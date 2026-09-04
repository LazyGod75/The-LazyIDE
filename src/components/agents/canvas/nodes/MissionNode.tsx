/* MissionNode.tsx — one-shot mission card (spec §4.2/§4.3/§4.5).

   W-CARDS (product owner, 2026-07-18): "je veux pareil zoomé et dézoomé;
   si je veux lire je zoome, mais je vois tout pareil" — the mission card
   renders its ONE full layout (title, status ring, progress, verdict/cost
   chips, stage rail) at EVERY zoom level, geometrically scaled by React
   Flow's own viewport transform like any other node (WYSIWYG: tiny far
   away, readable up close — no semantic content swap by zoom). The old
   three-tier semantic LOD (dot/chip billboard at low zoom, a stripped
   "compact" card in the middle band) is retired for missions: `zoomLevel`
   is still accepted for call-site compatibility (every existing test/
   caller) but no longer changes what renders.

   Split in two on purpose:
   - `MissionNodeCard` — a PURE presentational component. No React Flow
     hooks, no context requirement beyond CanvasActionsContext (which has a
     safe no-op default) — directly unit-testable without a live viewport/
     ReactFlowProvider (see src/__tests__/canvasNodes.test.tsx).
   - `MissionNode` — the React Flow-registered node (default export via
     nodes/index.ts's `nodeTypes` map), rendering `MissionNodeCard` plus the
     connection Handles (Handle needs real RF context, so it stays out of
     the pure inner component).
*/

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import type { MissionNodeData } from '../canvasTypes';
import { makeRef } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import { classifyUrgent, urgentActionsFor } from '../../cockpit/cockpitHelpers';
import { useAgentsStoreActionsOptional, useAgentsStoreMissionsOptional, resolveProjectRoot } from '../../agentsStore';
import { useToastSafe } from '../../../ui';
import { pinChainWithAudit } from '../../../../lib/agents/canvasChainOps';
import { recordMissionAnswer } from '../../../../lib/agents/missionQuestion';
import { projectIdFromRoot } from '../../../../lib/journal/projectId';
import { useCanvasStore } from '../canvasStore';
import { useCanvasActions } from '../chrome/CanvasActionsContext';
import { useZoomLevel, type CanvasZoomLevel } from '../chrome/useZoomLevel';
import {
  AgentPersonaChip,
  AutonomyModeChip,
  BrainMemoryBadge,
  CardTitleBand,
  ConversationOriginDot,
  ExtraReadRootsBadge,
  FULL_CARD_MAX_HEIGHT,
  FULL_CARD_WIDTH,
  LiveActionLine,
  LiveOutputPeek,
  MetaChip,
  MissionIdBadge,
  ModelTierChip,
  NodeCard,
  PendingQuestionBadge,
  PinGlyph,
  PlanStepProgressBadge,
  ProgressBar,
  RetryHint,
  TypeGlyph,
  UrgentRankChip,
  VerdictChip,
  WorktreeBranchBadge,
  buildNodeTooltip,
  deriveMissionLiveness,
  isStaleInterruptedRelic,
  statusAccentColor,
  typeAccentColor,
} from '../chrome/nodeChrome';
import { CostChip } from '../chrome/CostChip';
import { classifyMissionModel } from '../../../../lib/agents/runtime';
import { usdToCredits } from '../../../../lib/billing/credits';
import { ContestWinnerChip, findContestWinner } from '../chrome/contestChrome';
import { ExpandIcon, HoverActionStrip, LogsIcon, OpenIcon, RetryIcon, StopIcon, type HoverAction } from '../chrome/HoverActionStrip';
import { STAGE_COLORS, StageRail } from '../chrome/StageRail';
import { STAGE_LABEL_KEYS } from '../../cockpit/ProjectRow';
import { useConnectionDragHighlight } from '../chrome/connectionDragStore';
import { GateFeedbackPopover } from '../chrome/GateFeedbackPopover';
import { LiveMissionPanel, type LivePanelQuickAction } from './LiveMissionPanel';
import { LIVE_PANEL_SIZE } from '../reconciler';
import { deriveLiveLine, isJudgeVerdictUnavailable, canvasLiveParts } from './missionLiveLine';

// `isJudgeVerdictUnavailable`/`deriveLiveLine` used to live here, but
// LiveMissionPanel.tsx also needs them, which made this file and
// LiveMissionPanel.tsx import each other (a real value-level cycle per
// madge's circular-dependency report). Moved verbatim to missionLiveLine.ts
// (same directory) so both node files depend on it instead of each other;
// re-exported below (both imported above for local use AND re-exported
// here) so every existing external import (tests) keeps working unchanged.
export { isJudgeVerdictUnavailable, deriveLiveLine, canvasLiveParts };

// fix/canvas-agents-visibility (deliverable 1, "voir ses agents
// travailler") — a raw actionTimeline entry can carry embedded newlines (a
// multi-line tool observation/command output), which would visually wrap
// or grow this card's fixed-height row before CSS `textOverflow: ellipsis`
// ever gets a chance to clip it (that rule only clips a SINGLE line).
// Collapses internal whitespace runs (including newlines) to one space and
// trims the ends, so the result is always one honest "terminal" line —
// never a truncated word, never a silent reformat of the actual text
// beyond whitespace collapsing. Returns undefined for empty/whitespace-only
// input, same "absent, not a blank line" convention `lastCompletedStep`'s
// own caller already follows.
export function formatLiveActivityLine(rawText: string | undefined): string | undefined {
  if (!rawText) return undefined;
  const collapsed = rawText.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

/** fix/canvas-title-ellipsis (owner repro, 2026-08-14 screenshot: a card
 *  title read "Créer un fichier index...." — four dots) — an upstream-
 *  generated mission title can already end in its own literal "..."/"…"
 *  (e.g. an agent's own truncated plan-step summary); the title band's CSS
 *  `textOverflow: ellipsis` then glues a SECOND ellipsis on top whenever the
 *  title overflows its fixed-width band. Strips any trailing run of dots/
 *  ellipsis characters (and the whitespace before them) before display —
 *  same technique this file already uses for the live-action line (`shown =
 *  ... line.replace(/[.…\s]+$/u, '')` below, W-UX3 audit fix #5a) — so a CSS
 *  ellipsis, if the browser ends up adding one, is always the ONE honest
 *  truncation mark, never stacked on a second one already baked into the
 *  text. Never touches a title with no trailing dots at all. */
export function stripTrailingEllipsis(title: string): string {
  return title.replace(/[.…\s]+$/u, '');
}

// fix/canvas-agents-visibility — "agent silencieux" threshold (founder,
// real incident: a frozen renderer/poll loop stopped refreshing
// FleetMission.updatedMs while the card kept showing a RUNNING status with
// no visible sign anything was wrong). 90s comfortably exceeds
// fleetMissions.ts's own poll cadence (2.5s), so a healthy mission never
// flickers into this state — only a genuinely stalled update stream does.
export const HEARTBEAT_STALE_THRESHOLD_MS = 90_000;

/** True once a running mission's last known update is older than
 *  {@link HEARTBEAT_STALE_THRESHOLD_MS} — pure so the exact boundary is
 *  directly unit-testable without mounting the card or faking timers. */
export function isHeartbeatStale(elapsedMs: number): boolean {
  return elapsedMs > HEARTBEAT_STALE_THRESHOLD_MS;
}

/** fix/canvas-promote-icon (David's measured repro: the "promote" quick
 *  action rendered as raw text carrying a literal 🧠 emoji, a real card in
 *  a real screenshot — the ONE quick-action button left using an emoji
 *  instead of a drawn icon, every other icon on this card and its siblings
 *  (HoverActionStrip.tsx's OpenIcon/LogsIcon/RetryIcon/etc., this file's
 *  own imports) is a plain inline SVG, `stroke="currentColor"`, never an
 *  emoji glyph — a bare emoji renders inconsistently across platforms/fonts
 *  and reads as unfinished next to that convention) — a double-chevron
 *  "escalate" glyph (this action promotes the mission to a stronger model
 *  tier), same 16x16 viewBox/stroke shape as every sibling icon. */
function PromoteIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 9.5 8 5l5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 13 8 8.5l5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// `& Record<string, unknown>` is required here: `MissionNodeData` is a
// plain `interface` (canvasTypes.ts), and TS does not synthesize an
// implicit index signature for interfaces the way it does for inline
// object-literal types — without the intersection, `Node<MissionNodeData,
// 'mission'>` fails the library's `NodeData extends Record<string,
// unknown>` constraint even though every real value is perfectly
// assignable. Same fix applied to every other node kind below.
export type MissionFlowNode = Node<MissionNodeData & Record<string, unknown>, 'mission'>;

// Re-exported for callers that used to import the zoom-level type from this
// file (W1b's original location) — the real definition now lives in
// chrome/useZoomLevel.ts (W2b) so every node kind shares one bucketing.
export type { CanvasZoomLevel };

interface MissionNodeCardProps {
  data: MissionNodeData;
  /** W-CARDS — accepted for call-site compatibility (every existing test/
   *  caller) but no longer read: the card always renders its one full
   *  layout regardless of zoom (see this file's own header). */
  zoomLevel: CanvasZoomLevel;
  selected?: boolean;
}

export function MissionNodeCard({ data, selected }: MissionNodeCardProps) {
  const { t } = useI18n();
  const toast = useToastSafe();
  const actions = useCanvasActions();
  // Optional on purpose (returns null outside an AgentsStoreProvider —
  // fixture tests, harness renders): Stop is simply omitted then, exactly
  // like CanvasContextMenu degrades. Never a crash, never a fake stop.
  const agentsActions = useAgentsStoreActionsOptional();
  const storeMissions = useAgentsStoreMissionsOptional();
  // W8a deliverable #2 — fold state lives in canvasStore's prefs (zustand
  // needs no provider; same direct-read pattern CanvasContextMenu.tsx
  // established). Prefs-resident so the reconciler sees it live — see
  // CanvasPrefs.foldedOrchestrators's doc comment.
  const folded = useCanvasStore((s) => s.prefs.foldedOrchestrators?.[data.mission.id] === true);
  const toggleFoldOrchestrator = useCanvasStore((s) => s.toggleFoldOrchestrator);
  const isSummarizing = useCanvasStore((s) => s.summarizingRefs.includes(makeRef('mission', data.mission.id)));
  const { mission } = data;
  const liveness = deriveMissionLiveness(mission);
  // 2026-08-06 (CI lint error fix): Date.now() during render is impure
  // (rules-of-react). The stale-relic softening below now reads a softly
  // refreshed clock (30s tick) instead of calling Date.now() in the
  // render body — a restart-interruption relic still softens shortly
  // after STALE_INTERRUPTED_RELIC_THRESHOLD_MS, just not on the exact
  // millisecond.
  const [relicClockMs, setRelicClockMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setRelicClockMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // Red relic softening (task: presentation-only calm-down of stale
  // restart-interruption relics) — see isStaleInterruptedRelic's own doc
  // comment (nodeChrome.tsx) for why the match is against the CURRENT
  // translation of the exact reason agentsActions.tsx's replay-recovery pass
  // writes, and why a fresh interruption (same reason, still young) is
  // deliberately excluded here (keeps its full red alarm).
  const isStaleRelic = isStaleInterruptedRelic(mission, liveness, t('agents.recoveredOnRestart'), relicClockMs);
  // W-UX3 audit fix #5b — a mission whose judge verdict already REJECTED it
  // must not present a green/primary « Approuver » (self-contradictory: the
  // judge said no). When true, the review gate de-emphasises approve
  // (secondary/grey) and emphasises reject (filled), and the quick-action
  // merge loses its primary green too. A missing/passed verdict keeps the
  // normal approve-forward affordances.
  const verdictRejected = mission.judgeVerdict != null && mission.judgeVerdict.passed === false;
  const stageColor = STAGE_COLORS[mission.stage];
  const urgentKind = classifyUrgent(mission);
  const rawQuickActions = urgentKind ? urgentActionsFor({ mission, kind: urgentKind, t, forceApprove: !!data.forceApprove }) : [];
  // fix/canvas-card-declutter (owner repro, 2026-08-14 screenshot: a review-
  // status card with a rejected verdict rendered FIVE action buttons at once
  // — Merger, Diff, Promouvoir, Approuver, Rejeter avec feedback — "visual
  // soup, nothing has priority", the red reject button bleeding past the
  // card's own edge). `urgentActionsFor`'s 'merge' quick action (below) and
  // the dedicated review gate row's own "Approuver" button now route through
  // the EXACT SAME `actions.onUrgentAction(mission, 'merge')` call Cockpit.tsx
  // owns — two buttons for one action, stacked on one card (fix/canvas-
  // collapse-reservation-adjacent regression, 2026-08-15: the gate button
  // used to call a LOCAL `handleGateApprove` that invoked
  // `agentsActions.approveMission` directly, silently skipping Cockpit's own
  // `switchToProjectIfNeeded` cross-project-honesty gate — a mission whose
  // project was never opened could be approved/merged from this button with
  // no "not open" toast, the exact invariant Cockpit.focusAndKpi.test.tsx's
  // "cross-project honesty" case exists to prove. Routing through the same
  // `actions.onUrgentAction` prop every OTHER card action already uses fixes
  // that for free — one real handler, not two independently-drifting ones).
  // The gate row already owns the whole approve/reject decision for a
  // 'review'-status mission (it renders under the exact same condition
  // checked here — `mission.status === 'review' && agentsStore`), so 'merge'
  // is dropped from the quick-action row whenever that gate row will actually
  // be on screen — never silently dropping the action when there is nowhere
  // else to reach it (no agentsStore -> no gate row -> 'merge' stays, e.g.
  // every pure-render test in this file that mounts with no store).
  const willShowReviewGate = mission.status === 'review' && !!agentsActions;
  const quickActions = willShowReviewGate ? rawQuickActions.filter((action) => action.key !== 'merge') : rawQuickActions;
  const isOrchestrator = (data.subMissionCount ?? 0) > 0;

  // W8c deliverable #1 (pin output) — outgoing chains from THIS mission's
  // node, read directly from canvasStore (same direct-read convention as
  // `folded` above). `fullMission` is the honest-degradation lookup
  // CanvasContextMenu.tsx's `duplicateAsDraft` already established: pinning
  // needs the REAL `Mission` (actionTimeline/result/diff/judgeVerdict —
  // `capturePinnedOutput` -> `buildContextBlock` -> `formatMissionDetail`
  // reads all of that), which `MissionNodeData.mission` (a `FleetMission`
  // read-model, spec §3) does not carry — only available when this mission
  // belongs to the ACTIVE project's live `agentsActions.missions` list.
  const missionRef = makeRef('mission', mission.id);
  // Selects the RAW `chains` array (a stable reference unless the array
  // itself changes) rather than filtering inside the selector — a selector
  // that allocates a new array every call breaks useSyncExternalStore's
  // "cached snapshot" contract (zustand's `useStore`) and was observed to
  // cause a real "Maximum update depth exceeded" loop in this exact
  // component during this wave's own test run. Derived with `useMemo` below
  // instead.
  const allChains = useCanvasStore((s) => s.chains);
  const outgoingChains = useMemo(() => allChains.filter((c) => c.sourceRef === missionRef), [allChains, missionRef]);
  // W-CONTEST — a completed contest's recorded winner (canvasStore's
  // `contests` slice, contestEngine.ts's `completeContest`). `.find()` never
  // allocates a new array (only `allChains`'s own `.filter()` above needs the
  // useMemo split — see that selector's own comment), so a plain selector is
  // safe here.
  const contestWinner = useCanvasStore((s) => findContestWinner(s.contests, mission.id));
  const hasPinnedOutgoing = outgoingChains.some((c) => c.pinnedContext != null);
  const hasUnpinnedOutgoing = outgoingChains.some((c) => c.pinnedContext == null);
  const fullMission = storeMissions?.find((m) => m.id === mission.id);
  // W-UX3 core deliverable 1 — 2-line LIVE TICKER's 2nd line: the real
  // actionTimeline's tail (the last COMPLETED step), never fabricated.
  // Only available once `fullMission` resolves (this project's live
  // agentsActions.missions, same honest-degradation lookup as above) —
  // absent falls back to the pre-existing single-line ticker below.
  const lastCompletedStep = formatLiveActivityLine(
    fullMission?.actionTimeline?.length
      ? fullMission.actionTimeline[fullMission.actionTimeline.length - 1]?.text
      : undefined,
  );
  // W-UX3 core deliverable 1 — ticking token/cost counter: real numbers
  // from the Rust agent runner's own metrics stream (Mission.agentMetrics
  // — the SAME field MissionDetailRight.tsx's CostCard already renders in
  // the detail view), never an estimate invented for this card.
  //
  // Fix D (2026-08-19 dollar-kill incident) — this used to render a raw
  // dollar figure ($X.XX) unconditionally, right next to CostChip below
  // which already said "No debit — subscription" for the exact same native
  // mission: one chip implied real money, the other said there was none.
  // Now rail-aware via the SAME classifyMissionModel/usdToCredits
  // CostChip.tsx itself uses — credits everywhere, "≈" + non-debited
  // wording on the native rail so the two chips never contradict each other.
  const liveMetrics = fullMission?.agentMetrics;
  const isLiveMetricsNativeRail = classifyMissionModel(fullMission?.model ?? mission.model) === 'native';
  const liveMetricsLabel = liveMetrics
    ? `${isLiveMetricsNativeRail ? '≈' : ''}${usdToCredits(liveMetrics.costUsd).toLocaleString()} ${t('canvas.node.creditsUnit')} · ${(liveMetrics.inputTokens + liveMetrics.outputTokens).toLocaleString()} tok`
    : undefined;
  // fix/canvas-agents-visibility (deliverable 1) — ticking "time since last
  // update" for a running mission, sourced from FleetMission.updatedMs
  // (already on `mission` — no new data fetched). Ticks only while
  // genuinely running: a paused/terminal card has no ongoing heartbeat to
  // watch, and ticking unconditionally would be a wasted per-card timer
  // across a large fleet.
  const [heartbeatNowMs, setHeartbeatNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (liveness !== 'running') return;
    const id = window.setInterval(() => setHeartbeatNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [liveness]);
  const heartbeatElapsedMs = Math.max(0, heartbeatNowMs - mission.updatedMs);
  const heartbeatSeconds = Math.floor(heartbeatElapsedMs / 1000);
  const heartbeatStale = liveness === 'running' && isHeartbeatStale(heartbeatElapsedMs);
  // R7 (living surfaces) — live-panel expand state lives in canvasStore's
  // own `expandedPanels` slice (see that store's doc comment) — same
  // direct-read convention as `folded` above. Presence of an entry for this
  // mission's ref both MEANS "expanded" and CARRIES its current footprint.
  const expandedPanelDims = useCanvasStore((s) => s.expandedPanels[missionRef]);
  const setExpandedPanel = useCanvasStore((s) => s.setExpandedPanel);
  const isExpanded = expandedPanelDims !== undefined;
  // R2b connectionUx "search-light" — highlight this card while a
  // connection drag is in progress canvas-wide (chrome/connectionDragStore.ts).
  const connectionHighlight = useConnectionDragHighlight(missionRef);

  // W8c deliverable #2 (approve/reject-with-feedback gate v2) — local UI
  // state for the inline textarea (feedback / question answer), never
  // persisted, mirroring MissionDetailControls.tsx's own local
  // `reviewing`/`blockedError` state shape.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [answerOpen, setAnswerOpen] = useState(false);
  const [answerText, setAnswerText] = useState('');
  // fix/canvas-ux R4d (dogfood defect #1) — the feedback/answer textarea now
  // renders as a GateFeedbackPopover portaled to <body>, anchored to the
  // gate row's own screen rect at the moment it opens (never the card
  // itself, which never grows — see that component's header). `null` means
  // "not open" for that popover; captured on open, cleared on close.
  const gateRowRef = useRef<HTMLDivElement>(null);
  const answerRowRef = useRef<HTMLDivElement>(null);
  const [feedbackAnchorRect, setFeedbackAnchorRect] = useState<DOMRect | null>(null);
  const [answerAnchorRect, setAnswerAnchorRect] = useState<DOMRect | null>(null);

  function handleGateRejectSubmit(): void {
    if (!agentsActions) return;
    const trimmed = feedbackText.trim();
    if (!trimmed) return;
    agentsActions.retryMission(mission.id, { feedback: trimmed });
    toast(t('canvas.gate.rejectToast'), 'success');
    setFeedbackOpen(false);
    setFeedbackAnchorRect(null);
    setFeedbackText('');
  }

  function handleGateRejectCancel(): void {
    setFeedbackOpen(false);
    setFeedbackAnchorRect(null);
    setFeedbackText('');
  }

  async function handleGateAnswerSubmit(): Promise<void> {
    if (!agentsActions || !mission.pendingQuestion) return;
    const trimmed = answerText.trim();
    if (!trimmed) return;
    agentsActions.interveneMission(mission.id, trimmed);
    try {
      const root = await resolveProjectRoot();
      await recordMissionAnswer({
        missionId: mission.id,
        question: mission.pendingQuestion,
        answer: trimmed,
        projectId: projectIdFromRoot(root),
        actor: 'user',
      });
      toast(t('canvas.gate.answerToast'), 'success');
    } catch {
      // best-effort journal write, mirrors interveneMission's own convention
    }
    setAnswerOpen(false);
    setAnswerAnchorRect(null);
    setAnswerText('');
  }

  function handleGateAnswerCancel(): void {
    setAnswerOpen(false);
    setAnswerAnchorRect(null);
    setAnswerText('');
  }

  // W8a deliverable #1 — hover quick-actions.
  //
  // R11 (corner-collision fix, MissionNode.tsx's own header) — the
  // "agrandir" live-panel expand chevron used to ALSO render as its own
  // absolutely-unrelated header-row button at the card's top-right, which
  // is the EXACT same corner NodeCard's `hoverActions` overlay occupies
  // (nodeChrome.tsx's `NodeCard`: `position: absolute; top: 6; right: 6;
  // zIndex: 2`) — on hover, the fading-in strip painted OVER the always-
  // present chevron (a positioned, z-indexed box always paints above static
  // in-flow content, CSS2.1 stacking order), making the chevron
  // unclickable at exactly the moment (hover) the strip itself is visible —
  // the R10 dogfood bug this follow-up task exists for (see
  // _e2e-r10-followup.mjs's `clickNodeButtonDiag`, which literally
  // hit-tests whether the chevron's OWN element owns its own click point).
  // Fixed by folding "expand" INTO this same strip as its first action —
  // one coherent top-right corner, nothing ever occludes anything else in
  // it — rather than inventing a second corner (top-left would also work
  // per the task brief, but that's ALREADY the fold chevron's spot for
  // orchestrator missions, so folding into the existing strip avoids a
  // second potential collision there too). `testId` keeps the PRE-EXISTING
  // `mission-node-expand-${missionId}` id (HoverActionStrip.tsx's own
  // `testId` override), so every caller/test that queried that id before
  // this move keeps working unchanged. W-CARDS — the card is now always the
  // single full layout, so this action is always present (no more
  // "compact/dot are already summaries" zoom gate).
  const hoverActions: HoverAction[] = [
    {
      key: 'expand',
      label: t('canvas.livePanel.expand'),
      icon: <ExpandIcon />,
      testId: `mission-node-expand-${mission.id}`,
      onSelect: () => setExpandedPanel(missionRef, LIVE_PANEL_SIZE),
    },
    { key: 'open', label: t('canvas.contextMenu.open'), icon: <OpenIcon />, onSelect: () => actions.onOpenMission(mission.id) },
    { key: 'logs', label: t('canvas.contextMenu.logs'), icon: <LogsIcon />, onSelect: () => actions.onUrgentAction(mission, 'logs') },
  ];
  if (mission.status === 'failed' || mission.status === 'cancelled') {
    hoverActions.push({ key: 'retry', label: t('canvas.node.retry'), icon: <RetryIcon />, onSelect: () => actions.onUrgentAction(mission, 'retry') });
  } else if ((mission.status === 'running' || mission.status === 'queued') && agentsActions) {
    hoverActions.push({ key: 'stop', label: t('canvas.contextMenu.stop'), icon: <StopIcon />, danger: true, onSelect: () => agentsActions.stopMission(mission.id) });
  }
  if (mission.status === 'done' && hasUnpinnedOutgoing && fullMission) {
    // W8c deliverable #1 — "hover strip if trivial" (module header): pins
    // EVERY currently-unpinned outgoing chain from this terminal-success
    // node in one action, rather than requiring one click per edge.
    hoverActions.push({
      key: 'pin',
      label: t('canvas.contextMenu.pinOutput'),
      icon: <PinGlyph size={12} />,
      onSelect: () => {
        for (const chain of outgoingChains) {
          // Shared audited pin choke point (chainEngine.pinChainWithAudit) —
          // same path as CanvasContextMenu's entries and the manager's
          // pin_chain action; one chain.pinned journal row per chain.
          if (chain.pinnedContext == null) void pinChainWithAudit(chain.id, fullMission);
        }
        toast(t('canvas.pin.toastPinned', { title: fullMission.title }), 'success');
      },
    });
  }

  // Auto-dismiss summary mode — when a one-time mission has been in 'done'
  // for SUMMARY_DELAY_MS, it transforms into this compact summary card
  // instead of the full card. Stays visible for SUMMARY_DISPLAY_MS, then
  // fades out (canvas-fade-exit class applied by useCanvasFlowGraph).
  if (isSummarizing) {
    return (
      <NodeCard
        liveness="merged"
        typeAccent={typeAccentColor('mission')}
        selected={selected}
        faded
        testId={`mission-node-summary-${mission.id}`}
        tooltip={buildNodeTooltip(mission.title, t('agents.status.done'), 'Summary')}
        className="canvas-summary-mode"
        style={{
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          width: FULL_CARD_WIDTH,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="var(--canvas-state-merged)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11.5,
              fontWeight: 700,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: 'var(--color-text-secondary)',
            }}
          >
            {stripTrailingEllipsis(mission.title)}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <ModelTierChip model={mission.model} />
          {mission.judgeVerdict && <VerdictChip verdict={mission.judgeVerdict} />}
          <CostChip
            costUsd={fullMission?.agentMetrics?.costUsd}
            tokensSource={fullMission?.agentMetrics?.tokensSource}
            model={fullMission?.model}
            testId={`mission-node-summary-cost-${mission.id}`}
          />
        </div>
      </NodeCard>
    );
  }

  // R7 (living surfaces, spec: "a mission card gains an agrandir chevron
  // ... that expands it into a live panel") — takes over the WHOLE render
  // (never combined with the full card below): an expanded mission is its
  // own live-streaming surface, not a bigger version of the normal card.
  // The connection Handles around this component (MissionNode, below) stay
  // mounted regardless, so chain wiring is unaffected.
  if (isExpanded && expandedPanelDims) {
    const panelQuickActions: LivePanelQuickAction[] = quickActions.map((action) => ({
      key: action.key,
      label: action.label,
      onSelect: () => actions.onUrgentAction(mission, action.key),
    }));
    return (
      <>
        <NodeResizer
          isVisible={selected}
          minWidth={360}
          minHeight={280}
          onResizeEnd={(_event, params) => setExpandedPanel(missionRef, { width: params.width, height: params.height })}
        />
        <LiveMissionPanel
          mission={mission}
          fullMission={fullMission}
          width={expandedPanelDims.width}
          height={expandedPanelDims.height}
          quickActions={panelQuickActions}
          onOpen={() => actions.onOpenMission(mission.id)}
          onCollapse={() => setExpandedPanel(missionRef, null)}
          // W-CLOSE row 5 (canvas scorecard "LangGraph interrupt-and-patch"
          // gap, honest v1) — composes the TWO real primitives this app
          // already has (never a fabricated "rewrite the agent's live state"
          // mechanism): interveneMission queues the edited plan as a
          // structured message a managed mission's ReAct loop actually reads
          // on its next step, THEN resumeMission un-pauses so that step
          // actually happens next. Order matters — queue before resuming, so
          // the very first post-resume step already sees it.
          onAdjustPlan={
            agentsActions
              ? (adjustedPlanText) => {
                  agentsActions.interveneMission(mission.id, `PLAN AJUSTÉ:\n${adjustedPlanText}`);
                  agentsActions.resumeMission(mission.id);
                }
              : undefined
          }
        />
      </>
    );
  }

  // Compact = card + verb + stage rail. `null` when LiveActionLine has
  // nothing honest to split (queued/failed/merged, a pending question, or
  // a passthrough sentence). Review WITH a real diffFiles basename is a
  // live verb+file, same as a running tool step — not a fallback sentence.
  const liveActionParts = canvasLiveParts(mission, liveness, t);
  const liveActionLineEl = liveActionParts ? (
    <LiveActionLine
      testId="mission-node-live-verb"
      verb={liveActionParts.verb}
      detail={liveActionParts.detail || undefined}
      accentColor={statusAccentColor(liveness)}
    />
  ) : null;

  return (
    <NodeCard
      liveness={liveness}
      typeAccent={typeAccentColor('mission')}
      // Design pass — a calm, always-on 3px left liveness stripe (running/
      // review/failed/merged/queued, chrome/nodeChrome.tsx's
      // statusAccentColor) alongside the existing type-accent top strip:
      // NodeCard already supports this exact "legacy/additive" left-stripe
      // slot (see its own `accentColor` prop doc comment), just unused by
      // this card until now. Additive to the existing running/review ring
      // (statusHaloClassName below, driven by `liveness`), not a
      // replacement — the stripe is the one signal that survives even a
      // selected card's ring being swapped for the selection border, and
      // reads instantly at any zoom without relying on motion.
      // Red relic softening — a stale restart-interruption relic loses its
      // alarming red stripe (falls back to the calm idle grey) and its
      // error ring; a FRESH interruption (or any other genuine failure)
      // keeps the full red treatment unchanged.
      accentColor={isStaleRelic ? 'var(--canvas-state-idle)' : statusAccentColor(liveness)}
      error={liveness === 'failed' && !isStaleRelic}
      selected={selected}
      faded={liveness === 'merged' || isStaleRelic}
      connectionHighlight={connectionHighlight}
      testId={`mission-node-${mission.id}`}
      tooltip={buildNodeTooltip(mission.title, t(`agents.status.${mission.status}`), t(STAGE_LABEL_KEYS[mission.stage]))}
      hoverActions={<HoverActionStrip actions={hoverActions} groupLabel={t('canvas.hover.actions')} />}
      // P2 node visual language — the rotating running/review ring is now
      // NodeCard's own `liveness`-driven halo (statusHaloClassName ->
      // canvas-node-ring-running/-review, chrome/canvas.css), applied at
      // BOTH compact and full zoom, not just full — superseding the old
      // full-only "hero" elevation (canvas-node-hero) that used to be set
      // here, and the old `running` prop's additive inner-pulse (dropped:
      // one ring is the card's one motion signal now, matching the
      // mockup — no second competing animation layered underneath it).
      // R7 (living surfaces, spec: "chevron AND double-click both expand")
      // — W-CARDS: always on now (one card, no compact/dot summary tier
      // left to reserve double-click for a zoom/selection gesture instead).
      onDoubleClick={() => setExpandedPanel(missionRef, LIVE_PANEL_SIZE)}
      style={{
        padding: '10px 12px 8px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        width: FULL_CARD_WIDTH,
        maxHeight: FULL_CARD_MAX_HEIGHT,
        overflow: 'hidden',
      }}
    >
      <CardTitleBand testId={`mission-node-title-band-${mission.id}`}>
        {isOrchestrator && (
          <button
            type="button"
            data-testid={`mission-node-fold-${mission.id}`}
            className="nodrag"
            title={t(folded ? 'canvas.fold.unfold' : 'canvas.fold.fold')}
            aria-label={t(folded ? 'canvas.fold.unfold' : 'canvas.fold.fold')}
            aria-expanded={!folded}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleFoldOrchestrator(mission.id);
            }}
            style={{
              width: 16,
              height: 16,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg
              className="canvas-fold-chevron"
              data-open={String(!folded)}
              width={10}
              height={10}
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path d="M3.5 6 8 10.5 12.5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <TypeGlyph kind="mission" color={stageColor} title="Mission" />
        {/* fix/canvas-graph-legibility — the mission's own short id (the
            SAME "M45" form the FLUX bar/chat already reference it by),
            always present so a card is identifiable at deep dezoom even
            when its title has long since become illegible. */}
        <MissionIdBadge id={mission.id} liveness={liveness} testId={`mission-node-id-badge-${mission.id}`} />
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: statusAccentColor(liveness),
            flexShrink: 0,
          }}
        >
          {t(`agents.status.${mission.status}`)}
        </span>
        {mission.pendingQuestion && <PendingQuestionBadge />}
        {data.urgentRank !== undefined && <UrgentRankChip rank={data.urgentRank} />}
        {mission.originConversationId && <ConversationOriginDot conversationId={mission.originConversationId} />}
      </CardTitleBand>
      <span
        data-testid="mission-node-title"
        style={{
          minWidth: 0,
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          lineHeight: 1.25,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {stripTrailingEllipsis(mission.title)}
      </span>

      {/* Row 1: Agent Persona & Environment Context */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        <AgentPersonaChip
          agentName={mission.agentName || fullMission?.agentName}
          testId={`mission-node-agent-chip-${mission.id}`}
        />
        <AutonomyModeChip mode={mission.permissionMode ?? fullMission?.permissionMode} />
        <WorktreeBranchBadge worktree={mission.worktree || fullMission?.worktree} />
        {/* Cross-project READ access transparency — see
            Mission.extraReadableRoots' doc comment (types.ts). Sourced from
            the live full Mission only (FleetMission's cross-project/journal
            row shape does not carry this field): absent for a background-
            project fleet row, shown for the mission's own live card. */}
        <ExtraReadRootsBadge roots={fullMission?.extraReadableRoots} />
        <BrainMemoryBadge
          count={mission.brainCitationsCount}
          tokensSaved={mission.tokensSaved}
          adapted={mission.brainAdapted}
        />
      </div>

      {isOrchestrator && folded && (
        <div
          data-testid={`mission-node-fold-badge-${mission.id}`}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span
            data-testid="mission-node-fold-badge-dot"
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              flexShrink: 0,
              background: statusAccentColor(
                deriveMissionLiveness({ status: data.worstSubMissionStatus ?? 'done', paused: false }),
              ),
            }}
          />
          <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
            {t('canvas.fold.badge', { count: data.subMissionCount ?? 0 })}
          </span>
        </div>
      )}

      <StageRail
        currentStage={mission.stage}
        variant="compact"
        hasPinnedOutgoing={hasPinnedOutgoing}
        currentStageErrored={liveness === 'failed'}
        running={liveness === 'running'}
      />

      {/* W-CARDS — one card, always the full body (title + verb line +
          progress + chips + gates): no more compact-tier subset. */}
      <>
          {(mission.planSteps || fullMission?.planSteps) && (
            <PlanStepProgressBadge planSteps={mission.planSteps || fullMission?.planSteps} />
          )}

          <div
            data-testid="mission-node-live-action"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--color-text-secondary)',
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
            }}
          >
            {liveActionLineEl ??
              (() => {
                // W-UX3 audit fix #5a — the animated ellipsis (::after on
                // `canvas-live-ellipsis`) appends "…", so a liveAction that
                // ALREADY ends with an ellipsis (« écrit PaymentSheet.tsx… »)
                // rendered a DOUBLE ellipsis (« …… »). Strip any trailing
                // dots/ellipsis from the text precisely when we're about to
                // add the animated one, so exactly one shows.
                const animated = liveness === 'running' && !mission.pendingQuestion;
                const line = deriveLiveLine(mission, liveness, t);
                const shown = animated ? line.replace(/[.…\s]+$/u, '') : line;
                return (
                  // Design pass 2026-08-22 — this line IS the card's state
                  // sentence, so for a failure it now CARRIES the
                  // `status-reason` testid and the danger color itself.
                  // RetryHint below no longer repeats the same string (a
                  // failed card used to print "FCM token invalide — 3
                  // tentatives…" twice, once grey and once red: visual soup,
                  // caught on a real 127%-zoom screenshot). One state line,
                  // one color, one place.
                  <div
                    data-testid={liveness === 'failed' ? 'status-reason' : undefined}
                    style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      // W-UX4: constrain the line to its card so the ellipsis
                      // actually engages — a block/flex item with a long
                      // unbroken token (e.g. an agent_create_worktree error
                      // naming a branch) used to overflow the card instead of
                      // truncating, because flex items default to
                      // min-width:auto (they refuse to shrink below content).
                      maxWidth: '100%',
                      minWidth: 0,
                      ...(liveness === 'failed' ? { color: 'var(--color-danger-text)', fontWeight: 600 } : {}),
                    }}
                  >
                    <span className={animated ? 'canvas-live-ellipsis' : undefined}>{shown}</span>
                  </div>
                );
              })()}
            {/* fix/canvas-agents-visibility (deliverable 1) — live activity
                strip: a discreet pulse + the actionTimeline's raw tail
                (never fabricated — see `formatLiveActivityLine`'s own doc
                comment) rendered as one compact terminal line, plus how
                long ago FleetMission.updatedMs last moved (orange +
                "agent silencieux" past HEARTBEAT_STALE_THRESHOLD_MS — a
                real signal of a frozen update stream, not a guess). Only
                while genuinely running; a paused/failed/etc. card already
                shows its own honest state line above and gets no second
                row. The heartbeat itself renders even with no actionTimeline
                entry yet (e.g. right after a mission starts) — it only
                needs `mission.updatedMs`, already on every FleetMission. */}
            {liveness === 'running' && lastCompletedStep && (
              <div
                data-testid={`mission-node-activity-${mission.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}
              >
                <span
                  className="canvas-blink"
                  aria-hidden="true"
                  style={{ width: 5, height: 5, borderRadius: '50%', background: statusAccentColor(liveness), flexShrink: 0 }}
                />
                <span
                  data-testid="mission-node-last-step"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontSize: 9.5,
                    color: 'var(--color-text-disabled)',
                  }}
                >
                  {lastCompletedStep}
                </span>
              </div>
            )}
            {liveness === 'running' && fullMission?.actionTimeline && fullMission.actionTimeline.length > 0 && (
              <LiveOutputPeek
                timeline={fullMission.actionTimeline}
                diffAdded={mission.diffAdded ?? fullMission.diffAdded}
                diffRemoved={mission.diffRemoved ?? fullMission.diffRemoved}
                liveness={liveness}
              />
            )}
          </div>

          {mission.progress !== undefined && <ProgressBar value={mission.progress} />}

          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <ModelTierChip model={mission.model} testId="mission-node-model-chip" />
            {liveness === 'running' && (
              // Design pass 2026-08-22 — the heartbeat lives in the FOOTER
              // chip row now, right-aligned like a timestamp. It used to sit
              // alone on the activity row; without a lastCompletedStep beside
              // it, "il y a 2s" floated mid-card with nothing anchoring it
              // (caught on a real 127%-zoom screenshot). Footer placement
              // reads as metadata, not as an orphaned sentence.
              <span
                data-testid={`mission-node-heartbeat-${mission.id}`}
                title={t('canvas.node.heartbeatTooltip')}
                style={{
                  marginLeft: 'auto',
                  flexShrink: 0,
                  fontSize: 9.5,
                  fontFamily: 'var(--font-mono)',
                  fontWeight: heartbeatStale ? 700 : 400,
                  color: heartbeatStale ? 'var(--color-warning-text)' : 'var(--color-text-disabled)',
                }}
              >
                {heartbeatStale
                  ? t('canvas.node.heartbeatSilent', { seconds: heartbeatSeconds })
                  : t('canvas.node.heartbeatAge', { seconds: heartbeatSeconds })}
              </span>
            )}
            {mission.judgeVerdict && <VerdictChip verdict={mission.judgeVerdict} />}
            {contestWinner && <ContestWinnerChip />}
            {/* W-UX3 core deliverable 1 — ticking token/cost counter: real
                numbers only (see `liveMetricsLabel`'s own doc comment),
                absent until the runner's first metrics event lands. */}
            {liveness === 'running' && liveMetricsLabel && (
              <MetaChip testId="mission-node-metrics-chip">{liveMetricsLabel}</MetaChip>
            )}
            {/* W-COST — per-mission live cost chip (market research: cheap
                differentiator, no competitor shows per-agent live cost).
                Sourced from `fullMission` (same honest-degradation lookup as
                `liveMetrics` above) rather than the FleetMission read-model,
                which carries no agentMetrics/contract of its own — absent
                fullMission (fixture render, no AgentsStoreProvider) simply
                hides the chip, same as liveMetricsLabel already does. */}
            <CostChip
              costUsd={fullMission?.agentMetrics?.costUsd}
              tokensSource={fullMission?.agentMetrics?.tokensSource}
              budgetCapUsd={fullMission?.contract?.budgetCapUsd}
              model={fullMission?.model}
              testId={`mission-node-cost-chip-${mission.id}`}
            />
          </div>

          {liveness === 'failed' && (
            // No `reason` prop: the failure sentence already renders once in
            // the state line above (danger-colored, with the status-reason
            // testid). Repeating it here doubled the text on every failed
            // card — one line, then the action.
            <RetryHint
              onRetry={() => actions.onUrgentAction(mission, 'retry')}
              retryLabel={t('canvas.node.retry')}
            />
          )}

          {quickActions.length > 0 && (
            <div style={{ display: 'flex', gap: 5 }}>
              {quickActions.map((action, index) => {
                // W-UX3 audit fix #5b — a rejected verdict strips the primary
                // green from the merge action: promoting a merge the judge
                // already rejected is exactly the contradiction to avoid, so
                // it drops to the secondary (outlined) treatment.
                const isPrimary = index === 0 && !(verdictRejected && action.key === 'merge');
                return (
                  <button
                    key={action.key}
                    type="button"
                    data-testid={`mission-node-action-${mission.id}-${action.key}`}
                    className="nodrag"
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.onUrgentAction(mission, action.key);
                    }}
                    style={{
                      flex: 1,
                      fontSize: 10.5,
                      fontWeight: 700,
                      padding: '4px 6px',
                      borderRadius: 6,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      border: isPrimary ? 'none' : '1px solid rgba(255,255,255,0.18)',
                      background: isPrimary ? (action.key === 'merge' ? 'var(--color-merge)' : '#F0EFF4') : 'transparent',
                      color: isPrimary ? '#14141C' : 'var(--color-text)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                    }}
                  >
                    {/* fix/canvas-promote-icon — a drawn glyph replaces the
                        raw 🧠 emoji cockpitHelpers.ts's i18n label used to
                        carry inline (see PromoteIcon's own doc comment). */}
                    {action.key === 'promote' && <PromoteIcon />}
                    {action.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* W8c deliverable #2 — approve/reject-with-feedback gate v2
              (Flowise AgentFlow HITL, reimplemented): a first-class inline
              gate for a mission genuinely awaiting a human decision — a
              'review' mission (approve/reject) or one paused on a real
              ask_user question (answer). Additive alongside the existing
              quick-action row above (unchanged, still the fast path for a
              plain merge).

              fix/canvas-ux R4d (dogfood defect #1, BLOQUANT): the reject-
              feedback textarea used to render INLINE here, swapping in for
              the approve/reject row — pushing content past the card's fixed
              `FULL_CARD_MAX_HEIGHT` (nodeChrome.tsx's `NodeCard`,
              geometry.ts), which `overflow: hidden` then silently clipped,
              including the submit button (unclickable at every zoom, R3
              dogfood d13/d14/d19). Fixed: this row NEVER changes shape —
              opening feedback captures its own screen rect and renders a
              GateFeedbackPopover portaled to <body> instead (see that
              component's header for why a portal categorically avoids the
              clip rather than just avoiding it "for now"). */}
          {mission.status === 'review' && agentsActions && (
            <div
              ref={gateRowRef}
              data-testid={`mission-node-gate-${mission.id}`}
              className="nodrag"
              style={{
                display: 'flex',
                gap: 5,
                padding: '6px 7px',
                borderRadius: 7,
                border: '1px solid rgba(124,92,255,0.28)',
                background: 'rgba(124,92,255,0.06)',
              }}
            >
              {/* W-UX3 audit fix #5b — when the judge already rejected this
                  mission, APPROVE is de-emphasised (secondary/outlined,
                  never green) and REJECT is the primary/filled action; a
                  passed/absent verdict keeps approve forward. */}
              <button
                type="button"
                data-testid={`mission-node-gate-approve-${mission.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.onUrgentAction(mission, 'merge');
                }}
                style={{
                  flex: 1,
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: '4px 6px',
                  borderRadius: 6,
                  border: verdictRejected ? '1px solid rgba(255,255,255,0.22)' : 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: verdictRejected ? 'transparent' : 'var(--color-merge)',
                  color: verdictRejected ? 'var(--color-text-muted)' : '#14141C',
                  opacity: 1,
                }}
              >
                {t('canvas.gate.approve')}
              </button>
              <button
                type="button"
                data-testid={`mission-node-gate-reject-open-${mission.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setFeedbackAnchorRect(gateRowRef.current?.getBoundingClientRect() ?? null);
                  setFeedbackOpen(true);
                }}
                style={{
                  flex: 1,
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: '4px 6px',
                  borderRadius: 6,
                  border: verdictRejected ? 'none' : '1px solid var(--color-danger)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: verdictRejected ? 'var(--color-danger)' : 'transparent',
                  color: verdictRejected ? '#14141C' : 'var(--color-danger)',
                }}
              >
                {t('canvas.gate.rejectFeedback')}
              </button>
            </div>
          )}
          {feedbackOpen && feedbackAnchorRect && (
            <GateFeedbackPopover
              anchorRect={feedbackAnchorRect}
              accent="purple"
              value={feedbackText}
              onChange={setFeedbackText}
              onSubmit={handleGateRejectSubmit}
              onCancel={handleGateRejectCancel}
              placeholder={t('canvas.gate.feedbackPlaceholder')}
              submitLabel={t('canvas.gate.submitReject')}
              cancelLabel={t('canvas.gate.cancel')}
              inputTestId={`mission-node-gate-feedback-input-${mission.id}`}
              submitTestId={`mission-node-gate-reject-submit-${mission.id}`}
              cancelTestId={`mission-node-gate-cancel-${mission.id}`}
            />
          )}

          {/* fix/canvas-ux R4d — same popover treatment as the reject-
              feedback gate above: this row was the OTHER inline textarea
              sharing the same overflow-hidden card, so it carried the
              identical clipping risk even though the R3 dogfood evidence
              happened to catch the reject-feedback one first. */}
          {mission.status !== 'review' && mission.pendingQuestion && agentsActions && (
            <div
              ref={answerRowRef}
              data-testid={`mission-node-answer-${mission.id}`}
              className="nodrag"
              style={{
                display: 'flex',
                padding: '6px 7px',
                borderRadius: 7,
                border: '1px solid rgba(251,185,36,0.3)',
                background: 'rgba(251,185,36,0.06)',
              }}
            >
              <button
                type="button"
                data-testid={`mission-node-answer-open-${mission.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setAnswerAnchorRect(answerRowRef.current?.getBoundingClientRect() ?? null);
                  setAnswerOpen(true);
                }}
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: '4px 6px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: '#FBB924',
                  color: '#14141C',
                }}
              >
                {t('canvas.gate.answer')}
              </button>
            </div>
          )}
          {answerOpen && answerAnchorRect && (
            <GateFeedbackPopover
              anchorRect={answerAnchorRect}
              accent="amber"
              value={answerText}
              onChange={setAnswerText}
              onSubmit={() => void handleGateAnswerSubmit()}
              onCancel={handleGateAnswerCancel}
              placeholder={t('canvas.gate.answerPlaceholder')}
              submitLabel={t('canvas.gate.answer')}
              cancelLabel={t('canvas.gate.cancel')}
              inputTestId={`mission-node-answer-input-${mission.id}`}
              submitTestId={`mission-node-answer-submit-${mission.id}`}
              cancelTestId={`mission-node-answer-cancel-${mission.id}`}
            />
          )}
        </>
    </NodeCard>
  );
}

// R2b nodeSpec handles — target is a small vertical bar (flush-left),
// source a slightly larger circle (Position.Right); real forgiving hit-
// area comes from `connectionRadius={30}` (already set on `<ReactFlow>`
// in CanvasView.tsx, spec's navigationScheme), not from the visible dot's
// own size — this only needs to be legible, not literally 32px.
const MISSION_ACCENT = typeAccentColor('mission');
const TARGET_HANDLE_STYLE = { width: 6, height: 16, borderRadius: 2, background: MISSION_ACCENT, border: '2px solid var(--color-panel)' };
const SOURCE_HANDLE_STYLE = { width: 12, height: 12, borderRadius: '50%', background: MISSION_ACCENT, border: '2px solid var(--color-panel)' };

export const MissionNode = memo(function MissionNode({ data, selected }: NodeProps<MissionFlowNode>) {
  const zoomLevel = useZoomLevel();
  return (
    <>
      <Handle type="target" position={Position.Left} style={TARGET_HANDLE_STYLE} />
      <MissionNodeCard data={data} zoomLevel={zoomLevel} selected={selected} />
      <Handle type="source" position={Position.Right} style={SOURCE_HANDLE_STYLE} />
    </>
  );
});
