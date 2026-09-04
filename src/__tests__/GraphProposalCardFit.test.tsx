/**
 * GraphProposalCardFit.test.tsx — 2026-08 third verification pass (see
 * GraphProposalCard.tsx's own top header). The founder measured the
 * SUCCESSFUL graph's own SVG at 916x236 inside a docked panel column
 * ~300px wide — one node visible, the rest reachable only by scrolling.
 * The scale-to-fit mechanism (GRAPH_HEIGHT_BUDGET/DOCKED_PANEL_WIDTH_FLOOR/
 * MIN_READABLE_SCALE) was real but wired ONLY to the degraded fallback
 * view; the successful graph — the actual point of this feature — still
 * rendered at `Math.max(viewWidth, 420)`, a fixed large pixel value.
 *
 * Deliberately does NOT assert against ManagerOverlay.tsx's specific
 * docked/expanded pixel constants (360 / 480-920) — the founder's own
 * correction mid-wave was explicit: the panel itself auto-expands and is
 * meant to become freely drag-resizable (a separate, larger change — see
 * this file's own header note on scope), so this card's fit mechanism must
 * work at WHATEVER width it is actually given, continuously, not just at
 * two known checkpoints. This suite proves that generically: narrow ->
 * dense, generously wide -> not dense, and re-fits live across a SEQUENCE
 * of container-width changes (simulating a user dragging the panel edge),
 * never latching a stale scale/mode from an earlier size.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { GraphProposalCard } from '../components/lazyManager/GraphProposalCard';
import type { ManagerMessage, OrchestratorPlanStepInput } from '../lib/agents/types';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return { ...actual, getProviderMode: vi.fn(() => 'pro') };
});

type ResizeCallback = (entries: Array<{ contentRect: { width: number } }>) => void;

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  private readonly callback: ResizeCallback;
  constructor(callback: ResizeCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  trigger(width: number): void {
    this.callback([{ contentRect: { width } }]);
  }
}

beforeEach(() => {
  MockResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', MockResizeObserver as unknown as typeof ResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 12 steps, 2 distinct joinGroups (2 members each) — matches the
// coordinator's exact ask ("a 12-node, 2-join-group graph"): a root, a
// research fan-out/join, a review fan-out/join, and a sequential tail.
// Deliberately 2-member (not 3+) groups: elkjs's own real layered spacing
// for THIS shape keeps peak per-layer height low enough that width — not
// height — is the binding constraint once the container is wide enough,
// which is what this suite needs to demonstrate the legibility floor
// actually clearing at a generous width, not just staying permanently
// dense regardless of room (verified against elkjs's REAL output, not
// hand-derived).
function makeTwelveNodeTwoJoinMessage(): ManagerMessage {
  const steps: OrchestratorPlanStepInput[] = [
    { id: 's0', description: 'Kick off the launch plan' },
    { id: 's1', description: 'Research competitor positioning', dependsOn: ['s0'], joinGroup: 'research', agentName: 'web-researcher' },
    { id: 's2', description: 'Research target audience segments', dependsOn: ['s0'], joinGroup: 'research', agentName: 'web-researcher' },
    { id: 's3', description: 'Synthesize research into a positioning doc', dependsOn: ['s1', 's2'], joinGroup: 'review' },
    { id: 's4', description: 'Draft the campaign copy from the positioning doc', dependsOn: ['s1', 's2'], joinGroup: 'review' },
    { id: 's5', description: 'Merge the synthesis and the draft copy', dependsOn: ['s3', 's4'] },
    { id: 's6', description: 'Legal review of the merged copy', dependsOn: ['s5'] },
    { id: 's7', description: 'Brand review of the merged copy', dependsOn: ['s6'] },
    { id: 's8', description: 'Finalize the campaign copy', dependsOn: ['s7'] },
    { id: 's9', description: 'Schedule the launch email', dependsOn: ['s8'] },
    { id: 's10', description: 'Brief the sales team', dependsOn: ['s9'] },
    { id: 's11', description: 'Launch the campaign', dependsOn: ['s10'] },
  ];
  return {
    id: 'msg-fit',
    role: 'assistant',
    content: 'Here is a plan.',
    timestamp: new Date().toISOString(),
    proposal: { state: 'pending', planId: 'orch-fit', objective: 'Launch the product', steps },
  };
}

function renderCard() {
  const msg = makeTwelveNodeTwoJoinMessage();
  return render(
    <I18nProvider>
      <GraphProposalCard msg={msg} onAccept={vi.fn()} onReject={vi.fn()} />
    </I18nProvider>,
  );
}

// 2026-08 fourth verification pass — the founder's own described shape (2
// sequential -> 4-way parallel fan-out -> join -> 3-step chain, 9 total
// steps), the exact plan that motivated this pass: at a REAL, realistic
// manually-expanded panel width (769px, live-measured), this shape's real
// elkjs layout (1494x460 — verified via the SAME layoutPreviewGraph this
// card calls, not hand-derived) is HEIGHT-bound (216/460=0.47), not width-
// bound, so the old flat `MIN_READABLE_SCALE=0.6` threshold could NEVER
// clear at this width no matter how wide the panel got — see
// GraphProposalCard.tsx's own header for the full diagnosis.
function makeNineStepFanoutMessage(): ManagerMessage {
  const steps: OrchestratorPlanStepInput[] = [
    { id: 's0', description: 'Audit the current onboarding funnel' },
    { id: 's1', description: 'Draft the new onboarding flow spec', dependsOn: ['s0'] },
    { id: 's2', description: 'Build the welcome screen variant', dependsOn: ['s1'], joinGroup: 'build', agentName: 'frontend' },
    { id: 's3', description: 'Build the signup form variant', dependsOn: ['s1'], joinGroup: 'build', agentName: 'frontend' },
    { id: 's4', description: 'Build the empty-state variant', dependsOn: ['s1'], joinGroup: 'build', agentName: 'frontend' },
    { id: 's5', description: 'Build the confirmation variant', dependsOn: ['s1'], joinGroup: 'build', agentName: 'frontend' },
    { id: 's6', description: 'Integrate all onboarding variants', dependsOn: ['s2', 's3', 's4', 's5'] },
    { id: 's7', description: 'QA the integrated onboarding flow', dependsOn: ['s6'] },
    { id: 's8', description: 'Ship the onboarding redesign', dependsOn: ['s7'] },
  ];
  return {
    id: 'msg-fanout',
    role: 'assistant',
    content: 'Here is a plan.',
    timestamp: new Date().toISOString(),
    proposal: { state: 'pending', planId: 'orch-fanout', objective: 'Redesign onboarding', steps },
  };
}

function renderFanoutCard() {
  const msg = makeNineStepFanoutMessage();
  return render(
    <I18nProvider>
      <GraphProposalCard msg={msg} onAccept={vi.fn()} onReject={vi.fn()} />
    </I18nProvider>,
  );
}

describe('GraphProposalCard — dense-mode threshold gates on the rendered node box, not the raw scale (2026-08 fourth verification pass)', () => {
  it('renders the graph with EMPTY, structural boxes (no free-text foreignObject) even at a wide panel width — 2026-08-06 "rectangles vides" (founder: text inside the boxes was unreadable); the full step title stays in the <title> tooltip and in the step list below', async () => {
    renderFanoutCard();
    await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 });
    const observer = MockResizeObserver.instances[0];
    expect(observer).toBeDefined();
    await act(async () => observer!.trigger(769));

    const firstNode = screen.getByTestId('graph-proposal-node-s0');
    // No text box inside the node anymore — the numbered badge + glyph
    // carry the structure, the full title is one hover away in <title>.
    expect(firstNode.querySelector('foreignObject')).toBeNull();
    expect(firstNode.querySelector('title')?.textContent ?? '').toContain('Audit the current onboarding funnel');
    // The numbered badge is still there.
    expect(firstNode.querySelector('text')?.textContent).toBeTruthy();
  });

  it('still uses the dense (glyph-only) representation at the genuinely narrow docked width for the SAME plan — boxes stay empty at every width by design', async () => {
    renderFanoutCard();
    const svg = await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 });
    const observer = MockResizeObserver.instances[0];
    await act(async () => observer!.trigger(244));

    expect(svg.getAttribute('data-dense')).toBe('true');
    const firstNode = screen.getByTestId('graph-proposal-node-s0');
    expect(firstNode.querySelector('foreignObject')).toBeNull();
  });
});

describe('GraphProposalCard — the successful graph fits the panel (fix #7)', () => {
  it('renders the successful graph at a responsive width, not a fixed large pixel size that forces horizontal scrolling — fails on the pre-fix code, where a resolved graph\'s width was Math.max(viewWidth, 420), a plain fixed number', async () => {
    renderCard();
    const svg = await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 });
    // Every step actually laid out — a real, fully-resolved 12-node graph
    // with both join groups synthesized, not a degraded/partial one.
    for (let i = 0; i < 12; i++) {
      expect(screen.getByTestId(`graph-proposal-node-s${i}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('graph-proposal-join-join:research')).toBeInTheDocument();
    expect(screen.getByTestId('graph-proposal-join-join:review')).toBeInTheDocument();

    // The rendered width tracks the CONTAINER (responsive), never a fixed
    // pixel value derived from content size — this is what actually
    // prevents the horizontal-scroll-required regression the founder
    // photographed, regardless of which specific width the panel has.
    expect(svg.getAttribute('width')).toBe('100%');
    expect(Number(svg.getAttribute('height'))).toBeLessThanOrEqual(216);
  });

  it('enters the dense (legibility-floor) representation when the container is narrow — no illegible free-text labels baked into the shrunk pixels, full detail still one hover away via the tooltip', async () => {
    renderCard();
    const svg = await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 });
    const observer = MockResizeObserver.instances[0];
    expect(observer).toBeDefined();
    await act(async () => observer!.trigger(300));

    expect(svg.getAttribute('data-dense')).toBe('true');
    // The free-text label is gone from the rendered pixels — scoped to
    // exactly node s0's own <g> (matching by DOM structure, not text,
    // sidesteps the SAME description legitimately reappearing in OTHER
    // nodes' own "depends on s0" tooltip lines, and in the step checklist
    // below the graph).
    const firstNode = screen.getByTestId('graph-proposal-node-s0');
    expect(firstNode.querySelector('foreignObject')).toBeNull();
    // ...but the full title is still reachable via that exact node's own
    // <title> tooltip (fix #3, unaffected by density) — nothing is lost,
    // only not baked into pixels too small to read.
    expect(firstNode.querySelector('title')?.textContent).toContain('Kick off the launch plan');
  });

  it('stays structural (empty boxes) even once the container is generously wide — 2026-08-06 "rectangles vides": the boxes are never labeled at any width; the density flag still tracks the fit, but free-text never comes back into the SVG', async () => {
    renderCard();
    await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 });
    const observer = MockResizeObserver.instances[0];
    await act(async () => observer!.trigger(300));
    expect(screen.getByTestId('graph-proposal-minigraph').getAttribute('data-dense')).toBe('true');

    await act(async () => observer!.trigger(3000));
    const svg = screen.getByTestId('graph-proposal-minigraph');
    expect(svg.getAttribute('width')).toBe('100%');
    expect(svg.getAttribute('data-dense')).toBeNull();
    const node = screen.getByTestId('graph-proposal-node-s0');
    // Empty boxes by design at every width — the numbered badge stays.
    expect(node.querySelector('foreignObject')).toBeNull();
    expect(node.querySelector('text')?.textContent).toBeTruthy();
  });

  it('re-fits live across a SEQUENCE of container-width changes (simulating a user dragging the panel edge) — never latches a stale scale/mode from an earlier size', async () => {
    renderCard();
    const svg = await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 });
    const observer = MockResizeObserver.instances[0];

    // Narrow -> dense.
    await act(async () => observer!.trigger(280));
    expect(svg.getAttribute('data-dense')).toBe('true');

    // Dragged wider -> exits dense.
    await act(async () => observer!.trigger(2500));
    expect(svg.getAttribute('data-dense')).toBeNull();

    // Dragged back narrow -> dense again (not a one-way/hysteresis switch —
    // this is exactly what a live drag-to-resize needs: the SAME width
    // always produces the SAME density, in either direction).
    await act(async () => observer!.trigger(280));
    expect(svg.getAttribute('data-dense')).toBe('true');

    // And back wide again, to a DIFFERENT generous width than before —
    // still responsive, still exits dense, proving this isn't a fixed
    // two-state toggle but a continuous function of the real width.
    await act(async () => observer!.trigger(1800));
    expect(svg.getAttribute('width')).toBe('100%');
    expect(svg.getAttribute('data-dense')).toBeNull();
  });
});

// 2026-08 "giant empty rectangle" fix (David, verbatim: "pourquoi la j'ai
// un agent géant dans le canva ??") — the previous fit suite already locks
// in "no free-text foreignObject inside a task/contest node, at any width"
// (the 2026-08-06 decision, unchanged by this pass). What THIS suite guards
// is the other half: a node must never render as a bare, empty rect either
// (the literal complaint) — it always carries its numbered badge plus a
// structural mark on the opposite side (glyph or, for a legible-width
// contest node, the "best of N" pill) — and the panel's vertical footprint
// never grows with plan size, regardless of how many steps/joins a real
// plan lays out to.
describe('GraphProposalCard — every node shows a visible mark, and the preview footprint stays bounded (2026-08 "giant empty rectangle" fix)', () => {
  it('never renders a node with no visible content — every task node carries its numbered badge + type glyph, every join node carries its glyph', async () => {
    renderCard();
    await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 });

    const steps = makeTwelveNodeTwoJoinMessage().proposal!.steps;
    for (const step of steps) {
      const node = screen.getByTestId(`graph-proposal-node-${step.id}`);
      // The numbered badge is a real, non-empty text node — never a bare
      // rect with nothing drawn inside it.
      const badgeText = node.querySelector('text');
      expect(badgeText).not.toBeNull();
      expect(badgeText?.textContent?.trim()).not.toBe('');
      // And a structural mark on the opposite side — the type glyph for
      // every plain task node in this plan (none of these steps declare a
      // contestN, so the contest-pill branch never applies here) — never
      // neither.
      expect(node.querySelector('svg')).not.toBeNull();
    }

    expect(screen.getByTestId('graph-proposal-join-join:research').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('graph-proposal-join-join:review').querySelector('svg')).not.toBeNull();
  });

  it('keeps the preview panel at a fixed, bounded height regardless of plan size — a 12-node/2-join plan takes the SAME vertical footprint as any other, never growing with step count', async () => {
    renderCard();
    const svg = await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 });
    // The scroll container around the SVG stays a fixed 244px regardless of
    // how many steps/joins the real elkjs layout produced — GRAPH_HEIGHT_
    // BUDGET-driven fit scaling (computeGraphFit) is what keeps a large
    // plan from ever forcing this panel taller, never a CSS max-height that
    // merely clips overflow after the fact.
    const container = svg.parentElement as HTMLElement;
    expect(container.style.height).toBe('244px');
    expect(Number(svg.getAttribute('height'))).toBeLessThanOrEqual(216);
  });
});
