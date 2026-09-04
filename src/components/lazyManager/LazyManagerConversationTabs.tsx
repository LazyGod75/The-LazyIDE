/* LazyManagerConversationTabs — the multi-conversation tab strip, split
   out of LazyManagerHeader.tsx (which was pushing 900+ lines) so the
   narrow-width fixes below have a small, focused file of their own.

   Three real bugs fixed here, all only visible with several open
   conversations (real QA repro, 2026-08-14/2026-08-15):

   1. A tab's label could get HARD-CLIPPED with no ellipsis at all
      ("Repon" instead of "Repon…"). Root cause: the label `<span>` had
      `overflow:hidden; textOverflow:ellipsis` but no `minWidth:0` — on a
      flex child (the label sits inside the tab's flex `<button>`), the
      browser's default `min-width:auto` floors the span at its own
      content width, so it never actually shrinks small enough for its OWN
      ellipsis to engage. What clips it instead is the ANCESTOR wrapper's
      `overflow:hidden` (`maxWidth: 168`), which has no `text-overflow` of
      its own — a silent hard cut, exactly the "cut mid-word" defect
      reported. `minWidth: 0` on the span restores the real shrink-and-
      ellipsis path.

   2. Several open conversations sharing the same first user message
      rendered as visually IDENTICAL tabs (see conversationTabLabel.ts's
      own doc comment for the full repro) — fixed one layer up, in
      LazyManager.tsx's use of buildConversationTabLabels; this file only
      renders whatever `title`/`fullTitle` it's given. A user can also
      break a collision (or just pick a name they recognize) themselves —
      double-clicking a tab's label enters an inline rename (see
      `renamingId` state below), persisted via `onRenameConversation`
      (agentsStore.tsx's renameManagerConversation).

   3. With 6 tabs open (MAX_OPEN_MANAGER_CONVERSATIONS) the strip could
      genuinely overflow its available width — the old fix just left the
      browser's own horizontal scrollbar to handle it (`overflowX: auto`),
      which reads as raw/crude next to the rest of this panel's chrome.
      This now hides that native scrollbar (see design-system.css's
      `.lazy-manager-tab-scroll` rule) and replaces it with VS Code's own
      editor-tab-overflow pattern: small chevron buttons at each end of the
      strip that only render when there is actually more to scroll to in
      that direction, scrolling by one tab-width's worth per click. The
      trailing "+" (new conversation) button is now OUTSIDE the scrollable
      region entirely — VS Code's own "new tab" affordance is never itself
      one of the things that can scroll out of view. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { conversationAccentColor } from '../../lib/agents/conversationColor';
import type { PanelWidthTier } from './panelWidthTier';
import type { ManagerConversationTab } from './LazyManagerHeader';

/**
 * Accessibility fix (real user QA, 2026-08-15): the open-conversation-cap
 * disable reason on BOTH "New conversation" entry points (this file's own
 * trailing "+", AND LazyManagerHeader.tsx's "+ Nouvelle" pill) used to live
 * ONLY in a `title` attribute, which a hover-only sighted user can read but
 * a screen-reader/keyboard user hitting the disabled control never gets
 * announced at all. Defined HERE (not in LazyManagerHeader.tsx, which
 * already imports this file's own component) so LazyManagerHeader.tsx can
 * import it without creating a runtime import cycle. Shared by both
 * buttons' `aria-describedby` and the single visually-hidden (`.sr-only`,
 * design-system.css) text node LazyManagerHeader.tsx renders once, beside
 * its own pill — ARIA doesn't require DOM order/adjacency for the
 * reference to resolve, so this file's button can point at that SAME id
 * without duplicating the text a second time.
 */
export const OPEN_CONVERSATION_CAP_REASON_ID = 'lazy-manager-open-cap-reason';

interface LazyManagerConversationTabsProps {
  conversations: ManagerConversationTab[];
  activeConversationId?: string;
  onSelectConversation?: (id: string) => void;
  onCloseConversation?: (id: string) => void;
  /** Item 3 fix — double-click a tab's label to rename it (see this file's
   *  own header comment). `undefined` renders no rename affordance at all,
   *  same "no handler, no extra UI" contract as `onCloseConversation`. */
  onRenameConversation?: (id: string, title: string) => void;
  onNewSession: () => void;
  openConversationCapReached: boolean;
  tier: PanelWidthTier;
}

/** A single tab's max width, per tier — at `narrow`, a tighter cap so one
 *  long-titled tab can't eat the little strip width there is, leaving
 *  none for its siblings. */
function tabMaxWidth(tier: PanelWidthTier): number {
  return tier === 'narrow' ? 128 : 168;
}

/** How far one click of a scroll-overflow chevron moves the strip — a
 *  little less than tabMaxWidth('wide') so the tab straddling the visible
 *  edge is never left exactly half-cut after a click. */
const SCROLL_STEP_PX = 150;

/** Small chevron button shared by the two scroll-overflow controls below —
 *  same 20px icon-button convention as the trailing "+" button, just
 *  narrower (it never carries a text label). */
function ScrollChevronButton({
  direction, onClick, label,
}: { direction: 'left' | 'right'; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      data-testid={`lazy-manager-conversation-tab-scroll-${direction}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 20, flexShrink: 0, borderRadius: 4,
        border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
        color: 'rgba(255,255,255,0.45)', transition: 'color 0.15s, background 0.15s',
      }}
      onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.9)'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.45)'; e.currentTarget.style.background = 'transparent'; }}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
        {direction === 'left'
          ? <path d="M6 1L2 4l4 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          : <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
    </button>
  );
}

export function LazyManagerConversationTabs({
  conversations,
  activeConversationId,
  onSelectConversation,
  onCloseConversation,
  onRenameConversation,
  onNewSession,
  openConversationCapReached,
  tier,
}: LazyManagerConversationTabsProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Item 3 fix — inline rename state. `renamingId` is the SINGLE tab
  // currently being edited (never more than one at once); `renamingValue`
  // is the input's own live text, seeded from that tab's raw
  // `customTitle` (never the truncated display `title`) when the rename
  // starts.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');

  const startRename = useCallback((conv: ManagerConversationTab) => {
    if (!onRenameConversation) return;
    setRenamingId(conv.id);
    setRenamingValue(conv.customTitle ?? '');
  }, [onRenameConversation]);

  const commitRename = useCallback(() => {
    if (renamingId) onRenameConversation?.(renamingId, renamingValue);
    setRenamingId(null);
  }, [renamingId, renamingValue, onRenameConversation]);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
  }, []);

  // Recomputes which scroll-overflow chevron(s) should render — a couple
  // px of slop on both edges so a sub-pixel scroll position (some browsers
  // report fractional scrollLeft under display scaling) never leaves a
  // chevron stuck visible with nothing left to actually scroll to.
  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    updateScrollState();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    return () => observer.disconnect();
    // conversations.length: adding/closing a tab changes the strip's own
    // content width, which can flip either chevron's visibility even with
    // no scroll/resize event of its own.
  }, [conversations.length, updateScrollState]);

  const scrollBy = (delta: number) => {
    scrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  if (conversations.length <= 1) return null;

  const maxWidth = tabMaxWidth(tier);

  return (
    <div
      data-testid="lazy-manager-conversation-tabs"
      style={{
        display: 'flex', alignItems: 'center', gap: 2, padding: '8px 16px 0', minWidth: 0,
      }}
    >
      {canScrollLeft && (
        <ScrollChevronButton direction="left" onClick={() => scrollBy(-SCROLL_STEP_PX)} label={t('lazyManager.conversationTab.scrollLeft')} />
      )}
      <div
        ref={scrollRef}
        onScroll={updateScrollState}
        className="lazy-manager-tab-scroll"
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          overflowX: 'auto', flex: 1, minWidth: 0,
        }}
      >
        {conversations.map((conv, idx) => {
          const active = conv.id === activeConversationId;
          const color = conversationAccentColor(conv.id);
          const statusKey = conv.phase === 'queued'
            ? 'lazyManager.conversationTab.queued'
            : conv.busy
              ? 'lazyManager.conversationTab.busy'
              : 'lazyManager.conversationTab.idle';
          const statusText = t(statusKey, { n: idx + 1 });
          const label = conv.title ?? String(idx + 1);
          const baseTooltip = conv.fullTitle ? `${statusText} — ${conv.fullTitle}` : statusText;
          const tooltip = onRenameConversation
            ? `${baseTooltip}\n${t('lazyManager.conversationTab.renameHint')}`
            : baseTooltip;
          const handleCloseKeyDown = (e: React.KeyboardEvent) => {
            if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              e.stopPropagation();
              onCloseConversation?.(conv.id);
            }
          };
          const isRenaming = renamingId === conv.id;
          return (
            <div
              key={conv.id}
              data-testid="lazy-manager-conversation-tab"
              data-active={active}
              data-busy={conv.busy}
              style={{
                display: 'flex', alignItems: 'center', gap: 0,
                borderRadius: 999, border: `1px solid ${active ? color : 'transparent'}`,
                background: active ? `${color}26` : 'rgba(255,255,255,0.04)',
                flexShrink: 0, maxWidth: isRenaming ? undefined : maxWidth, overflow: isRenaming ? 'visible' : 'hidden',
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              {isRenaming ? (
                // Rename input — a plain <div>, never a <button> (an
                // `<input>` inside a `<button>` is invalid HTML and drops
                // focus/click handling in some browsers), same status dot
                // as the button below so identity doesn't flicker while
                // editing.
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px 3px 9px', minWidth: 0 }}>
                  <span
                    aria-hidden="true"
                    style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }}
                  />
                  <input
                    autoFocus
                    type="text"
                    data-testid="lazy-manager-conversation-tab-rename-input"
                    aria-label={t('lazyManager.conversationTab.rename')}
                    placeholder={t('lazyManager.conversationTab.renamePlaceholder')}
                    value={renamingValue}
                    onChange={(e) => setRenamingValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                    }}
                    style={{
                      width: 110, minWidth: 0, background: 'transparent', border: 'none',
                      borderBottom: `1px solid ${color}`, color: 'var(--color-text)', fontFamily: 'inherit',
                      fontSize: 10.5, fontWeight: 600, outline: 'none', padding: '0 0 1px',
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelectConversation?.(conv.id)}
                  onDoubleClick={() => startRename(conv)}
                  onKeyDown={handleCloseKeyDown}
                  title={tooltip}
                  aria-pressed={active}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, padding: '3px 4px 3px 9px',
                    border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
                    color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
                    fontSize: 10.5, fontWeight: 600, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden',
                  }}
                >
                  <span
                    aria-hidden="true"
                    data-testid="lazy-manager-conversation-tab-dot"
                    style={{
                      width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0,
                      opacity: conv.phase === 'queued' ? 0.4 : 1,
                      animation: conv.phase === 'turn' || conv.phase === 'grounding' ? 'blinkDot 2s infinite' : 'none',
                    }}
                  />
                  {/* Fix #1 (this file's own doc comment): `minWidth: 0` is
                      what lets this span actually shrink below its content
                      width so `textOverflow: ellipsis` has something to do —
                      without it, the ancestor's `overflow:hidden` silently
                      hard-clips instead, with no ellipsis ever shown. */}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                </button>
              )}
              <button
                type="button"
                data-testid="lazy-manager-conversation-tab-close"
                aria-label={t('lazyManager.conversationTab.close')}
                title={t('lazyManager.conversationTab.close')}
                onClick={(e) => { e.stopPropagation(); onCloseConversation?.(conv.id); }}
                onKeyDown={handleCloseKeyDown}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 16, height: 16, margin: '0 4px 0 1px', borderRadius: '50%',
                  border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
                  color: 'var(--color-text-muted)', flexShrink: 0, padding: 0,
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.14)'; e.currentTarget.style.color = 'var(--color-text)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-muted)'; }}
              >
                <svg width="7" height="7" viewBox="0 0 8 8" fill="none">
                  <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
      {canScrollRight && (
        <ScrollChevronButton direction="right" onClick={() => scrollBy(SCROLL_STEP_PX)} label={t('lazyManager.conversationTab.scrollRight')} />
      )}
      <button
        type="button"
        data-testid="lazy-manager-conversation-tab-add"
        onClick={onNewSession}
        disabled={openConversationCapReached}
        title={openConversationCapReached ? t('lazyManager.newConversationBusyHint') : t('lazyManager.newConversation')}
        aria-label={t('lazyManager.newConversation')}
        aria-describedby={openConversationCapReached ? OPEN_CONVERSATION_CAP_REASON_ID : undefined}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginLeft: 2,
          border: '1px dashed rgba(255,255,255,0.18)', background: 'transparent',
          cursor: openConversationCapReached ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
          color: openConversationCapReached ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.45)',
          opacity: openConversationCapReached ? 0.5 : 1, transition: 'color 0.15s, background 0.15s',
        }}
        onMouseEnter={e => { if (!openConversationCapReached) { e.currentTarget.style.color = 'rgba(255,255,255,0.9)'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; } }}
        onMouseLeave={e => { if (!openConversationCapReached) { e.currentTarget.style.color = 'rgba(255,255,255,0.45)'; e.currentTarget.style.background = 'transparent'; } }}
      >
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
          <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
