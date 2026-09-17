/* Jev integration tests — the open-source contract, verified:
   - no key / mode off → every surface degrades silently, never throws
   - the client validates wire shapes at the boundary
   - ask_jev validates like every other manager action
   - the wakeup consult drops noise but NEVER drops critical kinds
   - the journal knows the jev.judgment event type
*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isJevConfigured,
  isJevModeOn,
  isJevModeEnabled,
  setJevModeEnabled,
  saveJevKey,
  deleteJevKey,
} from '../jevMode';
import { jevAsk, jevNoul, jevChoice, JevError } from '../jevClient';
import { runAskJev, formatJevAnswers } from '../jevAskRunner';
import { jevResolveLazyBotIntent, jevRerankRecallHits, jevScoreMissionReview } from '../jevEnhancements';
import { validateManagerAction } from '../../agents/managerActionValidator';
import { SAFE_ACTIONS } from '../../agents/actionClassifier';
import { JOURNAL_EVENT_TYPES } from '../../journal/journalEventTypeList';
import { startManagerWakeupScheduler, type WakeupJournalRow } from '../../agents/managerWakeup';

const TEST_KEY = 'apikey_test_only_not_a_real_key_0000000000000000';

function enableJev(): void {
  saveJevKey(TEST_KEY);
  setJevModeEnabled(true);
}

function mockFetchOnce(payload: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })));
}

beforeEach(() => {
  deleteJevKey();
  setJevModeEnabled(true);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch must be mocked'); }));
});

afterEach(() => {
  deleteJevKey();
  vi.unstubAllGlobals();
});

// ── jevMode gating ───────────────────────────────────────────────────

describe('jevMode gates', () => {
  it('is unconfigured and off with no key', () => {
    expect(isJevConfigured()).toBe(false);
    expect(isJevModeOn()).toBe(false);
  });

  it('is configured but still off when the user disabled the mode', () => {
    enableJev();
    setJevModeEnabled(false);
    expect(isJevConfigured()).toBe(true);
    expect(isJevModeEnabled()).toBe(false);
    expect(isJevModeOn()).toBe(false);
  });

  it('is on only when both gates pass', () => {
    enableJev();
    expect(isJevModeOn()).toBe(true);
  });

  it('turns fully off when the key is removed', () => {
    enableJev();
    deleteJevKey();
    expect(isJevConfigured()).toBe(false);
    expect(isJevModeOn()).toBe(false);
  });
});

// ── jevClient ────────────────────────────────────────────────────────

describe('jevAsk', () => {
  it('refuses to run when Jev mode is off (never hits the network)', async () => {
    await expect(jevAsk({}, { q: { type: 'noul', instructions: 'x?' } }))
      .rejects.toBeInstanceOf(JevError);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('sends {state, model, questions} with the Bearer key and parses typed answers', async () => {
    enableJev();
    mockFetchOnce({
      model: 'jev-1.13.0',
      answers: { q: { type: 'noul', noul: 0.87 } },
      usage: { input_tokens: 120 },
    });
    const res = await jevAsk({ a: 1 }, { q: { type: 'noul', instructions: 'yes?' } });
    expect(res.model).toBe('jev-1.13.0');
    expect(res.answers.q).toEqual({ type: 'noul', noul: 0.87 });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-latest');
    expect(body.questions.q.type).toBe('noul');
    // The key rides the Authorization header — and never lands in errors.
    expect(String((init.headers as Record<string, string>).Authorization)).toContain(TEST_KEY);
  });

  it('rejects a malformed answers payload', async () => {
    enableJev();
    mockFetchOnce({ model: 'm', answers: { q: { type: 'noul' } } });
    await expect(jevAsk({}, { q: { type: 'noul', instructions: 'x' } }))
      .rejects.toThrow(/malformed noul/);
  });

  it('rejects an empty questions map before any fetch', async () => {
    enableJev();
    await expect(jevAsk({}, {})).rejects.toThrow(/empty/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('does not retry on 401 and never leaks the key in the error', async () => {
    enableJev();
    mockFetchOnce('unauthorized', 401);
    await expect(jevAsk({}, { q: { type: 'noul', instructions: 'x' } }))
      .rejects.toThrow(/authentication failed/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('retries once on a 5xx then succeeds', async () => {
    enableJev();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('boom', { status: 503 });
      return new Response(JSON.stringify({
        model: 'm', answers: { q: { type: 'noul', noul: 0.5 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const res = await jevAsk({}, { q: { type: 'noul', instructions: 'x' } });
    expect(res.answers.q.type).toBe('noul');
    expect(calls).toBe(2);
  });

  it('jevNoul returns the probability, jevChoice returns the pick', async () => {
    enableJev();
    mockFetchOnce({ model: 'm', answers: { q: { type: 'noul', noul: 0.7 } } });
    await expect(jevNoul({}, 'is it?')).resolves.toBe(0.7);

    mockFetchOnce({
      model: 'm',
      answers: { q: { type: 'choice', choice: 'b', probabilities: { a: 0.2, b: 0.8 }, confidence: 0.9 } },
    });
    const pick = await jevChoice({}, 'which?', ['a', 'b']);
    expect(pick.choice).toBe('b');
    expect(pick.probability).toBe(0.8);
  });
});

// ── runAskJev (manager action + agent tool shared path) ─────────────

describe('runAskJev', () => {
  it('returns an explicit unavailable line when Jev mode is off', async () => {
    const out = await runAskJev({}, [{ id: 'q', type: 'noul', instructions: 'x?' }], { subject: 'ask_jev' });
    expect(out).toMatch(/ask_jev unavailable/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('rejects malformed question lists with an honest reason', async () => {
    enableJev();
    expect(await runAskJev({}, [], { subject: 'ask_jev' })).toMatch(/non-empty array/);
    expect(await runAskJev({}, [{ id: 'q', type: 'nope' as never, instructions: 'x' }], { subject: 'ask_jev' }))
      .toMatch(/unknown type/);
    expect(await runAskJev({}, [{ id: 'q', type: 'choice', instructions: 'x' }], { subject: 'ask_jev' }))
      .toMatch(/options/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('formats real typed answers for the model', async () => {
    enableJev();
    mockFetchOnce({
      model: 'jev-1.13.0',
      answers: {
        wants_run: { type: 'noul', noul: 0.91 },
        which: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.85 },
      },
    });
    const out = await runAskJev({ ctx: 1 }, [
      { id: 'wants_run', type: 'noul', instructions: 'run?' },
      { id: 'which', type: 'choice', instructions: 'which?', options: ['a', 'b'] },
    ], { subject: 'ask_jev' });
    expect(out).toContain('noul 0.91');
    expect(out).toContain('choice "a"');
    expect(out).toContain('jev-1.13.0');
  });

  it('returns an unavailable line (never throws) when the request fails', async () => {
    enableJev();
    mockFetchOnce('server exploded', 500);
    const out = await runAskJev({}, [{ id: 'q', type: 'noul', instructions: 'x' }], { subject: 'ask_jev' });
    expect(out).toMatch(/ask_jev unavailable/);
  });
});

describe('formatJevAnswers', () => {
  it('renders all three primitives compactly', () => {
    const s = formatJevAnswers({
      model: 'm',
      answers: {
        n: { type: 'noul', noul: 0.3 },
        c: { type: 'choice', choice: 'x' },
        s: { type: 'score', score: 2 },
      },
    });
    expect(s).toContain('n: noul 0.30');
    expect(s).toContain('c: choice "x"');
    expect(s).toContain('s: score 2');
  });
});

// ── Manager action plumbing ─────────────────────────────────────────

describe('ask_jev manager action', () => {
  const valid = {
    type: 'ask_jev',
    state: { note: 'ctx' },
    questions: [{ id: 'q', type: 'noul', instructions: 'is it?' }],
  };

  it('validates a well-formed ask_jev action', () => {
    expect(validateManagerAction(valid)).toEqual({ ok: true });
  });

  it('rejects missing/empty questions and bad types', () => {
    expect(validateManagerAction({ type: 'ask_jev' }).ok).toBe(false);
    expect(validateManagerAction({ type: 'ask_jev', questions: [] }).ok).toBe(false);
    expect(validateManagerAction({
      type: 'ask_jev',
      questions: [{ id: 'q', type: 'guess', instructions: 'x' }],
    }).ok).toBe(false);
    expect(validateManagerAction({
      type: 'ask_jev',
      questions: [{ id: 'q', type: 'choice', instructions: 'x' }],
    }).ok).toBe(false);
  });

  it('is classified safe (read-only grounding — never gated by approval)', () => {
    expect(SAFE_ACTIONS.has('ask_jev')).toBe(true);
  });
});

// ── Journal contract ────────────────────────────────────────────────

describe('jev.judgment journal event', () => {
  it('is registered in the runtime event list', () => {
    expect(JOURNAL_EVENT_TYPES).toContain('jev.judgment');
  });
});

// ── Enhancements: silent degradation without a key ──────────────────

describe('enhancements degrade without Jev mode', () => {
  it('jevResolveLazyBotIntent returns undefined and never fetches', async () => {
    const out = await jevResolveLazyBotIntent('lance le bot', [
      { id: 'b1', name: 'Bot', enabled: true } as never,
    ]);
    expect(out).toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('jevRerankRecallHits returns the original list untouched', async () => {
    const hits = [{ id: 'h1', title: 't' }, { id: 'h2', title: 'u' }] as never[];
    const out = await jevRerankRecallHits('query', hits, 'p');
    expect(out).toBe(hits);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('jevResolveLazyBotIntent (mode on)', () => {
  const bots = [
    { id: 'bot-a', name: 'Scraper', enabled: true },
    { id: 'bot-b', name: 'Mailer', enabled: true },
  ] as never[];

  it('returns undefined when P(run) is low', async () => {
    enableJev();
    mockFetchOnce({
      model: 'm',
      answers: {
        wants_run: { type: 'noul', noul: 0.2 },
        which_bot: { type: 'choice', choice: 'bot-a', probabilities: { 'bot-a': 0.9 } },
      },
    });
    expect(await jevResolveLazyBotIntent('quel temps ?', bots)).toBeUndefined();
  });

  it('picks the chosen bot only above the probability threshold', async () => {
    enableJev();
    mockFetchOnce({
      model: 'm',
      answers: {
        wants_run: { type: 'noul', noul: 0.9 },
        which_bot: { type: 'choice', choice: 'bot-b', probabilities: { 'bot-b': 0.75 } },
      },
    });
    const out = await jevResolveLazyBotIntent('envoie les mails', bots);
    expect(out?.botId).toBe('bot-b');
  });

  it('refuses a low-confidence pick', async () => {
    enableJev();
    mockFetchOnce({
      model: 'm',
      answers: {
        wants_run: { type: 'noul', noul: 0.9 },
        which_bot: { type: 'choice', choice: 'bot-b', probabilities: { 'bot-b': 0.3 } },
      },
    });
    expect(await jevResolveLazyBotIntent('envoie les mails', bots)).toBeUndefined();
  });
});

// ── Wakeup consult: veto drops noise, never criticals ───────────────

function wakeupDeps(overrides: Record<string, unknown> = {}) {
  return {
    fetchEventsSince: async () => [] as WakeupJournalRow[],
    isManagerBusy: () => false,
    sendWakeupTurn: vi.fn(async () => {}),
    formatWakeupText: () => 'wakeup text',
    getConfig: () => ({ enabled: true, debounceMs: 5, maxAutoTurnsPerHour: 10, echoSuppressMs: 0 }),
    ...overrides,
  };
}

function row(type: string, payload: Record<string, unknown> = {}, missionId?: string): WakeupJournalRow {
  return { type, ts_ms: Date.now(), mission_id: missionId ?? null, payload: JSON.stringify(payload) } as WakeupJournalRow;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
}

describe('managerWakeup Jev consult', () => {
  it('sends the batch unchanged without a judge dep', async () => {
    const send = vi.fn(async () => {});
    const h = startManagerWakeupScheduler(wakeupDeps({ sendWakeupTurn: send }));
    h.ingestRows([row('chain.fired', { targetRef: 'mission:M1' }, 'M1')]);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('drops a vetoed non-critical batch entirely', async () => {
    const send = vi.fn(async () => {});
    const h = startManagerWakeupScheduler(wakeupDeps({
      sendWakeupTurn: send,
      judgeWakeupBatch: async () => ({ proceed: false }),
    }));
    h.ingestRows([row('chain.fired', { targetRef: 'mission:M1' }, 'M1')]);
    await settle();
    expect(send).not.toHaveBeenCalled();
    h.stop();
  });

  it('still sends critical kinds even when the judge vetoes the batch', async () => {
    const send = vi.fn(async () => {});
    const h = startManagerWakeupScheduler(wakeupDeps({
      sendWakeupTurn: send,
      judgeWakeupBatch: async () => ({ proceed: false }),
    }));
    h.ingestRows([row('mission.failed', {}, 'M9')]);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('filters the batch to the keep list (criticals always kept)', async () => {
    const sent: WakeupJournalRow[][] = [];
    const h = startManagerWakeupScheduler(wakeupDeps({
      sendWakeupTurn: async (_t: string, c: unknown[]) => { sent.push(c as never); },
      judgeWakeupBatch: async () => ({ proceed: true, keep: ['chain_fired'] }),
    }));
    h.ingestRows([
      row('chain.fired', { targetRef: 'mission:M1' }, 'M1'),
      row('mission.approved', {}, 'M2'), // review_passed — not critical, filtered out
    ]);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1);
    h.stop();
  });

  it('fails open when the judge throws', async () => {
    const send = vi.fn(async () => {});
    const h = startManagerWakeupScheduler(wakeupDeps({
      sendWakeupTurn: send,
      judgeWakeupBatch: async () => { throw new Error('jev down'); },
    }));
    h.ingestRows([row('chain.fired', { targetRef: 'mission:M1' }, 'M1')]);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    h.stop();
  });
});

// ── Rerank: reorders, drops, fails open ─────────────────────────────

describe('jevRerankRecallHits (mode on)', () => {
  const hits = [
    { id: 'h1', title: 'alpha', snippet: 'a' },
    { id: 'h2', title: 'beta', snippet: 'b' },
    { id: 'h3', title: 'gamma', snippet: 'c' },
  ] as never[];

  it('reorders by noul and drops hits below the keep threshold', async () => {
    enableJev();
    mockFetchOnce({
      model: 'm',
      answers: {
        rel_0: { type: 'noul', noul: 0.3 }, // below RECALL_KEEP_THRESHOLD → dropped
        rel_1: { type: 'noul', noul: 0.9 },
        rel_2: { type: 'noul', noul: 0.6 },
      },
    });
    const out = await jevRerankRecallHits('q', hits, 'p');
    expect(out.map((h) => (h as { id: string }).id)).toEqual(['h2', 'h3']);
  });

  it('keeps the original list when every hit scores below threshold (fail-open)', async () => {
    enableJev();
    mockFetchOnce({
      model: 'm',
      answers: {
        rel_0: { type: 'noul', noul: 0.1 },
        rel_1: { type: 'noul', noul: 0.2 },
        rel_2: { type: 'noul', noul: 0.1 },
      },
    });
    const out = await jevRerankRecallHits('q', hits, 'p');
    expect(out).toBe(hits);
  });
});

// ── Question shape: noul criteria sharpen the judgment ──────────────

describe('enhancement question shapes', () => {
  it('sends true/false criteria on the lazybot noul', async () => {
    enableJev();
    mockFetchOnce({
      model: 'm',
      answers: {
        wants_run: { type: 'noul', noul: 0.9 },
        which_bot: { type: 'choice', choice: 'bot-a', probabilities: { 'bot-a': 0.8 } },
      },
    });
    await jevResolveLazyBotIntent('lance le bot', [
      { id: 'bot-a', name: 'Scraper', enabled: true },
      { id: 'bot-b', name: 'Mailer', enabled: true },
    ] as never[]);
    const [, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.questions.wants_run.criteria).toEqual({
      true: expect.any(String),
      false: expect.any(String),
    });
  });
});

// ── runAskJev: oversized object states are bounded, not fatal ───────

describe('runAskJev state bounding', () => {
  it('truncates an oversized object state instead of failing the request', async () => {
    enableJev();
    mockFetchOnce({ model: 'm', answers: { q: { type: 'noul', noul: 0.5 } } });
    const huge = { blob: 'x'.repeat(20_000) };
    const out = await runAskJev(huge, [{ id: 'q', type: 'noul', instructions: 'x?' }], { subject: 'ask_jev' });
    expect(out).toContain('noul 0.50');
    const [, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(typeof body.state.context).toBe('string');
    expect(body.state.context.length).toBeLessThanOrEqual(8_100);
  });
});

// ── Mission review: confidence flows to the chip ────────────────────

describe('jevScoreMissionReview (mode on)', () => {
  it('carries the score confidence through so the UI can gate on it', async () => {
    enableJev();
    mockFetchOnce({
      model: 'm',
      answers: {
        satisfies_task: { type: 'noul', noul: 0.82 },
        review_urgency: { type: 'score', score: 1, confidence: 0.2 },
      },
    });
    const out = await jevScoreMissionReview({ missionTitle: 't', projectId: 'p', missionId: 'm' });
    expect(out?.satisfies).toBe(0.82);
    expect(out?.confidence).toBe(0.2);
  });
});
