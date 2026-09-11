/**
 * LazyManagerHeader — deliberate `compact`/`narrow` layouts
 * (panelWidthTier.ts), real QA repro 2026-08-14: at the panel's real
 * ~500px docked width, Row 1 fell back to an accidental `flexWrap` reflow
 * — "+ Nouvelle" stayed on the first line while History and the status dot
 * dropped onto an orphaned second line with a large gap. This file pins
 * that every Row 1 control stays PRESENT and reachable at every tier (the
 * "nothing may become unreachable at any width" requirement), and that the
 * `compact`/`narrow` tiers actually render a DIFFERENT, deliberate
 * structure rather than reusing `wide`'s single-row DOM.
 *
 * jsdom has no real layout engine (same caveat
 * lazyManagerHeaderDockedWidth.test.tsx's own header comment makes) — this
 * is a DOM-shape/style-contract proof, not a pixel one; the real-app
 * visual check is out of this file's reach.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React, { createRef } from 'react';
import { I18nProvider } from '../i18n';
import { LazyManagerStoreProvider } from '../components/lazyManager/lazyManagerStore';
import { LazyManagerHeader, type ManagerConversationTab } from '../components/lazyManager/LazyManagerHeader';
import type { PanelWidthTier } from '../components/lazyManager/panelWidthTier';

const ONE_CONVERSATION: ManagerConversationTab[] = [
  { id: 'conv-1', busy: false, phase: 'idle', title: 'Fix the checkout bug', fullTitle: 'Fix the checkout bug' },
];

function renderHeader(tier: PanelWidthTier | undefined, overrides: Partial<React.ComponentProps<typeof LazyManagerHeader>> = {}) {
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
          tier={tier}
          {...overrides}
        />
      </LazyManagerStoreProvider>
    </I18nProvider>,
  );
}

describe.each<PanelWidthTier>(['wide', 'compact', 'narrow'])('LazyManagerHeader at tier=%s', (tier) => {
  it('every Row 1 control is present and reachable: identity, "+ Nouvelle", History, status dot', () => {
    renderHeader(tier);
    expect(screen.getByText('LazyManager')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-new-conv')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-history-btn')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-status-dot')).toBeInTheDocument();
  });

  it('the model picker and mode toggle are both present', () => {
    renderHeader(tier);
    expect(screen.getByTestId('lazy-manager-mode-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('manager-model-select')).toBeInTheDocument();
  });
});

describe('LazyManagerHeader — tier="wide" (default, no regression)', () => {
  it('Row 1 is a single flex row: identity and every action are direct siblings, in order', () => {
    renderHeader('wide');
    const statusDot = screen.getByTestId('lazy-manager-status-dot');
    const row1 = statusDot.parentElement as HTMLElement;
    expect(row1.style.display).toBe('flex');
    const pillBtn = screen.getByTestId('lazy-manager-new-conv');
    const historyBtn = screen.getByTestId('lazy-manager-history-btn');
    expect(pillBtn.parentElement).toBe(row1);
    expect(historyBtn.parentElement).toBe(row1);
    const children = Array.from(row1.children) as HTMLElement[];
    expect(children.indexOf(pillBtn)).toBeLessThan(children.indexOf(historyBtn));
    expect(children.indexOf(historyBtn)).toBeLessThan(children.indexOf(statusDot));
  });

  it('omitting the tier prop entirely renders identically to explicit tier="wide" (every pre-existing caller/test never passes it)', () => {
    const { unmount } = renderHeader(undefined);
    const statusDot = screen.getByTestId('lazy-manager-status-dot');
    expect(statusDot.parentElement?.style.display).toBe('flex');
    unmount();
  });
});

describe('LazyManagerHeader — tier="compact"/"narrow" (deliberate two-row layout, not a squeezed one-row)', () => {
  it.each<PanelWidthTier>(['compact', 'narrow'])('the "+ Nouvelle" pill and History/status-dot are grouped on the SAME action row, not split across an orphaned second line (%s)', (tier) => {
    renderHeader(tier);
    const pillBtn = screen.getByTestId('lazy-manager-new-conv');
    const historyBtn = screen.getByTestId('lazy-manager-history-btn');
    const statusDot = screen.getByTestId('lazy-manager-status-dot');
    // All three share the SAME direct parent (the action-cluster row) —
    // the real defect this replaces put the pill on Row 1 and left
    // History/the dot to fall onto their own orphaned line.
    expect(historyBtn.parentElement).toBe(pillBtn.parentElement);
    expect(statusDot.parentElement).toBe(pillBtn.parentElement);
  });

  it.each<PanelWidthTier>(['compact', 'narrow'])('the identity block (avatar) is on its OWN row, a DIFFERENT parent than the action cluster, laid out in an explicit column (%s)', (tier) => {
    renderHeader(tier);
    const avatar = screen.getByText('M');
    const pillBtn = screen.getByTestId('lazy-manager-new-conv');
    const identityRow = avatar.parentElement as HTMLElement;
    const actionsRow = pillBtn.parentElement as HTMLElement;
    expect(identityRow).not.toBe(actionsRow);
    // Both rows share the SAME outer wrapper, stacked via flexDirection:
    // 'column' — a deliberate two-row shape, not two accidental fragments.
    expect(identityRow.parentElement).toBe(actionsRow.parentElement);
    expect((identityRow.parentElement as HTMLElement).style.flexDirection).toBe('column');
  });

  it('at tier="wide", by contrast, the avatar and the "+ Nouvelle" pill are direct siblings in ONE row (no column split)', () => {
    renderHeader('wide');
    const avatar = screen.getByText('M');
    const pillBtn = screen.getByTestId('lazy-manager-new-conv');
    expect(avatar.parentElement).toBe(pillBtn.parentElement);
  });

  it('the model picker gets its own full-width row (flexBasis/width: 100%), not the wide layout\'s inline marginLeft:auto placement', () => {
    renderHeader('compact');
    const select = screen.getByTestId('manager-model-select');
    expect(select.style.width).toBe('100%');
    expect(select.style.marginLeft).toBe('0px');
  });
});

describe('LazyManagerHeader — model picker open/close (real user bug, 2026-09-11)', () => {
  it('a real mouse click sequence (focus → click) leaves the picker OPEN', () => {
    // The trigger used to carry BOTH onFocus={open} and onClick={toggle}:
    // a mouse click fires focus first (opening the picker), then the click
    // toggled it straight back shut — the picker flashed and "se ferme
    // direct". This pins the real browser event order.
    renderHeader('wide');
    const trigger = screen.getByTestId('manager-model-select');
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    expect(screen.getByTestId('model-picker-search')).toBeInTheDocument();
  });

  it('a second click closes it (toggle still works)', () => {
    renderHeader('wide');
    const trigger = screen.getByTestId('manager-model-select');
    fireEvent.click(trigger);
    expect(screen.getByTestId('model-picker-search')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('model-picker-search')).not.toBeInTheDocument();
  });
});
