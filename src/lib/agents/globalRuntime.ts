/* globalRuntime.ts — Global Runtime Registry (Pillar A).
   Holds runtime state for ALL open projects so the orchestrator can manage
   them simultaneously without forcing a UI project switch.
*/

import type { Mission, LoopConfig, OrchestratorState } from './types.js';

// ── Types ─────────────────────────────────────────────────────────

export interface ProjectRuntimeState {
  projectId: string;
  projectRoot: string;
  projectName: string;
  missions: Mission[];
  loops: LoopConfig[];
  orchestrators: OrchestratorState[];
  budget: { spentCents: number; limitCents?: number };
  lastSyncAt: number;
}

export interface GlobalRuntimeSnapshot {
  projects: ProjectRuntimeState[];
  allMissions: Mission[];
  runningMissions: Mission[];
  blockedMissions: Mission[];
  recentOutcomes: Mission[];
}

type Listener = () => void;

// ── Module state ──────────────────────────────────────────────────

const projects = new Map<string, ProjectRuntimeState>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // listeners must not break the registry
    }
  }
}

// ── Project lifecycle ─────────────────────────────────────────────

export function registerProject(projectId: string, projectRoot: string, projectName: string): ProjectRuntimeState {
  const existing = projects.get(projectId);
  if (existing) {
    existing.projectRoot = projectRoot;
    existing.projectName = projectName;
    existing.lastSyncAt = Date.now();
    emit();
    return existing;
  }

  const state: ProjectRuntimeState = {
    projectId,
    projectRoot,
    projectName,
    missions: [],
    loops: [],
    orchestrators: [],
    budget: { spentCents: 0 },
    lastSyncAt: Date.now(),
  };
  projects.set(projectId, state);
  emit();
  return state;
}

export function unregisterProject(projectId: string): void {
  projects.delete(projectId);
  emit();
}

export function getProject(projectId: string): ProjectRuntimeState | undefined {
  return projects.get(projectId);
}

export function getAllProjects(): ProjectRuntimeState[] {
  return Array.from(projects.values());
}

// ── Mission accessors ─────────────────────────────────────────────

export function getAllMissions(): Mission[] {
  const result: Mission[] = [];
  for (const state of projects.values()) {
    result.push(...state.missions);
  }
  return result;
}

export function getRunningMissions(): Mission[] {
  return getAllMissions().filter((m) => m.status === 'running');
}

export function getBlockedMissions(): Mission[] {
  return getAllMissions().filter((m) => m.status === 'failed' || m.status === 'review');
}

export function findMissionById(missionId: string): Mission | undefined {
  for (const state of projects.values()) {
    const mission = state.missions.find((m) => m.id === missionId);
    if (mission) return mission;
  }
  return undefined;
}

export function findMissionProjectId(missionId: string): string | undefined {
  for (const state of projects.values()) {
    if (state.missions.some((m) => m.id === missionId)) {
      return state.projectId;
    }
  }
  return undefined;
}

// ── Mutations ─────────────────────────────────────────────────────

export function setProjectMissions(projectId: string, missions: Mission[]): void {
  const state = projects.get(projectId);
  if (!state) return;
  state.missions = missions;
  state.lastSyncAt = Date.now();
  emit();
}

export function updateMissionInRegistry(update: { id: string; patch: Partial<Mission> }): Mission | undefined {
  for (const state of projects.values()) {
    const index = state.missions.findIndex((m) => m.id === update.id);
    if (index >= 0) {
      const updated = { ...state.missions[index], ...update.patch };
      state.missions[index] = updated;
      state.lastSyncAt = Date.now();
      emit();
      return updated;
    }
  }
  return undefined;
}

export function addMissionToRegistry(projectId: string, mission: Mission): void {
  const state = projects.get(projectId);
  if (!state) return;
  state.missions.push(mission);
  state.lastSyncAt = Date.now();
  emit();
}

export function removeMissionFromRegistry(missionId: string): void {
  for (const state of projects.values()) {
    const index = state.missions.findIndex((m) => m.id === missionId);
    if (index >= 0) {
      state.missions.splice(index, 1);
      state.lastSyncAt = Date.now();
      emit();
      return;
    }
  }
}

// ── Loops & orchestrators ─────────────────────────────────────────

export function setProjectLoops(projectId: string, loops: LoopConfig[]): void {
  const state = projects.get(projectId);
  if (!state) return;
  state.loops = loops;
  state.lastSyncAt = Date.now();
  emit();
}

export function getAllLoops(): LoopConfig[] {
  const result: LoopConfig[] = [];
  for (const state of projects.values()) {
    result.push(...state.loops);
  }
  return result;
}

export function setProjectOrchestrators(projectId: string, orchestrators: OrchestratorState[]): void {
  const state = projects.get(projectId);
  if (!state) return;
  state.orchestrators = orchestrators;
  state.lastSyncAt = Date.now();
  emit();
}

export function getAllOrchestrators(): OrchestratorState[] {
  const result: OrchestratorState[] = [];
  for (const state of projects.values()) {
    result.push(...state.orchestrators);
  }
  return result;
}

export function findOrchestratorById(orchestratorId: string): OrchestratorState | undefined {
  for (const state of projects.values()) {
    const orch = state.orchestrators.find((o) => o.id === orchestratorId);
    if (orch) return orch;
  }
  return undefined;
}

// ── Budget ────────────────────────────────────────────────────────

export function addProjectSpend(projectId: string, cents: number): void {
  const state = projects.get(projectId);
  if (!state) return;
  state.budget.spentCents += cents;
  state.lastSyncAt = Date.now();
  emit();
}

export function setProjectBudget(projectId: string, limitCents?: number): void {
  const state = projects.get(projectId);
  if (!state) return;
  state.budget.limitCents = limitCents;
  state.lastSyncAt = Date.now();
  emit();
}

export function getGlobalBudget(): { spentCents: number; limitCents?: number } {
  let spent = 0;
  let limit: number | undefined;
  for (const state of projects.values()) {
    spent += state.budget.spentCents;
    if (state.budget.limitCents !== undefined) {
      limit = (limit ?? 0) + state.budget.limitCents;
    }
  }
  return { spentCents: spent, limitCents: limit };
}

// ── Snapshot ──────────────────────────────────────────────────────

export function getSnapshot(): GlobalRuntimeSnapshot {
  const allMissions = getAllMissions();
  return {
    projects: getAllProjects(),
    allMissions,
    runningMissions: allMissions.filter((m) => m.status === 'running'),
    blockedMissions: allMissions.filter((m) => m.status === 'failed' || m.status === 'review'),
    recentOutcomes: allMissions
      .filter((m) => m.status === 'done' || m.status === 'failed' || m.status === 'cancelled')
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 50),
  };
}

// ── Subscription ──────────────────────────────────────────────────

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Recovery ──────────────────────────────────────────────────────

/**
 * Mark running missions as interrupted after a crash, returning the list
 * so the boot flow can propose resuming them.
 */
export function markInterruptedAfterCrash(): Mission[] {
  const interrupted: Mission[] = [];
  for (const state of projects.values()) {
    for (let i = 0; i < state.missions.length; i += 1) {
      const mission = state.missions[i];
      if (mission.status === 'running') {
        const updated: Mission = { ...mission, status: 'failed', statusReason: 'interrupted_by_crash' };
        state.missions[i] = updated;
        interrupted.push(updated);
      }
    }
  }
  if (interrupted.length > 0) emit();
  return interrupted;
}
