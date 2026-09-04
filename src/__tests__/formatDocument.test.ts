import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isPrettierConfigured, runPrettierWrite } from '../lib/editor/formatDocument';
import type { TerminalProcess } from '../lib/platform/types';

// B23: "Formater le document" must never fake a success — isPrettierConfigured
// is the honest local gate (package.json only, no network), runPrettierWrite
// is the real spawn + exit-code classification.

describe('isPrettierConfigured', () => {
  it('returns true when prettier is a devDependency', async () => {
    const fs = { readFile: vi.fn().mockResolvedValue(JSON.stringify({ devDependencies: { prettier: '^3.0.0' } })) };
    await expect(isPrettierConfigured({ fs } as never, '/repo')).resolves.toBe(true);
  });

  it('returns true when prettier is a dependency', async () => {
    const fs = { readFile: vi.fn().mockResolvedValue(JSON.stringify({ dependencies: { prettier: '^3.0.0' } })) };
    await expect(isPrettierConfigured({ fs } as never, '/repo')).resolves.toBe(true);
  });

  it('returns false when package.json has neither', async () => {
    const fs = { readFile: vi.fn().mockResolvedValue(JSON.stringify({ dependencies: { react: '^18.0.0' } })) };
    await expect(isPrettierConfigured({ fs } as never, '/repo')).resolves.toBe(false);
  });

  it('returns false (never throws) when package.json is missing', async () => {
    const fs = { readFile: vi.fn().mockRejectedValue(new Error('ENOENT')) };
    await expect(isPrettierConfigured({ fs } as never, '/repo')).resolves.toBe(false);
  });

  it('returns false (never throws) when package.json is malformed JSON', async () => {
    const fs = { readFile: vi.fn().mockResolvedValue('{not valid json') };
    await expect(isPrettierConfigured({ fs } as never, '/repo')).resolves.toBe(false);
  });
});

function makeFakeProcess(): { proc: TerminalProcess; fireExit: (code: number) => void; fireData: (d: string) => void } {
  let exitCb: ((code: number) => void) | null = null;
  const dataCbs = new Set<(d: string) => void>();
  const proc: TerminalProcess = {
    pid: 123,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => { dataCbs.add(cb); return () => dataCbs.delete(cb); },
    onExit: (cb) => { exitCb = cb; return () => { exitCb = null; }; },
  };
  return {
    proc,
    fireExit: (code) => exitCb?.(code),
    fireData: (d) => dataCbs.forEach(cb => cb(d)),
  };
}

describe('runPrettierWrite', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves ok:true on a clean exit (code 0)', async () => {
    const { proc, fireExit } = makeFakeProcess();
    const spawn = vi.fn().mockResolvedValue(proc);
    const p = runPrettierWrite({ terminal: { spawn } } as never, '/repo', '/repo/src/a.ts', false);
    // spawn() resolves on a microtask — flush it (fake timers active in this
    // describe block) so proc.onExit's listener is actually attached before
    // firing the exit, otherwise fireExit fires into nothing and the call
    // hangs until FORMAT_TIMEOUT_MS.
    await vi.advanceTimersByTimeAsync(0);
    fireExit(0);
    await expect(p).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith('npx', ['--no-install', 'prettier', '--write', '/repo/src/a.ts'], { cwd: '/repo' });
  });

  it('routes through `cmd /c` on Windows (the .cmd-shim spawn footgun)', async () => {
    const { proc, fireExit } = makeFakeProcess();
    const spawn = vi.fn().mockResolvedValue(proc);
    const p = runPrettierWrite({ terminal: { spawn } } as never, '/repo', '/repo/src/a.ts', true);
    await vi.advanceTimersByTimeAsync(0);
    fireExit(0);
    await expect(p).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith('cmd', ['/c', 'npx', '--no-install', 'prettier', '--write', '/repo/src/a.ts'], { cwd: '/repo' });
  });

  it('resolves ok:false with the captured output on a non-zero exit', async () => {
    const { proc, fireExit, fireData } = makeFakeProcess();
    const spawn = vi.fn().mockResolvedValue(proc);
    const p = runPrettierWrite({ terminal: { spawn } } as never, '/repo', '/repo/src/a.ts', false);
    await vi.advanceTimersByTimeAsync(0);
    fireData('[error] src/a.ts: SyntaxError: Unexpected token');
    fireExit(1);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/SyntaxError/);
  });

  it('resolves ok:false when spawn itself rejects (binary genuinely unreachable)', async () => {
    const spawn = vi.fn().mockRejectedValue(new Error('spawn ENOENT'));
    const result = await runPrettierWrite({ terminal: { spawn } } as never, '/repo', '/repo/src/a.ts', false);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/ENOENT/);
  });

  it('resolves ok:false and kills the process on timeout (never hangs the UI forever)', async () => {
    const { proc } = makeFakeProcess(); // onExit never fires
    const spawn = vi.fn().mockResolvedValue(proc);
    const p = runPrettierWrite({ terminal: { spawn } } as never, '/repo', '/repo/src/a.ts', false);
    await vi.advanceTimersByTimeAsync(15_001);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/timed out/);
    expect(proc.kill).toHaveBeenCalled();
  });
});
