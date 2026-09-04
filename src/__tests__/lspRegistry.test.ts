/**
 * lspRegistry.test.ts
 *
 * Tests the server-id registry logic extracted from the nativeLsp implementation:
 * - available() passes language to the Rust command
 * - start() caches the returned server_id per (repoPath, language)
 * - request() / notify() resolve the cached server_id and pass it to Rust
 * - a second start() reuses the cached id without calling lsp_start again
 *
 * All Rust invoke() calls are mocked — no Tauri runtime required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Server key helper (mirrors the private one in tauri.ts) ───────

function serverKey(repoPath: string, language: string): string {
  return `${language}::${repoPath}`;
}

// ── Minimal registry implementation (extracted logic to test) ─────
// Mirrors resolveServerId + the four methods of nativeLsp in tauri.ts.

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function buildLspClient(invokeFn: InvokeFn) {
  const registry = new Map<string, string>();

  async function resolveServerId(repoPath: string, language: string): Promise<string | null> {
    const key = serverKey(repoPath, language);
    const cached = registry.get(key);
    if (cached !== undefined) return cached;

    try {
      const serverId = await invokeFn('lsp_start', { repoPath, language }) as string;
      if (!serverId || serverId === 'unavailable') return null;
      registry.set(key, serverId);
      return serverId;
    } catch {
      return null;
    }
  }

  return {
    registry,
    async available(language: string): Promise<boolean> {
      try {
        return await invokeFn('lsp_available', { language }) as boolean;
      } catch {
        return false;
      }
    },
    async start(repoPath: string, language: string): Promise<boolean> {
      const id = await resolveServerId(repoPath, language);
      return id !== null;
    },
    async request(repoPath: string, language: string, method: string, params: unknown): Promise<unknown> {
      const serverId = await resolveServerId(repoPath, language);
      if (!serverId) throw new Error(`LSP server unavailable for language '${language}'`);
      const paramsJson = JSON.stringify(params);
      const resultJson = await invokeFn('lsp_request', { serverId, method, paramsJson }) as string;
      return JSON.parse(resultJson) as unknown;
    },
    async notify(repoPath: string, language: string, method: string, params: unknown): Promise<void> {
      const serverId = await resolveServerId(repoPath, language);
      if (!serverId) return;
      const paramsJson = JSON.stringify(params);
      await invokeFn('lsp_notify', { serverId, method, paramsJson });
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('LSP server-id registry', () => {
  const REPO = '/workspace/project';
  const LANG = 'typescript';
  const SERVER_ID = 'typescript-workspaceproject';

  let invoke: ReturnType<typeof vi.fn>;
  let lsp: ReturnType<typeof buildLspClient>;

  beforeEach(() => {
    invoke = vi.fn();
    lsp = buildLspClient(invoke as InvokeFn);
  });

  it('available() passes language to lsp_available', async () => {
    invoke.mockResolvedValueOnce(true);
    const result = await lsp.available(LANG);
    expect(result).toBe(true);
    expect(invoke).toHaveBeenCalledWith('lsp_available', { language: LANG });
  });

  it('available() returns false when invoke rejects', async () => {
    invoke.mockRejectedValueOnce(new Error('command not found'));
    const result = await lsp.available(LANG);
    expect(result).toBe(false);
  });

  it('start() calls lsp_start with repoPath + language and caches the id', async () => {
    invoke.mockResolvedValueOnce(SERVER_ID);
    const ok = await lsp.start(REPO, LANG);
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('lsp_start', { repoPath: REPO, language: LANG });
    expect(lsp.registry.get(serverKey(REPO, LANG))).toBe(SERVER_ID);
  });

  it('start() returns false when Rust returns "unavailable"', async () => {
    invoke.mockResolvedValueOnce('unavailable');
    const ok = await lsp.start(REPO, LANG);
    expect(ok).toBe(false);
    expect(lsp.registry.has(serverKey(REPO, LANG))).toBe(false);
  });

  it('start() reuses cached id — lsp_start not called twice', async () => {
    invoke.mockResolvedValueOnce(SERVER_ID);
    await lsp.start(REPO, LANG);
    await lsp.start(REPO, LANG);
    // lsp_start must have been called exactly once
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('request() passes cached serverId + paramsJson to lsp_request', async () => {
    invoke
      .mockResolvedValueOnce(SERVER_ID)            // lsp_start
      .mockResolvedValueOnce(JSON.stringify({ hover: 'ok' })); // lsp_request

    const result = await lsp.request(REPO, LANG, 'textDocument/hover', { position: { line: 0, character: 5 } });
    expect(result).toEqual({ hover: 'ok' });
    expect(invoke).toHaveBeenCalledWith('lsp_request', {
      serverId: SERVER_ID,
      method: 'textDocument/hover',
      paramsJson: JSON.stringify({ position: { line: 0, character: 5 } }),
    });
  });

  it('request() throws when server is unavailable', async () => {
    invoke.mockResolvedValueOnce('unavailable'); // lsp_start returns unavailable
    await expect(lsp.request(REPO, LANG, 'textDocument/hover', {})).rejects.toThrow(
      "LSP server unavailable for language 'typescript'",
    );
  });

  it('notify() passes cached serverId + paramsJson to lsp_notify', async () => {
    invoke
      .mockResolvedValueOnce(SERVER_ID)  // lsp_start
      .mockResolvedValueOnce(undefined); // lsp_notify

    await lsp.notify(REPO, LANG, 'textDocument/didOpen', { text: 'hello' });
    expect(invoke).toHaveBeenCalledWith('lsp_notify', {
      serverId: SERVER_ID,
      method: 'textDocument/didOpen',
      paramsJson: JSON.stringify({ text: 'hello' }),
    });
  });

  it('notify() silently degrades when server is unavailable', async () => {
    invoke.mockResolvedValueOnce('unavailable'); // lsp_start
    // Should resolve without throwing
    await expect(lsp.notify(REPO, LANG, 'textDocument/didOpen', {})).resolves.toBeUndefined();
    // lsp_notify must NOT have been called
    expect(invoke).not.toHaveBeenCalledWith('lsp_notify', expect.anything());
  });

  it('different (repoPath, language) pairs get separate server ids', async () => {
    const OTHER_REPO = '/other/repo';
    const OTHER_ID = 'typescript-otherrepo';

    invoke
      .mockResolvedValueOnce(SERVER_ID)  // first  lsp_start
      .mockResolvedValueOnce(OTHER_ID);  // second lsp_start

    await lsp.start(REPO, LANG);
    await lsp.start(OTHER_REPO, LANG);

    expect(lsp.registry.get(serverKey(REPO, LANG))).toBe(SERVER_ID);
    expect(lsp.registry.get(serverKey(OTHER_REPO, LANG))).toBe(OTHER_ID);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
