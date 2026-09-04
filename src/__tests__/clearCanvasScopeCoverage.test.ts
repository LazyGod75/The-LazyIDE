/**
 * clearCanvasScopeCoverage.test.ts — coherence check between clear_canvas's
 * prompt-catalog claims (managerEngine.ts's item 52 + the CLEANUP SCOPE
 * HONESTY rule) and what `planClearCanvas` (agentsStore.tsx) actually does.
 *
 * P0 fix, real user test: the manager told the user a "terminated"/bulk
 * cleanup would archive missions "en revue" (review status) — the executor
 * silently excluded them (defensible: a review-status mission is awaiting a
 * human approve/reject decision, not finished) but NEVER SAID SO. A
 * follow-up explicit request to "archive toutes celles en revue" hit the
 * same silent exclusion and reported "rien à nettoyer" in front of 27
 * still-visible missions. This suite is the "for each documented scope,
 * prove the doc matches the executor" check that was missing: one test per
 * scope, asserting exactly which of a mixed-status/mixed-kind snapshot it
 * sweeps, that a 'review' mission is reported (never silently dropped) when
 * a scope leaves it behind, and that `includeReview` is the one explicit,
 * destructive-tier way to actually sweep it in.
 */

import { describe, it, expect } from 'vitest';
import {
  planClearCanvas,
  isTerminalMissionStatus,
  type ClearCanvasSnapshot,
} from '../components/agents/agentsStore';
import type { Mission } from '../lib/agents/types';

const NOW_MS = 1_000_000_000_000;

function mission(id: string, status: Mission['status'], overrides: Partial<Mission> = {}): Mission {
  return { id, title: `Mission ${id}`, status, model: 'sonnet', ...overrides };
}

/** One of every mission status, plus one node of every other canvas kind —
 *  the fixture every scope is checked against, so a scope's real behavior
 *  and its documented behavior are compared against the exact SAME data. */
function buildSnapshot(missions: Mission[]): ClearCanvasSnapshot {
  return {
    missions,
    drafts: [{ id: 'd1', title: 'Draft 1', task: 'do the thing', createdBy: 'user' }],
    notes: [{ id: 'n1', text: 'a note' }],
    surfaces: [{ id: 's1', kind: 'terminal' }],
    routers: [{ id: 'r1', branches: [{ id: 'b1', label: 'x', condition: { kind: 'default' } }] }],
    joins: [{ id: 'j1', sourceRefs: [], mode: 'all_success' }],
    frames: [{ id: 'f1', title: 'Group', width: 100, height: 100 }],
  };
}

const ALL_STATUSES: Mission['status'][] = ['queued', 'running', 'review', 'done', 'failed', 'cancelled'];

function fullMissionSet(): Mission[] {
  return ALL_STATUSES.map((status) => mission(`M-${status}`, status));
}

function plan(scope: string, missions: Mission[], opts: Partial<Parameters<typeof planClearCanvas>[2]> = {}) {
  return planClearCanvas(scope, buildSnapshot(missions), {
    mode: 'archive',
    nowMs: NOW_MS,
    ...opts,
  });
}

describe('clear_canvas scope coverage — doc says / executor does, cross-checked', () => {
  it('isTerminalMissionStatus is exactly done/failed/cancelled — review is deliberately excluded', () => {
    expect(isTerminalMissionStatus('done')).toBe(true);
    expect(isTerminalMissionStatus('failed')).toBe(true);
    expect(isTerminalMissionStatus('cancelled')).toBe(true);
    expect(isTerminalMissionStatus('review')).toBe(false);
    expect(isTerminalMissionStatus('queued')).toBe(false);
    expect(isTerminalMissionStatus('running')).toBe(false);
  });

  describe('scope "terminated" — doc: "missions only (done/failed/cancelled), NEVER review"', () => {
    it('sweeps exactly the 3 terminal missions, never review/queued/running, never a draft/note/etc', () => {
      const result = plan('terminated', fullMissionSet());
      expect(result.missionIds.sort()).toEqual(['M-cancelled', 'M-done', 'M-failed'].sort());
      expect(result.draftIds).toEqual([]);
      expect(result.noteIds).toEqual([]);
      expect(result.surfaceRefs).toEqual([]);
      expect(result.routerIds).toEqual([]);
      expect(result.joinIds).toEqual([]);
      expect(result.frameIds).toEqual([]);
    });

    it('reports the excluded review mission honestly (never a silent drop)', () => {
      const result = plan('terminated', fullMissionSet());
      expect(result.reviewExcludedIds).toEqual(['M-review']);
    });

    it('includeReview:true sweeps the review mission in AND clears the excluded-notice', () => {
      const result = plan('terminated', fullMissionSet(), { includeReview: true });
      expect(result.missionIds.sort()).toEqual(['M-cancelled', 'M-done', 'M-failed', 'M-review'].sort());
      expect(result.reviewExcludedIds).toEqual([]);
    });

    it('an already-archived review mission is never counted as "left behind" either (invisible on the board already)', () => {
      const missions = [mission('M-review', 'review', { archived: true }), mission('M-done', 'done')];
      const result = plan('terminated', missions);
      expect(result.reviewExcludedIds).toEqual([]);
    });

    // BUG 4 fix (dogfood 2026-08-05): the approval card can honestly promise
    // "includeReview: true" (see describePendingAction's own
    // "y compris les missions en revue" label) while `olderThanHours`
    // STILL silently excludes a too-recent review mission from the actual
    // sweep — before this fix, reviewExcludedIds was unconditionally `[]`
    // whenever includeReview was true, so that exclusion carried NO signal
    // at all: the label promised the sweep, the executor could report
    // "rien à nettoyer" (or a partial count) with zero explanation for the
    // missing review mission. reviewExcludedIds is now derived from the
    // actual sweep outcome, not from includeReview alone, so label and
    // behavior can never silently disagree.
    it('includeReview:true does NOT silently swallow a review mission excluded by olderThanHours — it is reported, not dropped', () => {
      // isOlderThanHours treats a missing createdAt as "never old enough"
      // (honest exclusion, see its own doc comment) — every mission here
      // needs an explicit createdAt once olderThanHours is in play, or it
      // would be excluded for the wrong reason.
      const oldDone = mission('M-done', 'done', { createdAt: NOW_MS - 48 * 60 * 60 * 1000 }); // 48h old
      const recentReview = mission('M-review', 'review', { createdAt: NOW_MS - 1 * 60 * 60 * 1000 }); // 1h old
      const result = plan('terminated', [recentReview, oldDone], {
        includeReview: true,
        olderThanHours: 24,
      });
      // Too recent for the 24h floor — genuinely NOT swept in...
      expect(result.missionIds).toEqual(['M-done']);
      // ...but honestly reported as left behind, never silently dropped.
      expect(result.reviewExcludedIds).toEqual(['M-review']);
    });

    it('includeReview:true DOES sweep in a review mission that also satisfies olderThanHours, with no excluded-notice', () => {
      const oldDone = mission('M-done', 'done', { createdAt: NOW_MS - 48 * 60 * 60 * 1000 }); // 48h old
      const oldReview = mission('M-review', 'review', { createdAt: NOW_MS - 48 * 60 * 60 * 1000 }); // 48h old
      const result = plan('terminated', [oldReview, oldDone], {
        includeReview: true,
        olderThanHours: 24,
      });
      expect(result.missionIds.sort()).toEqual(['M-done', 'M-review'].sort());
      expect(result.reviewExcludedIds).toEqual([]);
    });
  });

  describe('scope "failed" — doc: "just failed", review was never in play here', () => {
    it('sweeps ONLY the failed mission, never done/cancelled/review', () => {
      const result = plan('failed', fullMissionSet());
      expect(result.missionIds).toEqual(['M-failed']);
    });

    it('never reports a review-excluded notice for this scope (it was never promised)', () => {
      const result = plan('failed', fullMissionSet());
      expect(result.reviewExcludedIds).toEqual([]);
    });

    it('includeReview:true has NO effect on "failed" — a review mission is not "failed"', () => {
      const result = plan('failed', fullMissionSet(), { includeReview: true });
      expect(result.missionIds).toEqual(['M-failed']);
      expect(result.reviewExcludedIds).toEqual([]);
    });
  });

  describe('scope "all" — doc: every kind + every terminal mission, never review', () => {
    it('sweeps every non-mission kind plus the 3 terminal missions', () => {
      const result = plan('all', fullMissionSet());
      expect(result.missionIds.sort()).toEqual(['M-cancelled', 'M-done', 'M-failed'].sort());
      expect(result.draftIds).toEqual(['d1']);
      expect(result.noteIds).toEqual(['n1']);
      expect(result.surfaceRefs).toEqual([{ id: 's1', kind: 'terminal' }]);
      expect(result.routerIds).toEqual(['r1']);
      expect(result.joinIds).toEqual(['j1']);
      expect(result.frameIds).toEqual(['f1']);
    });

    it('reports the excluded review mission honestly', () => {
      const result = plan('all', fullMissionSet());
      expect(result.reviewExcludedIds).toEqual(['M-review']);
    });

    it('includeReview:true sweeps the review mission in too', () => {
      const result = plan('all', fullMissionSet(), { includeReview: true });
      expect(result.missionIds).toContain('M-review');
      expect(result.reviewExcludedIds).toEqual([]);
    });
  });

  describe('scope "project" — doc: same as "all", narrowed to one project zone', () => {
    it('narrows drafts/notes/surfaces/routers/joins/frames to the target project, same mission coverage as "all"', () => {
      const snapshot = buildSnapshot(fullMissionSet());
      const scoped: ClearCanvasSnapshot = {
        ...snapshot,
        drafts: [...snapshot.drafts, { id: 'd2', title: 'Draft 2', task: 'x', createdBy: 'user', projectId: 'proj-a' }],
      };
      const result = planClearCanvas('project', scoped, { mode: 'archive', projectId: 'proj-a', nowMs: NOW_MS });
      expect(result.draftIds).toEqual(['d2']);
      expect(result.missionIds.sort()).toEqual(['M-cancelled', 'M-done', 'M-failed'].sort());
      expect(result.reviewExcludedIds).toEqual(['M-review']);
    });
  });

  describe('kind-only scopes ("drafts"/"notes"/"surfaces") — doc: that ONE kind, no mission of any status', () => {
    it('scope "drafts" never touches missions and never reports a review-excluded notice', () => {
      const result = plan('drafts', fullMissionSet());
      expect(result.draftIds).toEqual(['d1']);
      expect(result.missionIds).toEqual([]);
      expect(result.reviewExcludedIds).toEqual([]);
    });

    it('scope "notes" never touches missions', () => {
      const result = plan('notes', fullMissionSet());
      expect(result.noteIds).toEqual(['n1']);
      expect(result.missionIds).toEqual([]);
      expect(result.reviewExcludedIds).toEqual([]);
    });

    it('scope "surfaces" never touches missions', () => {
      const result = plan('surfaces', fullMissionSet());
      expect(result.surfaceRefs).toEqual([{ id: 's1', kind: 'terminal' }]);
      expect(result.missionIds).toEqual([]);
      expect(result.reviewExcludedIds).toEqual([]);
    });

    it('includeReview:true is a harmless no-op on a kind-only scope', () => {
      const result = plan('drafts', fullMissionSet(), { includeReview: true });
      expect(result.missionIds).toEqual([]);
      expect(result.reviewExcludedIds).toEqual([]);
    });
  });

  describe('scope "selection" — doc: exactly the named refs, whatever their status', () => {
    it('sweeps a review-status mission when its ref is explicitly named (explicit intent, not a silent default)', () => {
      const result = plan('selection', fullMissionSet(), { refs: ['mission:M-review'] });
      expect(result.missionIds).toEqual(['M-review']);
    });

    it('never emits a review-excluded notice — an explicit selection has nothing "left behind" by definition', () => {
      const result = plan('selection', fullMissionSet(), { refs: ['mission:M-done'] });
      expect(result.reviewExcludedIds).toEqual([]);
    });
  });

  describe('unknown scope — defense in depth', () => {
    it('reports unknownScope and touches nothing, including no review-excluded notice', () => {
      const result = plan('bogus-scope', fullMissionSet());
      expect(result.unknownScope).toBe('bogus-scope');
      expect(result.missionIds).toEqual([]);
      expect(result.draftIds).toEqual([]);
      expect(result.reviewExcludedIds).toEqual([]);
    });
  });
});
