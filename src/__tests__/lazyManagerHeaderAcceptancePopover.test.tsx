/**
 * LazyManagerHeader — "Acceptance" popover (Manuel/Supervisé/Lazy/
 * Personnalisé autonomy picker) backdrop-leak fix.
 *
 * Real prod repro (2026-08-04): menu opens, a click elsewhere visually
 * closes it, but something kept intercepting every subsequent click in the
 * panel until a full reload — DOM inspection showed an empty `<div>` still
 * mounted ("<div></div> subtree intercepts pointer events").
 *
 * Root cause: this popover was hand-rolled with its own `position: fixed`
 * backdrop div + a bespoke onClick, the only icon-triggered popover in the
 * app that didn't go through the shared `useDismissable` hook
 * (src/components/common/useDismissable.ts — already used by 13+ others,
 * including this exact file's sibling AgentMentionPopup.tsx). That hook's
 * own header documents this as the "third occurrence" of a real bug family
 * (a naive outside-pointerdown listener racing the trigger button's own
 * onClick). Fix: adopt useDismissable (removes the hand-rolled backdrop DIV
 * entirely — nothing left to ever leak) and add an explicit blur handler —
 * the open state (`showAcceptance`) is now the SOLE thing that mounts the
 * popover, and Escape/outside-click/blur all funnel into the same
 * `setShowAcceptance(false)`.
 *
 * Props-level render, same convention as lazyManagerHeaderDockedWidth.test
 * .tsx (a presentational-layout/behavior test of LazyManagerHeader's own
 * JSX contract, not a store-wiring behavior).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React, { createRef } from 'react';
import { I18nProvider } from '../i18n';
import { LazyManagerStoreProvider } from '../components/lazyManager/lazyManagerStore';
import { LazyManagerHeader } from '../components/lazyManager/LazyManagerHeader';

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
          openConversationCapReached={false}
          {...overrides}
        />
      </LazyManagerStoreProvider>
    </I18nProvider>,
  );
}

/** No `[style*="position: fixed"]` element anywhere in the render — the old
 *  hand-rolled backdrop is gone entirely, so there is nothing left that can
 *  ever survive a close and intercept clicks. */
function expectNoFixedBackdrop(container: HTMLElement) {
  expect(container.querySelectorAll('[style*="position: fixed"]').length).toBe(0);
}

describe('LazyManagerHeader — Acceptance popover opens/closes cleanly', () => {
  it('is closed by default, opens on trigger click, and shows all four autonomy options', () => {
    const { container } = renderHeader();
    expect(screen.queryByTestId('lazy-manager-acceptance-popover')).not.toBeInTheDocument();
    expectNoFixedBackdrop(container);

    fireEvent.click(screen.getByTestId('lazy-manager-acceptance-btn'));

    expect(screen.getByTestId('lazy-manager-acceptance-popover')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-acceptance-manual')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-acceptance-supervised')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-acceptance-yolo')).toBeInTheDocument();
    expect(screen.getByTestId('lazy-manager-acceptance-custom')).toBeInTheDocument();
    // The fix's core structural guarantee: no visual/click-catching backdrop
    // div is ever rendered — dismissal is listener-based (useDismissable),
    // never a DOM node that could outlive the popover.
    expectNoFixedBackdrop(container);
  });

  it('re-clicking the trigger toggles it closed (no fight between the outside-pointerdown listener and the button\'s own onClick)', () => {
    renderHeader();
    const trigger = screen.getByTestId('lazy-manager-acceptance-btn');
    fireEvent.click(trigger);
    expect(screen.getByTestId('lazy-manager-acceptance-popover')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByTestId('lazy-manager-acceptance-popover')).not.toBeInTheDocument();
  });

  it('Escape closes the popover, leaving no trace in the DOM', () => {
    const { container } = renderHeader();
    fireEvent.click(screen.getByTestId('lazy-manager-acceptance-btn'));
    expect(screen.getByTestId('lazy-manager-acceptance-popover')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('lazy-manager-acceptance-popover')).not.toBeInTheDocument();
    expectNoFixedBackdrop(container);
  });

  it('a genuine outside pointerdown (e.g. elsewhere in the panel) closes the popover, leaving no trace in the DOM', () => {
    const { container } = renderHeader();
    fireEvent.click(screen.getByTestId('lazy-manager-acceptance-btn'));
    expect(screen.getByTestId('lazy-manager-acceptance-popover')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('lazy-manager-acceptance-popover')).not.toBeInTheDocument();
    expectNoFixedBackdrop(container);
  });

  it('a pointerdown INSIDE the popover panel itself never closes it (only a genuine outside click does)', () => {
    renderHeader();
    fireEvent.click(screen.getByTestId('lazy-manager-acceptance-btn'));
    const popover = screen.getByTestId('lazy-manager-acceptance-popover');

    fireEvent.pointerDown(popover);

    expect(screen.getByTestId('lazy-manager-acceptance-popover')).toBeInTheDocument();
  });

  it('selecting an autonomy option calls onAutonomyChange and closes the popover', () => {
    const onAutonomyChange = vi.fn();
    renderHeader({ onAutonomyChange });
    fireEvent.click(screen.getByTestId('lazy-manager-acceptance-btn'));

    fireEvent.click(screen.getByTestId('lazy-manager-acceptance-yolo'));

    expect(onAutonomyChange).toHaveBeenCalledWith('yolo');
    expect(screen.queryByTestId('lazy-manager-acceptance-popover')).not.toBeInTheDocument();
  });

  it('blur (focus genuinely leaving the trigger+panel control) closes the popover', () => {
    renderHeader();
    const trigger = screen.getByTestId('lazy-manager-acceptance-btn');
    fireEvent.click(trigger);
    expect(screen.getByTestId('lazy-manager-acceptance-popover')).toBeInTheDocument();

    fireEvent.focusOut(trigger, { relatedTarget: document.body });

    expect(screen.queryByTestId('lazy-manager-acceptance-popover')).not.toBeInTheDocument();
  });

  it('blur moving focus BETWEEN the trigger and an option (still inside the control) never closes it', () => {
    renderHeader();
    const trigger = screen.getByTestId('lazy-manager-acceptance-btn');
    fireEvent.click(trigger);
    const manualOption = screen.getByTestId('lazy-manager-acceptance-manual');

    fireEvent.focusOut(trigger, { relatedTarget: manualOption });

    expect(screen.getByTestId('lazy-manager-acceptance-popover')).toBeInTheDocument();
  });

  it('is absent entirely in coder mode (mode gate unchanged by this fix)', () => {
    renderHeader({ mode: 'coder' });
    expect(screen.queryByTestId('lazy-manager-acceptance-btn')).not.toBeInTheDocument();
  });
});
