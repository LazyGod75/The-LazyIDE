/* teamAggregates.ts — Team cockpit aggregate KPIs (spec §13).

   Rolls up fleet KPIs across team members and projects into team-level
   aggregates for the cockpit view. Builds on the existing per-project
   fleet overview (T2.0) and adds team-specific dimensions:

   1. Per-member aggregates: missions, cost, tokens per team member
   2. Per-department aggregates: rollup by department
   3. Team-wide totals: overall fleet health
   4. Cross-project brain metrics: neurons, decisions, promotions

   All aggregates are derived from the journal fleet overview + the
   org context. No new Rust commands needed — this is pure TS-side
   aggregation over existing projections.
*/

import { isTauri } from '../platform/index.js';
import { getEntitlements } from '../entitlements/unifiedEntitlement.js';
import { queryFleetOverview } from '../journal/projections.js';
import { journalQuery } from '../journal/journal.js';

// ── Types ───────────────────────────────────────────────────────────

export interface MemberAggregate {
  memberId: string;
  memberName: string;
  role: string;
  department?: string;
  projects: number;
  running: number;
  queued: number;
  review: number;
  done: number;
  failed: number;
  totalCostUsd: number;
  totalTokens: number;
}

export interface DepartmentAggregate {
  departmentId: string;
  departmentName: string;
  members: number;
  projects: number;
  running: number;
  done: number;
  failed: number;
  totalCostUsd: number;
  totalTokens: number;
}

export interface TeamAggregate {
  totalMembers: number;
  totalProjects: number;
  totalRunning: number;
  totalQueued: number;
  totalReview: number;
  totalDone: number;
  totalFailed: number;
  totalCostUsd: number;
  totalTokens: number;
  neuronsPromoted: number;
  decisionsAutoAnswered: number;
  syncPushes: number;
  syncPulls: number;
}

export interface TeamCockpitData {
  team: TeamAggregate;
  members: MemberAggregate[];
  departments: DepartmentAggregate[];
}

// ── Aggregation ────────────────────────────────────────────────────

/**
 * Compute team cockpit aggregates from fleet KPIs + journal events.
 *
 * Gated by the Pro entitlement — only Pro and Pro+ users see team aggregates.
 * Returns null when not entitled or not in Tauri mode.
 */
export async function computeTeamAggregates(
  orgContext?: { members: Array<{ id: string; name: string; role: string; deptId?: string }> },
): Promise<TeamCockpitData | null> {
  const ents = getEntitlements();
  if (!ents.features.canUseTeamSearch) {
    return null;
  }

  if (!isTauri()) {
    return null;
  }

  // 1. Get fleet overview (per-project KPIs)
  const fleetKpis = await queryFleetOverview();

  // 2. Compute team-wide totals
  const teamTotals = fleetKpis.reduce(
    (acc, kpi) => ({
      totalRunning: acc.totalRunning + kpi.running,
      totalQueued: acc.totalQueued + kpi.queued,
      totalReview: acc.totalReview + kpi.review,
      totalDone: acc.totalDone + kpi.done,
      totalFailed: acc.totalFailed + kpi.failed,
      totalCostUsd: acc.totalCostUsd + kpi.total_cost_usd,
      totalTokens: acc.totalTokens + kpi.total_tokens,
    }),
    {
      totalRunning: 0,
      totalQueued: 0,
      totalReview: 0,
      totalDone: 0,
      totalFailed: 0,
      totalCostUsd: 0,
      totalTokens: 0,
    },
  );

  // 3. Query journal for brain/sync metrics
  let neuronsPromoted = 0;
  let decisionsAutoAnswered = 0;
  let syncPushes = 0;
  let syncPulls = 0;

  try {
    const promotedEvents = await journalQuery({
      types: ['brain.promoted'],
      limit: 100,
    });
    neuronsPromoted = promotedEvents.length;

    const decisionEvents = await journalQuery({
      types: ['brain.decision_hit'],
      limit: 100,
    });
    decisionsAutoAnswered = decisionEvents.length;

    const pushEvents = await journalQuery({
      types: ['teams.push'],
      limit: 100,
    });
    syncPushes = pushEvents.length;

    const pullEvents = await journalQuery({
      types: ['teams.pull'],
      limit: 100,
    });
    syncPulls = pullEvents.length;
  } catch {
    // Journal queries are best-effort
  }

  // 4. Build per-member aggregates
  const members: MemberAggregate[] = [];
  if (orgContext?.members) {
    for (const member of orgContext.members) {
      // Assign projects to members (simplified: all projects count for each member
      // in the absence of per-member project attribution in the journal)
      const memberKpis = fleetKpis; // In production, filter by member's projects
      const agg = memberKpis.reduce(
        (acc, kpi) => ({
          running: acc.running + kpi.running,
          queued: acc.queued + kpi.queued,
          review: acc.review + kpi.review,
          done: acc.done + kpi.done,
          failed: acc.failed + kpi.failed,
          totalCostUsd: acc.totalCostUsd + kpi.total_cost_usd,
          totalTokens: acc.totalTokens + kpi.total_tokens,
        }),
        {
          running: 0,
          queued: 0,
          review: 0,
          done: 0,
          failed: 0,
          totalCostUsd: 0,
          totalTokens: 0,
        },
      );

      members.push({
        memberId: member.id,
        memberName: member.name,
        role: member.role,
        department: member.deptId,
        projects: memberKpis.length,
        ...agg,
      });
    }
  }

  // 5. Build per-department aggregates
  const deptMap = new Map<string, DepartmentAggregate>();
  for (const member of members) {
    const deptId = member.department ?? 'unassigned';
    const existing = deptMap.get(deptId) ?? {
      departmentId: deptId,
      departmentName: deptId,
      members: 0,
      projects: 0,
      running: 0,
      done: 0,
      failed: 0,
      totalCostUsd: 0,
      totalTokens: 0,
    };

    existing.members++;
    existing.running += member.running;
    existing.done += member.done;
    existing.failed += member.failed;
    existing.totalCostUsd += member.totalCostUsd;
    existing.totalTokens += member.totalTokens;
    existing.projects = Math.max(existing.projects, member.projects);
    deptMap.set(deptId, existing);
  }

  return {
    team: {
      totalMembers: members.length,
      totalProjects: fleetKpis.length,
      ...teamTotals,
      neuronsPromoted,
      decisionsAutoAnswered,
      syncPushes,
      syncPulls,
    },
    members,
    departments: Array.from(deptMap.values()),
  };
}

/**
 * Get a simplified team health score (0-100) from the aggregate data.
 * Weighted: 40% mission success rate, 30% review backlog, 30% cost efficiency.
 */
export function computeTeamHealthScore(data: TeamCockpitData): number {
  const total = data.team.totalDone + data.team.totalFailed;
  if (total === 0) return 100;

  const successRate = (data.team.totalDone / total) * 40;
  const reviewPenalty = Math.min(data.team.totalReview * 5, 30);
  const costPenalty = Math.min(data.team.totalCostUsd * 10, 30);

  return Math.round(Math.max(0, successRate + (30 - reviewPenalty) + (30 - costPenalty)));
}
