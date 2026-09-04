/* opsOrphanWatch — bridge brain_ops_status → manager wakeup.

   Long-running brain children (dream / graph / recompose) write
   ops-status.json. When phase is timed_out (or running past its budget),
   emit a journal + bus event so LazyManager can digest / act. */

import { emit } from '../bus.js';
import { emitEvent } from '../journal/journal.js';
import {
  BRAIN_OPS_EVENT,
  readBrainOpsStatus,
  type BrainOpsStatus,
} from './opsStatus.js';

export const BRAIN_OPS_ORPHAN_JOURNAL = 'brain.ops_orphan' as const;

export function isOpsOrphan(status: BrainOpsStatus, nowMs = Date.now()): boolean {
  if (status.phase === 'timed_out') return true;
  if (status.phase !== 'running') return false;
  const timeoutSecs = status.timeoutSecs;
  if (timeoutSecs == null || timeoutSecs <= 0) return false;
  const updated = Date.parse(status.updatedAt);
  if (!Number.isFinite(updated)) return false;
  // Grace: only flag after 1.25× declared budget so a still-working child
  // that just crossed the soft deadline is not double-reported.
  return nowMs - updated > timeoutSecs * 1250;
}

export function opsOrphanFingerprint(status: BrainOpsStatus): string {
  return `${status.phase}|${status.step ?? ''}|${status.pid ?? ''}|${status.updatedAt}`;
}

let lastEmittedFingerprint: string | null = null;

/** Reset dedupe (tests). */
export function resetOpsOrphanDedupe(): void {
  lastEmittedFingerprint = null;
}

/**
 * Read live ops status; if orphaned, emit bus + journal once per fingerprint.
 * Returns the status when an orphan was reported, else null.
 */
export async function pollBrainOpsOrphan(opts: {
  projectId: string;
  readStatus?: () => Promise<BrainOpsStatus | null>;
  nowMs?: number;
}): Promise<BrainOpsStatus | null> {
  const read = opts.readStatus ?? readBrainOpsStatus;
  const status = await read();
  if (!status || !isOpsOrphan(status, opts.nowMs ?? Date.now())) return null;

  const fp = opsOrphanFingerprint(status);
  if (fp === lastEmittedFingerprint) return status;
  lastEmittedFingerprint = fp;

  const detail =
    status.detail ??
    (status.phase === 'timed_out'
      ? `${status.step ?? 'brain-ops'} timed out`
      : `${status.step ?? 'brain-ops'} still running past timeout`);

  emit(BRAIN_OPS_EVENT, {
    phase: status.phase,
    step: status.step ?? null,
    pid: status.pid ?? null,
    detail,
    brainPath: status.brainPath ?? null,
  });

  void emitEvent({
    type: BRAIN_OPS_ORPHAN_JOURNAL,
    tsMs: opts.nowMs ?? Date.now(),
    projectId: opts.projectId,
    actor: 'system',
    payload: {
      phase: status.phase,
      step: status.step ?? null,
      pid: status.pid ?? null,
      detail,
      timeoutSecs: status.timeoutSecs ?? null,
      brainPath: status.brainPath ?? null,
    },
  });

  return status;
}
