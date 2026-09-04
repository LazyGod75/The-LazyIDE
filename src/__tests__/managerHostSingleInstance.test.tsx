/**
 * managerHostSingleInstance.test.tsx
 *
 * Regression test for a real, measured bug: LazyManager used to be
 * instantiated TWICE — once directly inside ManagerOverlay (Cockpit, the
 * 'agents' space) and once directly inside CodeSpace's docked right rail
 * (the 'code' space). SpacesLayer (AppShell.tsx) intentionally keeps every
 * visited space mounted forever (display:none when inactive, for state
 * preservation — see AppShell.test.tsx), so once a session had visited
 * BOTH Cockpit and Code, both LazyManager copies stayed mounted and fully
 * live at once: `data-testid="manager-input"`/`manager-send` resolved to
 * two elements (Playwright strict-mode violations in the product's own e2e
 * suites), the invisible copy still ran every effect LazyManager owns
 * (persistence writes, bus subscriptions, timers, polling), and a driver
 * reading the DOM saw the same assistant reply twice.
 *
 * The fix (see managerHostRegistry.tsx / ManagerHost.tsx): ManagerOverlay
 * and CodeSpace no longer instantiate <LazyManager> themselves — they
 * register their DOM container + live props into managerHostRegistry, and
 * the single <ManagerHost> (mounted once, outside any per-space keep-alive
 * slot — see AppShell.tsx's AppShellInner) portals ONE LazyManager instance
 * into whichever host matches the active space.
 *
 * This test reproduces the real AppShell wiring closely enough to catch a
 * regression: real ManagerOverlay (cockpit host) + real CodeSpace (code
 * host), both wrapped in the same ManagerHostRegistryProvider, with
 * <ManagerHost> switching activeHostId exactly the way
 * AppShell.tsx's managerHostIdForSpace does — then asserts at most one
 * `manager-input` ever exists in the document across cockpit -> code ->
 * cockpit, and that switching back does not reset the composer draft
 * (proof it's the SAME component instance, not a remount).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import { EditorStoreProvider } from '../components/editor/editorStore';
import { ManagerOverlay } from '../components/agents/cockpit/ManagerOverlay';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider, type ManagerHostId } from '../components/lazyManager/managerHostRegistry';
import { CodeSpace } from '../spaces/CodeSpace';

// CodeSpace now mounts TerminalStrip's terminal sessions unconditionally
// (display:none when collapsed, but still mounted — see TerminalStrip.tsx's
// "always mounted" doc comment, commit 6cef1b6), so this harness's real
// CodeSpace mounts a real TerminalView, which mounts real @xterm/xterm.
// @xterm/xterm needs browser APIs jsdom doesn't provide (canvas 2d context,
// window.matchMedia) purely to construct a Terminal instance — this test
// cares about manager-host uniqueness, not terminal rendering, so xterm and
// its fit addon are mocked out exactly like TerminalView.test.tsx already
// does for the same reason.
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    dispose: vi.fn(),
    buffer: { active: { length: 0, getLine: () => undefined } },
  })),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
  })),
}));

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

// TerminalView (mounted for real inside CodeSpace's TerminalStrip) observes
// its container with a ResizeObserver to re-fit xterm on resize — jsdom has
// no ResizeObserver at all, the same gap TerminalView.test.tsx and several
// canvas-related suites already stub out per-file.
beforeEach(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
});

/** Mirrors AppShell.tsx's managerHostIdForSpace: which manager host is
 *  active for a given (fake, test-local) space name. */
function hostIdFor(space: 'cockpit' | 'code'): ManagerHostId {
  return space;
}

// Both real hosts (ManagerOverlay for cockpit, CodeSpace for code) stay
// mounted simultaneously here — exactly like SpacesLayer's real keep-alive
// behavior once a session has visited both spaces — with only <ManagerHost>
// switching which one it portals LazyManager into. If either host went back
// to instantiating <LazyManager> directly, this harness would immediately
// show two.
function Harness({ activeSpace }: { activeSpace: 'cockpit' | 'code' }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <EditorStoreProvider>
              <ManagerHostRegistryProvider>
                <div style={{ display: activeSpace === 'cockpit' ? 'block' : 'none' }}>
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
                </div>
                <div style={{ display: activeSpace === 'code' ? 'block' : 'none' }}>
                  <CodeSpace />
                </div>
                <ManagerHost activeHostId={hostIdFor(activeSpace)} />
              </ManagerHostRegistryProvider>
            </EditorStoreProvider>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function managerInputCount(): number {
  return document.querySelectorAll('[data-testid="manager-input"]').length;
}

describe('ManagerHost — exactly one LazyManager instance across space switches', () => {
  it('never renders more than one manager-input, cockpit -> code -> cockpit', async () => {
    const { rerender } = render(<Harness activeSpace="cockpit" />);
    await waitFor(() => expect(managerInputCount()).toBe(1));

    rerender(<Harness activeSpace="code" />);
    await waitFor(() => expect(managerInputCount()).toBe(1));

    rerender(<Harness activeSpace="cockpit" />);
    await waitFor(() => expect(managerInputCount()).toBe(1));
  });

  it('preserves the in-progress composer draft across a space switch (same instance, not a remount)', async () => {
    const { rerender } = render(<Harness activeSpace="cockpit" />);
    await waitFor(() => expect(managerInputCount()).toBe(1));

    fireEvent.change(screen.getByTestId('manager-input'), { target: { value: 'unsent draft' } });
    expect(screen.getByTestId('manager-input')).toHaveValue('unsent draft');

    // Switching to the code host relocates LazyManager's rendered DOM via a
    // portal — it never unmounts, so the draft (LazyManager's own local
    // `input` state, see LazyManager.tsx) must still be there.
    rerender(<Harness activeSpace="code" />);
    await waitFor(() => expect(managerInputCount()).toBe(1));
    expect(screen.getByTestId('manager-input')).toHaveValue('unsent draft');

    rerender(<Harness activeSpace="cockpit" />);
    await waitFor(() => expect(managerInputCount()).toBe(1));
    expect(screen.getByTestId('manager-input')).toHaveValue('unsent draft');
  });
});
