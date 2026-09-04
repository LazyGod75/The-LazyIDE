/* codeBanner.ts — pure state-machine deriving the Code space's contextual
   editor banner (D9) from the active file's real per-file activity plus its
   project's running missions. No I/O, fully unit-testable.

   Design source (design-code.md §4.6) specifies five banner kinds keyed off
   a per-file `agent.kind` field ('run' | 'blocked' | 'failed') and a
   `locked` flag that don't exist verbatim in the real Mission model — this
   module maps the REAL signals available (fleetMissions.ts's FleetMission,
   itself derived from Mission) onto the closest honest equivalent:
     - design 'run'      -> a mission's diffFiles/liveAction touches this file
     - design 'blocked'  -> the touching mission has a genuine pending
                            ask_user question (missionQuestion.ts) — the only
                            real "agent is stuck waiting on you" signal in
                            the codebase, same one AttentionInbox.tsx uses
     - design 'failed'   -> the touching mission's status is 'failed'
     - review            -> the touching mission is in review (real
                            diffFiles only — never a stale liveAction)
     - design 'locked'   -> the file isn't touched by any mission, but a
                            running mission with a declared contract scope is
                            active on this project and the file sits outside
                            every running mission's scope
   A file matching none of the above renders no banner at all — never a
   fabricated "stable on main" placeholder.
*/

import type { FleetMission } from './fleetMissions.js';
import { findFileActivity, matchesScopePaths } from './codeFileActivity.js';

export type CodeBanner =
  | { kind: 'none' }
  | { kind: 'run'; mission: FleetMission }
  | { kind: 'question'; mission: FleetMission; question: string }
  | { kind: 'failed'; mission: FleetMission }
  | { kind: 'review'; mission: FleetMission }
  | { kind: 'locked'; mission: FleetMission };

/**
 * Derives the banner for `relPath` (project-relative, forward-slash form)
 * given every real fleet mission tracked for the file's OWN project.
 */
export function deriveCodeBanner(
  relPath: string,
  filename: string,
  projectMissions: readonly FleetMission[],
): CodeBanner {
  const activity = findFileActivity(relPath, filename, projectMissions);
  if (activity) {
    if (activity.kind === 'question' && activity.mission.pendingQuestion) {
      return { kind: 'question', mission: activity.mission, question: activity.mission.pendingQuestion };
    }
    if (activity.kind === 'failed') {
      return { kind: 'failed', mission: activity.mission };
    }
    if (activity.kind === 'review') {
      return { kind: 'review', mission: activity.mission };
    }
    if (activity.kind === 'run') {
      return { kind: 'run', mission: activity.mission };
    }
  }

  // No direct activity on this file — check whether it falls outside every
  // currently-running mission's declared scope (design's "locked" state).
  const runningWithScope = projectMissions.filter(
    (m) => m.status === 'running' && (m.contractScopePaths?.length ?? 0) > 0,
  );
  if (runningWithScope.length === 0) return { kind: 'none' };

  const inSomeScope = runningWithScope.some((m) => matchesScopePaths(relPath, m.contractScopePaths ?? []));
  if (inSomeScope) return { kind: 'none' };

  return { kind: 'locked', mission: runningWithScope[0] };
}
