/* preflight.ts — mission conflict pre-flight (T1.6, spec §7.2).

   Before a mission launches, its PREDICTED file scope (contract.scopePaths)
   is compared against every currently RUNNING mission's own scope — both
   what it DECLARED (its own contract.scopePaths) and what it has actually
   TOUCHED so far (tool.called journal history, spec §4.2) — so a mission
   whose agent strayed outside its declared scope is still caught, not just
   one whose contract was accurate.

   Path comparison is segment-aware, never a naive string prefix: 'src/lib'
   must be treated as containing 'src/lib/x.ts' but NOT as containing
   'src/library' (which merely shares a character prefix, not a directory
   ancestor). See pathsOverlap.

   A candidate with unknown scope (no contract, or a contract without
   scopePaths) NEVER conflicts — deliberately, and documented at
   checkConflicts: blocking on unknown scope would be a false positive on
   every contract-less/legacy mission, which would only teach users to omit
   scopePaths to dodge the pre-flight, defeating the whole feature.

   Consumed by scheduler.ts's dispatch() (auto-sequence behind a conflicting
   mission, spec §7.2) and by NewMissionModal.tsx (non-blocking notice).
*/

import { journalQuery } from '../journal/journal.js';
import type { JournalEventRow, ToolCalledPayload } from '../journal/eventTypes.js';
import type { Mission } from './types.js';
import { stripVerbatimPrefix } from '../paths.js';

const HISTORICAL_TOUCHES_LIMIT = 500;

// ── Path comparison ───────────────────────────────────────────────────

/**
 * Display-friendly normalization: strips a Windows verbatim (`\\?\`) prefix
 * (src/lib/paths.ts) but otherwise preserves the path's original casing and
 * separators, so values returned from this module stay readable in the UI
 * (NewMissionModal's conflict notice). Deeper, comparison-only folding
 * (case, separators) happens in pathsOverlap instead — kept separate so it
 * never mutates what callers see.
 */
function displayNormalize(p: string): string {
  return stripVerbatimPrefix(p);
}

/**
 * Canonical form used ONLY for path comparison (never returned/displayed as
 * such): unifies separators to '/', trims a trailing slash, and lowercases.
 * Windows (and default-config macOS) filesystems are case-insensitive, so
 * 'Src/Lib' and 'src/lib' must compare equal — otherwise an agent editing
 * the same tree under a differently-cased scope string would silently
 * dodge the conflict check.
 */
function comparablePath(p: string): string {
  return displayNormalize(p)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function pathSegments(p: string): string[] {
  return comparablePath(p).split('/').filter(Boolean);
}

/**
 * True when `a` and `b` are the same path, or one is a directory-prefix of
 * the other, compared by path SEGMENT — never a naive string `startsWith`,
 * which would wrongly treat 'src/library' as inside 'src/lib' (both happen
 * to share the "src/lib" character prefix, but 'library' and 'lib' are
 * different path segments, not one nested in the other).
 */
export function pathsOverlap(a: string, b: string): boolean {
  const segA = pathSegments(a);
  const segB = pathSegments(b);
  if (segA.length === 0 || segB.length === 0) return false;

  const len = Math.min(segA.length, segB.length);
  for (let i = 0; i < len; i += 1) {
    if (segA[i] !== segB[i]) return false;
  }
  return true;
}

// ── Scope sources ────────────────────────────────────────────────────

/**
 * A mission's predicted file scope: its contract's declared `scopePaths`
 * (spec §7.2/§8), display-normalized. A mission with no contract, or a
 * contract with no scopePaths, has "unknown scope" — represented as `[]`
 * and handled specially by checkConflicts (never blocks; see there).
 */
export function predictedScope(mission: Mission): string[] {
  const scopePaths = mission.contract?.scopePaths;
  if (!scopePaths || scopePaths.length === 0) return [];
  return scopePaths.map(displayNormalize);
}

/**
 * Every file path a mission has actually touched so far, from its
 * `tool.called` journal history (payload.files, spec §4.2), deduplicated
 * and display-normalized. Checked independently of predictedScope so a
 * mission whose agent strayed outside its declared contract is still
 * caught by conflict detection.
 *
 * Defensive: journalQuery already never throws (journal.ts wraps its own
 * invoke in try/catch), but this wraps it again anyway so a future change
 * to that contract — or a test double that rejects — can never turn a
 * conflict check into a crash. A malformed payload on one row is skipped,
 * never aborts the scan for every other row.
 */
export async function historicalTouches(missionId: string): Promise<string[]> {
  let rows: JournalEventRow[];
  try {
    rows = await journalQuery({ missionId, types: ['tool.called'], limit: HISTORICAL_TOUCHES_LIMIT });
  } catch {
    return [];
  }

  const files = new Set<string>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as ToolCalledPayload;
      for (const f of payload.files ?? []) files.add(displayNormalize(f));
    } catch {
      // One malformed payload must never poison the whole scan.
    }
  }
  return Array.from(files);
}

// ── Conflict check ───────────────────────────────────────────────────

export interface ConflictCheckResult {
  /** Ids of currently-running missions whose scope overlaps the candidate's. */
  conflictsWith: string[];
  /** Per conflicting mission id, the specific overlapping path(s) (from
   *  either side) that triggered the conflict — for display/debugging. */
  overlaps: Record<string, string[]>;
}

/**
 * Pre-flight scope-conflict check (spec §7.2): does `candidate`'s predicted
 * file scope overlap with any mission in `runningMissions`'s own scope —
 * its declared contract.scopePaths UNIONED with what it has actually
 * touched (historicalTouches)?
 *
 * A candidate with unknown scope (predictedScope returns []) never
 * conflicts — checked upfront, before any journal query runs. Blocking on
 * unknown scope would be a false positive on every contract-less/legacy
 * mission; better to occasionally miss a real conflict on an unscoped
 * mission than to nag on every single launch and train users to stop
 * declaring scopes just to dodge the pre-flight.
 *
 * Never throws — historicalTouches is itself defensive per-mission, so one
 * running mission's journal lookup failing never prevents the others from
 * being checked.
 */
export interface ExtraOccupancyScope {
  id: string;
  scope: string[];
}

export async function checkConflicts(
  candidate: Mission,
  runningMissions: readonly Mission[],
  extraScopes: readonly ExtraOccupancyScope[] = [],
): Promise<ConflictCheckResult> {
  const candidateScope = predictedScope(candidate);
  if (candidateScope.length === 0) {
    return { conflictsWith: [], overlaps: {} };
  }

  const others = runningMissions.filter((m) => m.id !== candidate.id);

  const perMission = await Promise.all(
    others.map(async (running) => {
      const historical = await historicalTouches(running.id);
      const scope = [...predictedScope(running), ...historical];
      return { id: running.id, scope };
    }),
  );

  const overlaps: Record<string, string[]> = {};
  for (const { id, scope } of perMission) {
    if (scope.length === 0) continue;
    const matched = new Set<string>();
    for (const c of candidateScope) {
      for (const o of scope) {
        if (pathsOverlap(c, o)) {
          matched.add(c);
          matched.add(o);
        }
      }
    }
    if (matched.size > 0) overlaps[id] = Array.from(matched).sort();
  }

  for (const extra of extraScopes) {
    if (extra.id === candidate.id || extra.scope.length === 0) continue;
    const matched = new Set<string>();
    for (const c of candidateScope) {
      for (const o of extra.scope) {
        if (pathsOverlap(c, o)) {
          matched.add(c);
          matched.add(o);
        }
      }
    }
    if (matched.size > 0) overlaps[extra.id] = Array.from(matched).sort();
  }

  return { conflictsWith: Object.keys(overlaps), overlaps };
}
