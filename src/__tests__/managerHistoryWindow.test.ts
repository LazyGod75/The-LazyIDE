/**
 * managerHistoryWindow.test.ts — token-efficiency wave (2026-08-01):
 * bounds the LazyManager conversation history sent to the LLM every turn.
 * See managerHistoryWindow.ts's module doc comment for the full rationale
 * (char-budget sliding window + pinned first message, deliberately NOT an
 * LLM-generated summary).
 */

import { describe, it, expect } from 'vitest';
import { boundManagerHistory, MANAGER_HISTORY_CHAR_BUDGET } from '../lib/agents/managerHistoryWindow';
import type { ManagerMessage } from '../lib/agents/types';

function msg(id: string, role: ManagerMessage['role'], content: string): ManagerMessage {
  return { id, role, content, timestamp: new Date(2026, 0, 1, 0, Number(id.replace(/\D/g, '')) || 0).toISOString() };
}

describe('boundManagerHistory', () => {
  it('returns everything unchanged when total size fits the budget (the common case)', () => {
    const messages = [
      msg('m1', 'user', 'salut'),
      msg('m2', 'assistant', 'bonjour, comment puis-je aider ?'),
      msg('m3', 'user', 'lance une mission de test'),
    ];
    const result = boundManagerHistory(messages);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('returns an empty result for an empty conversation', () => {
    expect(boundManagerHistory([])).toEqual({ messages: [], droppedCount: 0 });
  });

  it('keeps a contiguous suffix of the most recent messages under a tight budget', () => {
    const messages = [
      msg('m1', 'user', 'a'.repeat(1000)),
      msg('m2', 'assistant', 'b'.repeat(1000)),
      msg('m3', 'user', 'c'.repeat(1000)),
      msg('m4', 'assistant', 'd'.repeat(1000)),
      msg('m5', 'user', 'e'.repeat(1000)),
    ];
    // Budget for ~2 messages' worth.
    const result = boundManagerHistory(messages, 2100);
    expect(result.droppedCount).toBeGreaterThan(0);
    // The most recent message (m5, the current turn's own question) is
    // always present.
    expect(result.messages.some((m) => m.id === 'm5')).toBe(true);
    // The pinned first message (m1, the standing goal) is always present
    // once anything was dropped.
    expect(result.messages.some((m) => m.id === 'm1')).toBe(true);
    // A marker explaining the omission is present.
    expect(result.messages.some((m) => m.content.includes('HISTORY WINDOW'))).toBe(true);
  });

  it('never drops the current turn\'s own last message, even if it alone exceeds the budget', () => {
    const messages = [
      msg('m1', 'user', 'goal'),
      msg('m2', 'user', 'x'.repeat(100_000)),
    ];
    const result = boundManagerHistory(messages, 10);
    expect(result.messages.some((m) => m.id === 'm2')).toBe(true);
    expect(result.messages[result.messages.length - 1].id).toBe('m2');
  });

  it('truncates (never drops) an oversized pinned first message', () => {
    const hugeFirst = msg('m1', 'user', 'y'.repeat(50_000));
    const messages = [
      hugeFirst,
      msg('m2', 'assistant', 'ok'),
      msg('m3', 'user', 'z'.repeat(1000)),
    ];
    const result = boundManagerHistory(messages, 1100);
    const pinned = result.messages.find((m) => m.id === 'm1');
    expect(pinned).toBeDefined();
    expect(pinned!.content.length).toBeLessThan(hugeFirst.content.length);
    expect(pinned!.content).toContain('truncated');
  });

  it('marker/pinned messages use role "user" — never "system", which the ai-proxy ChatMessage type does not accept mid-conversation', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(2000)));
    const result = boundManagerHistory(messages, 5000);
    expect(result.droppedCount).toBeGreaterThan(0);
    for (const m of result.messages) {
      expect(m.role === 'user' || m.role === 'assistant').toBe(true);
    }
  });

  it('never loses reachability of the standing goal: the pinned message content always contains a real fragment of the original first message', () => {
    const messages = [
      msg('m1', 'user', 'Construis-moi un carrousel Instagram pour le lancement produit, ton fun, jamais de majuscules dans les titres.'),
      ...Array.from({ length: 20 }, (_, i) => msg(`m${i + 2}`, i % 2 === 0 ? 'assistant' : 'user', 'x'.repeat(3000))),
    ];
    const result = boundManagerHistory(messages, 10_000);
    expect(result.droppedCount).toBeGreaterThan(0);
    const pinned = result.messages.find((m) => m.id === 'm1');
    expect(pinned?.content).toContain('jamais de majuscules');
  });

  it('MANAGER_HISTORY_CHAR_BUDGET is a positive, sane default', () => {
    expect(MANAGER_HISTORY_CHAR_BUDGET).toBeGreaterThan(0);
  });

  it('does not mutate the input array (immutability convention)', () => {
    const messages = [msg('m1', 'user', 'x'.repeat(2000)), msg('m2', 'user', 'y'.repeat(2000))];
    const snapshot = JSON.parse(JSON.stringify(messages));
    boundManagerHistory(messages, 1500);
    expect(messages).toEqual(snapshot);
  });
});
