/* codeFileActivity.ts — pure derivation of "who is working on this file"
   (Code space redesign, D9) from the real cross-project fleet mission
   read-model (fleetMissions.ts). No I/O, fully unit-testable.

   Matches a project-relative file path against each mission's real
   `diffFiles` entries (native/managed engines that populate per-file
   progress) with a `liveAction` free-text fallback (missions whose engine
   never set diffFiles but did announce what they're touching, e.g.
   "▊ écrit PricingTable.tsx…"). Never fabricates a match — a file with no
   real signal returns null, which the UI renders as "no agent" rather than
   guessing.
*/

import type { FleetMission } from './fleetMissions.js';
import { missionWhoLabel, missionWhoWhatLine } from './missionWhoLine.js';
import type { TFunc } from './runtime.js';
import { basename } from '../paths.js';

export type FileActivityKind = 'run' | 'question' | 'failed' | 'review';

export interface FileActivity {
  kind: FileActivityKind;
  mission: FleetMission;
}

/** Basename of a path, tolerant of both separators. Thin re-export of
 *  paths.ts's shared `basename` under this module's existing name —
 *  CodeSidebarBrain.tsx and CodeSpace.tsx already import `basenameOf` from
 *  here, so the name stays put rather than pushing a rename onto callers
 *  (same "re-export under its own name" pattern managedAgent.ts uses for
 *  stripVerbatimPrefix — see paths.ts's header comment). */
export { basename as basenameOf } from '../paths.js';

/** True when `relPath` (project-relative, forward-slash normalized) matches
 *  a diffFiles/liveAction filename reference — tolerant of the reference
 *  being a bare basename, a relative path, or an absolute one. */
function referencesFile(reference: string, relPath: string, filename: string): boolean {
  const normalizedRef = reference.replace(/\\/g, '/');
  if (normalizedRef === relPath) return true;
  if (normalizedRef.endsWith(`/${relPath}`)) return true;
  if (normalizedRef === filename) return true;
  return normalizedRef.endsWith(`/${filename}`);
}

/** `liveAction` is free text (e.g. "▊ écrit PricingTable.tsx…"), not a bare
 *  path reference — a substring check on the filename is the honest match
 *  strength available for it (structured diffFiles entries above get exact
 *  path matching; this is deliberately looser). */
function liveActionMentionsFile(liveAction: string, filename: string): boolean {
  return liveAction.includes(filename);
}

function missionTouchesFile(
  mission: FleetMission,
  relPath: string,
  filename: string,
  allowLiveAction: boolean,
): boolean {
  if ((mission.diffFiles ?? []).some((f) => referencesFile(f.filename, relPath, filename))) {
    return true;
  }
  if (!allowLiveAction || !mission.liveAction) return false;
  return liveActionMentionsFile(mission.liveAction, filename);
}

function classifyTouchingMission(
  mission: FleetMission,
  relPath: string,
  filename: string,
): FileActivityKind | null {
  if (mission.status === 'running' && mission.pendingQuestion && missionTouchesFile(mission, relPath, filename, true)) {
    return 'question';
  }
  if (mission.status === 'failed' && missionTouchesFile(mission, relPath, filename, false)) {
    return 'failed';
  }
  if (mission.status === 'review' && missionTouchesFile(mission, relPath, filename, false)) {
    return 'review';
  }
  if (mission.status === 'running' && missionTouchesFile(mission, relPath, filename, true)) {
    return 'run';
  }
  return null;
}

const KIND_PRIORITY: readonly FileActivityKind[] = ['question', 'failed', 'review', 'run'];

/**
 * Finds which (if any) of a project's real fleet missions is currently
 * touching `relPath`, and how — prioritizing the most urgent honest signal:
 * a pending question (agent genuinely blocked on the human) outranks a
 * failure, which outranks review, which outranks an in-progress write. A
 * file can only show one indicator at a time in the sidebar/tabs, so this
 * priority order decides which mission "owns" that indicator when more
 * than one could match.
 */
export function findFileActivity(
  relPath: string,
  filename: string,
  missions: readonly FleetMission[],
): FileActivity | null {
  // path-lint-ignore: relPath is project-relative (see this file's header),
  // never a raw canonicalize() path — no verbatim prefix to strip here.
  const normalizedRel = relPath.replace(/\\/g, '/');
  const found: Partial<Record<FileActivityKind, FleetMission>> = {};
  for (const mission of missions) {
    const kind = classifyTouchingMission(mission, normalizedRel, filename);
    if (kind && !found[kind]) found[kind] = mission;
  }
  for (const kind of KIND_PRIORITY) {
    const mission = found[kind];
    if (mission) return { kind, mission };
  }
  return null;
}

export function fileActivityDotChrome(kind: FileActivityKind): { color: string; animation: string } {
  if (kind === 'run') return { color: 'var(--color-success)', animation: 'blinkDot 1.4s infinite' };
  if (kind === 'question') return { color: 'var(--color-warning)', animation: 'blinkDot 1s infinite' };
  if (kind === 'review') return { color: 'var(--color-warning)', animation: 'blinkDot 1.2s infinite' };
  return { color: 'var(--color-danger)', animation: 'none' };
}

function reviewWhoLine(mission: FleetMission, t?: TFunc): string {
  const who = missionWhoLabel(mission);
  const name = mission.diffFiles?.[0]?.filename?.trim();
  const file = name ? basename(name) : '';
  const verb = t?.('agents.status.review') ?? 'review';
  const what = file ? `${verb} · ${file}` : verb;
  if (!who) return what;
  return `${who} · ${what}`;
}

/** Honest "who / what" line for a file-tree cursor. Never invents a path
 *  or a teammate — agentName/model and liveAction/pendingQuestion only. */
export function fileActivityWhoLine(activity: FileActivity, t?: TFunc): string {
  if (activity.kind === 'review') return reviewWhoLine(activity.mission, t);
  return missionWhoWhatLine(activity.mission, t);
}

/**
 * True when a running mission's write to `filename` is still in progress
 * (diffFiles[].inProgress) — the narrower signal that drives the "agent is
 * writing RIGHT NOW" blinking dot (as opposed to "touched at some point
 * during this run"), used by the tab strip's live dot and the live-worktree
 * tail view's polling gate.
 */
export function isFileInProgress(relPath: string, filename: string, mission: FleetMission): boolean {
  // path-lint-ignore: relPath is project-relative, never a raw canonicalize() path.
  const normalizedRel = relPath.replace(/\\/g, '/');
  return (mission.diffFiles ?? []).some(
    (f) => f.inProgress === true && referencesFile(f.filename, normalizedRel, filename),
  );
}

/**
 * Best-effort prefix/substring match of a project-relative path against a
 * mission contract's declared scope paths. Deliberately simple (no glob
 * engine) — scopePaths today are plain path prefixes assembled by
 * NewMissionModal, not glob patterns, so exact-prefix matching is the
 * honest level of precision to claim.
 */
export function matchesScopePaths(relPath: string, scopePaths: readonly string[]): boolean {
  // path-lint-ignore: relPath is project-relative, never a raw canonicalize() path.
  const normalizedRel = relPath.replace(/\\/g, '/');
  return scopePaths.some((scope) => {
    const normalizedScope = scope.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalizedRel === normalizedScope || normalizedRel.startsWith(`${normalizedScope}/`);
  });
}
