/* loopEngine.ts — Persistent loop scheduling for recurring missions.
   Stores loop configs to .lazy/loops.json, computes next-run times,
   and provides a tick() function that the scheduler calls periodically.

   Loops survive app restarts: on load, persisted loops are re-registered
   and their next-run times are computed from lastRunAt + cadence.
*/

import type { LoopCadence, LoopConfig, LoopStopCondition, Mission } from './types.js';
import type { PermissionMode } from './runtime.js';
import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { recordApproval, recordFailure } from './loopGate.js';

export type { LoopRegimeState } from './loopGate.js';

// ── Constants ──────────────────────────────────────────────────────

const LOOPS_FILE = '.lazy/loops.json';
const LOOPS_VERSION = '1.0.0';
const LOOP_STATE_FILE = '.lazy/loop-state.json';

const CADENCE_MS: Record<string, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

/** Parse a cadence string into milliseconds.
 *  Supports predefined values (1m, 5m, 15m, 1h, 6h, 1d) and arbitrary
 *  second-based values like "30s", "90s", "120s", or plain numbers (seconds).
 *  Arbitrary minute/hour/day values (e.g. "3m") are NOT supported — only the
 *  fixed preset set above plus seconds. Anything else falls back to 5min. */
export function parseCadenceMs(cadence: string): number {
  const predefined = CADENCE_MS[cadence];
  if (predefined !== undefined) return predefined;
  const match = cadence.match(/^(\d+)\s*(s|sec|secs|seconds?)$/i);
  if (match) return parseInt(match[1], 10) * 1000;
  // Plain number = seconds. Must match the ENTIRE (trimmed) string — using
  // parseInt() alone would silently accept "3m" as 3 (three seconds) instead
  // of falling through to the "unrecognized" fallback below.
  const trimmed = cadence.trim();
  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    if (num > 0) return num * 1000;
  }
  // Fallback: 5 minutes
  return 5 * 60 * 1000;
}

// ── Types ──────────────────────────────────────────────────────────

export interface PersistedLoop {
  missionId: string;
  title: string;
  agentName?: string;
  agentTask: string;
  model?: string;
  /**
   * Permission mode carried to every spawned iteration mission. Without this,
   * loop children ran with permissionMode undefined -> runtime.ts's 'default'
   * -> the native CLI stalls on an interactive approval prompt that never
   * appears in-app ("AWAITING PERMISSION" forever). Defaults to 'acceptEdits'
   * at registration time — the same default NewMissionModal uses.
   */
  permissionMode?: PermissionMode;
  loopConfig: LoopConfig;
  createdAt: string;
}

/** Resolves which loopArtifact.ts owner id a loop's frozen artifact lives
 *  under (spec §4 gate 1 — "figé une seule fois ... jamais régénéré").
 *  `loopConfig.templateArtifactRef` is the CANONICAL, charter-carried
 *  reference (types.ts: "opaque string ... this module does not own
 *  artifact storage" — loopArtifact.ts is that storage); falls back to the
 *  loop's own `missionId` when absent, which is what a loop that froze its
 *  OWN artifact (the common case, no separate one-time validation mission)
 *  naturally resolves to. */
export function artifactOwnerIdForLoop(loop: Pick<PersistedLoop, 'missionId' | 'loopConfig'>): string {
  return loop.loopConfig.templateArtifactRef ?? loop.missionId;
}

export interface LoopsState {
  loops: PersistedLoop[];
  version: string;
}

/**
 * Trust-critical defect #2 — why tick() refused to fire/kept a loop and
 * disabled it instead, one code per distinct guard:
 *   - 'stale_registry'    — the ORIGINAL zombie-loop belt-and-suspenders:
 *                           the tracked mission already reached 'done' or
 *                           was archived (the real fix lives at the
 *                           mission-terminal choke points themselves —
 *                           agentsStore.tsx's approveMission/archiveMission/
 *                           deleteMission — this only catches a registry a
 *                           build predating that fix left behind, or a race).
 *   - 'mission_failed'    — the tracked mission ended 'failed' or
 *                           'cancelled'. NEW: before this fix, only done/
 *                           archived were ever recognized as terminal here,
 *                           so a loop tracking a FAILED anchor mission
 *                           stayed `enabled` forever and kept being
 *                           eligible to fire on every cadence tick — real
 *                           QA capture: "Mission M1 — itération 20/19/…/4",
 *                           all fired while M1 itself sat failed. Re-firing
 *                           the identical failing thing is never the
 *                           answer without a change of input.
 *   - 'hard_iteration_cap'— HARD_ITERATION_CAP reached, a SYSTEM-enforced
 *                           ceiling independent of the loop's own
 *                           stopCondition (whose default, 'manual', has NO
 *                           user-configured limit at all) — a
 *                           runaway-impossible backstop.
 *   - 'repeated_failures' — CONSECUTIVE_FAILURE_LIMIT consecutive failed
 *                           iterations, caught HERE at the actual firing
 *                           decision (not only by fleetHygiene.ts's
 *                           planLoopSupervision's separate, best-effort
 *                           periodic sweep, which could be minutes away).
 */
export type LoopStopReason = 'stale_registry' | 'mission_failed' | 'hard_iteration_cap' | 'repeated_failures';

export interface LoopTickResult {
  loopsToFire: PersistedLoop[];
  /**
   * ZOMBIE LOOP fix (belt-and-suspenders) + trust-critical defect #2's
   * runaway guards: loops that were still `enabled` but that tick() refused
   * to fire and disabled right here instead — see LoopStopReason for the
   * distinct reason each entry's `stopReason` carries. Conservative by
   * design: a mission this function cannot find in `missions` (e.g. the
   * caller passed none) is left alone — never a false positive, same
   * "only act on what's actually proven" rule shouldStopLoop's own
   * stop-condition checks already follow.
   */
  loopsAutoDisabled: Array<PersistedLoop & { stopReason: LoopStopReason }>;
}

// ── Loop State (durable memory between iterations) ─────────────────

export interface LoopState {
  [missionId: string]: {
    lastIteration: number;
    lastResult: string;
    lastFilesCreated: string[];
    lastTimestamp: string;
    history: { iteration: number; result: string; timestamp: string }[];
  };
}

async function readLoopState(repoPath: string): Promise<LoopState> {
  const platform = getPlatform();
  if (!platform?.fs) return {};
  try {
    const raw = await platform.fs.readFile(joinPath(repoPath, LOOP_STATE_FILE));
    return JSON.parse(raw) as LoopState;
  } catch {
    return {};
  }
}

async function writeLoopState(repoPath: string, state: LoopState): Promise<void> {
  const platform = getPlatform();
  if (!platform?.fs) return;
  try {
    // joinPath (not a hardcoded '/') — see missionQueue.ts's writeQueue for
    // the full Windows verbatim-path bug-class rationale (paths.ts header).
    await platform.fs.createDir(joinPath(repoPath, '.lazy'));
    await platform.fs.writeFile(joinPath(repoPath, LOOP_STATE_FILE), JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[loopEngine] Failed to persist loop state:', err);
  }
}

/** Read the state for a specific loop (what previous iterations did). */
export async function getLoopState(repoPath: string, missionId: string): Promise<LoopState[string] | null> {
  const state = await readLoopState(repoPath);
  return state[missionId] ?? null;
}

/** Update the state after an iteration completes. */
export async function updateLoopState(
  repoPath: string,
  missionId: string,
  iteration: number,
  result: string,
  filesCreated: string[] = [],
): Promise<void> {
  const state = await readLoopState(repoPath);
  const existing = state[missionId];
  const history = existing?.history ?? [];
  history.push({ iteration, result: result.slice(0, 200), timestamp: new Date().toISOString() });
  state[missionId] = {
    lastIteration: iteration,
    lastResult: result.slice(0, 500),
    lastFilesCreated: filesCreated,
    lastTimestamp: new Date().toISOString(),
    history: history.slice(-20), // keep last 20 iterations
  };
  await writeLoopState(repoPath, state);
}

// ── Persistence ────────────────────────────────────────────────────

async function readLoops(repoPath: string): Promise<LoopsState> {
  const platform = getPlatform();
  if (!platform?.fs) return { loops: [], version: LOOPS_VERSION };

  try {
    const raw = await platform.fs.readFile(joinPath(repoPath, LOOPS_FILE));
    return JSON.parse(raw) as LoopsState;
  } catch {
    return { loops: [], version: LOOPS_VERSION };
  }
}

async function writeLoops(repoPath: string, state: LoopsState): Promise<void> {
  const platform = getPlatform();
  if (!platform?.fs) return;

  try {
    // joinPath (not a hardcoded '/') — see missionQueue.ts's writeQueue for
    // the full Windows verbatim-path bug-class rationale (paths.ts header).
    await platform.fs.createDir(joinPath(repoPath, '.lazy'));
    await platform.fs.writeFile(joinPath(repoPath, LOOPS_FILE), JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[loopEngine] Failed to persist loops:', err);
  }
}

// ── Public API ─────────────────────────────────────────────────────

/** Create a default loop config for a new loop mission. */
export function createLoopConfig(
  cadence: LoopCadence,
  stopCondition?: LoopStopCondition,
): LoopConfig {
  const now = Date.now();
  return {
    cadence,
    stopCondition: stopCondition ?? { kind: 'manual' },
    enabled: true,
    nextRunAt: new Date(now + parseCadenceMs(cadence)).toISOString(),
    iterationCount: 0,
    iterationMissionIds: [],
  };
}

/** Register a new loop and persist it. */
export async function registerLoop(
  repoPath: string,
  loop: Omit<PersistedLoop, 'createdAt'>,
): Promise<PersistedLoop> {
  const state = await readLoops(repoPath);
  const entry: PersistedLoop = {
    ...loop,
    createdAt: new Date().toISOString(),
  };
  // Remove any existing loop with the same missionId
  state.loops = state.loops.filter((l) => l.missionId !== loop.missionId);
  state.loops.push(entry);
  await writeLoops(repoPath, state);
  return entry;
}

/** Remove a loop by mission id. */
export async function unregisterLoop(repoPath: string, missionId: string): Promise<void> {
  const state = await readLoops(repoPath);
  state.loops = state.loops.filter((l) => l.missionId !== missionId);
  await writeLoops(repoPath, state);
}

/** Update a loop's config (e.g. enable/disable, change cadence). */
export async function updateLoop(
  repoPath: string,
  missionId: string,
  patch: Partial<PersistedLoop>,
): Promise<void> {
  const state = await readLoops(repoPath);
  const idx = state.loops.findIndex((l) => l.missionId === missionId);
  if (idx >= 0) {
    state.loops[idx] = { ...state.loops[idx], ...patch };
    await writeLoops(repoPath, state);
  }
}

/** List all persisted loops. */
export async function listLoops(repoPath: string): Promise<PersistedLoop[]> {
  const state = await readLoops(repoPath);
  return state.loops;
}

/** Load all loops on app startup and recompute next-run times. */
export async function loadLoopsOnStartup(repoPath: string): Promise<PersistedLoop[]> {
  const state = await readLoops(repoPath);
  const now = Date.now();
  let changed = false;

  for (const loop of state.loops) {
    if (!loop.loopConfig.enabled) continue;

    // If the loop was due while the app was closed, schedule it for immediate
    // execution on next tick by setting nextRunAt to now.
    const nextRun = loop.loopConfig.nextRunAt
      ? new Date(loop.loopConfig.nextRunAt).getTime()
      : 0;

    if (nextRun > 0 && nextRun < now) {
      loop.loopConfig.nextRunAt = new Date(now).toISOString();
      changed = true;
    }
  }

  if (changed) {
    await writeLoops(repoPath, state);
  }

  return state.loops;
}

// ── Trust-critical defect #2 — runaway-impossible guards ────────────
//
// Real QA capture: "Mission M1 — itération 20", "itération 19", …
// "itération 4" — all stamped the SAME second, while M1 (the loop's own
// anchor mission) sat in a terminal `failed` state. Root causes fixed
// below: tick() only ever recognized 'done'/archived as terminal (never
// 'failed'), so a loop tracking a failed mission stayed enabled forever;
// markIterationFired always advanced nextRunAt by the SAME fixed cadence
// regardless of outcome (no backoff); and no ceiling existed independent of
// the loop's own (optional, default 'manual' = unlimited) stopCondition.

/** Absolute floor on the delay between two iterations of the SAME loop,
 *  regardless of how small a user-configured cadence resolves to
 *  (parseCadenceMs accepts arbitrary seconds, e.g. "1s" = 1000ms) — "a
 *  minimum delay between iterations" enforced here rather than trusted to
 *  whatever cadence string a loop happens to carry. */
export const MIN_ITERATION_DELAY_MS = 5_000;

/** System-enforced ceiling on total iterations a loop may ever fire,
 *  independent of the loop's own stopCondition — whose default kind,
 *  'manual', carries NO user-configured limit at all. A real recurring
 *  loop that has fired this many iterations has certainly stopped being
 *  useful; re-enabling it is then an explicit human decision, never
 *  something the scheduler keeps doing unattended forever. */
export const HARD_ITERATION_CAP = 500;

/** How many consecutive FAILED iterations (the loop's own children, most
 *  recent first) before tick() refuses to fire another one and disables
 *  the loop instead — same threshold and rationale as loopSupervision.ts's
 *  REPEATED_FAILURE_THRESHOLD, checked independently HERE, at the actual
 *  firing decision, so the guard trips immediately rather than waiting for
 *  a separate best-effort periodic sweep (which could be minutes away —
 *  see agentsStore.tsx's runLoopSupervisionSweep) to catch up. */
export const CONSECUTIVE_FAILURE_LIMIT = 3;

/**
 * Current consecutive-failure streak for a loop's own iteration children
 * (most recent iteration first). A non-failed iteration anywhere in the
 * streak resets the count to 0 from that point outward (only the TRAILING
 * run of failures counts) — one bad run is noise, several in a row with no
 * success between them is a real pattern worth stopping for. Pure — no I/O.
 */
export function consecutiveLoopFailures(missions: readonly Mission[], loopMissionId: string): number {
  const iterations = missions
    .filter((m): m is Mission & { loopIteration: number } => m.loopParentId === loopMissionId && typeof m.loopIteration === 'number')
    .sort((a, b) => b.loopIteration - a.loopIteration);
  let count = 0;
  for (const m of iterations) {
    if (m.status !== 'failed') break;
    count += 1;
  }
  return count;
}

// ── Stop condition evaluation ──────────────────────────────────────

/** Check if a loop should stop based on its stop condition. */
export function shouldStopLoop(
  loop: PersistedLoop,
  completedMissions: Mission[],
): boolean {
  const { stopCondition } = loop.loopConfig;
  const iterations = completedMissions.filter(
    (m) => m.loopParentId === loop.missionId,
  );

  switch (stopCondition.kind) {
    case 'manual':
      return false;
    case 'maxIterations':
      return loop.loopConfig.iterationCount >= stopCondition.count;
    case 'untilDate':
      return Date.now() >= new Date(stopCondition.date).getTime();
    case 'untilPass': {
      const lastIteration = iterations[iterations.length - 1];
      if (!lastIteration?.judgeVerdict) return false;
      return (
        lastIteration.judgeVerdict.passed &&
        lastIteration.judgeVerdict.score >= stopCondition.minScore
      );
    }
    default:
      return false;
  }
}

// ── Tick: check which loops are due to fire ────────────────────────

/**
 * Check all enabled loops and return those due for execution.
 *
 * `missions` (optional, default `[]`) is the current mission list — passed
 * so this can defensively catch a loop whose OWN tracked mission already
 * went terminal (done/archived) but is still sitting `enabled: true` in the
 * registry (see LoopTickResult.loopsAutoDisabled's doc comment for why this
 * belt exists alongside the real fix). Omitted/empty is always safe: no
 * mission is ever found in an empty list, so nothing is ever
 * false-positively disabled — callers that don't track missions (or existing
 * tests) see byte-identical behavior to before this parameter existed.
 */
export async function tick(repoPath: string, missions: readonly Mission[] = []): Promise<LoopTickResult> {
  const state = await readLoops(repoPath);
  const now = Date.now();
  const due: PersistedLoop[] = [];
  const autoDisabled: Array<PersistedLoop & { stopReason: LoopStopReason }> = [];
  const missionById = new Map(missions.map((m) => [m.id, m] as const));

  for (const loop of state.loops) {
    if (!loop.loopConfig.enabled) continue;

    const mission = missionById.get(loop.missionId);

    // Ordered by specificity: a proven terminal status on the anchor
    // mission itself always wins over the count-based guards below (it is
    // the more informative diagnosis — same "one reason wins" convention
    // loopSupervision.ts's planLoopSupervision already follows).
    let stopReason: LoopStopReason | null = null;
    if (mission && (mission.status === 'done' || mission.archived === true)) {
      stopReason = 'stale_registry';
    } else if (mission && (mission.status === 'failed' || mission.status === 'cancelled')) {
      // Trust-critical defect #2's direct fix: refuse to re-enter a loop
      // whose body is in a terminal failed state without a change of
      // input — see this module's own header comment for the real QA
      // capture this reproduces.
      stopReason = 'mission_failed';
    } else if (loop.loopConfig.iterationCount >= HARD_ITERATION_CAP) {
      stopReason = 'hard_iteration_cap';
    } else if (consecutiveLoopFailures(missions, loop.missionId) >= CONSECUTIVE_FAILURE_LIMIT) {
      stopReason = 'repeated_failures';
    }

    if (stopReason) {
      await disableLoop(repoPath, loop.missionId);
      autoDisabled.push({ ...loop, stopReason });
      continue;
    }

    const nextRun = loop.loopConfig.nextRunAt
      ? new Date(loop.loopConfig.nextRunAt).getTime()
      : 0;

    if (nextRun > 0 && nextRun <= now) {
      due.push(loop);
    }
  }

  return { loopsToFire: due, loopsAutoDisabled: autoDisabled };
}

/**
 * Mark a loop iteration as fired and schedule the next run.
 *
 * `missions` (optional, default `[]`) feeds the minimum-delay + exponential
 * backoff guard (trust-critical defect #2): `failureStreak` is the
 * CONSECUTIVE-failure count computed from the PREVIOUS iterations only
 * (this new one hasn't been counted anywhere yet), so a healthy loop
 * (streak 0) schedules its next run exactly `cadence` away — byte-identical
 * to this function's behavior before this fix. A loop whose most recent
 * iteration(s) failed gets pushed further out each time (cadence *
 * 2^streak, floored at MIN_ITERATION_DELAY_MS) instead of being retried at
 * the SAME cadence as a healthy run — tick()'s own CONSECUTIVE_FAILURE_LIMIT
 * check disables the loop entirely once the streak would go further still,
 * so backoff only ever needs to cover streak values below that limit.
 */
export async function markIterationFired(
  repoPath: string,
  missionId: string,
  childMissionId: string,
  missions: readonly Mission[] = [],
): Promise<void> {
  const state = await readLoops(repoPath);
  const idx = state.loops.findIndex((l) => l.missionId === missionId);
  if (idx < 0) return;

  const loop = state.loops[idx];
  const now = Date.now();
  loop.loopConfig.lastRunAt = new Date(now).toISOString();
  loop.loopConfig.iterationCount += 1;
  loop.loopConfig.iterationMissionIds = [
    ...loop.loopConfig.iterationMissionIds,
    childMissionId,
  ];

  const failureStreak = consecutiveLoopFailures(missions, missionId);
  const backoffMultiplier = 2 ** Math.min(failureStreak, CONSECUTIVE_FAILURE_LIMIT);
  const baseDelayMs = Math.max(parseCadenceMs(loop.loopConfig.cadence), MIN_ITERATION_DELAY_MS);
  loop.loopConfig.nextRunAt = new Date(now + baseDelayMs * backoffMultiplier).toISOString();

  state.loops[idx] = loop;
  await writeLoops(repoPath, state);
}

/** Disable a loop (stops scheduling new iterations). */
export async function disableLoop(repoPath: string, missionId: string): Promise<void> {
  await updateLoop(repoPath, missionId, {
    loopConfig: {
      ...(await getLoop(repoPath, missionId))?.loopConfig ?? createLoopConfig('1h'),
      enabled: false,
      nextRunAt: undefined,
    },
  });
}

/** Pure — advances a loop's `nextRunAt` by exactly one cadence from its
 *  current `nextRunAt` (or from now, if it has none yet), returning a NEW
 *  `LoopConfig` (immutable, never mutates its input). Backs LoopNode's
 *  « Passer la prochaine » inline button (Agent Canvas W5a, spec §4.2
 *  "next-run countdown"): the caller (agentsStore.tsx's `skipLoopNextRun`)
 *  persists the result via the SAME `updateLoop` primitive `toggleLoop`
 *  already uses — this function only computes the new timestamp, it never
 *  touches the filesystem itself. */
export function skipNextRun(loopConfig: LoopConfig): LoopConfig {
  const base = loopConfig.nextRunAt ? new Date(loopConfig.nextRunAt).getTime() : Date.now();
  return {
    ...loopConfig,
    nextRunAt: new Date(base + parseCadenceMs(loopConfig.cadence)).toISOString(),
  };
}

/** Enable a loop and schedule next run. */
export async function enableLoop(repoPath: string, missionId: string): Promise<void> {
  const state = await readLoops(repoPath);
  const idx = state.loops.findIndex((l) => l.missionId === missionId);
  if (idx < 0) return;

  const loop = state.loops[idx];
  loop.loopConfig.enabled = true;
  loop.loopConfig.nextRunAt = new Date(
    Date.now() + parseCadenceMs(loop.loopConfig.cadence),
  ).toISOString();

  state.loops[idx] = loop;
  await writeLoops(repoPath, state);
}

/**
 * Get a single loop by mission id — `null` when no loop is registered under
 * that id. Exported (ZOMBIE LOOP fix) so a mission-terminal caller
 * (agentsStore.tsx's approveMission/archiveMission/deleteMission) can check
 * "is this mission actually a loop?" before deciding whether to
 * disable/unregister it and journal `loop.stopped` — never fired for the
 * overwhelming majority of missions that were never a loop at all.
 */
export async function getLoop(repoPath: string, missionId: string): Promise<PersistedLoop | null> {
  const state = await readLoops(repoPath);
  return state.loops.find((l) => l.missionId === missionId) ?? null;
}

// ── Section 4 gate: trial/validated/autonomous lifecycle ────────────

export interface LoopApprovalResult {
  loop: PersistedLoop;
  /** True exactly on the approval that crossed the trial threshold — the
   *  caller MUST announce this (spec: "jamais silencieuse"), never apply it
   *  quietly. */
  promoted: boolean;
}

/**
 * Records one approved execution against a loop's own regime (spec §4:
 * "compteur d'exécutions approuvées") and persists the result. Returns
 * `null` — never promotes, never counts anything — when `missionId` isn't a
 * registered loop at all, OR when it is but never opted into a gated regime
 * (`regime` absent). This is also how "no promotion for a single task" is
 * structurally guaranteed: a one-time mission is never registered as a loop,
 * so `getLoop` always resolves it to `null` here.
 */
export async function recordLoopApproval(repoPath: string, missionId: string): Promise<LoopApprovalResult | null> {
  const loop = await getLoop(repoPath, missionId);
  if (!loop || !loop.loopConfig.regimeState) return null;
  const { patch, promoted } = recordApproval(loop.loopConfig);
  if (Object.keys(patch).length === 0) return { loop, promoted };
  const loopConfig: LoopConfig = { ...loop.loopConfig, ...patch };
  const updated: PersistedLoop = { ...loop, loopConfig };
  await updateLoop(repoPath, missionId, { loopConfig });
  return { loop: updated, promoted };
}

export interface LoopFailureResult {
  loop: PersistedLoop;
  /** True when this failure sent an already-promoted regime back to
   *  'trial' — announce it (spec: "le dit"), never silently. */
  demoted: boolean;
}

/**
 * Records a failed/anomalous execution against a loop's own regime (spec
 * §4: "retour en mode essai ... au premier échec ou anomalie") and persists
 * the result. Returns `null` under the same conditions as
 * `recordLoopApproval` above — never a guess when there is no gated regime
 * to regress. Whether REPEATED failures should stop the loop outright is a
 * fleet-level decision — see fleetHygiene.ts's `planLoopSupervision`
 * (`repeated_failure`), which a caller should feed this function's own
 * outcome into over time (e.g. via a consecutive-failure counter derived
 * from the mission list), not something this per-event call decides alone.
 */
export async function recordLoopFailure(repoPath: string, missionId: string): Promise<LoopFailureResult | null> {
  const loop = await getLoop(repoPath, missionId);
  if (!loop || !loop.loopConfig.regimeState) return null;
  const { patch, demoted } = recordFailure(loop.loopConfig);
  if (Object.keys(patch).length === 0) return { loop, demoted };
  const loopConfig: LoopConfig = { ...loop.loopConfig, ...patch };
  const updated: PersistedLoop = { ...loop, loopConfig };
  await updateLoop(repoPath, missionId, { loopConfig });
  return { loop: updated, demoted };
}

// ── Helpers ────────────────────────────────────────────────────────

/** Convert cadence to a human-readable label. */
export function cadenceLabel(cadence: LoopCadence): string {
  const labels: Record<string, string> = {
    '1m': '1 minute',
    '5m': '5 minutes',
    '15m': '15 minutes',
    '1h': '1 heure',
    '6h': '6 heures',
    '1d': '1 jour',
  };
  if (labels[cadence]) return labels[cadence];
  const secMatch = cadence.match(/^(\d+)\s*(s|sec|secs|seconds?)$/i);
  if (secMatch) return `${secMatch[1]} secondes`;
  const num = parseInt(cadence, 10);
  if (!isNaN(num)) return `${num} secondes`;
  return cadence;
}

/** Parse a cadence string from user input.
 *  Supports predefined values plus arbitrary seconds (e.g. "30s", "90s").
 *  Only the fixed presets above (1m, 5m, 15m, 1h, 6h, 1d, and their aliases)
 *  are valid minute/hour/day cadences — arbitrary minute values like "3m"
 *  are NOT supported (use seconds instead, e.g. "180s"); unrecognized input
 *  returns null. */
export function parseCadence(input: string): LoopCadence | null {
  const lower = input.toLowerCase().trim();
  const map: Record<string, string> = {
    '1m': '1m',
    '1min': '1m',
    '1minute': '1m',
    '5m': '5m',
    '5min': '5m',
    '5minutes': '5m',
    '15m': '15m',
    '15min': '15m',
    '15minutes': '15m',
    '1h': '1h',
    '1heure': '1h',
    'hourly': '1h',
    '6h': '6h',
    '6heures': '6h',
    '1d': '1d',
    '1day': '1d',
    '1jour': '1d',
    'daily': '1d',
    'jour': '1d',
  };
  if (map[lower]) return map[lower];
  // Arbitrary seconds: "30s", "90s", "120s"
  const secMatch = lower.match(/^(\d+)\s*(s|sec|secs|seconds?)$/);
  if (secMatch) return `${secMatch[1]}s`;
  // Plain number = seconds. Must match the ENTIRE string — parseInt() alone
  // would silently accept "3m" as the number 3 (ignoring the trailing "m"),
  // wrongly treating an unsupported minute value as "3 seconds" instead of
  // rejecting it.
  if (/^\d+$/.test(lower)) {
    const num = parseInt(lower, 10);
    if (num > 0) return `${num}s`;
  }
  return null;
}
