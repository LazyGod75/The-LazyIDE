/* githubConnect.ts — GitHub connect + repo provisioning for teams (spec §9).

   Wraps the existing Rust commands (brain_publish_github, import_brain_from_github)
   into a higher-level API for team repo provisioning. Handles:
   1. Connecting a GitHub repo as a team brain source
   2. Provisioning a new team brain repo (create + publish)
   3. Syncing team brain repos across members
   4. Listing connected repos

   This module is the TypeScript bridge between the teams UI and the
   Rust git/GitHub operations. It works with the unified entitlement
   system to gate access (Pro+ only for provisioning).

   R4-lite team sync transport (spec §10, plan T4.3/T4.4 — see
   syncDaemon.ts's module header for the full picture): this file also owns
   the localStorage-backed `teamRepos` config (org trunk + dept repos the
   daemon should pull/push) and `pullTeamRepo`, the real per-repo clone
   step. `import_brain_from_github` (the only real git-clone command
   reachable from TS) has one side effect that matters a lot here: on
   success it always persists the clone as the app's ACTIVE brain (Rust's
   apply_brain_config("custom", dest)) and restarts the sidecar to match —
   correct for the existing personal "connect my own brain" flow above,
   wrong for a background daemon cloning N team repos that must coexist
   with the user's own active brain. `pullTeamRepo` borrows the active-brain
   slot only for the duration of the clone and restores it immediately
   after; when a personal "global"/"custom" brain override is already
   active (BrainInfo.source === 'ui_config') it cannot be restored exactly,
   so it refuses to clone at all rather than risk clobbering it.
*/

import { getPlatform } from '../platform/index.js';
import { isTauri } from '../platform/index.js';
import { getEntitlements } from '../entitlements/unifiedEntitlement.js';
import { emitBuffered } from '../journal/journal.js';

// ── Types ───────────────────────────────────────────────────────────

export interface ConnectedRepo {
  url: string;
  localPath: string;
  brainPath: string;
  lastSyncedAt?: string;
}

export interface ProvisionResult {
  ok: boolean;
  url?: string;
  localPath?: string;
  message: string;
}

export interface ConnectResult {
  ok: boolean;
  brainPath?: string;
  message: string;
}

// ── Union-merge .gitattributes provisioning (spec §10.2) ──────────────
//
// The real team-repo provisioning (org-trunk/dept-<name> repos created
// through dedicated teams_clone/teams_push Rust commands — plan T4.3) is
// not built yet. This module is a stopgap that reuses the existing
// single-brain brain_publish_github/import_brain_from_github commands
// (personal brain backup/restore, see src-tauri/src/commands/brain/
// publish.rs) for team repo provisioning.
//
// What IS real and buildable today: writing the spec-mandated
// `.gitattributes` union-merge directive into the SAME local directory
// brain_publish_github publishes, so it travels with the very first
// commit (publish.rs's git_add_all runs `git add -A` before committing —
// any file present in that directory before the call is included).
// `resolvePublishRoot` mirrors publish.rs's own resolve_publish_root so
// the two agree on exactly which directory that is.

/**
 * Ensure the union-merge `.gitattributes` directive is present in the
 * brain root about to be published. Merges with any existing file content
 * (never clobbers a user's own `.gitattributes` entries) and is a no-op if
 * the directive is already there — safe to call on every publish, not
 * just the first.
 *
 * Never throws: a failure here must not block the publish itself. It only
 * means the merge driver isn't configured yet for this repo.
 */
async function ensureUnionMergeGitattributes(
  _platform: ReturnType<typeof getPlatform>,
  _brain: BrainWithInfo,
): Promise<void> {
  return;
}

// ── Repo provisioning ───────────────────────────────────────────────

/**
 * Provision a new team brain repo on GitHub.
 *
 * Uses the existing brain_publish_github Rust command to:
 * 1. git init the brain directory (if needed)
 * 2. Write the spec §10.2 union-merge .gitattributes directive
 * 3. Create a GitHub repo (via gh CLI or GITHUB_TOKEN) — always private
 * 4. Push the brain to the new repo
 *
 * Gated by Pro+ entitlement — only Pro+ users can provision team repos.
 *
 * `_isPrivate` is kept (default `true`, unused) purely for source
 * compatibility with existing call sites (syncTeamBrainRepo below, and
 * tests) — it is never forwarded to `brain.publishGithub()`. Repo
 * visibility is no longer a caller-controllable option anywhere in this
 * chain: publish.rs always creates repos private and refuses to push to a
 * pre-existing remote unless that remote's visibility is confirmed
 * private. See BrainPublishOptions above and publish.rs's module doc.
 */
export async function provisionTeamBrainRepo(
  remoteUrl?: string,
  _isPrivate = true,
): Promise<ProvisionResult> {
  if (!isTauri()) {
    return { ok: false, message: 'GitHub provisioning requires the desktop app' };
  }

  const ents = getEntitlements();
  if (!ents.features.canUseRootTrunk) {
    return {
      ok: false,
      message: 'Team brain provisioning requires a Pro+ plan',
    };
  }

  try {
    const platform = getPlatform();
    const brain = platform.brain as unknown as BrainWithPublish & BrainWithInfo;

    await ensureUnionMergeGitattributes(platform, brain);

    const result = await brain.publishGithub({
      remoteUrl: remoteUrl?.trim() || undefined,
    });

    if (result.ok && result.url) {
      emitBuffered({
        tsMs: Date.now(),
        projectId: '*',
        actor: 'user',
        type: 'teams.push',
        payload: {
          commit: result.url,
        },
      });

      return {
        ok: true,
        url: result.url,
        message: result.message,
      };
    }

    return {
      ok: false,
      message: result.message,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ProvisionOneBrainRepoResult {
  repoUrl: string;
  htmlUrl: string;
}

/**
 * Create a SINGLE private brain repo on GitHub via the REST API.
 *
 * Uses `github_api_post` (the existing Tauri command that proxies to
 * api.github.com) to POST to `/user/repos` with `{ name, private: true,
 * auto_init: false }`. Returns the clone_url and html_url from the API
 * response.
 */
export async function provisionOneBrainRepo(
  opts: { owner: string; name: string; token: string; isOrg?: boolean },
): Promise<ProvisionOneBrainRepoResult> {
  const { owner, name, token, isOrg } = opts;
  const { githubApiPost } = await import('./githubOAuth.js');
  const endpoint = isOrg
    ? `https://api.github.com/orgs/${owner}/repos`
    : 'https://api.github.com/user/repos';
  const res = await githubApiPost(
    endpoint,
    token,
    {
      name,
      private: true,
      description: 'LazyBrain team brain (auto-provisioned by Lazy)',
      auto_init: false,
    },
  );
  if (res.ok) {
    try {
      const parsed = JSON.parse(res.body) as {
        clone_url?: string;
        html_url?: string;
        name?: string;
      };
      return {
        repoUrl: parsed.clone_url ?? `https://github.com/${owner}/${name}.git`,
        htmlUrl: parsed.html_url ?? `https://github.com/${owner}/${name}`,
      };
    } catch {
      return {
        repoUrl: `https://github.com/${owner}/${name}.git`,
        htmlUrl: `https://github.com/${owner}/${name}`,
      };
    }
  }
  if (res.status === 422) {
    return {
      repoUrl: `https://github.com/${owner}/${name}.git`,
      htmlUrl: `https://github.com/${owner}/${name}`,
    };
  }
  throw new Error(res.error ?? `GitHub create ${name} failed (${res.status})`);
}

/**
 * Connect an existing GitHub repo as a team brain source.
 *
 * Uses the existing import_brain_from_github Rust command to:
 * 1. Clone the repo to a local destination
 * 2. Validate it looks like a brain
 * 3. Set it as the active brain
 *
 * Gated by Pro entitlement — Pro and Pro+ users can connect team brains.
 */
export async function connectTeamBrainRepo(
  url: string,
  dest: string,
): Promise<ConnectResult> {
  if (!isTauri()) {
    return { ok: false, message: 'Connecting a brain repo requires the desktop app' };
  }

  const ents = getEntitlements();
  if (!ents.features.canUseTeamSearch) {
    return {
      ok: false,
      message: 'Connecting team brain repos requires a Pro plan',
    };
  }

  const trimmedUrl = url.trim();
  const trimmedDest = dest.trim();
  if (!trimmedUrl || !trimmedDest) {
    return { ok: false, message: 'URL and destination path are required' };
  }

  try {
    const platform = getPlatform();
    const brain = platform.brain as unknown as BrainWithImport;

    const info = await brain.importFromGithub({
      url: trimmedUrl,
      dest: trimmedDest,
    });

    emitBuffered({
      tsMs: Date.now(),
      projectId: '*',
      actor: 'user',
      type: 'teams.pull',
      payload: {
        commit: trimmedUrl,
      },
    });

    return {
      ok: true,
      brainPath: info.path,
      message: `Brain connected and activated: ${info.path}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Re-publish the current brain to its connected GitHub repo.
 * This is a convenience wrapper for the common "sync changes" flow.
 */
export async function syncTeamBrainRepo(): Promise<ProvisionResult> {
  return provisionTeamBrainRepo(undefined, true);
}

// ── Team repo config (spec §10, R4-lite) ─────────────────────────────
//
// No storage for "which GitHub repos back my org's team brains" existed
// before this: provisionTeamBrainRepo/connectTeamBrainRepo just perform one
// operation and forget about it. syncDaemon.ts's pull/push cycles need a
// durable list to iterate — this is that list, localStorage-backed like
// the outbox (syncDaemon.ts's OUTBOX_KEY).
//
// Wired at login (T6a): authSync.ts's registerTeamReposFromOrgContext
// (called from syncTeamsOnLogin/resyncTeams) calls addTeamRepo() for the
// org trunk + every dept repo derived from the user's org context, with
// `localDir` under teams.rs's teams_data_dir() — the same dir
// org-context.json and registerTeamCloneBrains() already use (see
// teamSearch.ts). So getTeamRepos() is non-empty for any signed-in Teams
// org member, and the sync cycles below do real work for them; it stays []
// (and the cycles honest no-ops, exactly like today's `{transport:'none'}`)
// only for solo users or before a Teams member's first login.

export interface TeamRepoConfig {
  orgId: string;
  deptId?: string;
  /** Git remote (GitHub or any git-hosted URL) this repo clones/pushes to. */
  repoUrl: string;
  /** Local clone directory — must live under teams_data_dir() (teams.rs). */
  localDir: string;
  lastPulledAt?: number;
  lastPushedAt?: number;
  /** Consecutive real (non-skip) pull failures — drives retry backoff. */
  consecutiveFailures?: number;
  /** Backoff gate: a pull is skipped until Date.now() passes this. */
  nextRetryAt?: number;
  lastError?: string;
}

const TEAM_REPOS_KEY = 'lazy:team-repos-config';
const MAX_TEAM_REPOS = 50;

function loadTeamRepos(): TeamRepoConfig[] {
  try {
    const raw = localStorage.getItem(TEAM_REPOS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TeamRepoConfig[]).slice(0, MAX_TEAM_REPOS) : [];
  } catch {
    return [];
  }
}

function saveTeamRepos(repos: TeamRepoConfig[]): void {
  try {
    localStorage.setItem(TEAM_REPOS_KEY, JSON.stringify(repos.slice(0, MAX_TEAM_REPOS)));
  } catch {
    // Storage full or unavailable — in-memory only for this session.
  }
}

/** Every team repo (org trunk + dept) configured for automatic sync. */
export function getTeamRepos(): TeamRepoConfig[] {
  return loadTeamRepos();
}

/** Register a repo for automatic pull/push. Idempotent on `repoUrl` — a
 *  second call with the same URL is a no-op (existing entry untouched). */
export function addTeamRepo(
  entry: Pick<TeamRepoConfig, 'orgId' | 'deptId' | 'repoUrl' | 'localDir'>,
): TeamRepoConfig[] {
  const repos = loadTeamRepos();
  if (repos.some((r) => r.repoUrl === entry.repoUrl)) return repos;
  const next = [...repos, { ...entry }];
  saveTeamRepos(next);
  return next;
}

/** Merge a partial update (lastPulledAt, consecutiveFailures, ...) into the
 *  repo matching `repoUrl`. No-op if no such repo is configured. */
export function updateTeamRepo(repoUrl: string, patch: Partial<TeamRepoConfig>): void {
  const repos = loadTeamRepos();
  saveTeamRepos(repos.map((r) => (r.repoUrl === repoUrl ? { ...r, ...patch } : r)));
}

/** Remove a repo from automatic sync (does not delete its local clone). */
export function removeTeamRepo(repoUrl: string): void {
  saveTeamRepos(loadTeamRepos().filter((r) => r.repoUrl !== repoUrl));
}

/**
 * Remap the registered team-repo URLs to the repos actually created on
 * GitHub. Matching is by repo NAME so the convention URL and the real
 * provisioned URL connect. Returns the number of entries remapped.
 */
export function remapTeamRepoUrls(
  provisioned: Array<{ name: string; cloneUrl: string }>,
): number {
  const repos = loadTeamRepos();
  let remapped = 0;
  const next = repos.map((r) => {
    const name = r.repoUrl.split('/').pop()?.replace(/\.git$/, '') ?? '';
    const match = provisioned.find((p) => p.name === name);
    if (match && r.repoUrl !== match.cloneUrl) {
      remapped++;
      return { ...r, repoUrl: match.cloneUrl, lastError: undefined };
    }
    return r;
  });
  saveTeamRepos(next);
  return remapped;
}

// ── Team repo pull transport (spec §10, R4-lite) ─────────────────────

/** Outcome of one `pullTeamRepo` call. `skipped: true` means nothing was
 *  wrong — the operation was honestly not attempted (gated, already
 *  cloned, or unsafe to borrow the active-brain slot); only the bare
 *  `ok: false` (no `skipped`) shape means the real clone was attempted and
 *  failed. Callers (syncDaemon.ts) branch retry/backoff on that distinction. */
export type PullTeamRepoOutcome =
  | { ok: true; path: string }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped?: false; message: string };

/**
 * Real pull for ONE configured team repo: clones `repo.repoUrl` into
 * `repo.localDir` via the proven `import_brain_from_github` command —
 * but ONLY the first time (see module header: there is no real
 * update-in-place transport yet, and Rust refuses to re-clone into a
 * non-empty directory). A repo that's already cloned is honestly reported
 * as skipped rather than re-fetched or erroring.
 *
 * Guards the active-brain side effect (see module header): captures the
 * brain source BEFORE cloning, and
 *   - refuses to clone at all when a personal "global"/"custom" override
 *     is already active (`source === 'ui_config'`) — it cannot be restored
 *     exactly afterward, so failing closed beats risking it;
 *   - otherwise restores the default project-scoped resolution
 *     (`setConfig({mode:'project'})`) immediately after a successful clone.
 *
 * Never throws — every failure mode (gating, fs, clone, restore) resolves
 * to a typed outcome.
 */
export async function pullTeamRepo(repo: TeamRepoConfig): Promise<PullTeamRepoOutcome> {
  if (!isTauri()) {
    return { ok: false, skipped: true, reason: 'requires the desktop app' };
  }

  const ents = getEntitlements();
  if (!ents.features.canUseTeamSearch) {
    return { ok: false, skipped: true, reason: 'missing team-search entitlement' };
  }

  const platform = getPlatform();

  let alreadyCloned: boolean;
  try {
    const entries = await platform.fs.readDir(repo.localDir);
    alreadyCloned = entries.length > 0;
  } catch {
    alreadyCloned = false; // directory doesn't exist yet — first clone
  }
  if (alreadyCloned) {
    return { ok: false, skipped: true, reason: 'already cloned — no update transport yet' };
  }

  const brain = platform.brain as unknown as BrainWithImport & BrainWithInfo & BrainWithConfig;

  let priorSource: string | undefined;
  try {
    priorSource = (await brain.info()).source;
  } catch {
    priorSource = undefined;
  }
  if (priorSource === 'ui_config') {
    return { ok: false, skipped: true, reason: 'a personal brain override is active' };
  }

  try {
    const info = await brain.importFromGithub({ url: repo.repoUrl, dest: repo.localDir });
    try {
      await brain.setConfig({ mode: 'project' });
    } catch (err) {
      console.warn('[githubConnect] failed to restore active brain after team pull:', err);
    }
    return { ok: true, path: info.path };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ── Type augmentation for existing brain interface ──────────────────

interface BrainPublishOptions {
  remoteUrl?: string;
  // No visibility flag — mirrors src/lib/platform/tauri.ts's
  // BrainPublishOptions: the brain must never be publishable to a public
  // repo, so there is nothing here for a caller to set to false.
}

interface BrainPublishResult {
  ok: boolean;
  url?: string;
  message: string;
}

interface BrainImportOptions {
  url: string;
  dest: string;
}

interface BrainInfo {
  path: string;
  source?: string;
}

interface BrainWithPublish {
  publishGithub(opts?: BrainPublishOptions): Promise<BrainPublishResult>;
}

interface BrainWithImport {
  importFromGithub(opts: BrainImportOptions): Promise<BrainInfo>;
}

interface BrainWithInfo {
  info(): Promise<BrainInfo>;
}

interface BrainWithConfig {
  setConfig(opts: { mode: 'project' | 'global' | 'custom'; path?: string }): Promise<BrainInfo>;
}
