/* managerSignals.ts — derivation of the LazyManager rail's "live signals"
   feed (cockpit2 orchestrator upgrade), plus a persisted acknowledgment
   layer on top of it.

   Two owner-requested behaviors share ONE mechanism here:

   - QUESTION RELAY: a running mission's pending ask_user question should
     surface in the manager rail with an inline answer + quick
     Autoriser/Refuser buttons (traces AttentionInbox.tsx's 'question' kind
     — same extractPendingQuestionText-sourced signal, exposed fleet-wide as
     FleetMission.pendingQuestion by fleetMissions.ts).
   - PROACTIVE SIGNALS: when a mission enters review/failed, or a new
     question appears, the manager should post ONE concise line with real
     action buttons (Merger/Diff/Réessayer) — debounced, no spam.

   Design choice for "debounced, one line per event, no spam": rather than
   an ever-growing timeline of one-shot notifications (which needs its own
   dedup/expiry bookkeeping to avoid spam), a ManagerSignal is recomputed
   fresh from the CURRENT fleet snapshot every poll (deriveManagerSignals
   itself has no memory of its own) and keyed by `id` = `${kind}:${missionId}`.
   React's keyed reconciliation then gives the "one line per open event"
   property for free: the SAME mission staying urgent across polls renders
   the SAME bubble (no duplicate append), and a mission leaving its urgent
   state (answered/merged/retried) simply stops appearing next poll — no
   explicit "mark as seen"/expiry state to maintain, and nothing here can
   ever fabricate or accumulate stale entries. This mirrors
   AttentionInbox.tsx's own model (a live, source-of-truth-recomputed list),
   just re-skinned as manager-chat-style bubbles for the rail.

   Reuses cockpitHelpers.ts's rankUrgentMissions (the SAME classification
   already driving the AGENTS zone's urgent cards) instead of duplicating
   urgency logic — a mission is only ever "urgent" in one place.

   ARCHIVED MISSIONS (real user report fix): rankUrgentMissions/classifyUrgent
   (cockpitHelpers.ts) classify a mission purely from its status, with no
   `archived` check — an old failed/review mission the user archived (R13
   lifecycle, Mission.archived) kept generating the exact same signal forever
   since `project.missions` still includes it. deriveManagerSignals now drops
   an archived mission before classification, same as the Agent Canvas
   reconciler already does for the board itself.

   ACKNOWLEDGMENT (real user report fix, "j'ai des trucs échoués que je ne
   peux jamais supprimer donc ça pollue" — 29 stacked signals, some for
   missions that never resolve): deriveManagerSignals stays a pure function
   of its inputs (existing callers/tests are unaffected), but a signal is
   only ever "urgent" as long as its underlying mission stays in that exact
   state — an old failed mission the user isn't going to retry re-emits the
   SAME `id` (`${kind}:${missionId}`) every poll forever, with no way to say
   "I've seen this, stop showing it". useAcknowledgedSignals below adds a
   persisted (localStorage), per-id acknowledgment set alongside the pure
   derivation: `visibleManagerSignals` filters a signal list down to the
   ones NOT acknowledged. Acknowledging a signal only ever hides THAT exact
   (kind, missionId) pair — if the mission later changes status (e.g.
   failed -> retried -> review), its id changes too, so the new state's
   signal is unacknowledged and correctly resurfaces; this is not a
   permanent per-mission mute, it's a per-EVENT dismissal, exactly like
   closing a single notification.
*/

import { useCallback, useState } from 'react';
import type { FleetMission, FleetProject } from '../../../lib/agents/fleetMissions';
import { rankUrgentMissions, type UrgentKind } from './cockpitHelpers';

export type ManagerSignalKind = 'question' | 'review' | 'failed' | 'conflict';

/** One real action button on a signal bubble. `key` is the action key
 *  consumed by the same dispatch Cockpit.tsx already uses for urgent
 *  mission cards (handleUrgentAction) — 'merge' | 'diff' | 'retry' — so a
 *  signal button and a grid card button for the same mission call the
 *  exact same real primitive. */
export interface ManagerSignalButton {
  key: 'merge' | 'diff' | 'retry';
  labelKey: string;
  variant: 'primary' | 'outline';
}

export interface ManagerSignal {
  /** Stable per (kind, missionId) — React key AND the de-dupe key described
   *  in the module doc comment above. */
  id: string;
  kind: ManagerSignalKind;
  mission: FleetMission;
  projectId: string;
  projectName: string;
  /** Present only for kind 'question' — the real pending question text. */
  question?: string;
  buttons: ManagerSignalButton[];
}

const KIND_BY_URGENT: Record<UrgentKind, ManagerSignalKind> = {
  permission: 'question',
  failed: 'failed',
  review: 'review',
};

function buttonsFor(kind: ManagerSignalKind): ManagerSignalButton[] {
  switch (kind) {
    case 'review':
      return [
        { key: 'merge', labelKey: 'cockpit.action.merge', variant: 'primary' },
        { key: 'diff', labelKey: 'cockpit.action.diff', variant: 'outline' },
      ];
    case 'failed':
      return [
        { key: 'retry', labelKey: 'cockpit.action.retry', variant: 'primary' },
        { key: 'diff', labelKey: 'cockpit.action.logs', variant: 'outline' },
      ];
    case 'conflict':
      // Merge conflict honesty fix: Diff only — the merge was already
      // aborted server-side (git.rs), so there is no real "retry the exact
      // same merge" affordance that wouldn't just conflict again; the human
      // must look at the diff and resolve it themselves (outside the app,
      // or by adjusting the mission) before trying "Merger" again.
      return [{ key: 'diff', labelKey: 'cockpit.action.diff', variant: 'primary' }];
    case 'question':
      return [];
  }
}

/**
 * Fleet-wide live signal feed for the manager rail — real urgent missions
 * only (permission/failed/review, per rankUrgentMissions), re-skinned as
 * manager bubbles. Never fabricates a mission or question: `question` is
 * only ever the mission's own real `pendingQuestion` field.
 *
 * @param conflictedMissionIds - mission ids whose last "Merger" click ended
 *   in a real git conflict (Cockpit.tsx's local, session-only UI state, set
 *   from a thrown MergeConflictError — see agentsStore.tsx's approveMission
 *   and git.rs's agent_merge_worktree_inner doc comments for the abort-on-
 *   conflict mechanics). A conflicted mission stays status 'review' (the
 *   merge was aborted, nothing changed there), so it would otherwise still
 *   render as a normal 'review' signal — this overrides it to the honest
 *   'conflict' kind (Diff-only, no fake retry) instead of re-offering the
 *   same "Merger" button that just conflicted. Same ephemeral-overlay
 *   pattern as Cockpit.tsx's justMergedId/blockedApproveIds: never persisted
 *   onto the Mission itself, purely a session UI affordance.
 */
export function deriveManagerSignals(
  projects: FleetProject[],
  conflictedMissionIds?: ReadonlySet<string>,
): ManagerSignal[] {
  const projectNameById = new Map(projects.map((p) => [p.projectId, p.name] as const));
  return rankUrgentMissions(projects)
    // Archived-mission fix (see module doc comment): an archived mission is
    // no longer live on the board — never resurrect it as a fleet signal.
    .filter(({ mission }) => !mission.archived)
    .map(({ projectId, mission, kind }) => {
      const signalKind: ManagerSignalKind =
        conflictedMissionIds?.has(mission.id) && kind === 'review' ? 'conflict' : KIND_BY_URGENT[kind];
      return {
        id: `${signalKind}:${mission.id}`,
        kind: signalKind,
        mission,
        projectId,
        projectName: projectNameById.get(projectId) ?? projectId,
        question: signalKind === 'question' ? mission.pendingQuestion : undefined,
        buttons: buttonsFor(signalKind),
      };
    });
}

/** Find a signal's underlying FleetMission by id — convenience for callers
 *  that only have a missionId (e.g. a button's onClick closure built once
 *  per render). */
export function findSignalMission(signals: ManagerSignal[], missionId: string): FleetMission | undefined {
  return signals.find((s) => s.mission.id === missionId)?.mission;
}

// ── Acknowledgment (dismiss / clear-all) ─────────────────────────────────
//
// See the module doc comment's "ACKNOWLEDGMENT" section for the full
// rationale. Persisted to localStorage so a dismissed signal stays hidden
// across a reload, not just for the current session.

const ACK_STORAGE_KEY = 'lazy.managerSignals.acknowledged';

/** Reads the persisted acknowledgment set. Never throws — a corrupt/absent
 *  value (private browsing, quota, first run, manual edit) degrades to "no
 *  acknowledgments yet" rather than crashing the manager rail. */
function readAcknowledgedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(ACK_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

/** Persists the acknowledgment set. Best-effort — a write failure (quota,
 *  private mode) just means acknowledgment won't survive a reload, not a
 *  crash. */
function writeAcknowledgedIds(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(ACK_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Non-fatal — see doc comment above.
  }
}

export interface AcknowledgedSignalsState {
  /** True when `id` has been dismissed and should not render. */
  isAcknowledged: (id: string) => boolean;
  /** Dismiss one signal (its own "×" close button). */
  acknowledge: (id: string) => void;
  /** Dismiss every id in the list at once (the strip's "tout effacer"). */
  acknowledgeAll: (ids: readonly string[]) => void;
}

/**
 * Persisted, per-signal-id acknowledgment state for the manager rail's
 * signal strip. Deliberately separate from `deriveManagerSignals` (which
 * stays a pure function of its fleet snapshot, unchanged for every existing
 * caller/test) — callers combine the two via `visibleManagerSignals` below.
 */
export function useAcknowledgedSignals(): AcknowledgedSignalsState {
  const [ids, setIds] = useState<Set<string>>(() => readAcknowledgedIds());

  const acknowledge = useCallback((id: string) => {
    setIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      writeAcknowledgedIds(next);
      return next;
    });
  }, []);

  const acknowledgeAll = useCallback((newIds: readonly string[]) => {
    if (newIds.length === 0) return;
    setIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of newIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      if (!changed) return prev;
      writeAcknowledgedIds(next);
      return next;
    });
  }, []);

  const isAcknowledged = useCallback((id: string) => ids.has(id), [ids]);

  return { isAcknowledged, acknowledge, acknowledgeAll };
}

/**
 * Filters a derived signal list down to the ones NOT acknowledged — the
 * actual list a strip should render. Kept as a plain function (not baked
 * into the hook above) so it stays trivially testable without mounting
 * React: `visibleManagerSignals(deriveManagerSignals(projects), acked)`.
 */
export function visibleManagerSignals(
  signals: readonly ManagerSignal[],
  acknowledgedIds: ReadonlySet<string>,
): ManagerSignal[] {
  return signals.filter((s) => !acknowledgedIds.has(s.id));
}
