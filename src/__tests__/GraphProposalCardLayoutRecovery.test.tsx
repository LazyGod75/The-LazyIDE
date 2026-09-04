/**
 * GraphProposalCardLayoutRecovery.test.tsx — 2026-08 off-main-thread rewrite
 * (see layout.ts's own header for the founder's #1 complaint diagnosis).
 * Covers the two behaviors GraphProposalCard.test.tsx does NOT: what
 * happens when the layout watchdog actually fires (fix #2, STOP DEGRADING
 * PERMANENTLY) and whether the honest degraded fallback actually fits the
 * ~400px chat panel (fix #4). GraphProposalCard.test.tsx keeps the
 * happy-path/state/button coverage; this file is deliberately narrow so
 * neither grows past the "200-400 lines typical" file-size guideline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { GraphProposalCard } from '../components/lazyManager/GraphProposalCard';
import type { ManagerMessage } from '../lib/agents/types';
import { getProviderMode } from '../lib/models/index';
import type { PreviewGraphLayout } from '../components/agents/canvas/layout';
import { buildFallbackLayout, buildProposalGraph } from '../components/lazyManager/graphProposalGraph';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return { ...actual, getProviderMode: vi.fn() };
});

// Deferred promise (same "let resolve + factory" idiom as
// agentsStore.loadRace.test.tsx's own `resolveLoad`) so the test controls
// EXACTLY when the real elkjs/worker layout settles — required to
// reproduce the watchdog racing a real, eventually-successful layout.
let resolveLayout: ((value: PreviewGraphLayout) => void) | null = null;

function makeLayoutDeferred(): Promise<PreviewGraphLayout> {
  return new Promise<PreviewGraphLayout>((resolve) => {
    resolveLayout = resolve;
  });
}

vi.mock('../components/agents/canvas/layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents/canvas/layout')>();
  return {
    ...actual,
    layoutPreviewGraph: vi.fn(() => makeLayoutDeferred()),
  };
});

const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;

function makeTwelveStepMessage(): ManagerMessage {
  return {
    id: 'msg-recovery',
    role: 'assistant',
    content: 'Here is a big plan.',
    timestamp: new Date().toISOString(),
    proposal: {
      state: 'pending',
      planId: 'orch-recovery',
      objective: 'Ship the big migration',
      steps: Array.from({ length: 12 }, (_, i) => ({ description: `Step ${i + 1}` })),
    },
  };
}

describe('GraphProposalCard — layout watchdog recovery (fix #2: stop degrading permanently)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedGetProviderMode.mockReturnValue('pro');
    resolveLayout = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the honest degraded fallback + banner once the watchdog fires, then SWAPS IN the real layout and removes the banner the moment it lands', async () => {
    const msg = makeTwelveStepMessage();
    render(
      <I18nProvider>
        <GraphProposalCard msg={msg} onAccept={vi.fn()} onReject={vi.fn()} />
      </I18nProvider>,
    );

    // Past LAYOUT_RESOLUTION_TIMEOUT_MS (8000ms) with the layout promise
    // still deliberately pending — the watchdog must latch the honest
    // fallback + banner, never a perpetual skeleton.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });
    expect(screen.getByTestId('graph-proposal-layout-degraded')).toBeInTheDocument();
    expect(screen.getByTestId('graph-proposal-minigraph')).toBeInTheDocument();

    // The real layout finally lands — a slow worker call under a genuinely
    // busy machine, exactly the founder's own repro (`cpu=81%` logged at
    // the moment of failure). Before this fix, `failedGraph` latched
    // forever and this real result was silently thrown away by the render
    // logic even though `resolved` also became true.
    const realLayout: PreviewGraphLayout = {
      positions: Object.fromEntries(msg.proposal!.steps.map((_, i) => [String(i), { x: i * 200, y: 0 }])),
      width: 2600,
      height: 120,
    };
    await act(async () => {
      resolveLayout?.(realLayout);
    });

    expect(screen.queryByTestId('graph-proposal-layout-degraded')).not.toBeInTheDocument();
    expect(screen.getByTestId('graph-proposal-minigraph')).toBeInTheDocument();
  });

  // THIRD root cause behind this same user-visible symptom (dangling edge,
  // then main-thread starvation, now this — see GraphProposalCard.tsx's own
  // top header) — live-diagnosed via the debug trace added in the previous
  // round: a real proposal resolved in 411ms and was correctly applied,
  // then the WATCHDOG fired anyway 8 seconds later and re-latched
  // `failedGraph`, silently demoting an already-successful, already-
  // rendered graph to the degraded banner. The watchdog was only ever
  // cleared on the effect's OWN cleanup (unmount/re-run), never on the
  // promise it exists to guard actually settling. This test fails on the
  // pre-fix code (the watchdog fires 8s after mount regardless of the
  // earlier success and re-latches `failedGraph`) and passes once the
  // watchdog is cleared the instant the layout resolves.
  it('a FAST successful layout is never later demoted by the watchdog — the timer must be disarmed on success, not merely superseded on unmount', async () => {
    const msg = makeTwelveStepMessage();
    render(
      <I18nProvider>
        <GraphProposalCard msg={msg} onAccept={vi.fn()} onReject={vi.fn()} />
      </I18nProvider>,
    );

    // Resolves well WITHIN the watchdog's budget — the real-world case
    // (elkjs answering in tens to hundreds of ms) that this bug hid inside.
    const realLayout: PreviewGraphLayout = {
      positions: Object.fromEntries(msg.proposal!.steps.map((_, i) => [String(i), { x: i * 200, y: 0 }])),
      width: 2600,
      height: 120,
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
      resolveLayout?.(realLayout);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId('graph-proposal-minigraph')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-proposal-layout-degraded')).not.toBeInTheDocument();

    // Now advance PAST LAYOUT_RESOLUTION_TIMEOUT_MS (8000ms) — the exact
    // moment the founder's live app showed the "layout timed out after
    // 8000ms" banner replace an already-correct, already-rendered graph.
    // A disarmed watchdog must do nothing here.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });
    expect(screen.getByTestId('graph-proposal-minigraph')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-proposal-layout-degraded')).not.toBeInTheDocument();
  });

  it('never recovers if the layout genuinely never settles (watchdog stays the honest last resort)', async () => {
    const msg = makeTwelveStepMessage();
    render(
      <I18nProvider>
        <GraphProposalCard msg={msg} onAccept={vi.fn()} onReject={vi.fn()} />
      </I18nProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });
    expect(screen.getByTestId('graph-proposal-layout-degraded')).toBeInTheDocument();
    // Nothing ever resolves `resolveLayout` in this test — the degraded
    // view must simply stay up, never crash, never flip back to a skeleton.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId('graph-proposal-layout-degraded')).toBeInTheDocument();
  });
});

describe('GraphProposalCard — fallback fit-to-container (fix #4: readable inside the ~400px chat panel)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedGetProviderMode.mockReturnValue('pro');
    resolveLayout = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the degraded fallback graph at a bounded, responsive size instead of a huge fixed pixel canvas the user has to scroll to see', async () => {
    // 15 sequential steps — a purely-chained plan is the WORST case for
    // buildFallbackLayout's BFS layering (one node per layer), producing a
    // very wide layout exactly like the founder's own "nodes pushed off
    // the right edge" repro.
    const msg: ManagerMessage = {
      id: 'msg-fit',
      role: 'assistant',
      content: 'plan',
      timestamp: new Date().toISOString(),
      proposal: {
        state: 'pending',
        planId: 'orch-fit',
        objective: 'A long sequential plan',
        steps: Array.from({ length: 15 }, (_, i) => ({
          id: `s${i}`,
          description: `Step ${i + 1}`,
          dependsOn: i > 0 ? [`s${i - 1}`] : undefined,
        })),
      },
    };

    render(
      <I18nProvider>
        <GraphProposalCard msg={msg} onAccept={vi.fn()} onReject={vi.fn()} />
      </I18nProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8100);
    });

    const svg = screen.getByTestId('graph-proposal-minigraph');
    // The old behavior set the rendered pixel width to match a wide
    // viewBox 1:1 (`Math.max(viewWidth, 420)`, easily 1000px+ for 15
    // sequential steps) — the fix caps it at FALLBACK_RENDER_MAX_WIDTH via
    // a responsive width instead, so preserveAspectRatio scales the
    // content DOWN to fit rather than growing the box past the panel.
    expect(svg.getAttribute('width')).toBe('100%');
    const heightAttr = Number(svg.getAttribute('height'));
    expect(heightAttr).toBeLessThanOrEqual(220);
  });
});

describe('buildFallbackLayout — every node stays within the returned viewBox (fix #4)', () => {
  it('keeps every node fully inside [0, width] x [0, height] for a 15-node graph, including a wide fan-out shape', () => {
    const steps = Array.from({ length: 15 }, (_, i) => ({
      description: `Step ${i + 1}`,
      // A mix of chained and parallel dependencies — both a "wide" layer
      // (many nodes at once) and a "deep" chain (many layers), the two
      // shapes most likely to blow past a small fixed panel.
      dependsOn: i > 2 ? [`${Math.floor((i - 1) / 3)}`] : undefined,
    }));
    const proposal = {
      state: 'pending' as const,
      planId: 'orch-fallback-bounds',
      objective: 'Wide fan-out plan',
      steps,
    };
    const graph = buildProposalGraph(proposal);
    const layout = buildFallbackLayout(graph);

    expect(graph.nodes.length).toBe(15);
    for (const node of graph.nodes) {
      const position = layout.positions[node.id];
      expect(position).toBeDefined();
      expect(position!.x).toBeGreaterThanOrEqual(0);
      expect(position!.y).toBeGreaterThanOrEqual(0);
      expect(position!.x + node.width).toBeLessThanOrEqual(layout.width);
      expect(position!.y + node.height).toBeLessThanOrEqual(layout.height);
    }
  });
});
