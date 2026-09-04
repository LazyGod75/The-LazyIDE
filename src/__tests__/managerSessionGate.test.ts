/**
 * managerSessionGate.test.ts — unsigned free GLM must not hit the ai-proxy.
 */
import { describe, it, expect } from 'vitest';
import {
  managerTurnNeedsSession,
  formatManagerUserError,
} from '../lib/agents/managerSessionGate';

describe('managerTurnNeedsSession', () => {
  it('web mock + GLM 5.2 free tier needs a session (measured 2026-08-28; free rail is the :free id since the 2026-09-02 catalog split)', () => {
    expect(managerTurnNeedsSession('z-ai/glm-5.2:free', 'mock')).toBe(true);
  });

  it('web mock + native Claude id does not use the proxy', () => {
    expect(managerTurnNeedsSession('claude-sonnet-5', 'mock')).toBe(false);
  });

  it('web mock + paid OpenRouter id does not use this gate (not offered unsigned)', () => {
    expect(managerTurnNeedsSession('openai/gpt-5.6-luna', 'mock')).toBe(false);
    // The bare z-ai/glm-5.2 id became a PAID catalog entry in the
    // 2026-09-02 split — the free rail is the :free variant above.
    expect(managerTurnNeedsSession('z-ai/glm-5.2', 'mock')).toBe(false);
  });

  it('desktop managed/cli modes are not this gate (other rails)', () => {
    expect(managerTurnNeedsSession('z-ai/glm-5.2', 'managed')).toBe(false);
    expect(managerTurnNeedsSession('z-ai/glm-5.2', 'claude-code')).toBe(false);
  });
});

describe('formatManagerUserError', () => {
  it('unwraps nested LazyManager / ManagedUnavailableError prefixes', () => {
    const inner = new Error('Session requise pour le mode géré (agent)');
    inner.name = 'ManagedUnavailableError';
    const wrapped = new Error(`LazyManager error: ${String(inner)}`, { cause: inner });
    expect(formatManagerUserError(wrapped)).toBe('Session requise pour le mode géré (agent)');
  });

  it('does not leave Error: Error: LazyManager error in the user-facing string', () => {
    const thrown = new Error('LazyManager error: Error: model missing');
    expect(formatManagerUserError(thrown)).toBe('model missing');
    expect(formatManagerUserError(thrown)).not.toMatch(/LazyManager error/i);
  });

  it('unwraps the persisted Tauri bubble (measured 2026-08-28)', () => {
    const persisted =
      "Error: Error: LazyManager error: Error: There's an issue with the selected model (deepseek-chat).";
    expect(formatManagerUserError(persisted)).toBe(
      "There's an issue with the selected model (deepseek-chat).",
    );
  });

  it('strips the French i18n Error wrapper too', () => {
    expect(formatManagerUserError('Erreur : LazyManager error: Session requise')).toBe(
      'Session requise',
    );
  });
});
