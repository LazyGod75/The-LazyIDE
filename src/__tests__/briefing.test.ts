/* briefing.test.ts — the resume briefing's pure logic (src/lib/agents/briefing.ts).

   Covers:
   1. buildBriefingDigest: pure + deterministic grouping into
      shipped/asks/learned/spent/nightShift, order-independent (defensively
      sorts by seq), open-vs-resolved blocked/question semantics.
   2. buildBriefingPrompt: short, digest-only, explicit no-invent instruction,
      per-locale language selection.
   3. generateBriefingNarrative: reuses the shared model gateway
      (getProvider/describeProviderReadiness/getActiveModel from
      ../lib/models/index — same mock seam as autoFix.test.ts), throws
      (never fabricates) when no model is ready / the stream is empty.
   4. Cache (readBriefingCache/writeBriefingCache): keyed by lastSeq, a
      mismatched or corrupt cache entry is treated as a miss.
   5. lastSeen anchor math (readLastSeen/writeLastSeen/resolveSinceAnchor):
      24h first-run window, persisted-value roundtrip, resolveScope.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JournalEventRow } from '../lib/journal/eventTypes';
import {
  buildBriefingDigest,
  buildBriefingPrompt,
  generateBriefingNarrative,
  resolveScope,
  resolveSinceAnchor,
  readLastSeen,
  writeLastSeen,
  readBriefingCache,
  writeBriefingCache,
  type BriefingDigest,
} from '../lib/agents/briefing';

// getActiveModel() is left REAL via importOriginal (same rationale as
// autoFix.test.ts) — only provider selection/readiness is mocked.
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProvider: vi.fn(),
    describeProviderReadiness: vi.fn(() => ({ ready: true })),
  };
});

import { getProvider, describeProviderReadiness } from '../lib/models/index';
import type { StreamChatRequest } from '../lib/models';

function row(overrides: Partial<JournalEventRow> = {}): JournalEventRow {
  return {
    seq: 1,
    ts_ms: 1_000,
    project_id: 'proj-1',
    mission_id: null,
    agent_id: null,
    run_id: null,
    actor: 'agent',
    type: 'tool.called',
    payload: '{}',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  } as JournalEventRow;
}

beforeEach(() => {
  localStorage.clear();
});

// ── buildBriefingDigest ───────────────────────────────────────────────

describe('buildBriefingDigest — empty input', () => {
  it('returns an all-zero digest for an empty event list', () => {
    const digest = buildBriefingDigest([]);
    expect(digest.eventCount).toBe(0);
    expect(digest.lastSeq).toBe(0);
    expect(digest.shipped).toEqual([]);
    expect(digest.asks).toEqual([]);
    expect(digest.learned).toEqual({ capturedCount: 0, decisionCount: 0, promotedCount: 0, topItems: [] });
    expect(digest.spent).toEqual({ totalUsd: 0, byProject: {} });
    expect(digest.nightShift).toEqual({ count: 0, byProject: {}, items: [] });
  });
});

describe('buildBriefingDigest — shipped', () => {
  it('groups mission.completed/approved and attaches proof refs for the same mission', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, ts_ms: 100, mission_id: 'm1', type: 'mission.proof_attached', payload: JSON.stringify({ kind: 'test_run', label: 'unit tests' }) }),
      row({ seq: 2, ts_ms: 200, mission_id: 'm1', type: 'mission.completed' }),
      row({ seq: 3, ts_ms: 300, mission_id: 'm2', type: 'mission.approved' }),
    ];
    const digest = buildBriefingDigest(events);
    expect(digest.shipped).toHaveLength(2);
    expect(digest.shipped[0]).toMatchObject({ missionId: 'm1', kind: 'completed', proofRefs: ['unit tests'] });
    expect(digest.shipped[1]).toMatchObject({ missionId: 'm2', kind: 'approved', proofRefs: [] });
  });

  it('ignores mission.completed with no mission_id', () => {
    const events: JournalEventRow[] = [row({ seq: 1, type: 'mission.completed', mission_id: null })];
    expect(buildBriefingDigest(events).shipped).toEqual([]);
  });

  // BUG-5: a mission.completed/approved that was later superseded by a
  // mission.failed/mission.reverted for the SAME mission must not be
  // narrated as shipped — mirrors the asks section's resolvedLater pattern.
  it('excludes a mission.completed later superseded by mission.failed for the same mission_id', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.completed' }),
      row({ seq: 2, mission_id: 'm1', type: 'mission.failed' }),
    ];
    expect(buildBriefingDigest(events).shipped).toEqual([]);
  });

  it('excludes a mission.approved later superseded by mission.reverted for the same mission_id', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm2', type: 'mission.approved' }),
      row({ seq: 2, mission_id: 'm2', type: 'mission.reverted' }),
    ];
    expect(buildBriefingDigest(events).shipped).toEqual([]);
  });

  it('does not let an EARLIER mission.failed supersede a LATER mission.completed (seq order matters)', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.failed' }),
      row({ seq: 2, mission_id: 'm1', type: 'mission.completed' }),
    ];
    expect(buildBriefingDigest(events).shipped).toHaveLength(1);
  });

  it('a mission.failed for a DIFFERENT mission_id does not supersede this one', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.completed' }),
      row({ seq: 2, mission_id: 'm2', type: 'mission.failed' }),
    ];
    expect(buildBriefingDigest(events).shipped).toHaveLength(1);
  });

  it('still keeps a shipped item that is NOT superseded, alongside one that is', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.completed' }),
      row({ seq: 2, mission_id: 'm1', type: 'mission.failed' }),
      row({ seq: 3, mission_id: 'm2', type: 'mission.approved' }),
    ];
    const digest = buildBriefingDigest(events);
    expect(digest.shipped).toHaveLength(1);
    expect(digest.shipped[0]).toMatchObject({ missionId: 'm2', kind: 'approved' });
  });
});

describe('buildBriefingDigest — asks (open vs resolved)', () => {
  it('includes a mission.blocked event with no later resolver as an open ask', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.blocked', payload: JSON.stringify({ reason: 'waiting on API key' }) }),
    ];
    const digest = buildBriefingDigest(events);
    expect(digest.asks).toHaveLength(1);
    expect(digest.asks[0]).toMatchObject({ kind: 'blocked', missionId: 'm1', reason: 'waiting on API key' });
  });

  it('excludes a mission.blocked event resolved later by mission.resumed', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.blocked' }),
      row({ seq: 2, mission_id: 'm1', type: 'mission.resumed' }),
    ];
    expect(buildBriefingDigest(events).asks).toEqual([]);
  });

  it('does not let an EARLIER resolver-shaped event resolve a LATER blocked (seq order matters)', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.resumed' }),
      row({ seq: 2, mission_id: 'm1', type: 'mission.blocked' }),
    ];
    expect(buildBriefingDigest(events)).toMatchObject({ asks: [{ kind: 'blocked', missionId: 'm1' }] });
  });

  it('includes a mission.question with no later mission.answered as an open ask', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.question', payload: JSON.stringify({ question: 'which auth lib?' }) }),
    ];
    const digest = buildBriefingDigest(events);
    expect(digest.asks).toEqual([{ kind: 'question', missionId: 'm1', projectId: 'proj-1', tsMs: 1_000, reason: 'which auth lib?' }]);
  });

  it('excludes a mission.question resolved later by mission.answered', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.question' }),
      row({ seq: 2, mission_id: 'm1', type: 'mission.answered' }),
    ];
    expect(buildBriefingDigest(events).asks).toEqual([]);
  });

  it('always includes budget.warning and budget.exceeded (no resolver concept)', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, type: 'budget.warning', payload: JSON.stringify({ pct: 90, capUsd: 10 }) }),
      row({ seq: 2, type: 'budget.exceeded', payload: JSON.stringify({ capUsd: 10, spentUsd: 12 }) }),
    ];
    const digest = buildBriefingDigest(events);
    expect(digest.asks).toHaveLength(2);
    expect(digest.asks[0]).toMatchObject({ kind: 'budget_warning', reason: 'Budget at 90%' });
    expect(digest.asks[1]).toMatchObject({ kind: 'budget_exceeded', reason: 'Budget exceeded ($12.00)' });
  });

  it('a blocked mission from a DIFFERENT mission_id is not resolved by another mission resuming', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, mission_id: 'm1', type: 'mission.blocked' }),
      row({ seq: 2, mission_id: 'm2', type: 'mission.resumed' }),
    ];
    expect(buildBriefingDigest(events).asks).toHaveLength(1);
  });
});

describe('buildBriefingDigest — learned', () => {
  it('counts brain.captured/decision_created/promoted and caps topItems at 5, most-recent-first', () => {
    const events: JournalEventRow[] = Array.from({ length: 6 }, (_, i) =>
      row({ seq: i + 1, ts_ms: (i + 1) * 100, type: 'brain.captured', payload: JSON.stringify({ neuronId: `n${i}`, kind: `kind-${i}` }) }),
    );
    const digest = buildBriefingDigest(events);
    expect(digest.learned.capturedCount).toBe(6);
    expect(digest.learned.topItems).toHaveLength(5);
    // Most recent (kind-5, ts 600) first.
    expect(digest.learned.topItems[0]).toMatchObject({ kind: 'captured', label: 'kind-5' });
  });

  it('counts decisions and promotions independently', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, type: 'brain.decision_created', payload: JSON.stringify({ question: 'which db?', answer: 'postgres' }) }),
      row({ seq: 2, type: 'brain.promoted', payload: JSON.stringify({ neuronId: 'n1', scope: 'org' }) }),
    ];
    const digest = buildBriefingDigest(events);
    expect(digest.learned).toMatchObject({ capturedCount: 0, decisionCount: 1, promotedCount: 1 });
  });
});

describe('buildBriefingDigest — spent', () => {
  it('sums cost_usd per project and in total', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, project_id: 'proj-a', cost_usd: 0.5 }),
      row({ seq: 2, project_id: 'proj-a', cost_usd: 0.25 }),
      row({ seq: 3, project_id: 'proj-b', cost_usd: 1.0 }),
    ];
    const digest = buildBriefingDigest(events);
    expect(digest.spent.totalUsd).toBeCloseTo(1.75);
    expect(digest.spent.byProject).toEqual({ 'proj-a': 0.75, 'proj-b': 1.0 });
  });

  it('does not add a project entry for events with zero cost', () => {
    const digest = buildBriefingDigest([row({ seq: 1, project_id: 'proj-a', cost_usd: 0 })]);
    expect(digest.spent.byProject).toEqual({});
  });
});

describe('buildBriefingDigest — nightShift', () => {
  it('counts loop.iteration events per project and caps items at 8, most-recent-first', () => {
    const events: JournalEventRow[] = Array.from({ length: 10 }, (_, i) =>
      row({ seq: i + 1, ts_ms: (i + 1) * 10, project_id: 'proj-a', type: 'loop.iteration', payload: JSON.stringify({ summary: `iter-${i}` }) }),
    );
    const digest = buildBriefingDigest(events);
    expect(digest.nightShift.count).toBe(10);
    expect(digest.nightShift.byProject).toEqual({ 'proj-a': 10 });
    expect(digest.nightShift.items).toHaveLength(8);
    expect(digest.nightShift.items[0].summary).toBe('iter-9'); // most recent first
  });

  it('does not count loop.tick as a night-shift iteration', () => {
    const digest = buildBriefingDigest([row({ seq: 1, type: 'loop.tick' })]);
    expect(digest.nightShift.count).toBe(0);
  });
});

describe('buildBriefingDigest — determinism / order-independence', () => {
  it('produces an identical digest regardless of input array order', () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, ts_ms: 100, mission_id: 'm1', type: 'mission.completed' }),
      row({ seq: 2, ts_ms: 200, type: 'brain.captured', payload: JSON.stringify({ kind: 'note' }) }),
      row({ seq: 3, ts_ms: 300, cost_usd: 0.1 }),
    ];
    const forward = buildBriefingDigest(events);
    const shuffled = buildBriefingDigest([events[2], events[0], events[1]]);
    expect(shuffled).toEqual(forward);
  });

  it('is a pure function: calling it twice on the same input yields equal output', () => {
    const events: JournalEventRow[] = [row({ seq: 1, mission_id: 'm1', type: 'mission.approved' })];
    expect(buildBriefingDigest(events)).toEqual(buildBriefingDigest(events));
  });

  it('derives sinceMs/untilMs/lastSeq from the seq-ordered window', () => {
    const events: JournalEventRow[] = [
      row({ seq: 5, ts_ms: 500 }),
      row({ seq: 3, ts_ms: 300 }),
      row({ seq: 9, ts_ms: 900 }),
    ];
    const digest = buildBriefingDigest(events);
    expect(digest.sinceMs).toBe(300);
    expect(digest.untilMs).toBe(900);
    expect(digest.lastSeq).toBe(9);
    expect(digest.eventCount).toBe(3);
  });
});

// ── buildBriefingPrompt ───────────────────────────────────────────────

describe('buildBriefingPrompt', () => {
  const digest: BriefingDigest = {
    ...buildBriefingDigest([row({ seq: 1, ts_ms: 1_000, mission_id: 'm1', type: 'mission.completed' })]),
  };

  it('is short and includes an explicit no-invent instruction', () => {
    const prompt = buildBriefingPrompt(digest, 'en');
    expect(prompt).toMatch(/never invent/i);
    expect(prompt.length).toBeLessThan(1500);
  });

  it('embeds the digest facts (e.g. a shipped mission id), not a placeholder', () => {
    const prompt = buildBriefingPrompt(digest, 'en');
    expect(prompt).toContain('m1');
  });

  it('selects the language named after the given locale', () => {
    expect(buildBriefingPrompt(digest, 'fr')).toContain('French');
    expect(buildBriefingPrompt(digest, 'ja')).toContain('Japanese');
    expect(buildBriefingPrompt(digest, 'en')).toContain('English');
  });
});

// ── generateBriefingNarrative ─────────────────────────────────────────

describe('generateBriefingNarrative', () => {
  const digestWithEvents: BriefingDigest = buildBriefingDigest([
    row({ seq: 1, mission_id: 'm1', type: 'mission.completed' }),
  ]);

  it('throws without calling the provider when there are no events to narrate', async () => {
    const emptyDigest = buildBriefingDigest([]);
    await expect(generateBriefingNarrative(emptyDigest, 'en')).rejects.toThrow();
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('throws (never fabricates) when no model is ready, without calling getProvider', async () => {
    vi.mocked(describeProviderReadiness).mockReturnValueOnce({ ready: false, reason: 'No model available' });
    await expect(generateBriefingNarrative(digestWithEvents, 'en')).rejects.toThrow(/no model available/i);
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('returns the concatenated stream text, sending mode "ask" and the active model', async () => {
    const capture: { request: StreamChatRequest | null } = { request: null };
    vi.mocked(getProvider).mockReturnValue({
      id: 'mock',
      label: 'Mock',
      listModels: () => [],
      streamChat: (req: StreamChatRequest) => {
        capture.request = req;
        return (async function* () {
          yield 'Shipped ';
          yield 'm1.';
        })();
      },
    });

    const text = await generateBriefingNarrative(digestWithEvents, 'en');
    expect(text).toBe('Shipped m1.');
    expect(capture.request?.mode).toBe('ask');
    expect(capture.request?.messages).toHaveLength(1);
    expect(capture.request?.messages[0].role).toBe('user');
  });

  it('throws when the stream yields only whitespace (never returns fake/empty prose)', async () => {
    vi.mocked(getProvider).mockReturnValue({
      id: 'mock',
      label: 'Mock',
      listModels: () => [],
      streamChat: () => (async function* () { yield '   \n'; })(),
    });
    await expect(generateBriefingNarrative(digestWithEvents, 'en')).rejects.toThrow(/empty/i);
  });
});

// ── Cache (readBriefingCache / writeBriefingCache) ───────────────────

describe('briefing cache', () => {
  it('returns null when nothing is cached', () => {
    expect(readBriefingCache('fleet', 5)).toBeNull();
  });

  it('round-trips an entry when lastSeq matches', () => {
    writeBriefingCache('fleet', { lastSeq: 5, narrative: 'All good.', generatedAtMs: 123 });
    expect(readBriefingCache('fleet', 5)).toEqual({ lastSeq: 5, narrative: 'All good.', generatedAtMs: 123 });
  });

  it('treats a stale lastSeq (new events since caching) as a miss', () => {
    writeBriefingCache('fleet', { lastSeq: 5, narrative: 'Old summary.', generatedAtMs: 123 });
    expect(readBriefingCache('fleet', 6)).toBeNull();
  });

  it('treats corrupt JSON as a miss instead of throwing', () => {
    localStorage.setItem('lazy.briefing.fleet', '{not json');
    expect(readBriefingCache('fleet', 5)).toBeNull();
  });

  it('keeps per-scope entries independent', () => {
    writeBriefingCache('fleet', { lastSeq: 1, narrative: 'fleet summary', generatedAtMs: 1 });
    writeBriefingCache('proj-a', { lastSeq: 1, narrative: 'proj-a summary', generatedAtMs: 1 });
    expect(readBriefingCache('fleet', 1)?.narrative).toBe('fleet summary');
    expect(readBriefingCache('proj-a', 1)?.narrative).toBe('proj-a summary');
  });
});

// ── lastSeen anchor math ──────────────────────────────────────────────

describe('lastSeen / resolveSinceAnchor', () => {
  it('resolveScope maps undefined to "fleet" and passes a projectId through', () => {
    expect(resolveScope(undefined)).toBe('fleet');
    expect(resolveScope('proj-a')).toBe('proj-a');
  });

  it('readLastSeen returns null on first run', () => {
    expect(readLastSeen('fleet')).toBeNull();
  });

  it('writeLastSeen then readLastSeen round-trips the timestamp', () => {
    writeLastSeen('fleet', 42_000);
    expect(readLastSeen('fleet')).toBe(42_000);
  });

  it('resolveSinceAnchor falls back to a 24h lookback window on first run', () => {
    const now = 1_000_000_000_000;
    expect(resolveSinceAnchor('fleet', now)).toBe(now - 24 * 60 * 60 * 1000);
  });

  it('resolveSinceAnchor uses the persisted lastSeen when present, ignoring nowMs', () => {
    writeLastSeen('fleet', 42_000);
    expect(resolveSinceAnchor('fleet', 999_999_999)).toBe(42_000);
  });
});
