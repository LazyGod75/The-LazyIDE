import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emit, on } from '../lib/bus';
import {
  requestUserIntervention,
  detectHumanGate,
} from '../lib/bots/botRequestIntervention';

vi.mock('../lib/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/bus')>();
  return { ...actual, emit: vi.fn(actual.emit) };
});

describe('detectHumanGate', () => {
  it('detects a login wall from title or URL', () => {
    expect(detectHumanGate('Sign in to GitHub', 'https://github.com/login')).toBe('login');
    expect(detectHumanGate('Welcome', 'https://accounts.google.com/signin')).toBe('login');
  });

  it('detects 2FA / OTP screens', () => {
    expect(detectHumanGate('Two-factor authentication', 'https://example.com/2fa')).toBe('2fa');
    expect(detectHumanGate('Enter your verification code', 'https://example.com/verify')).toBe('2fa');
  });

  it('detects captcha / bot-check pages', () => {
    expect(detectHumanGate('Just a moment...', 'https://example.com/', 'recaptcha')).toBe('captcha');
    expect(detectHumanGate('Are you a robot?', 'https://example.com/cdn-cgi/challenge')).toBe('captcha');
  });

  it('returns null for ordinary pages', () => {
    expect(detectHumanGate('Example Domain', 'https://example.com/')).toBeNull();
  });
});

describe('requestUserIntervention', () => {
  beforeEach(() => {
    vi.mocked(emit).mockClear();
  });

  it('emits bot:intervention with botId, reason, and detail', () => {
    const seen: unknown[] = [];
    const off = on('bot:intervention', (p) => { seen.push(p); });
    requestUserIntervention('bot_1', 'login', 'https://example.com/login');
    off();
    expect(vi.mocked(emit)).toHaveBeenCalledWith(
      'bot:intervention',
      expect.objectContaining({ botId: 'bot_1', reason: 'login', detail: 'https://example.com/login' }),
    );
    expect(seen).toHaveLength(1);
  });

  it('never throws', () => {
    expect(() => requestUserIntervention('bot_x', 'captcha')).not.toThrow();
  });
});
