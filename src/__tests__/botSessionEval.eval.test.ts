/**
 * Automated bot session eval (F110).
 * Default: CDP mock ultra-fidèle via CdpSessionFacade.
 * Live: only when LIVE=1 and a Solari key is present (never logged).
 */

import { describe, expect, it } from 'vitest';
import {
  detectSolariLiveEnv,
  probeSolariLiveAuth,
  reduceBotSessionEval,
  runBotSessionEvalPipeline,
  runCdpFidelityLogin2faTakeover,
} from '../lib/brain/e2e/botSessionEvalHarness';

describe('bot session eval harness (CDP stubs)', () => {
  it('login without 2FA reaches authenticated', () => {
    expect(runBotSessionEvalPipeline([
      { type: 'bot.navigate' },
      { type: 'bot.login_form' },
      { type: 'bot.credentials_submitted' },
      { type: 'bot.authenticated' },
    ])).toBe('authenticated');
  });

  it('blocks automation on a 2FA challenge until a code is supplied', () => {
    const waiting = runBotSessionEvalPipeline([
      { type: 'bot.navigate' },
      { type: 'bot.login_form' },
      { type: 'bot.credentials_submitted' },
      { type: 'bot.2fa_challenge' },
    ]);
    expect(waiting).toBe('awaiting_2fa');
    expect(reduceBotSessionEval(waiting, { type: 'bot.scrape' })).toBe('awaiting_2fa');
    expect(runBotSessionEvalPipeline([
      { type: 'bot.navigate' },
      { type: 'bot.login_form' },
      { type: 'bot.credentials_submitted' },
      { type: 'bot.2fa_challenge' },
      { type: 'bot.2fa_code' },
      { type: 'bot.authenticated' },
    ])).toBe('authenticated');
  });

  it('takeover pauses automation until return', () => {
    const taken = runBotSessionEvalPipeline([
      { type: 'bot.navigate' },
      { type: 'bot.login_form' },
      { type: 'bot.credentials_submitted' },
      { type: 'bot.authenticated' },
      { type: 'bot.takeover_start' },
    ]);
    expect(taken).toBe('takeover');
    expect(reduceBotSessionEval(taken, { type: 'bot.scrape' })).toBe('takeover');
    expect(reduceBotSessionEval(taken, { type: 'bot.takeover_return' })).toBe('authenticated');
  });

  it('multi-tab switch keeps the authenticated session', () => {
    expect(runBotSessionEvalPipeline([
      { type: 'bot.navigate' },
      { type: 'bot.login_form' },
      { type: 'bot.credentials_submitted' },
      { type: 'bot.authenticated' },
      { type: 'bot.tab_opened' },
      { type: 'bot.tab_switched' },
    ])).toBe('authenticated');
  });

  it('resume after interrupt restores the session when a cookie is present', () => {
    const interrupted = runBotSessionEvalPipeline([
      { type: 'bot.navigate' },
      { type: 'bot.login_form' },
      { type: 'bot.credentials_submitted' },
      { type: 'bot.authenticated' },
      { type: 'bot.session_interrupted' },
    ]);
    expect(interrupted).toBe('interrupted');
    expect(reduceBotSessionEval(interrupted, { type: 'bot.resume', hasSessionCookie: true })).toBe('authenticated');
    expect(reduceBotSessionEval(interrupted, { type: 'bot.resume', hasSessionCookie: false })).toBe('login_form');
  });
});

describe('bot session CDP fidelity mock (F110)', () => {
  it('login → 2FA → takeover → multi-tab via CdpSessionFacade', async () => {
    const result = await runCdpFidelityLogin2faTakeover();
    expect(result.authWalls).toEqual(['login', '2fa', 'none']);
    expect(result.pageUrls[0]).toContain('/login');
    expect(result.pageUrls.at(-1)).toContain('/home');
    expect(result.tabCount).toBe(2);
    expect(result.stages.at(-1)).toBe('authenticated');
  });

  it('documents Solari live gate without leaking secrets', () => {
    const env = detectSolariLiveEnv();
    expect(typeof env.hasSolariKey).toBe('boolean');
    expect(typeof env.liveFlag).toBe('boolean');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ bench: 'f110-solari-gate', env }));
  });
});

const LIVE = process.env.LIVE === '1';
const solari = detectSolariLiveEnv();

describe.skipIf(!LIVE || !solari.hasSolariKey)('bot session LIVE Solari (F110)', () => {
  it('Solari key present — live gate opens', () => {
    // Do not print key material.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ bench: 'f110-solari-live', gated: true }));
    expect(solari.hasSolariKey).toBe(true);
  });

  it('authenticated GET /profiles succeeds (live Solari REST)', async () => {
    const result = await probeSolariLiveAuth();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ bench: 'f110-solari-auth', result }));
    expect(result.status).toBe('ok');
    expect(result.httpStatus).toBe(200);
  }, 30_000);

  it('login → 2FA → takeover still green via CDP fidelity mock beside live auth', async () => {
    // Full cloud browser create (POST /sessions + CDP drive) burns pool
    // credits — kept as the ultra-fidèle MockCdpTransport path proven above.
    // Live auth is covered by GET /profiles; protocol fidelity by the mock.
    const result = await runCdpFidelityLogin2faTakeover();
    expect(result.authWalls).toEqual(['login', '2fa', 'none']);
    expect(result.stages.at(-1)).toBe('authenticated');
  });
});
