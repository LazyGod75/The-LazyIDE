/* missionQueue.ts — Durable mission queue with stage state persistence.
   Replaces the fire-and-forget addMission() → runMission() pattern with
   a queue that persists execution state, enabling crash recovery and
   resume-from-last-stage.

   Inspired by Millrace's durable queue concept — adapted for Lazy's
   Tauri/TS stack using the filesystem for persistence.
*/

import type { CompiledPlan } from './stageContract.js';
import type { MissionStatus } from './types.js';
import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';

// ── Types ─────────────────────────────────────────────────────────

export interface QueuedMission {
  missionId: string;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed';
  compiledPlan?: CompiledPlan;
  currentStageId?: string;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
  priority: number;
  /**
   * R4b fix (ghost queue runs, real-money incident): a 'queued' entry that
   * has been sitting for longer than STALE_QUEUE_THRESHOLD_MS since
   * `enqueuedAt` with no `startedAt` — an app restart (or several) happened
   * without this mission ever actually launching. Set by
   * markStaleQueuedMissions, called from the boot recovery pass alongside
   * recoverStaleMissions (see agentsStore.tsx). Gates dequeue()'s own
   * eligibility filter below so a stale entry is never auto-picked — it
   * stays 'queued' (never force-failed/deleted, no data lost) but requires
   * an explicit user relaunch, surfaced by the UI as "en file (ancienne)".
   */
  stale?: boolean;
}

/** Age threshold (R4b fix) past which a still-'queued' entry (never
 *  started) is considered stale rather than merely slow — see
 *  QueuedMission.stale's doc comment and markStaleQueuedMissions below. */
export const STALE_QUEUE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export interface QueueState {
  missions: QueuedMission[];
  version: string;
}

// ── Persistence ───────────────────────────────────────────────────

const QUEUE_FILE = '.lazy/mission-queue.json';
const QUEUE_VERSION = '1.0.0';

async function readQueue(repoPath: string): Promise<QueueState> {
  const platform = getPlatform();
  if (!platform || !platform.fs) return { missions: [], version: QUEUE_VERSION };

  try {
    const raw = await platform.fs.readFile(joinPath(repoPath, QUEUE_FILE));
    return JSON.parse(raw) as QueueState;
  } catch {
    return { missions: [], version: QUEUE_VERSION };
  }
}

async function writeQueue(repoPath: string, state: QueueState): Promise<void> {
  const platform = getPlatform();
  if (!platform) return;

  try {
    // joinPath (not a hardcoded '/') — repoPath is typically Rust's own
    // canonicalize() output (verbatim '\\?\'-prefixed on Windows); joining
    // with a literal '/' produced the mixed-separator string that made the
    // Rust fs commands (fs_create_dir/write_file) reject this as "outside
    // project root" even though '.lazy' existed on disk. See paths.ts's
    // header comment for the full bug-class history.
    await platform.fs.createDir(joinPath(repoPath, '.lazy'));
    await platform.fs.writeFile(joinPath(repoPath, QUEUE_FILE), JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[missionQueue] Failed to persist queue:', err);
  }
}

// ── Public API ────────────────────────────────────────────────────

export async function enqueue(
  repoPath: string,
  missionId: string,
  priority = 0,
): Promise<QueuedMission> {
  const state = await readQueue(repoPath);
  const entry: QueuedMission = {
    missionId,
    status: 'queued',
    enqueuedAt: new Date().toISOString(),
    retryCount: 0,
    priority,
  };
  state.missions.push(entry);
  await writeQueue(repoPath, state);
  return entry;
}

export async function updateQueuedMission(
  repoPath: string,
  missionId: string,
  patch: Partial<QueuedMission>,
): Promise<void> {
  const state = await readQueue(repoPath);
  const idx = state.missions.findIndex((m) => m.missionId === missionId);
  if (idx >= 0) {
    state.missions[idx] = { ...state.missions[idx], ...patch };
    await writeQueue(repoPath, state);
  }
}

export async function dequeue(repoPath: string): Promise<QueuedMission | null> {
  const state = await readQueue(repoPath);
  const eligible = state.missions
    // R4b fix: a stale entry (see QueuedMission.stale) is deliberately
    // EXCLUDED from auto-pickup — it stays 'queued' in the store (nothing
    // deleted/force-failed), but only an explicit user relaunch can run it.
    .filter((m) => m.status === 'queued' && !m.stale)
    .sort((a, b) => b.priority - a.priority || a.enqueuedAt.localeCompare(b.enqueuedAt));
  return eligible[0] ?? null;
}

export async function getQueuedMission(repoPath: string, missionId: string): Promise<QueuedMission | null> {
  const state = await readQueue(repoPath);
  return state.missions.find((m) => m.missionId === missionId) ?? null;
}

export async function removeQueuedMission(repoPath: string, missionId: string): Promise<void> {
  const state = await readQueue(repoPath);
  state.missions = state.missions.filter((m) => m.missionId !== missionId);
  await writeQueue(repoPath, state);
}

/**
 * Recover stale missions on app restart.
 * Any mission marked 'running' or 'paused' in the queue but not actually
 * executing is marked for resume.
 */
export async function recoverStaleMissions(repoPath: string): Promise<QueuedMission[]> {
  const state = await readQueue(repoPath);
  const stale = state.missions.filter((m) => m.status === 'running');
  for (const m of stale) {
    m.status = 'paused'; // Ready for resume
  }
  if (stale.length > 0) {
    await writeQueue(repoPath, state);
  }
  return stale;
}

/**
 * R4b fix — "ghost queue runs" (real-money incident: stale 'queued' entries
 * from as far back as July 4th resurfacing and billing on a later boot).
 *
 * Marks every 'queued' entry that has sat for longer than
 * STALE_QUEUE_THRESHOLD_MS since `enqueuedAt` (and never actually started —
 * `startedAt` absent) as `stale: true`. Called from the SAME boot recovery
 * pass as recoverStaleMissions above (see agentsStore.tsx's boot effect).
 *
 * Deliberately non-destructive: status stays 'queued' (nothing is
 * force-failed, deleted, or silently cancelled — the mission's own history
 * is preserved intact), only the new `stale` flag changes. dequeue() above
 * excludes stale entries from auto-pickup; the UI (mission card) is expected
 * to surface a "en file (ancienne)" state with an explicit "Relancer"
 * affordance for the user to consciously re-arm it — see the flag exposed on
 * agentsStore.tsx's boot-loaded Mission list (`queueStale`, types.ts).
 *
 * Idempotent and safe to call every boot: an already-stale entry is left
 * alone (no repeated writes), and a freshly-queued entry under the
 * threshold is never touched.
 */
export async function markStaleQueuedMissions(
  repoPath: string,
  nowMs: number = Date.now(),
): Promise<QueuedMission[]> {
  const state = await readQueue(repoPath);
  const newlyStale: QueuedMission[] = [];
  for (const m of state.missions) {
    if (m.status !== 'queued' || m.stale || m.startedAt) continue;
    const enqueuedAtMs = Date.parse(m.enqueuedAt);
    if (Number.isNaN(enqueuedAtMs)) continue;
    if (nowMs - enqueuedAtMs >= STALE_QUEUE_THRESHOLD_MS) {
      m.stale = true;
      newlyStale.push(m);
    }
  }
  if (newlyStale.length > 0) {
    await writeQueue(repoPath, state);
  }
  return newlyStale;
}

/**
 * Self-heal fix (2026-08-02 incident — mission-queue.json found holding
 * entries from over two weeks earlier, flagged `stale: true` and never
 * purged): markStaleQueuedMissions above is deliberately non-destructive
 * (see its own doc comment — status/history stay intact so a conscious
 * "Relancer" is always still possible), but NOTHING in this codebase has
 * ever removed a `stale` entry once flagged, so this file only ever grows.
 * dequeue() is the only reader of `stale` at all, and it has ZERO
 * production call sites (only this module's own unit tests call it — see
 * scheduler.ts's own header for the real launch path, which never touches
 * this file's 'queued' entries) — so a `stale` entry blocks nothing, it is
 * pure residue. Once an entry has been `stale` for STALE_QUEUE_PURGE_MS
 * (one week past the original 24h staleness bar), any realistic manual
 * "Relancer" would go through retryMission instead (which enqueues a BRAND
 * NEW entry under a new mission id — see agentsStore.tsx), making this old
 * record dead weight forever. Removing it here deletes ONLY this queue
 * file's own bookkeeping row — the mission's real history (journal /
 * missions.json, the actual source of truth) is completely untouched.
 * Called from the SAME best-effort boot pass as recoverStaleMissions/
 * markStaleQueuedMissions (agentsStore.tsx).
 */
export const STALE_QUEUE_PURGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function purgeAncientStaleQueuedMissions(
  repoPath: string,
  nowMs: number = Date.now(),
): Promise<QueuedMission[]> {
  const state = await readQueue(repoPath);
  const purged: QueuedMission[] = [];
  const kept: QueuedMission[] = [];
  for (const m of state.missions) {
    const enqueuedAtMs = Date.parse(m.enqueuedAt);
    const oldEnough = !Number.isNaN(enqueuedAtMs) && nowMs - enqueuedAtMs >= STALE_QUEUE_PURGE_MS;
    if (m.stale && oldEnough) {
      purged.push(m);
    } else {
      kept.push(m);
    }
  }
  if (purged.length > 0) {
    state.missions = kept;
    await writeQueue(repoPath, state);
  }
  return purged;
}

/**
 * Resume a paused mission from its last completed stage.
 */
export async function resumeMission(
  repoPath: string,
  missionId: string,
): Promise<QueuedMission | null> {
  const state = await readQueue(repoPath);
  const entry = state.missions.find((m) => m.missionId === missionId);
  if (!entry || (entry.status !== 'paused' && entry.status !== 'failed')) return null;

  entry.status = 'queued';
  entry.retryCount += 1;
  await writeQueue(repoPath, state);
  return entry;
}

/**
 * Pause a running mission — it will stop after the current stage completes.
 */
export async function pauseMission(repoPath: string, missionId: string): Promise<void> {
  await updateQueuedMission(repoPath, missionId, { status: 'paused' });
}

/**
 * Get all missions in the queue, sorted by priority then enqueue time.
 */
export async function listQueue(repoPath: string): Promise<QueuedMission[]> {
  const state = await readQueue(repoPath);
  return state.missions.sort(
    (a, b) => b.priority - a.priority || a.enqueuedAt.localeCompare(b.enqueuedAt),
  );
}

/** A mission has left the queue-relevant lifecycle once it reaches one of
 *  these statuses — see reconcileQueueAgainstMissions below. */
const NON_RUNNABLE_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set([
  'review',
  'done',
  'failed',
  'cancelled',
]);

/**
 * Boot-truth reconcile (W-GUARD) — drops any queue entry whose mission has
 * already left the queue-relevant lifecycle (review/done/failed/cancelled).
 *
 * Real-world truth bug this fixes: nothing in this codebase ever calls
 * removeQueuedMission/updateQueuedMission when a mission naturally reaches a
 * terminal status — enqueue()'s record just sits at whatever status it last
 * held (typically still 'queued') forever, even long after the mission
 * itself moved on. Observed on the real machine: several missions sat
 * 'queued' in mission-queue.json while missions.json already showed them
 * 'review' with their branch already merged — a truth mismatch, not (today)
 * an actual double-run, since dequeue() — the only reader of 'queued'
 * entries — has no production call site (only this module's own unit tests
 * call it). This reconcile removes the ghost record on principle, so a
 * future scheduler wired onto dequeue() can never resurrect a mission that
 * has already moved on.
 *
 * Called from the SAME boot pass as recoverStaleMissions/
 * markStaleQueuedMissions (agentsStore.tsx), once the real mission list for
 * this boot is known (necessarily after mission loading, unlike those two —
 * see agentsStore.tsx's boot effect). Never touches a mission still
 * genuinely in-flight, or a queue entry whose mission id isn't in
 * `missions` at all (e.g. not yet loaded this boot) — only an entry whose
 * mission resolves to a known NON-runnable status is dropped.
 */
export async function reconcileQueueAgainstMissions(
  repoPath: string,
  missions: ReadonlyArray<{ id: string; status: MissionStatus }>,
): Promise<Array<QueuedMission & { missionStatus: MissionStatus }>> {
  const state = await readQueue(repoPath);
  const statusById = new Map(missions.map((m) => [m.id, m.status]));
  const dropped: Array<QueuedMission & { missionStatus: MissionStatus }> = [];
  const kept: QueuedMission[] = [];

  for (const entry of state.missions) {
    const missionStatus = statusById.get(entry.missionId);
    if (missionStatus && NON_RUNNABLE_MISSION_STATUSES.has(missionStatus)) {
      dropped.push({ ...entry, missionStatus });
    } else {
      kept.push(entry);
    }
  }

  if (dropped.length > 0) {
    state.missions = kept;
    await writeQueue(repoPath, state);
  }
  return dropped;
}
