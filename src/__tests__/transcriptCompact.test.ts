import { describe, it, expect } from 'vitest';
import {
  compactTranscript,
  compactTranscriptWithMeta,
  excerptTurn,
  pruneStaleObservations,
  transcriptCharCount,
  COMPACT_KEEP_RECENT,
} from '../lib/agents/transcriptCompact';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'user') {
  return { id, role, content, timestamp: '2026-08-28T00:00:00Z' };
}

describe('compactTranscript', () => {
  it('leaves a short transcript unchanged', () => {
    const input = [msg('1', 'hello'), msg('2', 'world', 'assistant')];
    expect(compactTranscript(input, { triggerChars: 10_000 })).toEqual(input);
  });

  it('folds older turns into real excerpts, keeping the recent tail', () => {
    const input = Array.from({ length: COMPACT_KEEP_RECENT + 4 }, (_, i) =>
      msg(`m${i}`, `turn-${i}-` + 'x'.repeat(2000)),
    );
    const out = compactTranscript(input, { triggerChars: 100, excerptChars: 20 });
    expect(out).toHaveLength(COMPACT_KEEP_RECENT + 1);
    expect(out[0].content).toContain('verbatim excerpts');
    expect(out[0].content).toContain('turn-0-');
    expect(out[0].content).not.toMatch(/invented|placeholder|lorem/i);
    expect(out[out.length - 1].id).toBe(input[input.length - 1].id);
    expect(out[out.length - 1].content).toBe(input[input.length - 1].content);
  });

  it('never increases the character count of a long transcript', () => {
    const input = Array.from({ length: 20 }, (_, i) =>
      msg(`m${i}`, 'y'.repeat(3000)),
    );
    const out = compactTranscript(input, { triggerChars: 1000 });
    expect(transcriptCharCount(out)).toBeLessThan(transcriptCharCount(input));
  });

  it('keeps head and tail of long turns (B32 — no LLM required)', () => {
    const body = `START-${'a'.repeat(200)}-MID-${'b'.repeat(200)}-END`;
    const out = excerptTurn(body, 80);
    expect(out).toContain('START-');
    expect(out).toContain('END');
    expect(out).toContain('…');
    expect(out.length).toBeLessThanOrEqual(85);
  });

  it('force folds even when under the character budget', () => {
    const input = Array.from({ length: COMPACT_KEEP_RECENT + 3 }, (_, i) =>
      msg(`m${i}`, `short-${i}`),
    );
    expect(compactTranscript(input)).toEqual(input);
    const forced = compactTranscript(input, { force: true, excerptChars: 80 });
    expect(forced).toHaveLength(COMPACT_KEEP_RECENT + 1);
    expect(forced[0].content).toContain('short-0');
  });

  it('reports folded turn count and char delta when compact actually runs', () => {
    const input = Array.from({ length: COMPACT_KEEP_RECENT + 4 }, (_, i) =>
      msg(`m${i}`, `turn-${i}-` + 'x'.repeat(2000)),
    );
    const { messages, meta } = compactTranscriptWithMeta(input, { triggerChars: 100, excerptChars: 20 });
    expect(meta.foldedTurns).toBe(4);
    expect(meta.charsAfter).toBeLessThan(meta.charsBefore);
    expect(messages).toHaveLength(COMPACT_KEEP_RECENT + 1);
  });

  it('uses a token budget (~4 chars/token) instead of a raw character cap', () => {
    const input = Array.from({ length: COMPACT_KEEP_RECENT + 4 }, (_, i) =>
      msg(`m${i}`, 't'.repeat(400)),
    );
    const under = compactTranscriptWithMeta(input, { triggerTokens: 10_000 });
    expect(under.meta.foldedTurns).toBe(0);
    const over = compactTranscriptWithMeta(input, { triggerTokens: 50, excerptChars: 20 });
    expect(over.meta.foldedTurns).toBe(4);
  });

  it('folds through an optional summariser of real turns (nothing invented)', () => {
    const input = Array.from({ length: COMPACT_KEEP_RECENT + 3 }, (_, i) =>
      msg(`m${i}`, `real-turn-${i}`),
    );
    const { messages } = compactTranscriptWithMeta(input, {
      force: true,
      summarize: (folded) => folded.map((m) => m.content).join(' | '),
    });
    expect(messages[0].content).toContain('real-turn-0');
    expect(messages[0].content).toContain('real-turn-1');
    expect(messages[0].content).not.toMatch(/invented|placeholder/i);
  });
});

describe('pruneStaleObservations', () => {
  it('keeps the last observations full and clips older ones to real prefixes', () => {
    const input = [
      { role: 'assistant', content: 'plan' },
      { role: 'user', content: 'Observation: ' + 'AAAA'.repeat(100) },
      { role: 'assistant', content: 'next' },
      { role: 'user', content: 'Observation: ' + 'BBBB'.repeat(100) },
      { role: 'user', content: 'Observation: ' + 'CCCC'.repeat(100) },
      { role: 'user', content: 'Observation: ' + 'DDDD'.repeat(100) },
    ];
    const out = pruneStaleObservations(input, { keepRecent: 2, excerptChars: 16 });
    expect(out[1].content.startsWith('Observation: AAAA')).toBe(true);
    expect(out[1].content.length).toBeLessThan(input[1].content.length);
    expect(out[4].content).toBe(input[4].content);
    expect(out[5].content).toBe(input[5].content);
  });
});

