/* perimeter.ts — D13 graft (b): "Périmètre" rows for the mission detail
   drawer's ScopeCard. Pure, side-effect-free derivation from Mission-facing
   data — no fabrication.

   VERIFIED FACT (recon, code-cockpit-map.md open question #1, confirmed by
   reading preflight.ts's own module doc comment): contract.scopePaths is a
   DECLARED, pre-flight-only field. It is compared against other RUNNING
   missions' scopes to sequence launches (scheduler.ts's scope_conflict), but
   nothing in runtime.ts/managedAgent.ts/toolPermissions.ts blocks a tool call
   for straying outside it — preflight.ts's header even documents this as
   deliberate ("blocking on unknown scope would ... teach users to omit
   scopePaths to dodge the pre-flight"). Every declared row below is
   therefore labeled "déclaré", never "autorisé"/"enforced".

   ✕ ("flagged") rows are NEVER fabricated: they only appear when one of the
   mission's own REAL recorded texts — statusReason on a failed mission, or
   its pending ask_user question (missionQuestion.ts) — actually mentions a
   declared scope path. There is no dedicated "denied path" event anywhere
   in the codebase today (grepped every `statusReason:` assignment site:
   'launch_stalled', a generic run-failed message, budget-exceeded text, or a
   plan-compile error — never a per-path denial), so this list is empty for
   the large majority of missions. That is the honest, expected result, not
   a bug — see MissionScopeCard, which renders nothing at all when there is
   no contract (honest empty).
*/

import type { Mission } from './types.js';
import { extractPendingQuestionText } from './missionQuestion.js';

export interface PerimeterRow {
  path: string;
  state: 'declared' | 'flagged';
  /** Present only for a 'flagged' row — the real text the flag was found in. */
  detail?: string;
}

/**
 * Loose (case-insensitive substring) match between a real recorded text and
 * a declared scope path. Intentionally looser than preflight.ts's
 * pathsOverlap (segment-aware directory containment): free-form prose (a
 * failure reason, a permission question) won't always spell out a clean,
 * fully-segmented path, so a substring check is the honest ceiling here —
 * it never claims MORE precision than the source text actually offers.
 */
function textMentionsPath(text: string, path: string): boolean {
  return text.toLowerCase().includes(path.toLowerCase());
}

/**
 * Derives the Périmètre rows for a mission: one row per declared
 * contract.scopePaths entry, 'flagged' only when a real recorded signal
 * (statusReason on a failed mission, or a pending permission question)
 * actually names that path, 'declared' otherwise. Returns [] when the
 * mission has no contract or no scopePaths (honest empty).
 */
export function derivePerimeterRows(mission: Mission): PerimeterRow[] {
  const scopePaths = mission.contract?.scopePaths;
  if (!scopePaths || scopePaths.length === 0) return [];

  const flagSources: string[] = [];
  if (mission.status === 'failed' && mission.statusReason) {
    flagSources.push(mission.statusReason);
  }
  const pendingQuestion = extractPendingQuestionText(mission);
  if (pendingQuestion) flagSources.push(pendingQuestion);

  return scopePaths.map((path): PerimeterRow => {
    const detail = flagSources.find((text) => textMentionsPath(text, path));
    return detail ? { path, state: 'flagged', detail } : { path, state: 'declared' };
  });
}
