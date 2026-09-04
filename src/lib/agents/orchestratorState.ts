/* orchestratorState.ts — Persisted orchestrator state (Pillar A/B).
   Orchestrators are plans spanning multiple missions. This module provides
   CRUD + persistence in `.lazy/orchestrators.json` inside each project root.
*/

import { joinPath } from '../paths.js';
import { getPlatform } from '../platform/index.js';
import { isMissingFileReadError } from '../fsErrors.js';
import type { OrchestratorState, OrchestratorPlanStep, OrchestratorPlanStepInput } from './types.js';

// ── Constants ─────────────────────────────────────────────────────

const ORCHESTRATORS_FILE = 'orchestrators.json';
const ORCHESTRATORS_DIR = '.lazy';

// ── Helpers ───────────────────────────────────────────────────────

function orchestratorsPath(projectRoot: string): string {
  return joinPath(projectRoot, ORCHESTRATORS_DIR, ORCHESTRATORS_FILE);
}

function generateId(): string {
  return `orch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateStepId(orchestratorId: string, index: number): string {
  return `${orchestratorId}-step-${index}`;
}

// ── Persistence ───────────────────────────────────────────────────

async function loadOrchestratorsJson(projectRoot: string): Promise<OrchestratorState[]> {
  try {
    const path = orchestratorsPath(projectRoot);
    const raw = await getPlatform().fs.readFile(path);
    // Strip a UTF-8 BOM if present — a file touched by a tool that wrote a
    // BOM (PowerShell, some editors) would otherwise fail JSON.parse and
    // silently lose the whole orchestrator state.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed as OrchestratorState[];
  } catch (err) {
    // A project that has never had an orchestrator created has no
    // `.lazy/orchestrators.json` at all — that is the NORMAL state, not a
    // failure, and must not be logged. The previous check matched English
    // phrases ('cannot find', 'No such file', 'not find') against the raw
    // read_file rejection, but that text embeds the OS's own LOCALIZED
    // error message (e.g. French Windows: "Le fichier spécifié est
    // introuvable. (os error 2)") — none of those English substrings ever
    // matched on a non-English OS, so this branch silently fell through to
    // the warn-and-return-empty case below on EVERY missing-file read,
    // flooding the console with a raw, non-English OS string that read as
    // a failure when it was nothing of the sort. isMissingFileReadError
    // (lib/fsErrors.ts) matches the locale-independent "(os error N)" code
    // Rust's own Display impl always appends, regardless of OS language.
    if (isMissingFileReadError(err)) return [];
    console.warn('[orchestratorState] load failed:', err);
    return [];
  }
}

async function saveOrchestratorsJson(projectRoot: string, orchestrators: OrchestratorState[]): Promise<void> {
  try {
    const path = orchestratorsPath(projectRoot);
    const fs = getPlatform().fs;
    try {
      await fs.createDir(joinPath(projectRoot, ORCHESTRATORS_DIR));
    } catch {
      // dir may already exist
    }
    await fs.writeFile(path, JSON.stringify(orchestrators, null, 2));
  } catch (err) {
    console.warn('[orchestratorState] save failed:', err);
  }
}

// ── CRUD ──────────────────────────────────────────────────────────

export interface CreateOrchestratorInput {
  projectRoot: string;
  projectId: string;
  name: string;
  objective: string;
  steps: OrchestratorPlanStepInput[];
  targetProjectIds?: string[];
  budgetLimitCents?: number;
  autonomyLevel?: 'manual' | 'supervised' | 'yolo' | 'custom';
  citedLessonIds?: string[];
}

export async function createOrchestrator(input: CreateOrchestratorInput): Promise<OrchestratorState> {
  const orchestrators = await loadOrchestratorsJson(input.projectRoot);
  const id = generateId();

  function resolveStepAutonomy(level?: 'manual' | 'supervised' | 'yolo' | 'custom'): 'manual' | 'supervised' | 'yolo' {
    if (level === 'manual') return 'manual';
    if (level === 'yolo') return 'yolo';
    return 'supervised';
  }

  const steps: OrchestratorPlanStep[] = input.steps.map((s, idx) => ({
    id: s.id ?? generateStepId(id, idx),
    description: s.description,
    status: 'pending',
    missionIds: [],
    dependsOn: s.dependsOn ?? [],
    autonomyLevel: resolveStepAutonomy(s.autonomyLevel ?? input.autonomyLevel),
    agentName: s.agentName,
    model: s.model,
    // modelId catalog wave (plan-first leg) — was missing from this explicit
    // field-by-field map (see OrchestratorPlanStepInput.modelId's doc
    // comment, types.ts): an exact catalog id set on a generate_plan step
    // silently never reached the persisted OrchestratorPlanStep at all,
    // even before compileOrchestrator/sgrOrchestratorRunner's own gap.
    modelId: s.modelId,
    // Cross-project READ access (plan-first leg, same wiring-gap class as
    // modelId's own comment above — a field forgotten in exactly this
    // explicit field-by-field map disappears silently, which is precisely
    // what already happened once with modelId): see
    // OrchestratorPlanStepInput.extraReadableProjectIds's doc comment
    // (types.ts) for the full thread from here through
    // compileOrchestrator.ts, sgrOrchestratorRunner.ts, and the SGR
    // launchMission dep (agentsStore.tsx), where declared ids/names are
    // finally resolved to real roots.
    extraReadableProjectIds: s.extraReadableProjectIds,
    baseBranch: s.baseBranch,
    effort: s.effort,
    engine: s.engine,
    budgetCapUsd: s.budgetCapUsd,
    maxDurationMs: s.maxDurationMs,
    scopePaths: s.scopePaths,
    proofs: s.proofs,
    contestN: s.contestN,
    critical: s.critical,
    role: s.role,
    onFail: s.onFail,
    maxAttempts: s.maxAttempts,
    joinGroup: s.joinGroup,
  }));

  const orchestrator: OrchestratorState = {
    id,
    name: input.name,
    projectId: input.projectId,
    targetProjectIds: input.targetProjectIds ?? [input.projectId],
    objective: input.objective,
    steps,
    currentStep: 0,
    status: 'planning',
    budget: { spentCents: 0, limitCents: input.budgetLimitCents },
    childMissionIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    autonomyLevel: input.autonomyLevel ?? 'supervised',
    citedLessonIds: input.citedLessonIds,
  };

  orchestrators.push(orchestrator);
  await saveOrchestratorsJson(input.projectRoot, orchestrators);
  return orchestrator;
}

/**
 * Transitive dependency closure: every id in `seedIds` plus every step any
 * seed (transitively) `dependsOn`. Pure, never mutates `steps`.
 *
 * Single source of truth for "which steps must run/materialize for this
 * seed set" — used by BOTH partial plan EXECUTION (agentsStore.tsx's
 * execute_plan handler) and partial plan MATERIALIZATION onto the canvas
 * (agentsStore.tsx's executePlan, before it calls execute_plan). Before this
 * helper existed, execute_plan recomputed its own closure from a SINGLE
 * `fromStep` seed while materialization recomputed the same shape from a
 * potentially MULTI-element `stepIds` set — the two could silently diverge
 * (a step accepted/materialized as active on the canvas, but never actually
 * executed, if it did not happen to be a transitive dependency of
 * `stepIds[0]`; see GraphProposalCard.tsx's checkbox partial-accept, which
 * can select several mutually-independent steps at once).
 */
export function closeStepDependencies(
  steps: readonly OrchestratorPlanStep[],
  seedIds: readonly string[],
): OrchestratorPlanStep[] {
  const allNeeded = new Set<string>(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (allNeeded.has(step.id)) {
        for (const dep of step.dependsOn) {
          if (!allNeeded.has(dep)) {
            allNeeded.add(dep);
            changed = true;
          }
        }
      }
    }
  }
  return steps.filter((s) => allNeeded.has(s.id));
}

export async function updateOrchestrator(
  projectRoot: string,
  orchestratorId: string,
  patch: Partial<OrchestratorState>,
): Promise<OrchestratorState | undefined> {
  const orchestrators = await loadOrchestratorsJson(projectRoot);
  const index = orchestrators.findIndex((o) => o.id === orchestratorId);
  if (index < 0) return undefined;

  orchestrators[index] = { ...orchestrators[index], ...patch, updatedAt: Date.now() };
  await saveOrchestratorsJson(projectRoot, orchestrators);
  return orchestrators[index];
}

export async function getOrchestrator(projectRoot: string, orchestratorId: string): Promise<OrchestratorState | undefined> {
  const orchestrators = await loadOrchestratorsJson(projectRoot);
  return orchestrators.find((o) => o.id === orchestratorId);
}

export async function saveOrchestratorState(projectRoot: string, orchestrator: OrchestratorState): Promise<void> {
  const orchestrators = await loadOrchestratorsJson(projectRoot);
  const index = orchestrators.findIndex((o) => o.id === orchestrator.id);
  if (index >= 0) {
    orchestrators[index] = { ...orchestrator, updatedAt: Date.now() };
  } else {
    orchestrators.push({ ...orchestrator, updatedAt: Date.now() });
  }
  await saveOrchestratorsJson(projectRoot, orchestrators);
}

export async function listOrchestrators(projectRoot: string): Promise<OrchestratorState[]> {
  return loadOrchestratorsJson(projectRoot);
}

export async function deleteOrchestrator(projectRoot: string, orchestratorId: string): Promise<boolean> {
  const orchestrators = await loadOrchestratorsJson(projectRoot);
  const next = orchestrators.filter((o) => o.id !== orchestratorId);
  if (next.length === orchestrators.length) return false;
  await saveOrchestratorsJson(projectRoot, next);
  return true;
}

// ── Step helpers ──────────────────────────────────────────────────

export async function updateOrchestratorStep(
  projectRoot: string,
  orchestratorId: string,
  stepId: string,
  patch: Partial<OrchestratorPlanStep>,
): Promise<OrchestratorState | undefined> {
  const orchestrators = await loadOrchestratorsJson(projectRoot);
  const orch = orchestrators.find((o) => o.id === orchestratorId);
  if (!orch) return undefined;

  const step = orch.steps.find((s) => s.id === stepId);
  if (!step) return undefined;

  Object.assign(step, patch);
  orch.updatedAt = Date.now();
  await saveOrchestratorsJson(projectRoot, orchestrators);
  return orch;
}

export async function appendMissionToStep(
  projectRoot: string,
  orchestratorId: string,
  stepId: string,
  missionId: string,
): Promise<OrchestratorState | undefined> {
  const orchestrators = await loadOrchestratorsJson(projectRoot);
  const orch = orchestrators.find((o) => o.id === orchestratorId);
  if (!orch) return undefined;

  const step = orch.steps.find((s) => s.id === stepId);
  if (!step) return undefined;

  if (!step.missionIds.includes(missionId)) {
    step.missionIds.push(missionId);
  }
  if (!orch.childMissionIds.includes(missionId)) {
    orch.childMissionIds.push(missionId);
  }
  orch.updatedAt = Date.now();
  await saveOrchestratorsJson(projectRoot, orchestrators);
  return orch;
}
