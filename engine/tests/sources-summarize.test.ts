import { describe, expect, it } from 'vitest';
import { summarizeMessages } from '../src/sources/summarize.js';

describe('summarizeMessages', () => {
  it('prioritizes decisions, then errors, then facts', () => {
    const text = summarizeMessages([
      { role: 'user', text: 'We decided to use parameterized queries everywhere in payments.' },
      {
        role: 'assistant',
        text: 'The error was caused by a missing idempotency key in the handler.',
      },
      { role: 'user', text: 'You should always check the event id before processing anything.' },
      {
        role: 'assistant',
        text: 'Here is a long general explanation about the payments architecture and flows.',
      },
    ]);
    const iDecision = text.indexOf('parameterized queries');
    const iError = text.indexOf('idempotency key');
    expect(iDecision).toBeGreaterThanOrEqual(0);
    expect(iError).toBeGreaterThan(iDecision);
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  it('drops short and meta texts', () => {
    const text = summarizeMessages([
      { role: 'user', text: 'ok' },
      { role: 'assistant', text: '--- PROGRESS UPDATE ---' },
    ]);
    expect(text).toBe('');
  });

  it('skips assistant JSON/code/status openers', () => {
    const text = summarizeMessages([
      {
        role: 'assistant',
        text: '{"raw": "json blob that is long enough to pass the length filter"}',
      },
      {
        role: 'assistant',
        text: 'Running the tests now to check the build output for failures...',
      },
    ]);
    expect(text).toBe('');
  });
});
