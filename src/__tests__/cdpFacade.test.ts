/**
 * C73 — CDP façade unit tests (no live Solari / no WebSocket).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CdpSessionFacade, MockCdpTransport } from '../lib/solari/cdpFacade';
import { onCdpPageView } from '../lib/solari/cdpBrowser';

describe('CdpSessionFacade (C73)', () => {
  let transport: MockCdpTransport;
  let facade: CdpSessionFacade;

  beforeEach(() => {
    transport = new MockCdpTransport();
    facade = new CdpSessionFacade(transport, 'sess-test');
  });

  it('navigates and emits a page-view for takeover listeners', () => {
    const views: Array<{ url: string; title: string }> = [];
    const off = onCdpPageView((v) => views.push({ url: v.url, title: v.title }));
    return facade.navigate('t1', 'https://example.com/login', 'Sign in').then((view) => {
      expect(view.url).toBe('https://example.com/login');
      expect(views).toEqual([{ url: 'https://example.com/login', title: 'Sign in' }]);
      expect(facade.activePage?.targetId).toBe('t1');
      off();
    });
  });

  it('detects login and 2FA walls from HTML (F110 mock fidelity)', () => {
    expect(facade.detectAuthWall('<form><input type="password" name="password"></form>')).toBe('login');
    expect(facade.detectAuthWall('<p>Enter your verification code (2FA)</p>')).toBe('2fa');
    expect(facade.detectAuthWall('<h1>Example Domain</h1>')).toBe('none');
  });

  it('opens a distinct tab via pickDistinctPageTarget', async () => {
    await facade.navigate('t1', 'https://a.example');
    const id = await facade.openDistinctTab('t1', 't2');
    expect(id).toBe('t2');
    expect(facade.listPages().map((p) => p.targetId).sort()).toEqual(['t1', 't2']);
  });

  it('builds full-page screenshot params without touching the socket', () => {
    expect(facade.screenshotParams(true)).toEqual({
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
    });
  });

  it('records transport calls for Target.createTarget via mock', async () => {
    await transport.send('Target.createTarget', { url: 'about:blank' });
    expect(transport.calls.some((c) => c.method === 'Target.createTarget')).toBe(true);
  });
});
