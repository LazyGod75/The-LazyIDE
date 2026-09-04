import { describe, it, expect } from 'vitest';
import {
  classifyUrgent,
  rankUrgentMissions,
  countPendingDecisions,
  sortMissionsForColumn,
  formatElapsed,
  modelFamily,
  countActiveByModelFamily,
  deriveProjectPills,
  nextModelTierLabel,
  urgentActionsFor,
} from '../components/agents/cockpit/cockpitHelpers';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Test mission',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: 0,
    urgent: false,
    ...overrides,
  };
}

function project(missions: FleetMission[], overrides: Partial<FleetProject> = {}): FleetProject {
  return {
    projectId: 'p1',
    root: '/p1',
    name: 'p1',
    missions,
    ...overrides,
  };
}

describe('classifyUrgent', () => {
  it('classifies a pending-question mission as permission, even if status is running', () => {
    expect(classifyUrgent(mission({ status: 'running', pendingQuestion: 'Overwrite auth.rs?' }))).toBe(
      'permission',
    );
  });

  it('classifies a failed mission as failed', () => {
    expect(classifyUrgent(mission({ status: 'failed' }))).toBe('failed');
  });

  it('classifies a review mission as review', () => {
    expect(classifyUrgent(mission({ status: 'review' }))).toBe('review');
  });

  it('returns null for a plain running mission with no pending question', () => {
    expect(classifyUrgent(mission({ status: 'running' }))).toBeNull();
  });

  it('returns null for queued/done missions', () => {
    expect(classifyUrgent(mission({ status: 'queued' }))).toBeNull();
    expect(classifyUrgent(mission({ status: 'done' }))).toBeNull();
  });
});

// ── urgentActionsFor (QA B15 — moved from ProjectRow.tsx for testability) ──

describe('urgentActionsFor', () => {
  const t = (key: string) => key;

  it('permission kind offers deny-replan (solid) + allow-once', () => {
    const actions = urgentActionsFor({ mission: mission({ status: 'running', pendingQuestion: 'q?' }), kind: 'permission', t, forceApprove: false });
    expect(actions.map((a) => a.key)).toEqual(['deny-replan', 'allow-once']);
    expect(actions[0]!.solid).toBe(true);
  });

  it('failed kind offers promote (solid) + logs', () => {
    const actions = urgentActionsFor({ mission: mission({ status: 'failed' }), kind: 'failed', t, forceApprove: false });
    expect(actions.map((a) => a.key)).toEqual(['promote', 'logs']);
    expect(actions[0]!.solid).toBe(true);
  });

  it('review kind (verdict still pending, no judgeVerdict) offers only merge + diff, no promote', () => {
    const actions = urgentActionsFor({ mission: mission({ status: 'review' }), kind: 'review', t, forceApprove: false });
    expect(actions.map((a) => a.key)).toEqual(['merge', 'diff']);
  });

  it('review kind with an APPROVED verdict still offers only merge + diff, no promote', () => {
    const rejected = mission({
      status: 'review',
      judgeVerdict: { score: 91, passed: true, risk: 'low', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z' },
    });
    const actions = urgentActionsFor({ mission: rejected, kind: 'review', t, forceApprove: false });
    expect(actions.map((a) => a.key)).toEqual(['merge', 'diff']);
  });

  it('review kind with a REJECTED verdict (QA B15) additionally offers promote', () => {
    const rejected = mission({
      status: 'review',
      judgeVerdict: { score: 12, passed: false, risk: 'high', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z' },
    });
    const actions = urgentActionsFor({ mission: rejected, kind: 'review', t, forceApprove: false });
    expect(actions.map((a) => a.key)).toEqual(['merge', 'diff', 'promote']);
    // The extra promote action is secondary, not solid — merge stays the primary CTA.
    expect(actions[2]!.solid).toBeFalsy();
  });

  it('review kind shows forceMerge label once forceApprove is true, rejected verdict or not', () => {
    const rejected = mission({
      status: 'review',
      judgeVerdict: { score: 12, passed: false, risk: 'high', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z' },
    });
    const actions = urgentActionsFor({ mission: rejected, kind: 'review', t, forceApprove: true });
    expect(actions[0]).toEqual({ key: 'merge', label: 'cockpit.action.forceMerge', solid: true });
  });
});

describe('rankUrgentMissions / countPendingDecisions', () => {
  it('ranks permission before failed before review, oldest first within a kind', () => {
    const projects: FleetProject[] = [
      project(
        [
          mission({ id: 'review-old', status: 'review', updatedMs: 100 }),
          mission({ id: 'failed-1', status: 'failed', updatedMs: 300 }),
          mission({ id: 'permission-1', status: 'running', pendingQuestion: 'q?', updatedMs: 500 }),
          mission({ id: 'review-new', status: 'review', updatedMs: 400 }),
        ],
        { projectId: 'proj-a' },
      ),
    ];
    const ranked = rankUrgentMissions(projects);
    expect(ranked.map((r) => r.mission.id)).toEqual(['permission-1', 'failed-1', 'review-old', 'review-new']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('countPendingDecisions matches rankUrgentMissions length (single source of truth)', () => {
    const projects: FleetProject[] = [
      project([mission({ status: 'failed' }), mission({ status: 'running' })], { projectId: 'a' }),
      project([mission({ status: 'review' })], { projectId: 'b' }),
    ];
    expect(countPendingDecisions(projects)).toBe(rankUrgentMissions(projects).length);
    expect(countPendingDecisions(projects)).toBe(2);
  });

  it('returns 0 for an empty fleet', () => {
    expect(countPendingDecisions([])).toBe(0);
  });
});

describe('sortMissionsForColumn', () => {
  it('orders urgent first, then running, then done/other, then queued last', () => {
    const missions = [
      mission({ id: 'queued', status: 'queued', updatedMs: 1 }),
      mission({ id: 'running', status: 'running', updatedMs: 1 }),
      mission({ id: 'failed', status: 'failed', updatedMs: 1 }),
      mission({ id: 'done', status: 'done', updatedMs: 1 }),
    ];
    const sorted = sortMissionsForColumn(missions);
    expect(sorted.map((m) => m.id)).toEqual(['failed', 'running', 'done', 'queued']);
  });
});

describe('formatElapsed', () => {
  it('formats under a minute as "à l\'instant" (no t: original French fallback)', () => {
    expect(formatElapsed(0, undefined, 30_000)).toBe("à l'instant");
  });

  it('formats minutes (no t: original French fallback)', () => {
    expect(formatElapsed(0, undefined, 18 * 60_000)).toBe('18 min');
  });

  it('formats hours (no t: original French fallback)', () => {
    expect(formatElapsed(0, undefined, 2 * 3_600_000)).toBe('2 h');
  });

  it('formats days (no t: original French fallback)', () => {
    expect(formatElapsed(0, undefined, 3 * 86_400_000)).toBe('3 j');
  });

  it('translates via t when supplied', () => {
    const t = (key: string, params?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        'cockpit.elapsed.justNow': 'just now',
        'cockpit.elapsed.minutesAgo': `${params?.count} min`,
        'cockpit.elapsed.hoursAgo': `${params?.count} h`,
        'cockpit.elapsed.daysAgo': `${params?.count} d`,
      };
      return dict[key] ?? key;
    };
    expect(formatElapsed(0, t, 30_000)).toBe('just now');
    expect(formatElapsed(0, t, 18 * 60_000)).toBe('18 min');
    expect(formatElapsed(0, t, 2 * 3_600_000)).toBe('2 h');
    expect(formatElapsed(0, t, 3 * 86_400_000)).toBe('3 d');
  });
});

describe('modelFamily / countActiveByModelFamily', () => {
  it('classifies model strings case-insensitively', () => {
    expect(modelFamily('Sonnet 4.6')).toBe('sonnet');
    expect(modelFamily('haiku-4.5')).toBe('haiku');
    expect(modelFamily('anthropic/claude-opus-4.5')).toBe('opus');
    expect(modelFamily('gpt-4o')).toBe('other');
  });

  it('counts only running missions by default, grouped by family', () => {
    const projects: FleetProject[] = [
      project(
        [
          mission({ status: 'running', model: 'sonnet 4.6' }),
          mission({ status: 'running', model: 'haiku 4.5' }),
          mission({ status: 'queued', model: 'sonnet 4.6' }),
          mission({ status: 'running', model: 'opus 4.5' }),
        ],
        { projectId: 'a' },
      ),
    ];
    expect(countActiveByModelFamily(projects)).toEqual({ sonnet: 1, haiku: 1, opus: 1, other: 0 });
  });
});

describe('nextModelTierLabel', () => {
  it('promotes haiku to sonnet', () => {
    expect(nextModelTierLabel('haiku 4.5')).toBe('Sonnet 4.6');
  });

  it('promotes sonnet (or anything else) to opus', () => {
    expect(nextModelTierLabel('sonnet 4.6')).toBe('Opus 4.5');
    expect(nextModelTierLabel('gpt-4o')).toBe('Opus 4.5');
  });
});

describe('deriveProjectPills', () => {
  it('flags urgent when any mission needs a decision', () => {
    const projects: FleetProject[] = [project([mission({ status: 'failed' })], { projectId: 'a', name: 'a' })];
    expect(deriveProjectPills(projects)).toEqual([{ projectId: 'a', name: 'a', state: 'urgent' }]);
  });

  it('flags active when running/queued but nothing urgent', () => {
    const projects: FleetProject[] = [project([mission({ status: 'running' })], { projectId: 'a', name: 'a' })];
    expect(deriveProjectPills(projects)).toEqual([{ projectId: 'a', name: 'a', state: 'active' }]);
  });

  it('flags idle when no active mission at all', () => {
    const projects: FleetProject[] = [project([mission({ status: 'done' })], { projectId: 'a', name: 'a' })];
    expect(deriveProjectPills(projects)).toEqual([{ projectId: 'a', name: 'a', state: 'idle' }]);
  });
});
