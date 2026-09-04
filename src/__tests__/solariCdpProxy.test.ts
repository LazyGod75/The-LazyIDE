import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('solariCdpProxyBase (C72)', () => {
  const originalDev = import.meta.env.DEV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // restore DEV flag if we mutated it via define — tests use mocks instead
    void originalDev;
  });

  it('uses Vite same-origin /solari-cdp in DEV', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } });
    const { solariCdpProxyBase, SOLARI_PROD_CORS_NOTE } = await import('../lib/solari/solariClient');
    // In vitest, import.meta.env.DEV is typically true
    if (import.meta.env.DEV) {
      expect(solariCdpProxyBase()).toBe('http://localhost:5173/solari-cdp');
    }
    expect(SOLARI_PROD_CORS_NOTE).toMatch(/Rust proxy|solari_cdp_proxy/i);
  });

  it('hydrateSolariCdpProxy caches the Tauri Rust proxy base for packaged builds', async () => {
    const invoke = vi.fn().mockResolvedValue('ws://127.0.0.1:34567');
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const mod = await import('../lib/solari/solariClient');
    mod.resetSolariCdpProxyCache();
    await mod.hydrateSolariCdpProxy({ force: true, isDev: false });
    expect(invoke).toHaveBeenCalledWith('solari_cdp_proxy_base');
    expect(mod.solariCdpProxyBase({ isDev: false })).toBe('ws://127.0.0.1:34567');
  });
});
