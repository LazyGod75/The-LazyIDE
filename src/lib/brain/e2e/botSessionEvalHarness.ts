/* Bot session eval protocol (login / 2FA / takeover / multi-tab / resume).

   F110 — without SOLARI_API_KEY, drive CdpSessionFacade + MockCdpTransport
   (ultra-fidèle CDP mock: real page-view emit, auth-wall HTML detection,
   multi-tab via pickDistinctPageTarget). With Solari key + LIVE=1, the eval
   test probes live (see botSessionEval.eval.test.ts).

   Does not import botEngine.
*/

import { CdpSessionFacade, MockCdpTransport } from '../../solari/cdpFacade.js';

export type BotSessionEvalStage =
  | 'idle'
  | 'navigating'
  | 'login_form'
  | 'awaiting_2fa'
  | 'authenticated'
  | 'takeover'
  | 'interrupted';

export type BotSessionEvalEvent =
  | { type: 'bot.navigate' }
  | { type: 'bot.login_form' }
  | { type: 'bot.credentials_submitted' }
  | { type: 'bot.2fa_challenge' }
  | { type: 'bot.2fa_code' }
  | { type: 'bot.authenticated' }
  | { type: 'bot.takeover_start' }
  | { type: 'bot.takeover_return' }
  | { type: 'bot.tab_opened' }
  | { type: 'bot.tab_switched' }
  | { type: 'bot.session_interrupted' }
  | { type: 'bot.resume'; hasSessionCookie?: boolean }
  | { type: 'bot.scrape' };

export function reduceBotSessionEval(
  stage: BotSessionEvalStage,
  event: BotSessionEvalEvent,
): BotSessionEvalStage {
  switch (event.type) {
    case 'bot.navigate':
      return stage === 'idle' ? 'navigating' : stage;
    case 'bot.login_form':
      return stage === 'navigating' || stage === 'interrupted' ? 'login_form' : stage;
    case 'bot.credentials_submitted':
      return stage === 'login_form' ? 'login_form' : stage;
    case 'bot.2fa_challenge':
      return stage === 'login_form' ? 'awaiting_2fa' : stage;
    case 'bot.2fa_code':
      return stage === 'awaiting_2fa' ? 'awaiting_2fa' : stage;
    case 'bot.authenticated':
      return stage === 'login_form' || stage === 'awaiting_2fa' ? 'authenticated' : stage;
    case 'bot.takeover_start':
      return stage === 'authenticated' ? 'takeover' : stage;
    case 'bot.takeover_return':
      return stage === 'takeover' ? 'authenticated' : stage;
    case 'bot.tab_opened':
    case 'bot.tab_switched':
      return stage === 'authenticated' ? 'authenticated' : stage;
    case 'bot.session_interrupted':
      return stage === 'authenticated' || stage === 'takeover' ? 'interrupted' : stage;
    case 'bot.resume':
      if (stage !== 'interrupted') return stage;
      return event.hasSessionCookie ? 'authenticated' : 'login_form';
    case 'bot.scrape':
      return stage;
    default:
      return stage;
  }
}

export function runBotSessionEvalPipeline(
  events: BotSessionEvalEvent[],
): BotSessionEvalStage {
  return events.reduce<BotSessionEvalStage>(
    (stage, event) => reduceBotSessionEval(stage, event),
    'idle',
  );
}

/** F110 — drive the CDP façade through a login→2FA→takeover path (mock). */
export async function runCdpFidelityLogin2faTakeover(): Promise<{
  stages: BotSessionEvalStage[];
  authWalls: Array<'none' | 'login' | '2fa'>;
  pageUrls: string[];
  tabCount: number;
}> {
  const transport = new MockCdpTransport();
  const facade = new CdpSessionFacade(transport, 'eval-sess');
  const stages: BotSessionEvalStage[] = [];
  const authWalls: Array<'none' | 'login' | '2fa'> = [];
  const pageUrls: string[] = [];

  let stage: BotSessionEvalStage = 'idle';
  const step = (event: BotSessionEvalEvent) => {
    stage = reduceBotSessionEval(stage, event);
    stages.push(stage);
  };

  step({ type: 'bot.navigate' });
  await facade.navigate('t1', 'https://accounts.example/login', 'Sign in');
  pageUrls.push(facade.activePage!.url);
  const loginHtml = '<form><input type="password" name="password"/><button>Sign in</button></form>';
  facade.setHtml('t1', loginHtml, 'Sign in');
  authWalls.push(facade.detectAuthWall(loginHtml));
  step({ type: 'bot.login_form' });
  step({ type: 'bot.credentials_submitted' });

  const twoFaHtml = '<p>Enter your two-factor authentication code</p><input name="otp"/>';
  facade.setHtml('t1', twoFaHtml, '2FA');
  authWalls.push(facade.detectAuthWall(twoFaHtml));
  step({ type: 'bot.2fa_challenge' });
  step({ type: 'bot.2fa_code' });
  step({ type: 'bot.authenticated' });

  await facade.navigate('t1', 'https://app.example/home', 'Home');
  pageUrls.push(facade.activePage!.url);
  authWalls.push(facade.detectAuthWall('<h1>Dashboard</h1>'));

  step({ type: 'bot.takeover_start' });
  step({ type: 'bot.takeover_return' });
  await facade.openDistinctTab('t1', 't2');
  step({ type: 'bot.tab_opened' });
  step({ type: 'bot.tab_switched' });

  const tabCount = facade.listPages().length;
  facade.close();
  return { stages, authWalls, pageUrls, tabCount };
}

/** Env presence only — never returns key material (F110 live gate). */
export function detectSolariLiveEnv(): { hasSolariKey: boolean; liveFlag: boolean } {
  const keyNames = ['SOLARI_API_KEY', 'LAZY_SOLARI_KEY', 'VITE_SOLARI_API_KEY'];
  const hasSolariKey = keyNames.some((n) => {
    const v = process.env[n];
    return typeof v === 'string' && v.trim().length > 0;
  });
  const live = process.env.LIVE === '1' || process.env.LIVE === 'true';
  return { hasSolariKey, liveFlag: live };
}

/**
 * F110 live — authenticated Solari REST probe (GET /profiles).
 * Returns HTTP status only; never logs the key or response body.
 */
export async function probeSolariLiveAuth(): Promise<{
  status: 'ok' | 'skip' | 'fail';
  httpStatus?: number;
  detail: string;
}> {
  const key = (
    process.env.SOLARI_API_KEY ||
    process.env.LAZY_SOLARI_KEY ||
    process.env.VITE_SOLARI_API_KEY ||
    ''
  ).trim();
  if (!key) return { status: 'skip', detail: 'SOLARI_API_KEY absent' };
  try {
    const res = await fetch('https://api.getsolari.com/profiles', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
    });
    if (res.ok) return { status: 'ok', httpStatus: res.status, detail: `HTTP ${res.status}` };
    return { status: 'fail', httpStatus: res.status, detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
