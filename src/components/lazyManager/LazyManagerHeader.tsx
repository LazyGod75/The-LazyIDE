/* LazyManagerHeader — single unified header for the LazyManager panel.
   Contains: identity avatar, name, engine badge, mode toggle chips,
   history button, new conversation button, model picker.
   Replaces both IdentityHeader (from LazyManagerUnified) and
   AssistantHeader (from assistant/). */

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useLazyManagerStoreOptional } from './lazyManagerStore';
import { useDismissable } from '../common/useDismissable';
import type { ManagerMode } from './lazyManagerStore';
import { useAgentsStoreOptional } from '../agents/agentsStore';
import { getProviderMode, hasManagedCreditsActive, resolveByokDef, loadAccessSettings } from '../../lib/models';
import { detectModelEntitlements, buildModelPickerOptions, isSelectablePickerModel } from '../../lib/models/modelPickerOptions';
import { findOpenRouterModel } from '../../lib/models/openrouterCatalog';
import { useSubscriptionContext, formatRenewalDate } from '../../lib/billing';
import { emit, on } from '../../lib/bus';
import type { AutonomyMode } from '../../lib/agents/types';
import { LazyManagerConversationTabs, OPEN_CONVERSATION_CAP_REASON_ID } from './LazyManagerConversationTabs';
import { getPanelWidthTier, type PanelWidthTier } from './panelWidthTier';

/**
 * One tab strip entry — structurally mirrored from agentsStore.tsx's
 * ManagerConversationState (never imported), same "structurally mirrored"
 * convention PendingApprovalCard.tsx/LazyManagerMessageList.tsx already use
 * for PendingApprovalAction. Only the fields the tab strip actually renders.
 */
export interface ManagerConversationTab {
  id: string;
  busy: boolean;
  phase: 'idle' | 'turn' | 'grounding' | 'queued';
  /** Item 2 fix — short, derived label (LazyManager.tsx's own doc comment
   *  on conversationTabs has the truncation contract). `undefined` for a
   *  still-empty conversation, which falls back to its 1-based ordinal
   *  below — never a blank tab. */
  title?: string;
  /** Untruncated counterpart to `title` above, for the tab's tooltip only
   *  (never rendered inline — that's what `title` is for). Same
   *  `undefined`-when-empty contract. */
  fullTitle?: string;
  /** Rename feature — the RAW user-chosen name (agentsStore.tsx's
   *  ManagerConversationState.customTitle), if this conversation has ever
   *  been renamed. `undefined` when it hasn't — distinct from `title`
   *  above (which is always the truncated DISPLAY label, derived or
   *  custom) because the rename input needs the untruncated original to
   *  prefill with, not whatever got cut for the tab strip. */
  customTitle?: string;
}

export type EngineKey = 'claude-code' | 'codex' | 'live-key' | 'managed' | 'pro' | 'mock';

/** Engine keys that consume Lazy-managed credits — every other key runs
 *  via a CLI subscription (claude-code/codex) or the user's own API key
 *  (live-key), never Lazy's own metered credits. Exported for
 *  GraphProposalCard.tsx's item 7 fix (credits-vs-subscription estimate
 *  display) — same "reuse, never a second classification" rule as the
 *  credits conversion itself. */
export const CREDIT_METERED_ENGINES: ReadonlySet<EngineKey> = new Set(['managed', 'pro']);

export const ENGINE_I18N_KEY: Record<EngineKey, string> = {
  'claude-code': 'assistant.engine.claudeCode',
  'codex':       'assistant.engine.codex',
  'live-key':    'assistant.engine.liveKey',
  'managed':     'assistant.engine.managed',
  'pro':         'assistant.engine.pro',
  'mock':        'assistant.engine.mock',
};

const ENGINE_COLOR: Record<string, string> = {
  'claude-code': 'rgba(124,92,255,0.18)',
  'codex':       'rgba(74,192,252,0.16)',
  'live-key':    'rgba(74,192,252,0.16)',
  'managed':     'rgba(124,92,255,0.18)',
  'pro':         'rgba(246,169,69,0.14)',
  'mock':        'rgba(255,255,255,0.07)',
};

const ENGINE_TEXT_COLOR: Record<string, string> = {
  'claude-code': '#A78BFF',
  'codex':       '#74C0FC',
  'live-key':    '#74C0FC',
  'managed':     '#A78BFF',
  'pro':         '#F6A945',
  'mock':        'rgba(255,255,255,0.35)',
};

/** Safety cutoff for the "+ Nouvelle" busy dot (see its own doc comment
 *  where it's consumed, in the component body below) — 3 minutes,
 *  comfortably past streamTimeout.ts's own 30s idle-stream cutoff (the
 *  bound on how long any real turn can go without producing output before
 *  the app itself gives up on it), so a genuinely busy turn's dot is never
 *  masked; it exists purely to stop trusting a wedged upstream flag. */
export const BUSY_DOT_SAFETY_TIMEOUT_MS = 180_000;

interface LazyManagerHeaderProps {
  mode: ManagerMode;
  onModeChange: (m: ManagerMode) => void;
  onShowHistory: () => void;
  onNewSession: () => void;
  disabled: boolean;
  modelSelectRef: React.RefObject<HTMLSelectElement | null>;
  autonomyLevel: AutonomyMode;
  onAutonomyChange: (mode: AutonomyMode) => void;
  phase: 'idle' | 'turn' | 'grounding' | 'streaming' | 'queued';
  onCollapse?: () => void;
  collapseDisabled?: boolean;
  /** Current overlay width state + manual widen/narrow toggle (cockpit
   *  only — see ManagerOverlay.tsx's header comment for the full state
   *  machine). The button only renders when `onToggleWidth` is provided
   *  (undefined in the CodeSpace usage of LazyManager). */
  widthState?: 'normal' | 'expanded' | 'collapsed';
  onToggleWidth?: () => void;
  /**
   * Multi-conversation LazyManager (wave 1) — every currently OPEN
   * orchestrator conversation, in tab-strip order, plus which one is
   * active and how to switch. Empty (or a single entry) in coder mode /
   * whenever agentsStore is unavailable — the tab strip renders nothing in
   * that case (a single-conversation, single-tab experience reads the same
   * as before this feature existed).
   */
  conversations?: ManagerConversationTab[];
  activeConversationId?: string;
  onSelectConversation?: (id: string) => void;
  /**
   * Tab-strip close ("x" on a tab, or Delete/Backspace while a tab is
   * focused). Undefined has the SAME "renders nothing extra" contract as
   * `conversations` defaulting to `[]` — no close affordance without a real
   * handler wired (LazyManager.tsx always wires one when agentsStore is
   * available). See agentsStore.tsx's closeManagerConversation for the
   * closing-vs-deleting / busy / last-tab / active-tab semantics this
   * button triggers.
   */
  onCloseConversation?: (id: string) => void;
  /**
   * Rename feature — double-click a tab (LazyManagerConversationTabs.tsx)
   * to persist a custom name for it (agentsStore.tsx's
   * renameManagerConversation). `undefined` has the SAME "renders nothing
   * extra" contract as `onCloseConversation` — no rename affordance
   * without a real handler wired.
   */
  onRenameConversation?: (id: string, title: string) => void;
  /**
   * True once conversationOrder.length has reached
   * MAX_OPEN_MANAGER_CONVERSATIONS — the ONLY condition that actually
   * disables the "+" button (real user test, 2026-08-01 QA fix this
   * preserves): a turn being in flight on the active conversation NEVER
   * disables it, see this button's own inline doc comment below.
   */
  openConversationCapReached?: boolean;
  /**
   * The PANEL's own measured width tier (panelWidthTier.ts) — NOT the app
   * viewport, which the docked/expanded panel is only ever a fraction of.
   * `undefined` (every pre-existing caller/test) resolves to `'wide'`
   * inside panelWidthTier.ts's own getPanelWidthTier, so omitting this prop
   * keeps rendering the single-row layout every existing test already
   * asserts on. LazyManager.tsx is the only real caller that measures and
   * passes a live value (see that file's own ResizeObserver).
   */
  tier?: PanelWidthTier;
}

export function LazyManagerHeader({
  mode,
  onModeChange,
  onShowHistory,
  onNewSession,
  disabled,
  modelSelectRef,
  autonomyLevel,
  onAutonomyChange,
  phase,
  onCollapse,
  collapseDisabled,
  widthState,
  onToggleWidth,
  conversations = [],
  activeConversationId,
  onSelectConversation,
  onCloseConversation,
  onRenameConversation,
  openConversationCapReached = false,
  tier: tierProp,
}: LazyManagerHeaderProps) {
  const { t, locale } = useI18n();
  // See this prop's own doc comment: `undefined` (no live measurement yet,
  // or a caller/test that never passes it) resolves to the wide layout,
  // never a flash of the compact one on first mount.
  const tier: PanelWidthTier = tierProp ?? getPanelWidthTier(undefined);
  const agents = useAgentsStoreOptional();
  const store = useLazyManagerStoreOptional();
  const { subscription } = useSubscriptionContext();
  const [showAcceptance, setShowAcceptance] = useState(false);
  const acceptanceTriggerRef = useRef<HTMLButtonElement>(null);
  // LazyBots (A3) — bot → manager human-intervention requests (login/2FA/
  // takeover). Kept as a tiny local map botId → latest request; the note
  // renders at the top of the header (data-testid="bot-intervention-<botId>")
  // and persists for the component's lifetime — a bot re-emits on each new
  // ask, refreshing the entry. Never throws: the bus event is pure signal.
  const [botInterventions, setBotInterventions] = useState<Record<string, { reason: string; detail?: string; at: number }>>({});
  useEffect(() => {
    return on('bot:intervention', (p) => {
      setBotInterventions((prev) => ({ ...prev, [p.botId]: { reason: p.reason, detail: p.detail, at: p.at } }));
    });
  }, []);
  // Backdrop-leak fix (real prod repro, 2026-08-04: menu opens, a click
  // elsewhere visually closes it, but something kept intercepting every
  // subsequent click in the panel until a full reload — DOM inspection
  // showed an empty `<div>` still mounted). Root cause: this popover was
  // hand-rolled with its own `position:fixed` backdrop div + bespoke
  // onClick, the ONLY icon-triggered popover in the app that doesn't go
  // through the shared `useDismissable` hook (src/components/common/
  // useDismissable.ts — already used by 13+ others, including this exact
  // file's sibling AgentMentionPopup.tsx) — that hook's own header
  // documents this as the "third occurrence" of a real bug family (a naive
  // outside-pointerdown listener racing the trigger button's own onClick).
  // Switching to it removes the hand-rolled backdrop DIV entirely (nothing
  // left to ever leak) and adds Escape handling this popover never had.
  // `ignoreRefs: [acceptanceTriggerRef]` is what lets a re-click on the
  // trigger button toggle closed normally instead of the outside-pointerdown
  // listener and the button's own onClick fighting over the same click.
  const acceptancePopoverRef = useDismissable<HTMLDivElement>({
    open: showAcceptance,
    onClose: () => setShowAcceptance(false),
    ignoreRefs: [acceptanceTriggerRef],
  });

  // "+ Nouvelle" busy-dot safety timeout (real user report: the pill read
  // grey/stuck for 30s+ with no turn actually running). Multi-conversation
  // LazyManager (wave 1, 2026-08-01) already made the button's own
  // `disabled` HTML attribute depend ONLY on `openConversationCapReached`
  // (see that prop's own doc comment + lazyManagerNewConversationBusy.test
  // .tsx) — `disabled` (busy, below) no longer gates clickability, only this
  // amber dot. This component holds no persisted state of its own: both
  // `disabled` and `openConversationCapReached` arrive fresh on every parent
  // render from live store data, so neither can get "stuck" INSIDE this
  // file — but a stale/wedged upstream busy signal (a hydration race, a
  // future regression) would still surface here as a `disabled` prop that
  // never flips back to false, leaving the dot lying indefinitely. This is
  // the missing safety net: once `disabled` has been continuously true for
  // longer than any real manager turn plausibly takes
  // (BUSY_DOT_SAFETY_TIMEOUT_MS — comfortably past streamTimeout.ts's own
  // 30s idle-stream cutoff, which already bounds how long a real turn can
  // go without producing output before the app itself gives up on it), the
  // dot stops trusting the signal and hides itself rather than showing a
  // stale "something's busy" cue forever. Starts a FRESH window on every
  // mount (a freshly booted/reloaded panel never inherits a timer from a
  // previous session) and resets immediately the moment `disabled` itself
  // flips back to false.
  const [busyDotStale, setBusyDotStale] = useState(false);
  useEffect(() => {
    if (!disabled) {
      setBusyDotStale(false);
      return;
    }
    const timer = setTimeout(() => setBusyDotStale(true), BUSY_DOT_SAFETY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [disabled]);
  // Docked-width crowding fix (real user screenshot, 2026-08-02), REVISED
  // same day after the owner rejected the first pass outright: "je comprends
  // pas ton délire du bouton nouvelle conversation, je suis censé pouvoir
  // ouvrir une nouvelle conversation quand je veux et une autre session
  // quand je veux aussi". Starting a conversation and reopening a past one
  // are both PRIMARY actions for him — hiding either based on state (the
  // first pass hid "+ Nouvelle" once a second conversation opened, and
  // buried History in this menu) is backwards: the moment he's actively
  // using the feature is exactly when the control disappeared. Only Widen
  // and Collapse — both of which already have keyboard equivalents ('E' for
  // widen, see ManagerOverlay.tsx's own doc comment) — are genuinely
  // secondary enough to live behind this "..." menu. "+ Nouvelle" and
  // History are now direct, always-visible Row-1 controls; the room for
  // them is taken from here (two fewer always-visible items) instead of
  // from the title block or by hiding the primary actions.
  const [showMoreActions, setShowMoreActions] = useState(false);

  const engineMode = getProviderMode();
  let engineLabel: string;
  if (engineMode === 'live-key') {
    // BYOK wave: the badge shows the SELECTED provider (DeepSeek, OpenRouter,
    // xAI, ...), not a generic "Claude" label — real-user report 2026-08-03
    // ("j'ai DeepSeek d'activé et le badge dit encore Claude").
    const byokDef = resolveByokDef(loadAccessSettings().byokProvider);
    engineLabel = byokDef ? `${byokDef.label} · clé API` : t(ENGINE_I18N_KEY['live-key']);
  } else {
    engineLabel = t(ENGINE_I18N_KEY[engineMode as EngineKey] ?? 'assistant.engine.mock');
  }
  const engineBg = ENGINE_COLOR[engineMode] ?? ENGINE_COLOR['mock'];
  const engineColor = ENGINE_TEXT_COLOR[engineMode] ?? ENGINE_TEXT_COLOR['mock'];
  const showProBadge = hasManagedCreditsActive() && engineMode !== 'managed' && engineMode !== 'pro';

  // Orchestrator model picker options
  const entitlements = detectModelEntitlements();
  const pickerOptions = buildModelPickerOptions(entitlements, t);

  // Browser: a leftover native id (Sonnet) from before the web picker
  // honesty fix would stay selected and keep failing CLI. Snap to the
  // first unlocked option. Depends on the model id, not pickerOptions
  // identity — that object is rebuilt every render.
  useEffect(() => {
    if (!agents) return;
    if (isSelectablePickerModel(agents.managerModel)) return;
    agents.setManagerModel(pickerOptions.defaultModelId);
  }, [agents, agents?.managerModel, pickerOptions.defaultModelId]);

  const isSelectedModelProRouted = Boolean(findOpenRouterModel(agents?.managerModel ?? ''));
  const creditsRenewalDate = formatRenewalDate(subscription?.period_end, locale);
  const creditsHintText =
    pickerOptions.proExhausted && isSelectedModelProRouted
      ? creditsRenewalDate
        ? t('cockpit.manager.noCreditsHintWithDate', { date: creditsRenewalDate })
        : t('cockpit.manager.noCreditsHint')
      : undefined;

  // P2-18 fix: overflow:hidden + textOverflow:ellipsis used to let flexbox
  // shrink each flex:1 chip BELOW its own text's min-content width (per the
  // CSS spec, min-width:auto only floors a flex item at its content size when
  // overflow is visible) — so "Orchestrateur" (and equally long labels in
  // other locales, e.g. es "Orquestador") got silently truncated to
  // "Orchestr..." whenever this row's available width was tight, even though
  // the row already wraps (flexWrap:'wrap' below) when it genuinely runs out
  // of room. Dropping overflow/textOverflow restores that natural min-content
  // floor, so the label always renders in full and the model picker wraps to
  // its own line instead of stealing space from it.
  const baseChipStyle: React.CSSProperties = {
    flex: 1, padding: '5px 10px', fontSize: 11, fontWeight: 600, textAlign: 'center',
    cursor: 'pointer', border: 'none', fontFamily: 'inherit',
    transition: 'background 0.15s, color 0.15s', whiteSpace: 'nowrap',
  };
  const activeChipStyle: React.CSSProperties = {
    ...baseChipStyle, background: 'rgba(124,92,255,0.18)', color: '#C4B5FD',
  };
  const inactiveChipStyle: React.CSSProperties = {
    ...baseChipStyle, background: 'transparent', color: 'rgba(255,255,255,0.35)',
  };

  const iconBtnStyle = (active: boolean): React.CSSProperties => ({
    width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? 'rgba(255,255,255,0.15)' : active ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)',
    borderRadius: 5, background: active && !disabled ? 'rgba(255,255,255,0.08)' : 'transparent',
    border: 'none', fontFamily: 'inherit', flexShrink: 0, transition: 'color 0.15s, background 0.15s',
  });

  // Overflow-menu item (Widen/Collapse only — History moved back to a
  // direct Row-1 control, see `showMoreActions`'s own doc comment above) —
  // same bare-icon-plus-tooltip convention the standalone buttons already
  // used (only the "+ Nouvelle" pill gets a visible text label anywhere in
  // this header), just stacked vertically inside the popover instead of
  // laid out inline.
  const menuItemStyle = (itemDisabled: boolean): React.CSSProperties => ({
    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: itemDisabled ? 'not-allowed' : 'pointer',
    color: itemDisabled ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.7)',
    borderRadius: 6, background: 'transparent',
    border: 'none', fontFamily: 'inherit', transition: 'color 0.15s, background 0.15s',
    opacity: itemDisabled ? 0.4 : 1,
  });

  // Model picker (Row 2) — item 3 fix in this file's own brief: at `wide`
  // it sits inline, pushed to the far right by `marginLeft: auto` (its
  // ORIGINAL look, unchanged). At `compact`/`narrow` that same
  // `marginLeft: auto` used to only take effect once the row's default
  // `flexWrap` happened to push it onto its own line — an accident of
  // available space, not a decision — so it read as a stray right-aligned
  // control on an otherwise-empty row, a different visual weight than
  // every other Row 2 control. `flexBasis: '100%'` makes the break
  // DELIBERATE (always its own row below that width, never conditional on
  // how much text happens to fit) and `width: '100%'` + the wider padding
  // give it the same full-measure weight as the mode-toggle group beside
  // it, instead of floating at partial width on the right.
  const modelPickerStyle: React.CSSProperties = tier === 'wide'
    ? {
        marginLeft: 'auto', background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 6, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)',
        fontSize: 11, padding: '3px 6px',
      }
    : {
        marginLeft: 0, width: '100%', flexBasis: '100%', background: 'transparent',
        border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: 'var(--color-text-muted)',
        fontFamily: 'var(--font-mono)', fontSize: 11, padding: '5px 8px',
      };

  return (
    <div style={{ flexShrink: 0, borderBottom: '1px solid var(--color-border-2)' }}>
      {/* LazyBots (A3) — outstanding bot → human intervention requests
          (login/2FA/takeover, via botRequestIntervention.ts's
          requestUserIntervention). One compact note per bot, keyed by the
          bot's own id; the data-testid lets tests assert a specific bot's
          request. Minimal surface on purpose — the user answers by taking
          over the session or asking the manager to stop the bot run. */}
      {Object.entries(botInterventions).map(([botId, iv]) => (
        <div
          key={botId}
          data-testid={`bot-intervention-${botId}`}
          title={iv.detail ?? iv.reason}
          style={{
            padding: '5px 16px', fontSize: 11, lineHeight: 1.4,
            color: '#FCD34D', background: 'rgba(245,158,11,0.08)',
            borderBottom: '1px solid var(--color-border-2)',
          }}
        >
          ⚠ LazyBot <strong>{botId}</strong> needs you: {iv.reason}
        </div>
      ))}
      {/* Conversation tab strip — extracted to its own file
          (LazyManagerConversationTabs.tsx), see that file's own doc
          comment for the two narrow-width bugs it fixes. Only rendered
          once a second conversation is actually open (its own early
          return), so the overwhelming common case (one conversation)
          reads exactly as before this feature existed. */}
      <LazyManagerConversationTabs
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={onSelectConversation}
        onCloseConversation={onCloseConversation}
        onRenameConversation={onRenameConversation}
        onNewSession={onNewSession}
        openConversationCapReached={openConversationCapReached}
        tier={tier}
      />

      {/* Row 1: identity + engine + actions — tier-aware (panelWidthTier.ts).
          `wide` keeps the ORIGINAL single flex row below, unchanged (the
          primary layout this fix must never regress). `compact`/`narrow`
          split it into two EXPLICIT rows — identity, then the action
          cluster as one atomic group — instead of the `flexWrap` reflow
          this replaces, which is what produced the real defect
          (2026-08-14): "+ Nouvelle" stayed on row 1 while History and the
          status dot dropped onto an orphaned row 2 with a big gap, an
          accidental layout rather than a deliberate one. `identityBlock`/
          `actionsCluster` are built ONCE as JSX fragments (no extra DOM
          node of their own) so neither tier branch duplicates the actual
          control markup below — only the wrapping differs. */}
      {(() => {
        const identityBlock = (
          <>
        {/* Avatar */}
        <span style={{
          width: 32, height: 32, borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--color-accent), var(--color-assistant-cyan))',
          color: '#fff', fontWeight: 700, fontSize: 16, display: 'flex',
          alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          M
        </span>

        {/* Name + engine badge — item 3 fix (real user QA, 2026-08-01): this
            row's flex:1/minWidth:0 parent lets IT shrink narrower than its
            children's combined text width (that's the whole point of
            minWidth:0 on a flex item), but neither this row nor the engine
            badge span had `overflow:hidden` — so at the panel's real
            docked width (~400px), the badge's own text ("Claude ·
            abonnement" or similar) painted PAST its own shrunk box and
            visually overlapped the status dot rendered after it in the
            outer Row 1 flex ("abonne●nt" on screen). `overflow:hidden` on
            this row clips instead of bleeding into siblings; the badge
            itself gets `minWidth:0` (so IT, not just the name span, can be
            the one that shrinks) + ellipsis — its own `title` attribute
            already carries the full text, so nothing is lost, only
            visually truncated when space is tight. The identity name
            (`lazyManager.name`, short in every locale) keeps
            `flexShrink:0` — it is never the one sacrificed for space.

            Docked-width clipping fix (real user screenshot, 2026-08-02):
            this container's OWN `minWidth` used to be `0` too, which — on
            a flex item — doesn't just allow ITS children to shrink, it lets
            the FLEX ALGORITHM shrink this whole box below its content's
            natural minimum (name's flexShrink:0 width included), because
            `min-width:0` is what overrides the browser's default
            `min-width:auto` floor. At the real ~440px docked width, once
            every fixed-size sibling (icons/pill/status dot) claimed its
            share, this box was squeezed narrower than the name alone
            needs, and the name — unable to shrink itself, but sitting
            inside a box now smaller than it — visually overflowed and got
            hard-clipped by this row's `overflow:hidden`. `minWidth:
            'min-content'` restores the real floor: the browser computes it
            from actual children (name's full nowrap width + the badge's
            OWN min-width:0 floor, effectively ~0), so this box can still
            shrink the badge down to nothing, but can never again be forced
            narrower than the name itself — no guessed pixel constant, no
            per-locale drift (the name is unchanged across locales). */}
        <div style={{ minWidth: 'min-content', flex: 1, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text)', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {t('lazyManager.name')}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 500, color: engineColor, background: engineBg,
              border: `1px solid ${engineColor}33`, borderRadius: 4, padding: '1px 6px',
              letterSpacing: '0.01em', lineHeight: '16px', whiteSpace: 'nowrap',
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            }} title={t('assistant.engineLabel', { label: engineLabel })}>
              {engineLabel}
            </span>
            {showProBadge && (
              <span style={{
                fontSize: 10, fontWeight: 600, color: '#F6A945', background: 'rgba(246,169,69,0.14)',
                border: '1px solid rgba(246,169,69,0.32)', borderRadius: 4, padding: '1px 6px',
                letterSpacing: '0.01em', lineHeight: '16px', whiteSpace: 'nowrap', flexShrink: 0,
              }}>
                {t('account.chip.pro')}
              </span>
            )}
          </div>
          <div style={{
            fontSize: 11, color: 'var(--color-accent-pale)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {t('lazyManager.tagline')}
          </div>
        </div>
          </>
        );

        const actionsCluster = (
          <>
        {/* "+ Nouvelle" pill — real-user discoverability fix (2026-08-01 QA:
            "je ne vois pas le bouton pour lancer une nouvelle conv" — a bare
            24px icon read as just another secondary control). Labelled
            icon+text, the ONLY button in this row with its own background/
            border, so it visually reads as "the" action.

            ALWAYS rendered, whatever the conversation count (owner rejected
            the 2026-08-02 attempt to hide it once a second conversation
            opened — see `showMoreActions`'s own doc comment above for the
            verbatim quote). The tab strip's OWN trailing "+" is a second,
            equally valid entry point to this same action once it exists —
            a duplicate is fine and standard (browser/editor tabs both do
            this); it is a hidden primary action that is not fine. */}
        <button
          type="button"
          data-testid="lazy-manager-new-conv"
          onClick={onNewSession}
          // Multi-conversation LazyManager (wave 1): the ONLY real
          // `disabled` condition is the open-conversation cap
          // (MAX_OPEN_MANAGER_CONVERSATIONS) — never a busy turn.
          // Starting a fresh conversation no longer stops/interrupts the
          // active one (it keeps working in the background, on its own
          // tab — that's the whole point), so there is nothing left for
          // a busy turn to protect here. The amber dot below stays as a
          // "something else is still working" cue, not a disable reason.
          disabled={openConversationCapReached}
          title={
            openConversationCapReached
              ? t('lazyManager.newConversationBusyHint')
              : t('lazyManager.newConversation')
          }
          aria-label={t('lazyManager.newConversation')}
          aria-describedby={openConversationCapReached ? OPEN_CONVERSATION_CAP_REASON_ID : undefined}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, height: 24,
            padding: '0 9px 0 7px', position: 'relative',
            cursor: openConversationCapReached ? 'not-allowed' : 'pointer',
            color: openConversationCapReached ? 'rgba(255,255,255,0.2)' : '#C4B5FD',
            borderRadius: 999,
            background: openConversationCapReached ? 'transparent' : 'rgba(124,92,255,0.16)',
            border: `1px solid ${openConversationCapReached ? 'var(--color-border-2)' : 'rgba(124,92,255,0.4)'}`,
            fontFamily: 'inherit', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
            flexShrink: 0, transition: 'color 0.15s, background 0.15s, border-color 0.15s',
            opacity: openConversationCapReached ? 0.6 : 1,
          }}
          onMouseEnter={e => { if (!openConversationCapReached) { e.currentTarget.style.background = 'rgba(124,92,255,0.26)'; } }}
          onMouseLeave={e => { if (!openConversationCapReached) { e.currentTarget.style.background = 'rgba(124,92,255,0.16)'; } }}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          <span>{t('lazyManager.newConversationShort')}</span>
          {openConversationCapReached && (
            <span id={OPEN_CONVERSATION_CAP_REASON_ID} className="sr-only">
              {t('lazyManager.newConversationBusyHint')}
            </span>
          )}
          {disabled && !busyDotStale && (
            <span
              aria-hidden="true"
              data-testid="lazy-manager-new-conv-busy-dot"
              style={{
                position: 'absolute', top: -2, right: -2, width: 6, height: 6, borderRadius: '50%',
                background: 'var(--color-warning)', boxShadow: '0 0 0 1.5px var(--color-panel, #16161D)',
              }}
            />
          )}
        </button>

        {/* History — re-promoted to a direct, always-visible Row-1 control
            (owner, 2026-08-02: "...une autre session quand je veux aussi").
            Opening a past session is primary navigation for him, not an
            occasional action the 2026-08-02 first pass buried in the "..."
            overflow. Icon-only (no text label) — it stays visually
            secondary to the labelled "+ Nouvelle" pill while remaining
            reachable in one click, not two. */}
        <button
          type="button"
          data-testid="lazy-manager-history-btn"
          onClick={onShowHistory}
          title={t('lazyManager.history')}
          aria-label={t('lazyManager.history')}
          style={iconBtnStyle(false)}
          onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)'; e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.1" />
            <path d="M7 3.5v3.5l2.5 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {/* Status dot — real state, not decorative. Always visible (never
            grouped into the overflow menu below) — carries live meaning. */}
        <span
          data-testid="lazy-manager-status-dot"
          title={t(phase === 'idle' ? 'lazyManager.status.idle' : 'lazyManager.status.busy')}
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: phase === 'idle' ? 'var(--color-success)' : 'var(--color-warning)',
            animation: phase !== 'idle' ? 'blinkDot 2s infinite' : 'none',
            flexShrink: 0,
          }}
        />

        {/* Secondary-actions overflow menu (Widen / Collapse only — History
            was re-promoted to its own direct Row-1 control above, see that
            button's own doc comment) — see the `showMoreActions` state's
            own doc comment above for why only these two, both backed by a
            keyboard equivalent, still live behind one 24px "..." trigger.
            Same popover convention as the Acceptance dropdown in Row 2
            below (fixed-inset click-outside backdrop + an
            absolutely-positioned panel). The trigger itself only renders
            when at least one of the two handlers is actually wired
            (CodeSpace's LazyManager instance has neither) — an empty menu
            behind a live-looking "..." would be its own dead-end. */}
        {(onToggleWidth || onCollapse) && (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            data-testid="lazy-manager-more-actions"
            aria-label={t('lazyManager.moreActions')}
            aria-haspopup="true"
            aria-expanded={showMoreActions}
            onClick={() => setShowMoreActions(v => !v)}
            title={t('lazyManager.moreActions')}
            style={iconBtnStyle(showMoreActions)}
            onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = showMoreActions ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)'; e.currentTarget.style.background = showMoreActions ? 'rgba(255,255,255,0.08)' : 'transparent'; }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="3" cy="7" r="1.3" fill="currentColor" />
              <circle cx="7" cy="7" r="1.3" fill="currentColor" />
              <circle cx="11" cy="7" r="1.3" fill="currentColor" />
            </svg>
          </button>
          {showMoreActions && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                onClick={() => setShowMoreActions(false)}
              />
              <div
                data-testid="lazy-manager-more-actions-menu"
                style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 100,
                  background: 'var(--color-panel-2)', border: '1px solid var(--color-border-2)',
                  borderRadius: 8, padding: 4, display: 'flex', alignItems: 'center', gap: 2,
                  boxShadow: '0 8px 24px -8px rgba(0,0,0,0.6)',
                }}
              >
                {/* Widen/narrow toggle — manual override for the
                    discussion/proposal width (ManagerOverlay.tsx's
                    'expanded' state). Only rendered when a toggle handler is
                    actually wired (cockpit usage); CodeSpace's LazyManager
                    instance has no width-state concept at all. */}
                {onToggleWidth && (
                  <button
                    type="button"
                    data-testid="manager-overlay-toggle-width"
                    aria-label={t(widthState === 'expanded' ? 'cockpit.manager.narrow' : 'cockpit.manager.widen')}
                    aria-pressed={widthState === 'expanded'}
                    onClick={() => { onToggleWidth(); setShowMoreActions(false); }}
                    title={t(widthState === 'expanded' ? 'cockpit.manager.narrow' : 'cockpit.manager.widen')}
                    style={menuItemStyle(false)}
                    onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,1)'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; e.currentTarget.style.background = 'transparent'; }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      {widthState === 'expanded' ? (
                        // Inward-pointing arrows — "narrow back down"
                        <path d="M5 2L2 5M2 5h3M2 5V2M9 12l3-3M12 9H9M12 9v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                      ) : (
                        // Outward-pointing arrows — "widen"
                        <path d="M2 2l3 3M5 5H2M5 5V2M12 12l-3-3M9 9h3M9 9v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                      )}
                    </svg>
                  </button>
                )}

                {/* Collapse button — fused into header */}
                {onCollapse && (
                  <button
                    type="button"
                    data-testid="manager-overlay-collapse"
                    aria-label={t('cockpit.manager.collapse')}
                    onClick={() => { onCollapse(); setShowMoreActions(false); }}
                    disabled={collapseDisabled}
                    title={collapseDisabled ? '' : t('cockpit.manager.collapse')}
                    style={menuItemStyle(Boolean(collapseDisabled))}
                    onMouseEnter={e => { if (!collapseDisabled) { e.currentTarget.style.color = 'rgba(255,255,255,1)'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; } }}
                    onMouseLeave={e => { if (!collapseDisabled) { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; e.currentTarget.style.background = 'transparent'; } }}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M10 6l-6 6 6 6" transform="translate(-1 -6)" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        )}
          </>
        );

        if (tier === 'wide') {
          return (
            <div style={{
              padding: '12px 16px 8px', display: 'flex', alignItems: 'center', gap: 10, minWidth: 0,
              // Defensive fallback only — real width handling is the tier
              // branch below; this keeps a first-paint/unmeasured frame
              // from ever hard-overflowing instead of reflowing.
              flexWrap: 'wrap',
            }}>
              {identityBlock}
              {actionsCluster}
            </div>
          );
        }

        // compact/narrow — two EXPLICIT rows (identity, then the action
        // cluster as one atomic group) instead of the accidental
        // `flexWrap` reflow the `wide` branch falls back to — see this
        // IIFE's own opening doc comment for the real defect this fixes.
        return (
          <div style={{ padding: '12px 16px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              {identityBlock}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {actionsCluster}
            </div>
          </div>
        );
      })()}

      {/* Row 2: mode toggle chips + model picker */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        padding: '0 16px 8px', fontSize: 11.5,
      }}>
        {/* Mode toggle */}
        <div data-testid="lazy-manager-mode-toggle" style={{
          display: 'flex', flexShrink: 0, borderRadius: 6, overflow: 'hidden',
          border: '1px solid var(--color-border-2)',
        }}>
          <button
            type="button"
            data-testid="lazy-manager-mode-orchestrator"
            title={t('lazyManager.mode.orchestratorHint')}
            onClick={() => onModeChange('orchestrator')}
            style={mode === 'orchestrator' ? activeChipStyle : inactiveChipStyle}
            onMouseEnter={e => { if (mode !== 'orchestrator') (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
            onMouseLeave={e => { if (mode !== 'orchestrator') (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          >
            {t('lazyManager.mode.orchestrator')}
          </button>
          <button
            type="button"
            data-testid="lazy-manager-mode-coder"
            title={t('lazyManager.mode.coderHint')}
            onClick={() => onModeChange('coder')}
            style={mode === 'coder' ? activeChipStyle : inactiveChipStyle}
            onMouseEnter={e => { if (mode !== 'coder') (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)'; }}
            onMouseLeave={e => { if (mode !== 'coder') (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          >
            {t('lazyManager.mode.coder')}
          </button>
        </div>

        {/* Acceptance popover — compact, not a full row */}
        {mode === 'orchestrator' && (
          <div
            style={{ position: 'relative', flexShrink: 0 }}
            // Blur close — React normalizes focus/blur to bubble (unlike the
            // native DOM events), so this fires for a blur on ANY descendant
            // (the trigger button or one of the four mode buttons below).
            // `relatedTarget` is where focus is GOING; still inside this
            // wrapper (e.g. Tab moving between the trigger and the four mode
            // buttons) is not a close — only focus genuinely leaving the
            // whole control is. Escape and outside-click are handled by
            // useDismissable (acceptancePopoverRef below) — this is the
            // third close path the fix requires.
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setShowAcceptance(false);
            }}
          >
            <button
              ref={acceptanceTriggerRef}
              type="button"
              data-testid="lazy-manager-acceptance-btn"
              onClick={() => setShowAcceptance(v => !v)}
              title={t('lazyManager.acceptance.tooltip')}
              style={{
                ...baseChipStyle,
                flex: 'none',
                background: showAcceptance ? 'rgba(124,92,255,0.14)' : 'transparent',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border-2)',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              {t('lazyManager.acceptance')}
              <span style={{ fontSize: 8, opacity: 0.6 }}>▾</span>
            </button>
            {showAcceptance && (
                <div
                  ref={acceptancePopoverRef}
                  data-testid="lazy-manager-acceptance-popover"
                  style={{
                    position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
                    background: 'var(--color-panel-2)', border: '1px solid var(--color-border-2)',
                    borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 4,
                    minWidth: 180, boxShadow: '0 8px 24px -8px rgba(0,0,0,0.6)',
                  }}
                >
                  {(['manual', 'supervised', 'yolo', 'custom'] as AutonomyMode[]).map(am => {
                    const active = autonomyLevel === am;
                    const labelKey = am === 'yolo' ? 'cockpit.manager.autonomy.yolo' : `cockpit.manager.autonomy.${am}`;
                    const tooltipKey = am === 'yolo' ? 'lazyManager.autonomy.tooltip.lazy' : `lazyManager.autonomy.tooltip.${am}`;
                    return (
                      <button
                        key={am}
                        type="button"
                        data-testid={`lazy-manager-acceptance-${am}`}
                        aria-pressed={active}
                        onClick={() => { onAutonomyChange(am); setShowAcceptance(false); }}
                        title={t(tooltipKey)}
                        style={{
                          textAlign: 'left', padding: '5px 10px', fontSize: 11.5, fontWeight: 600,
                          borderRadius: 6, border: 'none', fontFamily: 'inherit', cursor: 'pointer',
                          background: active ? 'rgba(124,92,255,0.18)' : 'transparent',
                          color: active ? '#C4B5FD' : 'var(--color-text-muted)',
                        }}
                      >
                        <span>{t(labelKey)}</span>
                        <span style={{ display: 'block', fontSize: 10, fontWeight: 400, color: 'var(--color-text-disabled)', lineHeight: 1.3 }}>
                          {t(`lazyManager.autonomy.matrix.${am === 'yolo' ? 'yolo' : am}`)}
                        </span>
                      </button>
                    );
                  })}
                </div>
            )}
          </div>
        )}

        {/* Model picker — changes based on mode */}
        {mode === 'orchestrator' ? (
          <select
            ref={modelSelectRef}
            data-testid="manager-model-select"
            value={agents?.managerModel ?? ''}
            onChange={e => agents?.setManagerModel(e.target.value)}
            disabled={!pickerOptions.hasOptions}
            style={modelPickerStyle}
          >
            {pickerOptions.groups.map(group => (
              <optgroup
                key={group.id}
                label={group.label}
                style={{ backgroundColor: 'var(--color-panel-2)', color: 'var(--color-accent-pale)' }}
              >
                {group.models.map(m => (
                  <option
                    key={m.id}
                    value={m.id}
                    data-testid="manager-model-option"
                    style={{ backgroundColor: 'var(--color-panel-2)', color: 'var(--color-text)' }}
                  >
                    {m.label}
                  </option>
                ))}
              </optgroup>
            ))}
            {pickerOptions.lockedProGroup && (
              <optgroup
                label={pickerOptions.lockedProGroup.label}
                style={{ backgroundColor: 'var(--color-panel-2)', color: 'var(--color-accent-pale)' }}
              >
                {pickerOptions.lockedProGroup.models.map(m => (
                  <option
                    key={m.id}
                    value={m.id}
                    disabled
                    data-testid="manager-model-option-locked"
                    style={{ backgroundColor: 'var(--color-panel-2)', color: 'var(--color-text-muted)' }}
                  >
                    {m.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        ) : (
          <span style={{
            ...modelPickerStyle, border: 'none', padding: 0,
            fontSize: 11, color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
            textAlign: tier === 'wide' ? undefined : 'right',
          }}>
            {store?.selectedModel.label ?? agents?.managerModel ?? '—'}
          </span>
        )}
      </div>

      {/* Credits hint (orchestrator only) */}
      {mode === 'orchestrator' && creditsHintText && (
        <div data-testid="manager-model-credits-hint" style={{ padding: '0 16px 6px', fontSize: 11, color: 'var(--color-text-muted)' }}>
          {creditsHintText}
        </div>
      )}

      {/* Pro upsell (orchestrator only) */}
      {mode === 'orchestrator' && pickerOptions.lockedProGroup && (
        <button
          type="button"
          data-testid="manager-model-pro-upsell"
          onClick={() => emit('nav:openAccountPopover', undefined)}
          style={{
            alignSelf: 'flex-end', background: 'transparent', border: 'none',
            color: 'var(--color-accent-pale)', fontSize: 11, fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', padding: '0 16px 8px', textAlign: 'right',
          }}
        >
          {t('cockpit.manager.proUpsell')}
        </button>
      )}
    </div>
  );
}
