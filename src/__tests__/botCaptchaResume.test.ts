import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  advanceCaptchaResume,
  getCaptchaResumeState,
  markCaptchaWaiting,
  resetCaptchaResume,
  waitForCaptchaClear,
} from '../lib/bots/botCaptchaResume';

beforeEach(() => resetCaptchaResume());

describe('botCaptchaResume loop (C59)', () => {
  it('waits on captcha pages and resumes when the page clears', () => {
    expect(advanceCaptchaResume('bot_1', 'Just a moment...', 'https://example.com/', 'recaptcha')).toBe('waiting_human');
    expect(getCaptchaResumeState('bot_1')).toBe('waiting_human');
    expect(advanceCaptchaResume('bot_1', 'Example Domain', 'https://example.com/')).toBe('solved');
  });

  it('waitForCaptchaClear polls until solved or timeout', async () => {
    markCaptchaWaiting('bot_1', 'https://x/captcha');
    let n = 0;
    const probe = vi.fn(() => {
      n += 1;
      return n >= 3
        ? { title: 'Home', url: 'https://x/', extra: '' }
        : { title: 'Just a moment...', url: 'https://x/', extra: 'captcha' };
    });
    const state = await waitForCaptchaClear('bot_1', {
      probe,
      intervalMs: 5,
      timeoutMs: 500,
    });
    expect(state).toBe('solved');
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(getCaptchaResumeState('bot_1')).toBe('solved');
  });

  it('waitForCaptchaClear returns waiting_human on timeout', async () => {
    markCaptchaWaiting('bot_1', 'https://x/captcha');
    const state = await waitForCaptchaClear('bot_1', {
      probe: () => ({ title: 'Just a moment...', url: 'https://x/', extra: 'captcha' }),
      intervalMs: 5,
      timeoutMs: 20,
    });
    expect(state).toBe('waiting_human');
  });
});
