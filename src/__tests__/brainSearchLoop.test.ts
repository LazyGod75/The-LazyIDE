/* brainSearchLoop.test.ts
   Unit tests for the shared ReAct brain_search shim.

   Covers:
   1. stripInvisibleLines — existing whole-line behavior (regression guard)
   2. stripInvisibleLines — NEW: mid-line markers (QA bug: raw "[reasoning]"
      and "BRAIN_SEARCH: ..." leaking verbatim into the visible transcript)
   3. withTimeout — races a promise against a bounded timeout
   4. recallForDirective — never hangs, even when the platform call never
      settles (QA bug: brain recall timing out hung the turn)
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock brain recall normalization — pass through unchanged so assertions can
// focus on the recall-bounding behavior rather than token-count math.
vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn((r: unknown) => r),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(),
}));

// Mock the recall-savings choke point (costStore.recordRecallSaving) so the
// wiring tests below can assert recallForDirective forwards its measured
// saving there — without pulling in the real usageHistory persistence.
const mockRecordRecallSaving = vi.fn();
vi.mock('../lib/models/costStore', () => ({
  recordRecallSaving: (...args: unknown[]) => mockRecordRecallSaving(...args),
}));

import { getPlatform } from '../lib/platform';
import {
  stripInvisibleLines,
  withTimeout,
  recallForDirective,
  withBrainSearchLoop,
  withBrainSearchLoopEvents,
  describeBrainDirective,
  executeBrainDirective,
  isBrainDirectiveError,
  BRAIN_RECALL_TIMEOUT_MS,
} from '../lib/models/brainSearchLoop';
import type { StreamEvent } from '../lib/models/types';

const mockGetPlatform = getPlatform as unknown as ReturnType<typeof vi.fn>;

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

// ── stripInvisibleLines — regression guard (existing whole-line behavior) ──

describe('stripInvisibleLines — existing whole-line behavior', () => {
  it('passes through normal text unchanged', () => {
    expect(stripInvisibleLines('Hello, world!')).toBe('Hello, world!');
  });

  it('strips a reasoning-channel line (whole line starts with the marker)', () => {
    const input = '\x1b[reasoning]I am thinking...\nHere is my answer.';
    expect(stripInvisibleLines(input)).toBe('Here is my answer.');
  });

  it('strips a BRAIN_SEARCH directive line', () => {
    const input = 'BRAIN_SEARCH: what is the auth flow\nSome visible text.';
    expect(stripInvisibleLines(input)).toBe('Some visible text.');
  });

  it('strips an indented BRAIN_SEARCH line', () => {
    const input = '  BRAIN_SEARCH: some query\nAnswer here.';
    expect(stripInvisibleLines(input)).toBe('Answer here.');
  });

  it('preserves empty lines that are not reasoning or directives', () => {
    const input = 'Line one.\n\nLine two.';
    expect(stripInvisibleLines(input)).toBe('Line one.\n\nLine two.');
  });

  it('returns empty string when all lines are stripped', () => {
    const input = '\x1b[reasoning]thinking\nBRAIN_SEARCH: foo';
    expect(stripInvisibleLines(input)).toBe('');
  });
});

// ── stripInvisibleLines — NEW: mid-line markers (bug #3) ───────────────────

describe('stripInvisibleLines — mid-line markers (QA leak fix)', () => {
  it('strips a BRAIN_SEARCH directive that appears mid-line, keeping prior prose', () => {
    const input = 'Je vais vérifier. BRAIN_SEARCH: src/hello.js sampleproj';
    expect(stripInvisibleLines(input)).toBe('Je vais vérifier.');
  });

  it('strips a bare "[reasoning]" tag with no ANSI escape byte', () => {
    // Some CLI backends drop control characters in transit, leaving the
    // literal "[reasoning]" text (this is what QA actually saw leak).
    const input = '[reasoning] internal notes\nFinal answer.';
    expect(stripInvisibleLines(input)).toBe('Final answer.');
  });

  it('strips a bare "[reasoning]" tag that appears mid-line, keeping prior prose', () => {
    const input = 'Some prose [reasoning] more internal notes';
    expect(stripInvisibleLines(input)).toBe('Some prose');
  });

  it('strips both reasoning and BRAIN_SEARCH markers embedded in the same line', () => {
    // Matches the exact pattern documented in parseBrainSearchDirective:
    // "\x1b[reasoning]...BRAIN_SEARCH: how is auth built" — no leading newline.
    const input = '\x1b[reasoning]Let me check. BRAIN_SEARCH: how is auth built\nAuth uses Supabase.';
    expect(stripInvisibleLines(input)).toBe('Auth uses Supabase.');
  });

  it('does not strip legitimate prose that merely mentions "search:"', () => {
    const input = 'Voici le résultat de la recherche: tout va bien.';
    expect(stripInvisibleLines(input)).toBe(input);
  });

  it('strips a BRAIN_QUERY_CSS structural directive line (kept out of visible UI like BRAIN_SEARCH)', () => {
    const input = 'BRAIN_QUERY_CSS: aside[role="doc-warning"]\nHere are the warnings.';
    expect(stripInvisibleLines(input)).toBe('Here are the warnings.');
  });

  it('strips a BRAIN_NEIGHBOURS structural directive, including mid-line, keeping prior prose', () => {
    expect(stripInvisibleLines('Let me follow it. BRAIN_NEIGHBOURS: decision-7')).toBe('Let me follow it.');
  });
});

// ── directive helpers (describe/execute/isError) ───────────────────────────

describe('brain directive helpers', () => {
  beforeEach(() => {
    mockGetPlatform.mockReset();
  });

  it('describeBrainDirective maps each kind to its tool name, input, status line, and observation header', () => {
    expect(describeBrainDirective({ kind: 'search', arg: 'q' })).toMatchObject({
      toolName: 'brain_search',
      toolInput: { query: 'q' },
    });
    const css = describeBrainDirective({ kind: 'query_css', arg: 'sel' });
    expect(css).toMatchObject({ toolName: 'brain_query_css', toolInput: { selector: 'sel' } });
    expect(css.statusLine).toContain('Requête mémoire');
    expect(css.observationHeader).toContain('brain_query_css results');
    const nb = describeBrainDirective({ kind: 'neighbours', arg: 'id7' });
    expect(nb).toMatchObject({ toolName: 'brain_neighbours', toolInput: { id: 'id7' } });
    expect(nb.statusLine).toContain('Voisins mémoire');
  });

  it('executeBrainDirective routes query_css -> queryCss and neighbours -> neighbours (verbatim arg)', async () => {
    const queryCss = vi.fn().mockResolvedValue('css out');
    const neighbours = vi.fn().mockResolvedValue('neigh out');
    mockGetPlatform.mockReturnValue({ brain: { queryCss, neighbours, recallScoped: vi.fn() } });

    expect(await executeBrainDirective({ kind: 'query_css', arg: 'article[data-x]' })).toBe('css out');
    expect(queryCss).toHaveBeenCalledWith('article[data-x]', undefined);
    expect(await executeBrainDirective({ kind: 'neighbours', arg: 'node-7' })).toBe('neigh out');
    expect(neighbours).toHaveBeenCalledWith('node-7');
  });

  it('executeBrainDirective routes search -> recallScoped, forwarding the sessionId', async () => {
    const recallScoped = vi.fn().mockResolvedValue({ injectedContext: 'ctx', nodes: [] });
    mockGetPlatform.mockReturnValue({ brain: { recallScoped } });
    expect(await executeBrainDirective({ kind: 'search', arg: 'q' }, 'sess-1')).toBe('ctx');
    expect(recallScoped).toHaveBeenCalledWith('q', 'current', 'sess-1');
  });

  it('executeBrainDirective never throws — returns an unavailable string on backend failure', async () => {
    mockGetPlatform.mockReturnValue({
      brain: { queryCss: vi.fn().mockRejectedValue(new Error('boom')), neighbours: vi.fn() },
    });
    const out = await executeBrainDirective({ kind: 'query_css', arg: 'sel' });
    expect(out).toMatch(/brain_query_css unavailable/);
  });

  it('isBrainDirectiveError flags unavailable strings but not legitimate "no hits" results', () => {
    expect(isBrainDirectiveError('(brain search unavailable: x)')).toBe(true);
    expect(isBrainDirectiveError('(brain_query_css unavailable: y)')).toBe(true);
    expect(isBrainDirectiveError('(brain_neighbours unavailable: z)')).toBe(true);
    expect(isBrainDirectiveError('0 matches')).toBe(false);
    expect(isBrainDirectiveError('(no memory hits found)')).toBe(false);
    expect(isBrainDirectiveError('#7 Decision: use SQLite')).toBe(false);
  });
});

// ── withTimeout ─────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'test')).resolves.toBe('ok');
  });

  it('propagates the original rejection reason when it rejects before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'test')).rejects.toThrow('boom');
  });

  it('rejects with a descriptive error when the promise never settles', async () => {
    vi.useFakeTimers();
    try {
      const assertion = expect(withTimeout(neverSettles(), 1000, 'brain recall')).rejects.toThrow(
        /brain recall timed out after 1000ms/,
      );
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── recallForDirective — never hangs the ReAct loop (bug #1) ───────────────

describe('recallForDirective', () => {
  beforeEach(() => {
    mockGetPlatform.mockReset();
    mockRecordRecallSaving.mockReset();
  });

  it('returns the injected context when recall succeeds', async () => {
    mockGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn().mockResolvedValue({ injectedContext: 'some context', nodes: [] }) },
    });
    await expect(recallForDirective('q')).resolves.toBe('some context');
  });

  it('uses a floor of 120s for large-brain cold recall (B35)', () => {
    expect(BRAIN_RECALL_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(BRAIN_RECALL_TIMEOUT_MS).toBeLessThanOrEqual(180_000);
  });

  it('surfaces an explicit timed-out message distinct from unavailable (B35)', async () => {
    const { describeBrainRecallFailure } = await import('../lib/models/brainSearchLoop');
    const timed = describeBrainRecallFailure('brain recall timed out after 150000ms');
    expect(timed).toMatch(/timed out after 150s/);
    expect(timed).toMatch(/^\(brain search timed out/);
    expect(timed).not.toMatch(/^\(brain search unavailable/);
    const other = describeBrainRecallFailure('sidecar down');
    expect(other).toMatch(/^\(brain search unavailable/);
  });

  it('returns a fallback string (never throws) when recall rejects', async () => {
    mockGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    await expect(recallForDirective('q')).resolves.toMatch(/brain search unavailable/);
  });

  it('returns a fallback string within BRAIN_RECALL_TIMEOUT_MS instead of hanging forever', async () => {
    mockGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn(() => neverSettles()) },
    });
    vi.useFakeTimers();
    try {
      // QA fix (2026-07-28): a timeout now gets its own honest, actionable
      // wording ("timed out" + large-brain explanation + scan_project
      // suggestion) instead of the generic "unavailable" — see
      // describeBrainRecallFailure's doc comment. Still never throws/hangs,
      // which is this test's actual point.
      const assertion = expect(recallForDirective('q')).resolves.toMatch(
        /brain search timed out after \d+s/,
      );
      await vi.advanceTimersByTimeAsync(BRAIN_RECALL_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  // ── sessionId threading (Q3 differential-injection dedup) ────────────
  //
  // search.rs's brain_fetch_recall_scoped's session_id param lets the
  // engine skip notes already shown earlier in the same conversation.
  // recallForDirective is the single choke point every BRAIN_SEARCH round
  // (both withBrainSearchLoop and withBrainSearchLoopEvents) recalls
  // through, so proving it forwards sessionId here covers both callers.

  it('forwards sessionId to recallScoped as the third positional argument', async () => {
    const recallScoped = vi.fn().mockResolvedValue({ injectedContext: 'ctx', nodes: [] });
    mockGetPlatform.mockReturnValue({ brain: { recallScoped } });

    await recallForDirective('q', 'conv-123');

    expect(recallScoped).toHaveBeenCalledWith('q', 'current', 'conv-123');
  });

  it('calls recallScoped with sessionId undefined when none is provided (unchanged pre-existing behavior)', async () => {
    const recallScoped = vi.fn().mockResolvedValue({ injectedContext: 'ctx', nodes: [] });
    mockGetPlatform.mockReturnValue({ brain: { recallScoped } });

    await recallForDirective('q');

    expect(recallScoped).toHaveBeenCalledWith('q', 'current', undefined);
  });

  // ── brain-savings wiring (root-cause fix: mid-loop BRAIN_SEARCH recalls
  // used to compute a real tokensSaved estimate and then let it evaporate —
  // see costStore.recordRecallSaving's doc comment) ──────────────────────

  describe('brain-savings wiring', () => {
    it('forwards the recall result to recordRecallSaving, tagged "tool", on a successful recall', async () => {
      const recall = { injectedContext: 'some context', nodes: [], tokensSaved: 812 };
      mockGetPlatform.mockReturnValue({
        brain: { recallScoped: vi.fn().mockResolvedValue(recall) },
      });

      await recallForDirective('q');

      expect(mockRecordRecallSaving).toHaveBeenCalledTimes(1);
      expect(mockRecordRecallSaving).toHaveBeenCalledWith(recall, 'tool');
    });

    it('does not call recordRecallSaving when the recall rejects (nothing was actually injected)', async () => {
      mockGetPlatform.mockReturnValue({
        brain: { recallScoped: vi.fn().mockRejectedValue(new Error('boom')) },
      });

      await recallForDirective('q');

      expect(mockRecordRecallSaving).not.toHaveBeenCalled();
    });

    it('does not call recordRecallSaving when the recall times out', async () => {
      mockGetPlatform.mockReturnValue({
        brain: { recallScoped: vi.fn(() => neverSettles()) },
      });

      vi.useFakeTimers();
      try {
        const resultPromise = recallForDirective('q');
        await vi.advanceTimersByTimeAsync(BRAIN_RECALL_TIMEOUT_MS);
        await resultPromise;
      } finally {
        vi.useRealTimers();
      }

      expect(mockRecordRecallSaving).not.toHaveBeenCalled();
    });
  });
});

// ── withBrainSearchLoop — graceful continuation (bug #1 integration) ───────

describe('withBrainSearchLoop — graceful recall degradation', () => {
  beforeEach(() => {
    mockGetPlatform.mockReset();
  });

  const baseReq = {
    messages: [{ id: 'u1', role: 'user' as const, content: 'hi' }],
    model: { id: 'm', label: 'M', provider: 'anthropic', description: '' },
    mode: 'ask' as const,
    tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
  };

  it('still reaches a final prose answer when the mid-stream recall never settles', async () => {
    mockGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn(() => neverSettles()) },
    });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      if (call === 1) {
        yield 'BRAIN_SEARCH: some query\n';
      } else {
        yield 'Final answer after recall.\n';
      }
    }

    vi.useFakeTimers();
    try {
      const resultPromise = collect(withBrainSearchLoop(baseReq, runTurn));
      await vi.advanceTimersByTimeAsync(BRAIN_RECALL_TIMEOUT_MS + 100);
      const chunks = await resultPromise;
      const combined = chunks.join('');
      expect(combined).toContain('Final answer after recall.');
      expect(combined).not.toContain('BRAIN_SEARCH:');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a transparent pass-through (no recall call) when brain_search is not offered', async () => {
    const recallScoped = vi.fn();
    mockGetPlatform.mockReturnValue({ brain: { recallScoped } });

    async function* runTurn(): AsyncGenerator<string> {
      yield 'Plain answer, no tools.\n';
    }

    const chunks = await collect(withBrainSearchLoop({ ...baseReq, tools: undefined }, runTurn));
    expect(chunks.join('')).toContain('Plain answer, no tools.');
    expect(recallScoped).not.toHaveBeenCalled();
  });

  it('threads req.sessionId into the brain_search recall call (session-dedup)', async () => {
    const recallScoped = vi.fn().mockResolvedValue({ injectedContext: 'ctx', nodes: [] });
    mockGetPlatform.mockReturnValue({ brain: { recallScoped } });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      yield call === 1 ? 'BRAIN_SEARCH: some query\n' : 'Final answer.\n';
    }

    await collect(withBrainSearchLoop({ ...baseReq, sessionId: 'conv-xyz' }, runTurn));

    expect(recallScoped).toHaveBeenCalledWith(expect.any(String), 'current', 'conv-xyz');
  });

  it('fires a BRAIN_QUERY_CSS: directive, runs the structural query, and feeds the result back', async () => {
    const queryCss = vi.fn().mockResolvedValue('#7 Decision: use SQLite for local cache');
    mockGetPlatform.mockReturnValue({ brain: { queryCss, neighbours: vi.fn() } });

    const selector = 'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])';
    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      yield call === 1 ? `BRAIN_QUERY_CSS: ${selector}\n` : 'We use SQLite (#7).\n';
    }

    const combined = (await collect(withBrainSearchLoop(baseReq, runTurn))).join('');

    // Selector passed verbatim (no limit) to the platform method.
    expect(queryCss).toHaveBeenCalledWith(selector, undefined);
    // The raw directive is hidden; a clean status line + the final answer show.
    expect(combined).not.toContain('BRAIN_QUERY_CSS:');
    expect(combined).toContain('Requête mémoire');
    expect(combined).toContain('We use SQLite (#7).');
  });

  it('fires a BRAIN_NEIGHBOURS: directive, follows the graph, and feeds the result back', async () => {
    const neighbours = vi.fn().mockResolvedValue('#7 -> replaced-by #12');
    mockGetPlatform.mockReturnValue({ brain: { queryCss: vi.fn(), neighbours } });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      yield call === 1 ? 'BRAIN_NEIGHBOURS: decision-7\n' : 'It was replaced by #12.\n';
    }

    const combined = (await collect(withBrainSearchLoop(baseReq, runTurn))).join('');

    expect(neighbours).toHaveBeenCalledWith('decision-7');
    expect(combined).not.toContain('BRAIN_NEIGHBOURS:');
    expect(combined).toContain('Voisins mémoire');
    expect(combined).toContain('It was replaced by #12.');
  });

  it('BRAIN_SEARCH: still works alongside the new structural directives (no regression)', async () => {
    const recallScoped = vi.fn().mockResolvedValue({ injectedContext: 'Auth uses Supabase JWT.', nodes: [] });
    mockGetPlatform.mockReturnValue({ brain: { recallScoped, queryCss: vi.fn(), neighbours: vi.fn() } });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      yield call === 1 ? 'BRAIN_SEARCH: how does auth work\n' : 'Auth uses Supabase JWT.\n';
    }

    const combined = (await collect(withBrainSearchLoop(baseReq, runTurn))).join('');
    expect(recallScoped).toHaveBeenCalled();
    expect(combined).toContain('Recherche mémoire');
    expect(combined).toContain('Auth uses Supabase JWT.');
  });
});

// ── withBrainSearchLoopEvents — structured-event counterpart ───────────────
//
// Exercises the SAME loop this module's real providers (claudeCodeProvider,
// anthropicProvider, cliBackendProvider) call in production via
// buildRunTurn — runTurn here is a plain fake (no Tauri), so this proves
// the loop's own event-emission logic directly, not just the store's
// reducer against a hand-rolled fake stream. It does NOT prove the Rust/
// Tauri bridge actually delivers reasoning-marker text for these three
// providers at runtime (see the final report's risk notes).

describe('withBrainSearchLoopEvents', () => {
  beforeEach(() => {
    mockGetPlatform.mockReset();
  });

  const baseReq = {
    messages: [{ id: 'u1', role: 'user' as const, content: 'hi' }],
    model: { id: 'm', label: 'M', provider: 'anthropic', description: '' },
    mode: 'ask' as const,
    tools: [{ name: 'brain_search', description: '', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
  };

  it('emits a running->done tool event around a brain_search call, then a text event for the final answer', async () => {
    mockGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn().mockResolvedValue({ injectedContext: 'Auth uses Supabase JWT.', nodes: [] }) },
    });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      if (call === 1) {
        yield 'BRAIN_SEARCH: how does auth work\n';
      } else {
        yield 'Auth is handled by Supabase.\n';
      }
    }

    const events = await collect<StreamEvent>(withBrainSearchLoopEvents(baseReq, runTurn));

    const toolEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool' }> => e.type === 'tool');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({ name: 'brain_search', status: 'running', input: { query: 'how does auth work' } });
    expect(toolEvents[1]).toMatchObject({ name: 'brain_search', status: 'done', input: { query: 'how does auth work' } });
    // Same id across the running -> done transition (so the UI updates the
    // SAME step in place instead of appending a second one).
    expect(toolEvents[1].id).toBe(toolEvents[0].id);

    const textEvents = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');
    expect(textEvents.map(e => e.text).join('')).toContain('Auth is handled by Supabase.');

    // The raw directive line must never leak into a text event.
    expect(textEvents.some(e => e.text.includes('BRAIN_SEARCH:'))).toBe(false);
  });

  it('extracts reasoning-marker content as thinking events, kept out of text events entirely', async () => {
    async function* runTurn(): AsyncGenerator<string> {
      yield '\x1b[reasoning]I should just answer directly.\nThe answer is 42.\n';
    }

    const events = await collect<StreamEvent>(withBrainSearchLoopEvents({ ...baseReq, tools: undefined }, runTurn));

    const thinkingEvents = events.filter((e): e is Extract<StreamEvent, { type: 'thinking' }> => e.type === 'thinking');
    const textEvents = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');

    expect(thinkingEvents.map(e => e.text).join('')).toBe('I should just answer directly.');
    expect(textEvents.map(e => e.text).join('')).toBe('The answer is 42.\n');
    // Reasoning text must never also appear in a text event.
    expect(textEvents.some(e => e.text.includes('I should just answer directly'))).toBe(false);
  });

  it('reports tool status "error" when brain recall is unavailable', async () => {
    mockGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn().mockRejectedValue(new Error('sidecar down')) },
    });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      yield call === 1 ? 'BRAIN_SEARCH: some query\n' : 'Final answer anyway.\n';
    }

    const events = await collect<StreamEvent>(withBrainSearchLoopEvents(baseReq, runTurn));
    const toolEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool' }> => e.type === 'tool');

    expect(toolEvents[0].status).toBe('running');
    expect(toolEvents[1].status).toBe('error');
  });

  it('is a transparent pass-through (only text events, no tool events) when brain_search is not offered', async () => {
    const recallScoped = vi.fn();
    mockGetPlatform.mockReturnValue({ brain: { recallScoped } });

    async function* runTurn(): AsyncGenerator<string> {
      yield 'Plain answer, no tools.\n';
    }

    const events = await collect<StreamEvent>(withBrainSearchLoopEvents({ ...baseReq, tools: undefined }, runTurn));

    expect(events.every(e => e.type === 'text')).toBe(true);
    expect(events.map(e => (e.type === 'text' ? e.text : '')).join('')).toContain('Plain answer, no tools.');
    expect(recallScoped).not.toHaveBeenCalled();
  });

  it('still reaches a final text event when the mid-stream recall never settles', async () => {
    mockGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn(() => neverSettles()) },
    });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      yield call === 1 ? 'BRAIN_SEARCH: some query\n' : 'Final answer after recall.\n';
    }

    vi.useFakeTimers();
    try {
      const resultPromise = collect<StreamEvent>(withBrainSearchLoopEvents(baseReq, runTurn));
      await vi.advanceTimersByTimeAsync(BRAIN_RECALL_TIMEOUT_MS + 100);
      const events = await resultPromise;
      const textEvents = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');
      expect(textEvents.map(e => e.text).join('')).toContain('Final answer after recall.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit a second tool-call event for a duplicate query (dedup nudges instead)', async () => {
    mockGetPlatform.mockReturnValue({
      brain: { recallScoped: vi.fn().mockResolvedValue({ injectedContext: 'ctx', nodes: [] }) },
    });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      if (call <= 2) return yield 'BRAIN_SEARCH: auth flow\n';
      yield 'Auth uses Supabase JWT.\n';
    }

    const events = await collect<StreamEvent>(withBrainSearchLoopEvents(baseReq, runTurn));
    const toolEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool' }> => e.type === 'tool');

    // Exactly one search (running + done), not two — the duplicate round
    // nudges the model instead of firing a second recall.
    expect(toolEvents).toHaveLength(2);
    const textEvents = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');
    expect(textEvents.map(e => e.text).join('')).toContain('Auth uses Supabase JWT.');
  });

  it('threads req.sessionId into the brain_search recall call (session-dedup)', async () => {
    const recallScoped = vi.fn().mockResolvedValue({ injectedContext: 'ctx', nodes: [] });
    mockGetPlatform.mockReturnValue({ brain: { recallScoped } });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      yield call === 1 ? 'BRAIN_SEARCH: some query\n' : 'Final answer.\n';
    }

    await collect<StreamEvent>(
      withBrainSearchLoopEvents({ ...baseReq, sessionId: 'conv-events-xyz' }, runTurn),
    );

    expect(recallScoped).toHaveBeenCalledWith(expect.any(String), 'current', 'conv-events-xyz');
  });

  it('emits a brain_query_css tool event (running->done) around the structural query, then the final answer as text', async () => {
    const queryCss = vi.fn().mockResolvedValue('#7 Decision: use SQLite');
    mockGetPlatform.mockReturnValue({ brain: { queryCss, neighbours: vi.fn() } });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      yield call === 1 ? 'BRAIN_QUERY_CSS: aside[role="doc-warning"]\n' : 'One warning found.\n';
    }

    const events = await collect<StreamEvent>(withBrainSearchLoopEvents(baseReq, runTurn));
    const toolEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool' }> => e.type === 'tool');

    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0]).toMatchObject({
      name: 'brain_query_css',
      status: 'running',
      input: { selector: 'aside[role="doc-warning"]' },
    });
    expect(toolEvents[1]).toMatchObject({ name: 'brain_query_css', status: 'done' });
    expect(toolEvents[1].id).toBe(toolEvents[0].id);

    const textEvents = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');
    expect(textEvents.map(e => e.text).join('')).toContain('One warning found.');
    expect(textEvents.some(e => e.text.includes('BRAIN_QUERY_CSS:'))).toBe(false);
  });

  it('emits a brain_neighbours tool event and reports status "error" when the graph hop is unavailable', async () => {
    const neighbours = vi.fn().mockRejectedValue(new Error('sidecar down'));
    mockGetPlatform.mockReturnValue({ brain: { queryCss: vi.fn(), neighbours } });

    let call = 0;
    async function* runTurn(): AsyncGenerator<string> {
      call += 1;
      yield call === 1 ? 'BRAIN_NEIGHBOURS: node-7\n' : 'Could not follow that.\n';
    }

    const events = await collect<StreamEvent>(withBrainSearchLoopEvents(baseReq, runTurn));
    const toolEvents = events.filter((e): e is Extract<StreamEvent, { type: 'tool' }> => e.type === 'tool');

    expect(toolEvents[0]).toMatchObject({ name: 'brain_neighbours', status: 'running', input: { id: 'node-7' } });
    expect(toolEvents[1].status).toBe('error');
    const textEvents = events.filter((e): e is Extract<StreamEvent, { type: 'text' }> => e.type === 'text');
    expect(textEvents.map(e => e.text).join('')).toContain('Could not follow that.');
  });
});
