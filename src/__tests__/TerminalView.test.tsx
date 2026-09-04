/**
 * TerminalView.test.tsx
 *
 * Regression test for a P3 finding: TerminalView passed `cwd` straight
 * through to platform.terminal.spawn(), leaking Windows' verbatim "\\?\"
 * prefix — Rust's canonicalize() (AppContext's usual source for
 * projectRoot) returns paths with that prefix on Windows — into the
 * spawned shell's own prompt (e.g. `PS \\?\C:\...\>` in PowerShell). Fix:
 * strip it right at the spawn call site via the existing
 * stripVerbatimPrefix (src/lib/paths.ts), display-only — nothing about how
 * paths are stored/keyed elsewhere changes.
 *
 * @xterm/xterm and its fit addon are mocked out: they need a real canvas
 * backend jsdom doesn't provide, and this test only needs to observe what
 * TerminalView hands to platform.terminal.spawn(), not xterm's own
 * rendering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { TerminalView } from '../components/terminal/TerminalView';

// ── xterm mocks ─────────────────────────────────────────────────────────

const xtermWriteMock = vi.fn();

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    write: xtermWriteMock,
    dispose: vi.fn(),
    buffer: { active: { length: 0, getLine: () => undefined } },
  })),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
  })),
}));

vi.mock('../lib/ai/terminalAi', () => ({
  useTerminalAi: () => ({
    suggestCommand: vi.fn(),
    explainOutput: vi.fn(),
    isThinking: false,
  }),
}));

vi.mock('../lib/terminal/history', () => ({
  recordTerminalInput: vi.fn(),
  recordTerminalOutput: vi.fn(),
}));

// Minimal passthrough i18n — mirrors the convention already used elsewhere
// (e.g. ContextualBanner.test.tsx) for components that call useI18n()
// unconditionally.
vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

// R10 — captures the toast the honest spawn-rejection handler fires, without
// needing a real ToastProvider ancestor (useToastSafe's own contract).
// Path is relative to THIS file (src/__tests__/) — TerminalView.tsx imports
// from '../ui' relative to src/components/terminal/, both resolve to the
// same src/components/ui module.
const toastMock = vi.fn();
vi.mock('../components/ui', () => ({
  useToastSafe: () => toastMock,
}));

// ── platform mock — capture what spawn() receives ───────────────────────

const spawnMock = vi.fn().mockResolvedValue({
  pid: 0,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn(() => () => undefined),
  onExit: vi.fn(() => () => undefined),
});

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({
    name: 'tauri',
    terminal: { spawn: spawnMock },
  }),
}));

describe('TerminalView — cwd passed to platform.terminal.spawn', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    // jsdom does not implement ResizeObserver; TerminalView observes its
    // container to re-fit xterm on resize.
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));
  });

  it('strips the Windows verbatim "\\\\?\\" prefix before spawning the PTY', () => {
    render(<TerminalView cwd="\\?\C:\Users\user\Documents\proj" />);

    expect(spawnMock).toHaveBeenCalledWith('sh', [], { cwd: 'C:\\Users\\user\\Documents\\proj' });
  });

  it('strips the verbatim UNC prefix ("\\\\?\\UNC\\") the same way', () => {
    render(<TerminalView cwd="\\?\UNC\server\share\proj" />);

    expect(spawnMock).toHaveBeenCalledWith('sh', [], { cwd: '\\\\server\\share\\proj' });
  });

  it('passes an already-unprefixed cwd through unchanged', () => {
    render(<TerminalView cwd="C:\Users\user\Documents\proj" />);

    expect(spawnMock).toHaveBeenCalledWith('sh', [], { cwd: 'C:\\Users\\user\\Documents\\proj' });
  });

  it('passes an undefined cwd through unchanged (no project open yet)', () => {
    render(<TerminalView />);

    expect(spawnMock).toHaveBeenCalledWith('sh', [], { cwd: undefined });
  });
});

// ── R10: honest handling of a rejected PTY spawn (no unhandled rejection) ──
//
// R9 observed an unhandled promise rejection (pageerror) whose value was the
// cwd/reason string on terminal-node open: platform.terminal.spawn(...).then(...)
// had no .catch() at all. Fixed by handling the rejection honestly — written
// into the xterm pane and toasted — never silently swallowed, never unhandled.

describe('TerminalView — honest handling of a rejected PTY spawn', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    xtermWriteMock.mockClear();
    toastMock.mockClear();
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));
  });

  it('never leaves the spawn rejection unhandled — writes the reason to the pane and toasts it', async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (event: PromiseRejectionEvent) => unhandledRejections.push(event.reason);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    spawnMock.mockRejectedValueOnce('Working directory does not exist: C:\\gone\\missing');

    render(<TerminalView cwd="C:\gone\missing" />);

    // Flush the rejected microtask (the spawn promise's .catch handler).
    await Promise.resolve();
    await Promise.resolve();

    window.removeEventListener('unhandledrejection', onUnhandledRejection);

    expect(unhandledRejections).toEqual([]);
    expect(xtermWriteMock).toHaveBeenCalledWith(
      expect.stringContaining('Working directory does not exist: C:\\gone\\missing'),
    );
    expect(toastMock).toHaveBeenCalledWith(
      expect.stringContaining('Working directory does not exist: C:\\gone\\missing'),
      'error',
    );
  });

  it('describes a non-Error, non-string rejection with a generic fallback reason rather than "[object Object]"', async () => {
    spawnMock.mockRejectedValueOnce({ some: 'shape' });

    render(<TerminalView cwd="C:\gone\missing" />);

    await Promise.resolve();
    await Promise.resolve();

    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('unknown error'), 'error');
  });
});

// ── Root-cause regression: async-spawn/unmount race leaked the PTY ─────
//
// 2026-07-24 thread/handle leak: platform.terminal.spawn() is async: if the
// component unmounts (or `cwd` changes) BEFORE it resolves, `cleanupRef`
// is still null when the effect's cleanup runs, so the late-arriving PTY
// was never killed — orphaning its Rust-side child process plus reader and
// exit-watchdog OS threads forever. Observed live as ~100 threads/min and
// ~500 handles/min growth on an otherwise idle app (a canvas/list remounting
// TerminalView faster than a real PTY spawn round-trips). Fix: a `cancelled`
// flag captured by the effect's closure, checked in the `.then()` before
// attaching the PTY, killing it immediately if the effect already tore down.

describe('TerminalView — async spawn/unmount race does not leak the PTY', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));
  });

  it('kills a PTY that resolves AFTER the component has already unmounted', async () => {
    let resolveSpawn!: (pty: unknown) => void;
    const ptyKillMock = vi.fn();
    spawnMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const { unmount } = render(<TerminalView cwd="C:\Users\user\Documents\proj" />);

    // Unmount BEFORE the spawn promise ever resolves — simulates a fast
    // remount/unmount cycle racing the real (slower) PTY creation.
    unmount();

    // The spawn now resolves late, after teardown already ran.
    resolveSpawn({
      pid: 0,
      write: vi.fn(),
      resize: vi.fn(),
      kill: ptyKillMock,
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyKillMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT kill the PTY when the component is still mounted when spawn resolves', async () => {
    let resolveSpawn!: (pty: unknown) => void;
    const ptyKillMock = vi.fn();
    spawnMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    render(<TerminalView cwd="C:\Users\user\Documents\proj" />);

    resolveSpawn({
      pid: 0,
      write: vi.fn(),
      resize: vi.fn(),
      kill: ptyKillMock,
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyKillMock).not.toHaveBeenCalled();
  });
});

// ── UX pass 2026-08-15: "empty black band" — no visible indication a shell
// was even starting between tab-open and PTY-attach. Fix: an `isSpawning`
// overlay rendered on top of the (otherwise indistinguishable) black xterm
// container until the spawn settles, either way (attach or failure — the
// failure path already writes its own message directly into the pane).

describe('TerminalView — "starting" overlay while the PTY spawn is in flight', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }));
  });

  it('shows the starting hint while spawn is pending, and hides it once the PTY attaches', async () => {
    let resolveSpawn!: (pty: unknown) => void;
    spawnMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const { queryByText } = render(<TerminalView cwd="C:\Users\user\Documents\proj" />);

    expect(queryByText('terminal.starting')).not.toBeNull();

    resolveSpawn({
      pid: 0,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
    });

    await waitFor(() => expect(queryByText('terminal.starting')).toBeNull());
  });

  it('also hides the starting hint when the spawn fails (the failure message renders in the pane itself)', async () => {
    spawnMock.mockRejectedValueOnce('boom');

    const { queryByText } = render(<TerminalView cwd="C:\Users\user\Documents\proj" />);

    await waitFor(() => expect(queryByText('terminal.starting')).toBeNull());
  });
});
