/* opsStatus — readable snapshot of long-running brain subprocesses.

   Hung `lazybrain.js` children (dream / graph --cwd / recompose) used to be
   invisible except in Task Manager. Rust writes `<brain>/_cache/ops-status.json`
   and serves the same snapshot via `brain_ops_status`. The TS side reads that
   snapshot; `opsOrphanWatch.ts` polls it on the manager wakeup tick and
   wakes LazyManager when an orphan (timed_out / stuck past budget) is seen.
*/

export const BRAIN_OPS_EVENT = 'brain://ops';
export const BRAIN_OPS_STATUS_FILENAME = 'ops-status.json';

export type BrainOpsPhase = 'idle' | 'running' | 'timed_out' | 'done' | 'failed';

export interface BrainOpsStatus {
  updatedAt: string;
  phase: BrainOpsPhase | string;
  step?: string | null;
  pid?: number | null;
  timeoutSecs?: number | null;
  detail?: string | null;
  brainPath?: string | null;
}

export function parseOpsStatusJson(raw: string): BrainOpsStatus | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BrainOpsStatus>;
    if (typeof parsed.updatedAt !== 'string' || typeof parsed.phase !== 'string') {
      return null;
    }
    return {
      updatedAt: parsed.updatedAt,
      phase: parsed.phase,
      step: parsed.step ?? null,
      pid: parsed.pid ?? null,
      timeoutSecs: parsed.timeoutSecs ?? null,
      detail: parsed.detail ?? null,
      brainPath: parsed.brainPath ?? null,
    };
  } catch {
    return null;
  }
}

/** Best-effort read of the live snapshot. Returns null when the command is
 *  missing (older binary without rc.exe / SDK rebuild) or invoke fails. */
export async function readBrainOpsStatus(): Promise<BrainOpsStatus | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<BrainOpsStatus>('brain_ops_status');
  } catch {
    return null;
  }
}
