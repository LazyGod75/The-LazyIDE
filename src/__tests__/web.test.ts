import { describe, it, expect } from 'vitest';
import { WebPlatform, getWebCaptures } from '../lib/platform/web';

describe('WebPlatform.fs', () => {
  const { fs } = WebPlatform;

  it('readDir is empty for a path nobody wrote this session', async () => {
    expect(await fs.readDir('/__never-written__')).toEqual([]);
  });

  it('readDir for unknown path returns empty array', async () => {
    const entries = await fs.readDir('/does-not-exist');
    expect(entries).toEqual([]);
  });

  it('readFile returns empty string for a path that was never written', async () => {
    const content = await fs.readFile('/project/src/auth.ts');
    expect(content).toBe('');
  });

  it('writeFile then readFile roundtrip', async () => {
    const path = '/project/src/test-write.ts';
    const text = 'export const hello = "world";';
    await fs.writeFile(path, text);
    const back = await fs.readFile(path);
    expect(back).toBe(text);
  });

  it('readDir lists only files written this session', async () => {
    await fs.writeFile('/session/a.ts', 'a');
    await fs.writeFile('/session/lib/b.ts', 'b');
    const entries = await fs.readDir('/session');
    expect(entries).toEqual([
      { name: 'lib', path: '/session/lib', isDir: true },
      { name: 'a.ts', path: '/session/a.ts', isDir: false },
    ]);
  });

  it('writeFile overwrites existing content', async () => {
    const path = '/project/src/overwrite-test.ts';
    await fs.writeFile(path, 'v1');
    await fs.writeFile(path, 'v2');
    const back = await fs.readFile(path);
    expect(back).toBe('v2');
  });
});

describe('WebPlatform.brain.capture', () => {
  it('stores captured events in the web capture store', async () => {
    const countBefore = getWebCaptures().length;
    await WebPlatform.brain.capture({
      kind: 'edit',
      title: 'Test capture',
      text: 'Some content',
      source: 'test',
    });
    expect(getWebCaptures().length).toBe(countBefore + 1);
  });

  it('capture result has id, path, sizeBytes, attrsCount', async () => {
    const result = await WebPlatform.brain.capture({
      kind: 'agent',
      title: 'Agent mission',
      text: 'Mission text',
    });
    expect(result.id).toBeTruthy();
    expect(typeof result.path).toBe('string');
    expect(typeof result.sizeBytes).toBe('number');
    expect(typeof result.attrsCount).toBe('number');
  });
});

describe('WebPlatform.terminal (browser stub)', () => {
  it('spawns a process with a numeric pid', async () => {
    const proc = await WebPlatform.terminal.spawn('bash', []);
    expect(typeof proc.pid).toBe('number');
    proc.kill();
  });

  it('emits an honest browser-only welcome after spawn', async () => {
    const received: string[] = [];
    const proc = await WebPlatform.terminal.spawn('bash', []);
    proc.onData(d => received.push(d));

    await new Promise(r => setTimeout(r, 150));
    const full = received.join('');
    expect(full).toContain('No project filesystem in the browser');
    expect(full).not.toContain('Mock Shell');
    proc.kill();
  });

  it('kill triggers onExit callback', async () => {
    const codes: number[] = [];
    const proc = await WebPlatform.terminal.spawn('bash', []);
    proc.onExit(code => codes.push(code));
    proc.kill();
    expect(codes).toContain(0);
  });

  it('onData unsubscribe stops receiving data', async () => {
    const received: string[] = [];
    const proc = await WebPlatform.terminal.spawn('bash', []);
    const unsub = proc.onData(d => received.push(d));
    unsub();
    // Give mock shell time to emit welcome (should not reach callback)
    await new Promise(r => setTimeout(r, 150));
    expect(received).toHaveLength(0);
    proc.kill();
  });
});

describe('WebPlatform.git', () => {
  it('status is empty — no fabricated branch or files', async () => {
    const status = await WebPlatform.git.status('/project');
    expect(status.branch).toBe('');
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.files).toEqual([]);
  });

  it('diff is empty — no fabricated patch', async () => {
    const diff = await WebPlatform.git.diff('/project');
    expect(diff).toBe('');
  });

  it('commit rejects instead of pretending to succeed', async () => {
    await expect(
      WebPlatform.git.commit('/project', 'test commit')
    ).rejects.toThrow(/not available in the browser/);
  });
});

describe('WebPlatform name', () => {
  it('is "web"', () => {
    expect(WebPlatform.name).toBe('web');
  });
});

describe('WebPlatform.brain.recallScoped — sessionId (Q3 differential-injection dedup)', () => {
  // The web mock has no engine/sidecar session to dedup against — sessionId
  // is accepted (so callers like assistantStore.tsx/brainSearchLoop.ts don't
  // need to branch on platform) but has no effect, same convention as the
  // already-ignored `_scope` param. See platform/types.ts's `recallScoped`
  // doc comment and platform/tauri.ts's real (Tauri) implementation.

  it('accepts an optional sessionId and resolves without throwing', async () => {
    const result = await WebPlatform.brain.recallScoped('test query', 'current', 'some-session-id');
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(typeof result.injectedContext).toBe('string');
  });

  it('resolves identically whether or not sessionId is passed (ignored, not a regression)', async () => {
    const withSession = await WebPlatform.brain.recallScoped('test query', 'current', 'some-session-id');
    const withoutSession = await WebPlatform.brain.recallScoped('test query', 'current');
    expect(withSession.nodes).toEqual(withoutSession.nodes);
    expect(withSession.injectedContext).toBe(withoutSession.injectedContext);
  });
});
