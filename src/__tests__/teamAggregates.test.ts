/**
 * teamAggregates.test.ts — unit tests for the team cockpit KPI rollup
 * (src/lib/teams/teamAggregates.ts, spec §13). The module had zero test
 * coverage before this file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsTauri, mockCanUseTeamSearch } = vi.hoisted(() => ({
  mockIsTauri: vi.fn(),
  mockCanUseTeamSearch: vi.fn(),
}));

vi.mock('../lib/platform', () => ({
  isTauri: () => mockIsTauri(),
}));

vi.mock('../lib/entitlements/unifiedEntitlement', () => ({
  getEntitlements: () => ({ features: { canUseTeamSearch: mockCanUseTeamSearch() } }),
}));

const mockFleetKpis = vi.fn();
vi.mock('../lib/journal/projections', () => ({
  queryFleetOverview: () => mockFleetKpis(),
}));

const mockJournalQuery = vi.fn();
vi.mock('../lib/journal/journal', () => ({
  journalQuery: (filter: { types: string[] }) => mockJournalQuery(filter),
}));

import {
  computeTeamAggregates,
  computeTeamHealthScore,
  type TeamCockpitData,
} from '../lib/teams/teamAggregates';

function fleetKpi(overrides: Partial<{
  project_id: string;
  running: number;
  queued: number;
  review: number;
  done: number;
  failed: number;
  total_cost_usd: number;
  total_tokens: number;
}> = {}) {
  return {
    project_id: 'proj-1',
    running: 1,
    queued: 2,
    review: 0,
    done: 5,
    failed: 1,
    total_cost_usd: 1.5,
    total_tokens: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsTauri.mockReturnValue(true);
  mockCanUseTeamSearch.mockReturnValue(true);
  mockFleetKpis.mockResolvedValue([]);
  mockJournalQuery.mockResolvedValue([]);
});

describe('computeTeamAggregates — entitlement/platform gates', () => {
  it('returns null when the Pro/team entitlement is not active', async () => {
    mockCanUseTeamSearch.mockReturnValue(false);
    const result = await computeTeamAggregates();
    expect(result).toBeNull();
  });

  it('returns null outside Tauri', async () => {
    mockIsTauri.mockReturnValue(false);
    const result = await computeTeamAggregates();
    expect(result).toBeNull();
  });
});

describe('computeTeamAggregates — rollup math', () => {
  it('sums fleet KPIs into team-wide totals', async () => {
    mockFleetKpis.mockResolvedValue([
      fleetKpi({ project_id: 'a', running: 1, done: 5, failed: 1, total_cost_usd: 1.5, total_tokens: 1000 }),
      fleetKpi({ project_id: 'b', running: 2, done: 3, failed: 0, total_cost_usd: 0.5, total_tokens: 500 }),
    ]);

    const result = await computeTeamAggregates();

    expect(result).not.toBeNull();
    expect(result!.team.totalProjects).toBe(2);
    expect(result!.team.totalRunning).toBe(3);
    expect(result!.team.totalDone).toBe(8);
    expect(result!.team.totalFailed).toBe(1);
    expect(result!.team.totalCostUsd).toBeCloseTo(2.0);
    expect(result!.team.totalTokens).toBe(1500);
  });

  it('counts brain/sync journal events into the team totals', async () => {
    mockJournalQuery.mockImplementation((filter: { types: string[] }) => {
      const counts: Record<string, number> = {
        'brain.promoted': 3,
        'brain.decision_hit': 2,
        'teams.push': 4,
        'teams.pull': 1,
      };
      const n = counts[filter.types[0]] ?? 0;
      return Promise.resolve(Array.from({ length: n }, () => ({})));
    });

    const result = await computeTeamAggregates();

    expect(result!.team.neuronsPromoted).toBe(3);
    expect(result!.team.decisionsAutoAnswered).toBe(2);
    expect(result!.team.syncPushes).toBe(4);
    expect(result!.team.syncPulls).toBe(1);
  });

  it('degrades to zeroed brain/sync counts when journal queries fail', async () => {
    mockJournalQuery.mockRejectedValue(new Error('journal unavailable'));

    const result = await computeTeamAggregates();

    expect(result!.team.neuronsPromoted).toBe(0);
    expect(result!.team.decisionsAutoAnswered).toBe(0);
    expect(result!.team.syncPushes).toBe(0);
    expect(result!.team.syncPulls).toBe(0);
  });

  it('builds a per-member aggregate for each org member', async () => {
    mockFleetKpis.mockResolvedValue([fleetKpi()]);

    const result = await computeTeamAggregates({
      members: [
        { id: 'u1', name: 'Alice', role: 'org-admin', deptId: 'eng' },
        { id: 'u2', name: 'Bob', role: 'member' },
      ],
    });

    expect(result!.members).toHaveLength(2);
    expect(result!.members[0]).toMatchObject({ memberId: 'u1', memberName: 'Alice', department: 'eng' });
    expect(result!.members[1]).toMatchObject({ memberId: 'u2', memberName: 'Bob', department: undefined });
    expect(result!.team.totalMembers).toBe(2);
  });

  it('rolls up members into department aggregates, defaulting to "unassigned"', async () => {
    mockFleetKpis.mockResolvedValue([fleetKpi({ done: 2, failed: 1, total_cost_usd: 1, total_tokens: 100 })]);

    const result = await computeTeamAggregates({
      members: [
        { id: 'u1', name: 'Alice', role: 'org-admin', deptId: 'eng' },
        { id: 'u2', name: 'Bob', role: 'member', deptId: 'eng' },
        { id: 'u3', name: 'Cleo', role: 'member' },
      ],
    });

    const eng = result!.departments.find((d) => d.departmentId === 'eng');
    const unassigned = result!.departments.find((d) => d.departmentId === 'unassigned');

    expect(eng?.members).toBe(2);
    expect(eng?.done).toBe(4); // 2 members x 2 done each (all-projects-count-per-member simplification)
    expect(unassigned?.members).toBe(1);
  });
});

describe('computeTeamHealthScore', () => {
  function baseData(overrides: Partial<TeamCockpitData['team']> = {}): TeamCockpitData {
    return {
      team: {
        totalMembers: 1,
        totalProjects: 1,
        totalRunning: 0,
        totalQueued: 0,
        totalReview: 0,
        totalDone: 0,
        totalFailed: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        neuronsPromoted: 0,
        decisionsAutoAnswered: 0,
        syncPushes: 0,
        syncPulls: 0,
        ...overrides,
      },
      members: [],
      departments: [],
    };
  }

  it('returns 100 when there is no settled mission yet (done + failed === 0)', () => {
    expect(computeTeamHealthScore(baseData())).toBe(100);
  });

  it('returns 100 for an all-success, no-review, zero-cost team', () => {
    const score = computeTeamHealthScore(baseData({ totalDone: 10, totalFailed: 0 }));
    expect(score).toBe(100);
  });

  it('penalizes failures, review backlog, and cost together', () => {
    // successRate = (5/10)*40 = 20; reviewPenalty = min(2*5,30) = 10 -> 30-10=20;
    // costPenalty = min(2*10,30) = 20 -> 30-20=10; total = 20+20+10 = 50
    const score = computeTeamHealthScore(
      baseData({ totalDone: 5, totalFailed: 5, totalReview: 2, totalCostUsd: 2 }),
    );
    expect(score).toBe(50);
  });

  it('never returns a negative score even under heavy penalties', () => {
    const score = computeTeamHealthScore(
      baseData({ totalDone: 0, totalFailed: 10, totalReview: 50, totalCostUsd: 50 }),
    );
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
