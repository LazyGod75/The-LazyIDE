/**
 * ReplayBar.test.tsx — Agent Canvas W8d: the Replay mode overlay bar
 * (components/agents/canvas/replay/ReplayBar.tsx). Mounted with a hand-built
 * `UseReplayModeResult` fixture (never the real hook/journalQuery) — same
 * "wrap with I18nProvider + ReactFlowProvider, mount the real component"
 * approach canvasDryRun.test.tsx's own DryRunOverlay coverage uses, since
 * `<Panel>` requires a live React Flow context.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { I18nProvider } from '../i18n';
import { ReplayBar } from '../components/agents/canvas/replay/ReplayBar';
import { tickerText } from '../components/agents/canvas/replay/replayTicker';
import { buildFleetTimeline } from '../components/agents/canvas/replay/replayModel';
import type { UseReplayModeResult } from '../components/agents/canvas/replay/useReplayMode';
import type { JournalEventRow } from '../lib/journal/eventTypes';

afterEach(cleanup);

function row(seq: number, tsMs: number, missionId: string, type: JournalEventRow['type'], payload: Record<string, unknown> = {}): JournalEventRow {
  return {
    seq,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor: 'system',
    type,
    payload: JSON.stringify(payload),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

function baseReplay(overrides: Partial<UseReplayModeResult> = {}): UseReplayModeResult {
  return {
    active: true,
    loading: false,
    windowOption: 'today',
    timeline: null,
    currentTMs: 0,
    playing: false,
    speed: 1,
    fleetState: new Map(),
    firingChainIds: new Set(),
    tickerKeyframe: undefined,
    selectedMissionId: null,
    selectMission: vi.fn(),
    rawEvents: [],
    enter: vi.fn(),
    exit: vi.fn(),
    toggle: vi.fn(),
    setWindowOption: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    togglePlay: vi.fn(),
    setSpeed: vi.fn(),
    scrubTo: vi.fn(),
    stepMs: vi.fn(),
    ...overrides,
  };
}

function renderBar(replay: UseReplayModeResult, onForkMission?: (missionId: string) => void) {
  render(
    <I18nProvider>
      <ReactFlowProvider>
        <ReplayBar replay={replay} onForkMission={onForkMission} />
      </ReactFlowProvider>
    </I18nProvider>,
  );
}

describe('ReplayBar — empty window', () => {
  it('shows the "no events" empty state instead of a scrubber when the timeline has zero keyframes', () => {
    const timeline = buildFleetTimeline([], 0, 10_000);
    renderBar(baseReplay({ timeline }));

    expect(screen.getByTestId('canvas-replay-badge')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-replay-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-replay-scrubber')).not.toBeInTheDocument();
  });
});

// R2a fix (thread 3): before this, `isEmpty` was `timeline !== null && ...` —
// while `timeline` is still `null` (the fetch hasn't settled), that's FALSE,
// so the OLD code fell into the "not empty" branch with a zero-valued
// scrubber AND a ticker whose `tickerKeyframe` is `undefined`, which renders
// the exact SAME `canvas.replay.empty` copy the dedicated empty state uses
// (replayTicker.ts's tickerText fallback) — a user watching the bar during
// ordinary IPC/query latency saw "no events", indistinguishable from a
// genuinely empty window. These tests prove the fix: a loading window is
// NEVER rendered as "no events", whether it's the very first load
// (`timeline === null`) or a window-option switch still in flight
// (`loading === true` over a stale, still-present previous `timeline`).
describe('ReplayBar — loading vs. empty honesty (R2a thread 3)', () => {
  it('shows a loading state, never the empty state, on the very first load (timeline still null)', () => {
    renderBar(baseReplay({ timeline: null, loading: true }));

    expect(screen.getByTestId('canvas-replay-loading-state')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-replay-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canvas-replay-scrubber')).not.toBeInTheDocument();
  });

  it('shows a loading state, never the empty state, while a window-option switch is still in flight', () => {
    // A previous (non-null) timeline is still around, but loading is true
    // again (e.g. the user just clicked "24h") — must not flash "no events"
    // using the stale timeline's ticker, and must not show scrubber/ticker
    // data that may not correspond to the NEWLY selected window yet either.
    const staleTimeline = buildFleetTimeline([], 0, 10_000);
    renderBar(baseReplay({ timeline: staleTimeline, loading: true }));

    expect(screen.getByTestId('canvas-replay-loading-state')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-replay-empty')).not.toBeInTheDocument();
  });

  it('shows the genuine empty state once loading settles and the window really has zero keyframes', () => {
    const timeline = buildFleetTimeline([], 0, 10_000);
    renderBar(baseReplay({ timeline, loading: false }));

    expect(screen.getByTestId('canvas-replay-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-replay-loading-state')).not.toBeInTheDocument();
  });
});

describe('ReplayBar — populated window', () => {
  const events = [row(1, 1000, 'm-1', 'mission.created', { title: 'Mission A' }), row(2, 2000, 'm-1', 'mission.started', {})];
  const timeline = buildFleetTimeline(events, 0, 10_000);

  it('renders the scrubber/play-pause/speed/ticker and wires the window/speed/play/exit callbacks', () => {
    const replay = baseReplay({ timeline, currentTMs: 2000 });
    renderBar(replay);

    expect(screen.getByTestId('canvas-replay-scrubber')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-replay-play-pause')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-replay-ticker')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('canvas-replay-window-24h'));
    expect(replay.setWindowOption).toHaveBeenCalledWith('24h');

    fireEvent.click(screen.getByTestId('canvas-replay-speed-4'));
    expect(replay.setSpeed).toHaveBeenCalledWith(4);

    fireEvent.click(screen.getByTestId('canvas-replay-play-pause'));
    expect(replay.togglePlay).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('canvas-replay-exit'));
    expect(replay.exit).toHaveBeenCalledTimes(1);
  });

  it('scrubbing the range input calls scrubTo with the new value', () => {
    const replay = baseReplay({ timeline, currentTMs: 2000 });
    renderBar(replay);
    fireEvent.change(screen.getByTestId('canvas-replay-scrubber'), { target: { value: '5000' } });
    expect(replay.scrubTo).toHaveBeenCalledWith(5000);
  });

  it('shows a loading indicator while a query is in flight', () => {
    renderBar(baseReplay({ timeline, loading: true }));
    expect(screen.getByTestId('canvas-replay-loading')).toBeInTheDocument();
  });
});

describe('ReplayBar — fork-from-replay entry', () => {
  it('does not render the fork button when no mission is selected', () => {
    renderBar(baseReplay({ selectedMissionId: null }), vi.fn());
    expect(screen.queryByTestId('canvas-replay-fork')).not.toBeInTheDocument();
  });

  it('does not render the fork button when onForkMission was never wired, even with a selection', () => {
    renderBar(baseReplay({ selectedMissionId: 'm-1' }));
    expect(screen.queryByTestId('canvas-replay-fork')).not.toBeInTheDocument();
  });

  it('renders the fork button once a mission is selected, and calls onForkMission with its id', () => {
    const onForkMission = vi.fn();
    renderBar(baseReplay({ selectedMissionId: 'm-1' }), onForkMission);

    const button = screen.getByTestId('canvas-replay-fork');
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onForkMission).toHaveBeenCalledWith('m-1');
  });
});

describe('tickerText — event ticker composition', () => {
  const t = (key: string, params?: Record<string, string | number>): string => {
    const templates: Record<string, string> = {
      'canvas.replay.empty': 'Aucun événement sur la fenêtre',
      'canvas.replay.ticker.created': '{title} créée',
      'canvas.replay.ticker.stage': '{title} → {stage}',
      'canvas.replay.ticker.status': '{title} → {status}',
      'canvas.replay.ticker.chainFired': 'chaîne {chainId} déclenchée',
      'canvas.replay.ticker.system': '{type}',
      'canvas.replay.ticker.brainRecalled': 'brain: {count} node(s) recalled',
      'canvas.replay.ticker.brain': 'brain: {detail}',
      'cockpit.stage.test': 'TEST',
      'agents.status.review': 'En revue',
    };
    let str = templates[key] ?? key;
    if (params) for (const [k, v] of Object.entries(params)) str = str.replace(`{${k}}`, String(v));
    return str;
  };

  it('reports the empty-window copy when there is no keyframe at all', () => {
    expect(tickerText(t, undefined)).toBe('Aucun événement sur la fenêtre');
  });

  it('composes a "created" line with the clock + title', () => {
    const text = tickerText(t, { tsMs: 0, missionId: 'm-1', kind: 'created', title: 'Mission A' });
    expect(text).toContain('Mission A créée');
  });

  it('composes a "stage" line via the STAGE_LABEL_KEYS lookup', () => {
    const text = tickerText(t, { tsMs: 0, missionId: 'm-1', kind: 'stage', title: 'Mission A', stage: 'test' });
    expect(text).toBe(text); // clock prefix is locale/time-zone dependent — only assert the composed suffix below
    expect(text.endsWith('Mission A → TEST')).toBe(true);
  });

  it('composes a "status" line via the agents.status.* i18n namespace', () => {
    const text = tickerText(t, { tsMs: 0, missionId: 'm-1', kind: 'status', title: 'Mission A', status: 'review' });
    expect(text.endsWith('Mission A → En revue')).toBe(true);
  });

  it('composes a "chain_fired" line with the chain id', () => {
    const text = tickerText(t, { tsMs: 0, missionId: 'm-1', kind: 'chain_fired', title: null, chainId: 'chain-9' });
    expect(text.endsWith('chaîne chain-9 déclenchée')).toBe(true);
  });

  // ── Brain-integration wave: brain.* keyframes get a real, payload-derived line ──

  it('composes a "brain" recalled line from a real node count (brainCount)', () => {
    const text = tickerText(t, {
      tsMs: 0,
      missionId: null,
      kind: 'brain',
      title: null,
      eventType: 'brain.recalled',
      brainCount: 3,
    });
    expect(text.endsWith('brain: 3 node(s) recalled')).toBe(true);
  });

  it('composes a generic "brain" line from a real detail (captured/promoted/decision)', () => {
    const text = tickerText(t, {
      tsMs: 0,
      missionId: null,
      kind: 'brain',
      title: null,
      eventType: 'brain.captured',
      brainDetail: 'learning',
    });
    expect(text.endsWith('brain: learning')).toBe(true);
  });

  it('falls back to the raw event type when a brain keyframe carries neither a count nor a detail', () => {
    const text = tickerText(t, {
      tsMs: 0,
      missionId: null,
      kind: 'brain',
      title: null,
      eventType: 'brain.promoted',
    });
    expect(text.endsWith('brain.promoted')).toBe(true);
  });
});
