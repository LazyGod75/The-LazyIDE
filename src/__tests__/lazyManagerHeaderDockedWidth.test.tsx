/**
 * LazyManagerHeader — docked-width crowding fix (real user screenshot,
 * 2026-08-02 QA): the conversation tab strip shipped the previous night
 * (f32b47b, 6c9a200) tipped an already-tight Row 1 over capacity at the
 * panel's real ~440px docked width — the product name rendered clipped
 * ("LazyManag…"), and the "+ Nouvelle" pill crowded right up against it.
 *
 * Root cause (traced from the JSX, not guessed): the title block's own
 * flex item had `minWidth: 0`, which — on a flex item — doesn't just let
 * ITS children shrink, it removes the browser's default `min-width:auto`
 * floor on the box ITSELF, so the flex algorithm could squeeze the whole
 * title block narrower than the (flexShrink:0, unshrinkable) product name
 * needs once every fixed-size sibling (History/pill/status dot/widen/
 * collapse) had claimed its share. `minWidth: 'min-content'` restores that
 * floor with no guessed pixel constant.
 *
 * Fix, REVISED same day (2026-08-02): the first pass also hid "+ Nouvelle"
 * once a second conversation opened and buried History behind the "..."
 * overflow menu — the owner rejected that outright ("je suis censé pouvoir
 * ouvrir une nouvelle conversation quand je veux et une autre session
 * quand je veux aussi"): hiding a primary action based on state is
 * backwards. Both are now direct, always-visible Row-1 controls; the room
 * for them comes from the overflow menu instead (Widen/Collapse only, both
 * with keyboard equivalents), never from hiding the pill or the title.
 *
 * Fix, three parts (LazyManagerHeader.tsx):
 *   1. The title block's `minWidth` floor (this file's first describe).
 *   2. Widen/Collapse — genuinely secondary, each with a keyboard
 *      equivalent — grouped behind one "..." overflow menu; "+ Nouvelle"
 *      and History stay direct Row-1 controls at every conversation count
 *      (this file's second and third describe blocks).
 *
 * jsdom has no real layout engine (same caveat Cockpit.layout.test.tsx's
 * own header comment makes) — every assertion here is a style/DOM-order/
 * presence proof, not a pixel one. The real ~440px docked / ~1150px
 * expanded pixel proof is the screenshot harness, out of this file's reach.
 *
 * Props-level render (not the AgentsStoreProvider→LazyManagerStoreProvider
 * →LazyManager real tree the other lazyManager* test files use) — this is
 * deliberately a presentational-layout test of LazyManagerHeader's own
 * JSX/CSS contract, not a store-wiring behavior, so a direct render is the
 * right tool (LazyManagerStoreProvider itself only needs optional store
 * context, both absent here, and stays safe per its own contract).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import React, { createRef } from 'react';
import { I18nProvider } from '../i18n';
import { LazyManagerStoreProvider } from '../components/lazyManager/lazyManagerStore';
import { LazyManagerHeader, type ManagerConversationTab } from '../components/lazyManager/LazyManagerHeader';

const ONE_CONVERSATION: ManagerConversationTab[] = [
  { id: 'conv-1', busy: false, phase: 'idle', title: 'Fix the checkout bug', fullTitle: 'Fix the checkout bug' },
];
const TWO_CONVERSATIONS: ManagerConversationTab[] = [
  ...ONE_CONVERSATION,
  { id: 'conv-2', busy: false, phase: 'idle', title: 'Ship the release notes', fullTitle: 'Ship the release notes' },
];
const SIX_CONVERSATIONS: ManagerConversationTab[] = Array.from({ length: 6 }, (_, i) => ({
  id: `conv-${i + 1}`, busy: false, phase: 'idle' as const, title: `Conversation ${i + 1}`, fullTitle: `Conversation ${i + 1}`,
}));

function renderHeader(overrides: Partial<React.ComponentProps<typeof LazyManagerHeader>> = {}) {
  const modelSelectRef = createRef<HTMLSelectElement>();
  return render(
    <I18nProvider>
      <LazyManagerStoreProvider>
        <LazyManagerHeader
          mode="orchestrator"
          onModeChange={vi.fn()}
          onShowHistory={vi.fn()}
          onNewSession={vi.fn()}
          disabled={false}
          modelSelectRef={modelSelectRef}
          autonomyLevel="supervised"
          onAutonomyChange={vi.fn()}
          phase="idle"
          onCollapse={vi.fn()}
          collapseDisabled={false}
          widthState="normal"
          onToggleWidth={vi.fn()}
          conversations={ONE_CONVERSATION}
          activeConversationId="conv-1"
          onSelectConversation={vi.fn()}
          onCloseConversation={vi.fn()}
          openConversationCapReached={false}
          {...overrides}
        />
      </LazyManagerStoreProvider>
    </I18nProvider>,
  );
}

describe('LazyManagerHeader — product name is never clipped at the docked width', () => {
  it('the name span structurally cannot shrink or ellipsis-clip: flexShrink:0, nowrap, no overflow/textOverflow of its own', () => {
    renderHeader();
    const nameSpan = screen.getByText('LazyManager');
    expect(nameSpan.style.flexShrink).toBe('0');
    expect(nameSpan.style.whiteSpace).toBe('nowrap');
    // Never given its own ellipsis/clip styling — if it were, that alone
    // would be a silent truncation path regardless of container width.
    expect(nameSpan.style.textOverflow).toBe('');
    expect(nameSpan.style.overflow).toBe('');
  });

  it('the title block itself carries a real min-content floor (the actual regression: this used to be minWidth:0, letting the flex algorithm squeeze the box narrower than the unshrinkable name needs)', () => {
    renderHeader();
    const nameSpan = screen.getByText('LazyManager');
    // name -> inner flex row (name + engine badge) -> outer title block
    const titleBlock = nameSpan.parentElement?.parentElement as HTMLElement;
    expect(titleBlock).toBeTruthy();
    expect(titleBlock.style.minWidth).toBe('min-content');
    // Still the flexible one relative to its fixed-size Row 1 siblings —
    // the floor stops it collapsing below content, it doesn't turn it
    // rigid. jsdom/JSDOM's CSSOM expands the `flex: 1` shorthand it was
    // given to its longhand components (flex-grow/shrink/basis).
    expect(titleBlock.style.flex).toBe('1 1 0%');
  });
});

describe('LazyManagerHeader — action cluster no longer crowds the title block (no overlap)', () => {
  it('Widen/Collapse are no longer standalone Row-1 icons fighting the title block for width — grouped behind one "..." trigger, absent from the DOM entirely until opened; History and the "+ Nouvelle" pill stay direct, always-visible controls', () => {
    renderHeader({ conversations: ONE_CONVERSATION });
    // Not just hidden — genuinely not rendered as their own Row-1 boxes
    // while the menu is closed, so they claim zero width next to the
    // title/pill at rest.
    expect(screen.queryByTestId('manager-overlay-toggle-width')).not.toBeInTheDocument();
    expect(screen.queryByTestId('manager-overlay-collapse')).not.toBeInTheDocument();
    // One small trigger takes Widen/Collapse's place.
    expect(screen.getByTestId('lazy-manager-more-actions')).toBeInTheDocument();
    // History and "+ Nouvelle" are primary navigation for the owner — both
    // stay directly visible, never behind the "..." trigger.
    expect(screen.getByTestId('lazy-manager-history-btn')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-new-conv')).toBeInTheDocument();
  });

  it('Row 1 lays out every visible control as ordinary (non-absolute) flex siblings, in a fixed left-to-right order, with a real gap between them — the CSS layout guarantee that prevents overlap regardless of content width', () => {
    renderHeader({ conversations: ONE_CONVERSATION });
    const statusDot = screen.getByTestId('lazy-manager-status-dot');
    const row1 = statusDot.parentElement as HTMLElement;
    expect(row1.style.display).toBe('flex');
    expect(row1.style.gap).toBe('10px');

    const nameSpan = screen.getByText('LazyManager');
    const titleBlock = nameSpan.parentElement?.parentElement as HTMLElement;
    const pillBtn = screen.getByTestId('lazy-manager-new-conv');
    const historyBtn = screen.getByTestId('lazy-manager-history-btn');
    const overflowWrapper = screen.getByTestId('lazy-manager-more-actions').parentElement as HTMLElement;

    const children = Array.from(row1.children) as HTMLElement[];
    for (const child of children) {
      expect(child.style.position).not.toBe('absolute');
    }
    const idxTitle = children.indexOf(titleBlock);
    const idxPill = children.indexOf(pillBtn);
    const idxHistory = children.indexOf(historyBtn);
    const idxDot = children.indexOf(statusDot);
    const idxOverflow = children.indexOf(overflowWrapper);
    expect(idxTitle).toBeGreaterThanOrEqual(0);
    expect(idxTitle).toBeLessThan(idxPill);
    expect(idxPill).toBeLessThan(idxHistory);
    expect(idxHistory).toBeLessThan(idxDot);
    expect(idxDot).toBeLessThan(idxOverflow);
  });
});

describe('LazyManagerHeader — "+ Nouvelle" and History are always visible, whatever the conversation count', () => {
  // Owner, 2026-08-02, verbatim: "je suis censé pouvoir ouvrir une nouvelle
  // conversation quand je veux et une autre session quand je veux aussi" —
  // a control that disappears based on state is worse than one that is
  // merely small. A duplicate "+" in the tab strip once it exists is fine
  // and standard (browser/editor tabs do the same); it must never come at
  // the cost of hiding the primary one.
  it('1 conversation (no tab strip): the header pill and History are both present, no tab-strip "+" yet', () => {
    renderHeader({ conversations: ONE_CONVERSATION });
    expect(screen.getByTestId('lazy-manager-new-conv')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-history-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('lazy-manager-conversation-tab-add')).not.toBeInTheDocument();
  });

  it('2 conversations (tab strip visible): the header pill AND History stay present alongside the strip\'s own trailing "+" — a duplicate entry point, not a replacement', () => {
    renderHeader({ conversations: TWO_CONVERSATIONS, activeConversationId: 'conv-2' });
    expect(screen.getByTestId('lazy-manager-new-conv')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-history-btn')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-conversation-tab-add')).toBeInTheDocument();
  });

  it('6 conversations (well past the point the first pass hid the pill): the header pill and History are still present', () => {
    renderHeader({ conversations: SIX_CONVERSATIONS, activeConversationId: 'conv-6' });
    expect(screen.getByTestId('lazy-manager-new-conv')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-history-btn')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-conversation-tab-add')).toBeInTheDocument();
  });

  it('at the open-conversation cap: "+ Nouvelle" stays visible but disabled, with an explanatory title/accessible name — never removed from the DOM', () => {
    const enabledRender = renderHeader({ conversations: SIX_CONVERSATIONS, activeConversationId: 'conv-6', openConversationCapReached: false });
    const enabledTitle = within(enabledRender.container).getByTestId('lazy-manager-new-conv').getAttribute('title');
    enabledRender.unmount();
    cleanup();

    const cappedRender = renderHeader({ conversations: SIX_CONVERSATIONS, activeConversationId: 'conv-6', openConversationCapReached: true });
    const cappedPill = within(cappedRender.container).getByTestId('lazy-manager-new-conv');
    expect(cappedPill).toBeInTheDocument();
    expect(cappedPill).toBeDisabled();
    expect(cappedPill).toHaveAccessibleName();
    // The disabled explanation is a REAL, different string from the normal
    // "start a new conversation" title — not just re-showing the same
    // label, so it actually explains why the control is inert.
    expect(cappedPill.getAttribute('title')).not.toBe(enabledTitle);
    expect(cappedPill.getAttribute('title')).toBeTruthy();
    // History is unaffected by the cap — reopening a past session never
    // opens a NEW one, so it stays enabled.
    expect(within(cappedRender.container).getByTestId('lazy-manager-history-btn')).not.toBeDisabled();
  });
});

describe('LazyManagerHeader — overflow menu is functional', () => {
  it('opens on click, reveals Widen/Collapse (History is a direct control, no longer inside this menu)', () => {
    renderHeader();
    expect(screen.queryByTestId('lazy-manager-more-actions-menu')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('lazy-manager-more-actions'));
    expect(screen.getByTestId('lazy-manager-more-actions-menu')).toBeInTheDocument();
    expect(screen.getByTestId('manager-overlay-toggle-width')).toBeInTheDocument();
    expect(screen.getByTestId('manager-overlay-collapse')).toBeInTheDocument();
    // History's own testid still exists in the document, but as the direct
    // Row-1 button, NOT inside the open menu panel.
    const menu = screen.getByTestId('lazy-manager-more-actions-menu');
    expect(menu.querySelector('[data-testid="lazy-manager-history-btn"]')).toBeNull();
  });

  it('clicking History (direct control) calls the handler without touching the overflow menu', () => {
    const onShowHistory = vi.fn();
    renderHeader({ onShowHistory });
    fireEvent.click(screen.getByTestId('lazy-manager-history-btn'));
    expect(onShowHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('lazy-manager-more-actions-menu')).not.toBeInTheDocument();
  });

  it('the overflow trigger itself is absent when neither Widen nor Collapse is wired (CodeSpace usage), History and the pill are unaffected', () => {
    renderHeader({ onToggleWidth: undefined, onCollapse: undefined, widthState: undefined });
    expect(screen.queryByTestId('lazy-manager-more-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-history-btn')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-new-conv')).toBeInTheDocument();
  });

  it('clicking the backdrop closes the menu without calling any handler', () => {
    const onToggleWidth = vi.fn();
    const onCollapse = vi.fn();
    const { container } = renderHeader({ onToggleWidth, onCollapse });
    fireEvent.click(screen.getByTestId('lazy-manager-more-actions'));
    expect(screen.getByTestId('lazy-manager-more-actions-menu')).toBeInTheDocument();

    // The fixed-inset backdrop is the sibling right before the menu panel
    // (same convention as the Acceptance popover elsewhere in this file).
    const backdrop = container.querySelector('[style*="position: fixed"]') as HTMLElement;
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);

    expect(screen.queryByTestId('lazy-manager-more-actions-menu')).not.toBeInTheDocument();
    expect(onToggleWidth).not.toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();
  });
});
