/**
 * teamsSyncLocalRemote.test.ts
 *
 * END-TO-END proof of the Teams brain-sync transport (spec §10/§10.2)
 * through PRODUCT code paths, using a LOCAL BARE git repo as the shared
 * remote instead of GitHub — a bare repo is a fully valid git remote, so
 * this exercises the exact same git plumbing the real transport uses
 * (init/add/commit/remote/push/clone) without any network dependency.
 *
 * ── What is REAL vs SIMULATED in this file ───────────────────────────
 *
 * REAL, unmocked, exactly as shipped:
 *   - git itself. Every git operation below is a genuine subprocess
 *     (node:child_process), operating on genuine directories on disk
 *     (a fresh os.tmpdir() sandbox per run — see beforeAll/afterAll).
 *   - Every function under test from src/lib/teams/githubConnect.ts:
 *     provisionTeamBrainRepo, pullTeamRepo, connectTeamBrainRepo.
 *   - Every function under test from src/lib/teams/syncDaemon.ts:
 *     runTeamPushCycle, runTeamPullCycle, schedulePostCapturePush —
 *     all operating on a single repo from activeBrainConfig.
 *
 * SIMULATED — the ONLY mocked boundary is `platform.brain.*` /
 * `platform.fs.*` (src/lib/platform), i.e. exactly where the real app
 * would cross into Tauri's `invoke(...)` IPC and run compiled Rust — which
 * cannot run inside this Node/vitest process. Each `platform.brain.*`
 * method below is a small real-git-backed reimplementation that mirrors
 * the ACTUAL Rust command it stands in for (cited inline):
 *   - brain.publishGithub  -> mirrors brain_publish_github_inner
 *     (src-tauri/src/commands/brain/publish.rs)
 *   - brain.importFromGithub -> mirrors import_brain_from_github +
 *     clone_brain_repo + validate_cloned_brain
 *     (src-tauri/src/commands/brain/config.rs)
 *   - brain.info / brain.setConfig -> mirrors get_brain_info_inner /
 *     apply_brain_config's "custom" branch (same file) — including the
 *     documented side effect that a real clone/import always activates
 *     itself as the current brain (see githubConnect.ts's module header).
 * `platform.fs.*` are direct real `node:fs` calls with no behavior
 * simulation at all: the real Rust fs commands are themselves thin
 * wrappers over std::fs, so plain Node fs is already a faithful stand-in.
 * Deliberately NOT reproduced (irrelevant to this proof, documented so a
 * reader doesn't mistake the omission for an oversight): publish.rs's
 * `.gitignore` cache-exclusion management, and the gh-CLI/GitHub-API
 * auto-create fallbacks in `resolve_remote_and_push` (this file always
 * supplies an explicit remote URL, the same "paste-URL fallback" path
 * real users take when `gh` isn't installed).
 *
 * ── Single-repo daemon (V0-V7 refactor) ──────────────────────────────
 * The sync daemon now reads from activeBrainConfig (a single repo) instead
 * of the old multi-repo localStorage team-repos-config. These tests use
 * writeActiveBrainConfig/clearActiveBrainConfig to manage the active brain
 * config, exercising runTeamPullCycle/runTeamPushCycle/schedulePostCapturePush
 * against the single-repo path.
 *
 * ── Ordering ──────────────────────────────────────────────────────────
 * Unlike this repo's usual fully-isolated unit tests, the `it()` blocks
 * below are INTENTIONALLY ORDER-DEPENDENT and share mutable module state
 * (the scratch directories, the simulated "active brain" pointer, the
 * activeBrainConfig cache). They narrate ONE continuous multi-actor git
 * history (A publishes -> B clones -> daemon pull/push on single repo)
 * that cannot be sliced into independent tests without losing the
 * end-to-end property being proven. Vitest runs `it()` blocks within a
 * file sequentially by default, so this is safe.
 *
 * ── Timeouts ─────────────────────────────────────────────────────────
 * Each `it()` carries an explicit 30s budget: every block shells out to
 * REAL git subprocesses (init/add/commit/clone/push/fetch/merge) and the
 * default 5000ms vitest timeout is a coin flip under CI load (observed
 * flaking on the CONCURRENT APPEND block). The assertion is a git-history
 * property, not a latency claim, so the generous cap only removes the
 * flake.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── journal / entitlements / features mocks ─────────────
// None of these are the subject of this test; they're neutralized exactly
// like the existing githubConnect.test.ts / syncDaemon.test.ts do, so the
// real transport functions under test can run un-gated.

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  emitBuffered: vi.fn(),
}));

vi.mock('../lib/entitlements/unifiedEntitlement', () => ({
  getEntitlements: () => ({ features: { canUseRootTrunk: true, canUseTeamSearch: true } }),
}));

vi.mock('../lib/features', () => ({
  teamsActive: () => true,
}));

vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: async () => 'C:\\Users\\test\\AppData\\Local',
}));

// ── Real-transport mocks: the TS daemon now crosses into Rust via
// invoke('teams_pull_repo') / invoke('teams_push_repo'). In vitest there is
// no Rust runtime, so these invokes are backed by REAL git subprocesses
// operating on the same local bare-remote fixture — the exact git plumbing
// the Rust commands (teams_git.rs) run. ────────────────────────────────
const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  if (cmd === 'teams_pull_repo') {
    return simTeamsPull(String(args.localDir), String(args.repoUrl));
  }
  if (cmd === 'teams_push_repo') {
    return simTeamsPush(String(args.localDir), String(args.repoUrl));
  }
  if (cmd === 'brain_rebuild_graph') {
    return null;
  }
  if (cmd === 'brain_recompose_all') {
    return null;
  }
  if (cmd === 'write_file') {
    return null;
  }
  throw new Error(`unexpected invoke: ${cmd}`);
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(args[0] as string, (args[1] ?? {}) as Record<string, unknown>),
}));

vi.mock('../lib/teams/githubOAuth', () => ({
  readGitHubToken: async () => ({ token: 'gho_e2e_token', login: 'bob', email: 'bob@example.com', updatedAt: 0 }),
}));

vi.mock('../lib/teams/canvasShare', () => ({
  publishCanvasToTeam: async () => ({ layout: false, chains: false }),
  applyTeamCanvasToLocal: async () => false,
}));

/** Mirrors teams_git.rs's teams_pull_inner over REAL git: clone on first
 *  sync, fetch+merge (union .gitattributes) after. */
function simTeamsPull(localDir: string, repoUrl: string): { ok: boolean; action: string; message: string; repoUrl: string; localDir: string } {
  const result = (ok: boolean, action: string, message: string) => ({ ok, action, message, repoUrl, localDir });
  try {
    if (!fs.existsSync(path.join(localDir, '.git'))) {
      if (fs.existsSync(localDir) && fs.readdirSync(localDir).length > 0) {
        return result(false, 'error', 'destination exists and is not a git clone');
      }
      fs.mkdirSync(localDir, { recursive: true });
      gitSync(path.dirname(localDir), ['clone', repoUrl, localDir]);
      configureLocalGitIdentity(localDir, 'Bob', 'bob@test.local');
      return result(true, 'cloned', 'cloned team brain repo');
    }
    gitSync(localDir, ['fetch', 'origin']);
    const heads = gitSync(localDir, ['ls-remote', '--heads', 'origin', 'main']).trim();
    if (!heads) return result(true, 'up-to-date', 'remote has no branch yet');
    const localHead = gitSync(localDir, ['rev-parse', 'HEAD']).trim();
    const remoteHead = gitSync(localDir, ['rev-parse', 'origin/main']).trim();
    if (localHead === remoteHead) return result(true, 'up-to-date', 'already up to date');
    gitSync(localDir, ['merge', '--no-edit', '--allow-unrelated-histories', 'origin/main']);
    return result(true, 'pulled', 'merged origin/main');
  } catch (e) {
    return result(false, 'error', execErrorOutput(e) || String(e));
  }
}

/** Mirrors teams_git.rs's teams_push_inner over REAL git: add/commit/push. */
function simTeamsPush(localDir: string, repoUrl: string): { ok: boolean; action: string; message: string; repoUrl: string; localDir: string } {
  const result = (ok: boolean, action: string, message: string) => ({ ok, action, message, repoUrl, localDir });
  try {
    gitSync(localDir, ['add', '-A']);
    const staged = gitSync(localDir, ['diff', '--cached', '--name-only']).trim();
    if (!staged) return result(true, 'nothing-to-push', 'no local changes');
    gitSync(localDir, ['commit', '-m', 'test(lazybrain): sync']);
    gitSync(localDir, ['push', 'origin', 'HEAD']);
    return result(true, 'pushed', 'pushed team brain changes');
  } catch (e) {
    return result(false, 'error', execErrorOutput(e) || String(e));
  }
}

// ── Simulated Tauri-invoke boundary (platform.brain.* / platform.fs.*) ─
//
// Module-level mutable state mirrors Rust's ProjectState + brain-config.json:
// "which directory is the CURRENTLY active brain" — read by brain.info(),
// changed by brain.setConfig()/brain.importFromGithub()'s documented side
// effect, and consulted by brain.publishGithub() to decide what to publish.
// All declared with `function`/`let` (not `const` arrows) so they are fully
// hoisted — safe to reference from the vi.mock('../lib/platform', ...)
// factory below regardless of textual order (the factory's own arrow
// functions are not INVOKED until deep inside the it() blocks, by which
// point beforeAll has already initialized everything).

let scratchRoot: string;
let memberABrainRoot: string;
let originGitPath: string;
let memberBCloneRoot: string;
let activeBrainPath: string;
let activeBrainSource: string;
// Member B's team-repo registration (addTeamRepo persists it to
// localStorage — see the global afterEach in src/__tests__/setup.ts, which
// clears localStorage after every test for isolation). Hoisted so the
// "CONCURRENT APPEND" test can re-assert it below instead of relying on it
// surviving across tests. `TeamRepoConfig` is a type-only import further
// down this file — referencing it here is fine, type positions are not
// subject to JS declaration order.
let memberBRepoConfig: TeamRepoConfig;

function defaultProjectBrainPath(): string {
  return path.join(memberABrainRoot, 'brain');
}

function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function execErrorOutput(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string };
  return `${e.stdout ?? ''}${e.stderr ?? ''}`;
}

/** Test-harness-only identity + determinism config, scoped LOCALLY to one
 *  repo via plain `git config` (never --global) — mirrors publish.rs's own
 *  #[cfg(test)] `configure_git_identity` helper, needed because this
 *  machine's global git config cannot be assumed to have a usable identity
 *  or commit-signing disabled. */
function configureLocalGitIdentity(root: string, name: string, email: string): void {
  gitSync(root, ['config', 'user.name', name]);
  gitSync(root, ['config', 'user.email', email]);
  gitSync(root, ['config', 'commit.gpgsign', 'false']);
  gitSync(root, ['config', 'core.autocrlf', 'false']);
}

/** Mirrors publish.rs's git_init_if_needed exactly: `-b main`, falling
 *  back to a plain `init` for older git, no-op if `.git` already exists. */
function simGitInitIfNeeded(root: string): void {
  if (fs.existsSync(path.join(root, '.git'))) return;
  try {
    gitSync(root, ['init', '-b', 'main']);
  } catch {
    gitSync(root, ['init']);
  }
}

function simGitAddAll(root: string): void {
  gitSync(root, ['add', '-A']);
}

/** Mirrors git_commit_publish: tolerates "nothing to commit" (a re-publish
 *  with no changes) as success, not an error. */
function simGitCommit(root: string, message: string): void {
  try {
    gitSync(root, ['commit', '-m', message]);
  } catch (err) {
    if (!execErrorOutput(err).includes('nothing to commit')) throw err;
  }
}

function simGetOriginUrl(root: string): string | null {
  try {
    const url = gitSync(root, ['remote', 'get-url', 'origin']).trim();
    return url || null;
  } catch {
    return null;
  }
}

function simCurrentBranch(root: string): string {
  return gitSync(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

/** Mirrors githubConnect.ts's private `resolvePublishRoot` / publish.rs's
 *  `resolve_publish_root`: strips a trailing "brain" leaf component so the
 *  publish root is the leaf's PARENT. The two real implementations must
 *  stay in lockstep with each other (see githubConnect.ts's own comment on
 *  this); this test-only third copy exists purely to drive the SIMULATED
 *  Rust-side publish below with the same convention. */
function resolvePublishRootSim(brainPath: string): string {
  const sep = brainPath.includes('\\') ? '\\' : '/';
  // path-lint-ignore: test-only simulation of the Rust-side convention
  // (see doc comment above), not production path handling.
  const trimmed = brainPath.replace(/[\\/]+$/, '');
  const lastSep = trimmed.lastIndexOf(sep);
  const base = lastSep === -1 ? trimmed : trimmed.slice(lastSep + 1);
  return base === 'brain' ? trimmed.slice(0, lastSep) : trimmed;
}

interface SimPublishResult {
  ok: boolean;
  url?: string;
  message: string;
}

/** SIMULATED `brain_publish_github` (publish.rs) — real git underneath.
 *  Deliberately omits .gitignore management and the gh/API auto-create
 *  fallbacks (see file header); every call in this file supplies an
 *  explicit remoteUrl, the one path that matters for this proof. */
function simPublishGithub(opts: { remoteUrl?: string; private?: boolean }): SimPublishResult {
  const root = resolvePublishRootSim(activeBrainPath);

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, message: `brain directory does not exist: ${root}` };
  }

  const justInitialized = !fs.existsSync(path.join(root, '.git'));
  simGitInitIfNeeded(root);
  // In this file's narrative a just-initialized publish root is always
  // member A's very first publish — member B's clone gets its own
  // identity configured explicitly right after cloning (git clone never
  // runs git_init_if_needed, so this branch never fires for it).
  if (justInitialized) configureLocalGitIdentity(root, 'Alice', 'alice@test.local');

  simGitAddAll(root);
  simGitCommit(root, 'Publish brain');

  const existingOrigin = simGetOriginUrl(root);
  if (!existingOrigin) {
    const remoteUrl = opts.remoteUrl?.trim();
    if (!remoteUrl) return { ok: false, message: 'No remote configured.' };
    gitSync(root, ['remote', 'add', 'origin', remoteUrl]);
  }

  const branch = simCurrentBranch(root);
  try {
    gitSync(root, ['push', '-u', 'origin', branch]);
  } catch (err) {
    return { ok: false, message: `push failed: ${execErrorOutput(err) || String(err)}` };
  }

  const originForDisplay = existingOrigin ?? opts.remoteUrl ?? '';
  return { ok: true, url: originForDisplay.replace(/\.git$/, ''), message: 'Published successfully.' };
}

/** Mirrors config.rs's `validate_cloned_brain`, restricted to the one
 *  shape this file's fixtures use (a `brain/` directory present). */
function validateClonedBrainSim(dest: string): boolean {
  const brainDir = path.join(dest, 'brain');
  return fs.existsSync(brainDir) && fs.statSync(brainDir).isDirectory();
}

/** Mirrors config.rs's `custom_brain_leaf`: descend into `<root>/brain`
 *  when present, else use `root` as the leaf directly. */
function customBrainLeafSim(root: string): string {
  const nested = path.join(root, 'brain');
  return fs.existsSync(nested) && fs.statSync(nested).isDirectory() ? nested : root;
}

interface SimBrainInfo {
  path: string;
  source: string;
}

/** SIMULATED `import_brain_from_github` (config.rs) — real `git clone`
 *  underneath, real validate_cloned_brain-equivalent check, and the SAME
 *  "always activates the clone as the current brain" side effect the real
 *  command has (apply_brain_config("custom", dest, ...)) — this is exactly
 *  what pullTeamRepo's own doc comment warns about and works around. */
function simImportFromGithub(opts: { url: string; dest: string }): SimBrainInfo {
  if (fs.existsSync(opts.dest) && fs.readdirSync(opts.dest).length > 0) {
    throw new Error(`destination '${opts.dest}' already exists and is not empty`);
  }
  // `-c core.autocrlf=false` applies BEFORE the clone's initial checkout —
  // without it, a Windows machine whose GLOBAL git config defaults to
  // core.autocrlf=true would silently rewrite LF blobs to CRLF on disk
  // (the new clone has no local config of its own yet at checkout time),
  // corrupting the byte-exact content this test relies on. Member A's own
  // repo avoids this the ordinary way (a LOCAL core.autocrlf=false is
  // configured right after `git init`, before its first commit — see
  // simPublishGithub) — a fresh clone has no such local config until AFTER
  // checkout already happened, so it needs this explicit override instead.
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', opts.url, opts.dest], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!validateClonedBrainSim(opts.dest)) {
    fs.rmSync(opts.dest, { recursive: true, force: true });
    throw new Error(`'${opts.dest}' does not look like a LazyBrain brain — refusing to adopt it`);
  }

  activeBrainPath = customBrainLeafSim(opts.dest);
  activeBrainSource = 'ui_config';
  return { path: activeBrainPath, source: activeBrainSource };
}

function simBrainInfo(): SimBrainInfo {
  return { path: activeBrainPath, source: activeBrainSource };
}

function simSetConfig(opts: { mode: string; path?: string }): SimBrainInfo {
  if (opts.mode === 'project') {
    activeBrainPath = defaultProjectBrainPath();
    activeBrainSource = 'project';
  } else if (opts.mode === 'custom' && opts.path) {
    activeBrainPath = customBrainLeafSim(opts.path);
    activeBrainSource = 'ui_config';
  }
  return simBrainInfo();
}

async function simReadDir(dirPath: string): Promise<Array<{ name: string; path: string; isDir: boolean }>> {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, path: path.join(dirPath, e.name), isDir: e.isDirectory() }));
}

vi.mock('../lib/platform', () => ({
  isTauri: () => true,
  getPlatform: () => ({
    name: 'tauri',
    brain: {
      info: async () => simBrainInfo(),
      setConfig: async (opts: { mode: string; path?: string }) => simSetConfig(opts),
      publishGithub: async (opts?: { remoteUrl?: string; private?: boolean }) => simPublishGithub(opts ?? {}),
      importFromGithub: async (opts: { url: string; dest: string }) => simImportFromGithub(opts),
    },
    fs: {
      readDir: (p: string) => simReadDir(p),
      readFile: (p: string) => fsp.readFile(p, 'utf8'),
      writeFile: (p: string, content: string) => fsp.writeFile(p, content, 'utf8'),
    },
  }),
}));

import {
  provisionTeamBrainRepo,
  pullTeamRepo,
  connectTeamBrainRepo,
  type TeamRepoConfig,
} from '../lib/teams/githubConnect';
import { runTeamPushCycle, runTeamPullCycle, schedulePostCapturePush } from '../lib/teams/syncDaemon';
import { writeActiveBrainConfig, clearActiveBrainConfig } from '../lib/teams/activeBrainConfig';

// ── Fixtures ───────────────────────────────────────────────────────────

const ALICE_NOTE_1 = `<article data-cerveau-type="neuron" data-cerveau-author="Alice" data-cerveau-created="2026-07-01">
<header><h1>Deploy checklist</h1></header>
<section data-section="facts">
<p data-cerveau-author="Alice" data-cerveau-created="2026-07-01">Staging deploys require a passing e2e run first.</p>
</section>
</article>
`;

const ALICE_NOTE_2 = `<article data-cerveau-type="neuron" data-cerveau-author="Alice" data-cerveau-created="2026-07-01">
<header><h1>On-call rotation</h1></header>
<section data-section="facts">
<p data-cerveau-author="Alice" data-cerveau-created="2026-07-01">On-call rotates every Monday at 9am.</p>
</section>
</article>
`;

beforeAll(() => {
  localStorage.clear();

  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-teams-e2e-'));
  memberABrainRoot = path.join(scratchRoot, 'member-a-brain');
  originGitPath = path.join(scratchRoot, 'origin.git');
  memberBCloneRoot = path.join(scratchRoot, 'member-b-clone');

  // Member A's brain content, on disk only — no git yet: git init/add/commit
  // is PRODUCT code's job, exercised by provisionTeamBrainRepo below.
  fs.mkdirSync(path.join(memberABrainRoot, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(memberABrainRoot, 'neurons'), { recursive: true });
  fs.writeFileSync(path.join(memberABrainRoot, 'brain', '.lazybrain-config.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(memberABrainRoot, 'neurons', 'note1.html'), ALICE_NOTE_1, 'utf8');
  fs.writeFileSync(path.join(memberABrainRoot, 'neurons', 'note2.html'), ALICE_NOTE_2, 'utf8');

  // "origin.git" — a LOCAL BARE repo standing in for a git host (GitHub or
  // otherwise): a bare repo is a fully valid git remote. REAL git, not a
  // mock. The `symbolic-ref HEAD` line is test-harness setup only, working
  // around one difference between a raw local bare repo and a real git
  // host: GitHub sets a new repo's default branch to match whatever gets
  // pushed to it; `git init --bare` instead defaults HEAD to
  // refs/heads/<init.defaultBranch> regardless of what's later pushed,
  // leaving it dangling (confirmed with a manual dry run before writing
  // this test — a clone against an unpatched bare repo silently checks out
  // nothing and warns "remote HEAD refers to nonexistent ref").
  execFileSync('git', ['init', '--bare', originGitPath], { encoding: 'utf8' });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: originGitPath, encoding: 'utf8' });

  activeBrainPath = defaultProjectBrainPath();
  activeBrainSource = 'project';
});

afterAll(() => {
  if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true });
});

// ── The narrative ──────────────────────────────────────────────────────

describe('Teams brain sync over a local git remote (end-to-end, real git)', () => {
  it('MEMBER A PUSH — provisionTeamBrainRepo pushes real content to origin.git', async () => {
    const result = await provisionTeamBrainRepo(originGitPath, true);

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Published successfully.');

    const tracked = execFileSync(
      'git',
      [`--git-dir=${originGitPath}`, 'ls-tree', '-r', '--name-only', 'main'],
      { encoding: 'utf8' },
    );
    expect(tracked).toContain('neurons/note1.html');
    expect(tracked).toContain('neurons/note2.html');
    expect(tracked).toContain('brain/.lazybrain-config.json');
  }, 30_000);

  it("MEMBER B PULL — pullTeamRepo clones the real repo and Alice's attribution survives intact", async () => {
    memberBRepoConfig = {
      orgId: 'org-1',
      deptId: 'dept-eng',
      repoUrl: originGitPath,
      localDir: memberBCloneRoot,
    };
    const repo = memberBRepoConfig;

    const outcome = await pullTeamRepo(repo);

    expect(outcome).toEqual({ ok: true, path: path.join(memberBCloneRoot, 'brain') });

    const note1 = fs.readFileSync(path.join(memberBCloneRoot, 'neurons', 'note1.html'), 'utf8');
    const note2 = fs.readFileSync(path.join(memberBCloneRoot, 'neurons', 'note2.html'), 'utf8');
    expect(note1).toContain('data-cerveau-author="Alice"');
    expect(note2).toContain('data-cerveau-author="Alice"');

    expect(activeBrainPath).toBe(defaultProjectBrainPath());
    expect(activeBrainSource).toBe('project');

    configureLocalGitIdentity(memberBCloneRoot, 'Bob', 'bob@test.local');
  }, 30_000);

  it('DAEMON PULL — runTeamPullCycle pulls from a single repo in activeBrainConfig', async () => {
    writeActiveBrainConfig({
      orgId: 'org-1',
      repoUrl: originGitPath,
      localDir: memberBCloneRoot,
      lastPulledAt: 0,
      lastPushedAt: 0,
      lastError: null,
    });

    const result = await runTeamPullCycle();

    expect(result).toEqual({ pulled: 1, skipped: 0, failed: 0 });
    expect(activeBrainPath).toBe(defaultProjectBrainPath());
  }, 30_000);

  it('DAEMON PUSH — runTeamPushCycle pushes to a single repo in activeBrainConfig', async () => {
    fs.writeFileSync(
      path.join(memberBCloneRoot, 'neurons', 'note3.html'),
      '<article data-cerveau-type="neuron" data-cerveau-author="Bob"><header><h1>Bob note</h1></header></article>\n',
      'utf8',
    );

    writeActiveBrainConfig({
      orgId: 'org-1',
      repoUrl: originGitPath,
      localDir: memberBCloneRoot,
      lastPulledAt: Date.now(),
      lastPushedAt: 0,
      lastError: null,
    });

    const result = await runTeamPushCycle();

    expect(result).toEqual({ pushed: 1, skipped: 0, failed: 0 });

    const tracked = execFileSync(
      'git',
      [`--git-dir=${originGitPath}`, 'ls-tree', '-r', '--name-only', 'main'],
      { encoding: 'utf8' },
    );
    expect(tracked).toContain('neurons/note3.html');
  }, 30_000);

  it('DAEMON SKIP — cycles skip when no active config exists', async () => {
    clearActiveBrainConfig();

    const pullResult = await runTeamPullCycle();
    expect(pullResult).toEqual({ pulled: 0, skipped: 0, failed: 0 });

    const pushResult = await runTeamPushCycle();
    expect(pushResult).toEqual({ pushed: 0, skipped: 0, failed: 0 });
  }, 30_000);

  it('POST-CAPTURE PUSH — schedulePostCapturePush triggers runTeamPushCycle after a delay', async () => {
    writeActiveBrainConfig({
      orgId: 'org-1',
      repoUrl: originGitPath,
      localDir: memberBCloneRoot,
      lastPulledAt: 0,
      lastPushedAt: 0,
      lastError: null,
    });

    const pushCallsBefore = invokeMock.mock.calls.filter((c) => c[0] === 'teams_push_repo').length;

    vi.useFakeTimers();
    schedulePostCapturePush();
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'teams_push_repo').length).toBe(pushCallsBefore);

    await vi.advanceTimersByTimeAsync(3000);

    expect(invokeMock.mock.calls.filter((c) => c[0] === 'teams_push_repo').length).toBeGreaterThan(pushCallsBefore);
    vi.useRealTimers();
  }, 30_000);

  it('DAEMON ERROR — runTeamPullCycle handles transport errors for the single repo', async () => {
    writeActiveBrainConfig({
      orgId: 'org-1',
      repoUrl: path.join(scratchRoot, 'nonexistent-repo.git'),
      localDir: path.join(scratchRoot, 'nonexistent-clone'),
      lastPulledAt: 0,
      lastPushedAt: 0,
      lastError: null,
    });

    const result = await runTeamPullCycle();

    expect(result).toEqual({ pulled: 0, skipped: 0, failed: 1 });
    clearActiveBrainConfig();
  }, 30_000);

  it('URL VALIDATION — a local, non-github repoUrl is accepted end-to-end with zero client-side rejection (paste-URL fallback confirmed)', async () => {
    expect(originGitPath.startsWith('https://github.com')).toBe(false);

    const personalDest = path.join(scratchRoot, 'personal-connect-dest');
    const result = await connectTeamBrainRepo(originGitPath, personalDest);

    expect(result.ok).toBe(true);
    expect(result.message).toContain('Brain connected and activated');
    expect(fs.existsSync(path.join(personalDest, 'neurons', 'note1.html'))).toBe(true);
  }, 30_000);
});
