/* LazyManager — the unified LazyManager entity. One panel, one header,
   one history, one composer. Mode toggle (Orchestrateur / Codeur) changes
   only the routing of the next send — no new conversation, no UI swap.

   Replaces LazyManagerUnified.tsx (which was a conditional switch between
   two separate components with separate stores, headers, and histories).

   This component is rendered inside:
   - ManagerOverlay (cockpit) — with orchestrator props (projects, signals, etc.)
   - CodeSpace (code page right rail) — with coder props (identity, quickActions)

   Both stores (agentsStore, assistantStore) stay mounted at the AppShell
   root level, so state persists across space switches. The
   LazyManagerStoreProvider wraps both into a unified adapter. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SafeResizeObserver } from '../../lib/safeResizeObserver';
import { useLazyManagerStore, type ManagerMode } from './lazyManagerStore';
import { LazyManagerHistoryDrawer } from './LazyManagerHistoryDrawer';
import { LazyManagerHeader } from './LazyManagerHeader';
import { LazyManagerMessageList } from './LazyManagerMessageList';
import { LazyManagerComposer } from './LazyManagerComposer';
import { useAgentsStoreOptional, MAX_OPEN_MANAGER_CONVERSATIONS, describePendingActionDetail } from '../agents/agentsStore';
import { PendingApprovalBar, type PendingApprovalBarItem } from './PendingApprovalBar';
import { buildConversationTabLabels } from './conversationTabLabel';
import { getPanelWidthTier } from './panelWidthTier';
import { useAssistantStoreOptional } from '../assistant/assistantStore';
import type { AssistantIdentity, AssistantQuickAction } from '../assistant/assistantIdentity';
import type { FleetMission, FleetProject } from '../../lib/agents/fleetMissions';
import type { ManagerMessage } from '../../lib/agents/types';
import type { ManagerSignal } from '../agents/cockpit/managerSignals';
import { emit, on } from '../../lib/bus';
import { useI18n } from '../../i18n';
import { listPendingApprovals, resolveApproval, type PendingApproval as SolariPendingApproval } from '../../lib/agents/approval/approvalGate';
import {
  formatCharterRejectMessage,
  formatCharterValidationMessage,
  formatRegimeRevertMessage,
  formatRegimeStopMessage,
  regimeStatusFromMission,
  type MissionCharter,
  type RegimeStatus,
} from './missionCharter';
import {
  formatArtifactRejectMessage,
  formatArtifactSelectionMessage,
  type ArtifactProposal,
  type ArtifactVariant,
} from './artifactProposal';
import {
  useManagerActionQueue,
  charterActionKey,
  decisionActionKey,
  artifactActionKey,
  proposalActionKey,
  regimeActionKey,
  retryActionKey,
} from './useManagerActionQueue';

export interface LazyManagerProps {
  /** Cockpit fleet projects — only used in orchestrator mode. */
  projects?: FleetProject[];
  /** Cockpit draft prefill — only used in orchestrator mode. */
  draftPrefill?: string | null;
  onDraftConsumed?: () => void;
  /** Screenshot/test-only seam — passes fixture messages to the orchestrator view. */
  messagesOverride?: ManagerMessage[];
  /** Cockpit signal feed — only used in orchestrator mode. */
  signals?: ManagerSignal[];
  onAnswerSignal?: (mission: FleetMission, projectId: string, question: string, answer: string) => void;
  onSignalAction?: (mission: FleetMission, actionKey: string) => void;
  /** CodeSpace identity branding — only used in coder mode. */
  identity?: AssistantIdentity;
  /** CodeSpace file-context quick actions — only used in coder mode. */
  quickActions?: AssistantQuickAction[];
  /** Collapse callback — fused into header (cockpit only). */
  onCollapse?: () => void;
  collapseDisabled?: boolean;
  /** Current overlay width state + manual widen/narrow toggle — cockpit
   *  only (ManagerOverlay owns the state machine; see that file's header
   *  comment). Undefined in the CodeSpace usage, where there's no
   *  expand/collapse concept at all — LazyManagerHeader only renders the
   *  widen/narrow button when `onToggleWidth` is provided. */
  widthState?: 'normal' | 'expanded' | 'collapsed';
  onToggleWidth?: () => void;
}

export function LazyManager({
  projects = [],
  draftPrefill = null,
  onDraftConsumed = () => {},
  onCollapse,
  collapseDisabled,
  widthState,
  onToggleWidth,
  messagesOverride,
  signals = [],
  onAnswerSignal = () => {},
  onSignalAction = () => {},
  identity,
  quickActions,
}: LazyManagerProps) {
  const store = useLazyManagerStore();
  const agents = useAgentsStoreOptional();
  const assistant = useAssistantStoreOptional();
  const { t } = useI18n();
  // NEVER DEGRADE IN SILENCE — every card action below (Validate/Reject a
  // charter, answer a decision, pick/reject an artifact variant, accept/
  // modify/reject a graph proposal, revert/stop a regime, retry a timed-out
  // turn) used to read `if (!store.busy) void store.send(...)`: a click made
  // while the manager was mid-turn was simply dropped, with the card often
  // still flipping to a false "ACCEPTÉE" (real user test, 2026-07-28 — see
  // MissionCharterCard.tsx's own doc comment for the exact repro). This
  // queue is the single mechanism every one of those handlers now goes
  // through: it sends immediately when free, or queues (preserving order,
  // deduping a repeated click) for the instant the manager frees up — see
  // useManagerActionQueue.ts's own doc comment for the full contract.
  const queue = useManagerActionQueue(store.busy);

  // SILENT-FALSE-POSITIVE FIX (real user test, 2026-07-28, round 2 — see
  // useManagerActionQueue.ts's own doc comment for the full repro: a queued
  // card action used to promote to "resolved" on the mere fact that the
  // queue drained, never confirming the send actually reached the manager).
  // Kept in sync with the FRESHEST `agents.managerMessages` snapshot on
  // every render — a `run` closure captured by useManagerActionQueue at
  // click time (possibly queued while busy, invoked much later once it
  // flushes) must read the CURRENT conversation length through this ref,
  // not the stale array frozen into the closure at click time (agentsStore
  // rebuilds this array immutably on every append — `[...prev, msg]` — so
  // an old captured reference can never grow, no matter how long we wait
  // on it).
  const managerMessagesRef = useRef(agents?.managerMessages ?? []);
  managerMessagesRef.current = agents?.managerMessages ?? [];

  // Sends `text` through the manager and CONFIRMS it from the REAL result —
  // the conversation actually grew — rather than merely from the send
  // promise resolving without throwing (a silently no-op send, e.g. because
  // the underlying store was unavailable, would resolve too and used to be
  // reported as success). Every charter/decision/artifact/regime/retry
  // handler below routes through this so `useManagerActionQueue` can tell a
  // confirmed send apart from an attempted-but-refused one — see that
  // module's own doc comment for the full contract (`false` = confirmed
  // failure, re-arms the card and shows why).
  const sendConfirmed = useCallback(async (text: string): Promise<boolean> => {
    const before = managerMessagesRef.current.length;
    try {
      await store.send(text);
    } catch {
      return false;
    }
    // send() can resolve in the same tick as the last store setState,
    // before this component re-renders. Yield one frame so the ref
    // (synced during render) includes the new user bubble.
    await new Promise<void>((r) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
      else queueMicrotask(r);
    });
    return managerMessagesRef.current.length > before;
  }, [store]);

  // Same contract as sendConfirmed above, for the one handler
  // (handleRetryMessage) that calls agents.sendManagerMessage directly
  // instead of routing through store.send.
  const sendManagerConfirmed = useCallback(async (text: string, model: string): Promise<boolean> => {
    const before = managerMessagesRef.current.length;
    try {
      if (!agents) return false;
      await agents.sendManagerMessage(agents.activeConversationId, text, model);
    } catch {
      return false;
    }
    await new Promise<void>((r) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => r());
      else queueMicrotask(r);
    });
    return managerMessagesRef.current.length > before;
  }, [agents]);

  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Scroll-intent flag for the auto-scroll policy below: true while the
   *  reader is at (or near) the bottom of the message container. Updated on
   *  EVERY scroll event of that container (user wheel/touch/drag and
   *  programmatic alike), so it reflects the reader's CURRENT intent rather
   *  than a one-shot snapshot taken after the DOM already grew. */
  const stickToBottomRef = useRef(true);
  const handleMessageListScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }, []);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectRef = useRef<HTMLSelectElement>(null);

  // "Nouvelle conversation" confirmation toast (real user test, 2026-08-01
  // QA): the header's New-conversation button is now clickable even while
  // busy (LazyManagerHeader.tsx's own doc comment on that button) — the
  // transcript emptying out is too subtle a signal on its own when the
  // panel is also full of fleet signals, so this renders a brief, explicit
  // confirmation. `interrupted` records whether the manager was mid-turn AT
  // CLICK TIME (captured before store.newSession() runs and flips busy back
  // to false), so the toast is honest about whether anything was actually
  // cut short. Auto-clears via a bare setTimeout — same convention as
  // CodeBlock's own `copied`/`applied` transient flags (MessageList.tsx) —
  // not cleaned up on unmount since this panel stays mounted for the whole
  // session, same posture those flags already take.
  const [newConversationToast, setNewConversationToast] = useState<{ interrupted: boolean } | null>(null);

  // Draft prefill (orchestrator mode only)
  useEffect(() => {
    if (draftPrefill !== null && store.mode === 'orchestrator') {
      setInput(draftPrefill);
      onDraftConsumed();
    }
  }, [draftPrefill, onDraftConsumed, store.mode]);

  // Auto-scroll on new messages / busy state changes — but ONLY while the
  // reader is at (or near) the bottom, tracked live by handleMessageListScroll
  // on every container scroll (real-user bug 2026-08-04: scrolling up to
  // read history was impossible because every message/busy/signal change
  // force-jumped scrollTop to the bottom, overriding the reader's position).
  // Reading the flag (not re-measuring the DOM here) also keeps the bottom
  // case working: when content grows under a reader who IS at the bottom,
  // no scroll event fires, the flag stays true, and the container follows
  // the new content. 96px ≈ two message rows, so a slight overshoot still
  // snaps.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    const timer = setTimeout(() => { el.scrollTop = el.scrollHeight; }, 60);
    return () => clearTimeout(timer);
  }, [store.messages, store.busy, signals.length]);

  // Escape = stop while busy, or reject pending proposal when idle
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      if (store.busy) {
        e.preventDefault();
        store.stop();
      } else {
        // P2c: Reject the most recent pending proposal on Escape
        const pendingProposal = agents?.managerMessages.find(
          (m) => m.proposal?.state === 'pending',
        );
        if (pendingProposal?.proposal?.planId) {
          e.preventDefault();
          void agents?.rejectPlan(pendingProposal.proposal.planId);
        }
      }
    }
  }

  // NOT part of the silent-drop bug: the composer's textarea AND its send
  // button are both `disabled={busy}` (LazyManagerComposer.tsx), so this
  // guard is unreachable via any real interaction — kept only as a
  // defensive no-op, same as before this fix.
  function handleSend(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || store.busy) return;
    setInput('');
    void store.send(text);
  }

  function handleStop() {
    store.stop();
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  // "Nouvelle conversation" must both close a still-open history drawer AND
  // start the new session in one click — without this, the drawer's own
  // z-index used to sit on top of the header, so the click never even
  // reached this handler in the first place (see the inner wrapper below).
  // Also purges the action queue (see useManagerActionQueue.ts): a queued
  // click belongs to the conversation that was on screen when it was made,
  // never to the fresh one this starts.
  //
  // Multi-conversation LazyManager (wave 1) — starting a new conversation
  // no longer stops/interrupts whatever was busy: the old conversation
  // keeps working on its own tab in the background (that is the entire
  // point of this feature). The toast is therefore always the plain
  // "started" wording, never "interrupted" — nothing was ever cut short.
  function handleNewSession() {
    setShowHistory(false);
    queue.reset();
    store.newSession();
    setNewConversationToast({ interrupted: false });
    setTimeout(() => setNewConversationToast(null), 2500);
  }

  // Loading a different session or switching mode (orchestrator <-> coder)
  // is just as much "the conversation changed" as starting a new one — same
  // queue purge, same rationale as handleNewSession above.
  function handleLoadSession(id: string, source: ManagerMode) {
    queue.reset();
    store.loadSession(id, source);
  }

  function handleModeChange(mode: ManagerMode) {
    queue.reset();
    store.setMode(mode);
  }

  // Closing a tab that WASN'T the active one never touches what's currently
  // on screen — no queue reset needed (same "only reset when the visible
  // conversation actually changes" rule handleNewSession/handleLoadSession
  // above already follow). Closing the ACTIVE tab always switches which
  // conversation is on screen (agentsStore.tsx's closeManagerConversation
  // activates a neighbour, or a fresh conversation if it was the last one),
  // so a queued action captured against the now-hidden conversation must be
  // purged exactly like a new/loaded session would purge it.
  function handleCloseConversation(id: string) {
    if (agents?.activeConversationId === id) queue.reset();
    agents?.closeManagerConversation(id);
  }

  // Rename feature (tab strip fix, item 3) — thin passthrough to
  // agentsStore.tsx's renameManagerConversation. Never resets the action
  // queue: a rename is purely cosmetic (the label above the transcript),
  // never a conversation switch — unlike handleCloseConversation/
  // handleLoadSession/handleNewSession above, nothing queued against the
  // still-visible conversation becomes stale because of it.
  function handleRenameConversation(id: string, title: string) {
    agents?.renameManagerConversation(id, title);
  }

  const handleLaunchAgent = useCallback(() => {
    const lastUser = [...store.messages].reverse().find(m => m.role === 'user');
    const task = lastUser?.content ?? '';
    emit('agent:launch', {
      task,
      title: task.slice(0, 57) + (task.length > 57 ? '...' : ''),
      model: store.mode === 'orchestrator' ? store.managerModel : store.selectedModel.id,
      conversation: store.messages.map(m => ({ role: m.role, content: m.content })),
    });
  }, [store.messages, store.mode, store.managerModel, store.selectedModel]);

  // Real regime status per mission — derived from FleetMission.loopConfig
  // (lib/agents/types.ts's LoopConfig.regimeState/trialApprovedCount/
  // trialPromotionThreshold), across every project's missions. Absent
  // regimeState (pre-charter loop, or a one-off task) yields null and is
  // filtered out — see regimeStatusFromMission's own doc comment.
  const activeRegimes = useMemo<RegimeStatus[]>(
    () => projects.flatMap((p) => p.missions.map(regimeStatusFromMission).filter((r): r is RegimeStatus => r !== null)),
    [projects],
  );

  // Solari (bot tool) approvals � cloud_* tool calls gated by approvalGate.ts,
  // NOT manager actions. Without this they only appeared in the canvas
  // LazyBotNode's inline row, never in the manager chat. We merge them into
  // the same PendingApprovalBar so the user can approve from the manager.
  const [solariPending, setSolariPending] = useState<SolariPendingApproval[]>([]);
  useEffect(() => {
    const sync = () => setSolariPending(listPendingApprovals());
    sync();
    const offReq = on('solari:approvalRequest', sync);
    const offRes = on('solari:approvalResolved', sync);
    return () => { offReq(); offRes(); };
  }, []);

    // PendingApprovalBar items (safety fix, 2026-08-15 — see that component's
  // own doc comment): maps the store's pendingApprovals into the plain,
  // decoupled shape the bar needs, reusing the SAME describePendingAction /
  // describePendingActionDetail pipeline PendingApprovalCard.tsx's own
  // per-message mapping (LazyManagerMessageList.tsx) already relies on —
  // `label` already comes from the action itself (agentsStore.tsx sets it
  // via describePendingAction at creation time), never re-derived here.
  const pendingApprovalBarItems = useMemo<PendingApprovalBarItem[]>(
    () => [
      ...(agents?.pendingApprovals ?? []).map((p) => ({
        id: p.id,
        actionType: p.action.type,
        label: p.label,
        detail: describePendingActionDetail(p.action, t),
        turnId: p.turnId,
        lastFailure: p.lastFailure,
      })),
      ...solariPending.map((p) => ({
        id: 'solari:' + p.missionId,
        actionType: p.tool,
        label: p.tool + (p.args && Object.keys(p.args).length > 0 ? ': ' + JSON.stringify(p.args).slice(0, 60) : ''),
        detail: JSON.stringify(p.args, null, 2),
        turnId: '__solari__',
      })),
    ],
    [agents?.pendingApprovals, t, solariPending],
  );

  // Multi-conversation LazyManager (wave 1) — the tab strip's own view of
  // every currently open orchestrator conversation, in tab-strip order.
  // Empty for the coder mode / no-agentsStore case, which is exactly what
  // LazyManagerHeader needs to keep rendering nothing (single-conversation
  // look, unchanged from before this feature existed).
  //
  // Item 2 fix (real user QA, 2026-08-01), REVISED 2026-08-14: a title
  // derived only from the conversation's own first user message is a poor
  // disambiguator when several conversations happen to START the same way
  // (a real repro: 4 of 5 open tabs all began "Repondez uniquement...") —
  // truncating each independently just produced 4 visually identical tabs.
  // buildConversationTabLabels (conversationTabLabel.ts) now derives the
  // SAME first-message-based label but detects that collision across every
  // OPEN conversation and appends the real creation time (recovered from
  // the conversation id itself — see that file's own doc comment) only to
  // the tabs that actually need it to stay distinguishable. It also owns
  // the truncation itself, via truncateLabel.ts (word-boundary aware,
  // always-ellipsis) — the SAME canonical truncator PendingApprovalCard.tsx
  // already uses, replacing this file's former direct use of agentsStore
  // .tsx's OWN (differently-tuned) truncateLabel, so LazyManager no longer
  // depends on two divergent truncation implementations for the same job.
  // `undefined` for a brand new, still-empty conversation ("+" just
  // clicked) — the tab strip falls back to its ordinal in that case,
  // unchanged from before this fix.
  const conversationTabs = useMemo(() => {
    const order = agents?.conversationOrder ?? [];
    const sources = order.flatMap((id) => {
      const conv = agents?.conversations[id];
      return conv
        ? [{ id, firstUserMessage: conv.messages.find((m) => m.role === 'user')?.content, customTitle: conv.customTitle }]
        : [];
    });
    const labels = new Map(buildConversationTabLabels(sources).map((l) => [l.id, l]));
    return order.flatMap((id) => {
      const conv = agents?.conversations[id];
      if (!conv) return [];
      const label = labels.get(id);
      return [{
        id: conv.id, busy: conv.busy, phase: conv.phase,
        title: label?.title, fullTitle: label?.fullTitle, customTitle: conv.customTitle,
      }];
    });
  }, [agents?.conversationOrder, agents?.conversations]);

  // Real breakpoints for the PANEL's own width (panelWidthTier.ts) — see
  // that file's own module doc comment for why this must be the panel's
  // measured width, not the app viewport. Ad-hoc ResizeObserver on the
  // panel's own root box, same pattern already used elsewhere in this
  // codebase for a single caller's real container width (GraphProposalCard
  // .tsx's ProposalGraphPreview) rather than adding a new shared hook for
  // one consumer. `typeof ResizeObserver !== 'function'` guards jsdom
  // (vitest has no polyfill for it) — `panelWidth` simply stays `undefined`
  // there, and getPanelWidthTier(undefined) resolves to `'wide'`, matching
  // every existing test's assumption and this component's own pre-measurement
  // first frame.
  const panelRootRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = panelRootRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new SafeResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setPanelWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const panelTier = getPanelWidthTier(panelWidth);

  // Mission charter surface (SPEC-CHARTE-DE-MISSION.md, Mission C) — interim
  // wiring through the plain `store.send(text)` primitive, formatted by
  // missionCharter.ts's helpers so the manager sees the (possibly edited)
  // charter / the chosen option restated in plain language, same as if the
  // user had typed it. See missionCharter.ts's module doc comment: once
  // agentsStore.tsx grows dedicated charterProposal accept/reject/answer
  // methods (out of this task's perimeter), these should call those
  // directly instead, mirroring onAcceptProposal/onRejectProposal below.
  //
  // Every handler below returns the queue's ActionDispatchOutcome so its
  // caller (the card, via LazyManagerMessageList's wiring) can show the
  // right thing: 'sent' → the final result: 'queued' → an explicit waiting
  // state, never a false final result; 'idle' → stay actionable.
  function handleAnswerDecision(option: string, index: number, messageId: string) {
    return queue.dispatch(decisionActionKey(messageId, index), () => sendConfirmed(option));
  }
  function handleValidateCharter(charter: MissionCharter, answeredDecisions: Record<number, string>, messageId: string) {
    return queue.dispatch(charterActionKey(messageId), () => sendConfirmed(formatCharterValidationMessage(charter, answeredDecisions, t)));
  }
  function handleRejectCharter(messageId: string) {
    return queue.dispatch(charterActionKey(messageId), () => sendConfirmed(formatCharterRejectMessage(t)));
  }
  // Visible-artifact fix — same interim send-as-text wiring as the charter
  // handlers above (see artifactProposal.ts's own INTEGRATION GAP doc
  // comment): no dedicated store method exists yet for `artifactProposal`,
  // so picking a variant / rejecting the whole proposal is restated in
  // plain language and sent as the user's own turn.
  function handleSelectArtifactVariant(proposal: ArtifactProposal, variant: ArtifactVariant, messageId: string) {
    return queue.dispatch(artifactActionKey(messageId), () => sendConfirmed(formatArtifactSelectionMessage(proposal, variant, t)));
  }
  function handleRejectArtifact(proposal: ArtifactProposal, messageId: string) {
    return queue.dispatch(artifactActionKey(messageId), () => sendConfirmed(formatArtifactRejectMessage(proposal, t)));
  }
  function handleRevertRegimeToTrial(regimeId: string) {
    const regime = activeRegimes.find((r) => r.id === regimeId);
    if (!regime) return 'idle' as const;
    return queue.dispatch(regimeActionKey(regimeId, 'revert'), () => sendConfirmed(formatRegimeRevertMessage(regime, t)));
  }
  function handleStopRegime(regimeId: string) {
    const regime = activeRegimes.find((r) => r.id === regimeId);
    if (!regime) return 'idle' as const;
    return queue.dispatch(regimeActionKey(regimeId, 'stop'), () => sendConfirmed(formatRegimeStopMessage(regime, t)));
  }
  function handleRetryMessage(retryText: string, messageId: string) {
    return queue.dispatch(retryActionKey(messageId), () => sendManagerConfirmed(retryText, agents?.managerModel ?? ''));
  }
  // Proposal actions mutate plan state rather than appending a chat
  // message, so message-count confirmation (sendConfirmed's own technique)
  // does not apply here — "did the call throw" is the best available real-
  // result signal without a dedicated plan-state confirmation, which is out
  // of this task's perimeter (agentsStore.tsx). Still strictly more honest
  // than before: a rejected executePlan/revisePlan/rejectPlan now reports
  // 'failed' instead of being swallowed and shown as resolved.
  function handleAcceptProposal(planId: string, opts?: { stepIds?: string[] }) {
    return queue.dispatch(proposalActionKey(planId), async () => {
      try {
        await agents?.executePlan(planId, opts);
        return true;
      } catch {
        return false;
      }
    });
  }
  function handleModifyProposal(planId: string) {
    return queue.dispatch(proposalActionKey(planId), async () => {
      try {
        await agents?.revisePlan(planId);
        return true;
      } catch {
        return false;
      }
    });
  }
  function handleRejectProposal(planId: string) {
    return queue.dispatch(proposalActionKey(planId), async () => {
      try {
        await agents?.rejectPlan(planId);
        return true;
      } catch {
        return false;
      }
    });
  }
  // Feature E — per-step model chip in the pending plan card. Fire-and-forget
  // (the card's own selection state is the source of truth until the store
  // mirrors it back); a failure surfaces via the store's own toast.
  function handleStepModelChange(planId: string, stepId: string, modelId: string) {
    void agents?.setStepModel(planId, stepId, modelId);
  }
  // 2026-08-06 (founder: "c'est une catastrophe que le lazymanager ne fasse
  // pas ce qu'on demande") — the "Stoppe tout" / "Nettoyer" quick pills
  // execute the REAL primitives directly (stopAll / clear_canvas through
  // the same executor the manager uses), never a prose prompt the model
  // might fail to act on. Works even while the manager is mid-loop.
  function handleDirectStopAll() {
    agents?.stopAll();
  }
  function handleDirectCleanup() {
    agents?.clearCanvasDirect?.('all', 'archive');
  }

  return (
    <div ref={panelRootRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
      {/* Single unified header — NOT inside the relatively-positioned wrapper
          below, so the history drawer's absolute overlay (anchored to that
          wrapper) can never cover this row's icon buttons. */}
      <LazyManagerHeader
        mode={store.mode}
        onModeChange={handleModeChange}
        onShowHistory={() => setShowHistory(v => !v)}
        onNewSession={handleNewSession}
        disabled={store.busy}
        modelSelectRef={modelSelectRef}
        autonomyLevel={agents?.autonomyLevel ?? 'supervised'}
        onAutonomyChange={agents?.setAutonomyLevel ?? (() => {})}
        phase={store.phase}
        onCollapse={onCollapse}
        collapseDisabled={collapseDisabled}
        widthState={widthState}
        onToggleWidth={onToggleWidth}
        conversations={conversationTabs}
        activeConversationId={agents?.activeConversationId}
        onSelectConversation={agents?.setActiveConversationId}
        onCloseConversation={handleCloseConversation}
        onRenameConversation={agents ? handleRenameConversation : undefined}
        openConversationCapReached={(agents?.conversationOrder.length ?? 0) >= MAX_OPEN_MANAGER_CONVERSATIONS}
        tier={panelTier}
      />

      {/* Body wrapper: the history drawer overlay anchors to THIS box (not
          the outer panel), so it starts below the header instead of on top
          of it. */}
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {showHistory && (
          <LazyManagerHistoryDrawer
            sessions={store.sessions}
            onOpenSession={handleLoadSession}
            onDeleteSession={store.deleteSession}
            onClose={() => setShowHistory(false)}
            disabled={store.busy}
          />
        )}

        {/* "Nouvelle conversation" confirmation toast — see this
            component's own `newConversationToast` doc comment above. Floats
            above the (now-empty) transcript, self-dismisses, never blocks
            interaction (pointerEvents:none). */}
        {newConversationToast && (
          <div
            data-testid="lazy-manager-new-conversation-toast"
            style={{
              position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
              zIndex: 5, pointerEvents: 'none', maxWidth: '90%',
              background: 'var(--color-panel-2)', border: '1px solid var(--color-accent-border, rgba(124,92,255,0.4))',
              borderRadius: 8, padding: '6px 14px', fontSize: 11.5, fontWeight: 600,
              color: 'var(--color-accent-pale)', boxShadow: '0 4px 16px -4px rgba(0,0,0,0.5)',
              textAlign: 'center',
            }}
          >
            {t(newConversationToast.interrupted ? 'lazyManager.newConversationStartedInterrupted' : 'lazyManager.newConversationStarted')}
          </div>
        )}

        {/* Messages + signals */}
        <LazyManagerMessageList
          scrollRef={scrollRef}
          onScroll={handleMessageListScroll}
          mode={store.mode}
          busy={store.busy}
          phase={store.phase}
          signals={signals}
          onAnswerSignal={onAnswerSignal}
          onSignalAction={onSignalAction}
          messagesOverride={messagesOverride}
          managerMessages={agents?.managerMessages ?? []}
          assistantMessages={assistant?.messages ?? []}
          onFocusModel={() => modelSelectRef.current?.focus()}
          onRetry={handleRetryMessage}
          onAcceptProposal={handleAcceptProposal}
          onModifyProposal={handleModifyProposal}
          onRejectProposal={handleRejectProposal}
          onStepModelChange={handleStepModelChange}
          pendingApprovals={agents?.pendingApprovals ?? []}
          // Every pending-approval action below is scoped to the ACTIVE
          // conversation (multi-conversation LazyManager, wave 1) — this
          // message list only ever renders the active conversation's own
          // transcript/pendingApprovals, so its actions must resolve
          // against that SAME conversation, never a stale/wrong one.
          onApprovePendingAction={(id: string) => (agents ? agents.approvePendingAction(agents.activeConversationId, id) : Promise.resolve({ ok: false }))}
          onRejectPendingAction={(id: string) => { if (agents) agents.rejectPendingAction(agents.activeConversationId, id); }}
          onApproveAllPendingActions={(turnId: string) => (agents ? agents.approveAllPendingActions(agents.activeConversationId, turnId) : Promise.resolve([]))}
          onRejectAllPendingActions={(turnId: string) => { if (agents) agents.rejectAllPendingActions(agents.activeConversationId, turnId); }}
          onForcePendingAction={(id: string) => (agents ? agents.approvePendingAction(agents.activeConversationId, id, { force: true }) : Promise.resolve({ ok: false }))}
          onAnswerDecision={handleAnswerDecision}
          onValidateCharter={handleValidateCharter}
          onRejectCharter={handleRejectCharter}
          onSelectArtifactVariant={handleSelectArtifactVariant}
          onRejectArtifact={handleRejectArtifact}
          activeRegimes={activeRegimes}
          onRevertRegimeToTrial={handleRevertRegimeToTrial}
          onStopRegime={handleStopRegime}
          isActionQueued={queue.isQueued}
          isActionFailed={queue.isFailed}
          brainRecall={store.brainRecall}
          brainError={store.brainError}
          brainEnabled={store.brainEnabled}
          onRetryBrain={store.retryBrain}
        />

        {/* Persistent Accept/Reject bar (real-user design 2026-08-03,
            Cursor/Windsurf-style): while actions are pending, the
            accept/reject controls stay pinned ABOVE the chat — one click,
            always visible — instead of living only inside a card buried in
            the transcript. Works in every approval mode (manual/auto_green/
            full_auto).

            SAFETY FIX (2026-08-15): this used to be the ONLY approval
            surface a user could reach without scrolling into the transcript
            history, yet it rendered a bare count and bulk buttons with no
            indication of what was actually being approved — approving blind
            in an app that runs shell commands and writes files on the real
            machine. PendingApprovalBar now renders each pending action's
            tool name, its label/argument, an expand affordance for the full
            untruncated text, and its own Approve/Reject — see that
            component's own doc comment.

            HONESTY FIX (real user report, 2026-08-14 — "M4/M5 zombie
            approval loop" incident): these handlers used to be pure
            fire-and-forget (`void agents.approvePendingAction(...)`),
            discarding the real outcome — a blocked approve_mission rendered
            no reason anywhere on this bar and repeated "Tout approuver"
            clicks silently did nothing observable. Now returns the SAME
            real outcome the in-transcript card's onApprove/onApproveAll/
            onForce already do (see those props just above), so
            PendingApprovalBar can show the system's own reason and a Force
            retry when one might help — never a silent dead end. */}
        <PendingApprovalBar
          pending={pendingApprovalBarItems}
          onApprove={(id) => {
            if (id.startsWith('solari:')) {
              resolveApproval(id.slice('solari:'.length), 'approve');
              return Promise.resolve({ ok: true });
            }
            return agents ? agents.approvePendingAction(agents.activeConversationId, id) : Promise.resolve({ ok: false });
          }}
          onReject={(id) => {
            if (id.startsWith('solari:')) {
              resolveApproval(id.slice('solari:'.length), 'deny');
              return;
            }
            if (agents) agents.rejectPendingAction(agents.activeConversationId, id);
          }}
          onApproveAll={(turnId) => {
            if (turnId === '__solari__') {
              for (const p of listPendingApprovals()) resolveApproval(p.missionId, 'approve');
              return Promise.resolve([]);
            }
            return agents ? agents.approveAllPendingActions(agents.activeConversationId, turnId) : Promise.resolve([]);
          }}
          onRejectAll={(turnId) => {
            if (turnId === '__solari__') {
              for (const p of listPendingApprovals()) resolveApproval(p.missionId, 'deny');
              return;
            }
            if (agents) agents.rejectAllPendingActions(agents.activeConversationId, turnId);
          }}
          onForce={(id) => {
            if (id.startsWith('solari:')) {
              resolveApproval(id.slice('solari:'.length), 'approve');
              return Promise.resolve({ ok: true });
            }
            return agents ? agents.approvePendingAction(agents.activeConversationId, id, { force: true }) : Promise.resolve({ ok: false });
          }}
        />

        {/* Composer */}
        <LazyManagerComposer
          mode={store.mode}
          input={input}
          setInput={setInput}
          onSend={handleSend}
          onStop={handleStop}
          busy={store.busy}
          inputRef={inputRef}
          onKeyDown={handleInputKeyDown}
          onLaunchAgent={handleLaunchAgent}
          quickActions={quickActions}
          identity={identity}
          onStopAll={handleDirectStopAll}
          onCleanup={handleDirectCleanup}
        />
      </div>
    </div>
  );
}
