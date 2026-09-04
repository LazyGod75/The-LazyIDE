/**
 * devPreview.test.ts — P46+P48 dev-server orchestration. Covers the pure
 * port/script detection heuristic (no I/O) and the stateful orchestrator
 * (reuse-if-running, spawn-via-PTY, concurrent-call dedup, idle-stop) via
 * fully injected {@link DevPreviewDeps} — never a real Tauri runtime, same
 * "pure/testable independent of real fetch/timers" convention
 * previewBackoff.test.ts/previewProbe.test.ts already follow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectDevServerConfig,
  resolveDevServerPort,
  devServerCommand,
  resolveWebDeliverableRoot,
  contentFingerprintMatches,
  ensureDevServerForProject,
  noteProjectMissionActivity,
  stopDevServer,
  isDevServerManaged,
  getDevServerLogs,
  getConfiguredPort,
  setConfiguredPort,
  getIdleTimeoutMs,
  setIdleTimeoutMs,
  DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS,
  getDevServerSkipReason,
  getConfirmedDevServerPort,
  setConfirmedDevServerPort,
  _resetDevPreviewForTests,
  type DevPreviewDeps,
  type DevServerShellHandle,
} from '../lib/agents/devPreview';
import { emitEvent } from '../lib/journal/journal';
import { on } from '../lib/bus';

// devPreview.ts journals `spawn.deferred` via emitEvent (2026-07-22
// memory-pressure incident fix) — mocked the SAME way journalEmitters.test.ts
// mocks the journal client, so these tests assert WHAT gets emitted, never
// hitting a real Tauri invoke.
vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Pure heuristic: resolveDevServerPort / detectDevServerConfig ────────

describe('resolveDevServerPort', () => {
  it('resolves next → 3000 by default', () => {
    expect(resolveDevServerPort('next dev', { dependencies: { next: '14.0.0' } })).toBe(3000);
  });

  it('resolves vite → 5173 by default', () => {
    expect(resolveDevServerPort('vite', { dependencies: { vite: '5.0.0' } })).toBe(5173);
  });

  it('detects the framework from the script text even with no matching dependency', () => {
    expect(resolveDevServerPort('next dev', {})).toBe(3000);
  });

  it('an explicit --port flag always wins over the framework default', () => {
    expect(resolveDevServerPort('next dev --port 4000', { dependencies: { next: '14.0.0' } })).toBe(4000);
  });

  it('an explicit -p flag is recognized too', () => {
    expect(resolveDevServerPort('vite -p 4321', { dependencies: { vite: '5.0.0' } })).toBe(4321);
  });

  it('a --port=N form (equals sign) is recognized', () => {
    expect(resolveDevServerPort('next dev --port=4242', {})).toBe(4242);
  });

  it('a leading PORT= env prefix is recognized when there is no --port flag', () => {
    expect(resolveDevServerPort('PORT=4500 next dev', { dependencies: { next: '14.0.0' } })).toBe(4500);
  });

  it('an explicit flag wins over a PORT= env prefix if somehow both are present', () => {
    expect(resolveDevServerPort('PORT=4500 next dev --port 4600', {})).toBe(4600);
  });

  it('a per-project override wins over everything else', () => {
    expect(resolveDevServerPort('next dev --port 4600', { dependencies: { next: '14.0.0' } }, 9999)).toBe(9999);
  });

  it('returns null when no framework/flag/env signal exists at all', () => {
    expect(resolveDevServerPort('react-scripts start', {})).toBeNull();
  });
});

describe('detectDevServerConfig', () => {
  it('parses a real Next.js package.json (LazySite-internet shape) — no explicit port, defaults to 3000', () => {
    const raw = JSON.stringify({
      name: 'lazy-site',
      scripts: { dev: 'next dev', build: 'next build' },
      dependencies: { next: '16.2.9', react: '19.2.4' },
    });
    const config = detectDevServerConfig(raw);
    expect(config).toEqual({ script: 'next dev', port: 3000, packageManager: 'npm' });
  });

  it('returns null when scripts.dev is missing', () => {
    const raw = JSON.stringify({ scripts: { build: 'next build' } });
    expect(detectDevServerConfig(raw)).toBeNull();
  });

  it('returns null when scripts.dev is an empty/whitespace string', () => {
    expect(detectDevServerConfig(JSON.stringify({ scripts: { dev: '   ' } }))).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    expect(detectDevServerConfig('{ not json')).toBeNull();
  });

  it('returns null when no port heuristic resolves', () => {
    const raw = JSON.stringify({ scripts: { dev: 'my-custom-server' } });
    expect(detectDevServerConfig(raw)).toBeNull();
  });

  it('honors a portOverride even when a framework default would otherwise apply', () => {
    const raw = JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } });
    expect(detectDevServerConfig(raw, { portOverride: 8123 })?.port).toBe(8123);
  });
});

describe('devServerCommand', () => {
  it('npm → "npm run dev"', () => {
    expect(devServerCommand('npm')).toBe('npm run dev');
  });
  it('pnpm → "pnpm run dev"', () => {
    expect(devServerCommand('pnpm')).toBe('pnpm run dev');
  });
  it('yarn → "yarn dev" (not "yarn run dev")', () => {
    expect(devServerCommand('yarn')).toBe('yarn dev');
  });
});

// ── P46+P48 round 2: static web deliverable resolution ──────────────────

describe('resolveWebDeliverableRoot', () => {
  it('resolves an index.html one level under public/ of the MOST RECENT worktree', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('mission-b') && s.includes('public') && s.includes('game') && s.includes('index.html')) {
        return '<!doctype html>';
      }
      throw new Error('ENOENT');
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readDir.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('mission-b') && s.includes('public')) return [{ name: 'game', isDir: true }];
      throw new Error('ENOENT');
    });
    const { deps } = makeDeps({ readFile, readDir });

    // Branch-style worktree rels ("agent/mission-b") must be sanitized to
    // the on-disk directory form ("agent-mission-b") — same sanitize as
    // resolveDiscardWorktreePath (agentsStore.tsx).
    const root = await resolveWebDeliverableRoot('C:\\proj', ['agent/mission-a', 'agent/mission-b'], deps);
    expect(root).not.toBeNull();
    expect(String(root)).toContain('agent-mission-b');
    expect(String(root)).not.toContain('agent/mission-b');
    expect(String(root)).toContain('game');
  });

  it('prefers the worktree root itself over public/ when both could match', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('mission-a') && s.endsWith('index.html') && !s.includes('public')) return '<!doctype html>';
      throw new Error('ENOENT');
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const { deps } = makeDeps({ readFile, readDir });

    const root = await resolveWebDeliverableRoot('C:\\proj', ['agent/mission-a'], deps);
    expect(root).not.toBeNull();
    expect(String(root)).toContain('mission-a');
    expect(String(root)).not.toContain('public');
  });

  it('returns null when no worktree holds an index.html', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const { deps } = makeDeps({ readFile, readDir });

    const root = await resolveWebDeliverableRoot('C:\\proj', ['agent/mission-a'], deps);
    expect(root).toBeNull();
  });

  it('scans the project root itself when no worktrees are provided', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.endsWith('index.html') && !s.includes('public')) return '<!doctype html>';
      throw new Error('ENOENT');
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const { deps } = makeDeps({ readFile, readDir });

    const root = await resolveWebDeliverableRoot('C:\\proj', undefined, deps);
    expect(root).not.toBeNull();
    expect(String(root)).not.toContain('worktrees');
  });
});

// 2026-08-04 orphaned-static-server incident: pure fingerprint comparison
// used by ensureStaticDevServer before trusting an already-answering static
// port — tested directly, independent of any deps/I-O (same "pure/testable"
// convention as resolveDevServerPort above).
describe('contentFingerprintMatches', () => {
  it('matches identical content, and content that only differs by whitespace formatting (CRLF vs LF, indentation)', () => {
    expect(contentFingerprintMatches('<!doctype html><title>App</title>', '<!doctype html><title>App</title>')).toBe(true);

    const local = '<!doctype html>\r\n  <html>\r\n    <head><title>App</title></head>';
    const remote = '<!doctype html>\n<html>\n<head><title>App</title></head>';
    expect(contentFingerprintMatches(remote, local)).toBe(true);
  });

  it('does not match genuinely different content, and a null remote (fetch failed/timed out/CORS-blocked) never matches — fails closed', () => {
    expect(contentFingerprintMatches('<!doctype html><title>Unrelated Site</title>', '<!doctype html><title>My Game</title>')).toBe(false);
    expect(contentFingerprintMatches(null, '<!doctype html><title>My Game</title>')).toBe(false);
  });
});

describe('ensureDevServerForProject — static deliverable path', () => {
  it('serves a mission worktree plain-HTML deliverable with npx serve when worktrees are provided', async () => {
    // The worktree has public/game/index.html (the deliverable); the project
    // ALSO has a package.json with scripts.dev — the deliverable must win.
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('index.html')) return '<!doctype html>';
      return JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } });
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readDir.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('public')) return [{ name: 'game', isDir: true }];
      return [{ name: 'package-lock.json', isDir: false }];
    });
    const { deps, shell } = makeDeps({ readFile, readDir });

    const result = await ensureDevServerForProject('p1', 'C:\\proj', deps, ['agent/mission-a']);
    expect(result).toEqual({ url: 'http://localhost:8080', port: 8080, reused: false });
    expect(shell.write).toHaveBeenCalledWith(expect.stringContaining('npx --yes serve --cors -l 8080'));
  });

  it('reuses an already-answering static port instead of stacking a second server (matching content fingerprint)', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('index.html')) return '<!doctype html>';
      throw new Error('ENOENT');
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readDir.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('public')) return [{ name: 'game', isDir: true }];
      throw new Error('ENOENT');
    });
    const { deps, shell } = makeDeps({
      readFile,
      readDir,
      probeReachable: vi.fn().mockResolvedValue(true),
      // Same content as the local staticRoot/index.html above — this is
      // OUR OWN server (e.g. an agent's earlier `npx serve`), confirmed via
      // the 2026-08-04 content-fingerprint check, not just port reachability.
      fetchBodyStart: vi.fn().mockResolvedValue('<!doctype html>'),
    });

    const result = await ensureDevServerForProject('p1', 'C:\\proj', deps, ['agent/mission-a']);
    expect(result).toEqual({ url: 'http://localhost:8080', port: 8080, reused: true });
    expect(shell.write).not.toHaveBeenCalled();
    expect(deps.fetchBodyStart).toHaveBeenCalledWith(8080);
  });

  // 2026-08-04 orphaned-static-server incident: 8080 was blindly reused even
  // though it was actually serving a DIFFERENT project's site — the user's
  // preview showed the wrong project. These four tests cover the fix.
  it('does NOT reuse a reachable static port whose content fingerprint mismatches — keeps scanning to a later matching port', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('index.html')) return '<!doctype html><title>My Game</title>';
      throw new Error('ENOENT');
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readDir.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('public')) return [{ name: 'game', isDir: true }];
      throw new Error('ENOENT');
    });
    const fetchBodyStart = vi.fn().mockImplementation(async (port: number) =>
      port === 8080 ? '<!doctype html><title>Some Other Orphaned Site</title>' : '<!doctype html><title>My Game</title>',
    );
    const { deps, shell } = makeDeps({
      readFile,
      readDir,
      probeReachable: vi.fn().mockResolvedValue(true), // every port answers
      fetchBodyStart,
    });

    const result = await ensureDevServerForProject('p1', 'C:\\proj', deps, ['agent/mission-a']);

    expect(result).toEqual({ url: 'http://localhost:8000', port: 8000, reused: true });
    expect(shell.write).not.toHaveBeenCalled();
    expect(fetchBodyStart).toHaveBeenCalledWith(8080);
    expect(fetchBodyStart).toHaveBeenCalledWith(8000);
  });

  it('spawns on the first free port after skipping a reachable port with foreign (mismatched) content', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('index.html')) return '<!doctype html><title>My Game</title>';
      return JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } });
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readDir.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('public')) return [{ name: 'game', isDir: true }];
      return [{ name: 'package-lock.json', isDir: false }];
    });
    const probeReachable = vi.fn().mockImplementation(async (port: number) => port === 8080); // only 8080 answers
    const fetchBodyStart = vi.fn().mockResolvedValue('<!doctype html><title>Some Other Orphaned Site</title>');
    const { deps, shell } = makeDeps({ readFile, readDir, probeReachable, fetchBodyStart });

    const result = await ensureDevServerForProject('p1', 'C:\\proj', deps, ['agent/mission-a']);

    // 8080 answered but with foreign content, so the (no-longer-hardcoded)
    // spawn target is 8000 — the first genuinely free port in the list.
    expect(result).toEqual({ url: 'http://localhost:8000', port: 8000, reused: false });
    expect(shell.write).toHaveBeenCalledWith(expect.stringContaining('npx --yes serve --cors -l 8000'));
    expect(fetchBodyStart).toHaveBeenCalledWith(8080);
    expect(fetchBodyStart).not.toHaveBeenCalledWith(8000); // 8000 was free — never needed a fingerprint check
  });

  it('returns null with a ports_busy_foreign_content skip reason when every static port is occupied by foreign content', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('index.html')) return '<!doctype html><title>My Game</title>';
      throw new Error('ENOENT');
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readDir.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('public')) return [{ name: 'game', isDir: true }];
      throw new Error('ENOENT');
    });
    const { deps, shell } = makeDeps({
      readFile,
      readDir,
      probeReachable: vi.fn().mockResolvedValue(true), // every STATIC_SERVER_PORTS entry answers
      fetchBodyStart: vi.fn().mockResolvedValue('<!doctype html><title>Some Other Orphaned Site</title>'), // none match
    });

    const result = await ensureDevServerForProject('p1', 'C:\\proj', deps, ['agent/mission-a']);

    expect(result).toBeNull();
    expect(shell.write).not.toHaveBeenCalled();
    expect(getDevServerSkipReason('p1')).toBe('ports_busy_foreign_content');
  });

  it('still falls back to scripts.dev when no worktree deliverable exists', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('index.html')) throw new Error('ENOENT');
      return JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } });
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readDir.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.includes('public')) return [{ name: 'logo.svg', isDir: false }];
      return [{ name: 'package-lock.json', isDir: false }];
    });
    const { deps, shell } = makeDeps({ readFile, readDir });

    const result = await ensureDevServerForProject('p1', 'C:\\proj', deps, ['agent/mission-a']);
    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, reused: false });
    expect(shell.write).toHaveBeenCalledWith('npm run dev\r\n');
  });

  it('serves a plain static project root (no package.json) statically', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.endsWith('index.html')) return '<!doctype html>';
      throw new Error('ENOENT');
    });
    const readDir = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const { deps, shell } = makeDeps({ readFile, readDir });

    const result = await ensureDevServerForProject('p1', 'C:\\proj', deps);
    expect(result).toEqual({ url: 'http://localhost:8080', port: 8080, reused: false });
    expect(shell.write).toHaveBeenCalledWith(expect.stringContaining('npx --yes serve --cors -l 8080'));
  });
});

// ── Stateful orchestrator: ensureDevServerForProject / idle-stop ───────

function makeShellHandle(): DevServerShellHandle & { write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  const dataCallbacks: Array<(chunk: string) => void> = [];
  return {
    write: vi.fn(),
    kill: vi.fn(),
    onData: (cb: (chunk: string) => void) => {
      dataCallbacks.push(cb);
      return () => {
        const idx = dataCallbacks.indexOf(cb);
        if (idx !== -1) dataCallbacks.splice(idx, 1);
      };
    },
  };
}

function makeDeps(overrides: Partial<DevPreviewDeps> = {}): { deps: DevPreviewDeps; shell: ReturnType<typeof makeShellHandle> } {
  const shell = makeShellHandle();
  const now = 1_000_000;
  const deps: DevPreviewDeps = {
    readFile: vi.fn().mockResolvedValue(
      JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } }),
    ),
    readDir: vi.fn().mockResolvedValue([{ name: 'package-lock.json', isDir: false }]),
    probeReachable: vi.fn().mockResolvedValue(false),
    // Defaults to "unconfirmed" (null) — same fail-closed posture as the
    // real defaultFetchBodyStart on any failure. Tests exercising the
    // static-port content-fingerprint check override this explicitly.
    fetchBodyStart: vi.fn().mockResolvedValue(null),
    spawnShell: vi.fn().mockResolvedValue(shell),
    now: () => now,
    getPressureLevel: () => 'normal',
    ...overrides,
  };
  return { deps, shell };
}

beforeEach(() => {
  _resetDevPreviewForTests();
  localStorage.clear();
  vi.mocked(emitEvent).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ensureDevServerForProject', () => {
  // 2026-08-07 wrong-project-preview incident fix — "anything reachable is
  // ours" reuse used to be unconditional; a genuinely first-ever-seen
  // reachable port with no ownership record is now DECLINED rather than
  // trusted (see doEnsureDevServerForProject's own doc comment for the real
  // incident: a stale, unrelated project's Next.js dev server got silently
  // attributed to a different project's preview). The full suite of
  // ownership-check tests lives further down
  // ("ensureDevServerForProject — port ownership").
  it('does NOT reuse a reachable port with no ownership record — declines rather than risking the wrong project', async () => {
    const { deps, shell } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toBeNull();
    expect(deps.spawnShell).not.toHaveBeenCalled();
    expect(shell.write).not.toHaveBeenCalled();
    expect(isDevServerManaged('p1')).toBe(false); // never tracked — nothing to ever kill
    expect(getDevServerSkipReason('p1')).toBe('port_unconfirmed');
  });

  it('reuses an already-reachable port verbatim once it is a CONFIRMED port for this project, never spawning a shell', async () => {
    setConfirmedDevServerPort('p1', 3000);
    const { deps, shell } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, reused: true });
    expect(deps.spawnShell).not.toHaveBeenCalled();
    expect(shell.write).not.toHaveBeenCalled();
    expect(isDevServerManaged('p1')).toBe(false); // never tracked — nothing to ever kill
    expect(getDevServerSkipReason('p1')).toBeUndefined();
  });

  it('reuses an already-reachable port once the project has an explicit user-configured port override, even with no prior confirmation', async () => {
    setConfiguredPort('p1', 3000);
    const { deps, shell } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, reused: true });
    expect(shell.write).not.toHaveBeenCalled();
    setConfiguredPort('p1', undefined);
  });

  it('a successful spawn records this project\'s confirmed port, so a LATER call (e.g. after an app restart) reuses it instead of declining', async () => {
    const { deps: spawnDeps } = makeDeps(); // probeReachable defaults false — forces a spawn
    const spawnResult = await ensureDevServerForProject('p1', 'C:\\proj\\p1', spawnDeps);
    expect(spawnResult).toEqual({ url: 'http://localhost:3000', port: 3000, reused: false });
    expect(getConfirmedDevServerPort('p1')).toBe(3000);

    // Simulate a fresh session: reset in-memory state (never localStorage —
    // the confirmation is meant to survive exactly this) and probe again,
    // this time finding it already reachable.
    _resetDevPreviewForTests();
    const { deps: reuseDeps, shell: reuseShell } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) });
    const reuseResult = await ensureDevServerForProject('p1', 'C:\\proj\\p1', reuseDeps);

    expect(reuseResult).toEqual({ url: 'http://localhost:3000', port: 3000, reused: true });
    expect(reuseShell.write).not.toHaveBeenCalled();
  });

  it('spawns the shell and types the resolved package-manager command when not reachable', async () => {
    const { deps, shell } = makeDeps();

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, reused: false });
    expect(deps.spawnShell).toHaveBeenCalledTimes(1);
    expect(shell.write).toHaveBeenCalledWith('npm run dev\r\n');
    expect(isDevServerManaged('p1')).toBe(true);
  });

  it('strips a Windows verbatim (\\\\?\\) prefix before reading package.json / spawning', async () => {
    const { deps } = makeDeps();

    await ensureDevServerForProject('p1', '\\\\?\\C:\\proj\\p1', deps);

    expect(deps.readFile).toHaveBeenCalledWith('C:\\proj\\p1\\package.json');
    expect(deps.spawnShell).toHaveBeenCalledWith('C:\\proj\\p1');
  });

  it('picks yarn when yarn.lock is present', async () => {
    const { deps, shell } = makeDeps({
      readDir: vi.fn().mockResolvedValue([{ name: 'yarn.lock', isDir: false }]),
    });

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(shell.write).toHaveBeenCalledWith('yarn dev\r\n');
  });

  it('picks pnpm when pnpm-lock.yaml is present', async () => {
    const { deps, shell } = makeDeps({
      readDir: vi.fn().mockResolvedValue([{ name: 'pnpm-lock.yaml', isDir: false }]),
    });

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(shell.write).toHaveBeenCalledWith('pnpm run dev\r\n');
  });

  it('defaults to npm when readDir fails or finds no known lockfile', async () => {
    const { deps, shell } = makeDeps({ readDir: vi.fn().mockRejectedValue(new Error('nope')) });

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(shell.write).toHaveBeenCalledWith('npm run dev\r\n');
  });

  it('returns null (and never probes/spawns) when the project has no package.json', async () => {
    const { deps } = makeDeps({ readFile: vi.fn().mockRejectedValue(new Error('ENOENT')) });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toBeNull();
    expect(deps.probeReachable).not.toHaveBeenCalled();
    expect(deps.spawnShell).not.toHaveBeenCalled();
  });

  it('returns null when package.json has no detectable dev script', async () => {
    const { deps } = makeDeps({ readFile: vi.fn().mockResolvedValue(JSON.stringify({ scripts: { build: 'tsc' } })) });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toBeNull();
  });

  it('degrades to null (never throws) when the PTY spawn itself fails', async () => {
    const { deps } = makeDeps({ spawnShell: vi.fn().mockRejectedValue(new Error('terminal_spawn failed')) });

    await expect(ensureDevServerForProject('p1', 'C:\\proj\\p1', deps)).resolves.toBeNull();
    expect(isDevServerManaged('p1')).toBe(false);
  });

  it('dedupes concurrent calls for the same project — spawns exactly once', async () => {
    let resolveReadFile!: (value: string) => void;
    const readFile = vi.fn().mockReturnValue(new Promise<string>((resolve) => { resolveReadFile = resolve; }));
    const { deps, shell } = makeDeps({ readFile });

    const first = ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    const second = ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    resolveReadFile(JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '14.0.0' } }));

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual(r2);
    expect(deps.spawnShell).toHaveBeenCalledTimes(1);
    expect(shell.write).toHaveBeenCalledTimes(1);
  });

  it('a later call reuses the already-managed handle instead of re-reading package.json', async () => {
    const { deps } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    (deps.readFile as ReturnType<typeof vi.fn>).mockClear();
    (deps.spawnShell as ReturnType<typeof vi.fn>).mockClear();

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, reused: false });
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.spawnShell).not.toHaveBeenCalled();
  });

  it('captures PTY output into getDevServerLogs, bounded, for the managed server', async () => {
    const { deps, shell } = makeDeps();
    let feed: ((chunk: string) => void) | undefined;
    (shell.onData as unknown as (cb: (chunk: string) => void) => () => void) = ((cb: (chunk: string) => void) => {
      feed = cb;
      return () => {};
    }) as never;

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    feed?.('> next dev\n');
    feed?.('ready on http://localhost:3000\n');

    expect(getDevServerLogs('p1')).toEqual(['> next dev\n', 'ready on http://localhost:3000\n']);
  });

  it('getDevServerLogs is empty for an unmanaged project', () => {
    expect(getDevServerLogs('nope')).toEqual([]);
  });
});

// ── 2026-08-07 wrong-project-preview incident ───────────────────────────
// Real repro: LazySite-internet (a Next.js project, default port 3000)
// probed 3000, found a STALE lazy-backoffice dev server still answering
// there from an earlier session, and — under the old "anything reachable is
// ours" rule — reused it verbatim. The canvas preview then rendered
// lazy-backoffice's own Next.js "Server Error" page (its absolute file paths
// fully visible) under a green "Live" badge, silently attributed to the
// WRONG project. These tests cover the ownership-confirmation fix in
// doEnsureDevServerForProject's `alreadyReachable` branch.

describe('ensureDevServerForProject — port ownership (2026-08-07 wrong-project-preview incident)', () => {
  it('reproduces the real incident: a port confirmed for a DIFFERENT project is never reused for this one', async () => {
    // lazy-backoffice was, at some point (this session or an earlier one),
    // confirmed to run on 3000 — exactly what a prior successful spawn for
    // THAT project would have recorded.
    setConfirmedDevServerPort('lazy-backoffice', 3000);

    const { deps, shell } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) });
    const result = await ensureDevServerForProject('lazy-site-internet', 'C:\\proj\\lazy-site', deps);

    expect(result).toBeNull();
    expect(shell.write).not.toHaveBeenCalled();
    expect(isDevServerManaged('lazy-site-internet')).toBe(false);
    expect(getDevServerSkipReason('lazy-site-internet')).toBe('port_unconfirmed');
  });

  it('emits devPreview:portUnconfirmed with ownedByOtherProject: true when the port is confirmed for a different project', async () => {
    setConfirmedDevServerPort('lazy-backoffice', 3000);
    const { deps } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) });
    const handler = vi.fn();
    const unsubscribe = on('devPreview:portUnconfirmed', handler);

    await ensureDevServerForProject('lazy-site-internet', 'C:\\proj\\lazy-site', deps);
    unsubscribe();

    expect(handler).toHaveBeenCalledWith({ projectId: 'lazy-site-internet', port: 3000, ownedByOtherProject: true });
  });

  it('emits devPreview:portUnconfirmed with ownedByOtherProject: false for a genuinely never-seen-before port', async () => {
    const { deps } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) });
    const handler = vi.fn();
    const unsubscribe = on('devPreview:portUnconfirmed', handler);

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    unsubscribe();

    expect(handler).toHaveBeenCalledWith({ projectId: 'p1', port: 3000, ownedByOtherProject: false });
  });

  it('does not re-emit devPreview:portUnconfirmed on a repeat decline (same tick-to-tick polling) — only on the transition', async () => {
    const { deps } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) });
    const handler = vi.fn();
    const unsubscribe = on('devPreview:portUnconfirmed', handler);

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    unsubscribe();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('re-emits devPreview:portUnconfirmed after the decline clears and reoccurs (a fresh transition)', async () => {
    let reachable = true;
    const { deps } = makeDeps({ probeReachable: vi.fn().mockImplementation(async () => reachable) });
    const handler = vi.fn();
    const unsubscribe = on('devPreview:portUnconfirmed', handler);

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps); // declines — 1st emission
    reachable = false;
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps); // spawns instead — clears the reason
    reachable = true;
    // A different, still-unconfirmed port answering again is a NEW decline
    // transition (not a repeat of the same one) — this project is now
    // managed (spawned above), so re-probe a fresh project id instead to
    // exercise the same transition edge in isolation.
    await ensureDevServerForProject('p2', 'C:\\proj\\p2', deps); // declines — 2nd emission (different project, fresh transition)
    unsubscribe();

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('getConfirmedDevServerPort is undefined until a spawn or explicit test-setup confirms one', () => {
    expect(getConfirmedDevServerPort('never-touched')).toBeUndefined();
  });

  it('two DIFFERENT projects can each have their own confirmed port with no cross-contamination', async () => {
    const spawnA = makeDeps(); // probeReachable defaults false — forces a spawn
    await ensureDevServerForProject('project-a', 'C:\\proj\\a', spawnA.deps);
    expect(getConfirmedDevServerPort('project-a')).toBe(3000);
    expect(getConfirmedDevServerPort('project-b')).toBeUndefined();

    // project-b resolves to a DIFFERENT port (its own package.json below
    // uses an explicit --port), and is unaffected by project-a's own
    // confirmation.
    const spawnB = makeDeps({
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify({ scripts: { dev: 'next dev --port 4000' }, dependencies: { next: '14.0.0' } }),
      ),
    });
    await ensureDevServerForProject('project-b', 'C:\\proj\\b', spawnB.deps);
    expect(getConfirmedDevServerPort('project-b')).toBe(4000);
    expect(getConfirmedDevServerPort('project-a')).toBe(3000); // untouched
  });
});

// ── FOUNDER NORTH STAR: pressure-gated spawning ────────────────────────

describe('ensureDevServerForProject — pressure gate', () => {
  it('does not spawn a NEW dev server while pressure is high', async () => {
    const { deps, shell } = makeDeps({ getPressureLevel: () => 'high' });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toBeNull();
    expect(deps.spawnShell).not.toHaveBeenCalled();
    expect(shell.write).not.toHaveBeenCalled();
    expect(isDevServerManaged('p1')).toBe(false);
    expect(getDevServerSkipReason('p1')).toBe('pressure_high');
  });

  it('still reuses an already-reachable CONFIRMED server even while pressure is high', async () => {
    setConfirmedDevServerPort('p1', 3000);
    const { deps, shell } = makeDeps({
      getPressureLevel: () => 'high',
      probeReachable: vi.fn().mockResolvedValue(true),
    });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, reused: true });
    expect(deps.spawnShell).not.toHaveBeenCalled();
    expect(shell.write).not.toHaveBeenCalled();
    expect(getDevServerSkipReason('p1')).toBeUndefined();
  });

  // 2026-07-22 memory-pressure incident: the preemptive gate for a fresh,
  // non-user-initiated auto-spawn (ensureDevServerForProject's ONLY caller
  // is useCanvasAutoComposition.ts's background port-probe) was widened to
  // also block at 'elevated', not just 'high' — see doEnsureDevServerForProject's
  // own doc comment for why. A user-initiated spawn (a manually opened
  // terminal, "Formater le document", ...) goes through
  // platform.terminal.spawn directly and is entirely untouched by this gate.
  it('does not spawn a NEW dev server while pressure is "elevated" (tightened gate)', async () => {
    const { deps, shell } = makeDeps({ getPressureLevel: () => 'elevated' });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toBeNull();
    expect(deps.spawnShell).not.toHaveBeenCalled();
    expect(shell.write).not.toHaveBeenCalled();
    expect(isDevServerManaged('p1')).toBe(false);
    expect(getDevServerSkipReason('p1')).toBe('pressure_elevated');
  });

  it('still reuses an already-reachable CONFIRMED server even while pressure is "elevated"', async () => {
    setConfirmedDevServerPort('p1', 3000);
    const { deps } = makeDeps({
      getPressureLevel: () => 'elevated',
      probeReachable: vi.fn().mockResolvedValue(true),
    });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, reused: true });
    expect(deps.spawnShell).not.toHaveBeenCalled();
    expect(getDevServerSkipReason('p1')).toBeUndefined();
  });

  it('spawns normally at "normal" pressure', async () => {
    const { deps, shell } = makeDeps({ getPressureLevel: () => 'normal' });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, reused: false });
    expect(deps.spawnShell).toHaveBeenCalledTimes(1);
    expect(shell.write).toHaveBeenCalledWith('npm run dev\r\n');
    expect(getDevServerSkipReason('p1')).toBeUndefined();
  });

  it('getDevServerSkipReason is undefined until a pressure-gated skip actually happens', () => {
    expect(getDevServerSkipReason('never-touched')).toBeUndefined();
  });

  it('clears a stale skip reason once pressure eases and a later call spawns successfully', async () => {
    let level: 'normal' | 'elevated' | 'high' = 'high';
    const { deps } = makeDeps({ getPressureLevel: () => level });

    const blocked = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    expect(blocked).toBeNull();
    expect(getDevServerSkipReason('p1')).toBe('pressure_high');

    level = 'normal';
    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, reused: false });
    expect(getDevServerSkipReason('p1')).toBeUndefined();
  });
});

// ── 2026-07-22 memory-pressure incident: insufficient-memory soft-path ────
// terminal.rs prefixes an OS "not enough memory to spawn" failure with a
// stable `INSUFFICIENT_MEMORY:` marker (see that file's own
// SPAWN_ERROR_INSUFFICIENT_MEMORY_PREFIX doc comment) — devPreview.ts
// matches on it to defer a single retry instead of degrading silently like
// every other spawn failure.

const INSUFFICIENT_MEMORY_ERROR = new Error(
  "INSUFFICIENT_MEMORY: spawn_command failed for 'powershell.exe': CreateProcessW failed: os error 8 (not enough memory)",
);

describe('ensureDevServerForProject — insufficient-memory soft-path', () => {
  it('never throws/degrades to a raw error — returns null and marks the skip reason', async () => {
    const { deps, shell } = makeDeps({ spawnShell: vi.fn().mockRejectedValue(INSUFFICIENT_MEMORY_ERROR) });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toBeNull();
    expect(shell.write).not.toHaveBeenCalled();
    expect(isDevServerManaged('p1')).toBe(false);
    expect(getDevServerSkipReason('p1')).toBe('spawn_deferred_memory');
  });

  it('journals a spawn.deferred event with the reason and retry delay', async () => {
    const { deps } = makeDeps({ spawnShell: vi.fn().mockRejectedValue(INSUFFICIENT_MEMORY_ERROR) });

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'spawn.deferred',
        projectId: 'p1',
        actor: 'system',
        payload: { reason: 'insufficient_memory', retryInMs: 60_000 },
      }),
    );
  });

  it('emits a bus notice so a real UI surface can show a SOFT in-app toast', async () => {
    const { deps } = makeDeps({ spawnShell: vi.fn().mockRejectedValue(INSUFFICIENT_MEMORY_ERROR) });
    const handler = vi.fn();
    const unsubscribe = on('devPreview:spawnDeferredMemory', handler);

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    unsubscribe();

    expect(handler).toHaveBeenCalledWith({ projectId: 'p1', retryInMs: 60_000 });
  });

  it('never re-attempts the spawn on a later tick while the single retry is still pending', async () => {
    const spawnShell = vi.fn().mockRejectedValue(INSUFFICIENT_MEMORY_ERROR);
    const { deps } = makeDeps({ spawnShell });

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    expect(spawnShell).toHaveBeenCalledTimes(1);

    // Simulates useCanvasAutoComposition.ts's ~4s port-probe tick calling
    // ensureDevServerForProject again well before the 60s retry fires.
    const second = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(second).toBeNull();
    expect(spawnShell).toHaveBeenCalledTimes(1); // never hammered a second time
    expect(getDevServerSkipReason('p1')).toBe('spawn_deferred_memory');
  });

  it('retries exactly once after 60s and succeeds once the spawn works', async () => {
    vi.useFakeTimers();
    const shell = makeShellHandle();
    const spawnShell = vi.fn().mockRejectedValueOnce(INSUFFICIENT_MEMORY_ERROR).mockResolvedValueOnce(shell);
    const { deps } = makeDeps({ spawnShell });

    const first = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    expect(first).toBeNull();
    expect(spawnShell).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawnShell).toHaveBeenCalledTimes(2);
    expect(shell.write).toHaveBeenCalledWith('npm run dev\r\n');
    expect(isDevServerManaged('p1')).toBe(true);
    expect(getDevServerSkipReason('p1')).toBeUndefined();
  });

  it('the scheduled retry allows "elevated" pressure — only "high" still blocks it', async () => {
    vi.useFakeTimers();
    const shell = makeShellHandle();
    const spawnShell = vi.fn().mockRejectedValueOnce(INSUFFICIENT_MEMORY_ERROR).mockResolvedValueOnce(shell);
    let level: 'normal' | 'elevated' | 'high' = 'normal';
    const { deps } = makeDeps({ spawnShell, getPressureLevel: () => level });

    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    level = 'elevated'; // still eased off 'high' by the time the retry fires

    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawnShell).toHaveBeenCalledTimes(2);
    expect(isDevServerManaged('p1')).toBe(true);
  });

  it('a generic (non-memory) spawn failure is NOT deferred — degrades exactly as before this fix', async () => {
    const spawnShell = vi.fn().mockRejectedValue(new Error('spawn_command failed: some other reason'));
    const { deps } = makeDeps({ spawnShell });

    const result = await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(result).toBeNull();
    expect(getDevServerSkipReason('p1')).toBeUndefined();
    expect(emitEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'spawn.deferred' }));

    // A later call (simulating the next tick) attempts the spawn again
    // immediately — no pendingMemoryRetry guard applies to a non-memory
    // failure.
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    expect(spawnShell).toHaveBeenCalledTimes(2);
  });
});

describe('noteProjectMissionActivity + idle-stop', () => {
  it('stops a managed dev server after the idle timeout once missions stop running', async () => {
    vi.useFakeTimers();
    const { deps, shell } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    noteProjectMissionActivity('p1', false, deps);
    expect(shell.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS - 1);
    expect(shell.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(shell.kill).toHaveBeenCalledTimes(1);
    expect(isDevServerManaged('p1')).toBe(false);
  });

  it('cancels the idle countdown once a mission is active again', async () => {
    vi.useFakeTimers();
    const { deps, shell } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    noteProjectMissionActivity('p1', false, deps);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS - 1);
    noteProjectMissionActivity('p1', true, deps); // work resumed just in time

    await vi.advanceTimersByTimeAsync(DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS);
    expect(shell.kill).not.toHaveBeenCalled();
    expect(isDevServerManaged('p1')).toBe(true);
  });

  it('respects a per-project idle timeout override', async () => {
    vi.useFakeTimers();
    setIdleTimeoutMs('p1', 5_000);
    const { deps, shell } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    noteProjectMissionActivity('p1', false, deps);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(shell.kill).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a project with no managed server (nothing to stop)', () => {
    expect(() => noteProjectMissionActivity('nope', false)).not.toThrow();
  });

  it('is a no-op for a project whose server was only ever reused (never ours to kill)', async () => {
    const { deps } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) });
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    vi.useFakeTimers();
    noteProjectMissionActivity('p1', false, deps);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS + 1_000);

    expect(isDevServerManaged('p1')).toBe(false); // was never tracked in the first place
  });
});

describe('stopDevServer', () => {
  it('kills and untracks a managed server explicitly', async () => {
    const { deps, shell } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    stopDevServer('p1');

    expect(shell.kill).toHaveBeenCalledTimes(1);
    expect(isDevServerManaged('p1')).toBe(false);
  });

  it('is a no-op for an unmanaged project', () => {
    expect(() => stopDevServer('nope')).not.toThrow();
  });

  // Preview lifecycle fix — the canvas preview surface for this project
  // must not go on polling a port this call just killed (see bus.ts's
  // 'devPreview:serverStopped' doc comment for the full wiring).
  it('emits devPreview:serverStopped with the project id and its exact url', async () => {
    const { deps } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    const handler = vi.fn();
    const unsubscribe = on('devPreview:serverStopped', handler);

    stopDevServer('p1');
    unsubscribe();

    expect(handler).toHaveBeenCalledWith({ projectId: 'p1', url: 'http://localhost:3000' });
  });

  it('never emits devPreview:serverStopped for a no-op stop (unmanaged project)', () => {
    const handler = vi.fn();
    const unsubscribe = on('devPreview:serverStopped', handler);

    stopDevServer('nope');
    unsubscribe();

    expect(handler).not.toHaveBeenCalled();
  });

  it('the idle-timeout path (noteProjectMissionActivity) emits devPreview:serverStopped too — same real stopDevServer call', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    const handler = vi.fn();
    const unsubscribe = on('devPreview:serverStopped', handler);

    noteProjectMissionActivity('p1', false, deps);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS);
    unsubscribe();

    expect(handler).toHaveBeenCalledWith({ projectId: 'p1', url: 'http://localhost:3000' });
  });
});

describe('per-project configuration (localStorage)', () => {
  it('getConfiguredPort is undefined until explicitly set', () => {
    expect(getConfiguredPort('p1')).toBeUndefined();
  });

  it('round-trips a configured port override', () => {
    setConfiguredPort('p1', 4567);
    expect(getConfiguredPort('p1')).toBe(4567);
    setConfiguredPort('p1', undefined);
    expect(getConfiguredPort('p1')).toBeUndefined();
  });

  it('getIdleTimeoutMs defaults to 30 minutes until overridden', () => {
    expect(getIdleTimeoutMs('p1')).toBe(DEFAULT_DEV_SERVER_IDLE_TIMEOUT_MS);
    setIdleTimeoutMs('p1', 60_000);
    expect(getIdleTimeoutMs('p1')).toBe(60_000);
  });

  it('a corrupted localStorage value degrades to the defaults rather than throwing', () => {
    localStorage.setItem('lazy.canvas.devPreviewPortOverrides', 'not json');
    expect(() => getConfiguredPort('p1')).not.toThrow();
    expect(getConfiguredPort('p1')).toBeUndefined();
  });
});

// ── Dev-only debug handle (window.__lazyDevPreview) ────────────────────
// Replaces the old qa.preview.diag journal spam (useCanvasAutoComposition.ts)
// — import.meta.env.DEV is true under Vitest (same convention
// previewLayoutWorkerClient.test.ts's sibling debug-log tests rely on), so
// the handle is always installed in this test environment.

interface LazyDevPreviewDebugHandleForTest {
  skipReason: (projectId: string) => string | undefined;
  managed: () => Array<{ projectId: string; port: number; url: string }>;
  lastEnsure: () => Array<{ tsMs: number; projectId: string; url: string | null; reused: boolean | null; skipReason: string | null }>;
}

function getDebugHandle(): LazyDevPreviewDebugHandleForTest {
  const handle = (window as unknown as { __lazyDevPreview?: LazyDevPreviewDebugHandleForTest }).__lazyDevPreview;
  expect(handle).toBeDefined();
  return handle!;
}

describe('window.__lazyDevPreview debug handle (dev-only)', () => {
  it('skipReason(projectId) mirrors getDevServerSkipReason', async () => {
    const { deps } = makeDeps({ getPressureLevel: () => 'high' });
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(getDebugHandle().skipReason('p1')).toBe('pressure_high');
    expect(getDebugHandle().skipReason('p1')).toBe(getDevServerSkipReason('p1'));
  });

  it('managed() lists every currently-managed server as {projectId, port, url}', async () => {
    const { deps } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    expect(getDebugHandle().managed()).toEqual([{ projectId: 'p1', port: 3000, url: 'http://localhost:3000' }]);
  });

  it('managed() is empty once the server is stopped', async () => {
    const { deps } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    stopDevServer('p1');

    expect(getDebugHandle().managed()).toEqual([]);
  });

  it('lastEnsure() records one ring-buffer entry per resolved ensureDevServerForProject call', async () => {
    const { deps } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    const log = getDebugHandle().lastEnsure();
    expect(log.at(-1)).toMatchObject({ projectId: 'p1', url: 'http://localhost:3000', reused: false, skipReason: null });
  });

  it('lastEnsure() records the skip reason for a declined call', async () => {
    const { deps } = makeDeps({ getPressureLevel: () => 'elevated' });
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);

    const log = getDebugHandle().lastEnsure();
    expect(log.at(-1)).toMatchObject({ projectId: 'p1', url: null, reused: null, skipReason: 'pressure_elevated' });
  });

  it('lastEnsure() is bounded to the last 20 entries', async () => {
    const { deps } = makeDeps({ probeReachable: vi.fn().mockResolvedValue(true) }); // reuse path — cheap, no shell spawn
    for (let i = 0; i < 25; i += 1) {
      await ensureDevServerForProject(`p${i}`, `C:\\proj\\p${i}`, deps);
    }

    const log = getDebugHandle().lastEnsure();
    expect(log.length).toBe(20);
    expect(log[0]).toMatchObject({ projectId: 'p5' }); // the 5 oldest entries were dropped
    expect(log.at(-1)).toMatchObject({ projectId: 'p24' });
  });

  it('lastEnsure() is cleared by the test-only reset', async () => {
    const { deps } = makeDeps();
    await ensureDevServerForProject('p1', 'C:\\proj\\p1', deps);
    expect(getDebugHandle().lastEnsure().length).toBeGreaterThan(0);

    _resetDevPreviewForTests();

    expect(getDebugHandle().lastEnsure()).toEqual([]);
  });
});
