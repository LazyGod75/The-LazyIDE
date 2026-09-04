/* managerDynamicContext — optional per-turn prompt sections for LazyManager.

   Measured 2026-08-28: buildManagerDynamicContext cyclomatic complexity was
   25 (ESLint ratchet ceiling 12). Each grounded/credits/canvas block was a
   ternary in the parent, on the TTFT path. Helpers live here so the
   assembler is a pipeline, not a 23-branch function.
*/

import type { Mission } from './types.js';

export const MAX_MANAGER_MISSION_LINES = 30;

/** Render `value` only when it is a real non-empty string. `trim` matches
 *  the startup-context block (whitespace-only is omitted). Other blocks
 *  keep the original truthiness check — a present string, even padded,
 *  still renders. */
export function presentSection(
  value: string | undefined,
  render: (v: string) => string,
  trim = false,
): string {
  if (!value) return '';
  const v = trim ? value.trim() : value;
  if (trim && !v) return '';
  return render(v);
}

/** Grounded follow-up block. Absent lookup → empty string, never a
 *  fabricated "no hits" placeholder. */
export function groundedResultBlock(
  title: string,
  body: string | undefined,
  instruction: string,
): string {
  if (!body) return '';
  return `\n\n### ${title}\n${body}\n\n${instruction}`;
}

function formatOneMissionLine(m: Mission): string {
  const reason = m.statusReason ? ` reason=${m.statusReason}` : '';
  const loop = m.loopConfig ? ' (loop)' : '';
  const agent = m.agentName ? ` @${m.agentName}` : '';
  const progress = m.progress !== undefined ? ` ${m.progress}%` : '';
  const branch = m.worktree ? ` branch=${m.worktree}` : '';
  return `- ${m.id}: [${m.status}]${reason} ${m.title}${loop}${agent}${progress}${branch}`;
}

/** Canvas-visible missions only (archived filtered), most recent first cap.
    Same projection the reconciler uses — never the insertion-order first 30. */
export function formatVisibleMissionLines(missions: readonly Mission[]): string[] {
  return missions.filter((m) => !m.archived).slice(-MAX_MANAGER_MISSION_LINES).map(formatOneMissionLine);
}
