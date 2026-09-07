/* budgetTracker.ts — Real-time budget enforcement (Pillar A).
   Tracks spend per mission, project, and globally. Emits events when
   thresholds are crossed so the runtime and UI can react.
*/

import { emitEvent } from '../journal/journal.js';
import type { JournalEventInput } from '../journal/eventTypes.js';
import { emitIfOverThreshold } from './budgetThreshold.js';

// ── Types ─────────────────────────────────────────────────────────

export interface BudgetState {
  spentCents: number;
  limitCents?: number;
}

export interface MissionBudget extends BudgetState {
  missionId: string;
}

export interface ProjectBudget extends BudgetState {
  projectId: string;
}

// ── Module state ──────────────────────────────────────────────────

const missionBudgets = new Map<string, MissionBudget>();
const projectBudgets = new Map<string, ProjectBudget>();
let globalLimitCents: number | undefined;
let globalSpentCents = 0;
const listeners = new Set<() => void>();

/** Session ledger ids for costStore.addUsage → spend() (not a real mission). */
const USAGE_LEDGER_ID = '__usage__';

/** Fractional-cent accumulator for recordUsageSpendCents. costStore feeds
 *  UNROUNDED cents (usd * 100) per call; cheap calls (e.g. $0.004 = 0.4¢)
 *  would otherwise round to 0 and evaporate — 1000 × $0.004 recorded 0¢
 *  instead of 400¢. We bank the remainder here and only book whole cents
 *  to spend(), so sub-cent spend accumulates across calls. */
let _usageSpendCentsAccum = 0;

function notifyBudget(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* listeners must not break the tracker */ }
  }
}

export function subscribeBudget(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── Budget lifecycle ──────────────────────────────────────────────

export function setMissionLimit(missionId: string, limitCents?: number): void {
  const existing = missionBudgets.get(missionId) ?? { missionId, spentCents: 0 };
  existing.limitCents = limitCents;
  missionBudgets.set(missionId, existing);
}

export function setProjectLimit(projectId: string, limitCents?: number): void {
  const existing = projectBudgets.get(projectId) ?? { projectId, spentCents: 0 };
  existing.limitCents = limitCents;
  projectBudgets.set(projectId, existing);
}

export function setGlobalLimit(limitCents?: number): void {
  globalLimitCents = limitCents;
}

function emitJournalBudgetEvent(
  type: 'budget.warning' | 'budget.exceeded',
  projectId: string,
  missionId: string,
  capUsd: number,
  spentUsd: number,
  pct: number,
): void {
  const event = {
    type,
    tsMs: Date.now(),
    projectId,
    missionId,
    actor: 'manager' as const,
    payload: { capUsd, spentUsd, pct },
  } as JournalEventInput;
  void emitEvent(event);
}

export function spend(missionId: string, projectId: string, cents: number): void {
  const mission = missionBudgets.get(missionId) ?? { missionId, spentCents: 0 };
  mission.spentCents += cents;
  missionBudgets.set(missionId, mission);

  const project = projectBudgets.get(projectId) ?? { projectId, spentCents: 0 };
  project.spentCents += cents;
  projectBudgets.set(projectId, project);

  globalSpentCents += cents;

  checkThresholds(mission, project, projectId, missionId);
  notifyBudget();
}

function checkThresholds(mission: MissionBudget, project: ProjectBudget, projectId: string, missionId: string): void {
  const emit = (
    kind: 'budget.warning' | 'budget.exceeded',
    capUsd: number,
    spentUsd: number,
    pct: number,
  ) => emitJournalBudgetEvent(kind, projectId, missionId, capUsd, spentUsd, pct);
  emitIfOverThreshold(mission.spentCents, mission.limitCents, emit);
  emitIfOverThreshold(project.spentCents, project.limitCents, emit);
  emitIfOverThreshold(globalSpentCents, globalLimitCents, emit);
}

// ── Queries ───────────────────────────────────────────────────────

export function getMissionBudget(missionId: string): MissionBudget {
  return missionBudgets.get(missionId) ?? { missionId, spentCents: 0 };
}

export function getProjectBudget(projectId: string): ProjectBudget {
  return projectBudgets.get(projectId) ?? { projectId, spentCents: 0 };
}

export function getGlobalBudget(): BudgetState {
  return { spentCents: globalSpentCents, limitCents: globalLimitCents };
}

/** Fold durable usageHistory cost into the live tracker. Uses max() so a
 *  concurrent live spend() is never clobbered by a stale hydrate. */
export function hydrateGlobalSpentCents(historyCents: number): void {
  if (!Number.isFinite(historyCents) || historyCents < 0) return;
  const next = Math.max(globalSpentCents, Math.round(historyCents));
  if (next === globalSpentCents) return;
  globalSpentCents = next;
  notifyBudget();
}

/** Record settled USD from costStore.addUsage on the session ledger.
 *  Accepts UNROUNDED cents (usd * 100); fractional cents accumulate in
 *  _usageSpendCentsAccum and only whole cents are booked to spend(), so a
 *  stream of sub-cent calls (e.g. 1000 × $0.004) converges to the correct
 *  total instead of rounding each call down to 0. */
export function recordUsageSpendCents(cents: number): void {
  if (!Number.isFinite(cents) || cents <= 0) return;
  _usageSpendCentsAccum += cents;
  // Floor with a tiny epsilon to absorb float drift (e.g. 399.9999999999
  // → 400) without ever crossing a real integer boundary.
  const whole = Math.floor(_usageSpendCentsAccum + 1e-9);
  if (whole <= 0) return;
  _usageSpendCentsAccum -= whole;
  spend(USAGE_LEDGER_ID, USAGE_LEDGER_ID, whole);
}

export function _resetBudgetTrackerForTests(): void {
  missionBudgets.clear();
  projectBudgets.clear();
  globalLimitCents = undefined;
  globalSpentCents = 0;
  _usageSpendCentsAccum = 0;
  listeners.clear();
}

export function isOverBudget(missionId: string, projectId: string): boolean {
  const mission = getMissionBudget(missionId);
  if (mission.limitCents !== undefined && mission.spentCents >= mission.limitCents) return true;
  const project = getProjectBudget(projectId);
  if (project.limitCents !== undefined && project.spentCents >= project.limitCents) return true;
  if (globalLimitCents !== undefined && globalSpentCents >= globalLimitCents) return true;
  return false;
}

/**
 * YOLO hard stop: returns true when spend has reached 120% of the limit.
 * In YOLO mode the manager runs freely within budget, but this gate
 * enforces a hard ceiling so a runaway loop can never spend unbounded.
 */
export function isOverYoloHardStop(missionId: string, projectId: string): boolean {
  const mission = getMissionBudget(missionId);
  if (mission.limitCents !== undefined && mission.spentCents >= mission.limitCents * 1.2) return true;
  const project = getProjectBudget(projectId);
  if (project.limitCents !== undefined && project.spentCents >= project.limitCents * 1.2) return true;
  if (globalLimitCents !== undefined && globalSpentCents >= globalLimitCents * 1.2) return true;
  return false;
}

/**
 * Returns true when the requested extra spend would push any budget over
 * its limit. Used by the scheduler before launching a mission.
 */
export function wouldExceedBudget(missionId: string, projectId: string, extraCents: number): boolean {
  const mission = getMissionBudget(missionId);
  if (mission.limitCents !== undefined && mission.spentCents + extraCents > mission.limitCents) return true;
  const project = getProjectBudget(projectId);
  if (project.limitCents !== undefined && project.spentCents + extraCents > project.limitCents) return true;
  if (globalLimitCents !== undefined && globalSpentCents + extraCents > globalLimitCents) return true;
  return false;
}

/**
 * Estimate the cost of a planned mission in cents. Returns 0 when no
 * estimate can be produced (caller decides how to handle that).
 */
export function estimateMissionCostCents(_model: string, expectedTurns = 10): number {
  // Placeholder: real pricing should come from costStore/model catalog.
  // 1 cent per turn is a conservative low bound for display/ordering.
  return Math.max(1, expectedTurns);
}
