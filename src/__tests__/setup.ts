import '@testing-library/jest-dom';
import { invoke } from '@tauri-apps/api/core';
import { _resetJournalMissionsFeedForTests } from '../lib/agents/journalMissionsFeed';
import { invalidateProjectRootCache } from '../lib/agents/projectRootCache';
import { invalidateAgentsListCache } from '../lib/agents/agentsStorage';

// ── Global Tauri mocks ──────────────────────────────────────────────
// Any module importing @tauri-apps/api/core or @tauri-apps/api/event
// will get these stubs instead of the real Tauri runtime.

// Default invoke resolution. Every command resolves `undefined` EXCEPT
// `read_dir`, which resolves a real (empty) array: the native fs.readDir
// (src/lib/platform/tauri.ts) immediately .map()s the result, so a bare
// `undefined` makes it throw — and agentsStore.tsx's worktree existence
// probe (defaultWorktreeExists, read by approveMission/discardMission)
// reads a throwing readDir as "directory gone", a false negative that
// fails every approve/discard test which simulates Tauri against a
// virtual repo. `[]` is the honest "directory exists but is empty"
// signal, and it is exactly what agentsStore.test.tsx's own pre-existing
// convention already arranges (`read_dir ? [] : undefined`, see that
// file's WORKTREE-DESTROYED-PRE-MERGE test setup).
const { defaultInvoke } = vi.hoisted(() => ({
  defaultInvoke: (cmd: string): Promise<unknown> =>
    cmd === 'read_dir' ? Promise.resolve([]) : Promise.resolve(undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(defaultInvoke),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Unsigned jsdom + default picker (free GLM) would otherwise hit
// sendManagerMessage's session gate on every manager test. Production still
// blocks unsigned web (managerSessionHonesty.test.tsx mocks this false).
vi.mock('../lib/agents/managerSessionGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerSessionGate')>();
  return {
    ...actual,
    hasManagedSession: vi.fn(async () => true),
  };
});

// Ensure window.__TAURI_INTERNALS__ is absent so isTauriRuntime() returns false
// (WebPlatform / mock paths will be exercised in tests).
if (typeof window !== 'undefined') {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

// ── Real-terminal jsdom gaps ─────────────────────────────────────────
// TerminalStrip.tsx (commit 6cef1b6) now mounts terminal sessions
// unconditionally (CSS `display` toggle, no longer a conditional render),
// so any suite that renders CodeSpace/TerminalStrip for real without
// mocking '@xterm/xterm' instantiates a REAL xterm Terminal against jsdom.
// jsdom is missing THREE browser APIs that a real Terminal.open() needs
// just to construct, confirmed by reproducing the crash with each stub
// added one at a time:
//   - HTMLCanvasElement.prototype.getContext (no `canvas` npm package
//     installed — xterm's Color.ts probes a throwaway canvas to resolve CSS
//     colors) — jsdom throws "Not implemented" for this by default.
//   - window.matchMedia — CoreBrowserService's _updateDpr() calls it
//     unconditionally to track devicePixelRatio; jsdom 24.x does not
//     implement it at all (`typeof window.matchMedia === 'undefined'`),
//     so calling it throws a plain TypeError, not a "not implemented"
//     warning — this is what actually crashes Terminal.open() with
//     "this._parentWindow.matchMedia is not a function". This failure is
//     deterministic, not load-sensitive: jsdom structurally has no
//     matchMedia implementation at all, confirmed outside vitest too.
//   - ResizeObserver — see below; used by TerminalView.tsx itself, not by
//     xterm's internals.
// These stubs are the honest minimum to let Terminal.open() complete
// without throwing; they do not make xterm's canvas-based rendering
// pixel-correct, so tests that need to observe real rendered output should
// still mock '@xterm/xterm' directly per file (see TerminalView.test.tsx)
// — this is a backstop against the crash, not a substitute for that.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
// TerminalView's own resize-fit effect (not xterm itself) calls
// `new ResizeObserver(...)` directly — jsdom has no ResizeObserver either.
// Several suites already install their own mock per-file (beforeEach,
// e.g. TerminalView.test.tsx, CanvasView.test.tsx) when they need to
// assert on observe/unobserve calls; this only supplies a harmless default
// for suites that mount a real TerminalView without doing that themselves,
// and any per-file beforeEach still overrides it as usual.
//
// Deliberately a plain ES class, NOT `vi.fn()` — a `vi.fn()`-based mock
// gets tracked in Vitest's global mock registry, and any test file that
// calls `vi.restoreAllMocks()`/`resetAllMocks()` in its own `beforeEach`
// (a common, unrelated hygiene pattern — see GraphProposalCard.test.tsx)
// silently strips the implementation from EVERY tracked mock process-wide,
// not just that file's own. That downgraded this stub to a no-op
// constructor returning `{}`, which still passes `typeof x === 'function'`
// (so components' existing "ResizeObserver is available" guards no longer
// protect them) but crashes on the first `.observe()` call — a real
// regression this exact stub caused in GraphProposalCard.test.tsx, caught
// by running the full suite. A plain class is never tracked by Vitest's
// mock lifecycle, so it can't be reset out from under an unrelated file.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof global !== 'undefined' && typeof (global as unknown as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

// ── Global test isolation ───────────────────────────────────────────
// Files sharing a vitest worker leak state through jsdom's persisted
// storage (localStorage/sessionStorage survive across test files in the
// same worker). Clear both after every test so no file can observe
// state written by a previous one.
afterEach(() => {
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.clear();
  }
  // Individual tests routinely override the shared `invoke` mock's
  // resolved value or implementation (mockResolvedValueOnce covers itself,
  // but mockResolvedValue/mockImplementation persist for the rest of the
  // file). Restore the module-level default so a later test in the same
  // file never observes a previous test's leaked implementation.
  (invoke as ReturnType<typeof vi.fn>).mockReset();
  (invoke as ReturnType<typeof vi.fn>).mockImplementation(defaultInvoke);
  // journalMissionsFeed.ts (perf audit: single shared journal_missions_current
  // poller/cache replacing three independent timers) is a module-level
  // singleton — its cached rows/listeners/interval would otherwise leak
  // across `it()` blocks in the same test file exactly like the `invoke`
  // mock above did before this file existed. Same convention as
  // approvalMode.ts's `_resetApprovalModesForTests`.
  _resetJournalMissionsFeedForTests();
  // resolveProjectRoot's IPC cache (projectRootCache.ts) would otherwise
  // leak a root from a previous test's mock across it() blocks — same
  // module-level singleton pattern as the two above.
  invalidateProjectRootCache();
  invalidateAgentsListCache();
});
