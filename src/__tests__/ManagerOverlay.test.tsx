/**
 * ManagerOverlay — three width states (collapsed/normal/expanded), their
 * persistence across sessions, and the manual-vs-automatic precedence rule
 * for the discussion/proposal 'expanded' state (product ask: the panel
 * widens over the canvas to read/discuss a plan proposal, then retracts
 * once execution actually starts; the user can always force either width,
 * and that manual choice outranks a same-context automatic re-suggestion,
 * while an automatic shrink — execution starting — always wins since it's
 * a hard phase transition).
 *
 * No pending proposal is ever seeded into the real agents store here (the
 * store starts empty) — so `currentProposalKey` stays the fixed 'none'
 * sentinel throughout, letting the manual/automatic precedence rule be
 * exercised directly via the exact same bus events GraphProposalCard/
 * agentsStore emit in the real app ('manager:expandOverlay'/
 * 'manager:shrinkOverlay'), without needing to drive a real LLM round trip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import { ManagerOverlay, computeExpandedOverlayWidth, COLLAPSED_WIDTH } from '../components/agents/cockpit/ManagerOverlay';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import { emit, on } from '../lib/bus';
import * as bus from '../lib/bus';

vi.mock('../lib/brain/capture', () => ({ captureAgentMission: vi.fn() }));
vi.mock('../lib/agents/runtime', () => ({
  runMission: vi.fn().mockResolvedValue(undefined),
  mergeWorktree: vi.fn().mockResolvedValue(undefined),
  discardWorktree: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/agents/loopEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/loopEngine')>();
  return { ...actual, listLoops: vi.fn().mockResolvedValue([]) };
});

function renderOverlay() {
  // ManagerOverlay no longer instantiates <LazyManager> itself — it
  // registers its container/props with managerHostRegistry.tsx and the
  // single <ManagerHost> (normally mounted once in AppShell.tsx) portals
  // LazyManager into it. Real usage always has exactly one <ManagerHost>
  // wrapped in the same <ManagerHostRegistryProvider> as every host, so
  // that's reproduced here too — see managerHostRegistry.tsx's header
  // comment for the double-mount bug this replaced.
  return render(
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <ManagerHostRegistryProvider>
              <ManagerOverlay
                projects={[]}
                draftPrefill={null}
                onDraftConsumed={() => {}}
                signals={[]}
                onAnswerSignal={() => {}}
                onSignalAction={() => {}}
                autonomyLevel="supervised"
                onAutonomyChange={() => {}}
              />
              <ManagerHost activeHostId="cockpit" />
            </ManagerHostRegistryProvider>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

/** The Widen/Collapse header controls moved behind the "⋮" overflow menu in
 *  the 2026-08 header-unclutter fix (0649837 — see
 *  lazyManagerHeaderDockedWidth.test.tsx: the buttons are genuinely absent
 *  from the DOM while the menu is closed, so they claim zero Row-1 width).
 *  Every click below therefore goes through the same real user path: open
 *  the menu first, then click the item. The menu closes itself on item
 *  click, so a fresh open is needed before each toggle/collapse click. */
function openOverflowMenu() {
  fireEvent.click(screen.getByTestId('lazy-manager-more-actions'));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('computeExpandedOverlayWidth — pure width formula', () => {
  it('is meaningfully wider than "normal" (360px) and keeps at least ~30% of the window as visible canvas on a laptop width', () => {
    const width = computeExpandedOverlayWidth(1366);
    expect(width).toBeGreaterThan(360);
    expect((1366 - width) / 1366).toBeGreaterThanOrEqual(0.3);
  });

  it('never exceeds the readability cap on an ultra-wide monitor (panel stops growing, canvas gets the rest)', () => {
    const width = computeExpandedOverlayWidth(3440);
    expect(width).toBeLessThanOrEqual(920);
    expect((3440 - width) / 3440).toBeGreaterThan(0.3);
  });

  it('never covers the whole window even on a small width (point 4: usable below a certain width)', () => {
    const width = computeExpandedOverlayWidth(800);
    expect(width).toBeLessThan(800);
    expect((800 - width) / 800).toBeGreaterThanOrEqual(0.3);
  });

  it('falls back to a sane positive default for a non-finite/invalid width (SSR-safe)', () => {
    expect(computeExpandedOverlayWidth(0)).toBeGreaterThan(0);
    expect(computeExpandedOverlayWidth(NaN)).toBeGreaterThan(0);
  });
});

describe('ManagerOverlay — three width states', () => {
  it('defaults to normal (360px) with no persisted state', () => {
    renderOverlay();
    const overlay = screen.getByTestId('manager-overlay');
    expect(overlay.dataset.overlayState).toBe('normal');
    expect(overlay.dataset.overlayWidth).toBe('360');
  });

  it('the header widen button switches to expanded — wider than normal, never the full window', () => {
    renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width'));
    const overlay = screen.getByTestId('manager-overlay');
    expect(overlay.dataset.overlayState).toBe('expanded');
    expect(Number(overlay.dataset.overlayWidth)).toBeGreaterThan(360);
  });

  it('clicking the same button again narrows back to normal', () => {
    renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width'));
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width'));
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('normal');
  });

  it('collapsing renders the thin persistent tab (panel hidden), and reopening restores it', () => {
    renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-collapse'));
    expect(screen.queryByTestId('manager-overlay')).toBeNull();
    const tab = screen.getByTestId('manager-overlay-expand');
    expect(tab).toBeInTheDocument();
    fireEvent.click(tab);
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('normal');
  });

  it('collapsing is allowed from the expanded width too (no pending proposal outstanding) — reopening restores expanded, not always normal', () => {
    renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width')); // -> expanded
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-collapse'));
    expect(screen.queryByTestId('manager-overlay')).toBeNull();
    fireEvent.click(screen.getByTestId('manager-overlay-expand'));
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('expanded');
  });
});

describe('ManagerOverlay — persistence across sessions', () => {
  it('persists a manual widen to localStorage and restores it on a fresh mount', () => {
    const { unmount } = renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width'));
    expect(localStorage.getItem('lazy.manager.overlayWidth')).toBe('expanded');
    unmount();

    renderOverlay();
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('expanded');
  });

  it('persists a manual collapse and restores it on a fresh mount', () => {
    const { unmount } = renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-collapse'));
    expect(localStorage.getItem('lazy.manager.overlayWidth')).toBe('collapsed');
    unmount();

    renderOverlay();
    expect(screen.getByTestId('manager-overlay-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('manager-overlay')).toBeNull();
  });

  // fix/canvas-collapse-reservation (David's round-8 report, real packaged
  // app: collapsed the overlay — manager-overlay confirmed gone from the
  // DOM — yet the canvas container stayed exactly as narrow as before, "a
  // large empty black band" where the panel used to be). Root cause: once a
  // user EVER drags the resize handle (VS Code terminal style,
  // manager-overlay-resize-handle), the resulting customWidth is persisted
  // to localStorage and — before this fix — applied UNCONDITIONALLY via
  // `customWidth ?? overlayWidthFor(widthState, ...)`, permanently
  // overriding collapse (and every other width-state transition) from then
  // on, since neither handleCollapse nor the 'M' shortcut's collapse branch
  // ever cleared it. `manager:overlayWidthChange` is the ONLY value
  // Cockpit.tsx's `reservedRightPx` ever reflects — this reproduces the
  // exact real sequence (drag first, THEN collapse) and asserts the emitted
  // width on the LATEST event, the one the canvas actually reserves against.
  it('collapsing AFTER a manual drag-resize reserves COLLAPSED_WIDTH, not the stale custom drag width (fix/canvas-collapse-reservation)', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    renderOverlay();

    const emittedWidths: number[] = [];
    const off = on('manager:overlayWidthChange', ({ width }) => emittedWidths.push(width));

    // Drag the resize handle to a wide custom width (VS Code terminal
    // style) — same real gesture as OVERLAY_RIGHT_OFFSET's own doc comment
    // describes: mousedown on the handle, mousemove with a new clientX,
    // mouseup to commit + persist it.
    fireEvent.mouseDown(screen.getByTestId('manager-overlay-resize-handle'));
    act(() => {
      fireEvent.mouseMove(window, { clientX: 508 }); // -> customWidth ~= 1024 - 508 - 16 = 500
    });
    fireEvent.mouseUp(window);
    expect(localStorage.getItem('lazy.manager.overlayWidth.custom')).toBe('500');
    const widthAfterDrag = emittedWidths.at(-1);
    expect(widthAfterDrag).toBe(500);

    // Now collapse — the exact real repro's next step. The custom width is
    // NEVER cleared (still 500 in localStorage — a deliberate preference,
    // restored later when the user reopens), but the EMITTED (and
    // therefore RESERVED) width while collapsed must be COLLAPSED_WIDTH,
    // not the stale 500.
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-collapse'));
    expect(localStorage.getItem('lazy.manager.overlayWidth.custom')).toBe('500');
    expect(emittedWidths.at(-1)).toBe(COLLAPSED_WIDTH);

    // Restoring brings the user's own custom width back — collapsing never
    // discarded their preference, it only stopped masking collapse itself.
    fireEvent.click(screen.getByTestId('manager-overlay-expand'));
    expect(emittedWidths.at(-1)).toBe(500);

    off();
  });

  it('does NOT persist an automatic (bus-driven) expand as the saved baseline — it is tied to an ephemeral proposal, not a preference', () => {
    const { unmount } = renderOverlay();
    act(() => { emit('manager:expandOverlay', undefined); });
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('expanded');
    expect(localStorage.getItem('lazy.manager.overlayWidth')).toBeNull();
    unmount();

    renderOverlay();
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('normal');
  });
});

describe('ManagerOverlay — manual choice primes over automatic (point 2/3)', () => {
  it('a manual narrow blocks a same-context automatic expand from re-asserting itself', () => {
    renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width')); // -> expanded (manual)
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width')); // -> normal (manual, same context)
    act(() => { emit('manager:expandOverlay', undefined); }); // automatic re-suggestion, same context
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('normal');
  });

  it('an automatic shrink always applies — hard execution-start transition — even over a manual widen', () => {
    renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width')); // -> expanded (manual)
    act(() => { emit('manager:shrinkOverlay', undefined); });
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('normal');
  });

  it('after an automatic shrink resolves the override, the NEXT automatic expand is honored again (new proposal, fresh context)', () => {
    renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width')); // -> expanded (manual)
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-toggle-width')); // -> normal (manual)
    act(() => { emit('manager:shrinkOverlay', undefined); }); // resolves/clears the override
    act(() => { emit('manager:expandOverlay', undefined); }); // a fresh automatic suggestion
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('expanded');
  });
});

// fix/canvas-manager-collapse (David's measured repro, real packaged app:
// manager-overlay is 836px wide in a 1440px window — 42% of the screen,
// permanently — and the ONLY control found on it was the resize handle; the
// EXISTING collapse control this file's own `openOverflowMenu()` helper
// documents lives behind LazyManager's own "⋮" header menu, "genuinely
// absent from the DOM while the menu is closed" — not reachable in one
// click). This suite covers the SECOND, independent, always-visible trigger
// added directly on ManagerOverlay itself, reachable with zero setup.
describe('ManagerOverlay — always-visible collapse trigger (fix/canvas-manager-collapse)', () => {
  it('is visible and clickable with NO menu opened first — the actual discoverability fix', () => {
    renderOverlay();
    // Deliberately does NOT call openOverflowMenu() — the whole point.
    const trigger = screen.getByTestId('manager-overlay-collapse-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).not.toBeDisabled();
  });

  it('clicking it collapses the panel to the thin persistent tab, same end state as the menu-based control', () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId('manager-overlay-collapse-trigger'));
    expect(screen.queryByTestId('manager-overlay')).toBeNull();
    expect(screen.getByTestId('manager-overlay-expand')).toBeInTheDocument();
  });

  it('the restore control (the collapsed tab itself) is what remains visible while collapsed — never hidden behind anything', () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId('manager-overlay-collapse-trigger'));
    const tab = screen.getByTestId('manager-overlay-expand');
    expect(tab).toBeVisible();
    fireEvent.click(tab);
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('normal');
  });

  it('persists the collapsed choice the SAME way the existing menu-based control already does (localStorage, survives a remount)', () => {
    const { unmount } = renderOverlay();
    fireEvent.click(screen.getByTestId('manager-overlay-collapse-trigger'));
    unmount();
    renderOverlay();
    expect(screen.getByTestId('manager-overlay-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('manager-overlay')).toBeNull();
  });
});

// fix/canvas-manager-collapse — bare 'M' keyboard shortcut, a REAL
// window-level KeyboardEvent (unlike the 'E' shortcut below, which is
// Cockpit.tsx's own binding relayed through the 'manager:toggleOverlayWidth'
// bus event — 'M' is registered directly inside ManagerOverlay.tsx itself).
describe('ManagerOverlay — "M" keyboard shortcut (collapse/restore)', () => {
  it('collapses the open panel', () => {
    renderOverlay();
    fireEvent.keyDown(window, { key: 'm' });
    expect(screen.queryByTestId('manager-overlay')).toBeNull();
    expect(screen.getByTestId('manager-overlay-expand')).toBeInTheDocument();
  });

  it('restores the collapsed panel back to its last open width', () => {
    renderOverlay();
    fireEvent.keyDown(window, { key: 'm' }); // -> collapsed
    fireEvent.keyDown(window, { key: 'm' }); // -> restored
    expect(screen.getByTestId('manager-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('manager-overlay-expand')).toBeNull();
  });

  it('is case-insensitive (Shift+M / caps lock still works)', () => {
    renderOverlay();
    fireEvent.keyDown(window, { key: 'M' });
    expect(screen.queryByTestId('manager-overlay')).toBeNull();
  });

  it('is ignored with a modifier held (Ctrl/Cmd/Alt+M reserved for the OS/browser, never hijacked)', () => {
    renderOverlay();
    fireEvent.keyDown(window, { key: 'm', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'm', metaKey: true });
    fireEvent.keyDown(window, { key: 'm', altKey: true });
    expect(screen.getByTestId('manager-overlay')).toBeInTheDocument();
  });

  it('is ignored while typing in the manager\'s own input field (isEditableTarget guard — never hijacks a literal "m" keystroke while composing an order)', () => {
    renderOverlay();
    const input = screen.getByTestId('manager-input');
    fireEvent.keyDown(input, { key: 'm' });
    expect(screen.getByTestId('manager-overlay')).toBeInTheDocument();
  });
});

describe('ManagerOverlay — "E" keyboard shortcut wiring (manager:toggleOverlayWidth)', () => {
  it('toggles the same as the header button', () => {
    renderOverlay();
    act(() => { emit('manager:toggleOverlayWidth', undefined); });
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('expanded');
    act(() => { emit('manager:toggleOverlayWidth', undefined); });
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('normal');
  });

  it('is a no-op while collapsed (reopen first — nothing to toggle without a visible panel)', () => {
    renderOverlay();
    openOverflowMenu();
    fireEvent.click(screen.getByTestId('manager-overlay-collapse'));
    act(() => { emit('manager:toggleOverlayWidth', undefined); });
    expect(screen.queryByTestId('manager-overlay')).toBeNull();
    expect(screen.getByTestId('manager-overlay-expand')).toBeInTheDocument();
  });
});

// 2026-08 fourth verification pass — founder: "it worked for one plan
// tonight but did NOT fire for another" (auto-expand flakiness). Root
// cause: the bus-listener-registration effect had `widthState` in its
// dependency array, so it tore down and rebuilt all four listeners
// (including 'manager:expandOverlay') on EVERY width change — including an
// ordinary shrink when a PRIOR proposal is accepted/revised. A
// 'manager:expandOverlay' for a brand-new proposal landing in that
// unsubscribe/resubscribe gap was silently dropped. Existing tests above
// could never catch this: every `emit()` is wrapped in its own `act()`,
// which fully flushes React's effect cleanup+rebuild before the next
// `emit()` ever runs, so the resubscribe window never actually opens in
// that harness. This suite instead asserts on the listener REGISTRATION
// COUNT itself — the direct, structural proxy for "does this window exist
// at all" — which fails on the pre-fix code (one extra `on('manager:
// expandOverlay', ...)` call per width-state change) and passes once the
// listeners are registered exactly once, for the component's whole
// lifetime, regardless of how many times the width changes.
describe('ManagerOverlay — bus listeners are registered ONCE, not re-subscribed on every width change', () => {
  it('never re-registers the manager:expandOverlay listener across a shrink -> expand -> shrink -> expand sequence (the exact race window that dropped a real proposal\'s auto-expand)', () => {
    const onSpy = vi.spyOn(bus, 'on');
    renderOverlay();
    const expandCallCountAfterMount = onSpy.mock.calls.filter(([type]) => type === 'manager:expandOverlay').length;
    expect(expandCallCountAfterMount).toBe(1); // registered once, at mount

    // Simulate the real sequence: a proposal resolves (shrink), a later,
    // unrelated proposal appears (expand), repeated a few times — matching
    // "one plan expanded fine, a later one didn't" from a single session.
    act(() => { emit('manager:shrinkOverlay', undefined); });
    act(() => { emit('manager:expandOverlay', undefined); });
    act(() => { emit('manager:shrinkOverlay', undefined); });
    act(() => { emit('manager:expandOverlay', undefined); });

    const expandCallCountAfterCycles = onSpy.mock.calls.filter(([type]) => type === 'manager:expandOverlay').length;
    expect(expandCallCountAfterCycles).toBe(1);
    onSpy.mockRestore();
  });

  it('honors an expand emitted immediately after a shrink with no intervening act() flush — the exact timing the old per-widthState resubscribe could miss', () => {
    renderOverlay();
    // Deliberately ONE act() wrapping BOTH emits back to back, instead of
    // one act() per emit (every existing test above's pattern) — the
    // closest a jsdom/RTL harness can get to "no gap for React to fully
    // settle the previous re-render before the next bus event fires".
    act(() => {
      emit('manager:shrinkOverlay', undefined);
      emit('manager:expandOverlay', undefined);
    });
    expect(screen.getByTestId('manager-overlay').dataset.overlayState).toBe('expanded');
  });
});
