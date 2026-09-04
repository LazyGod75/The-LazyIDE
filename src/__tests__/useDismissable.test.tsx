/**
 * useDismissable.test.tsx — unit tests for the shared dismissable-panel hook
 * (src/components/common/useDismissable.ts), extracted to fix the founder
 * bug "un des boutons du canva comme KPI impossible à refermer" (a cockpit
 * rail popover couldn't be closed by re-clicking its own toggle button —
 * see that hook's header comment for the exact close-then-reopen race).
 *
 * Covers, in isolation from any real popover component:
 *   - a genuine outside pointerdown closes
 *   - a pointerdown inside the panel does NOT close
 *   - a pointerdown on an ignored trigger ref does NOT close (this is the
 *     mechanism that prevents the race — without `ignoreRefs`, the same
 *     click on the toggle button WOULD be treated as "outside")
 *   - Escape closes
 *   - the listeners are torn down once `open` becomes false (no further
 *     onClose calls from stale listeners)
 *   - the actual "toggle race" regression: a real toggle button driving its
 *     own `open` state, re-clicked (pointerdown then click, matching real
 *     browser event order) while open, ends up CLOSED rather than
 *     flickering shut and reopening.
 *   - the "Escape doesn't close" regression (David's repro, 2026-08-15,
 *     canvas legend popover): an unrelated re-render of the caller — which
 *     always passes a fresh `onClose` lambda, e.g.
 *     `onClose={() => setOpen(false)}` — must NOT tear down and reinstall
 *     the `window` listeners; only a real open/close transition should.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React, { useEffect, useRef, useState } from 'react';
import { useDismissable } from '../components/common/useDismissable';

function Harness({
  open,
  onClose,
  ignoreTrigger,
}: {
  open: boolean;
  onClose: () => void;
  ignoreTrigger: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useDismissable<HTMLDivElement>({
    open,
    onClose,
    ignoreRefs: ignoreTrigger ? [triggerRef] : undefined,
  });

  return (
    <div>
      <button data-testid="trigger" ref={triggerRef}>Trigger</button>
      <button data-testid="outside">Outside</button>
      {open && (
        <div data-testid="panel" ref={panelRef}>
          <button data-testid="inside">Inside</button>
        </div>
      )}
    </div>
  );
}

describe('useDismissable — outside click', () => {
  it('calls onClose on a genuine outside pointerdown', () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} ignoreTrigger />);

    fireEvent.pointerDown(screen.getByTestId('outside'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose for a pointerdown inside the panel', () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} ignoreTrigger />);

    fireEvent.pointerDown(screen.getByTestId('inside'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT attach listeners while closed (no onClose from a stale listener)', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness open onClose={onClose} ignoreTrigger />);
    rerender(<Harness open={false} onClose={onClose} ignoreTrigger />);

    fireEvent.pointerDown(screen.getByTestId('outside'));

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('useDismissable — Escape', () => {
  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} ignoreTrigger />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} ignoreTrigger />);

    fireEvent.keyDown(window, { key: 'Enter' });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('useDismissable — ignoreRefs (the close-then-reopen race)', () => {
  it('does NOT call onClose for a pointerdown on an ignored trigger ref', () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} ignoreTrigger />);

    fireEvent.pointerDown(screen.getByTestId('trigger'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('WITHOUT ignoreRefs, the same pointerdown on the trigger IS treated as outside (proves ignoreRefs is what prevents the race, not something else)', () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} ignoreTrigger={false} />);

    fireEvent.pointerDown(screen.getByTestId('trigger'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── The actual regression: a real toggle button + its own open state ──────

function ToggleHarness({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useDismissable<HTMLDivElement>({
    open,
    onClose: () => setOpen(false),
    ignoreRefs: [triggerRef],
  });

  return (
    <div>
      <button data-testid="toggle" ref={triggerRef} onClick={() => setOpen((v) => !v)}>
        Toggle
      </button>
      {open && <div data-testid="panel" ref={panelRef}>Panel</div>}
    </div>
  );
}

/** Same shape, but WITHOUT `ignoreRefs` — reproduces the pre-fix bug so the
 *  fixed version above can be contrasted against it directly. */
function RacyToggleHarness({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const panelRef = useDismissable<HTMLDivElement>({
    open,
    onClose: () => setOpen(false),
  });

  return (
    <div>
      <button data-testid="toggle" onClick={() => setOpen((v) => !v)}>
        Toggle
      </button>
      {open && <div data-testid="panel" ref={panelRef}>Panel</div>}
    </div>
  );
}

describe('useDismissable — toggle race (re-clicking an already-open trigger)', () => {
  it('with ignoreRefs: re-clicking the toggle button while open closes the panel (does not reopen)', () => {
    render(<ToggleHarness startOpen />);
    expect(screen.getByTestId('panel')).toBeInTheDocument();

    const toggle = screen.getByTestId('toggle');
    // Real browsers fire pointerdown, then click, for a single click — fire
    // both explicitly (fireEvent.click alone would never reproduce the race).
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);

    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('without ignoreRefs: the same re-click sequence closes-then-reopens the panel (the bug this hook fixes)', () => {
    render(<RacyToggleHarness startOpen />);
    expect(screen.getByTestId('panel')).toBeInTheDocument();

    const toggle = screen.getByTestId('toggle');
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);

    // The panel unmounts (onClose fires from the outside-pointerdown) then
    // remounts (the click's own toggle, reading the now-stale closed state)
    // — net effect: still open, exactly the "impossible to close" bug.
    expect(screen.getByTestId('panel')).toBeInTheDocument();
  });
});

// ── The Escape regression: unrelated re-renders with a fresh onClose ──────

/** Re-renders itself `renders` times (via a counter effect) — same shape as
 *  CanvasLegendPopover being re-rendered because ITS parent (CanvasToolbar)
 *  re-rendered for an unrelated reason (e.g. live agentsStore updates)
 *  while the popover stays open the whole time. Every render passes a
 *  brand-new `onClose` lambda, exactly like every real caller of this hook
 *  (`onClose={() => setOpen(false)}` inline in JSX). */
function ChurnHarness({ renders, onEscape }: { renders: number; onEscape: () => void }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n < renders) setN((v) => v + 1);
  }, [n, renders]);
  const panelRef = useDismissable<HTMLDivElement>({
    open: true,
    // Fresh identity every render — the exact shape that broke this hook
    // before the ref-stabilization fix.
    onClose: () => onEscape(),
  });
  return (
    <div data-testid="render-count" data-count={n}>
      <div data-testid="panel" ref={panelRef}>Panel</div>
    </div>
  );
}

describe('useDismissable — Escape after unrelated re-renders (regression, 2026-08-15)', () => {
  it('does not reattach the window listeners on every re-render while open — addEventListener fires once, not once per render', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    render(<ChurnHarness renders={20} onEscape={vi.fn()} />);

    expect(screen.getByTestId('render-count').dataset.count).toBe('20');
    // Exactly one keydown + one pointerdown listener installed across all
    // 20 re-renders (only the initial mount, since `open` never changes) —
    // before the fix this was reattached 20 times (torn down + reinstalled
    // once per render because `onClose`'s identity changed every time).
    expect(addSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    expect(addSpy.mock.calls.filter(([type]) => type === 'pointerdown')).toHaveLength(1);
    expect(removeSpy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
    expect(removeSpy.mock.calls.filter(([type]) => type === 'pointerdown')).toHaveLength(0);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('still calls onClose on Escape after many unrelated re-renders (the actual user-visible symptom)', () => {
    const onEscape = vi.fn();
    render(<ChurnHarness renders={20} onEscape={onEscape} />);
    expect(screen.getByTestId('render-count').dataset.count).toBe('20');

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});
