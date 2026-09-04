/* botRoutineQueue — web→desktop resume queue for LazyBot cron routines (C67).

   Web builds cannot run an always-on scheduler. When a routine is due (or the
   user is on web with enabled routines), we persist a small queue in
   localStorage. Opening the same project in Lazy Desktop drains the queue
   and launches the missed routines once.
*/

const STORAGE_KEY = 'lazy.bots.routineQueue.v1';

export interface QueuedRoutineFire {
  botId: string;
  botName: string;
  routineId: string;
  routineName: string;
  task: string;
  dueAt: string;
  enqueuedAt: string;
}

function readRaw(): QueuedRoutineFire[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is QueuedRoutineFire => {
      const r = row as Record<string, unknown>;
      return typeof r.botId === 'string'
        && typeof r.routineId === 'string'
        && typeof r.task === 'string';
    });
  } catch {
    return [];
  }
}

function writeRaw(rows: QueuedRoutineFire[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Quota / private mode — best-effort only.
  }
}

/** Enqueue a due routine if not already queued for the same routineId. */
export function enqueueRoutineFire(entry: Omit<QueuedRoutineFire, 'enqueuedAt'>): boolean {
  const rows = readRaw();
  if (rows.some((r) => r.botId === entry.botId && r.routineId === entry.routineId)) {
    return false;
  }
  rows.push({ ...entry, enqueuedAt: new Date().toISOString() });
  writeRaw(rows);
  return true;
}

export function listQueuedRoutineFires(): QueuedRoutineFire[] {
  return readRaw();
}

/** Atomically take and clear the queue (Tauri boot drain). */
export function drainQueuedRoutineFires(): QueuedRoutineFire[] {
  const rows = readRaw();
  writeRaw([]);
  return rows;
}

export function clearQueuedRoutineFires(): void {
  writeRaw([]);
}

/** Tests only. */
export function resetRoutineQueueForTests(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
