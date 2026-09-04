/* migrate.ts — one-shot per-project migration from the legacy
   `.lazy/missions.json` (+ `.lazy/mission-queue.json`) snapshot into the
   event journal (T0.5, spec §4.3), so `missionsProjection.loadMissionsFromJournal`
   has something to load on the FIRST boot after this feature ships.

   Idempotent via a marker file (`.lazy/journal-migrated`): a project
   migrated once never re-emits its history into the journal again, even
   across many subsequent boots — `migrateProjectToJournal` checks the
   marker itself, so callers (agentsStore.tsx's boot effect) can call it
   unconditionally whenever the journal comes back empty and trust it to be
   a cheap no-op when there is truly nothing left to do.

   Emits directly via `invoke('journal_emit_batch', ...)` (NOT
   journal.ts's emitEvent/emitBuffered) so the whole replay — every
   mission.created + mission.updated pair — lands in ONE Rust transaction:
   either the full history is imported, or none of it is (see journal.rs's
   `journal_emit_batch_inner`), which is exactly what "idempotent, marker
   written only on success" requires. journal.ts's buffered client is a
   time-windowed best-effort sink built for live high-frequency telemetry,
   not a one-shot atomic backfill.
*/

import { invoke } from '@tauri-apps/api/core';
import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { serializeEvent } from './journal.js';
import { projectIdFromRoot } from './projectId.js';
import type { JournalEventInput } from './eventTypes.js';
import type { Mission } from '../agents/types.js';
import type { QueuedMission } from '../agents/missionQueue.js';

const MARKER_FILE = '.lazy/journal-migrated';
const MISSION_QUEUE_FILE = '.lazy/mission-queue.json';

export type MigrationResult = { imported: number } | { skipped: true };

// ── Legacy-data parsing (local copies — see nowTime()'s doc comment in
// agentsStore.tsx for why small per-module duplicates like this are the
// existing convention rather than a shared import) ──────────────────────

function isMissionLike(value: unknown): value is Mission {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

function parseMissionsArray(raw: unknown): Mission[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isMissionLike);
}

/** Best-known original timestamp for a persisted mission: prefers the
 *  mission's own `createdAt` (epoch ms, added after missions.json already
 *  existed for some projects — see Mission.createdAt's doc comment), falls
 *  back to the matching mission-queue.json entry's `enqueuedAt`/`startedAt`
 *  (ISO strings, present since the durable queue predates `createdAt`),
 *  else "now" — a mission with no timestamp info anywhere is being
 *  migrated NOW, so "now" is the least-wrong synthetic value. */
function bestKnownTimestamp(mission: Mission, queueEntry: QueuedMission | undefined): number {
  if (typeof mission.createdAt === 'number' && Number.isFinite(mission.createdAt)) {
    return mission.createdAt;
  }
  const isoCandidate = queueEntry?.enqueuedAt ?? queueEntry?.startedAt;
  if (isoCandidate) {
    const parsed = Date.parse(isoCandidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

// ── Marker file ───────────────────────────────────────────────────────

async function readMarker(root: string): Promise<boolean> {
  const platform = getPlatform();
  try {
    await platform.fs.readFile(joinPath(root, MARKER_FILE));
    return true;
  } catch {
    return false;
  }
}

async function writeMarker(root: string): Promise<void> {
  const platform = getPlatform();
  await platform.fs.createDir(joinPath(root, '.lazy'));
  await platform.fs.writeFile(joinPath(root, MARKER_FILE), new Date().toISOString());
}

// ── mission-queue.json (best-effort timestamp enrichment only) ───────────

async function readMissionQueue(root: string): Promise<QueuedMission[]> {
  const platform = getPlatform();
  try {
    const raw = await platform.fs.readFile(joinPath(root, MISSION_QUEUE_FILE));
    const parsed = JSON.parse(raw) as { missions?: unknown };
    return Array.isArray(parsed.missions) ? (parsed.missions as QueuedMission[]) : [];
  } catch {
    return [];
  }
}

// ── Migration ─────────────────────────────────────────────────────────

/**
 * Replays a project's legacy missions.json (+ mission-queue.json) snapshot
 * into the event journal as synthetic `mission.created`/`mission.updated`
 * events, then writes the `.lazy/journal-migrated` marker so this never
 * runs again for the same project.
 *
 * Idempotent: returns `{ skipped: true }` immediately (no reads, no
 * emits) when the marker already exists. Returns `{ imported: 0 }` (and
 * still writes the marker) when there was nothing to migrate — a brand
 * new project should never be re-checked on every future boot either.
 */
export async function migrateProjectToJournal(projectRoot: string): Promise<MigrationResult> {
  if (await readMarker(projectRoot)) {
    return { skipped: true };
  }

  const platform = getPlatform();
  const rawMissions = await platform.missions.load(projectRoot).catch(() => null);
  const missions = parseMissionsArray(rawMissions);

  if (missions.length === 0) {
    await writeMarker(projectRoot);
    return { imported: 0 };
  }

  const queueEntries = await readMissionQueue(projectRoot);
  const queueById = new Map(queueEntries.map((q) => [q.missionId, q] as const));
  const projectId = projectIdFromRoot(projectRoot);

  const events: JournalEventInput[] = [];
  for (const mission of missions) {
    const tsMs = bestKnownTimestamp(mission, queueById.get(mission.id));
    events.push({
      type: 'mission.created',
      tsMs,
      projectId,
      missionId: mission.id,
      actor: 'system',
      payload: { title: mission.title, model: mission.model, mission, imported: true },
    });
    events.push({
      type: 'mission.updated',
      tsMs,
      projectId,
      missionId: mission.id,
      actor: 'system',
      payload: { mission },
    });
  }

  // One transaction (see module header) — a failure here must propagate
  // so the marker below is NOT written, letting the next boot retry.
  await invoke('journal_emit_batch', { events: events.map(serializeEvent) });
  await writeMarker(projectRoot);

  return { imported: missions.length };
}
