/**
 * src/lib/agents/loopGuard.ts — general loop-stall guard for agent loops.
 *
 * Found by the DeepSWE benchmark: agents on hard tasks stall by repeating the
 * same tool calls (re-reading / re-searching the same symbols) without making
 * any file-modifying progress, and can degenerate into prose replies instead of
 * tool calls. This module provides a pure, harness-agnostic stall detector so
 * EVERY loop (LazyManager, headless IDE harness, CLI) can nudge the agent back
 * toward decisive action.
 *
 * Two independent signals:
 *   1. repeat — the exact same (tool, args) appears repeatedly in recent calls.
 *   2. no-progress — no file-modifying tool in the last N calls.
 *
 * Pure function: unit-testable, no imports from the app runtime.
 */

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

export interface StallVerdict {
  stalled: boolean;
  message: string;
}

/** Tools that count as making concrete progress on the codebase. */
export const EDIT_TOOLS = new Set([
  'edit_file',
  'multi_edit',
  'write_file',
  'rename_file',
  'delete_file',
  'undo_edit',
  'git_commit',
]);

export function signatureOf(rec: ToolCallRecord): string {
  return `${rec.name}:${JSON.stringify(rec.args)}`;
}

export interface StallOptions {
  /** Exact-repeat count that triggers the nudge (default 3; pass a huge number to disable). */
  repeatThreshold?: number;
  /** Calls without an edit tool that trigger the no-progress nudge (default 10). */
  noEditWindow?: number;
  /** How many of the most recent calls to inspect for repeats (default 6). */
  repeatWindow?: number;
}

/**
 * Detect agent-loop stall. Returns a corrective observation when the agent is
 * repeating the same call or making no file-modifying progress.
 */
export function detectStall(history: ToolCallRecord[], opts: StallOptions = {}): StallVerdict {
  const repeatThreshold = opts.repeatThreshold ?? 3;
  const noEditWindow = opts.noEditWindow ?? 10;
  const repeatWindow = opts.repeatWindow ?? 6;

  // 1) Exact repeat within the recent window.
  const recent = history.slice(-repeatWindow);
  const counts = new Map<string, number>();
  for (const rec of recent) {
    const sig = signatureOf(rec);
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  for (const [sig, count] of counts) {
    if (count >= repeatThreshold) {
      const toolName = sig.split(':')[0];
      return {
        stalled: true,
        message:
          `STALL GUARD: you made the exact same ${toolName} call ${count} times in a row. ` +
          'Stop repeating it — read a DIFFERENT file, make a concrete change with edit_file/write_file, ' +
          'run the relevant test, or call finish.',
      };
    }
  }

  // 2) No file-modifying progress in the last window.
  const window = history.slice(-noEditWindow);
  if (window.length >= noEditWindow && !window.some((r) => EDIT_TOOLS.has(r.name))) {
    return {
      stalled: true,
      message:
        `STALL GUARD: you made ${noEditWindow} tool calls without changing any file. ` +
        'Make a concrete code change (edit_file/write_file), run the relevant test/build, or call finish — do not keep exploring.',
    };
  }

  return { stalled: false, message: '' };
}
