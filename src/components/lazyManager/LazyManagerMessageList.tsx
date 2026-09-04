/* LazyManagerMessageList — unified message rendering for both orchestrator
   and coder messages. In orchestrator mode, renders manager bubbles (with
   actions, signals, canvas chips) via the existing ManagerBubble pattern.
   In coder mode, renders the existing MessageList + BrainContextBanner.
   Signals are shown only in orchestrator mode.

   Fleet signals (ManagerSignalBubble) render in their OWN collapsible strip
   pinned above the scrollable thread, never interleaved with conversation
   messages — a fresh conversation (empty thread) used to be flooded with
   every open fleet signal before the first message even arrived. Default
   open/closed state derives from whether the thread is empty (collapsed on
   a brand new conversation, expanded once it has messages); a manual toggle
   overrides that until the thread empties again (a real newSession, not
   just a new turn), at which point it reverts to the derived default. */

import { type RefObject, useEffect, useRef, useState, memo } from 'react';
import { useI18n } from '../../i18n';
import type { ManagerMode } from './lazyManagerStore';
import type { ManagerMessage, ManagerAction } from '../../lib/agents/types';
import type { ChatMessage } from '../../lib/models';
import type { BrainRecallResult } from '../../lib/platform/types';
import type { FleetMission } from '../../lib/agents/fleetMissions';
import { type useAgentsStoreOptional, describePendingAction, describePendingActionDetail } from '../agents/agentsStore';
import type { ManagerSignal } from '../agents/cockpit/managerSignals';
import { useAcknowledgedSignals } from '../agents/cockpit/managerSignals';
import { ManagerSignalBubble } from '../agents/cockpit/ManagerSignalBubble';
import { MessageList } from '../assistant/MessageList';
import { BrainContextBanner } from '../assistant/BrainContextBanner';
import { MarkdownRenderer } from '../../lib/markdown';
import { emit } from '../../lib/bus';
import { makeRef } from '../agents/canvas/canvasTypes';
import { TRANSVERSE_PROJECT_ID } from '../agents/canvas/reconciler';
import { WAKEUP_MARKER_PREFIX } from '../../lib/agents/managerWakeup';
import { GraphProposalCard } from './GraphProposalCard';
import { PendingApprovalCard, type PendingApprovalItem, type PendingApprovalOutcome } from './PendingApprovalCard';
import { dedupeAdjacentParagraphs } from './dedupeMessageText';
import { sanitizeManagerDisplayText } from '../../lib/agents/managerEngine';
import { stripManagerErrorPrefixes } from '../../lib/agents/managerSessionGate';
import { stripVerbatimPrefixesInText } from '../../lib/paths';
import { truncateLabel, truncatePathLabel } from './truncateLabel';
import { MissionCharterCard } from './MissionCharterCard';
import { RegimeStatusCard } from './RegimeStatusCard';
import type { MissionCharter, RegimeStatus } from './missionCharter';
import { ArtifactProposalCard } from './ArtifactProposalCard';
import type { ArtifactProposal, ArtifactVariant } from './artifactProposal';
import {
  type ActionDispatchOutcome,
  charterActionKey,
  decisionActionKey,
  artifactActionKey,
  proposalActionKey,
  regimeActionKey,
  retryActionKey,
} from './useManagerActionQueue';

/**
 * Visible-artifact fix — see artifactProposal.ts's own INTEGRATION GAP doc
 * comment: `ManagerMessage` does not carry an `artifactProposal` field yet
 * (that addition belongs to lib/agents/types.ts, out of this task's locked
 * perimeter). This widened type lets `ManagerBubble` read it OPTIONALLY,
 * exactly the same recovery-without-modifying-the-owning-type technique
 * this file already uses just above for `PendingApprovalAction` (recovered
 * from agentsStore.tsx's own return type rather than that file exporting
 * it). Every REAL `ManagerMessage` today simply lacks this key, so
 * `msg.artifactProposal` reads `undefined` and the card renders nothing —
 * zero behavior change until a future sibling task actually populates it. */
type MessageWithArtifact = ManagerMessage & { artifactProposal?: ArtifactProposal };

/**
 * One gate-deferred action awaiting user resolution — structurally the
 * store's own (unexported) `PendingApprovalAction`, recovered via
 * `ReturnType<typeof useAgentsStoreOptional>` so this file never needs
 * agentsStore.tsx to export it (that file is out of this task's locked
 * perimeter). See agentsStore.tsx's PendingApprovalAction doc comment for
 * the full field-by-field contract.
 */
type AgentsStoreShape = NonNullable<ReturnType<typeof useAgentsStoreOptional>>;
export type PendingApprovalAction = AgentsStoreShape['pendingApprovals'][number];

/** Truncation budgets for actionSummary's chip labels below — kept as named
 *  constants (rather than inline magic numbers) now that every truncation
 *  call site MUST route through truncateLabel/truncatePathLabel (see that
 *  module's own doc comment for the real bug this fixes: a bare
 *  `.slice(0, N)` with no indicator could turn a path into a different,
 *  valid-looking, WRONG directory). PATH_LABEL_MAX_CHARS is deliberately
 *  larger than the plain-text budgets — a path needs enough room for both a
 *  recognizable root prefix AND its full final segment to stay meaningful. */
const TEXT_LABEL_MAX_CHARS = 32;
const TEXT_LABEL_MAX_CHARS_SHORT = 24;
const PATH_LABEL_MAX_CHARS = 60;

/**
 * RENDER-TIME backstop for leaked raw envelopes / Windows verbatim-prefix
 * paths (2026-08-15 coordinator follow-up to the artifactEnvelopeLeak +
 * worktreeMissing fixes). Both of those fixes sanitize at INGEST time only:
 * sanitizeManagerDisplayText runs once, inside runManagerTurn, on the text
 * that becomes a NEW ManagerMessage's `content`; stripVerbatimPrefixesInText
 * runs once, at the moment agentsStore.tsx's approveMissionInner throws
 * ApproveBlockedError. Neither is applied again afterward — messages persist
 * verbatim (managerPersistence.ts) and this component just reads
 * `msg.content`/`msg.displayContent` straight off the store, so a
 * conversation already on disk from BEFORE either fix shipped keeps
 * rendering its leak forever, even on a rebuilt binary that ingests cleanly
 * from now on. Confirmed live: a `<artifact>` envelope on an old message
 * (id `query-m7`) and a `\\?\`-prefixed worktree path inside a wakeup fact
 * built from an old `mission.approve_blocked` journal row (managerWakeup.ts's
 * formatWakeupFact/wakeupReasonSuffix embeds `candidate.reason` — itself
 * read straight from that persisted journal payload — with no sanitization
 * of its own, ever, on either the ingest OR render side).
 *
 * Rendering is the right choke point for this: it is idempotent (both
 * underlying functions are proven idempotent — see their own test suites),
 * needs no data migration, and can never corrupt the stored conversation —
 * it only ever affects what this one component paints on screen. Applied to
 * every non-user manager-facing string this file renders (the wakeup/system
 * chip's `displayContent ?? content`, and the assistant bubble's `content`);
 * deliberately NOT applied to the user's own bubble — a human's own typed
 * text is never leak-scrubbed.
 */
function sanitizeHistoricalManagerText(text: string): string {
  return stripManagerErrorPrefixes(
    stripVerbatimPrefixesInText(sanitizeManagerDisplayText(text)),
  );
}

function actionSummary(action: ManagerAction, t: (key: string, params?: Record<string, string | number>) => string): string {
  switch (action.type) {
    case 'launch_mission': return t('cockpit.manager.action.launched', { task: truncateLabel(action.task, TEXT_LABEL_MAX_CHARS) });
    case 'create_loop': return t('cockpit.manager.action.loop', { cadence: action.cadence, task: truncateLabel(action.task, TEXT_LABEL_MAX_CHARS_SHORT) });
    case 'stop_mission': return t('cockpit.manager.action.stopped', { id: action.missionId });
    case 'stop_all': return t('cockpit.manager.action.stopAll');
    case 'retry_mission': return t('cockpit.manager.action.retried', { id: action.missionId });
    case 'delete_mission': return t('cockpit.manager.action.deleted', { id: action.missionId });
    case 'clone_mission': return t('cockpit.manager.action.cloned', { id: action.missionId });
    case 'revert_mission': return t('cockpit.manager.action.reverted', { id: action.missionId });
    case 'reassign_agent': return t('cockpit.manager.action.reassigned', { model: action.model });
    case 'answer_question': return t('cockpit.manager.action.answered', { id: action.missionId });
    case 'set_budget': return t('cockpit.manager.action.budget', { limit: action.limitUsd });
    case 'brain_query':
    case 'brain_query_css':
    case 'brain_neighbours': return t('cockpit.manager.action.brainSearch');
    case 'web_search': return t('cockpit.manager.action.webSearch', { query: truncateLabel(action.query, TEXT_LABEL_MAX_CHARS_SHORT) });
    case 'web_fetch': return t('cockpit.manager.action.webFetch', { url: truncateLabel(action.url, TEXT_LABEL_MAX_CHARS_SHORT) });
    case 'query_mission': return t('cockpit.manager.action.queryMission', { id: action.missionId });
    case 'get_agent_output': return t('cockpit.manager.action.agentOutput', { id: action.missionId });
    case 'quote_mission': return t('cockpit.manager.action.quote', { task: truncateLabel(action.task, TEXT_LABEL_MAX_CHARS_SHORT) });
    case 'spawn_submissions': return t('cockpit.manager.action.spawned', { id: action.missionId });
    case 'set_approval_mode': return t('cockpit.manager.action.approvalMode', { mode: action.mode });
    case 'briefing_query': return t('cockpit.manager.action.briefing');
    case 'decision_lookup': return t('cockpit.manager.action.decision');
    case 'list_agents': return t('cockpit.manager.action.listAgents');
    case 'list_missions': return t('cockpit.manager.action.listMissions');
    case 'canvas_overview': return t('cockpit.manager.action.canvasOverview');
    case 'create_draft': return t('cockpit.manager.action.createDraft', { title: truncateLabel(action.title ?? action.task, TEXT_LABEL_MAX_CHARS) });
    case 'launch_draft': return t('cockpit.manager.action.launchDraft');
    case 'chain_agents': return t('cockpit.manager.action.chainAgents');
    case 'unchain': return t('cockpit.manager.action.unchain', { id: action.chainId });
    case 'arrange_canvas': return t('cockpit.manager.action.arrangeCanvas');
    case 'focus_canvas': return t('cockpit.manager.action.focusCanvas');
    case 'move_node': return t('cockpit.manager.action.moveNode');
    case 'canvas_note': return t('cockpit.manager.action.canvasNote', { text: truncateLabel(action.text, TEXT_LABEL_MAX_CHARS_SHORT) });
    case 'collapse_project': return t('cockpit.manager.action.collapseProject');
    case 'analyze_frictions': return t('cockpit.manager.action.analyzeFrictions');
    case 'pin_chain': return t('cockpit.manager.action.pinChain', { id: action.chainId });
    case 'unpin_chain': return t('cockpit.manager.action.unpinChain', { id: action.chainId });
    case 'refire_chain': return t('cockpit.manager.action.refireChain', { id: action.chainId });
    case 'approve_mission': return t('cockpit.manager.action.approved', { id: action.missionId });
    case 'reject_mission': return t('cockpit.manager.action.rejected', { id: action.missionId });
    case 'create_router': return t('cockpit.manager.action.createRouter');
    case 'open_report': return t('cockpit.manager.action.openReport');
    case 'save_macro': return t('cockpit.manager.action.saveMacro', { name: action.name });
    case 'instantiate_macro': return t('cockpit.manager.action.instantiateMacro', { name: action.name });
    case 'generate_plan': return t('cockpit.manager.action.generatePlan', { objective: truncateLabel(action.objective, TEXT_LABEL_MAX_CHARS) });
    case 'execute_plan': return t('cockpit.manager.action.executePlan', { id: action.planId });
    case 'revise_plan': return t('cockpit.manager.action.revisePlan', { id: action.planId });
    // reject_plan (types.ts) — added after this switch was last completed;
    // TS2366 fix: a switch over ManagerAction's discriminated union with no
    // `default` must cover every member for this function's inferred
    // `string` return type to type-check. Same "label only, no i18n copy
    // yet" convention as 'scan_project'/'propose_artifact' above.
    case 'reject_plan': return t('cockpit.manager.action.rejectPlan', { id: action.planId });
    case 'start_preview': return t('cockpit.manager.action.startPreview');
    case 'clear_canvas': return t('cockpit.manager.action.clearCanvas', { scope: action.scope });
    case 'archive_mission': return t('cockpit.manager.action.archived', { id: action.missionId });
    case 'archive_terminated': return t('cockpit.manager.action.archiveTerminated');
    case 'delete_draft': return t('cockpit.manager.action.deleteDraft', { id: action.draftId });
    case 'delete_note': return t('cockpit.manager.action.deleteNote', { id: action.noteId });
    case 'delete_router': return t('cockpit.manager.action.deleteRouter', { id: action.routerId });
    case 'delete_join': return t('cockpit.manager.action.deleteJoin', { id: action.joinId });
    case 'delete_frame': return t('cockpit.manager.action.deleteFrame', { id: action.frameId });
    case 'close_surface': return t('cockpit.manager.action.closeSurface', { id: action.surfaceId });
    // Same "label only, no i18n copy yet" convention as 'scan_project'/
    // 'propose_artifact'/'run_browser_recipe' below — t() falls back to the
    // raw key until proper copy is added (out of this action's perimeter).
    case 'open_project': return t('cockpit.manager.action.openProject', { path: truncatePathLabel(action.path, PATH_LABEL_MAX_CHARS) });
    case 'create_project': return t('cockpit.manager.action.createProject', { path: truncatePathLabel(action.path, PATH_LABEL_MAX_CHARS) });
    case 'close_project': return t('cockpit.manager.action.closeProject');
    case 'provision_service': return t('cockpit.manager.action.provision', { service: action.service });
    case 'teardown_service': return t('cockpit.manager.action.teardown', { id: action.serviceId });
    case 'self_improve': return t('cockpit.manager.action.selfImprove');
    case 'create_agent_template': return t('cockpit.manager.action.createTemplate', { id: action.missionId });
    case 'learn_pattern': return t('cockpit.manager.action.learnPattern', { trigger: truncateLabel(action.trigger, TEXT_LABEL_MAX_CHARS) });
    case 'launch_best_of_n': return t('cockpit.manager.action.bestOfN', { n: action.n, task: truncateLabel(action.task, TEXT_LABEL_MAX_CHARS_SHORT) });
    case 'fork_graph_run': return t('cockpit.manager.action.forkGraph', { id: action.planId });
    case 'resume_graph_run': return t('cockpit.manager.action.resumeGraph', { id: action.planId });
    case 'pause_loop': return t('cockpit.manager.action.pauseLoop', { id: action.loopId });
    case 'delete_loop': return t('cockpit.manager.action.deleteLoop', { id: action.loopId });
    case 'create_agent': return t('cockpit.manager.action.createAgent');
    // LazyBot wave — manager-driven bot lifecycle.
    case 'create_lazybot': return t('cockpit.manager.action.createLazybot', { name: action.name });
    case 'update_lazybot': return t('cockpit.manager.action.updateLazybot', { name: action.botId });
    case 'run_lazybot': return t('cockpit.manager.action.runLazybot', { name: action.botId });
    case 'stop_lazybot': return t('cockpit.manager.action.stopLazybot', { name: action.botId });
    case 'list_lazybots': return t('cockpit.manager.action.listLazybots');
    case 'info': return action.message;
    // Structural project digest (projectDigest.ts) — grounding action, same
    // display treatment as brain_query/brain_query_css/brain_neighbours
    // above (a label only; no i18n string added yet for this key, so t()
    // falls back to the raw key — see i18n/index.tsx's dict ?? fallbackDict
    // ?? key chain — until proper copy is added).
    case 'scan_project': return t('cockpit.manager.action.scanProject');
    // Mission charter (SPEC-CHARTE-DE-MISSION.md, Mission C) — same chip +
    // full-card pairing convention as 'generate_plan' above (chip here,
    // MissionCharterCard rendered below via msg.charterProposal).
    case 'propose_mission_charter': return t('cockpit.manager.action.proposeCharter', { objective: truncateLabel(action.objective, TEXT_LABEL_MAX_CHARS) });
    // Visible-artifact fix — same "label only, no i18n copy yet" convention
    // as 'scan_project'/'run_browser_recipe' above (this action's own file
    // perimeter excludes src/i18n/locales/*.ts); the real surface for this
    // action is ArtifactProposalCard below, this chip is secondary.
    case 'propose_artifact': return t('cockpit.manager.action.proposeArtifact', { name: truncateLabel(action.name, TEXT_LABEL_MAX_CHARS) });
    // Mission D (SPEC-CHARTE-DE-MISSION.md §5) — same "label only, no i18n
    // copy yet" convention as 'scan_project' above until proper copy lands.
    case 'run_browser_recipe': return t('cockpit.manager.action.runBrowserRecipe', { profile: action.recipe.profileName });
  }
}

function resolveCanvasFocusRef(
  actions: readonly ManagerAction[] | undefined,
  actionRefs?: readonly (string | undefined)[],
): string | undefined {
  if (!actions) return undefined;
  // P0 #4: prefer patched refs from execution when available — these are
  // the REAL canvas refs the executor generated (e.g. "draft:abc-123" for
  // create_draft, "mission:M12" for launch_mission), not heuristic guesses.
  if (actionRefs) {
    // Find the first action with a patched ref, prioritizing focus_canvas >
    // chain_agents > create_draft/launch_mission > others
    const priorityTypes = ['focus_canvas', 'chain_agents', 'create_draft', 'launch_mission', 'launch_draft'];
    for (const pt of priorityTypes) {
      const idx = actions.findIndex((a) => a.type === pt);
      if (idx >= 0 && actionRefs[idx]) return actionRefs[idx];
    }
    // Fall back to any patched ref
    const anyRef = actionRefs.find((r) => r);
    if (anyRef) return anyRef;
  }
  const focus = actions.find((a): a is Extract<ManagerAction, { type: 'focus_canvas' }> => a.type === 'focus_canvas');
  if (focus?.ref) return focus.ref;
  const chain = actions.find((a): a is Extract<ManagerAction, { type: 'chain_agents' }> => a.type === 'chain_agents');
  if (chain?.sourceRef) return chain.sourceRef;
  const alias = focus?.refAlias ?? chain?.sourceAlias;
  if (alias) {
    const aliased = actions.find(
      (a): a is Extract<ManagerAction, { type: 'create_draft' }> => a.type === 'create_draft' && a.alias === alias,
    );
    if (aliased) return makeRef('project', aliased.projectId ?? TRANSVERSE_PROJECT_ID);
  }
  const zoned = actions.find(
    (a): a is Extract<ManagerAction, { type: 'create_draft' | 'canvas_note' }> => a.type === 'create_draft' || a.type === 'canvas_note',
  );
  if (zoned) return makeRef('project', zoned.projectId ?? TRANSVERSE_PROJECT_ID);
  return undefined;
}

/**
 * Item 5 fix (real user QA, 2026-08-01, verbatim: "Focus canvas" does
 * nothing — a dead button next to two working ones): 'focus_canvas' used
 * to always get its own chip in the action-chip row below, same as every
 * other non-'info' action type. That chip is a plain `<span>` with no
 * `onClick` at all (unlike the REAL "Voir sur le canvas" button just above
 * it, `manager-canvas-focus-chip`, which resolveCanvasFocusRef already
 * resolves from this SAME action) — so it visually looked like a third
 * clickable pill in the same family, but clicking it genuinely did
 * nothing. Rather than half-build a second click handler that would just
 * duplicate the real button one line up, a SUCCESSFUL focus_canvas's chip
 * is dropped entirely — the working button already fully represents it. A
 * FAILED focus_canvas (`actionStatuses[i] === false`, e.g. an unresolvable
 * ref) keeps its chip: that is real, non-redundant information ("this
 * failed") the working button never shows, and hiding it would be a
 * silent failure — never acceptable in this codebase (see the pending/
 * denied styling just below, same "never degrade in silence" posture).
 */
function isVisibleActionChip(action: ManagerAction, failed: boolean): boolean {
  if (action.type === 'info') return false;
  if (action.type === 'focus_canvas' && !failed) return false;
  return true;
}

function CanvasChipIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 13.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

const cardActionButtonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', background: 'transparent',
  border: '1px solid var(--color-accent-border, rgba(124,92,255,0.4))',
  color: 'var(--color-accent-pale)', borderRadius: 8, padding: '5px 11px',
  fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
};

const ManagerBubble = memo(function ManagerBubble({
  msg,
  onFocusModel,
  onRetry,
  onAcceptProposal,
  onModifyProposal,
  onRejectProposal,
  onStepModelChange,
  pendingApprovals,
  onApprovePendingAction,
  onRejectPendingAction,
  onApproveAllPendingActions,
  onRejectAllPendingActions,
  onForcePendingAction,
  onAnswerDecision,
  onValidateCharter,
  onModifyCharter,
  onRejectCharter,
  onSelectArtifactVariant,
  onRejectArtifact,
  isActionQueued,
  isActionFailed,
}: {
  msg: ManagerMessage;
  onFocusModel: () => void;
  onRetry: (text: string, messageId: string) => ActionDispatchOutcome | void;
  onAcceptProposal: (planId: string, opts?: { stepIds?: string[] }) => void;
  onModifyProposal?: (planId: string) => void;
  onRejectProposal: () => void;
  /** Feature E — per-step model chip in the pending plan card. */
  onStepModelChange?: (planId: string, stepId: string, modelId: string) => void;
  pendingApprovals: PendingApprovalAction[];
  onApprovePendingAction: (id: string) => Promise<PendingApprovalOutcome>;
  onRejectPendingAction: (id: string) => void;
  onApproveAllPendingActions: (turnId: string) => Promise<Array<{ id: string } & PendingApprovalOutcome>>;
  onRejectAllPendingActions: (turnId: string) => void;
  /** Retries a failed approve_mission bypassing the judge/proof gate — see
   *  PendingApprovalCard.tsx's own doc comment. Optional, so every
   *  pre-existing caller/test that doesn't wire it up keeps compiling and
   *  rendering exactly as before (the card simply never shows the button). */
  onForcePendingAction?: (id: string) => Promise<PendingApprovalOutcome>;
  onAnswerDecision: (option: string, index: number, messageId: string) => ActionDispatchOutcome | void;
  onValidateCharter: (charter: MissionCharter, answeredDecisions: Record<number, string>, messageId: string) => ActionDispatchOutcome | void;
  onModifyCharter?: () => void;
  onRejectCharter: (messageId: string) => ActionDispatchOutcome | void;
  onSelectArtifactVariant: (proposal: ArtifactProposal, variant: ArtifactVariant, messageId: string) => ActionDispatchOutcome | void;
  onRejectArtifact: (proposal: ArtifactProposal, messageId: string) => ActionDispatchOutcome | void;
  /** Reactive queued-status reader from useManagerActionQueue.ts — see that
   *  module's doc comment. Defaults to "nothing queued" so every
   *  pre-existing caller/test that doesn't know about the queue yet keeps
   *  compiling and rendering exactly as before. */
  isActionQueued: (key: string) => boolean;
  /** NEVER DEGRADE IN SILENCE, round 2 (real user test, 2026-07-28 — see
   *  useManagerActionQueue.ts's own doc comment for the full repro):
   *  reactive real-result-failure reader, the counterpart to
   *  `isActionQueued` above. Optional, defaulting to "nothing ever failed"
   *  so every pre-existing caller/test keeps compiling and rendering
   *  exactly as before. */
  isActionFailed?: (key: string) => boolean;
}) {
  const { t } = useI18n();
  const isUser = msg.role === 'user';
  // Manager wakeup (managerWakeup.ts): a proactive turn's own "user" input is
  // still role 'user' — deliberately, so every provider backend (claude-code/
  // codex/managed) keeps receiving the exact same message shape it always
  // has, zero pipeline risk — but its content carries the shared
  // WAKEUP_MARKER_PREFIX ("🔔 ") so it renders as this same small system-chip
  // style instead of a normal user bubble, additive to the pre-existing
  // role==='system' branch below. See managerWakeup.ts's own doc comment on
  // WAKEUP_MARKER_PREFIX for why a content prefix, not a role, is the marker.
  const isWakeupMarker = isUser && msg.content.startsWith(WAKEUP_MARKER_PREFIX);
  if (msg.role === 'system' || isWakeupMarker) {
    return (
      <div
        data-testid={isWakeupMarker ? 'manager-wakeup-chip' : undefined}
        style={{ textAlign: 'center', fontSize: 10, color: 'var(--color-text-disabled)', padding: '4px 0' }}
      >
        {/* displayContent (real user report, 2026-08-01 QA): a wakeup turn's
            `content` also carries the internal directive the MODEL needs
            ("check the follow-up... reply in French") — a human reading
            this chip never needs that clause. Falls back to `content` for
            every ordinary system message, which has no displayContent and
            renders exactly as before. See ManagerMessage.displayContent's
            own doc comment / agentsStore.tsx's formatWakeupDisplayMessage. */}
        {sanitizeHistoricalManagerText(msg.displayContent ?? msg.content)}
      </div>
    );
  }
  const canvasFocusRef = !isUser ? resolveCanvasFocusRef(msg.actions, msg.actionRefs) : undefined;
  // 2026-08-06 (founder, verbatim: "je veux pas voir ce texte Résultat réel
  // : …") — real-result reports are addressed to the MANAGER's context, not
  // the human's: agentsStore stamps them `displayContent: ''` and this row
  // renders nothing for them. The message itself STAYS in the conversation
  // store, so the LLM keeps reading the real outcome on its next turn.
  // The content-prefix check also covers messages created before the
  // displayContent stamp existed (already persisted in the store).
  if (!isUser && (msg.displayContent === '' || msg.content.startsWith(t('agents.manager.realResult', { result: '' })))) {
    const prefix = t('agents.manager.realResult', { result: '' });
    const shown = (msg.displayContent && msg.displayContent.length > 0)
      ? msg.displayContent
      : msg.content.startsWith(prefix) ? msg.content.slice(prefix.length).trim() : msg.content;
    if (!shown) return null;
    return (
      <div
        data-testid="manager-real-result"
        style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--color-text-muted)', padding: '4px 16px' }}
      >
        {sanitizeHistoricalManagerText(shown)}
      </div>
    );
  }
  // See PendingApprovalCard.tsx's module doc comment for the MOUNTING
  // CONTRACT this relies on: it must be rendered unconditionally below
  // (never gated on msgPendingItems.length), mapped from the store's own
  // (unexported) PendingApprovalAction into the plain shape the card needs.
  const msgPendingItems: PendingApprovalItem[] = isUser
    ? []
    : pendingApprovals
        .filter((p) => p.messageId === msg.id)
        .map((p) => ({
          id: p.id,
          label: p.label,
          // Truncation-reachability fix (real user report, 2026-08-01 QA):
          // `label` above can still be a compact, truncated preview (see
          // describePendingAction's own doc comment) — `detail` is the FULL,
          // untruncated text, derived fresh from the same action so a human
          // can always read exactly what he is approving via the card's
          // expand affordance (PendingApprovalCard.tsx).
          detail: describePendingActionDetail(p.action, t),
          turnId: p.turnId,
          lastFailure: p.lastFailure,
        }));
  // NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — reactive queued
  // status for this message's own retry button.
  const retryQueued = isActionQueued(retryActionKey(msg.id));
  // NEVER DEGRADE IN SILENCE, round 2 (useManagerActionQueue.ts) — defaults
  // to "nothing ever failed" so every pre-existing caller/test that doesn't
  // pass `isActionFailed` keeps rendering exactly as before.
  const failCheck = isActionFailed ?? (() => false);
  const isStreaming = !isUser && msg.isStreaming === true;
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', animation: 'fade-in 0.18s ease-out' }}>
      <div
        data-testid={isUser ? 'manager-message-user' : 'manager-message-assistant'}
        data-streaming={isStreaming ? 'true' : undefined}
        style={{
          maxWidth: isUser ? '88%' : '94%',
          background: isUser ? 'var(--color-accent)' : 'var(--color-panel-2)',
          color: isUser ? '#fff' : 'var(--color-text-secondary)',
          border: isUser ? 'none' : '1px solid rgba(255,255,255,0.1)',
          borderRadius: 11,
          borderTopLeftRadius: isUser ? 11 : 4,
          borderBottomRightRadius: isUser ? 4 : 11,
          padding: isUser ? '9px 13px' : '10px 13px',
          fontSize: 13.5,
          lineHeight: isUser ? 1.5 : 1.55,
          // Markdown fix (real user report, 2026-08-01 QA): the assistant
          // side now renders through MarkdownRenderer below, which owns its
          // own paragraph/list/heading spacing (markdownStyles.ts) — a
          // whiteSpace:pre-wrap inherited from THIS wrapper would double up
          // with that (every single '\n' the model happens to leave inside a
          // paragraph would ALSO force a hard line break on top of the
          // renderer's own margins). The user side is still plain typed
          // text with no markdown parsing, so it keeps pre-wrap exactly as
          // before (a user's own line breaks must render verbatim).
          whiteSpace: isUser ? 'pre-wrap' : 'normal',
          wordBreak: 'break-word',
        }}
      >
        {isUser ? (
          msg.content
        ) : (
          // Markdown fix — reuses the SAME renderer as the coder chat
          // (MessageList.tsx's AssistantMessage) instead of raw text, so
          // **bold**/*italic*/`code`/lists/links the manager writes
          // constantly no longer show up as literal asterisks. Defaults
          // (plain read-only code blocks, plain citation text) are
          // intentional here — the manager transcript has no
          // apply-to-file/brain-citation context, same posture as
          // MarkdownPreview.tsx's own use of the defaults. Never renders raw
          // HTML (see MarkdownRenderer.tsx's own SAFETY doc comment) — every
          // text token becomes a React text child, so anything resembling a
          // script/event-handler in the model's output is inert, literal
          // text only.
          <>
            {msg.compactNotice ? (
              <div
                data-testid="manager-compact-notice"
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-secondary)',
                  marginBottom: 8,
                  opacity: 0.85,
                }}
              >
                {msg.compactNotice}
              </div>
            ) : null}
            {msg.content.trim().length > 0 ? (
              <MarkdownRenderer content={dedupeAdjacentParagraphs(sanitizeHistoricalManagerText(msg.content))} />
            ) : isStreaming ? (
              <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                {t('cockpit.manager.thinking')}
              </span>
            ) : null}
            {isStreaming && (
              <span
                data-testid="manager-stream-caret"
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 13,
                  background: 'var(--color-accent)',
                  marginLeft: 3,
                  borderRadius: 1,
                  animation: 'blink 0.8s step-end infinite',
                  verticalAlign: 'text-bottom',
                }}
              />
            )}
          </>
        )}
        {/* fix/manager-question-triplicate (defect 2a) \u2014 'info' actions are
            excluded from this chip row: agentsStore.tsx's turnDisplayText
            ALWAYS folds every 'info' action's own `message` into `msg.content`
            already (the bubble's own prose, above), so re-rendering it here
            as a chip is never new information \u2014 it is the SAME field shown a
            second time via a second code path. For a short info message this
            chip still just read as a slightly redundant pill, easy to miss;
            for a long one (a restated clarifying question, the real-user
            repro this fixes) the chip wraps to a full-width highlighted box
            that reads as the question being asked a third time in the SAME
            bubble. Every other action type still renders its chip exactly as
            before \u2014 only 'info' (whose text is guaranteed to already be in
            the prose above, see turnDisplayText's own join) is suppressed.
            A successful 'focus_canvas' is ALSO suppressed here \u2014 see
            isVisibleActionChip's own doc comment (item 5 fix) for why. */}
        {!isUser && msg.actions && msg.actions.some((a, i) => isVisibleActionChip(a, msg.actionStatuses?.[i] === false)) && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {msg.actions.map((action, i) => {
              const status = msg.actionStatuses?.[i];
              const failed = status === false;
              if (!isVisibleActionChip(action, failed)) return null;
              // CONSENT-BYPASS FIX: a THIRD status, distinct from both a
              // genuine success and a denial/pending-approval `false` \u2014
              // this action arrived in the SAME turn as a `generate_plan`
              // and was never executed NOR sent through the approval gate
              // yet (see types.ts's ActionStatus doc comment). It only gets
              // gated for real (agentsStore.tsx's executePlan) once the
              // user validates the plan, at which point this same index is
              // patched to `true`/`false` \u2014 never shown as a success before
              // that has genuinely happened.
              const isDeferred = status === 'deferred';
              // Chip style fix (real user test, 2026-07-28): `actionStatuses`
              // marks BOTH a denied action and a gate-deferred ('ask') one
              // the exact same way (`false` \u2014 see agentsStore.tsx's
              // sendManagerMessage) \u2014 this used to render them identically
              // (red, crossed out), which itself reads as a final refusal
              // even though a deferred action can still be approved. A
              // pending one is cross-referenced against the LIVE
              // `pendingApprovals` queue (still awaiting a decision for
              // THIS exact action) and gets its OWN distinct amber/"waiting"
              // treatment \u2014 never the crossed-out red of a real denial, and
              // never the plain accent of a genuine success.
              const pendingMatch = failed
                ? pendingApprovals.find((p) => p.messageId === msg.id && p.actionIndex === i)
                : undefined;
              const isPending = !!pendingMatch;
              const isDenied = failed && !isPending;
              // Optimistic-tense fix (real user report, 2026-08-15 \u2014 "\u23f3
              // Lanc\u00e9e" repro): actionSummary() below always phrases every
              // action type in the COMPLETED past tense ("Lanc\u00e9e", "Approuv\u00e9e",
              // ...) \u2014 correct once the action really ran, but a `gate.decision
              // === 'ask'` action (see agentsStore.tsx's sendManagerMessage) was
              // never executed at all: it only sits in `pendingApprovals` awaiting
              // a human click. Pairing that untouched past-tense text with the
              // amber "\u23f3 waiting" chip read as a contradiction \u2014 "\u23f3 Lanc\u00e9e"
              // literally says "already launched" while nothing has started \u2014
              // and was the root of the founder's "the manager claims success but
              // nothing happened" report (verified: the action WAS queued
              // correctly, only the wording lied about its state). Reuses
              // `pendingMatch.label` \u2014 the SAME describePendingAction() string
              // already shown, honestly, in the pending-approval bar/card
              // ("Lancer la mission : ...", present/infinitive) \u2014 instead of
              // actionSummary's own completed-tense copy, so the chip and the
              // approval surface never disagree about whether the action ran.
              // A `'deferred'` action gets the SAME present/infinitive
              // treatment for the SAME reason \u2014 it has not run either.
              return (
                <span
                  key={i}
                  data-testid={
                    isDeferred ? `manager-action-chip-deferred-${i}`
                      : isPending ? `manager-action-chip-pending-${i}`
                        : `manager-action-chip-${action.type}-${i}`
                  }
                  style={{
                    background: isDeferred ? 'rgba(100,116,139,0.16)' : isPending ? 'rgba(217,119,6,0.16)' : isDenied ? 'rgba(220,38,38,0.18)' : 'rgba(124,92,255,0.18)',
                    border: `1px solid ${isDeferred ? 'rgba(100,116,139,0.45)' : isPending ? 'rgba(217,119,6,0.45)' : isDenied ? 'rgba(220,38,38,0.45)' : 'rgba(124,92,255,0.45)'}`,
                    color: isDeferred ? 'var(--color-text-muted)' : isPending ? '#fbbf24' : isDenied ? '#fca5a5' : 'var(--color-accent-pale)',
                    borderRadius: 8, padding: '5px 11px', fontSize: 12.5, fontWeight: 700,
                    textDecoration: isDenied ? 'line-through' : 'none', opacity: isDenied ? 0.7 : 1,
                  }}
                  title={
                    isDeferred ? t('lazyManager.proposal.deferredActionChipTitle')
                      : isPending ? t('lazyManager.approval.chipPending')
                        : isDenied ? 'Action failed' : undefined
                  }
                >
                  {isDeferred ? '\u{1f553} ' : isPending ? '\u23f3 ' : isDenied ? '\u2717 ' : ''}
                  {isDeferred ? describePendingAction(action, t) : isPending && pendingMatch ? pendingMatch.label : actionSummary(action, t)}
                </span>
              );
            })}
          </div>
        )}
        {!isUser && msg.approxCreditsUsed !== undefined && (
          <div data-testid="manager-turn-cost" style={{ marginTop: 6, fontSize: 10.5, color: 'var(--color-text-disabled)' }}>
            {t('cockpit.manager.approxCredits', { count: msg.approxCreditsUsed })}
          </div>
        )}
        {!isUser && msg.creditsBlocked && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <button type="button" data-testid="manager-credits-recharge" onClick={() => emit('nav:openAccountPopover', undefined)} style={cardActionButtonStyle}>
              {t('cockpit.manager.noCreditsRecharge')}
            </button>
            <button type="button" data-testid="manager-credits-change-model" onClick={onFocusModel} style={cardActionButtonStyle}>
              {t('cockpit.manager.noCreditsChangeModel')}
            </button>
          </div>
        )}
        {!isUser && msg.sessionBlocked && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <button type="button" data-testid="manager-session-signin" onClick={() => emit('nav:navigateSpace', { space: 'account', tab: 'signin' })} style={cardActionButtonStyle}>
              {t('cockpit.manager.sessionRequiredSignIn')}
            </button>
          </div>
        )}
        {!isUser && msg.timedOut && msg.retryText && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
            <button
              type="button"
              data-testid="manager-retry"
              onClick={() => onRetry(msg.retryText!, msg.id)}
              disabled={retryQueued}
              style={{ ...cardActionButtonStyle, opacity: retryQueued ? 0.5 : 1, cursor: retryQueued ? 'default' : 'pointer' }}
            >
              {t('cockpit.manager.retry')}
            </button>
            {retryQueued && (
              <span data-testid="manager-retry-queued" style={{ fontSize: 10.5, color: 'var(--color-warning)' }}>
                {t('lazyManager.actionQueued')}
              </span>
            )}
          </div>
        )}
        {!isUser && canvasFocusRef && (
          <button
            type="button"
            data-testid="manager-canvas-focus-chip"
            onClick={() => {
              emit('nav:navigateSpace', 'agents');
              emit('canvas:focus', { ref: canvasFocusRef });
            }}
            style={{
              marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 5,
              background: 'transparent', border: '1px solid var(--color-accent-border, rgba(124,92,255,0.4))',
              color: 'var(--color-accent-pale)', borderRadius: 8, padding: '4px 10px',
              fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <CanvasChipIcon />
            {t('canvas.rail.viewOnCanvas')}
          </button>
        )}
        {!isUser && msg.proposal && (
          <GraphProposalCard
            msg={msg}
            onAccept={onAcceptProposal}
            onModify={onModifyProposal}
            onReject={onRejectProposal}
            onStepModelChange={onStepModelChange}
            isActionQueued={isActionQueued(proposalActionKey(msg.proposal.planId ?? msg.id))}
          />
        )}
        {/* MOUNTING CONTRACT (see PendingApprovalCard.tsx's own doc
            comment): rendered unconditionally, never `msgPendingItems.length
            > 0 && (...)` — the card decides internally whether it has
            anything to show, and must stay mounted across the
            pending -> resolved transition to keep its own history. */}
        {!isUser && (
          <PendingApprovalCard
            pending={msgPendingItems}
            onApprove={onApprovePendingAction}
            onReject={onRejectPendingAction}
            onApproveAll={onApproveAllPendingActions}
            onRejectAll={onRejectAllPendingActions}
            onForce={onForcePendingAction}
          />
        )}
        {!isUser && msg.charterProposal && (
          <MissionCharterCard
            charterProposal={msg.charterProposal}
            onAnswerDecision={(option, index) => onAnswerDecision(option, index, msg.id)}
            onValidate={(charter, answeredDecisions) => onValidateCharter(charter, answeredDecisions, msg.id)}
            onModify={onModifyCharter}
            onReject={() => onRejectCharter(msg.id)}
            isActionQueued={isActionQueued(charterActionKey(msg.id))}
            isDecisionQueued={(index) => isActionQueued(decisionActionKey(msg.id, index))}
            isActionFailed={failCheck(charterActionKey(msg.id))}
            isDecisionFailed={(index) => failCheck(decisionActionKey(msg.id, index))}
          />
        )}
        {/* Visible-artifact fix — see this file's own `MessageWithArtifact`
            comment above: renders once a future sibling task actually
            populates `ManagerMessage.artifactProposal`; a plain no-op today. */}
        {!isUser && (msg as MessageWithArtifact).artifactProposal && (
          <ArtifactProposalCard
            proposal={(msg as MessageWithArtifact).artifactProposal!}
            onSelectVariant={(variant) => onSelectArtifactVariant((msg as MessageWithArtifact).artifactProposal!, variant, msg.id)}
            onReject={() => onRejectArtifact((msg as MessageWithArtifact).artifactProposal!, msg.id)}
            isActionQueued={isActionQueued(artifactActionKey(msg.id))}
          />
        )}
      </div>
    </div>
  );
});

function TypingDot({ delay }: { delay: string }) {
  return (
    <span style={{
      width: 5, height: 5, borderRadius: '50%', background: 'var(--color-text-muted)',
      display: 'inline-block', animation: 'lm-pulse 1.4s ease-in-out infinite', animationDelay: delay,
    }} />
  );
}

function ManagerTypingBubble({ groundingLabel }: { groundingLabel?: string }) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div
        data-testid="manager-typing-indicator"
        style={{
          maxWidth: '80%', background: 'var(--color-panel-2)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 11, borderTopLeftRadius: 4, padding: '10px 13px', display: 'flex',
          flexDirection: 'column', gap: 5,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ display: 'inline-flex', gap: 3 }}>
            <TypingDot delay="0s" /><TypingDot delay="0.2s" /><TypingDot delay="0.4s" />
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
            {t('cockpit.manager.thinking')}
          </span>
        </div>
        {groundingLabel && (
          <div data-testid="manager-grounding-status" style={{ fontSize: 11, color: 'var(--color-accent-pale)' }}>
            {groundingLabel}
          </div>
        )}
      </div>
    </div>
  );
}

/** Above this many currently-visible signals, the strip starts collapsed
 *  even on a thread that already has messages — a real user reported 29
 *  stacked signal cards burying the conversation; a big pile should require
 *  an explicit expand, not shove the chat out of view by default. */
const SIGNALS_AUTO_COLLAPSE_THRESHOLD = 8;

interface LazyManagerMessageListProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Scroll intent tracking for the auto-scroll policy in LazyManager.tsx —
   *  fired on ANY scroll of the message container (user wheel/touch/drag
   *  AND programmatic), so the owner can keep a sticky "is the reader at
   *  the bottom" flag. Optional, no-op default so every pre-existing
   *  caller/test keeps compiling and rendering exactly as before. */
  onScroll?: () => void;
  mode: ManagerMode;
  busy: boolean;
  phase: 'idle' | 'turn' | 'grounding' | 'streaming' | 'queued';
  signals: ManagerSignal[];
  onAnswerSignal: (mission: FleetMission, projectId: string, question: string, answer: string) => void;
  onSignalAction: (mission: FleetMission, actionKey: string) => void;
  messagesOverride?: ManagerMessage[];
  managerMessages: ManagerMessage[];
  assistantMessages: ChatMessage[];
  onFocusModel: () => void;
  onRetry: (text: string, messageId: string) => ActionDispatchOutcome | void;
  onAcceptProposal: (planId: string, opts?: { stepIds?: string[] }) => ActionDispatchOutcome | void;
  onModifyProposal?: (planId: string) => ActionDispatchOutcome | void;
  onRejectProposal: (planId: string) => ActionDispatchOutcome | void;
  /** Feature E — per-step model chip in the pending plan card. */
  onStepModelChange?: (planId: string, stepId: string, modelId: string) => void;
  brainRecall: BrainRecallResult | null;
  brainError: string | null;
  brainEnabled: boolean;
  onRetryBrain: () => Promise<void>;
  /** Gate-deferred actions awaiting user resolution — see
   *  PendingApprovalCard.tsx's module doc comment. Optional (defaults to
   *  empty) so every pre-existing caller/test that doesn't know about
   *  approval gating yet keeps compiling and rendering exactly as before. */
  pendingApprovals?: PendingApprovalAction[];
  onApprovePendingAction?: (id: string) => Promise<PendingApprovalOutcome>;
  onRejectPendingAction?: (id: string) => void;
  onApproveAllPendingActions?: (turnId: string) => Promise<Array<{ id: string } & PendingApprovalOutcome>>;
  onRejectAllPendingActions?: (turnId: string) => void;
  /** Retries a failed approve_mission bypassing the judge/proof gate — see
   *  PendingApprovalCard.tsx's own doc comment. Optional, no-op default so
   *  every pre-existing caller/test keeps compiling and rendering exactly
   *  as before (the card simply never shows the "force" button). */
  onForcePendingAction?: (id: string) => Promise<PendingApprovalOutcome>;
  /** Mission charter surface (SPEC-CHARTE-DE-MISSION.md, Mission C) — all
   *  optional with no-op defaults so every pre-existing caller/test keeps
   *  compiling and rendering exactly as before, same convention as the
   *  pendingApprovals props above. */
  onAnswerDecision?: (option: string, index: number, messageId: string) => ActionDispatchOutcome | void;
  onValidateCharter?: (charter: MissionCharter, answeredDecisions: Record<number, string>, messageId: string) => ActionDispatchOutcome | void;
  onModifyCharter?: () => void;
  onRejectCharter?: (messageId: string) => ActionDispatchOutcome | void;
  /** Visible-artifact fix — optional, no-op default so every pre-existing
   *  caller/test keeps compiling and rendering exactly as before, same
   *  convention as the charter props above. */
  onSelectArtifactVariant?: (proposal: ArtifactProposal, variant: ArtifactVariant, messageId: string) => ActionDispatchOutcome | void;
  onRejectArtifact?: (proposal: ArtifactProposal, messageId: string) => ActionDispatchOutcome | void;
  /** Active recurring/permanent regimes, shown in a persistent strip above
   *  the thread so their trial/validated/autonomous state stays visible
   *  "en continu" (spec §4), independent of which message reported it. */
  activeRegimes?: RegimeStatus[];
  onRevertRegimeToTrial?: (id: string) => ActionDispatchOutcome | void;
  onStopRegime?: (id: string) => ActionDispatchOutcome | void;
  /** NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — reactive reader
   *  for whether a given action key is currently queued (taken in charge,
   *  not yet sent). Optional, defaulting to "nothing ever queued" so every
   *  pre-existing caller/test that doesn't know about the queue yet keeps
   *  compiling and rendering exactly as before. */
  isActionQueued?: (key: string) => boolean;
  /** NEVER DEGRADE IN SILENCE, round 2 (real user test, 2026-07-28 — see
   *  useManagerActionQueue.ts's own doc comment for the full repro):
   *  reactive real-result-failure reader, the counterpart to
   *  `isActionQueued` above. Optional, defaulting to "nothing ever failed"
   *  so every pre-existing caller/test keeps compiling and rendering
   *  exactly as before. */
  isActionFailed?: (key: string) => boolean;
}

export function LazyManagerMessageList({
  scrollRef,
  onScroll,
  mode,
  busy,
  phase,
  signals,
  onAnswerSignal,
  onSignalAction,
  messagesOverride,
  managerMessages,
  assistantMessages,
  onFocusModel,
  onRetry,
  onAcceptProposal,
  onModifyProposal,
  onRejectProposal,
  onStepModelChange,
  brainRecall,
  brainError,
  brainEnabled,
  onRetryBrain,
  pendingApprovals = [],
  onApprovePendingAction = () => Promise.resolve({ ok: false }),
  onRejectPendingAction = () => {},
  onApproveAllPendingActions = () => Promise.resolve([]),
  onRejectAllPendingActions = () => {},
  onForcePendingAction,
  onAnswerDecision = () => {},
  onValidateCharter = () => {},
  onModifyCharter,
  onRejectCharter = () => {},
  onSelectArtifactVariant = () => {},
  onRejectArtifact = () => {},
  activeRegimes = [],
  onRevertRegimeToTrial = () => {},
  onStopRegime = () => {},
  isActionQueued = () => false,
  isActionFailed = () => false,
}: LazyManagerMessageListProps) {
  const { t } = useI18n();
  const displayMessages = messagesOverride ?? managerMessages;

  // Acknowledgment (dismiss / clear-all) — see managerSignals.ts's own doc
  // comment for the full rationale (real user report: 29 stacked signals,
  // some for missions that never resolve, with no way to dismiss them).
  const { isAcknowledged, acknowledge, acknowledgeAll } = useAcknowledgedSignals();
  const visibleSignals = signals.filter((s) => !isAcknowledged(s.id));

  // Signals strip open/closed state — see the module doc comment above for
  // the "collapsed on a fresh thread, expanded otherwise" rule. `null` means
  // "no manual override" (follow the derived default); a user click sets an
  // explicit boolean that sticks until the thread transitions back to empty.
  // Also collapsed by default beyond SIGNALS_AUTO_COLLAPSE_THRESHOLD, even
  // on a non-empty thread (see that constant's doc comment).
  const [signalsOverride, setSignalsOverride] = useState<boolean | null>(null);
  const prevMessageCountRef = useRef(displayMessages.length);
  useEffect(() => {
    const wasEmpty = prevMessageCountRef.current === 0;
    const isEmpty = displayMessages.length === 0;
    if (!wasEmpty && isEmpty) setSignalsOverride(null);
    prevMessageCountRef.current = displayMessages.length;
  }, [displayMessages.length]);
  const signalsExpanded =
    signalsOverride ?? (displayMessages.length > 0 && visibleSignals.length <= SIGNALS_AUTO_COLLAPSE_THRESHOLD);

  if (mode === 'coder') {
    return (
      <>
        <BrainContextBanner recall={brainRecall} brainError={brainError} brainEnabled={brainEnabled} onRetryBrain={onRetryBrain} />
        <div ref={scrollRef} onScroll={onScroll} style={{ flex: 1, padding: '14px 16px', overflowY: 'auto', minHeight: 0 }}>
          {assistantMessages.length === 0 && !busy && (
            <div style={{ textAlign: 'center', padding: '24px 0', fontSize: 12, color: 'var(--color-text-disabled)', lineHeight: 1.6 }}>
              {t('lazyManager.emptyCoder')}
            </div>
          )}
          <MessageList messages={assistantMessages} />
        </div>
      </>
    );
  }

  // Orchestrator mode
  return (
    <>
      {visibleSignals.length > 0 && (
        // P2-17 fix: this strip used to have no background of its own, so the
        // gaps between cards (and the toggle row) were fully transparent —
        // under this panel's backdrop-filter glass effect, the scrollable
        // messages thread right below it could paint through those gaps,
        // reading as "message text behind the signal cards". An explicit
        // opaque background plus its own stacking context (position+zIndex,
        // ABOVE the messages thread below) makes the strip a real solid
        // layer that nothing can show through, independent of any paint-
        // order edge case between the two independently-scrolling regions —
        // not a masking overflow:hidden, an actual solid+ordered layer.
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            flexShrink: 0,
            background: 'var(--color-panel-2)',
            borderBottom: '1px solid var(--color-border-2)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <button
              type="button"
              data-testid="manager-signals-strip-toggle"
              onClick={() => setSignalsOverride(!signalsExpanded)}
              aria-expanded={signalsExpanded}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 8, padding: '8px 16px', background: 'transparent', border: 'none',
                color: 'var(--color-warning)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <span>{t('lazyManager.signalsStrip', { count: visibleSignals.length })}</span>
              <span aria-hidden="true" style={{ transform: signalsExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                ▾
              </span>
            </button>
            {/* "Tout effacer" (real user report: 29 stacked signals with no
                way to clear them) — acknowledges every currently-visible
                signal at once, same persisted mechanism as a single "×". */}
            <button
              type="button"
              data-testid="manager-signals-strip-clear-all"
              onClick={() => acknowledgeAll(visibleSignals.map((s) => s.id))}
              style={{
                flexShrink: 0, marginRight: 10, padding: '5px 10px', fontSize: 11, fontWeight: 700,
                borderRadius: 7, border: '1px solid var(--color-border-2)', background: 'transparent',
                color: 'var(--color-text-muted)', cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {t('lazyManager.signalsStripClearAll')}
            </button>
          </div>
          {signalsExpanded && (
            <div
              data-testid="manager-signals-strip-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 16px 10px', maxHeight: 220, overflowY: 'auto' }}
            >
              {visibleSignals.map(signal => (
                <div key={signal.id} style={{ position: 'relative' }}>
                  <ManagerSignalBubble signal={signal} onAnswer={onAnswerSignal} onAction={onSignalAction} />
                  {/* Per-card close button (real user report: signals "que
                      je ne peux jamais supprimer") — an absolutely
                      positioned overlay so ManagerSignalBubble.tsx itself
                      (out of this task's perimeter) needs no changes. */}
                  <button
                    type="button"
                    data-testid={`manager-signal-dismiss-${signal.id}`}
                    aria-label={t('lazyManager.signalDismiss')}
                    onClick={() => acknowledge(signal.id)}
                    style={{
                      position: 'absolute', top: 6, right: 6, width: 20, height: 20,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,0.08)',
                      color: 'var(--color-text-muted)', fontSize: 12, lineHeight: 1, cursor: 'pointer',
                      fontFamily: 'inherit', padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Persistent regime status strip — "en continu" (spec §4): stays
          visible above the thread regardless of which message reported the
          transition, independent of the signals strip above. */}
      {activeRegimes.length > 0 && (
        <div
          data-testid="lazy-manager-regimes-strip"
          style={{
            flexShrink: 0, padding: '8px 16px 0', display: 'flex', flexDirection: 'column', gap: 0,
            background: 'var(--color-panel-2)', borderBottom: '1px solid var(--color-border-2)',
          }}
        >
          {activeRegimes.map((regime) => (
            <RegimeStatusCard
              key={regime.id}
              regime={regime}
              onRevertToTrial={onRevertRegimeToTrial}
              onStop={onStopRegime}
              isRevertQueued={isActionQueued(regimeActionKey(regime.id, 'revert'))}
              isStopQueued={isActionQueued(regimeActionKey(regime.id, 'stop'))}
            />
          ))}
          <div style={{ height: 8 }} />
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} style={{
        position: 'relative', zIndex: 1,
        flex: 1, padding: '14px 16px', display: 'flex', flexDirection: 'column',
        gap: 11, overflowY: 'auto', minHeight: 0,
      }}>
        {displayMessages.length === 0 && !busy && (
          <div style={{ textAlign: 'center', padding: '24px 0', fontSize: 12, color: 'var(--color-text-disabled)', lineHeight: 1.6 }}>
            {t('lazyManager.emptyOrchestrator')}
          </div>
        )}
        {displayMessages.map(msg => (
          <ManagerBubble
            key={msg.id}
            msg={msg}
            onFocusModel={onFocusModel}
            onRetry={onRetry}
            onAcceptProposal={onAcceptProposal}
            onModifyProposal={onModifyProposal}
            onRejectProposal={() => {
              if (msg.proposal?.planId) onRejectProposal(msg.proposal.planId);
            }}
            onStepModelChange={onStepModelChange}
            pendingApprovals={pendingApprovals}
            onApprovePendingAction={onApprovePendingAction}
            onRejectPendingAction={onRejectPendingAction}
            onApproveAllPendingActions={onApproveAllPendingActions}
            onRejectAllPendingActions={onRejectAllPendingActions}
            onForcePendingAction={onForcePendingAction}
            onAnswerDecision={onAnswerDecision}
            onValidateCharter={onValidateCharter}
            onModifyCharter={onModifyCharter}
            onRejectCharter={onRejectCharter}
            onSelectArtifactVariant={onSelectArtifactVariant}
            onRejectArtifact={onRejectArtifact}
            isActionQueued={isActionQueued}
            isActionFailed={isActionFailed}
          />
        ))}
        {busy && !displayMessages.some((m) => m.isStreaming) && (
          <ManagerTypingBubble
            groundingLabel={
              phase === 'grounding'
                ? t('cockpit.manager.groundingStatus')
                : phase === 'queued'
                  ? t('cockpit.manager.queuedStatus')
                  : undefined
            }
          />
        )}
      </div>
    </>
  );
}
