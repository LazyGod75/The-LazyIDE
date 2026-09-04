/**
 * Unit tests for applyNoisePenalty (recall-time noise demotion).
 *
 * Verifies that notes matching noise heuristics (build output, agent meta,
 * short episodic low-importance) are demoted below real notes for the same
 * query, without over-penalizing genuine episodic content.
 */

import { describe, expect, it, vi } from 'vitest';
import { applyNoisePenalty } from '../rankers.js';
import type { ResolvedHit } from '../router-types.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../indexer/fts.js', () => ({
  getNoteById: vi.fn((id: string) => {
    const notes: Record<string, { type: string; importance: number | null }> = {
      'real-note': { type: 'decision', importance: 0.9 },
      'episodic-good': { type: 'episodic', importance: 0.8 },
      'episodic-short-low': { type: 'episodic', importance: 0.05 },
      'build-noise': { type: 'episodic', importance: 0.5 },
      'agent-meta': { type: 'episodic', importance: 0.5 },
      'episodic-rich': { type: 'episodic', importance: 0.15 },
      'shell-dump': { type: 'episodic', importance: 0.3 },
      'real-with-banner': { type: 'episodic', importance: 0.7 },
    };
    return notes[id] ?? null;
  }),
  getNoteText: vi.fn((id: string) => {
    const texts: Record<string, string> = {
      'real-note':
        'We decided to migrate the authentication layer to Supabase because of built-in RLS support. ' +
        'The decision was made after evaluating Auth0, Clerk, and Supabase in a spike during week 22.',
      'episodic-good':
        'During the architecture review we discovered that the pagerank seeds were causing a cache ' +
        'invalidation bug on cold starts. Fixed by adding the cwd to the cache key.',
      'episodic-short-low': 'build ok',
      'build-noise':
        '1. lint-step\n2. typecheck-step\n3. build-step\n4. test-step\n5. deploy-step\n6. verify-step',
      'agent-meta':
        'This is an automated run of a scheduled task. The user is not present to answer questions.',
      'episodic-rich':
        'The Supabase migration completed successfully after adding the UNIQUE constraint on user_id. ' +
        'We also added an index on created_at to speed up the timeline query. ' +
        'The RLS policy now correctly scopes all reads to the authenticated user session.',
      // Banner-delimited diagnostic stdout + dense JSON stats dump, no prose.
      'shell-dump':
        '=== brain path / stats === BRAIN_PATH=/var/data/brain ' +
        '{ "window_hours": 24, "totals": { "notes_total": 3354, "notes_active": 3354, "notes_invalidated": 0 }, ' +
        '"by_type": [ { "type": "episodic", "n": 2172 }, { "type": "reference", "n": 960 } ] }',
      // A diagnostic banner but the body is a real prose conclusion (must be KEPT).
      'real-with-banner':
        '=== migration check === We decided to add a UNIQUE constraint on the email column ' +
        'because concurrent signups were creating duplicate user records in production. ' +
        'The fix uses Supabase upsert semantics and was verified against the staging dataset.',
    };
    return texts[id] ?? '';
  }),
  listAll: vi.fn(() => []),
  notesMentioningEntity: vi.fn(() => []),
  recordAccessMany: vi.fn(),
}));

vi.mock('../../util/telemetry.js', () => ({
  logTelemetry: vi.fn(),
  nowIso: vi.fn(() => new Date().toISOString()),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hit(id: string, score: number): ResolvedHit {
  return { id, path: `notes/${id}.html`, score, level: 'L2' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyNoisePenalty', () => {
  it('demotes a build-output note below a real decision note', () => {
    const hits = [hit('build-noise', 0.8), hit('real-note', 0.7)];
    const result = applyNoisePenalty(hits);
    const ids = result.map((h) => h.id);
    expect(ids[0]).toBe('real-note');
    expect(ids[1]).toBe('build-noise');
  });

  it('demotes an agent-meta note below a real decision note', () => {
    const hits = [hit('agent-meta', 0.85), hit('real-note', 0.6)];
    const result = applyNoisePenalty(hits);
    const ids = result.map((h) => h.id);
    expect(ids[0]).toBe('real-note');
    expect(ids[1]).toBe('agent-meta');
  });

  it('demotes a very short low-importance episodic note', () => {
    // 'episodic-short-low' has type=episodic, importance=0.05, text="build ok" (2 words < 12)
    const hits = [hit('episodic-short-low', 0.9), hit('real-note', 0.5)];
    const result = applyNoisePenalty(hits);
    const ids = result.map((h) => h.id);
    expect(ids[0]).toBe('real-note');
    expect(ids[1]).toBe('episodic-short-low');
  });

  it('demotes a shell-diagnostic JSON-dump note below a real decision note', () => {
    // 'shell-dump' is a banner-delimited JSON stats dump with no prose — even
    // with a higher BM25 score it must rank below the genuine decision note.
    const hits = [hit('shell-dump', 0.9), hit('real-note', 0.6)];
    const result = applyNoisePenalty(hits);
    const ids = result.map((h) => h.id);
    expect(ids[0]).toBe('real-note');
    expect(ids[1]).toBe('shell-dump');
  });

  it('does NOT penalize a real note that has a "===" banner but real prose (anti-regression)', () => {
    // 'real-with-banner' has a diagnostic banner AND a JSON-ish mention but the
    // body is a substantive decision paragraph — it must NOT be demoted.
    const hits = [hit('real-with-banner', 0.7), hit('real-note', 0.5)];
    const result = applyNoisePenalty(hits);
    expect(result[0].id).toBe('real-with-banner');
    expect(result[0].score).toBeCloseTo(0.7, 5);
  });

  it('applies NOISE_PENALTY_FACTOR=0.25 to noise note score', () => {
    const hits = [hit('build-noise', 0.8)];
    const result = applyNoisePenalty(hits);
    expect(result[0].score).toBeCloseTo(0.8 * 0.25, 5);
  });

  it('does NOT penalize a genuine episodic note with rich content', () => {
    // 'episodic-good' has type=episodic but importance=0.8 and has substantive text
    const hits = [hit('real-note', 0.6), hit('episodic-good', 0.8)];
    const result = applyNoisePenalty(hits);
    expect(result[0].id).toBe('episodic-good');
    expect(result[0].score).toBeCloseTo(0.8, 5);
  });

  it('does NOT penalize an episodic note with low importance but rich content', () => {
    // 'episodic-rich' has importance=0.15 (<0.2) but text has 50+ words (>= 12)
    const hits = [hit('episodic-rich', 0.75), hit('real-note', 0.5)];
    const result = applyNoisePenalty(hits);
    expect(result[0].id).toBe('episodic-rich');
    expect(result[0].score).toBeCloseTo(0.75, 5);
  });

  it('returns a new array (immutability)', () => {
    const hits = [hit('real-note', 0.7)];
    const result = applyNoisePenalty(hits);
    expect(result).not.toBe(hits);
    expect(result[0]).not.toBe(hits[0]);
  });

  it('returns empty array unchanged', () => {
    expect(applyNoisePenalty([])).toEqual([]);
  });

  it('handles a note with no FTS record gracefully (no crash)', () => {
    const hits = [hit('unknown-note-xyz', 0.5)];
    expect(() => applyNoisePenalty(hits)).not.toThrow();
    expect(applyNoisePenalty(hits)[0].score).toBeCloseTo(0.5, 5);
  });
});
