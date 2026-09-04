/* devPreview.ts — P46+P48 "signature experience": when a mission chain works
   on a web project, the user must automatically get a LIVE localhost
   preview next to the working agents — zero manual steps ("si le
   lazymanager travaille sur un site je dois voir le localhost et voir que
   des agents taffent dessus").

   BEFORE this module: useCanvasAutoComposition.ts's dev-server auto-detect
   only ever PASSIVELY probed a short list of common ports (3000/3001/5173/
   8080) and auto-added a preview once one answered. Nothing ever actually
   STARTED a dev server — a project whose dev server wasn't already running
   for some other reason (a terminal the user opened themselves, a previous
   session) never got a preview at all.

   This module adds the missing half: detect the project's own dev script
   (package.json `scripts.dev`) and the port it will bind, REUSE an already-
   answering port verbatim (never spawn a second server on top of one
   that's already up — see `reused` on {@link DevPreviewResult}), and
   otherwise spawn it via the app's EXISTING PTY infra (`platform.terminal.
   spawn`, the same real portable-pty TerminalView.tsx already drives) —
   deliberately no new Rust command.

   HOW A COMMAND ACTUALLY RUNS (important, non-obvious): `terminal_spawn`
   (src-tauri, wired through tauri.ts's `nativeTerminal.spawn`) takes only
   `cols`/`rows`/`cwd` — the `command`/`args` parameters TerminalView.tsx
   already passes it are NOT forwarded to Rust at all (see that file's own
   `platform.terminal.spawn('sh', [], { cwd })` call — 'sh' is a throwaway
   placeholder, never actually used to pick a shell binary). A PTY spawned
   this way is always just an interactive shell prompt; the only way to run
   a specific command in it is to `write()` the command line into it,
   exactly like a user typing it and pressing Enter. `spawnDevServerShell`
   below does exactly that: spawn the shell, then `write('npm run dev\r\n')`.

   SECURITY NOTE (deliberate, not an oversight): the only command line ever
   written into the spawned shell is `<packageManager> run dev` — the
   package manager is sniffed from a LOCKFILE NAME already committed to the
   project (package-lock.json/yarn.lock/pnpm-lock.yaml), never from
   arbitrary user/mission text, and `dev` is a literal npm-script invocation
   of whatever `package.json`'s OWN `scripts.dev` already says — this module
   never constructs or runs a shell command built from mission/agent output.

   REUSE-IF-RUNNING: before spawning anything, the resolved port is probed
   (same `no-cors` reachability technique PreviewNode.tsx/
   useCanvasAutoComposition.ts already use) — if something is already
   listening there, it is reused verbatim and NEVER tracked for idle-stop
   (see `reused` below): this module only ever kills a process it itself
   started.

   IDLE-STOP: a dev server this module spawned is stopped once its project
   has had no active (running) mission for `getIdleTimeoutMs` (default 30
   minutes, configurable per project) — driven by the caller invoking
   `noteProjectMissionActivity` on every mission-status tick (see
   useCanvasAutoComposition.ts's wiring). Deliberately NOT tied to the
   canvas hook's own mount/unmount lifecycle: a user navigating away from
   the Agent Canvas space must never kill a dev server whose project still
   has real work running — see that hook's own doc comment for why.

   Every I/O boundary (`readFile`/`readDir`/`probeReachable`/`fetchBodyStart`/
   `spawnShell`) is injectable via {@link DevPreviewDeps} — same "pure/
   testable independent of real fetch/timers" convention previewProbe.ts/
   previewBackoff.ts already follow — so the orchestration logic
   (reuse-if-running, dedup, idle-stop) is unit-tested without a real Tauri
   runtime.
*/

import { getPlatform } from '../platform/index.js';
import { joinPath, stripVerbatimPrefix } from '../paths.js';
import { getSystemPressure, type PressureLevel } from './systemPressure.js';
import { emitEvent } from '../journal/journal.js';
import { emit } from '../bus.js';

// ── Port/script detection (pure — no I/O) ─────────────────────────────

export type PackageManager = 'npm' | 'yarn' | 'pnpm';

export interface DevServerConfig {
  /** The raw `scripts.dev` command (e.g. `"next dev"`) — never executed
   *  directly, only read to derive the port heuristic below. The command
   *  actually run is `<packageManager> run dev` (see `devServerCommand`),
   *  which delegates to whatever this string says. */
  script: string;
  port: number;
  packageManager: PackageManager;
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Framework → default dev-server port, checked against the script text
 *  itself AND the project's declared dependencies (a generic script name
 *  like "start-dev" still resolves if `next`/`vite` is a real dependency).
 *  Deliberately short — "ship the general heuristic, don't over-engineer
 *  other frameworks" (only the two most common local dev servers). */
const FRAMEWORK_DEFAULT_PORTS: ReadonlyArray<{ readonly test: RegExp; readonly port: number }> = [
  { test: /(^|[^a-z])next([^a-z]|$)/i, port: 3000 },
  { test: /(^|[^a-z])vite([^a-z]|$)/i, port: 5173 },
];

/** Matches `--port 4000` / `--port=4000` / `-p 4000` in a dev script — an
 *  EXPLICIT port the project's own script already commits to, which must
 *  always win over a mere framework-default guess. */
function portFromFlag(script: string): number | null {
  const match = script.match(/(?:--port|-p)[\s=](\d{2,5})/);
  return match ? Number(match[1]) : null;
}

/** Matches a leading `PORT=4000` env-var assignment in a dev script
 *  (e.g. `"PORT=4000 next dev"`) — the other explicit, project-authored
 *  signal, checked before falling back to a framework default. */
function portFromEnvPrefix(script: string): number | null {
  const match = script.match(/(?:^|\s)PORT=(\d{2,5})/);
  return match ? Number(match[1]) : null;
}

function portFromFramework(script: string, pkg: PackageJsonShape): number | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const { test, port } of FRAMEWORK_DEFAULT_PORTS) {
    if (test.test(script) || Object.keys(deps).some((name) => test.test(name))) return port;
  }
  return null;
}

/**
 * Resolves the port a project's dev server will bind, in priority order:
 * an explicit per-project override (user-configured, see
 * `getConfiguredPort`) > an explicit `--port`/`-p` flag in the script > an
 * explicit `PORT=` env prefix in the script > a recognized framework's
 * default port. Returns null when NONE of these apply — this module never
 * guesses a port it has no real signal for.
 */
export function resolveDevServerPort(
  script: string,
  pkg: Pick<PackageJsonShape, 'dependencies' | 'devDependencies'>,
  portOverride?: number,
): number | null {
  if (portOverride !== undefined) return portOverride;
  return portFromFlag(script) ?? portFromEnvPrefix(script) ?? portFromFramework(script, pkg);
}

/**
 * Parses a `package.json` file's raw text and resolves a {@link
 * DevServerConfig}, or null when there is no `scripts.dev` at all, the JSON
 * itself is malformed, or no port can be confidently resolved (see
 * `resolveDevServerPort`) — every null case means "not a project this
 * module can drive", never a thrown error (a malformed/foreign
 * `package.json` must never crash the canvas).
 */
export function detectDevServerConfig(
  packageJsonRaw: string,
  opts?: { portOverride?: number; packageManager?: PackageManager },
): DevServerConfig | null {
  let pkg: PackageJsonShape;
  try {
    pkg = JSON.parse(packageJsonRaw) as PackageJsonShape;
  } catch {
    return null;
  }
  const script = pkg.scripts?.dev;
  if (typeof script !== 'string' || script.trim().length === 0) return null;
  const port = resolveDevServerPort(script, pkg, opts?.portOverride);
  if (port === null) return null;
  return { script, port, packageManager: opts?.packageManager ?? 'npm' };
}

/** The literal command line written into the spawned shell — see this
 *  module's own header for why a PTY spawn can't take a command directly. */
export function devServerCommand(packageManager: PackageManager): string {
  return packageManager === 'yarn' ? 'yarn dev' : `${packageManager} run dev`;
}

/**
 * P46+P48 round 2 — serves a resolved plain-HTML deliverable directory via
 * the app's real PTY infra, reusing an already-answering static port when
 * one exists (an agent's own `npx serve` from an earlier step must never
 * get a second server stacked on top of it — same reuse-if-running
 * invariant as the framework path). Idle-stop and every other lifecycle
 * rule apply identically (it IS a ManagedDevServer like any other).
 *
 * 2026-08-04 orphaned-server incident fix: an already-answering port is no
 * longer reused BLINDLY. Each port in STATIC_SERVER_PORTS is now
 * fingerprinted (see `contentFingerprintMatches`) against `staticRoot`'s
 * own `index.html` before being trusted — a port serving a DIFFERENT
 * project's content (a stale `npx serve` orphaned from an earlier,
 * unrelated project) is skipped in favor of the next port in the list. The
 * first port that never answers at all (genuinely free) becomes the spawn
 * target — see `spawnPort` below, deliberately no longer hardcoded to
 * STATIC_SERVER_PORTS[0].
 */
async function ensureStaticDevServer(
  projectId: string,
  staticRoot: string,
  projectRoot: string,
  deps: DevPreviewDeps,
  worktreeRels?: readonly (string | undefined)[],
): Promise<DevPreviewResult | null> {
  // Read once, up front — every reachable port below is fingerprinted
  // against this SAME local snapshot. A failed read (staticRoot's
  // index.html vanished between resolveWebDeliverableRoot and here, an
  // unlikely race) means no port can ever be CONFIRMED a match — every
  // reachable port is then treated as foreign rather than blindly reused
  // (fail closed, same posture as a null `fetchBodyStart`).
  const localIndexHtml = await deps.readFile(joinPath(staticRoot, 'index.html')).catch(() => null);

  let spawnPort: number | null = null;
  for (const port of STATIC_SERVER_PORTS) {
    if (!(await deps.probeReachable(port))) {
      spawnPort = port; // first genuinely free port — spawn target if no match turns up
      break;
    }
    if (localIndexHtml !== null) {
      const remoteBodyStart = await deps.fetchBodyStart(port);
      if (contentFingerprintMatches(remoteBodyStart, localIndexHtml)) {
        // Confirmed: this port serves OUR OWN deliverable (an agent's own
        // `npx serve` from an earlier step, a server the user started
        // manually, ...) — reuse it verbatim, never spawn a second server,
        // never track it for idle-stop.
        skipReasons.delete(projectId);
        return { url: `http://localhost:${port}`, port, reused: true };
      }
    }
    // Reachable but serving something else entirely (or unverifiable —
    // see fetchBodyStart's fail-closed contract) — try the next port
    // rather than risk silently showing the wrong project.
  }

  if (spawnPort === null) {
    // Every STATIC_SERVER_PORTS entry answered and NONE of them serves
    // this project's own deliverable — reusing any would show the wrong
    // project, and there is no free port left to spawn a fresh one on.
    skipReasons.set(projectId, 'ports_busy_foreign_content');
    return null;
  }

  const pressureLevel = deps.getPressureLevel();
  if (pressureLevel === 'high' || pressureLevel === 'elevated') {
    skipReasons.set(projectId, pressureLevel === 'high' ? 'pressure_high' : 'pressure_elevated');
    return null;
  }
  skipReasons.delete(projectId);

  try {
    const shell = await deps.spawnShell(staticRoot);
    const logs: string[] = [];
    shell.onData((chunk) => {
      logs.push(chunk);
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
    });
    // `npx serve` is the SAME static server the agents themselves already
    // use in their own verification steps (verified in real runs) —
    // `--yes` skips its install prompt on first use. Served from
    // `staticRoot` directly (the shell's cwd), on the first free port found
    // above (no longer hardcoded — a busy STATIC_SERVER_PORTS[0] must not
    // block spawning on a later free port). `--cors` (vercel/serve's own
    // flag, sets `Access-Control-Allow-Origin: *`) is REQUIRED since the
    // 2026-08-04 content-fingerprint fix: without it, THIS OWN server would
    // be unreadable by `fetchBodyStart` on a later `ensureStaticDevServer`
    // call (e.g. after an app restart clears the in-memory `activeServers`
    // map) — a same-origin-only response would fail the fingerprint check
    // exactly like a foreign server, causing a NEW `npx serve` to be
    // spawned on the next free port instead of reusing this one, i.e. the
    // exact orphan-accumulation problem reuse-if-running exists to prevent.
    shell.write(`npx --yes serve --cors -l ${spawnPort} .\r\n`);

    const handle: ManagedDevServer = {
      projectId,
      port: spawnPort,
      url: `http://localhost:${spawnPort}`,
      logs,
      kill: shell.kill,
      idleTimer: null,
      lastActiveAtMs: deps.now(),
    };
    activeServers.set(projectId, handle);
    return { url: handle.url, port: handle.port, reused: false };
  } catch (err) {
    if (isInsufficientMemorySpawnError(err)) {
      deferSpawnRetryAfterInsufficientMemory(projectId, projectRoot, deps, worktreeRels);
      return null;
    }
    // Any other PTY failure — degrade to "nothing to attach yet" rather
    // than throw; the caller's existing passive-probe fallback still gets
    // a chance to find a preview.
    return null;
  }
}

// ── Static web deliverable support (P46+P48 round 2) ───────────────────
//
// A mission working on a plain HTML site/game has no `scripts.dev` for
// detectDevServerConfig to find — the deliverable is static files in the
// mission's OWN git worktree (`.lazy/worktrees/<mission.worktree>`), often
// under `public/<subdir>`. These helpers resolve that deliverable and serve
// it with the SAME PTY infra (never a new Rust command), so the user
// automatically gets a live localhost preview of what the agent actually
// produced — not of the project's (possibly unrelated) framework app.

/** Ports probed in order for an ALREADY-RUNNING static server to reuse —
 *  the ports `npx serve` (this module's own spawn command below) and common
 *  agent-launched static servers bind by default. Deliberately short, same
 *  posture as CANDIDATE_DEV_PORTS in useCanvasAutoComposition.ts. */
const STATIC_SERVER_PORTS: readonly number[] = [8080, 8000, 8081];

/** Subdirectories (relative to a base dir) that commonly hold a plain-HTML
 *  deliverable, probed in order after the base dir itself and `public/`. */
const STATIC_DELIVERABLE_SUBDIRS: readonly string[] = ['public', 'dist', 'build', 'out'];

/**
 * P46+P48 round 2 — plain-HTML deliverable resolution. Resolves the FIRST
 * directory that actually contains an `index.html`, or null. Candidate
 * order: each mission worktree (most recent first) with its base dir,
 * `public/`, `dist`/`build`/`out`, then every DIRECT subdir of `public/`
 * (the `public/game` shape). Without worktreeRels, only the project root
 * itself is scanned (the plain-static-site case).
 *
 * Never throws — every I/O failure just skips that candidate (same
 * best-effort posture as every other boundary in this module).
 */
export async function resolveWebDeliverableRoot(
  projectRoot: string,
  worktreeRels: readonly (string | undefined)[] | undefined,
  deps: DevPreviewDeps = realDeps,
): Promise<string | null> {
  const bases: string[] = [];
  const rels = (worktreeRels ?? []).filter((r): r is string => Boolean(r && r.trim()));
  if (rels.length > 0) {
    // Most recent worktree first — the newest mission's worktree is the one
    // the user is looking at.
    for (const rel of [...rels].reverse()) {
      // A mission's `worktree` field is the GIT BRANCH name (e.g.
      // "agent/M5-verifier-...") but the directory on disk is the
      // sanitized form (slashes → dashes) — the SAME sanitize
      // resolveDiscardWorktreePath (agentsStore.tsx) applies.
      const safeRel = rel.trim().replace(/[^a-zA-Z0-9\-_]/g, '-');
      bases.push(joinPath(projectRoot, '.lazy', 'worktrees', safeRel));
    }
  } else {
    bases.push(projectRoot);
  }

  const candidates: string[] = [];
  for (const base of bases) {
    candidates.push(base);
    for (const sub of STATIC_DELIVERABLE_SUBDIRS) candidates.push(joinPath(base, sub));
    // One level under public/ — the `public/game` shape.
    try {
      const entries = await deps.readDir(joinPath(base, 'public'));
      for (const entry of entries) {
        if (entry.isDir) candidates.push(joinPath(base, 'public', entry.name));
      }
    } catch {
      // no public/ — not a candidate shape, keep looking
    }
  }

  for (const dir of candidates) {
    try {
      await deps.readFile(joinPath(dir, 'index.html'));
      return dir;
    } catch {
      // no index.html here — keep looking
    }
  }
  return null;
}

/**
 * 2026-08-05 foreign-server-adoption incident fix — root-only variant of
 * {@link resolveWebDeliverableRoot} (worktrees deliberately ignored) paired
 * with a best-effort read of the resolved directory's `index.html`. Used by
 * useCanvasAutoComposition.ts's passive candidate-port fallback (see that
 * hook's own module header) as a LAST-RESORT content check before ever
 * adopting a reachable candidate port: even a project whose worktree-scoped
 * deliverable didn't resolve (resolveWebDeliverableRoot(root, worktreeRels)
 * came back null — e.g. a mission's worktree doesn't itself hold the site)
 * may still have its own plain static site sitting at the project ROOT.
 * Reused against a candidate's fetched body via `contentFingerprintMatches`
 * — never a reason to skip the check that guards it.
 *
 * Returns null when nothing resolves at the plain project root, or the
 * resolved directory's `index.html` can't be read — same best-effort,
 * never-throws contract as `resolveWebDeliverableRoot` itself; a null here
 * simply means the caller has nothing to fingerprint against (never treated
 * as a match, never treated as a mismatch — see `contentFingerprintMatches`'s
 * own fail-closed contract for what a null local/remote side means).
 */
export async function readRootDeliverableIndexHtml(
  projectRoot: string,
  deps: DevPreviewDeps = realDeps,
): Promise<string | null> {
  const staticRoot = await resolveWebDeliverableRoot(projectRoot, undefined, deps);
  if (!staticRoot) return null;
  try {
    return await deps.readFile(joinPath(staticRoot, 'index.html'));
  } catch {
    return null;
  }
}

// ── Static-port content fingerprint (2026-08-04 orphaned-server incident) ──
// An already-answering STATIC_SERVER_PORTS port used to be reused verbatim
// with no check at all — fine for an agent's OWN `npx serve` from an earlier
// step, but WRONG for an unrelated orphaned static server (a stale `npx
// serve` from a completely different project) that happens to still hold
// the port: the user's preview would silently show the wrong project. These
// two helpers let ensureStaticDevServer confirm a match before reusing.

/** Characters compared by `contentFingerprintMatches` — enough to
 *  distinguish two genuinely different projects' `index.html` without
 *  needing the WHOLE file. */
const CONTENT_FINGERPRINT_MAX_CHARS = 200;

/** Collapses all whitespace runs to a single space and trims — makes the
 *  comparison below immune to incidental formatting noise (CRLF vs LF,
 *  indentation, a trailing newline) that does NOT mean the content is a
 *  different project. */
function normalizeForFingerprint(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Decides whether an already-answering static port is serving the SAME
 * deliverable as `localIndexHtml` (this project's resolved
 * `staticRoot/index.html`, read via `deps.readFile`) rather than an
 * unrelated orphaned server (see this section's own header for the
 * incident this guards against).
 *
 * STRATEGY (chosen over comparing `<title>`): normalize whitespace in both
 * strings and compare the first `CONTENT_FINGERPRINT_MAX_CHARS` characters.
 * A `<title>` comparison was the other candidate but was rejected — Vite/
 * CRA's default boilerplate title ("Vite App", the CRA app name, ...) is
 * shared across many UNRELATED scaffolded projects far more often than the
 * first ~200 characters of full markup (doctype, head metas, root element
 * id, first script `src`) collide by chance.
 *
 * `remoteBodyStart === null` (the fetch failed, timed out, or was CORS-
 * blocked — see `fetchBodyStart`'s own doc comment) is NEVER a match: this
 * function fails closed, exactly like the reuse decision it feeds — an
 * unconfirmed port is treated the same as a confirmed mismatch, never as a
 * free pass to reuse.
 */
export function contentFingerprintMatches(remoteBodyStart: string | null, localIndexHtml: string): boolean {
  if (remoteBodyStart === null) return false;
  const remote = normalizeForFingerprint(remoteBodyStart).slice(0, CONTENT_FINGERPRINT_MAX_CHARS);
  const local = normalizeForFingerprint(localIndexHtml).slice(0, CONTENT_FINGERPRINT_MAX_CHARS);
  return remote.length > 0 && remote === local;
}

// ── Package manager detection (one readDir, lockfile name only) ──────

const LOCKFILE_PACKAGE_MANAGERS: ReadonlyArray<{ readonly name: string; readonly packageManager: PackageManager }> = [
  { name: 'pnpm-lock.yaml', packageManager: 'pnpm' },
  { name: 'yarn.lock', packageManager: 'yarn' },
  { name: 'package-lock.json', packageManager: 'npm' },
];

async function detectPackageManager(projectRoot: string, deps: DevPreviewDeps): Promise<PackageManager> {
  try {
    const entries = await deps.readDir(projectRoot);
    const names = new Set(entries.map((e) => e.name));
    for (const { name, packageManager } of LOCKFILE_PACKAGE_MANAGERS) {
      if (names.has(name)) return packageManager;
    }
  } catch {
    // readDir failure — fall through to the npm default below.
  }
  return 'npm';
}

// ── Per-project configuration (localStorage — same convention as
// autoPreviewPrefs.ts's dismissal set) ────────────────────────────────

const PORT_OVERRIDE_STORAGE_KEY = 'lazy.canvas.devPreviewPortOverrides';
const IDLE_TIMEOUT_STORAGE_KEY = 'lazy.canvas.devPreviewIdleTimeoutMs';

/** 30 minutes — the task's own default; overridable per project via
 *  `setIdleTimeoutMs`. */
export const DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function readNumberRecord(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

function writeNumberRecord(key: string, record: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // best-effort only — same convention as autoPreviewPrefs.ts
  }
}

/** A user-configured port override for `projectId`, or undefined when none
 *  was ever set (the heuristic in `detectDevServerConfig` decides alone). */
export function getConfiguredPort(projectId: string): number | undefined {
  return readNumberRecord(PORT_OVERRIDE_STORAGE_KEY)[projectId];
}

export function setConfiguredPort(projectId: string, port: number | undefined): void {
  const record = readNumberRecord(PORT_OVERRIDE_STORAGE_KEY);
  if (port === undefined) delete record[projectId];
  else record[projectId] = port;
  writeNumberRecord(PORT_OVERRIDE_STORAGE_KEY, record);
}

/** 2026-08-07 wrong-project-preview incident — persisted (localStorage,
 *  same convention as PORT_OVERRIDE_STORAGE_KEY) record of the port THIS
 *  module has POSITIVELY confirmed `projectId`'s own dev server runs on:
 *  either because this module itself spawned it (see the
 *  `recordConfirmedDevServerPort` call at the successful-spawn site in
 *  `doEnsureDevServerForProject`) or because an already-answering port was
 *  reused after already being confirmed on an earlier call. Read on every
 *  `alreadyReachable` decision before ever trusting a reachable port
 *  belongs to THIS project — see that function's own doc comment for the
 *  real incident this exists to prevent. Persisted (not just in-memory)
 *  specifically so a project's dev server surviving an app restart (the
 *  legitimate "I left the terminal open" case) still gets recognized as
 *  ITS OWN on the next session, not merely on the session that first
 *  spawned it. */
const CONFIRMED_PORT_STORAGE_KEY = 'lazy.canvas.devPreviewConfirmedPorts';

/** The port THIS module has previously confirmed `projectId`'s own dev
 *  server runs on, or undefined when none was ever confirmed. Exported for
 *  tests that need to simulate a confirmation carried over from an earlier
 *  session — the same reason `getConfiguredPort`/`setConfiguredPort` are
 *  both exported despite the write side normally only being called
 *  internally by this module. */
export function getConfirmedDevServerPort(projectId: string): number | undefined {
  return readNumberRecord(CONFIRMED_PORT_STORAGE_KEY)[projectId];
}

/** Records that `port` is confirmed as `projectId`'s own dev server —
 *  called internally after a successful spawn or a confirmed reuse (see
 *  `doEnsureDevServerForProject`). Exported for the same test-simulation
 *  reason `getConfirmedDevServerPort` is. */
export function setConfirmedDevServerPort(projectId: string, port: number): void {
  const record = readNumberRecord(CONFIRMED_PORT_STORAGE_KEY);
  record[projectId] = port;
  writeNumberRecord(CONFIRMED_PORT_STORAGE_KEY, record);
}

/** True when `port` is confirmed — persisted, or currently managed in this
 *  very session — to belong to a DIFFERENT project than `projectId`. The
 *  strongest available "this is NOT mine" signal that never reads the
 *  target's response content (see `doEnsureDevServerForProject`'s own doc
 *  comment for why content-sniffing a live framework dev server, unlike the
 *  static-deliverable path's fixed index.html fingerprint, is deliberately
 *  out of scope here). Used only to enrich the diagnostic bus event fired on
 *  decline — the decline decision itself never depends on a POSITIVE answer
 *  here (see that function: an unconfirmed port is declined regardless of
 *  whether another project is confirmed to own it or nobody is). */
function isPortOwnedByAnotherProject(port: number, projectId: string): boolean {
  for (const server of activeServers.values()) {
    if (server.port === port && server.projectId !== projectId) return true;
  }
  const record = readNumberRecord(CONFIRMED_PORT_STORAGE_KEY);
  return Object.entries(record).some(([otherProjectId, otherPort]) => otherProjectId !== projectId && otherPort === port);
}

/** The idle-stop timeout for `projectId` — `DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS`
 *  unless overridden via `setIdleTimeoutMs`. */
export function getIdleTimeoutMs(projectId: string): number {
  return readNumberRecord(IDLE_TIMEOUT_STORAGE_KEY)[projectId] ?? DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS;
}

export function setIdleTimeoutMs(projectId: string, ms: number | undefined): void {
  const record = readNumberRecord(IDLE_TIMEOUT_STORAGE_KEY);
  if (ms === undefined) delete record[projectId];
  else record[projectId] = ms;
  writeNumberRecord(IDLE_TIMEOUT_STORAGE_KEY, record);
}

// ── Injectable I/O boundary ────────────────────────────────────────────

export interface DevServerShellHandle {
  write: (data: string) => void;
  kill: () => void;
  onData: (cb: (chunk: string) => void) => () => void;
}

export interface DevPreviewDeps {
  /** Reads a file's content as text — same contract as `platform.fs.
   *  readFile` (rejects when missing/unreadable). */
  readFile: (path: string) => Promise<string>;
  /** Lists a directory's entries — used only to sniff a lockfile name
   *  (package-manager detection), same contract as `platform.fs.readDir`. */
  readDir: (path: string) => Promise<Array<{ name: string; isDir: boolean }>>;
  /** Best-effort "is anything listening on this port" — never rejects. */
  probeReachable: (port: number) => Promise<boolean>;
  /** Best-effort "first bytes of this port's `/index.html` response" — used
   *  only by ensureStaticDevServer's content-fingerprint check (see
   *  `contentFingerprintMatches`) to confirm an already-answering static
   *  port is actually serving THIS project's deliverable before reusing it
   *  (2026-08-04 orphaned-server incident). Same "never rejects" contract as
   *  `probeReachable`: resolves to null on ANY failure (timeout, network
   *  error, non-2xx, ...) — a null is treated as "match not confirmed", not
   *  as a free pass to reuse. */
  fetchBodyStart: (port: number) => Promise<string | null>;
  /** Spawns an interactive shell PTY in `cwd`. See this module's header for
   *  why the caller must `write()` a command rather than pass one here. */
  spawnShell: (cwd: string) => Promise<DevServerShellHandle>;
  now: () => number;
  /** FOUNDER NORTH STAR — current machine pressure (systemPressure.ts):
   *  read once per doEnsureDevServerForProject call, right before deciding
   *  whether to spawn a NEW dev server. Injectable for the same testability
   *  reason as every other boundary here, even though it isn't classic I/O.
   *  Defaults to the real shared systemPressure store. */
  getPressureLevel: () => PressureLevel;
}

const DEV_SERVER_PROBE_TIMEOUT_MS = 1_500;

/** Max characters read from a static port's `/index.html` response body by
 *  `defaultFetchBodyStart` — well above `CONTENT_FINGERPRINT_MAX_CHARS`
 *  (the comparison itself only looks at the first 200) so the fingerprint
 *  check never starves on a truncated `<head>`. */
const FETCH_BODY_START_MAX_CHARS = 2_048;

/** Bug fix (same IPv6/localhost gotcha as PreviewNode.tsx's own
 *  `probeReachable` — see that function's doc comment for the full root
 *  cause): probing `localhost` here can read a genuinely-running IPv4-only
 *  server as unreachable, which would make this module spawn a SECOND
 *  server on top of one already running instead of reusing it (the
 *  `alreadyReachable` check right below this deps boundary). `127.0.0.1`
 *  is the literal loopback the dev server actually bound. */
async function defaultProbeReachable(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}`, { mode: 'no-cors', signal: AbortSignal.timeout(DEV_SERVER_PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

/** 2026-08-04 orphaned-static-server incident fix — reads (at most
 *  `FETCH_BODY_START_MAX_CHARS` of) the `/index.html` response from an
 *  already-answering static port, so ensureStaticDevServer can fingerprint
 *  it against the local deliverable before reusing it (see
 *  `contentFingerprintMatches`). Deliberately NOT `mode: 'no-cors'` like
 *  `defaultProbeReachable` above — an opaque no-cors response body can never
 *  be read, and this call needs the actual bytes. That means a target with
 *  no permissive CORS header resolves to null here exactly like a network
 *  failure or timeout would (same fail-closed contract as this function's
 *  own DevPreviewDeps doc comment: null is never treated as a match).
 *  RESIDUAL RISK, accepted for this fix: a legitimate same-project static
 *  server with no CORS header is therefore also unconfirmable, and gets
 *  skipped exactly like a real foreign one — never a WRONG reuse, at worst
 *  a redundant spawn on the next free port. `res.text()` reads the full
 *  body before slicing: acceptable because a static deliverable's
 *  `index.html` is always small — this is a fingerprint check, not a
 *  general-purpose partial-content fetch.
 *
 *  Exported (2026-08-05 foreign-server-adoption incident fix) — reused
 *  verbatim by useCanvasAutoComposition.ts's passive CANDIDATE_DEV_PORTS
 *  fallback to fingerprint a candidate before ever adopting it as a
 *  project's preview (see that hook's own module header + `contentFingerprintMatches`
 *  doc comment); the function is generic over `port`, equally valid against
 *  a STATIC_SERVER_PORTS candidate or a CANDIDATE_DEV_PORTS one. */
export async function defaultFetchBodyStart(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/index.html`, { signal: AbortSignal.timeout(DEV_SERVER_PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.text()).slice(0, FETCH_BODY_START_MAX_CHARS);
  } catch {
    return null;
  }
}

const realDeps: DevPreviewDeps = {
  readFile: (path) => getPlatform().fs.readFile(path),
  readDir: (path) => getPlatform().fs.readDir(path),
  probeReachable: defaultProbeReachable,
  fetchBodyStart: defaultFetchBodyStart,
  spawnShell: async (cwd) => {
    const pty = await getPlatform().terminal.spawn('sh', [], { cwd });
    return {
      write: (data: string) => pty.write(data),
      kill: () => pty.kill(),
      onData: (cb: (chunk: string) => void) => pty.onData(cb),
    };
  },
  now: () => Date.now(),
  getPressureLevel: () => getSystemPressure().level,
};

// ── Orchestration state ────────────────────────────────────────────────

/** Bounded ring buffer size for a managed server's captured PTY output —
 *  "logs accessible" (module header) without an unbounded memory leak for
 *  a dev server left running for hours. */
const MAX_LOG_LINES = 500;

interface ManagedDevServer {
  projectId: string;
  port: number;
  url: string;
  logs: string[];
  kill: () => void;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActiveAtMs: number;
}

const activeServers = new Map<string, ManagedDevServer>();
const inFlightEnsure = new Map<string, Promise<DevPreviewResult | null>>();

/** Every reason ensureDevServerForProject can decline to spawn/retry a NEW
 *  server for a project:
 *   - 'pressure_high' / 'pressure_elevated' — the preemptive pressure gate
 *     (see doEnsureDevServerForProject) declined a NEW spawn outright.
 *   - 'spawn_deferred_memory' — 2026-07-22 memory-pressure incident fix: an
 *     actual spawn attempt hit an OS-level "not enough memory" failure
 *     (terminal.rs's typed error prefix) and a single retry is scheduled
 *     60s out (see deferSpawnRetryAfterInsufficientMemory below).
 *   - 'ports_busy_foreign_content' — 2026-08-04 orphaned-static-server
 *     incident fix: every port in STATIC_SERVER_PORTS answered, but NONE of
 *     them is serving THIS project's resolved staticRoot deliverable (see
 *     ensureStaticDevServer's content-fingerprint check) — an orphaned
 *     server from a DIFFERENT project (e.g. a stale `npx serve` left
 *     running) is squatting the whole list. Reusing any of them would
 *     silently show the user the wrong project, and there is no free port
 *     left to spawn a fresh server on either.
 *   - 'port_unconfirmed' — 2026-08-07 wrong-project-preview incident fix:
 *     the project's resolved framework port (e.g. Next.js's default 3000)
 *     already answers, but this module has no positive record (see
 *     `getConfirmedDevServerPort`) that the answering server is THIS
 *     project's own — it may be a completely unrelated project's dev server
 *     left running from an earlier session (the real incident: a stale
 *     lazy-backoffice Next.js server on 3000 got silently attributed to a
 *     different project's preview). Declined rather than attached to a
 *     possible squatter — see doEnsureDevServerForProject's own doc comment
 *     for the full reasoning. */
export type DevServerSkipReason =
  | 'pressure_high'
  | 'pressure_elevated'
  | 'spawn_deferred_memory'
  | 'ports_busy_foreign_content'
  | 'port_unconfirmed';

/** FOUNDER NORTH STAR — set only when a NEW dev server was deliberately not
 *  spawned/attempted this call (see the pressure gate and the
 *  insufficient-memory catch in doEnsureDevServerForProject below); read by
 *  getDevServerSkipReason so a consumer (the canvas preview node, once
 *  wired — see this module's own residual-wiring note there) can surface
 *  WHY, never leaving the user guessing at a silent "offline". Cleared at
 *  the top of every fresh ensure attempt so a stale reason never outlives
 *  the condition that caused it. */
const skipReasons = new Map<string, DevServerSkipReason>();

/** The reason ensureDevServerForProject most recently declined to spawn a
 *  NEW server for `projectId` — `undefined` when no such skip happened (an
 *  already-managed/reused server, a non-Node project, or normal pressure).
 *  See devPreview.ts's module header + PressureLevel for the founder north
 *  star this exists for. */
export function getDevServerSkipReason(projectId: string): DevServerSkipReason | undefined {
  return skipReasons.get(projectId);
}

/**
 * 2026-07-22 memory-pressure incident: projects with an OS-level "not
 * enough memory to spawn" failure awaiting exactly ONE scheduled retry (see
 * `deferSpawnRetryAfterInsufficientMemory`) — set the instant such a
 * failure is detected, cleared right before that single retry fires (so a
 * LATER independent failure can be deferred again). While a project is in
 * this set, doEnsureDevServerForProject short-circuits to `null`
 * immediately instead of re-attempting the actual spawn — without this, a
 * project stuck at low memory would get hammered with a fresh
 * CreateProcess attempt on every ~4s poll tick
 * (useCanvasAutoComposition.ts's port-probe interval), exactly the
 * opposite of "gentle" recovery.
 */
const pendingMemoryRetry = new Set<string>();

/** How long after an insufficient-memory spawn failure before the single
 *  scheduled retry fires. */
const RETRY_AFTER_INSUFFICIENT_MEMORY_MS = 60_000;

/** Matches terminal.rs's own stable error prefix
 *  (`SPAWN_ERROR_INSUFFICIENT_MEMORY_PREFIX`) for an OS-level "not enough
 *  memory to create this process" spawn failure — Windows `os error 8` /
 *  POSIX ENOMEM. Never true for any other spawn failure (a missing shell,
 *  a permission error, a bad cwd, ...), which must keep degrading silently
 *  exactly as before this fix (see doEnsureDevServerForProject's catch
 *  block). */
function isInsufficientMemorySpawnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes('INSUFFICIENT_MEMORY:');
}

/**
 * FOUNDER NORTH STAR (2026-07-21/22 memory-pressure incident — see this
 * module's own header): an auto-spawn attempt failed because the OS itself
 * refused to create the process for lack of memory — the WORST possible
 * moment to hammer the machine with an identical retry on the very next
 * poll tick. Instead: mark `projectId` deferred (`pendingMemoryRetry` blocks
 * every intermediate tick from re-attempting the spawn at all — see
 * doEnsureDevServerForProject's own early-return), journal the deferral as
 * an honest `spawn.deferred` event (visible in the activity ticker, never a
 * silent background retry) and emit a bus event so a real UI surface with
 * toast access can show a SOFT in-app notice (never the raw OS error as an
 * unowned dialog — see bus.ts's `devPreview:spawnDeferredMemory` doc
 * comment for the wiring), then schedule EXACTLY ONE retry `RETRY_AFTER_
 * INSUFFICIENT_MEMORY_MS` later. That retry re-enters
 * doEnsureDevServerForProject with `allowElevatedPressure: true` — a
 * DELIBERATELY more lenient pressure check than a fresh spawn's own
 * preemptive gate (which blocks at 'elevated' too): the failure that got us
 * here already implies the preemptive gate did not stop it (this codebase's
 * pressure signal does not perfectly track real-time available RAM — see
 * systemPressure.ts's own graceful-degradation contract), so the recovery
 * retry only needs pressure to have eased off 'high', not all the way back
 * to 'normal'. If that retry itself fails the same way, this same function
 * runs again — an honest, self-renewing single-retry-per-failure backoff,
 * not an unbounded tight loop (each retry is still 60s apart and still
 * pressure-checked).
 */
function deferSpawnRetryAfterInsufficientMemory(
  projectId: string,
  projectRoot: string,
  deps: DevPreviewDeps,
  worktreeRels?: readonly (string | undefined)[],
): void {
  pendingMemoryRetry.add(projectId);
  skipReasons.set(projectId, 'spawn_deferred_memory');

  void emitEvent({
    type: 'spawn.deferred',
    tsMs: deps.now(),
    projectId,
    actor: 'system',
    payload: { reason: 'insufficient_memory', retryInMs: RETRY_AFTER_INSUFFICIENT_MEMORY_MS },
  }).catch(() => {
    // best-effort only — mirrors this codebase's other fire-and-forget
    // journal writes (e.g. agentsStore.tsx's fleet.hygiene emission).
  });

  emit('devPreview:spawnDeferredMemory', { projectId, retryInMs: RETRY_AFTER_INSUFFICIENT_MEMORY_MS });

  setTimeout(() => {
    pendingMemoryRetry.delete(projectId);
    const retry = doEnsureDevServerForProject(projectId, projectRoot, deps, { allowElevatedPressure: true }, worktreeRels).finally(() => {
      if (inFlightEnsure.get(projectId) === retry) inFlightEnsure.delete(projectId);
    });
    inFlightEnsure.set(projectId, retry);
  }, RETRY_AFTER_INSUFFICIENT_MEMORY_MS);
}

export interface DevPreviewResult {
  url: string;
  port: number;
  /**
   * true when a server was ALREADY answering on the resolved port — this
   * module neither started it nor will ever stop it (see the idle-stop
   * section below, which only ever acts on a server THIS module spawned).
   * false when this call spawned/is managing the process itself.
   */
  reused: boolean;
}

function cancelIdleTimer(handle: ManagedDevServer): void {
  if (handle.idleTimer !== null) {
    clearTimeout(handle.idleTimer);
    handle.idleTimer = null;
  }
}

interface DoEnsureOpts {
  /** 2026-07-22 memory-pressure incident: set ONLY by the single scheduled
   *  retry deferSpawnRetryAfterInsufficientMemory schedules after an
   *  insufficient-memory failure — see that function's own doc comment for
   *  why the recovery retry is deliberately more lenient (blocks only at
   *  'high', not 'elevated') than a fresh spawn's own preemptive gate. */
  allowElevatedPressure?: boolean;
}

async function doEnsureDevServerForProject(
  projectId: string,
  projectRoot: string,
  deps: DevPreviewDeps,
  opts: DoEnsureOpts = {},
  worktreeRels?: readonly (string | undefined)[],
): Promise<DevPreviewResult | null> {
  const existing = activeServers.get(projectId);
  if (existing) {
    existing.lastActiveAtMs = deps.now();
    cancelIdleTimer(existing);
    return { url: existing.url, port: existing.port, reused: false };
  }

  if (pendingMemoryRetry.has(projectId)) {
    // A single retry is already scheduled after an earlier OS "not enough
    // memory to spawn" failure (see deferSpawnRetryAfterInsufficientMemory)
    // — never re-attempt the actual spawn on every subsequent tick
    // (useCanvasAutoComposition.ts polls every few seconds) while that
    // timer is outstanding; hammering an already memory-starved machine
    // with repeated CreateProcess calls is exactly what this guard exists
    // to avoid.
    skipReasons.set(projectId, 'spawn_deferred_memory');
    return null;
  }

  // 2026-08-07 wrong-project-preview incident — captured BEFORE the clear
  // right below, so the alreadyReachable branch further down can tell
  // whether an unconfirmed-port decline is a FRESH transition (worth one
  // diagnostic bus event) or a repeat of the same decline on every ~4s
  // polling tick (never worth re-notifying).
  const previousSkipReason = skipReasons.get(projectId);

  // A fresh attempt starts honest — any stale skip reason from an earlier
  // call is cleared up front; the pressure gate below re-sets it only if it
  // applies again THIS time.
  skipReasons.delete(projectId);

  // Rust's `read_file`/`read_dir` commands reject a Windows verbatim
  // (`\\?\`) prefix (see src/lib/paths.ts's header + toolRuntime.ts's own
  // `stripVerbatimPrefix(path)` call sites) — `platform.fs.*` itself does
  // NOT strip it (tauri.ts's nativeFs passes the path straight to invoke),
  // so every caller must strip it first. Stripping is a no-op for an
  // already-plain path, so this is always safe to apply unconditionally.
  const root = stripVerbatimPrefix(projectRoot);

  // P46+P48 round 2 — a mission's plain-HTML deliverable (in its own git
  // worktree, e.g. `public/game` under `.lazy/worktrees/<mission>`) has no
  // `scripts.dev` for detectDevServerConfig to find. When mission worktrees
  // are known, resolve and serve that deliverable FIRST — it is what the
  // user is looking at — before falling back to the framework path below.
  if (worktreeRels && worktreeRels.some((r) => r && r.trim())) {
    const staticRoot = await resolveWebDeliverableRoot(root, worktreeRels, deps);
    if (staticRoot) return ensureStaticDevServer(projectId, staticRoot, root, deps, worktreeRels);
  }

  let packageJsonRaw: string;
  try {
    packageJsonRaw = await deps.readFile(joinPath(root, 'package.json'));
  } catch {
    // No package.json — a plain static site at the project root is still a
    // valid deliverable: serve it statically (P46+P48 round 2).
    const staticRoot = await resolveWebDeliverableRoot(root, undefined, deps);
    if (staticRoot) return ensureStaticDevServer(projectId, staticRoot, root, deps, worktreeRels);
    return null; // not a Node project (or unreadable) — nothing this module can drive
  }

  const config = detectDevServerConfig(packageJsonRaw, { portOverride: getConfiguredPort(projectId) });
  if (!config) return null;

  const alreadyReachable = await deps.probeReachable(config.port);
  if (alreadyReachable) {
    // 2026-08-07 wrong-project-preview incident (real repro): LazySite-
    // internet (a Next.js project, default port 3000) probed 3000, found a
    // STALE lazy-backoffice dev server still answering there from an
    // earlier session, and — under the old "anything reachable is ours"
    // rule — reused it verbatim. The canvas preview then rendered
    // lazy-backoffice's own Next.js "Server Error" page (its absolute file
    // paths fully visible) under a green "Live" badge, silently attributed
    // to the WRONG project. Blind reuse never distinguished the user's OWN
    // dev server (started manually, or by this module in an earlier
    // session) from a completely unrelated project's server merely
    // squatting the same default port.
    //
    // Content-sniffing the response (the way `contentFingerprintMatches`
    // already does for the static-deliverable path) does not generalize
    // here — a live Next.js/Vite dev server's HTML is dynamically rendered,
    // not a fixed local file to diff against, so there is no reliable local
    // reference to compare it to. The only trustworthy signal left is OUR
    // OWN record of which project this port actually belongs to: an
    // explicit per-project port override (the user's own deliberate
    // configuration — `getConfiguredPort`) or a port this module has
    // previously, positively confirmed belongs to THIS project
    // (`getConfirmedDevServerPort` — set below on every successful spawn,
    // persisted so it survives an app restart). Anything else — including a
    // genuinely first-ever-seen reachable port with no record either way —
    // is now treated as UNCONFIRMED rather than trusted: reusing it is
    // exactly the risk that caused the incident, so this declines to attach
    // instead, surfacing an honest 'port_unconfirmed' skip reason the UI can
    // act on (see bus.ts's 'devPreview:portUnconfirmed') rather than
    // silently showing the wrong project as "Live".
    const confirmedPort = getConfirmedDevServerPort(projectId);
    const hasExplicitOverride = getConfiguredPort(projectId) !== undefined;
    if (confirmedPort === config.port || hasExplicitOverride) {
      skipReasons.delete(projectId);
      setConfirmedDevServerPort(projectId, config.port);
      return { url: `http://localhost:${config.port}`, port: config.port, reused: true };
    }

    skipReasons.set(projectId, 'port_unconfirmed');
    if (previousSkipReason !== 'port_unconfirmed') {
      // Fired once per DECLINE TRANSITION, never once per ~4s polling tick
      // (same "one diagnostic per transition" posture as
      // deferSpawnRetryAfterInsufficientMemory's own bus emission) — a
      // real UI surface (useCanvasAutoComposition.ts, the sole caller of
      // ensureDevServerForProject) can show a soft, actionable notice
      // instead of silently doing nothing.
      emit('devPreview:portUnconfirmed', {
        projectId,
        port: config.port,
        ownedByOtherProject: isPortOwnedByAnotherProject(config.port, projectId),
      });
    }
    return null;
  }

  // FOUNDER NORTH STAR — never spawn a NEW process (extra machine load)
  // while the machine is already under pressure. Reuse-if-running above is
  // unaffected; only a genuinely NEW spawn is gated here. Tightened
  // 2026-07-22 (memory-pressure incident): a fresh, preemptive spawn now
  // also blocks at 'elevated' (not just 'high') for this auto-flow — the
  // ONLY caller of ensureDevServerForProject is useCanvasAutoComposition.ts's
  // background port-probe, never a user-initiated action, so the wider
  // gate never blocks anything a user directly asked for (a manually
  // opened terminal, "Formater le document", etc. all spawn through
  // platform.terminal.spawn directly, untouched by this module). The single
  // scheduled retry after an insufficient-memory failure
  // (deferSpawnRetryAfterInsufficientMemory) passes `allowElevatedPressure:
  // true` to fall back to the OLDER, more lenient 'high'-only check — see
  // that function's own doc comment for why. An older Rust build that never
  // reports pressure (see systemPressure.ts's own graceful-degradation
  // contract) always reads 'normal' here, so this is a pure no-op then —
  // exactly today's behavior.
  const pressureLevel = deps.getPressureLevel();
  const blockedByPressure = opts.allowElevatedPressure ? pressureLevel === 'high' : pressureLevel === 'high' || pressureLevel === 'elevated';
  if (blockedByPressure) {
    skipReasons.set(projectId, pressureLevel === 'high' ? 'pressure_high' : 'pressure_elevated');
    return null;
  }
  skipReasons.delete(projectId);

  try {
    const packageManager = await detectPackageManager(root, deps);
    const shell = await deps.spawnShell(root);
    const logs: string[] = [];
    shell.onData((chunk) => {
      logs.push(chunk);
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
    });
    shell.write(`${devServerCommand(packageManager)}\r\n`);

    const handle: ManagedDevServer = {
      projectId,
      port: config.port,
      url: `http://localhost:${config.port}`,
      logs,
      kill: shell.kill,
      idleTimer: null,
      lastActiveAtMs: deps.now(),
    };
    activeServers.set(projectId, handle);
    // 2026-08-07 wrong-project-preview incident fix — this module itself
    // just spawned this port for this project, the strongest possible
    // ownership signal there is; persisted so a FUTURE session's
    // `alreadyReachable` check (this project's server surviving an app
    // restart) recognizes it as this project's own rather than declining it
    // as unconfirmed.
    setConfirmedDevServerPort(projectId, config.port);
    return { url: handle.url, port: config.port, reused: false };
  } catch (err) {
    // 2026-07-22 memory-pressure incident — an OS-level "not enough memory
    // to create this process" failure (terminal.rs's typed error prefix)
    // gets a SOFT deferred-retry path instead of degrading silently like
    // every other spawn failure below.
    if (isInsufficientMemorySpawnError(err)) {
      deferSpawnRetryAfterInsufficientMemory(projectId, projectRoot, deps);
      return null;
    }
    // The PTY infra failed to spawn for some OTHER reason — degrade to
    // "nothing to attach yet" rather than throw; the caller's existing
    // passive-probe fallback (useCanvasAutoComposition.ts) still gets a
    // chance to find a preview.
    return null;
  }
}

/**
 * Ensures a dev server is running (or already reachable) for `projectId`,
 * spawning it via the real PTY infra when genuinely needed. Concurrent
 * calls for the SAME project while one is already in flight share the one
 * promise (never spawn twice for a burst of near-simultaneous callers).
 */
export function ensureDevServerForProject(
  projectId: string,
  projectRoot: string,
  deps: DevPreviewDeps = realDeps,
  worktreeRels?: readonly (string | undefined)[],
  opts: DoEnsureOpts = {},
): Promise<DevPreviewResult | null> {
  const inFlight = inFlightEnsure.get(projectId);
  if (inFlight) return inFlight;

  const promise = doEnsureDevServerForProject(projectId, projectRoot, deps, opts, worktreeRels)
    .then((result) => {
      recordEnsureResult(projectId, result);
      return result;
    })
    .finally(() => {
      inFlightEnsure.delete(projectId);
    });
  inFlightEnsure.set(projectId, promise);
  return promise;
}

/**
 * Tells devPreview.ts whether `projectId` currently has any active
 * (running) mission — the ONLY signal that starts or cancels the idle-stop
 * countdown for a dev server THIS module spawned. A no-op for a project
 * this module is not managing (nothing to stop) or one it only reused
 * (never its process to kill — see `DevPreviewResult.reused`).
 */
export function noteProjectMissionActivity(
  projectId: string,
  hasActiveMissions: boolean,
  deps: DevPreviewDeps = realDeps,
): void {
  const handle = activeServers.get(projectId);
  if (!handle) return;
  if (hasActiveMissions) {
    handle.lastActiveAtMs = deps.now();
    cancelIdleTimer(handle);
    return;
  }
  if (handle.idleTimer !== null) return; // already counting down
  const timeoutMs = getIdleTimeoutMs(projectId);
  handle.idleTimer = setTimeout(() => stopDevServer(projectId), timeoutMs);
}

/** Stops (kills) a dev server this module manages for `projectId` — a
 *  no-op for a project it isn't managing (nothing to stop) or one it only
 *  reused. Exposed directly (not only via the idle timer) for a future
 *  explicit "stop preview" UI action.
 *
 *  Preview lifecycle fix: emits `devPreview:serverStopped` so the canvas
 *  preview surface for this project (if any, and if still pointed at THIS
 *  url) is removed rather than left polling a port nothing listens on
 *  anymore — see bus.ts's own doc comment for the full wiring. Fires for
 *  BOTH callers of this function: an explicit stop and the idle-timeout
 *  path (`noteProjectMissionActivity`'s `setTimeout(() =>
 *  stopDevServer(projectId), ...)` above), since both mean the same thing
 *  to the canvas — this server is gone. */
export function stopDevServer(projectId: string): void {
  const handle = activeServers.get(projectId);
  if (!handle) return;
  cancelIdleTimer(handle);
  handle.kill();
  activeServers.delete(projectId);
  emit('devPreview:serverStopped', { projectId, url: handle.url });
}

/** True while this module is managing (and could later kill) a dev server
 *  for `projectId` — false for a project with no server, or one whose
 *  server was only ever reused (see `DevPreviewResult.reused`). */
export function isDevServerManaged(projectId: string): boolean {
  return activeServers.has(projectId);
}

/** Captured PTY output for a managed dev server — "logs accessible" per
 *  this module's header, bounded to the last `MAX_LOG_LINES` chunks.
 *  Empty for a project with no managed server. */
export function getDevServerLogs(projectId: string): readonly string[] {
  return activeServers.get(projectId)?.logs ?? [];
}

// ── Dev-only debug handle (window.__lazyDevPreview) ────────────────────
// Replaces the old qa.preview.diag journal spam (removed from
// useCanvasAutoComposition.ts — it fired on every render) with a
// zero-cost-in-prod live inspection surface for "why is my preview not
// showing up": skipReason(projectId), managed(), lastEnsure().

/** One ring-buffer entry per resolved {@link ensureDevServerForProject}
 *  call (concurrent dedup callers for the same project share one entry —
 *  see that function's own doc comment). */
export interface DevPreviewEnsureLogEntry {
  tsMs: number;
  projectId: string;
  url: string | null;
  reused: boolean | null;
  skipReason: DevServerSkipReason | null;
}

const ENSURE_LOG_MAX_ENTRIES = 20;
const ensureResultLog: DevPreviewEnsureLogEntry[] = [];

function recordEnsureResult(projectId: string, result: DevPreviewResult | null): void {
  if (!import.meta.env.DEV) return; // dead-code-eliminated in a production build
  ensureResultLog.push({
    tsMs: Date.now(),
    projectId,
    url: result?.url ?? null,
    reused: result?.reused ?? null,
    skipReason: getDevServerSkipReason(projectId) ?? null,
  });
  if (ensureResultLog.length > ENSURE_LOG_MAX_ENTRIES) ensureResultLog.shift();
}

interface LazyDevPreviewDebugHandle {
  skipReason: (projectId: string) => DevServerSkipReason | undefined;
  managed: () => ReadonlyArray<{ projectId: string; port: number; url: string }>;
  lastEnsure: () => readonly DevPreviewEnsureLogEntry[];
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __lazyDevPreview: LazyDevPreviewDebugHandle }).__lazyDevPreview = {
    skipReason: getDevServerSkipReason,
    managed: () => Array.from(activeServers.values()).map(({ projectId, port, url }) => ({ projectId, port, url })),
    lastEnsure: () => ensureResultLog,
  };
}

/** Test-only reset — clears every managed server WITHOUT calling its real
 *  `kill()` (nothing real to kill in a unit test), mirroring canvasStore.ts's
 *  own `_resetCanvasStoreForTests` convention. */
export function _resetDevPreviewForTests(): void {
  for (const handle of activeServers.values()) cancelIdleTimer(handle);
  activeServers.clear();
  inFlightEnsure.clear();
  skipReasons.clear();
  pendingMemoryRetry.clear();
  ensureResultLog.length = 0;
}
