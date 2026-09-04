/**
 * decisions.test.ts — decision registry (spec §6, T3.2).
 *
 * Covers the two halves of the closed loop this task wires up:
 *   - lookupDecision/tryAutoAnswer: semantic match against 'current'-scoped
 *     brain recall, gated at the existing 0.75 similarity threshold.
 *   - createDecision: the previously-zero-callers capture path — now called
 *     from AttentionInbox.tsx's answer flow (see AttentionInbox.test.tsx for
 *     the end-to-end "answered question never re-asked" proof).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(),
}));

vi.mock('../lib/journal/journal', () => ({
  emitBuffered: vi.fn(),
}));

import { getPlatform } from '../lib/platform';
import { emitBuffered } from '../lib/journal/journal';
import { lookupDecision, createDecision, tryAutoAnswer } from '../lib/brain/decisions';
import type { JournalEventInput } from '../lib/journal/eventTypes';

const mockedGetPlatform = getPlatform as unknown as ReturnType<typeof vi.fn>;
const mockedEmitBuffered = emitBuffered as ReturnType<typeof vi.fn>;

function eventsOfType(type: string): JournalEventInput[] {
  return mockedEmitBuffered.mock.calls
    .map((call) => call[0] as JournalEventInput)
    .filter((e) => e.type === type);
}

beforeEach(() => {
  mockedGetPlatform.mockReset();
  mockedEmitBuffered.mockReset();
});

describe('lookupDecision', () => {
  it('returns found:false for a blank question without calling the brain', async () => {
    const recallScoped = vi.fn();
    mockedGetPlatform.mockReturnValue({ brain: { recallScoped } });

    const result = await lookupDecision('   ');
    expect(result).toEqual({ found: false });
    expect(recallScoped).not.toHaveBeenCalled();
  });

  it('returns found:false when the brain has no matching nodes', async () => {
    mockedGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn().mockResolvedValue({ nodes: [], injectedContext: '', tokensSaved: 0 }) },
    });

    const result = await lookupDecision('Should I use OAuth or sessions?');
    expect(result.found).toBe(false);
  });

  it('returns found:false when the best match scores below the 0.75 threshold', async () => {
    mockedGetPlatform.mockReturnValue({
      brain: {
        recallScoped: vi.fn().mockResolvedValue({
          nodes: [{ id: 'n1', snippet: 'unrelated', score: 0.4 }],
          injectedContext: '',
          tokensSaved: 0,
        }),
      },
    });

    const result = await lookupDecision('Should I use OAuth or sessions?');
    expect(result.found).toBe(false);
    expect(eventsOfType('brain.decision_hit')).toHaveLength(0);
  });

  it('returns found:true with the answer + decisionId and emits brain.decision_hit above the threshold', async () => {
    mockedGetPlatform.mockReturnValue({
      brain: {
        recallScoped: vi.fn().mockResolvedValue({
          nodes: [{ id: 'decision-42', snippet: 'Use OAuth with PKCE', score: 0.9 }],
          injectedContext: '',
          tokensSaved: 0,
        }),
      },
    });

    const result = await lookupDecision('Should I use OAuth or sessions?');
    expect(result).toEqual({ found: true, answer: 'Use OAuth with PKCE', decisionId: 'decision-42' });

    const hits = eventsOfType('brain.decision_hit');
    expect(hits).toHaveLength(1);
    expect(hits[0].payload).toEqual({ decisionId: 'decision-42', question: 'Should I use OAuth or sessions?' });
  });

  it('fails closed (found:false) when recallScoped throws', async () => {
    mockedGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn().mockRejectedValue(new Error('sidecar down')) },
    });

    const result = await lookupDecision('anything');
    expect(result).toEqual({ found: false });
  });
});

describe('tryAutoAnswer', () => {
  it('returns the answer string on a hit', async () => {
    mockedGetPlatform.mockReturnValue({
      brain: {
        recallScoped: vi.fn().mockResolvedValue({
          nodes: [{ id: 'd1', snippet: 'Answer text', score: 0.99 }],
          injectedContext: '',
          tokensSaved: 0,
        }),
      },
    });

    expect(await tryAutoAnswer('q')).toBe('Answer text');
  });

  it('returns null on a miss', async () => {
    mockedGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn().mockResolvedValue({ nodes: [], injectedContext: '', tokensSaved: 0 }) },
    });

    expect(await tryAutoAnswer('q')).toBeNull();
  });
});

describe('createDecision', () => {
  it('returns null and never calls capture when question or answer is blank', async () => {
    const capture = vi.fn();
    mockedGetPlatform.mockReturnValue({ brain: { capture } });

    expect(await createDecision({ question: '  ', answer: 'answer' })).toBeNull();
    expect(await createDecision({ question: 'question', answer: '  ' })).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it('captures a decision-kind neuron, defaults scope to project, and emits brain.decision_created', async () => {
    const capture = vi.fn().mockResolvedValue({ id: 'neuron-7' });
    mockedGetPlatform.mockReturnValue({ brain: { capture } });

    const id = await createDecision({ question: 'OAuth or sessions?', answer: 'OAuth with PKCE' });

    expect(id).toBe('neuron-7');
    expect(capture).toHaveBeenCalledTimes(1);
    const event = capture.mock.calls[0][0];
    expect(event.kind).toBe('decision');
    expect(event.text).toContain('Q: OAuth or sessions?');
    expect(event.text).toContain('A: OAuth with PKCE');
    expect(event.tags).toEqual(['decision', 'auto-registry', 'scope:project']);

    const created = eventsOfType('brain.decision_created');
    expect(created).toHaveLength(1);
    expect(created[0].payload).toEqual({ question: 'OAuth or sessions?', answer: 'OAuth with PKCE' });
  });

  it('tags an explicit org scope', async () => {
    const capture = vi.fn().mockResolvedValue({ id: 'neuron-8' });
    mockedGetPlatform.mockReturnValue({ brain: { capture } });

    await createDecision({ question: 'q', answer: 'a', scope: 'org' });

    expect(capture.mock.calls[0][0].tags).toEqual(['decision', 'auto-registry', 'scope:org']);
  });

  it('includes rationale in the captured text when provided', async () => {
    const capture = vi.fn().mockResolvedValue({ id: 'neuron-9' });
    mockedGetPlatform.mockReturnValue({ brain: { capture } });

    await createDecision({ question: 'q', answer: 'a', rationale: 'because it is safer' });

    expect(capture.mock.calls[0][0].text).toContain('Rationale: because it is safer');
  });

  it('fails closed (returns null) when capture throws', async () => {
    mockedGetPlatform.mockReturnValue({ brain: { capture: vi.fn().mockRejectedValue(new Error('offline')) } });

    expect(await createDecision({ question: 'q', answer: 'a' })).toBeNull();
  });
});
