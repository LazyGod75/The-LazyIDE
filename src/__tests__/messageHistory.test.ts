import { describe, it, expect } from 'vitest';
import { capMessageHistory, MAX_SENT_MESSAGES } from '../lib/models/messageHistory';

function makeMessages(n: number): Array<{ role: string; content: string }> {
  return Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` }));
}

describe('capMessageHistory', () => {
  it('returns all messages unchanged when already within budget', () => {
    const messages = makeMessages(10);
    expect(capMessageHistory(messages, 40)).toEqual(messages);
  });

  it('keeps the first message plus the most recent (max - 1) when over budget', () => {
    const messages = makeMessages(50);
    const capped = capMessageHistory(messages, 40);
    expect(capped).toHaveLength(40);
    expect(capped[0]).toEqual(messages[0]);
    expect(capped.slice(1)).toEqual(messages.slice(-39));
  });

  it('defaults to MAX_SENT_MESSAGES when no max is given', () => {
    const messages = makeMessages(MAX_SENT_MESSAGES + 5);
    expect(capMessageHistory(messages)).toHaveLength(MAX_SENT_MESSAGES);
  });

  it('never duplicates the first message when trimming', () => {
    const messages = makeMessages(41);
    const capped = capMessageHistory(messages, 40);
    const contents = capped.map(m => m.content);
    expect(new Set(contents).size).toBe(contents.length);
  });

  it('does not mutate the input array', () => {
    const messages = makeMessages(45);
    const copy = [...messages];
    capMessageHistory(messages, 40);
    expect(messages).toEqual(copy);
  });

  it('handles a single-message budget without crashing', () => {
    const messages = makeMessages(5);
    expect(capMessageHistory(messages, 1)).toEqual([messages[0]]);
  });
});
