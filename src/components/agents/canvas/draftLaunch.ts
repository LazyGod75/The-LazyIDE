/* draftLaunch.ts — shared draft-launch flow (W4 dedup, spec §8.2 "the
   manager uses the SAME functions the UI uses, no parallel path").

   Single source of truth for "launch a Draft into a real mission", used by
   BOTH useCanvasEditing.ts's handleLaunchDraft (the human's ▶ button /
   context-menu "Lancer") and agentsStore.tsx's manager action executor
   (`launch_draft`). Resolves the draft straight from `canvasStoreVanilla`
   (the same global singleton every other canvas primitive reads/writes —
   see canvasStore.ts's own header) and refuses honestly (spec §3
   "Cross-project honesty rule") when the draft belongs to a currently
   INACTIVE project, WITHOUT silently switching or launching anywhere —
   that decision belongs to the CALLER:
     - useCanvasEditing.ts's hook performs the real `switchToProjectIfNeeded`
       + toast (its pre-existing UX, unchanged — see that file);
     - the manager executor has no business silently switching the user's
       active project on its own initiative (same rule chainEngine.ts's
       cross-project defer follows for chain fires), so it just reports the
       reason back as action feedback (a toast, same as every other
       executor case — see agentsStore.tsx's `launch_draft` case).

   On success, calls the injected `addMission` (its return type was widened
   from `void` to `Promise<string>` in W3 specifically so chainEngine.ts
   could remap a fired draft — see agentsStore.tsx's AgentsStoreValue doc
   comment) and atomically remaps the draft to the new mission id via
   `canvasStore.remapDraftToMission`. This fixes a real staleness gap in the
   pre-W4 useCanvasEditing.ts, which predated the W3 addMission signature
   change and still called a plain `removeDraft(draftId)` after launch —
   correct for removing the ghost card, but it left any chain POINTING AT
   that draft dangling (chainValidation.ts's targets, ChainEdge's tombstone
   styling) instead of being rewritten onto the new `mission:<id>` ref, the
   same atomic rewrite chainEngine.ts's own fire path already relies on
   (see canvasStore.ts's remapDraftToMission doc comment: "position
   preserved, outgoing/incoming chains rewritten to the new id").
*/

import { canvasStoreVanilla } from './canvasStore';
import { normalizeForMembershipCompare } from './canvasDigest';
import type { NewMissionInput } from '../agentsStore';
import { getEngineReadiness, engineReasonKey } from '../../../lib/models/entitlement';

/** Honest fallback when a draft carries no explicit model — mirrors
 *  useCanvasEditing.ts's own DEFAULT_DRAFT_MODEL_LABEL precedent (no
 *  primitive exists here to derive "the" default model; NewMissionModal's
 *  full provider-aware selection UI is out of scope for a launched draft). */
const DEFAULT_DRAFT_MODEL_LABEL = 'sonnet';

export interface LaunchDraftDeps {
  /** Real launch primitive (agentsStore's addMission) — returns the new
   *  mission's id (W3). */
  addMission: (input: NewMissionInput) => Promise<string>;
  /** The currently ACTIVE project's id (journal/canvas project-id space,
   *  i.e. `projectIdFromRoot(activeRoot)` — the same id space
   *  `DraftSpec.projectId` lives in), or `null` when no project is active.
   *  Callers resolve this however fits their own context (useCanvasEditing:
   *  AppContext's activeRoot; the manager executor:
   *  `projectIdFromRoot(await resolveProjectRoot())`, same as
   *  chainEngine.ts's own `getActiveProjectId` dep). */
  activeProjectId: string | null;
}

export type LaunchDraftResult = { ok: true; missionId: string } | { ok: false; reasonKey: string };

/**
 * Launches `draftId` into a real mission, or refuses honestly. Never
 * silently no-ops: every failure path returns a specific `reasonKey` (an
 * i18n key, not pre-translated text — this is a pure lib module with no
 * `t()`/useI18n access, same key-returning convention chainValidation.ts's
 * `reasonKey` and `lib/models/entitlement.ts`'s `engineReasonKey` already
 * established, see chainValidation.ts's header) so the caller can resolve
 * it via `t(result.reasonKey)` and surface it.
 */
export async function launchDraft(draftId: string, deps: LaunchDraftDeps): Promise<LaunchDraftResult> {
  const draft = canvasStoreVanilla.getState().drafts.find((d) => d.id === draftId);
  if (!draft) {
    return { ok: false, reasonKey: 'canvas.draftLaunch.notFound' };
  }

  // 2026-08-05 fix (reproduced live 3x: a draft launch into its OWN active
  // project was refused). Compared via normalizeForMembershipCompare
  // (canvasDigest.ts — the same primitive resolveProjectRootById already
  // uses for the identical class of bug) instead of raw strict equality: a
  // draft's projectId can be stamped with a different drive-letter case or
  // slash direction than the canonicalized deps.activeProjectId (e.g. a
  // manager action echoing its own path argument back), which made a launch
  // into the SAME, actually-active project refuse itself. Comparison-only —
  // draft.projectId is never rewritten/stored, only the transient key used
  // for this check is normalized.
  if (
    draft.projectId !== undefined &&
    (deps.activeProjectId === null ||
      normalizeForMembershipCompare(draft.projectId) !== normalizeForMembershipCompare(deps.activeProjectId))
  ) {
    // Cross-project honesty (spec §3/§7) — never launch into a project that
    // is not actually active right now. The caller decides what to do next
    // (real switch + retry for the UI hook, honest feedback for the
    // manager executor) — see this module's header.
    return { ok: false, reasonKey: 'canvas.draftLaunch.inactiveProject' };
  }

  // BUG-4: the canvas launch path had NO engine gate at all (unlike
  // NewMissionModal's preflight panel) — a draft could silently die with no
  // feedback when the global mode was pro/managed with an empty wallet.
  // Same modelId-aware readiness check as the mission modal, mirrored here.
  const readiness = getEngineReadiness(undefined, draft.model);
  if (!readiness.ready && readiness.reason) {
    return { ok: false, reasonKey: engineReasonKey(readiness.reason) };
  }

  const missionId = await deps.addMission({
    title: draft.title,
    agentTask: draft.task,
    agentName: draft.agentName,
    repo: '.',
    worktree: '',
    modelLabel: draft.model ?? DEFAULT_DRAFT_MODEL_LABEL,
    mode: 'agent',
    orchestrator: false,
    // Same fix DEFECT 2/D (agentsStore.tsx) already applied to every other
    // real launch path (NewMissionModal, chainEngine's attemptFire): without
    // an explicit permissionMode, the native CLI defaults to an interactive
    // approval prompt that never appears in-app and the mission stalls.
    // R13 — honors an explicit per-draft override (DraftSpec.permissionMode,
    // canvasTypes.ts) when the manager/user set one, falling back to the
    // same 'acceptEdits' default as before so every pre-existing draft
    // (created before this field existed) behaves identically.
    permissionMode: draft.permissionMode ?? 'acceptEdits',
    // W-CLOSE row 6 (single-node re-run in isolation) — forwards the draft's
    // own isolation flag (set only by CanvasContextMenu's "Relancer en
    // isolation" entry) onto the launched Mission unchanged, same
    // pass-through convention as permissionMode above.
    isolated: draft.isolated,
  });

  canvasStoreVanilla.getState().remapDraftToMission(draftId, missionId);
  return { ok: true, missionId };
}
