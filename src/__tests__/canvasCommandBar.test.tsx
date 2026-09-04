/**
 * canvasCommandBar.test.tsx — W5b deliverable #1: CanvasCommandBar.tsx.
 * Mounts the real component directly (no `<ReactFlow>` needed — it is a
 * plain fixed overlay, same seam as CanvasQuickCreateModal.tsx's own test
 * approach). `listAgents()` is mocked so the agent-entry list is
 * deterministic and no Tauri/fs read happens under vitest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { CanvasCommandBar } from '../components/agents/canvas/CanvasCommandBar';
import type { StoredAgent } from '../lib/agents/agentsStorage';

const FIXTURE_AGENTS: StoredAgent[] = [
  {
    scope: 'user',
    agent: {
      id: 'agent-tester',
      name: 'tester',
      displayName: 'Testeur',
      description: 'Écrit des tests',
      modelTier: 'sonnet',
      triggers: {},
      memory: 'none',
      isolation: 'worktree',
    },
  } as unknown as StoredAgent,
];

vi.mock('../lib/agents/agentsStorage', () => ({
  listAgents: vi.fn(async () => FIXTURE_AGENTS),
}));

afterEach(cleanup);

function renderBar(overrides: Partial<React.ComponentProps<typeof CanvasCommandBar>> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    activeProjectId: 'p1',
    onAddDraft: vi.fn(),
    onRunLayout: vi.fn(),
    onToggleLaneMode: vi.fn(),
    onRecenter: vi.fn(),
    onFocusFailures: vi.fn(),
    onToggleMinimap: vi.fn(),
    onToggleSnap: vi.fn(),
    onTogglePalette: vi.fn(),
    ...overrides,
  };
  const view = render(
    <I18nProvider>
      <CanvasCommandBar {...props} />
    </I18nProvider>,
  );
  return { ...view, props };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Design's source-of-truth copy is French — pin the locale so `t()`
  // output is deterministic regardless of what a previous test file left
  // in localStorage (see LazyManagerRail.signals.test.tsx's identical note).
  localStorage.setItem('lazy.locale', 'fr');
});

afterEach(() => {
  localStorage.removeItem('lazy.locale');
});

describe('CanvasCommandBar', () => {
  it('renders nothing when closed', () => {
    renderBar({ open: false });
    expect(screen.queryByTestId('canvas-command-bar')).not.toBeInTheDocument();
  });

  it('lists the blank draft entry, canvas commands, and library agents once open', async () => {
    renderBar();
    expect(screen.getByTestId('canvas-command-bar-item-draft-blank')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-command-bar-item-cmd-layout')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-command-bar-item-cmd-lanes')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-command-bar-item-cmd-recenter')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-command-bar-item-cmd-focus-failures')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('canvas-command-bar-item-agent-agent-tester')).toBeInTheDocument());
  });

  it('filters entries as the user types', async () => {
    renderBar();
    await waitFor(() => expect(screen.getByTestId('canvas-command-bar-item-agent-agent-tester')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('canvas-command-bar-search'), { target: { value: 'ranger' } });
    expect(screen.getByTestId('canvas-command-bar-item-cmd-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-command-bar-item-agent-agent-tester')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-command-bar-item-draft-blank')).not.toBeInTheDocument();
  });

  it('selecting the blank-draft entry creates a DraftSpec via onAddDraft, in the active project zone', async () => {
    const { props } = renderBar();
    // Flushes the pending listAgents() microtask inside `act()` before the
    // synchronous interaction below (avoids a spurious "not wrapped in
    // act" warning from the agent list arriving after this test's body).
    await screen.findByTestId('canvas-command-bar-item-draft-blank');
    fireEvent.click(screen.getByTestId('canvas-command-bar-item-draft-blank'));
    expect(props.onAddDraft).toHaveBeenCalledWith(expect.objectContaining({ task: '' }), 'p1');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('selecting a library agent creates a draft carrying its agentName/model via the SAME onAddDraft path', async () => {
    const { props } = renderBar();
    await waitFor(() => expect(screen.getByTestId('canvas-command-bar-item-agent-agent-tester')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('canvas-command-bar-item-agent-agent-tester'));
    expect(props.onAddDraft).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Testeur', agentName: 'tester', model: 'sonnet' }),
      'p1',
    );
  });

  it('arrow-down + Enter selects a canvas command and closes', async () => {
    const { props } = renderBar();
    const overlay = screen.getByTestId('canvas-command-bar-overlay');
    await screen.findByTestId('canvas-command-bar-item-draft-blank');
    // draft-blank is index 0 — one ArrowDown lands on cmd-layout (index 1).
    fireEvent.keyDown(overlay, { key: 'ArrowDown' });
    fireEvent.keyDown(overlay, { key: 'Enter' });
    expect(props.onRunLayout).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('Escape closes without selecting anything', async () => {
    const { props } = renderBar();
    await screen.findByTestId('canvas-command-bar-item-draft-blank');
    fireEvent.keyDown(screen.getByTestId('canvas-command-bar-overlay'), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onAddDraft).not.toHaveBeenCalled();
    expect(props.onRunLayout).not.toHaveBeenCalled();
  });

  it('clicking the backdrop closes the overlay', async () => {
    const { props } = renderBar();
    await screen.findByTestId('canvas-command-bar-item-draft-blank');
    fireEvent.mouseDown(screen.getByTestId('canvas-command-bar-overlay'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

// fix/canvas-command-bar-stuck-overlay (David's forensics, real packaged
// app: a full-viewport `position: fixed` overlay at zIndex 2100 covered the
// top navigation and swallowed every click app-wide; two Escape presses did
// not close it). These pin the STRUCTURAL invariants the fix relies on —
// never a test that reproduces the exact keystroke sequence David could not
// even reliably reproduce himself.
describe('CanvasCommandBar — stuck-overlay hardening (fix/canvas-command-bar-stuck-overlay)', () => {
  it('is positioned absolute within its own container, never fixed to the viewport — cannot spatially reach the top navigation regardless of z-index', async () => {
    renderBar();
    const overlay = await screen.findByTestId('canvas-command-bar-overlay');
    expect(overlay.style.position).toBe('absolute');
    expect(overlay.style.position).not.toBe('fixed');
  });

  it('never uses an app-global z-index — stays within this canvas\'s own local chrome range (same order of magnitude as ManagerOverlay/CockpitLeftRail\'s own 40, nowhere near the old 2100)', async () => {
    renderBar();
    const overlay = await screen.findByTestId('canvas-command-bar-overlay');
    const z = Number(overlay.style.zIndex);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeLessThan(100);
  });

  // The real, structural bug this surfaced: the OLD dismissal path
  // (React's synthetic onKeyDown on the overlay div) only ever fires while
  // DOM focus is still somewhere INSIDE the overlay — Escape pressed after
  // focus has moved elsewhere (a toast, an async update elsewhere in a busy
  // session — exactly what David's own forensics describe) never reached
  // it, and useCanvasKeyboard.ts's own separate window-level Escape handler
  // has no notion of `commandBarOpen` at all. Dispatching the keydown on
  // `window` itself (not on any element inside the overlay) proves Escape
  // is now independent of focus location entirely.
  it('Escape closes the overlay even when nothing inside it has focus (the real regression: focus stolen elsewhere in a busy session)', async () => {
    const { props } = renderBar();
    await screen.findByTestId('canvas-command-bar-item-draft-blank');
    // Move focus somewhere OUTSIDE the overlay entirely, mirroring "a toast
    // or async update elsewhere stole focus" — the exact condition that
    // made the old bubbling-dependent handler unreachable.
    const outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);
    outsideEl.focus();
    expect(document.activeElement).toBe(outsideEl);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(props.onClose).toHaveBeenCalledTimes(1);
    document.body.removeChild(outsideEl);
  });

  it('every render of the overlay carries its own dismissal handler — closing then reopening still closes on Escape (no path where a mount is left without one)', async () => {
    const onClose = vi.fn();
    const { rerender, props } = renderBar({ onClose });
    await screen.findByTestId('canvas-command-bar-item-draft-blank');
    rerender(
      <I18nProvider>
        <CanvasCommandBar {...props} open={false} />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('canvas-command-bar-overlay')).not.toBeInTheDocument();
    rerender(
      <I18nProvider>
        <CanvasCommandBar {...props} open={true} />
      </I18nProvider>,
    );
    await screen.findByTestId('canvas-command-bar-item-draft-blank');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
