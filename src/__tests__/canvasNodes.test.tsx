/**
 * canvasNodes.test.tsx — W1b fixture render tests for the canvas node/edge
 * components (spec §4.2-§4.4, plan W1b). Covers the pure "Card"/helper
 * exports directly (no live viewport / ReactFlowProvider needed — Handle
 * and the semantic-zoom `useStore` selector live only in the RF-registered
 * wrapper components, which W1c mounts for real inside <ReactFlow/>).
 */

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';

// R7 (living surfaces) — MissionNodeCard's expanded live-panel branch renders
// a real @xyflow/react `NodeResizer`, which needs RF's internal node context
// to do anything useful; stubbed to a prop-capturing no-op for THIS file's
// fixture-level renders (no live ReactFlow tree here — see
// TerminalNode.test.tsx/PreviewNode.test.tsx for the identical convention).
// Every OTHER @xyflow/react export (Handle, Position, ...) passes through
// untouched, so every pre-existing test in this file is unaffected.
interface CapturedNodeResizerProps {
  onResizeEnd?: (event: unknown, params: { x: number; y: number; width: number; height: number }) => void;
}
let capturedNodeResizerProps: CapturedNodeResizerProps | null = null;
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    NodeResizer: (props: CapturedNodeResizerProps) => {
      capturedNodeResizerProps = props;
      return null;
    },
  };
});
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { DraftSpec, LoopNodeData, MissionNodeData, ProjectNodeData } from '../components/agents/canvas/canvasTypes';
import type { JudgeVerdict, LoopConfig } from '../lib/agents/types';
import type { IterationNodeData, NoteData, RouterNodeData, ScheduleNodeData } from '../components/agents/canvas/canvasTypes';
import {
  MissionNodeCard,
  deriveLiveLine,
  formatLiveActivityLine,
  isHeartbeatStale,
  isJudgeVerdictUnavailable,
  canvasLiveParts,
  HEARTBEAT_STALE_THRESHOLD_MS,
} from '../components/agents/canvas/nodes/MissionNode';
import { JUDGE_UNAVAILABLE_PROVIDER_REASON } from '../lib/agents/evaluator';
import { CostChip } from '../components/agents/canvas/chrome/CostChip';
import { LoopNodeCard } from '../components/agents/canvas/nodes/LoopNode';
import { DraftNodeCard } from '../components/agents/canvas/nodes/DraftNode';
import { IterationNodeCard } from '../components/agents/canvas/nodes/IterationNode';
import { ScheduleNodeCard } from '../components/agents/canvas/nodes/ScheduleNode';
import { NoteNodeCard } from '../components/agents/canvas/nodes/NoteNode';
import { RouterNodeCard } from '../components/agents/canvas/nodes/RouterNode';
import { ProjectGroupNodeCard } from '../components/agents/canvas/nodes/ProjectGroupNode';
import { chipClampMaxWidth, AGGREGATE_CHIP_MAX_SCALE } from '../components/agents/canvas/nodes/ZoneAggregateSummary';
import {
  ZONE_HEADER_HEIGHT,
  ZONE_TITLE_BAND_HEIGHT,
  ZONE_TITLE_GAP_ABOVE,
  ZONE_TITLE_RESERVED_NAME_CHARS,
  zoneMinWidthForTitle,
} from '../components/agents/canvas/geometry';
import { truncateMiddle } from '../lib/truncateMiddle';
import { TRANSVERSE_PROJECT_ID } from '../components/agents/canvas/reconciler';
import { on } from '../lib/bus';
import { StageRail } from '../components/agents/canvas/chrome/StageRail';
import { conditionLabelKey, conditionStrokeProps, chainEdgeLabelPosition, CHAIN_EDGE_LABEL_Y_NUDGE_PX } from '../components/agents/canvas/edges/ChainEdge';
import {
  CanvasActionsProvider,
  DEFAULT_CANVAS_ACTIONS,
  type CanvasActionsValue,
} from '../components/agents/canvas/chrome/CanvasActionsContext';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef } from '../components/agents/canvas/canvasTypes';

function makeMission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Fix login bug',
    status: 'running',
    stage: 'code',
    model: 'sonnet-4.6',
    updatedMs: Date.now(),
    urgent: false,
    ...overrides,
  };
}

function makeMissionData(
  overrides: Partial<MissionNodeData> = {},
  missionOverrides: Partial<FleetMission> = {},
): MissionNodeData {
  return {
    mission: makeMission(missionOverrides),
    projectId: 'p1',
    isActiveProject: true,
    ...overrides,
  };
}

function withActions(children: ReactNode, actions: Partial<CanvasActionsValue> = {}) {
  return (
    <I18nProvider>
      <CanvasActionsProvider value={{ ...DEFAULT_CANVAS_ACTIONS, ...actions }}>{children}</CanvasActionsProvider>
    </I18nProvider>
  );
}

describe('formatLiveActivityLine — pure terminal-line formatting (fix/canvas-agents-visibility)', () => {
  it('collapses embedded newlines/repeated whitespace into a single compact line', () => {
    expect(formatLiveActivityLine('[9] run_command: npx http-server\nServing on port 8080')).toBe(
      '[9] run_command: npx http-server Serving on port 8080',
    );
  });

  it('trims leading/trailing whitespace', () => {
    expect(formatLiveActivityLine('   Observation: build ok   ')).toBe('Observation: build ok');
  });

  it('returns undefined for empty/whitespace-only/undefined input — never a blank line', () => {
    expect(formatLiveActivityLine(undefined)).toBeUndefined();
    expect(formatLiveActivityLine('')).toBeUndefined();
    expect(formatLiveActivityLine('   \n  ')).toBeUndefined();
  });
});

describe('isHeartbeatStale — 90s "agent silencieux" threshold (fix/canvas-agents-visibility)', () => {
  it('is not stale at or before the threshold', () => {
    expect(isHeartbeatStale(0)).toBe(false);
    expect(isHeartbeatStale(HEARTBEAT_STALE_THRESHOLD_MS)).toBe(false);
  });

  it('is stale just past the threshold', () => {
    expect(isHeartbeatStale(HEARTBEAT_STALE_THRESHOLD_MS + 1)).toBe(true);
    expect(isHeartbeatStale(120_000)).toBe(true);
  });
});

describe('MissionNodeCard — live activity strip + heartbeat (fix/canvas-agents-visibility)', () => {
  it('shows a fresh (non-stale) heartbeat right after an update', () => {
    const data = makeMissionData({}, { status: 'running', updatedMs: Date.now() });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    const heartbeat = screen.getByTestId(`mission-node-heartbeat-${data.mission.id}`);
    expect(heartbeat.style.color).not.toBe('var(--color-warning-text)');
  });

  it('flips to the orange "agent silencieux" state once the last update is older than 90s', () => {
    localStorage.setItem('lazy.locale', 'fr');
    try {
      const data = makeMissionData(
        {},
        { status: 'running', updatedMs: Date.now() - (HEARTBEAT_STALE_THRESHOLD_MS + 5_000) },
      );
      render(<I18nProvider>
        <MissionNodeCard data={data} zoomLevel="full" />
      </I18nProvider>);
      const heartbeat = screen.getByTestId(`mission-node-heartbeat-${data.mission.id}`);
      expect(heartbeat.style.color).toBe('var(--color-warning-text)');
      expect(heartbeat.textContent).toMatch(/silencieux/);
    } finally {
      localStorage.removeItem('lazy.locale');
    }
  });

  it('never renders the activity/heartbeat strip for a non-running mission', () => {
    const data = makeMissionData({}, { status: 'done' });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    expect(screen.queryByTestId(`mission-node-heartbeat-${data.mission.id}`)).not.toBeInTheDocument();
  });
});

describe('MissionNodeCard — one constant card at every zoom (W-CARDS)', () => {
  // W-CARDS (product owner, 2026-07-18: "je veux pareil zoomé et dézoomé")
  // — the old three-tier semantic LOD (billboard chip / stripped compact
  // card / full card) is retired for missions: `zoomLevel` is accepted for
  // call-site compatibility but the SAME full card (title, status/type
  // glyph, stage rail) renders regardless of its value. Geometric scaling
  // by the real viewport zoom is React Flow's job, not this component's —
  // see MissionNode.tsx's own header.
  it.each(['chip', 'compact', 'full'] as const)('renders the one full card at zoomLevel %s — never a billboard chip', (zoomLevel) => {
    const data = makeMissionData();
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel={zoomLevel} />
    </I18nProvider>);
    expect(screen.getByTestId(`mission-node-${data.mission.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('mission-node-title')).toHaveTextContent('Fix login bug');
    expect(screen.getByTestId('glyph-mission')).toBeInTheDocument();
    expect(screen.queryByTestId(`mission-chip-${data.mission.id}`)).not.toBeInTheDocument();
  });

  it.each(['chip', 'compact', 'full'] as const)('EVERY mission shows its title at zoomLevel %s, not just the top-3 urgent (the "3 labels out of 12" bug)', (zoomLevel) => {
    const noRank = makeMissionData();
    const { unmount } = render(<I18nProvider>
      <MissionNodeCard data={noRank} zoomLevel={zoomLevel} />
    </I18nProvider>);
    expect(screen.getByTestId('mission-node-title')).toHaveTextContent('Fix login bug');
    unmount();

    const rank4 = makeMissionData({ urgentRank: 4 }, { status: 'failed', title: 'low-priority-ok' });
    render(<I18nProvider>
      <MissionNodeCard data={rank4} zoomLevel={zoomLevel} />
    </I18nProvider>);
    expect(screen.getByTestId('mission-node-title')).toHaveTextContent('low-priority-ok');
  });

  // W-CARDS — the DOM text content is the FULL, untruncated title at every
  // zoomLevel (CSS `textOverflow: ellipsis` handles VISUAL clipping when
  // the geometric zoom shrinks the card small — never a JS string-slice
  // that would also corrupt what a screen reader/test sees).
  it('never JS-truncates the title — full text stays in the DOM, CSS ellipsis handles overflow visually', () => {
    const data = makeMissionData({}, { title: 'a-very-long-mission-title-that-overflows' });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="chip" />
    </I18nProvider>);
    const title = screen.getByTestId('mission-node-title');
    expect(title).toHaveTextContent('a-very-long-mission-title-that-overflows');
    expect(title.style.textOverflow).toBe('ellipsis');
    expect(title.style.whiteSpace).toBe('nowrap');
  });

  it('the native tooltip carries the full "title — status — stage" line, regardless of zoomLevel', () => {
    localStorage.setItem('lazy.locale', 'fr');
    try {
      const data = makeMissionData({}, { title: 'Fix login bug', status: 'running', stage: 'code' });
      render(<I18nProvider>
        <MissionNodeCard data={data} zoomLevel="chip" />
      </I18nProvider>);
      const card = screen.getByTestId(`mission-node-${data.mission.id}`);
      const title = card.getAttribute('title') ?? '';
      expect(title).toContain('Fix login bug');
      expect(title.split('—').length).toBeGreaterThanOrEqual(3); // title — status — stage
    } finally {
      localStorage.removeItem('lazy.locale');
    }
  });

  it('a mission with a pending question shows the pending-question badge at any zoomLevel', () => {
    const data = makeMissionData({}, { pendingQuestion: 'Puis-je toucher ce fichier ?' });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="chip" />
    </I18nProvider>);
    expect(screen.getByTestId(`mission-node-${data.mission.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('pending-question-badge')).toBeInTheDocument();
  });

  // ── Attribute-work-visibly wave 1 — conversation origin dot ─────────────

  it('shows the conversation-origin dot when the mission carries originConversationId', () => {
    const data = makeMissionData({}, { originConversationId: 'conv-1' });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    expect(screen.getByTestId('mission-node-conversation-dot')).toBeInTheDocument();
  });

  it('omits the conversation-origin dot for a mission launched outside the manager (no fabricated attribution)', () => {
    const data = makeMissionData(); // no originConversationId
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    expect(screen.queryByTestId('mission-node-conversation-dot')).not.toBeInTheDocument();
  });

  it('two missions from the SAME conversation render the SAME dot color; a different conversation renders a different color', () => {
    const dataA = makeMissionData({}, { id: 'mA', originConversationId: 'conv-1' });
    const { unmount: unmountA } = render(<I18nProvider>
      <MissionNodeCard data={dataA} zoomLevel="full" />
    </I18nProvider>);
    const colorA1 = screen.getByTestId('mission-node-conversation-dot').style.background;
    unmountA();

    const dataA2 = makeMissionData({}, { id: 'mA2', originConversationId: 'conv-1' });
    const { unmount: unmountA2 } = render(<I18nProvider>
      <MissionNodeCard data={dataA2} zoomLevel="full" />
    </I18nProvider>);
    const colorA2 = screen.getByTestId('mission-node-conversation-dot').style.background;
    unmountA2();

    const dataB = makeMissionData({}, { id: 'mB', originConversationId: 'conv-2' });
    render(<I18nProvider>
      <MissionNodeCard data={dataB} zoomLevel="full" />
    </I18nProvider>);
    const colorB = screen.getByTestId('mission-node-conversation-dot').style.background;

    expect(colorA1).toBe(colorA2);
    expect(colorA1).not.toBe(colorB);
  });

  it('shows title + stage rail + live action at "compact" zoomLevel too — no stripped-down subset', () => {
    const data = makeMissionData();
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="compact" />
    </I18nProvider>);
    expect(screen.getByTestId('mission-node-title')).toHaveTextContent('Fix login bug');
    expect(screen.getByTestId('stage-rail')).toHaveAttribute('data-current-stage', 'code');
    expect(screen.getByTestId('mission-node-live-action')).toBeInTheDocument();
  });

  it('review with a real diffFiles basename uses LiveActionLine (blinking verb + file), never the stale liveAction', () => {
    localStorage.setItem('lazy.locale', 'en');
    try {
      const data = makeMissionData({}, {
        status: 'review',
        liveAction: 'Running reviewer sub-agent…',
        diffFiles: [{ filename: 'src/lib/auth.ts', added: 3, removed: 1 }],
      });
      render(withActions(<MissionNodeCard data={data} zoomLevel="full" />));
      const verb = screen.getByTestId('mission-node-live-verb');
      expect(verb).toHaveTextContent('In review');
      expect(verb).toHaveTextContent('auth.ts');
      expect(verb).not.toHaveTextContent('Running reviewer');
    } finally {
      localStorage.removeItem('lazy.locale');
    }
  });

  it('full level (failed mission) shows live action, progress, reason and a real retry callback', () => {
    const onUrgentAction = vi.fn();
    const data = makeMissionData({}, { status: 'failed', statusReason: 'Build cassé', progress: 42 });
    render(
      withActions(<MissionNodeCard data={data} zoomLevel="full" />, { onUrgentAction }),
    );
    expect(screen.getByTestId('mission-node-live-action')).toBeInTheDocument();
    expect(screen.getByTestId('progress-bar')).toBeInTheDocument();
    expect(screen.getByTestId('status-reason')).toHaveTextContent('Build cassé');

    fireEvent.click(screen.getByTestId('retry-button'));
    expect(onUrgentAction).toHaveBeenCalledWith(data.mission, 'retry');

    // Quick actions mirror cockpit's urgentActionsFor('failed', …): promote + logs.
    fireEvent.click(screen.getByTestId(`mission-node-action-${data.mission.id}-logs`));
    expect(onUrgentAction).toHaveBeenCalledWith(data.mission, 'logs');
  });

  // fix/canvas-ux R4d (dogfood defect #3) — R3 dogfood: a FAILED card kept
  // showing "en attente…" (the running-card no-live-text placeholder) even
  // though the mission was long done running. Regression coverage for the
  // exact reported text, at the real component level (not just the pure
  // deriveLiveLine unit tests below).
  it('failed mission with no statusReason never shows the queued/no-live-text placeholder (regression: "en attente…")', () => {
    localStorage.setItem('lazy.locale', 'fr');
    try {
      const data = makeMissionData({}, { status: 'failed', liveAction: undefined, statusReason: undefined });
      render(withActions(<MissionNodeCard data={data} zoomLevel="full" />));
      expect(screen.getByTestId('mission-node-live-action').textContent).not.toBe('en attente…');
      expect(screen.getByTestId('mission-node-live-action')).toHaveTextContent('Échec');
    } finally {
      localStorage.removeItem('lazy.locale');
    }
  });

  // W-UX3 audit fix #5a — the animated ellipsis (::after) appends "…", so a
  // running liveAction that ALREADY ends with one rendered « …… ». The text
  // must be stripped of its trailing ellipsis when the animated one is on.
  it('running live line strips its own trailing ellipsis so the animated one never doubles it', () => {
    const data = makeMissionData({}, { status: 'running', liveAction: 'écrit PaymentSheet.tsx…' });
    render(withActions(<MissionNodeCard data={data} zoomLevel="full" />));
    const line = screen.getByTestId('mission-node-live-action');
    const animatedSpan = line.querySelector('.canvas-live-ellipsis');
    expect(animatedSpan).not.toBeNull();
    // Trailing ellipsis removed from the text (the CSS ::after supplies it).
    expect(animatedSpan!.textContent).toBe('écrit PaymentSheet.tsx');
    expect(animatedSpan!.textContent).not.toMatch(/…$/);
  });

  // W-UX3 audit fix #5b — a review mission the judge already REJECTED must
  // not present a green/primary merge; it drops to the secondary treatment.
  it('review mission with a REJECTED verdict de-emphasises the merge quick action (no green primary)', () => {
    const rejected = makeMissionData({}, { status: 'review', judgeVerdict: { score: 30, passed: false, risk: 'high', reviewers: [], createdAt: new Date().toISOString() } });
    const { unmount } = render(withActions(<MissionNodeCard data={rejected} zoomLevel="full" />));
    const mergeRejected = screen.getByTestId('mission-node-action-m1-merge');
    expect(mergeRejected.style.background).toBe('transparent');
    unmount();

    const passed = makeMissionData({}, { status: 'review', judgeVerdict: { score: 90, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString() } });
    render(withActions(<MissionNodeCard data={passed} zoomLevel="full" />));
    const mergePassed = screen.getByTestId('mission-node-action-m1-merge');
    // A passed/forward verdict keeps the green primary merge.
    expect(mergePassed.style.background).toContain('--color-merge');
  });

  // fix/canvas-promote-icon (David's measured repro: the "promote" quick
  // action on a rejected review card rendered as raw text carrying a
  // literal 🧠 emoji) — a rejected verdict adds the 'promote' quick action
  // (cockpitHelpers.ts's urgentActionsFor, isJudgeRejected); its label must
  // never carry a raw emoji character, and it must render the SAME drawn-SVG
  // icon convention every other quick action/hover action on this card uses.
  it("the 'promote' quick action (rejected verdict) renders a drawn SVG icon, never a raw emoji in its label", () => {
    const rejected = makeMissionData(
      {},
      { status: 'review', judgeVerdict: { score: 30, passed: false, risk: 'high', reviewers: [], createdAt: new Date().toISOString() } },
    );
    render(withActions(<MissionNodeCard data={rejected} zoomLevel="full" />));
    const promoteButton = screen.getByTestId(`mission-node-action-${rejected.mission.id}-promote`);
    expect(promoteButton.querySelector('svg')).not.toBeNull();
    // The visible label text must not contain a raw emoji character (a
    // crude but effective check: no character above the BMP's emoji range).
    expect(promoteButton.textContent ?? '').not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('full level review mission: merge quick action label changes with forceApprove (no hardcoded locale text)', () => {
    const base = makeMissionData({ forceApprove: false }, { status: 'review' });
    const { unmount } = render(withActions(<MissionNodeCard data={base} zoomLevel="full" />));
    const normalLabel = screen.getByTestId(`mission-node-action-${base.mission.id}-merge`).textContent;
    unmount();

    const forced = makeMissionData({ forceApprove: true }, { status: 'review' });
    render(withActions(<MissionNodeCard data={forced} zoomLevel="full" />));
    const forcedLabel = screen.getByTestId(`mission-node-action-${forced.mission.id}-merge`).textContent;

    expect(forcedLabel).not.toBe(normalLabel);
  });

  it('pending question shows the "?" badge and urgent rank shows the rank chip', () => {
    const data = makeMissionData({ urgentRank: 2 }, { pendingQuestion: 'Puis-je toucher ce fichier ?' });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="compact" />
    </I18nProvider>);
    expect(screen.getByTestId('pending-question-badge')).toBeInTheDocument();
    expect(screen.getByTestId('urgent-rank-chip')).toHaveTextContent('2');
  });

  // W-CARDS — a running mission's card gets NodeCard's own rotating-ring
  // halo class (statusHaloClassName -> canvas-node-ring-running), the ONE
  // motion signal for "alive" now that there's no separate billboard-chip
  // pulse class to carry it at low zoom.
  it('a running mission gets the running-ring halo class, at any zoomLevel', () => {
    const data = makeMissionData({}, { status: 'running' });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="chip" />
    </I18nProvider>);
    expect(screen.getByTestId(`mission-node-${data.mission.id}`)).toHaveClass('canvas-node-ring-running');
  });
});

// fix/canvas-ux R4d (dogfood defect #2) — « Verdict 3000% » (a real judge
// score of 30 rendered through a stray `* 100`) and « Verdict 0% » side by
// side (R3 dogfood). `verdict.score` is a 0-100 value everywhere in the app
// (evaluator.ts, DataInspector.tsx's `{verdict.score}/100`, every
// evaluator.test.ts assertion) — VerdictChip used to re-scale it as if it
// were a 0-1 fraction. Locale pinned to 'fr' (same convention
// ProjectGroupNodeCard's own describe block below uses) since these assert
// the literal rendered text, not just presence.
describe('VerdictChip — score format (fix/canvas-ux R4d defect #2)', () => {
  beforeEach(() => localStorage.setItem('lazy.locale', 'fr'));
  afterEach(() => localStorage.removeItem('lazy.locale'));

  function verdict(score: number, passed: boolean): JudgeVerdict {
    return { score, passed, risk: 'low', reviewers: [], createdAt: new Date().toISOString() };
  }

  it('a score of 30 renders "Verdict 30/100" — never "Verdict 3000%"', () => {
    const data = makeMissionData({}, { status: 'review', judgeVerdict: verdict(30, false) });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    const chip = screen.getByTestId('verdict-chip');
    expect(chip).toHaveTextContent('Verdict 30/100');
    expect(chip.textContent).not.toContain('3000');
  });

  it('a score of 0 renders "Verdict 0/100" (never a bare, ambiguous "0%")', () => {
    const data = makeMissionData({}, { status: 'review', judgeVerdict: verdict(0, false) });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    expect(screen.getByTestId('verdict-chip')).toHaveTextContent('Verdict 0/100');
  });

  it('a passed score of 86 renders "Verdict 86/100"', () => {
    const data = makeMissionData({}, { status: 'review', judgeVerdict: verdict(86, true) });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    expect(screen.getByTestId('verdict-chip')).toHaveTextContent('Verdict 86/100');
  });

  // R11 (judge-score honesty) — evaluator.ts's aggregateVerdict flags
  // `scoreUnavailable: true` when neither the judge nor any conclusive
  // reviewer produced a real, parsable score (the judge JSON was unparsable
  // and there was no fallback signal either) — the exact case that used to
  // render a fabricated « Verdict 0/100 » on what could genuinely be a
  // PASSING mission. The chip must render the honest absence instead.
  //
  // Visual sweep #4b — a passing-but-unavailable verdict used to render the
  // bare "Verdict —" here, directly contradicting this SAME card's own
  // live-line text a few rows up (deriveLiveLine -> "Verdict : approuvé"):
  // one card simultaneously claiming "no verdict" and "approved". Now
  // renders an unambiguous "judged, no score" label instead of the dash.
  it('scoreUnavailable + passed renders "Jugé ✓" — never the bare "Verdict —" that contradicted this card\'s own "approuvé" live line', () => {
    const passingButUnavailable: JudgeVerdict = {
      score: 0,
      passed: true,
      risk: 'medium',
      reviewers: [],
      createdAt: new Date().toISOString(),
      scoreUnavailable: true,
    };
    const data = makeMissionData({}, { status: 'review', judgeVerdict: passingButUnavailable });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    const chip = screen.getByTestId('verdict-chip');
    expect(chip).toHaveTextContent('Jugé ✓');
    expect(chip.textContent).not.toContain('0/100');
    expect(chip.textContent).not.toContain('Verdict —');
  });

  // fix/canvas-verdict-contradiction (David's measured repro, 2026-08-14) —
  // the claim this test used to lock in ("no contradiction to fix... nothing
  // elsewhere on the card claims 'approved'") was wrong in practice:
  // deriveLiveLine (missionLiveLine.ts) renders "Verdict : rejeté" for this
  // EXACT state (scoreUnavailable + !passed, judge not itself flagged
  // unavailable) elsewhere on the very same card — a real card showed
  // "REVIEW / Verdict: rejected" in its body while this chip, right next to
  // it, read "Verdict —". Same fix shape as the passed side just above:
  // an unambiguous "judged, rejected" label instead of the dash.
  it('scoreUnavailable + rejected renders "Jugé ✗" — never the bare "Verdict —" that contradicted this card\'s own "rejeté" live line', () => {
    const rejectedAndUnavailable: JudgeVerdict = {
      score: 0,
      passed: false,
      risk: 'medium',
      reviewers: [],
      createdAt: new Date().toISOString(),
      scoreUnavailable: true,
    };
    const data = makeMissionData({}, { status: 'review', judgeVerdict: rejectedAndUnavailable });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    const chip = screen.getByTestId('verdict-chip');
    expect(chip).toHaveTextContent('Jugé ✗');
    expect(chip.textContent).not.toContain('0/100');
    expect(chip.textContent).not.toContain('Verdict —');
  });

  // fix/canvas-verdict-contradiction — "if you can cheaply surface WHY it
  // was rejected... do": the judge's own summary, when a real (conclusive)
  // one exists, rides along in the chip's tooltip instead of a bare word.
  it('surfaces the judge\'s own rejection reason in the chip tooltip when available', () => {
    const rejectedWithReason: JudgeVerdict = {
      score: 12,
      passed: false,
      risk: 'medium',
      reviewers: [{ role: 'judge', verdict: 'request_changes', summary: 'missing test coverage for the new endpoint' }],
      createdAt: new Date().toISOString(),
    };
    const data = makeMissionData({}, { status: 'review', judgeVerdict: rejectedWithReason });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    const chip = screen.getByTestId('verdict-chip');
    expect(chip.getAttribute('title')).toContain('missing test coverage for the new endpoint');
  });

  it('never fabricates a reason from an INCONCLUSIVE reviewer (a non-vote is not a real reason)', () => {
    const rejectedInconclusiveOnly: JudgeVerdict = {
      score: 0,
      passed: false,
      risk: 'medium',
      reviewers: [{ role: 'judge', verdict: 'request_changes', summary: 'evaluator infrastructure failure', inconclusive: true }],
      createdAt: new Date().toISOString(),
      scoreUnavailable: true,
    };
    const data = makeMissionData({}, { status: 'review', judgeVerdict: rejectedInconclusiveOnly });
    render(<I18nProvider>
      <MissionNodeCard data={data} zoomLevel="full" />
    </I18nProvider>);
    const chip = screen.getByTestId('verdict-chip');
    expect(chip.getAttribute('title')).not.toContain('evaluator infrastructure failure');
  });
});

// Founder directive (2026-08-05, DeepSeek 402 incident): "on sait meme pas
// ce que c'est... le lazymanager devrait savoir ce que c'est et nous aider
// dans la decision" — a mission whose judge sub-agent never actually ran
// (provider unavailable) must never present as "Verdict : rejeté". See
// isJudgeVerdictUnavailable's own doc comment (MissionNode.tsx) for the
// full aggregateVerdict mechanics this guards against (every reviewer
// inconclusive -> `passed` falls through to `false`).
describe('isJudgeVerdictUnavailable — judge-provider-unavailable detection (2026-08-05 DeepSeek 402 incident)', () => {
  it('false for undefined/null (no verdict at all yet)', () => {
    expect(isJudgeVerdictUnavailable(undefined)).toBe(false);
    expect(isJudgeVerdictUnavailable(null)).toBe(false);
  });

  it('false for a verdict with no judge reviewer entry, or a judge entry with an ordinary summary', () => {
    expect(isJudgeVerdictUnavailable({ reviewers: [] })).toBe(false);
    expect(isJudgeVerdictUnavailable({ reviewers: [{ role: 'judge', verdict: 'reject', summary: 'Missing error handling.' }] })).toBe(false);
  });

  it('true when the judge reviewer entry\'s summary starts with the stable JUDGE_UNAVAILABLE_PROVIDER_REASON marker', () => {
    const unavailable: Pick<JudgeVerdict, 'reviewers'> = {
      reviewers: [
        { role: 'reviewer', verdict: 'approve', summary: 'Looks fine.' },
        {
          role: 'judge',
          verdict: 'request_changes',
          summary: `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: deepseek — 402 quota exceeded (provider error, not a code defect — the judge could not run).`,
          inconclusive: true,
        },
      ],
    };
    expect(isJudgeVerdictUnavailable(unavailable)).toBe(true);
  });

  it('false when a NON-judge reviewer merely mentions the marker word in prose (only the judge role\'s own summary counts)', () => {
    const notJudge: Pick<JudgeVerdict, 'reviewers'> = {
      reviewers: [{ role: 'security', verdict: 'reject', summary: `Unrelated text mentioning ${JUDGE_UNAVAILABLE_PROVIDER_REASON} out of context.` }],
    };
    expect(isJudgeVerdictUnavailable(notJudge)).toBe(false);
  });
});

describe('deriveLiveLine — third verdict state: judge unavailable (2026-08-05 DeepSeek 402 incident)', () => {
  it('a judgeVerdict whose judge entry carries the unavailable marker renders the honest "unavailable" key, never verdictRejected — even though passed===false', () => {
    // Mirrors the real incident: aggregateVerdict's fallback with zero
    // conclusive reviewers sets `passed: false` — this must still NOT read
    // as "Verdict : rejeté".
    const judgeUnavailable: JudgeVerdict = {
      score: 0,
      passed: false,
      risk: 'medium',
      scoreUnavailable: true,
      createdAt: '',
      reviewers: [
        {
          role: 'judge',
          verdict: 'request_changes',
          summary: `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: deepseek — 402 quota exceeded (provider error, not a code defect — the judge could not run).`,
          inconclusive: true,
        },
      ],
    };
    const line = deriveLiveLine({ judgeVerdict: judgeUnavailable, liveAction: 'Running reviewer sub-agent…' }, 'review', fakeT);
    expect(line).toBe('canvas.node.verdictJudgeUnavailable');
    expect(line).not.toBe('canvas.node.verdictRejected');
  });

  it('a judge-unavailable verdict that HAPPENS to have passed===true (other reviewers approved) still shows "unavailable", not "approuvé"', () => {
    const judgeUnavailablePassed: JudgeVerdict = {
      score: 80,
      passed: true,
      risk: 'low',
      createdAt: '',
      reviewers: [
        { role: 'reviewer', verdict: 'approve', score: 80, summary: 'Looks good.' },
        {
          role: 'judge',
          verdict: 'request_changes',
          summary: `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: openai — 401 invalid key.`,
          inconclusive: true,
        },
      ],
    };
    expect(deriveLiveLine({ judgeVerdict: judgeUnavailablePassed }, 'review', fakeT)).toBe('canvas.node.verdictJudgeUnavailable');
  });
});

// Real-component-level regression coverage for the same fix (not just the
// pure deriveLiveLine unit tests above) — locale pinned to 'fr' so this
// asserts the literal rendered copy, same convention the VerdictChip
// describe block above uses.
describe('MissionNodeCard — live-action line honestly shows "évaluation indisponible" (2026-08-05 DeepSeek 402 incident)', () => {
  beforeEach(() => localStorage.setItem('lazy.locale', 'fr'));
  afterEach(() => localStorage.removeItem('lazy.locale'));

  it('renders "Évaluation indisponible" in the live-action line, never "Verdict : rejeté"', () => {
    const judgeUnavailable: JudgeVerdict = {
      score: 0,
      passed: false,
      risk: 'medium',
      scoreUnavailable: true,
      createdAt: new Date().toISOString(),
      reviewers: [
        {
          role: 'judge',
          verdict: 'request_changes',
          summary: `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: deepseek — 402 quota exceeded (provider error, not a code defect — the judge could not run).`,
          inconclusive: true,
        },
      ],
    };
    const data = makeMissionData({}, { status: 'review', judgeVerdict: judgeUnavailable });
    render(withActions(<MissionNodeCard data={data} zoomLevel="full" />));
    const line = screen.getByTestId('mission-node-live-action');
    expect(line).toHaveTextContent('Évaluation indisponible');
    expect(line.textContent).not.toMatch(/rejeté/);
  });
});

// W-COST — per-mission live cost chip (market research: per-agent live cost
// visibility is underserved by every competitor). Tested directly against
// the pure CostChip component (no hooks/context of its own, unlike
// VerdictChip above) rather than through MissionNodeCard, since MissionNode
// sources its props from `fullMission` (agentsStore lookup) which is always
// undefined in these bare fixture renders (no AgentsStoreProvider) — see
// MissionNode.tsx's own doc comment on that honest-degradation lookup.
// fix/canvas-cost-credits (David's measured repro: a claude-haiku-4-5
// mission — routed on the user's OWN Claude CLI subscription — showed
// "$0.07") — the owner's standing rule (already established elsewhere in
// this codebase, types.ts's estimatedCreditsByModel doc comment): mission
// cost is CREDITS, never €/$, and a subscription-routed run states
// explicitly that it incurred no debit rather than inventing a dollar
// figure. `model` absent (every test below that omits it) falls back to
// the credits-shown branch — `classifyMissionModel(undefined)` is neither
// 'native' nor anything else, so there is no rail to report "no debit" for.
describe('CostChip — live cost visibility + estimate honesty, credits not dollars (fix/canvas-cost-credits)', () => {
  it('a real cost renders "N cr" with no ≈ prefix — never a dollar figure', () => {
    render(<I18nProvider><CostChip costUsd={1.23} tokensSource="real" testId="cost-chip" /></I18nProvider>);
    expect(screen.getByTestId('cost-chip')).toHaveTextContent('123 cr');
    expect(screen.getByTestId('cost-chip').textContent).not.toContain('≈');
    expect(screen.getByTestId('cost-chip').textContent).not.toContain('$');
  });

  it('an undefined tokensSource (native agent_run — always exact) renders with no ≈ prefix', () => {
    render(<I18nProvider><CostChip costUsd={4.5} testId="cost-chip" /></I18nProvider>);
    expect(screen.getByTestId('cost-chip')).toHaveTextContent('450 cr');
    expect(screen.getByTestId('cost-chip').textContent).not.toContain('≈');
  });

  it('an estimated cost is prefixed with ≈ — never presented as exact', () => {
    render(<I18nProvider><CostChip costUsd={2.5} tokensSource="estimated" testId="cost-chip" /></I18nProvider>);
    expect(screen.getByTestId('cost-chip')).toHaveTextContent('≈250 cr');
  });

  it('a mixed real+estimated cost is ALSO prefixed with ≈', () => {
    render(<I18nProvider><CostChip costUsd={0.9} tokensSource="mixed" testId="cost-chip" /></I18nProvider>);
    expect(screen.getByTestId('cost-chip')).toHaveTextContent('≈90 cr');
  });

  it('zero or undefined cost renders nothing at all — never a fabricated "0 cr"', () => {
    const { rerender } = render(<I18nProvider><CostChip costUsd={0} testId="cost-chip" /></I18nProvider>);
    expect(screen.queryByTestId('cost-chip')).not.toBeInTheDocument();
    rerender(<I18nProvider><CostChip costUsd={undefined} testId="cost-chip" /></I18nProvider>);
    expect(screen.queryByTestId('cost-chip')).not.toBeInTheDocument();
  });

  it('at or above 90% of the budget cap, renders in the warning accent (classifyBudget\'s own threshold)', () => {
    render(<I18nProvider><CostChip costUsd={9} budgetCapUsd={10} testId="cost-chip" /></I18nProvider>);
    expect(screen.getByTestId('cost-chip')).toHaveAttribute('data-cost-warning', 'true');
  });

  it('below 90% of the budget cap, renders with no warning accent', () => {
    render(<I18nProvider><CostChip costUsd={5} budgetCapUsd={10} testId="cost-chip" /></I18nProvider>);
    expect(screen.getByTestId('cost-chip')).not.toHaveAttribute('data-cost-warning');
  });

  it('with no budgetCapUsd at all (unlimited), never warns regardless of spend', () => {
    render(<I18nProvider><CostChip costUsd={999} testId="cost-chip" /></I18nProvider>);
    expect(screen.getByTestId('cost-chip')).not.toHaveAttribute('data-cost-warning');
  });

  // fix/canvas-cost-credits — the CLI-subscription rail: runtime.ts's
  // classifyMissionModel('claude-haiku-4-5') -> 'native' (no '/', not a BYOK
  // provider id) is the SAME classification the mission's own run was
  // actually dispatched through.
  // Fix D (2026-08-19 dollar-kill incident follow-up): the native branch now
  // shows the SAME credits-equivalent figure the real-spend branch would
  // (one shared usdToCredits conversion, $0.07 -> 7 credits) instead of
  // hiding the number entirely — MissionNode.tsx used to show a raw dollar
  // figure right next to this chip's bare "no debit" text, a contradiction.
  // Still never a dollar figure, still explicitly non-debited (title +
  // "no debit" wording), just no longer a BLANK figure.
  it('a native (CLI subscription) model renders the credits-equivalent figure, explicitly non-debited — never a dollar figure', () => {
    render(<I18nProvider><CostChip costUsd={0.07} model="claude-haiku-4-5" testId="cost-chip" /></I18nProvider>);
    const chip = screen.getByTestId('cost-chip');
    expect(chip.textContent).not.toContain('$');
    expect(chip.textContent).toContain('≈7');
    expect(chip.textContent).toMatch(/\bcr\b/);
    expect(chip.title).toBeTruthy();
  });

  it('a managed (Pro/OpenRouter) model id renders credits, never the no-debit state', () => {
    render(<I18nProvider><CostChip costUsd={0.07} model="anthropic/claude-sonnet-5" testId="cost-chip" /></I18nProvider>);
    expect(screen.getByTestId('cost-chip')).toHaveTextContent('7 cr');
  });

  it('never warns on the no-debit subscription state, regardless of how large costUsd is internally', () => {
    render(<I18nProvider><CostChip costUsd={50} budgetCapUsd={10} model="claude-haiku-4-5" testId="cost-chip" /></I18nProvider>);
    expect(screen.getByTestId('cost-chip')).not.toHaveAttribute('data-cost-warning');
  });
});

describe('MissionNodeCard — cost chip presence no longer depends on zoomLevel (W-CARDS)', () => {
  // This fixture has no AgentsStoreProvider (see withActions), so
  // `fullMission`/`agentMetrics` — and therefore CostChip's own `costUsd`
  // — is always absent here regardless of zoomLevel (CostChip.test.tsx
  // covers the chip's own real-data rendering directly). What THIS test
  // protects: the OLD behavior gated the chip on `zoomLevel === 'full'`
  // (a second, independent reason to hide it at chip/compact) — that gate
  // is gone, so absence here must be IDENTICAL across every zoomLevel
  // (data-driven only), never additionally suppressed by a stale tier
  // check reappearing.
  it.each(['chip', 'compact', 'full'] as const)('cost chip absence at zoomLevel %s is data-driven only, never a zoomLevel gate', (zoomLevel) => {
    const data = makeMissionData({}, { id: 'm1' });
    render(withActions(<MissionNodeCard data={data} zoomLevel={zoomLevel} />));
    expect(screen.queryByTestId('mission-node-cost-chip-m1')).not.toBeInTheDocument();
  });
});

// fix/canvas-ux R4d (dogfood defect #3) — pure per-status coverage for
// nodes/MissionNode.tsx's `deriveLiveLine` (see that module's own doc
// comment). Uses a plain key-echoing `t` stub (not I18nProvider) so these
// assert the LOGIC — which key/value gets picked per liveness bucket —
// independent of any locale's translated copy (the MissionNodeCard-level
// test above already covers one real translated case end-to-end).
function fakeT(key: string, params?: Record<string, string | number>): string {
  return params ? `${key}:${JSON.stringify(params)}` : key;
}

describe('deriveLiveLine — honest per-status live-action text (fix/canvas-ux R4d defect #3)', () => {
  function line(overrides: Partial<Parameters<typeof deriveLiveLine>[0]> = {}) {
    return overrides;
  }

  it('running (not paused): the humanized live action, or the noLiveText fallback when there is none yet', () => {
    expect(deriveLiveLine(line({ liveAction: 'itération 3/∞…' }), 'running', fakeT)).toBe('itération 3/∞…');
    expect(deriveLiveLine(line(), 'running', fakeT)).toBe('cockpit.card.noLiveText');
  });

  it('paused: its own state line, never the (possibly stale) liveAction', () => {
    expect(deriveLiveLine(line({ liveAction: 'stale mid-run text' }), 'paused', fakeT)).toBe('agents.status.paused');
  });

  it('failed: statusReason when present, else a generic label — never the queued/no-live-text placeholder (regression: "en attente…")', () => {
    expect(deriveLiveLine(line({ statusReason: 'Build cassé', liveAction: 'en file…' }), 'failed', fakeT)).toBe('Build cassé');
    expect(deriveLiveLine(line({ liveAction: 'en file…' }), 'failed', fakeT)).toBe('agents.status.failed');
  });

  it('review: a verdict summary when a judgeVerdict exists, else "en revue" — never a stale "Running reviewer sub-agent…" leftover', () => {
    const passed: JudgeVerdict = { score: 90, passed: true, risk: 'low', reviewers: [], createdAt: '' };
    const rejected: JudgeVerdict = { score: 30, passed: false, risk: 'high', reviewers: [], createdAt: '' };
    const stale = 'Running reviewer sub-agent…';
    expect(deriveLiveLine(line({ judgeVerdict: passed, liveAction: stale }), 'review', fakeT)).toBe('canvas.node.verdictApproved');
    expect(deriveLiveLine(line({ judgeVerdict: rejected, liveAction: stale }), 'review', fakeT)).toBe('canvas.node.verdictRejected');
    expect(deriveLiveLine(line({ liveAction: stale }), 'review', fakeT)).toBe('agents.status.review');
  });

  it('review: appends the first real diffFiles basename as a cursor, never a fabricated path', () => {
    expect(deriveLiveLine(
      line({
        liveAction: 'Running reviewer sub-agent…',
        diffFiles: [{ filename: 'src/lib/auth.ts', added: 3, removed: 1 }],
      }),
      'review',
      fakeT,
    )).toBe('agents.status.review · auth.ts');
  });

  it('canvasLiveParts puts the review file on LiveActionLine, not the stale liveAction', () => {
    const parts = canvasLiveParts(
      line({
        liveAction: 'Running reviewer sub-agent…',
        diffFiles: [{ filename: 'src/lib/auth.ts', added: 3, removed: 1 }],
      }),
      'review',
      fakeT,
    );
    expect(parts).toEqual({ verb: 'agents.status.review', detail: 'auth.ts' });
  });

  it('merged/done: its own state line, never the stale last-run liveAction', () => {
    expect(deriveLiveLine(line({ liveAction: '▊ écrit PaymentSheet.tsx…' }), 'merged', fakeT)).toBe('agents.status.done');
  });

  it('queued: its own state line', () => {
    expect(deriveLiveLine(line({ liveAction: 'en file…' }), 'queued', fakeT)).toBe('agents.status.queued');
  });

  it('a real pendingQuestion always wins, regardless of liveness', () => {
    expect(deriveLiveLine(line({ pendingQuestion: 'ok ?', liveAction: 'anything' }), 'running', fakeT)).toBe('ok ?');
  });
});

describe('LoopNodeCard — countdown + toggle (spec §4.2)', () => {
  const nowMs = Date.parse('2026-07-14T10:00:00.000Z');

  function makeLoopConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
    return {
      cadence: '5m',
      stopCondition: { kind: 'manual' },
      enabled: true,
      iterationCount: 3,
      iterationMissionIds: [],
      ...overrides,
    };
  }

  function makeLoopData(overrides: Partial<LoopNodeData> = {}): LoopNodeData {
    return {
      mission: makeMission({ id: 'loop-1', title: 'Nightly QA sweep' }),
      projectId: 'p1',
      isActiveProject: true,
      loopConfig: makeLoopConfig(),
      recentIterations: [
        { id: 'it-1', status: 'done', iteration: 1 },
        { id: 'it-2', status: 'failed', iteration: 2 },
      ],
      ...overrides,
    };
  }

  it('renders a live countdown derived from loopConfig.nextRunAt - nowMs', () => {
    const data = makeLoopData({
      loopConfig: makeLoopConfig({ nextRunAt: new Date(nowMs + 65_000).toISOString() }),
    });
    render(<I18nProvider>
      <LoopNodeCard data={data} nowMs={nowMs} />
    </I18nProvider>);
    expect(screen.getByTestId('loop-node-countdown')).toHaveTextContent('1 min');
  });

  it('toggle switch calls onToggleLoop(missionId, !enabled)', () => {
    const onToggleLoop = vi.fn();
    const data = makeLoopData({ loopConfig: makeLoopConfig({ enabled: true }) });
    render(withActions(<LoopNodeCard data={data} nowMs={nowMs} />, { onToggleLoop }));
    fireEvent.click(screen.getByTestId('loop-node-toggle'));
    expect(onToggleLoop).toHaveBeenCalledWith('loop-1', false);
  });

  it('clicking an iteration chip calls onOpenIteration with the chip mission id', () => {
    const onOpenIteration = vi.fn();
    const data = makeLoopData();
    render(withActions(<LoopNodeCard data={data} nowMs={nowMs} />, { onOpenIteration }));
    fireEvent.click(screen.getByTestId('loop-node-iteration-it-2'));
    expect(onOpenIteration).toHaveBeenCalledWith('it-2');
  });

  it('« Passer la prochaine » (W5a) calls onSkipLoopNextRun(missionId) when enabled with a live next run', () => {
    const onSkipLoopNextRun = vi.fn();
    const data = makeLoopData({
      loopConfig: makeLoopConfig({ enabled: true, nextRunAt: new Date(nowMs + 65_000).toISOString() }),
    });
    render(withActions(<LoopNodeCard data={data} nowMs={nowMs} />, { onSkipLoopNextRun }));
    fireEvent.click(screen.getByTestId('loop-node-skip-next-run'));
    expect(onSkipLoopNextRun).toHaveBeenCalledWith('loop-1');
  });

  it('omits the skip-next-run button when the loop is disabled (nothing honest to skip)', () => {
    const data = makeLoopData({
      loopConfig: makeLoopConfig({ enabled: false, nextRunAt: undefined }),
    });
    render(<I18nProvider>
      <LoopNodeCard data={data} nowMs={nowMs} />
    </I18nProvider>);
    expect(screen.queryByTestId('loop-node-skip-next-run')).not.toBeInTheDocument();
  });

  // W-CARDS (founder, 2026-07-21) — the old dot glyph / title+cadence-only
  // compact / full three-tier zoom is retired: countdown, toggle and
  // iteration chips render at every zoomLevel now, exactly like
  // MissionNode.tsx.
  it.each(['chip', 'compact', 'full'] as const)('renders countdown + toggle + iteration chips at zoomLevel %s — never a dot or a stripped-down subset', (zoomLevel) => {
    const data = makeLoopData({
      loopConfig: makeLoopConfig({ nextRunAt: new Date(nowMs + 65_000).toISOString() }),
    });
    render(<I18nProvider>
      <LoopNodeCard data={data} nowMs={nowMs} zoomLevel={zoomLevel} />
    </I18nProvider>);
    expect(screen.getByTestId('loop-node-countdown')).toHaveTextContent('1 min');
    expect(screen.getByTestId('loop-node-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('loop-node-iteration-it-2')).toBeInTheDocument();
    expect(screen.queryByTestId(`loop-node-dot-${data.mission.id}`)).not.toBeInTheDocument();
  });

  // De-adaptation proof — no zoom subscription remains: the render is
  // identical whether `zoomLevel` is the old dot bucket or full.
  it('renders identically whether zoomLevel is "chip" or "full" — no zoom-driven branch remains', () => {
    const data = makeLoopData();
    const { container: chipContainer, unmount } = render(<I18nProvider>
      <LoopNodeCard data={data} nowMs={nowMs} zoomLevel="chip" />
    </I18nProvider>);
    const chipHtml = chipContainer.innerHTML;
    unmount();

    const { container: fullContainer } = render(<I18nProvider>
      <LoopNodeCard data={data} nowMs={nowMs} zoomLevel="full" />
    </I18nProvider>);
    expect(fullContainer.innerHTML).toBe(chipHtml);
  });
});

describe('ScheduleNodeCard — one constant card at every zoom (W-CARDS)', () => {
  function makeScheduleData(overrides: Partial<ScheduleNodeData> = {}): ScheduleNodeData {
    return {
      scheduleId: 'sched-1',
      agentName: 'Nightly QA agent',
      cron: '0 3 * * *',
      cronLabel: '3h00 chaque jour',
      enabled: true,
      nextRunMs: Date.parse('2026-07-14T10:01:05.000Z'),
      ...overrides,
    };
  }

  const nowMs = Date.parse('2026-07-14T10:00:00.000Z');

  // W-CARDS (founder, 2026-07-21) — the old dot glyph / agent-name+cron-only
  // compact / full three-tier zoom is retired: the countdown line renders
  // at every zoomLevel now, exactly like MissionNode.tsx.
  it.each(['chip', 'compact', 'full'] as const)('renders agent name + cron + countdown at zoomLevel %s — never a dot', (zoomLevel) => {
    const data = makeScheduleData();
    render(<I18nProvider>
      <ScheduleNodeCard data={data} nowMs={nowMs} zoomLevel={zoomLevel} />
    </I18nProvider>);
    expect(screen.getByTestId('schedule-node-agent')).toHaveTextContent('Nightly QA agent');
    expect(screen.getByTestId('schedule-node-cron-label')).toHaveTextContent('3h00 chaque jour');
    expect(screen.getByTestId('schedule-node-countdown')).toBeInTheDocument();
    expect(screen.queryByTestId(`schedule-node-dot-${data.scheduleId}`)).not.toBeInTheDocument();
  });

  // De-adaptation proof — no zoom subscription remains.
  it('renders identically whether zoomLevel is "chip" or "full" — no zoom-driven branch remains', () => {
    const data = makeScheduleData();
    const { container: chipContainer, unmount } = render(<I18nProvider>
      <ScheduleNodeCard data={data} nowMs={nowMs} zoomLevel="chip" />
    </I18nProvider>);
    const chipHtml = chipContainer.innerHTML;
    unmount();

    const { container: fullContainer } = render(<I18nProvider>
      <ScheduleNodeCard data={data} nowMs={nowMs} zoomLevel="full" />
    </I18nProvider>);
    expect(fullContainer.innerHTML).toBe(chipHtml);
  });
});

describe('NoteNodeCard — one constant, always-editable card at every zoom (W-CARDS)', () => {
  function makeNoteData(overrides: Partial<NoteData> = {}): NoteData {
    return { id: 'note-1', text: 'Remember to check the staging DB.', ...overrides };
  }

  // W-CARDS (founder, 2026-07-21) — the old dot glyph / read-only
  // single-line-preview compact / full editable three-tier zoom is
  // retired: the full editable card (with its remove button) renders at
  // every zoomLevel now, exactly like MissionNode.tsx.
  it.each(['chip', 'compact', 'full'] as const)('renders the full editable card at zoomLevel %s — never a dot or a read-only preview', (zoomLevel) => {
    const data = makeNoteData();
    render(withActions(<NoteNodeCard data={data} zoomLevel={zoomLevel} />));
    expect(screen.getByTestId('note-node-text-note-1')).toHaveTextContent('Remember to check the staging DB.');
    expect(screen.getByTestId('note-node-remove-note-1')).toBeInTheDocument();
    expect(screen.queryByTestId(`note-node-dot-${data.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`note-node-compact-${data.id}`)).not.toBeInTheDocument();
  });

  // De-adaptation proof — no zoom subscription remains.
  it('renders identically whether zoomLevel is "chip" or "full" — no zoom-driven branch remains', () => {
    const data = makeNoteData();
    const { container: chipContainer, unmount } = render(withActions(<NoteNodeCard data={data} zoomLevel="chip" />));
    const chipHtml = chipContainer.innerHTML;
    unmount();

    const { container: fullContainer } = render(withActions(<NoteNodeCard data={data} zoomLevel="full" />));
    expect(fullContainer.innerHTML).toBe(chipHtml);
  });
});

describe('RouterNodeCard — one constant card at every zoom (W-CARDS)', () => {
  function makeRouterData(): RouterNodeData {
    return {
      routerId: 'router-1',
      branches: [
        { id: 'b1', label: 'Branche A', condition: { kind: 'outcome', value: 'success' } },
        { id: 'b2', label: 'Branche B', condition: { kind: 'default' } },
      ],
    };
  }

  // W-CARDS (founder, 2026-07-21) — the old dot glyph / diamond-only
  // compact / diamond+branch-list full three-tier zoom is retired: the
  // branch-list panel renders at every zoomLevel now, exactly like
  // MissionNode.tsx.
  it.each(['chip', 'compact', 'full'] as const)('renders the diamond + branch list at zoomLevel %s — never a dot', (zoomLevel) => {
    const data = makeRouterData();
    render(withActions(<RouterNodeCard data={data} zoomLevel={zoomLevel} />));
    expect(screen.getByTestId('router-node-branch-label-b1')).toHaveTextContent('Branche A');
    expect(screen.getByTestId('router-node-branch-label-b2')).toHaveTextContent('Branche B');
    expect(screen.queryByTestId(`router-node-dot-${data.routerId}`)).not.toBeInTheDocument();
  });

  // De-adaptation proof — no zoom subscription remains.
  it('renders identically whether zoomLevel is "chip" or "full" — no zoom-driven branch remains', () => {
    const data = makeRouterData();
    const { container: chipContainer, unmount } = render(withActions(<RouterNodeCard data={data} zoomLevel="chip" />));
    const chipHtml = chipContainer.innerHTML;
    unmount();

    const { container: fullContainer } = render(withActions(<RouterNodeCard data={data} zoomLevel="full" />));
    expect(fullContainer.innerHTML).toBe(chipHtml);
  });
});

describe('DraftNodeCard — launch callback (spec §4.2)', () => {
  function makeDraft(overrides: Partial<DraftSpec> = {}): DraftSpec {
    return {
      id: 'draft-1',
      title: 'New tester agent',
      task: 'Run the full suite twice against the staging branch.',
      createdBy: 'user',
      ...overrides,
    };
  }

  it('"Lancer" calls onLaunchDraft(draftId)', () => {
    const onLaunchDraft = vi.fn();
    const data = makeDraft();
    render(withActions(<DraftNodeCard data={data} />, { onLaunchDraft }));
    fireEvent.click(screen.getByTestId('draft-node-launch-draft-1'));
    expect(onLaunchDraft).toHaveBeenCalledWith('draft-1');
  });

  it('edit affordance calls onEditDraft(draftId)', () => {
    const onEditDraft = vi.fn();
    const data = makeDraft();
    render(withActions(<DraftNodeCard data={data} />, { onEditDraft }));
    fireEvent.click(screen.getByTestId('draft-node-edit-draft-1'));
    expect(onEditDraft).toHaveBeenCalledWith('draft-1');
  });

  // W-CARDS (founder, 2026-07-21) — the old compact-zoom icon-button /
  // dot-zoom passive-glyph split is retired: DraftNodeCard now renders its
  // ONE full body (launch + edit buttons) at every zoomLevel, exactly like
  // MissionNode.tsx. Supersedes fix/canvas-ux R6a BLOQUANT #1's old
  // per-bucket coverage (the underlying "launch must always be reachable"
  // guarantee still holds — trivially, since there is only one body now).
  it.each(['chip', 'compact', 'full'] as const)('renders the one full body (with a clickable "Lancer" button) at zoomLevel %s — never a passive dot', (zoomLevel) => {
    const onLaunchDraft = vi.fn();
    const data = makeDraft();
    render(withActions(<DraftNodeCard data={data} zoomLevel={zoomLevel} />, { onLaunchDraft }));
    const launchBtn = screen.getByTestId('draft-node-launch-draft-1');
    fireEvent.click(launchBtn);
    expect(onLaunchDraft).toHaveBeenCalledWith('draft-1');
    expect(screen.queryByTestId('draft-node-dot-draft-1')).not.toBeInTheDocument();
  });

  it('exactly one launch element exists regardless of zoomLevel — never zero, never two', () => {
    const data = makeDraft();
    const { rerender } = render(withActions(<DraftNodeCard data={data} zoomLevel="compact" />));
    expect(screen.getAllByTestId('draft-node-launch-draft-1')).toHaveLength(1);

    rerender(withActions(<DraftNodeCard data={data} zoomLevel="full" />));
    expect(screen.getAllByTestId('draft-node-launch-draft-1')).toHaveLength(1);

    rerender(withActions(<DraftNodeCard data={data} zoomLevel="chip" />));
    expect(screen.getAllByTestId('draft-node-launch-draft-1')).toHaveLength(1);
  });

  // W-CARDS de-adaptation proof — mocking `zoomLevel` directly (the prop is
  // still accepted for call-site compatibility, see DraftNode.tsx's own
  // header) confirms the render is byte-for-byte identical at the two ends
  // of the old bucket range: no zoom subscription drives this card anymore.
  it('renders identically whether zoomLevel is "chip" (old dot bucket) or "full" — no zoom-driven branch remains', () => {
    const data = makeDraft();
    const { container: chipContainer, unmount } = render(withActions(<DraftNodeCard data={data} zoomLevel="chip" />));
    const chipHtml = chipContainer.innerHTML;
    unmount();

    const { container: fullContainer } = render(withActions(<DraftNodeCard data={data} zoomLevel="full" />));
    expect(fullContainer.innerHTML).toBe(chipHtml);
  });
});

// Chantier 3 (plan-first canvas) — a draft carrying `proposedPlanId` is one
// step of a still-pending manager plan proposal, awaiting validation at the
// PLAN level (GraphProposalCard), never per-node — see canvasTypes.ts's
// `DraftSpec.proposedPlanId` doc comment.
describe('DraftNodeCard — proposed plan-step style (chantier 3)', () => {
  function makeProposedDraft(overrides: Partial<DraftSpec> = {}): DraftSpec {
    return {
      id: 'draft-1',
      title: 'New tester agent',
      task: 'Run the full suite twice against the staging branch.',
      createdBy: 'manager',
      proposedPlanId: 'plan-1',
      ...overrides,
    };
  }

  it('shows the "Proposé" badge instead of the normal "waiting" badge', () => {
    render(withActions(<DraftNodeCard data={makeProposedDraft()} />));
    expect(screen.getByTestId('canvas-proposed-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('draft-node-waiting-badge')).not.toBeInTheDocument();
  });

  it('has no launch/edit affordance — the decision is made at the plan level, not per-node', () => {
    render(withActions(<DraftNodeCard data={makeProposedDraft()} />));
    expect(screen.queryByTestId('draft-node-launch-draft-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('draft-node-edit-draft-1')).not.toBeInTheDocument();
  });

  it('a normal (non-proposed) draft keeps the ordinary "waiting" badge and launch/edit buttons', () => {
    render(withActions(<DraftNodeCard data={makeProposedDraft({ proposedPlanId: undefined })} />));
    expect(screen.queryByTestId('canvas-proposed-badge')).not.toBeInTheDocument();
    expect(screen.getByTestId('draft-node-waiting-badge')).toBeInTheDocument();
    expect(screen.getByTestId('draft-node-launch-draft-1')).toBeInTheDocument();
  });
});

// R1b defect #7 (superseded by W-CARDS, 2026-07-21) — IterationNode used to
// be the ONE node kind that never adopted the old three-tier semantic zoom,
// so a fix at the time added a `zoom === 'chip'` dot branch matching every
// other kind's. The founder's W-CARDS rule now retires that whole
// convention: every node renders its ONE full layout at every zoom, scaled
// naturally by React Flow's own viewport transform, like MissionNode.tsx.
describe('IterationNodeCard — one constant card at every zoom (W-CARDS)', () => {
  function makeIterationData(overrides: Partial<IterationNodeData> = {}): IterationNodeData {
    return {
      missionId: 'it-1',
      title: 'Iteration payload',
      status: 'done',
      iteration: 2,
      loopMissionId: 'loop-1',
      ...overrides,
    };
  }

  it.each(['chip', 'compact', 'full'] as const)('renders the full title+number pill at zoomLevel %s — never a status-colored dot', (zoomLevel) => {
    const data = makeIterationData();
    render(<IterationNodeCard data={data} zoomLevel={zoomLevel} />);
    expect(screen.getByTestId('iteration-node-it-1')).toBeInTheDocument();
    expect(screen.getByTestId('iteration-node-title')).toHaveTextContent('Iteration payload');
    expect(screen.getByTestId('iteration-node-number')).toHaveTextContent('#2');
    expect(screen.queryByTestId('iteration-node-dot-it-1')).not.toBeInTheDocument();
  });

  // W-CARDS de-adaptation proof — no zoom subscription remains: the render
  // is identical whether `zoomLevel` is the old dot bucket or full.
  it('renders identically whether zoomLevel is "chip" or "full" — no zoom-driven branch remains', () => {
    const data = makeIterationData();
    const { container: chipContainer, unmount } = render(<IterationNodeCard data={data} zoomLevel="chip" />);
    const chipHtml = chipContainer.innerHTML;
    unmount();

    const { container: fullContainer } = render(<IterationNodeCard data={data} zoomLevel="full" />);
    expect(fullContainer.innerHTML).toBe(chipHtml);
  });
});

describe('ProjectGroupNodeCard — empty-zone ghost hint + Transverse label (spec §5/§4.1, W5a #4)', () => {
  // Ghost-hint/zone-name text is resolved via t() — pin the locale so these
  // French-text assertions are deterministic regardless of what a previous
  // test file left in localStorage (see LazyManagerRail.signals.test.tsx's
  // identical note). Scoped to this describe block only — every other test
  // in this file asserts on testids/structure, never translated text.
  beforeEach(() => localStorage.setItem('lazy.locale', 'fr'));
  afterEach(() => localStorage.removeItem('lazy.locale'));

  function makeProjectData(overrides: Partial<ProjectNodeData> = {}): ProjectNodeData {
    return {
      projectId: 'p1',
      root: '/repo/p1',
      name: 'demo-shop',
      color: 'hsl(220 65% 62%)',
      collapsed: false,
      isActive: true,
      counts: { running: 0, urgent: 0, review: 0, failed: 0, done: 0, total: 0 },
      hasChildren: true,
      ...overrides,
    };
  }

  it('renders the ghost hint centered in the zone body when hasChildren is false', () => {
    const data = makeProjectData({ hasChildren: false });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.getByTestId('project-node-empty-hint')).toHaveTextContent('Dépose un agent ici');
  });

  it('omits the ghost hint (never a fake node) once the zone has real children', () => {
    const data = makeProjectData({ hasChildren: true });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.queryByTestId('project-node-empty-hint')).not.toBeInTheDocument();
  });

  it('translates the synthetic Transverse zone name instead of showing the raw reconciler literal', () => {
    const data = makeProjectData({ projectId: TRANSVERSE_PROJECT_ID, name: 'Transverse' });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.getByTestId('project-node-name')).toHaveTextContent('Transverse');
  });

  it('never translates a REAL project name (only the synthetic Transverse zone gets t())', () => {
    const data = makeProjectData({ projectId: 'p1', name: 'demo-shop' });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.getByTestId('project-node-name')).toHaveTextContent('demo-shop');
  });

  // fix/canvas-title-band-zoom — the header row's own flow-space height
  // must read the live LOD-compensated CSS var (CanvasLodBroadcaster.tsx's
  // --canvas-lod-title-band-height), falling back to the plain resting
  // ZONE_HEADER_HEIGHT outside a live viewport (this fixture render), so the
  // row can grow at deep dezoom instead of clipping its own LOD-scaled
  // title (chrome/lod.ts's titleBandHeight — see canvasLod.test.ts for the
  // pure-function math coverage).
  it("the header row's height reads --canvas-lod-title-band-height with a ZONE_HEADER_HEIGHT fallback", () => {
    const data = makeProjectData({ projectId: 'p1', name: 'demo-shop' });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    const header = screen.getByTestId('project-node-name').closest('.canvas-zone-header') as HTMLElement;
    expect(header.style.height).toBe(`var(--canvas-lod-title-band-height, ${ZONE_HEADER_HEIGHT}px)`);
  });

  // fix/canvas-title-float — founder's 4th report of the same overlap bug,
  // verbatim: "pourquoi je vois des agents sur le titre de la zone projet,
  // je peux même pas lire le nom" + his exact fix request: "mets le nom et
  // la zone du titre juste AU-DESSUS de la zone". The header row used to be
  // an IN-FLOW flex child at the top of the zone box (pushing mission cards
  // down to make room) — it is now a FLOATING label positioned entirely
  // OUTSIDE the zone's own box, anchored above its top edge, so nothing
  // rendered inside the box can ever occupy the same pixels as the title.
  describe('the floating zone title (fix/canvas-title-float)', () => {
    it('positions the header row OUTSIDE the frame, anchored above its top edge by ZONE_TITLE_GAP_ABOVE', () => {
      const data = makeProjectData({ projectId: 'p1', name: 'demo-shop' });
      render(<I18nProvider>
        <ProjectGroupNodeCard data={data} />
      </I18nProvider>);
      const header = screen.getByTestId('project-node-name').closest('.canvas-zone-header') as HTMLElement;
      expect(header.style.position).toBe('absolute');
      expect(header.style.left).toBe('0px');
      expect(header.style.bottom).toBe(`calc(100% + ${ZONE_TITLE_GAP_ABOVE}px)`);
    });

    // fix/canvas-title-full-name (founder, angry, rightly: "je veux le
    // titre ENTIER tout le temps") — the ORIGINAL behavior this describe
    // block used to lock in ("clamps the floating row's own max-width to
    // the zone's live flow-space width") was a real bug: at low zoom, a
    // narrow zone's width divided by the (large) LOD scale factor collapsed
    // this clamp to a few flow px, forcing the name span's OWN
    // text-overflow:ellipsis to truncate it down to a single letter
    // ("Transverse" -> "T").
    //
    // fix/canvas-zone-title-overlap round 2 — REINSTATED by explicit product
    // direction (David's measured repro, real packaged app, 12% zoom / 8
    // zones: two neighbouring headers still overprinted each other even
    // after the character-cap fix — a character count alone doesn't bound
    // the BADGES, whose own on-screen footprint still grows with the same
    // lodScale compensation past what that heuristic accounted for). His
    // own diagnosis: "the invariant to enforce is geometric, not
    // typographic — a zone's header must never paint outside its own
    // zone's box, at ANY zoom." Reinstated on the OUTER (unscaled) header
    // div only — never on the INNER, lodScale-scaled identity-cluster span
    // (still `width: 'max-content'`, fully unconstrained, verified by the
    // sibling describe block below) — which is the structural difference
    // from the old "T" bug: nothing here divides an available width by the
    // scale factor, so the name's own layout budget is never touched; only
    // this outer, untransformed box clips whatever spills past the zone's
    // real edge.
    it("clamps the header row's own maxWidth to the zone's real live flow-space width (with overflow: hidden) whenever `width` is known — the geometric containment guarantee, true at every zoom because both header and zone share the identical React Flow viewport transform", () => {
      const data = makeProjectData({ projectId: 'p1', name: 'a-very-long-project-name-indeed' });
      for (const width of [40, 220, 320, 900]) {
        const { unmount } = render(<I18nProvider>
          <ProjectGroupNodeCard data={data} width={width} />
        </I18nProvider>);
        const header = screen.getByTestId('project-node-name').closest('.canvas-zone-header') as HTMLElement;
        expect(header.style.maxWidth).toBe(`${width}px`);
        expect(header.style.overflow).toBe('hidden');
        unmount();
      }
    });

    it('falls back to no maxWidth clamp when `width` is unknown (a fixture render with no live zone to bound against) — never worse than the pre-fix behavior', () => {
      const data = makeProjectData({ projectId: 'p1', name: 'a-very-long-project-name-indeed' });
      render(<I18nProvider>
        <ProjectGroupNodeCard data={data} width={undefined} />
      </I18nProvider>);
      const header = screen.getByTestId('project-node-name').closest('.canvas-zone-header') as HTMLElement;
      expect(header.style.maxWidth).toBe('');
    });

    // fix/canvas-zone-title-overlap — REVERSED by explicit product direction
    // (David's measured repro, 2026-08-14: several open zones at low zoom,
    // one zone's title/badges painting directly over its neighbour's — the
    // SAME class of bug this describe block's "never truncate" rule was
    // reintroducing). The new hard constraint is "no adaptive hiding at
    // zoom" (never a CSS clamp that collapses with the live LOD scale, the
    // ACTUAL cause of the old "Transverse" -> "T" bug this describe block
    // still guards against just above) — satisfied here by a fixed
    // CHARACTER cap (ZONE_TITLE_RESERVED_NAME_CHARS) applied BEFORE the
    // scale transform, so the reserved region's real screen-space size is
    // constant across every zoom, never a function of it.
    it('truncates a long project name to ZONE_TITLE_RESERVED_NAME_CHARS with a visible ellipsis, and always carries the full name as its title tooltip', () => {
      // A real project name already cited elsewhere in this codebase
      // (ZoneAggregateSummary.tsx's own doc comment) as a genuine example —
      // long enough to be a meaningful stress case, not a contrived one.
      const longName = 'lazy-e2e-soak-scratch-1784236548334';
      const data = makeProjectData({ projectId: 'p1', name: longName });
      render(<I18nProvider>
        <ProjectGroupNodeCard data={data} width={40} />
      </I18nProvider>);
      const nameEl = screen.getByTestId('project-node-name');
      expect(nameEl.textContent).toBe(truncateMiddle(longName, ZONE_TITLE_RESERVED_NAME_CHARS));
      expect(nameEl.textContent).toHaveLength(ZONE_TITLE_RESERVED_NAME_CHARS);
      expect(nameEl).toHaveTextContent('…');
      expect(nameEl.getAttribute('title')).toBe(longName);
      expect(nameEl.style.whiteSpace).toBe('nowrap');
      // fix/canvas-zone-name-flex-ellipsis — the name span is now the ONLY
      // shrink-enabled item in the identity cluster (flexShrink: 1 +
      // min-width: 0): when the header's real width runs out, THIS span
      // absorbs the shortage and its own text-overflow:ellipsis marks the
      // cut. It used to be flexShrink: 0 with a px-ESTIMATED maxWidth —
      // that estimate's floor overrode the honest budget on narrow zones
      // and the header's overflow:hidden did a SILENT hard cut (measured
      // live: "lazy-backoffice" on screen as "lazy-backo", no ellipsis).
      expect(nameEl.style.flexShrink).toBe('1');
      expect(nameEl.style.minWidth).toBe('0');
    });

    it('never truncates (and never sets a title tooltip on) a name that already fits within the reserved character cap', () => {
      const data = makeProjectData({ projectId: 'p1', name: 'demo-shop' });
      render(<I18nProvider>
        <ProjectGroupNodeCard data={data} />
      </I18nProvider>);
      const nameEl = screen.getByTestId('project-node-name');
      expect(nameEl.textContent).toBe('demo-shop');
      expect(nameEl).not.toHaveTextContent('…');
      expect(nameEl.getAttribute('title')).toBeNull();
    });

    // fix/canvas-zone-title-clip — STATED EXPECTATION (required before
    // implementing, per David's own instruction: "state what you expect
    // the header to read for a zone named uc-smoke-2026-08-12 at minimum
    // zoom, and make the test assert that"): given a zone widened to
    // `zoneMinWidthForTitle`'s own guarantee (geometry.ts, sized at
    // ZONE_SPACING_PRACTICAL_ZOOM — the "zoom people actually use" tier —
    // reconciler.test.ts's own sibling suite proves `reconcile()` actually
    // produces a zone this wide), the header renders the FULL name, no
    // ellipsis. This is the exact real project name from David's own repro.
    it('renders the FULL "uc-smoke-2026-08-12" name with no ellipsis, once the zone is widened to its own zoneMinWidthForTitle', () => {
      const longName = 'uc-smoke-2026-08-12';
      expect(longName.length).toBeLessThan(ZONE_TITLE_RESERVED_NAME_CHARS); // 19 < 28 — under the cap
      const data = makeProjectData({ projectId: 'p1', name: longName });
      render(<I18nProvider>
        <ProjectGroupNodeCard data={data} width={zoneMinWidthForTitle(longName)} />
      </I18nProvider>);
      const nameEl = screen.getByTestId('project-node-name');
      expect(nameEl.textContent).toBe(longName);
      expect(nameEl).not.toHaveTextContent('…');
      expect(nameEl.getAttribute('title')).toBeNull();
    });

    // fix/canvas-zone-title-clip — the graceful-degradation half, for the
    // documented residual case BELOW ZONE_SPACING_PRACTICAL_ZOOM (or any
    // zone narrower than zoneMinWidthForTitle's own guarantee for another
    // reason): the name span carries its own real CSS ellipsis machinery
    // (`overflow: hidden` + `textOverflow: ellipsis`). fix/canvas-zone-name-
    // flex-ellipsis — the OLD wiring here (a px-ESTIMATED
    // `maxWidth: max(120px FLOOR, calc(width/lodScale - CHROME))` reactive
    // to the live --canvas-lod-zone-label-scale var) is RETIRED: measured
    // live in the real app, the floor overrode the honest budget on narrow
    // zones so the span painted past the header box and the header's
    // overflow:hidden did a SILENT hard cut ("lazy-backoffice" on screen as
    // "lazy-backo", no ellipsis) — and the chrome estimate under-counted
    // real leading chrome ≈ 2×. The span now shrink-fits against the
    // header's REAL width via flexbox (min-width: 0 + flex-shrink: 1 — it
    // is the ONLY shrink-enabled item in its row), so the cut lands exactly
    // at the header boundary and is ALWAYS announced by the span's own
    // "…". jsdom performs no real layout/paint, so this can only assert
    // the MECHANISM is wired (the DOM text content itself is unaffected by
    // CSS overflow, by design — the same reason the "never truncates" tests
    // above still pass unchanged); a real-browser/live-app check is what
    // actually confirms the visual result.
    it("gives the name span its own flex-driven ellipsis machinery (min-width:0 + flex-shrink, no px estimates) whenever a zone width is known", () => {
      const data = makeProjectData({ projectId: 'p1', name: 'uc-smoke-2026-08-12' });
      render(<I18nProvider>
        <ProjectGroupNodeCard data={data} width={200} />
      </I18nProvider>);
      const nameEl = screen.getByTestId('project-node-name');
      expect(nameEl.style.overflow).toBe('hidden');
      expect(nameEl.style.textOverflow).toBe('ellipsis');
      expect(nameEl.style.minWidth).toBe('0');
      expect(nameEl.style.flexShrink).toBe('1');
      expect(nameEl.style.maxWidth).toBe('');
      // The DOM text content itself is NEVER JS-truncated by this
      // mechanism (only truncateMiddle's own fixed reserved-chars cap can do
      // that) — the ellipsis is purely a visual/CSS-level truncation,
      // exactly the "text stays in the DOM, CSS handles overflow visually"
      // convention this file's own MissionNodeCard title test (top of this
      // file) already documents for the identical class of concern.
      expect(nameEl.textContent).toBe('uc-smoke-2026-08-12');
    });

    // fix/canvas-zone-name-flex-ellipsis — the name span carries NO maxWidth
    // at all any more (estimate-free flex shrinking replaced it), so this is
    // now true at EVERY width value; kept as a regression guard against the
    // old px-ESTIMATED clamp ever coming back.
    it('leaves the name span with no maxWidth clamp at any `width` value — estimates retired in favour of flex shrinking', () => {
      const data = makeProjectData({ projectId: 'p1', name: 'uc-smoke-2026-08-12' });
      for (const width of [undefined, 40, 200]) {
        const { unmount } = render(<I18nProvider>
          <ProjectGroupNodeCard data={data} width={width} />
        </I18nProvider>);
        const nameEl = screen.getByTestId('project-node-name');
        expect(nameEl.style.maxWidth).toBe('');
        unmount();
      }
    });

    it('the identity-cluster span wrapping the name is also `width: max-content` with no max-width clamp, at any `width` value', () => {
      const data = makeProjectData({ projectId: 'p1', name: 'demo-shop' });
      for (const width of [undefined, 40, 320]) {
        const { unmount } = render(<I18nProvider>
          <ProjectGroupNodeCard data={data} width={width} />
        </I18nProvider>);
        const identitySpan = screen.getByTestId('project-node-name').parentElement as HTMLElement;
        expect(identitySpan.style.maxWidth).toBe('');
        expect(identitySpan.style.width).toBe('max-content');
        unmount();
      }
    });

    // scratch/_canvas-label-design.md §3.1 — the running-count chip lives in
    // `ZoneHeaderBand` now (a sibling AFTER the floating plaque, INSIDE the
    // frame — not inside the plaque's own reserved header region any more),
    // so it no longer competes with the name for the plaque's budget. DOM
    // order is still name-then-chip (the band renders after the plaque).
    it('renders the running-count chip AFTER the (possibly truncated) name in DOM order — badges never precede the name', () => {
      const longName = 'a-very-long-project-name-indeed';
      const data = makeProjectData({
        projectId: 'p1',
        name: longName,
        counts: { running: 2, urgent: 0, review: 0, failed: 0, done: 0, total: 2 },
      });
      render(<I18nProvider>
        <ProjectGroupNodeCard data={data} width={40} />
      </I18nProvider>);
      const nameEl = screen.getByTestId('project-node-name');
      const chip = screen.getByTestId('project-node-running-count');
      expect(nameEl.textContent).toBe(truncateMiddle(longName, ZONE_TITLE_RESERVED_NAME_CHARS));
      expect(nameEl.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('never shares the frame\'s top-corner rounding any more (no longer flush against the box) — has its own uniform, self-contained chip chrome instead', () => {
      const data = makeProjectData({ projectId: 'p1', name: 'demo-shop' });
      render(<I18nProvider>
        <ProjectGroupNodeCard data={data} />
      </I18nProvider>);
      const header = screen.getByTestId('project-node-name').closest('.canvas-zone-header') as HTMLElement;
      // Old chrome: only the TOP two corners were rounded (flush against the
      // frame's own top edge) and only the BOTTOM edge carried a border (a
      // divider from the content below). Neither is set independently any
      // more — replaced by one uniform `borderRadius`/`border` shorthand
      // (all 4 corners/edges alike), since this is now a self-contained
      // floating chip with nothing below it to divide from.
      expect(header.style.borderRadius).toBe('10px');
      expect(header.style.borderTop).toBe(header.style.borderBottom);
      expect(header.style.borderLeft).toBe(header.style.borderBottom);
    });

    it('still toggles collapse on click — floating the row never detaches its existing click handler', () => {
      const data = makeProjectData({ projectId: 'p1' });
      const calls: Array<[string, boolean]> = [];
      render(
        withActions(<ProjectGroupNodeCard data={data} />, {
          onToggleCollapseProject: (projectId, collapse) => calls.push([projectId, collapse]),
        }),
      );
      const header = screen.getByTestId('project-node-name').closest('.canvas-zone-header') as HTMLElement;
      fireEvent.click(header);
      expect(calls).toEqual([['p1', true]]);
    });
  });

  // ── W9 — zone-header « Voir le rapport » link ─────────────────────────

  it('the report icon-button emits report:open({ projectId }) for a real project, without collapsing the zone', () => {
    const data = makeProjectData({ projectId: 'p1' });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);

    const events: Array<{ projectId?: string }> = [];
    const unsub = on('report:open', (payload) => events.push(payload));
    fireEvent.click(screen.getByTestId('project-node-open-report'));
    unsub();

    expect(events).toEqual([{ projectId: 'p1' }]);
    // Clicking the report button must not also toggle collapse (the header
    // row's own onClick) — the chevron still shows the EXPANDED glyph.
    expect(screen.getByTestId('project-node-chevron')).toHaveTextContent('▼');
  });

  it('omits the report icon-button on the synthetic Transverse zone (no real project, no real report)', () => {
    const data = makeProjectData({ projectId: TRANSVERSE_PROJECT_ID, name: 'Transverse' });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.queryByTestId('project-node-open-report')).not.toBeInTheDocument();
  });

  it('omits the report icon-button on the collapsed chip (dot zoom) — not rendered at all, matching "Not at dot zoom"', () => {
    const data = makeProjectData({ projectId: 'p1', collapsed: true });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.getByTestId('project-node-p1')).toHaveAttribute('data-collapsed', 'true');
    expect(screen.queryByTestId('project-node-open-report')).not.toBeInTheDocument();
  });

  // fix/canvas-title-full-name — the COLLAPSED pill carried the exact same
  // `headerClampMaxWidth` bug as the expanded floating caption (same clamp,
  // same low-zoom collapse-to-a-sliver failure mode) — fixed identically:
  // no clamp, `width: max-content`, name span never shrinks/ellipsizes.
  it('never truncates the project name on the collapsed pill either, at any `width`', () => {
    const longName = 'lazy-e2e-soak-scratch-1784236548334';
    const data = makeProjectData({ projectId: 'p1', name: longName, collapsed: true });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} width={40} />
    </I18nProvider>);
    const statusRing = screen.getByTestId('project-node-status-ring');
    const nameEl = statusRing.nextElementSibling as HTMLElement;
    expect(nameEl.textContent).toBe(longName);
    expect(nameEl.style.textOverflow).not.toBe('ellipsis');
    expect(nameEl.style.overflow).not.toBe('hidden');
    expect((statusRing.parentElement as HTMLElement).style.maxWidth).toBe('');
    expect((statusRing.parentElement as HTMLElement).style.width).toBe('max-content');
  });

  // W6b geometry fix wave (spec CRITICAL 4) — lane-mode guides.
  it('renders the 5 PLAN/CODE/TEST/REVUE/MERGE lane guide headers when laneMode is on and the zone has children', () => {
    const data = makeProjectData({ hasChildren: true, laneMode: true });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.getByTestId('project-lane-guides')).toBeInTheDocument();
    for (const stage of ['plan', 'code', 'test', 'review', 'merged']) {
      expect(screen.getByTestId(`lane-header-${stage}`)).toBeInTheDocument();
    }
  });

  it('omits the lane guides when laneMode is off', () => {
    const data = makeProjectData({ hasChildren: true, laneMode: false });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.queryByTestId('project-lane-guides')).not.toBeInTheDocument();
  });

  it('omits the lane guides on an empty zone (the ghost hint owns that space instead)', () => {
    const data = makeProjectData({ hasChildren: false, laneMode: true });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.queryByTestId('project-lane-guides')).not.toBeInTheDocument();
  });

  // ── W-UX3 core deliverable 2 — zone work signal ─────────────────────────

  it('shows the animated equalizer next to the running-count chip while running > 0, and the breathing border class', () => {
    const data = makeProjectData({ counts: { running: 2, urgent: 0, review: 0, failed: 0, done: 0, total: 4 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.getByTestId('project-node-equalizer')).toBeInTheDocument();
    expect(screen.getByTestId('project-node-p1')).toHaveClass('canvas-zone-active-breathe');
  });

  it('omits the equalizer and the breathing class when nothing is running (calm zone stays calm)', () => {
    const data = makeProjectData({ counts: { running: 0, urgent: 0, review: 1, failed: 0, done: 0, total: 4 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.queryByTestId('project-node-equalizer')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-node-p1')).not.toHaveClass('canvas-zone-active-breathe');
  });

  // ── Attention-hierarchy wave 1 — "needs you" zone-header badge ──────────
  // (WAITING FOR HIM ranked above RUNNING — see NeedsYouBadge's own doc
  // comment in ProjectGroupNode.tsx for the full ranking rationale.)

  it('shows the "needs you" badge (review + failed) when a zone has actionable work, and it precedes the running-count chip in DOM order', () => {
    const data = makeProjectData({ counts: { running: 1, urgent: 0, review: 2, failed: 1, done: 0, total: 4 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    const badge = screen.getByTestId('project-node-needs-you-badge');
    expect(badge).toHaveTextContent('3'); // 2 review + 1 failed
    const runningChip = screen.getByTestId('project-node-running-count');
    // DOM order encodes visual priority: the needs-you badge must come
    // BEFORE the running-count chip (compareDocumentPosition bit 4 =
    // DOCUMENT_POSITION_FOLLOWING, i.e. runningChip follows badge).
    // eslint-disable-next-line no-bitwise
    expect(badge.compareDocumentPosition(runningChip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('omits the "needs you" badge when nothing is review/failed (a purely running or idle zone never shows a false alarm)', () => {
    const data = makeProjectData({ counts: { running: 2, urgent: 0, review: 0, failed: 0, done: 0, total: 2 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.queryByTestId('project-node-needs-you-badge')).not.toBeInTheDocument();
  });

  it('shows the "needs you" badge on a COLLAPSED zone too — this signal is never hidden, at any zoom or collapse state', () => {
    const data = makeProjectData({ collapsed: true, counts: { running: 0, urgent: 0, review: 1, failed: 0, done: 0, total: 1 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.getByTestId('project-node-needs-you-badge')).toHaveTextContent('1');
  });

  // ── W-UX3 three-tier fleet view — aggregate summary chip ────────────────

  // W-CARDS (product owner, 2026-07-18) — the aggregate summary used to
  // REPLACE the normal header/body (relying on canvas.css to hide every
  // child node underneath), which hid mission cards while zoomed out. It
  // now renders ADDITIVELY as header info; the normal header/body always
  // stays mounted too, so real children never disappear.
  it('aggregate tier: renders the summary chip (name + per-status counts) ADDITIVELY, alongside the normal header/body', () => {
    const data = makeProjectData({ counts: { running: 4, urgent: 1, review: 1, failed: 2, done: 0, total: 8 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} aggregate />
    </I18nProvider>);
    expect(screen.getByTestId('zone-aggregate-summary')).toHaveTextContent('demo-shop');
    expect(screen.getByTestId('zone-agg-running')).toHaveTextContent('4 en cours');
    expect(screen.getByTestId('zone-agg-failed')).toHaveTextContent('2 échec(s)');
    expect(screen.getByTestId('zone-agg-review')).toHaveTextContent('1 en revue');
    expect(screen.getByTestId('zone-agg-urgent')).toHaveTextContent('1');
    // Equalizer travels into the chip AND the normal header both, while
    // work runs (both render now — additive, not either/or).
    expect(screen.getAllByTestId('project-node-equalizer').length).toBe(2);
    // The normal header identity cluster ALSO renders — never replaced —
    // so this zone's real children keep their own visible chrome underneath.
    expect(screen.getByTestId('project-node-name')).toBeInTheDocument();
    expect(screen.getByTestId('project-node-open-report')).toBeInTheDocument();
  });

  // A zone with ONLY done missions (no running/failed/review) is idle by
  // design (nothing currently happening) — it shows the unified "0 actifs"
  // idle line, not a per-status "done" row (that row only appears for a
  // zone that ALSO has live work, tested here via a running mission
  // alongside the done count).
  it('aggregate tier: a "done" mission count renders its own line via the unified status parts list (on a non-idle zone)', () => {
    const data = makeProjectData({ counts: { running: 1, urgent: 0, review: 0, failed: 0, done: 3, total: 4 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} aggregate />
    </I18nProvider>);
    expect(screen.getByTestId('zone-agg-done')).toBeInTheDocument();
  });

  // fix/canvas-legibility — an idle zone (no running/failed/review work) no
  // longer RECEDES to a near-invisible bare label (the QA-observed
  // inconsistency: one zone had a full bordered card, the other two
  // rendered as ghost titles). Every zone — idle or busy — now shares the
  // SAME bordered chrome; an idle zone shows an honest "0 actifs" line
  // instead of disappearing, only its opacity drops so the eye still finds
  // the working zone first. `idle` folds in history-only zones (total > 0,
  // no live work).
  it('aggregate tier: an idle zone keeps the SAME bordered chrome as a busy zone, showing "0 actifs" instead of vanishing', () => {
    const historyOnly = makeProjectData({ name: 'quiet-proj', counts: { running: 0, urgent: 0, review: 0, failed: 0, done: 5, total: 5 } });
    const busy = makeProjectData({ name: 'busy-proj', counts: { running: 2, urgent: 0, review: 0, failed: 0, done: 0, total: 2 } });
    const { unmount } = render(<I18nProvider>
      <ProjectGroupNodeCard data={historyOnly} aggregate />
    </I18nProvider>);
    const idleChip = screen.getByTestId('zone-aggregate-summary');
    expect(idleChip).toHaveAttribute('data-idle', 'true');
    const nameEl = screen.getByTestId('zone-agg-idle');
    expect(nameEl).toHaveTextContent('quiet-proj');
    // W-UX3 audit fix #1 — still width-clamped + ellipsised so a long zone
    // name can't sprawl into a neighbouring zone's lane.
    expect(nameEl.style.overflow).toBe('hidden');
    expect(nameEl.style.textOverflow).toBe('ellipsis');
    expect(nameEl.style.maxWidth).not.toBe('');
    // Honest "0 actifs" line — never a disappearing counts box.
    expect(screen.getByTestId('zone-agg-idle-count')).toBeInTheDocument();
    // Same bordered chrome — the idle chip's own background/border/padding
    // must match a busy chip's (parity, not a stripped-down variant).
    const idleStyle = idleChip.style;
    unmount();

    render(<I18nProvider>
      <ProjectGroupNodeCard data={busy} aggregate />
    </I18nProvider>);
    const busyChip = screen.getByTestId('zone-aggregate-summary');
    expect(busyChip.style.background).toBe(idleStyle.background);
    expect(busyChip.style.border).toBe(idleStyle.border);
    expect(busyChip.style.padding).toBe(idleStyle.padding);
    expect(busyChip.style.borderRadius).toBe(idleStyle.borderRadius);

    // The zone node itself is still dimmed + de-emphasised.
    expect(screen.getByTestId('project-node-p1')).not.toHaveAttribute('data-idle');
  });

  it('aggregate tier: a truly empty zone (total 0) also gets the "0 actifs" line, never disappears', () => {
    const empty = makeProjectData({ name: 'brand-new', counts: { running: 0, urgent: 0, review: 0, failed: 0, done: 0, total: 0 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={empty} aggregate />
    </I18nProvider>);
    expect(screen.getByTestId('zone-aggregate-summary')).toHaveAttribute('data-idle', 'true');
    expect(screen.getByTestId('zone-agg-idle')).toHaveTextContent('brand-new');
    expect(screen.getByTestId('zone-agg-idle-count')).toBeInTheDocument();
  });

  it('aggregate tier: an ACTIVE zone is NOT idle — keeps the full chip and is not dimmed', () => {
    const active = makeProjectData({ counts: { running: 3, urgent: 0, review: 0, failed: 0, done: 0, total: 3 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={active} aggregate />
    </I18nProvider>);
    expect(screen.getByTestId('zone-aggregate-summary')).not.toHaveAttribute('data-idle');
    expect(screen.getByTestId('project-node-p1')).not.toHaveAttribute('data-idle');
    expect(screen.getByTestId('zone-agg-running')).toBeInTheDocument();
    expect(screen.queryByTestId('zone-agg-idle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('zone-agg-idle-count')).not.toBeInTheDocument();
  });

  it('aggregate tier: zero-count statuses are omitted from the chip (no « 0 échecs » noise)', () => {
    const data = makeProjectData({ counts: { running: 3, urgent: 0, review: 0, failed: 0, done: 0, total: 3 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} aggregate />
    </I18nProvider>);
    expect(screen.getByTestId('zone-agg-running')).toBeInTheDocument();
    expect(screen.queryByTestId('zone-agg-failed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('zone-agg-review')).not.toBeInTheDocument();
    expect(screen.queryByTestId('zone-agg-done')).not.toBeInTheDocument();
  });

  // fix/canvas-aggregate-title-band (3rd reported occurrence) — regression
  // coverage for the actual bug: this chip used to render as a `position:
  // absolute; top: 6; left: 6` OVERLAY inside the SAME zone container the
  // header row (ProjectGroupNode.tsx's `canvas-zone-header`) also occupies,
  // so both elements' title text painted over the exact same top-left
  // pixels at any aggregate zoom. Fixed structurally: the chip is now a
  // normal in-flow block rendered AFTER the header — this asserts that
  // structure directly rather than re-deriving pixel geometry jsdom can't
  // actually lay out.
  it('renders as a normal in-flow band AFTER the header (never an absolute overlay on top of it)', () => {
    const data = makeProjectData({ counts: { running: 2, urgent: 0, review: 0, failed: 0, done: 0, total: 2 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} aggregate width={320} />
    </I18nProvider>);
    const band = screen.getByTestId('zone-aggregate-summary-band');
    const chip = screen.getByTestId('zone-aggregate-summary');
    const header = screen.getByTestId('project-node-name').closest('.canvas-zone-header');
    expect(header).not.toBeNull();
    expect(band.style.position).not.toBe('absolute');
    expect(chip.style.position).not.toBe('absolute');
    // The band's own `minHeight` still reads geometry.ts's ZONE_TITLE_BAND_
    // HEIGHT verbatim (this component is permanently unmounted in the live
    // app — see this file's own module header — so its exact reserved size
    // is no longer load-bearing; this only pins the wiring). fix/canvas-
    // title-float shrank that constant to 0 (React renders an exactly-0
    // style value without a unit suffix, hence the ternary rather than a
    // blind template string).
    expect(band.style.minHeight).toBe(ZONE_TITLE_BAND_HEIGHT === 0 ? '0' : `${ZONE_TITLE_BAND_HEIGHT}px`);
    // DOM order: header first, band strictly AFTER — two sequential flow
    // siblings can never occupy the same pixels, by construction.
    expect(header!.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('width-clamps the chip to the zone\'s own live on-screen width (chipClampMaxWidth) when `width` is provided', () => {
    const data = makeProjectData({ counts: { running: 1, urgent: 0, review: 0, failed: 0, done: 0, total: 1 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} aggregate width={250} />
    </I18nProvider>);
    expect(screen.getByTestId('zone-aggregate-summary').style.maxWidth).toBe(chipClampMaxWidth(250));
  });

  it('falls back to the fixed 168px guard when no `width` is passed (fixture safety, matches pre-fix behavior)', () => {
    const data = makeProjectData({ counts: { running: 1, urgent: 0, review: 0, failed: 0, done: 0, total: 1 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} aggregate />
    </I18nProvider>);
    expect(screen.getByTestId('zone-aggregate-summary').style.maxWidth).toBe('168px');
  });
});

describe('chipClampMaxWidth — zone-edge clamp for the aggregate chip (fix/canvas-aggregate-title-band)', () => {
  it('emits a min() combining the fixed 168px guard with a calc() dividing the zone width by the capped chip scale', () => {
    expect(chipClampMaxWidth(900)).toBe(
      `min(168px, calc(900px / min(var(--canvas-lod-chip-scale, 1), ${AGGREGATE_CHIP_MAX_SCALE})))`,
    );
  });

  it('cancels the capped LOD transform-scale exactly: (zoneWidth / cappedScale) * cappedScale === zoneWidth', () => {
    const zoneWidthPx = 500;
    for (const cappedScale of [1, 1.5, AGGREGATE_CHIP_MAX_SCALE]) {
      const maxWidthPx = zoneWidthPx / cappedScale; // what the calc() half resolves to
      const onScreenFootprintPx = maxWidthPx * cappedScale;
      expect(onScreenFootprintPx).toBeCloseTo(zoneWidthPx, 6);
    }
  });

  it('clamps a negative/nonsensical width to 0 rather than emitting an invalid calc()', () => {
    expect(chipClampMaxWidth(-10)).toBe(
      `min(168px, calc(0px / min(var(--canvas-lod-chip-scale, 1), ${AGGREGATE_CHIP_MAX_SCALE})))`,
    );
  });

  it('keeps the fixed 168px guard present as the other min() operand for a wide zone (never grows past it)', () => {
    // Can't evaluate CSS min()/calc() in Node — asserting the fixed guard is
    // present as the other min() operand is what guarantees the browser's
    // own min() picks it whenever `zoneWidthPx / cappedScale` exceeds 168.
    expect(chipClampMaxWidth(2000)).toContain('min(168px,');
  });
});

// scratch/_canvas-label-design.md §3.1/§3.4 — the running-count chip,
// approval-mode badge, and urgent badge moved OUT of the plaque's
// contre-scaled identity cluster into `ZoneHeaderBand` (a normal in-frame
// strip, canvas scale). Per the owner's "no semantic zoom" rule they are no
// longer conditionally hidden by `headerTier` at any band — they render
// whenever their own DATA condition holds (running/urgent count > 0,
// approvalMode set), full stop. `headerTier` now only ever gates the
// plaque's own chevron/status-dot (this describe block's own regression
// coverage for that narrower scope, superseding the old badge-hiding
// tiers this suite used to lock in — see fix/canvas-legibility-toolbar-
// overlap's own history above for why those tiers existed in the first
// place: working around exactly the chrome-competes-with-the-name problem
// this design doc's plaque rework retires).
describe('ProjectGroupNodeCard — header secondary badges are never zoom-tier-gated any more (scratch/_canvas-label-design.md §3.1)', () => {
  function makeProjectData(overrides: Partial<ProjectNodeData> = {}): ProjectNodeData {
    return {
      projectId: 'p1',
      root: '/repo/p1',
      name: 'demo-shop',
      color: 'hsl(220 65% 62%)',
      collapsed: false,
      isActive: true,
      counts: { running: 2, urgent: 3, review: 0, failed: 0, done: 0, total: 4 },
      hasChildren: true,
      approvalMode: 'auto_green',
      ...overrides,
    };
  }

  it('headerTier "full": every secondary badge (running-count, approval-mode, urgent-count) renders', () => {
    const data = makeProjectData();
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} headerTier="full" />
    </I18nProvider>);
    expect(screen.getByTestId('project-node-running-count')).toBeInTheDocument();
    expect(screen.getByTestId('project-node-approval-mode-badge-trigger')).toBeInTheDocument();
    expect(screen.getByTestId('project-node-urgent-badge')).toHaveTextContent('3');
  });

  it('headerTier "reduced": secondary badges KEEP rendering (they live in ZoneHeaderBand now, unrelated to the plaque\'s own tier) — only the plaque itself has nothing new to drop', () => {
    const data = makeProjectData();
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} headerTier="reduced" />
    </I18nProvider>);
    expect(screen.getByTestId('project-node-urgent-badge')).toBeInTheDocument();
    expect(screen.getByTestId('project-node-running-count')).toBeInTheDocument();
    expect(screen.getByTestId('project-node-approval-mode-badge-trigger')).toBeInTheDocument();
    // Title/chevron/status-dot survive too.
    expect(screen.getByTestId('project-node-name')).toHaveTextContent('demo-shop');
    expect(screen.getByTestId('project-node-chevron')).toBeInTheDocument();
  });

  it('headerTier "minimal": the plaque drops its own chevron/status-dot, but ZoneHeaderBand\'s secondary badges are UNAFFECTED (never hidden, per the owner\'s "no semantic zoom" rule)', () => {
    const data = makeProjectData();
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} headerTier="minimal" />
    </I18nProvider>);
    expect(screen.getByTestId('project-node-urgent-badge')).toBeInTheDocument();
    expect(screen.getByTestId('project-node-running-count')).toBeInTheDocument();
    expect(screen.getByTestId('project-node-approval-mode-badge-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('project-node-chevron')).not.toBeInTheDocument();
    expect(screen.getByTestId('project-node-name')).toHaveTextContent('demo-shop');
  });

  it('with no urgent missions, the urgent badge is absent regardless of headerTier (data-driven, not a tier concern any more)', () => {
    const data = makeProjectData({ counts: { running: 2, urgent: 0, review: 0, failed: 0, done: 0, total: 2 } });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} headerTier="full" />
    </I18nProvider>);
    expect(screen.queryByTestId('project-node-urgent-badge')).not.toBeInTheDocument();
  });
});

describe('ProjectGroupNodeCard — per-mission dot strip (feat/always-visible-agents)', () => {
  function makeProjectData(overrides: Partial<ProjectNodeData> = {}): ProjectNodeData {
    return {
      projectId: 'p1',
      root: '/repo/p1',
      name: 'demo-shop',
      color: 'hsl(220 65% 62%)',
      collapsed: false,
      isActive: true,
      counts: { running: 1, urgent: 0, review: 0, failed: 1, done: 0, total: 2 },
      hasChildren: true,
      missions: [
        { missionId: 'm1', ref: makeRef('mission', 'm1'), title: 'Fix login bug', status: 'running', paused: false },
        { missionId: 'm2', ref: makeRef('mission', 'm2'), title: 'Flaky test', status: 'failed', paused: false },
      ],
      ...overrides,
    };
  }

  // W-CARDS (product owner, 2026-07-18) — an EXPANDED zone's real mission
  // cards now stay visible at every zoom (including the old "aggregate"
  // tier — see ProjectGroupNode.tsx's own header), so the dot strip this
  // block covers is redundant there and was removed from both the
  // aggregate summary and the (now-gone) chip-tier overlay. Dots remain
  // ONLY on a manually-COLLAPSED zone, which still has no real cards to
  // show at any zoom.
  it('does NOT render dots at the aggregate tier — the zone body (with real cards) stays mounted underneath instead', () => {
    const data = makeProjectData();
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} aggregate />
    </I18nProvider>);
    expect(screen.queryByTestId('zone-mission-dot-m1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('zone-mission-dot-m2')).not.toBeInTheDocument();
    // The zone's real header/name is still the expanded chrome — never
    // replaced by the aggregate summary.
    expect(screen.getByTestId('project-node-name')).toBeInTheDocument();
  });

  it('hides dots on an EXPANDED zone at every zoom (cards already visible — no duplication)', () => {
    const data = makeProjectData();
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.queryByTestId('zone-mission-dot-m1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('zone-mission-dot-m2')).not.toBeInTheDocument();
  });

  it('renders dots on a COLLAPSED zone at ANY zoom tier (its only real cards are hidden — dots are the honest roster)', () => {
    const data = makeProjectData({ collapsed: true });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    const runningDot = screen.getByTestId('zone-mission-dot-m1');
    const failedDot = screen.getByTestId('zone-mission-dot-m2');
    expect(runningDot).toBeInTheDocument();
    expect(failedDot).toBeInTheDocument();
    expect(runningDot).toHaveClass('canvas-dot-running-pulse');
    expect(failedDot).not.toHaveClass('canvas-dot-running-pulse');
    expect(runningDot.title).toContain('Fix login bug');
  });

  it('caps visible dots and discloses the rest via a "+N" overflow chip, on a collapsed zone', () => {
    const missions = Array.from({ length: 45 }, (_, i) => ({
      missionId: `m${i}`,
      ref: makeRef('mission', `m${i}`),
      title: `Mission ${i}`,
      status: 'queued' as const,
      paused: false,
    }));
    const data = makeProjectData({ missions, collapsed: true });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.getByTestId('zone-mission-dot-m0')).toBeInTheDocument();
    expect(screen.getByTestId('zone-mission-dot-m39')).toBeInTheDocument();
    expect(screen.queryByTestId('zone-mission-dot-m40')).not.toBeInTheDocument();
    expect(screen.getByTestId('zone-mission-dots-overflow')).toHaveTextContent('+5');
  });

  it('clicking a dot on a collapsed zone fires onFocusNode with the mission/loop node ref, without toggling collapse', () => {
    const onFocusNode = vi.fn();
    const data = makeProjectData({ collapsed: true });
    render(withActions(<ProjectGroupNodeCard data={data} />, { onFocusNode }));
    fireEvent.click(screen.getByTestId('zone-mission-dot-m1'));
    expect(onFocusNode).toHaveBeenCalledWith('mission:m1');
    // The collapsed pill's own onClick (uncollapse) must not also fire.
    expect(screen.getByTestId(`project-node-${data.projectId}`)).toHaveAttribute('data-collapsed', 'true');
  });

  it('renders no dot strip container on a collapsed zone with no missions', () => {
    const data = makeProjectData({ missions: [], collapsed: true });
    render(<I18nProvider>
      <ProjectGroupNodeCard data={data} />
    </I18nProvider>);
    expect(screen.queryByTestId('zone-mission-dots')).not.toBeInTheDocument();
  });
});

describe('ChainEdge condition mapping (spec §4.4)', () => {
  it('conditionLabelKey gives a distinct i18n key per condition (W5a: keys, not pre-translated text — see ChainEdge.tsx)', () => {
    expect(conditionLabelKey('success')).toBe('canvas.edge.conditionSuccess');
    expect(conditionLabelKey('fail')).toBe('canvas.edge.conditionFail');
    expect(conditionLabelKey('always')).toBe('canvas.edge.conditionAlways');
  });

  it('conditionStrokeProps: success/fail/always are visually distinct, disabled/tombstone mutes opacity', () => {
    const success = conditionStrokeProps('success', false);
    const fail = conditionStrokeProps('fail', false);
    const always = conditionStrokeProps('always', false);
    expect(new Set([success.stroke, fail.stroke, always.stroke]).size).toBe(3);
    expect(fail.strokeDasharray).toBeTruthy();
    expect(conditionStrokeProps('success', false).opacity).toBe(1);
    expect(conditionStrokeProps('success', true).opacity).toBeLessThan(1);
  });

  // Visual sweep #4 (P47) — the label must never render exactly on the
  // edge's raw midpoint (where it can paint over a neighboring node's
  // card); see chainEdgeLabelPosition's own doc comment for the CSS
  // stacking-order reasoning this offset stands in for.
  it('chainEdgeLabelPosition nudges the label a fixed amount ABOVE the raw midpoint, leaving X untouched', () => {
    expect(chainEdgeLabelPosition(120, 340)).toEqual({ x: 120, y: 340 - CHAIN_EDGE_LABEL_Y_NUDGE_PX });
  });

  it('chainEdgeLabelPosition is deterministic and never returns the exact raw midpoint', () => {
    const a = chainEdgeLabelPosition(50, 50);
    const b = chainEdgeLabelPosition(50, 50);
    expect(a).toEqual(b);
    expect(a.y).not.toBe(50);
  });
});

describe('StageRail — current-stage highlight (spec §4.3)', () => {
  it('marks only the current stage dot active and renders the full-variant label', () => {
    render(<I18nProvider>
      <StageRail currentStage="test" variant="full" />
    </I18nProvider>);
    const rail = screen.getByTestId('stage-rail');
    expect(rail).toHaveAttribute('data-current-stage', 'test');
    expect(screen.getByTestId('stage-dot-test')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('stage-dot-plan')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('stage-dot-merged')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('stage-rail-label')).toBeInTheDocument();
  });

  it('compact variant renders no label', () => {
    render(<I18nProvider>
      <StageRail currentStage="plan" variant="compact" />
    </I18nProvider>);
    expect(screen.queryByTestId('stage-rail-label')).not.toBeInTheDocument();
  });
});

// ── fix/canvas-ux R7 — MissionNode's live-panel expand gesture ───────────
//
// `expandedPanels` lives in canvasStore (not a component prop), so these
// tests seed/reset it directly — same "read canvasStore state, assert on
// the render" convention MissionNode.tsx's fold-chevron tests could already
// use if they needed to (they don't, since that feature is prop-driven via
// `data.subMissionCount`; expand is the first MissionNode feature that's
// canvasStore-driven at the CARD level).

describe('MissionNodeCard — living-surfaces live-panel expand (R7)', () => {
  beforeEach(() => {
    _resetCanvasStoreForTests();
    capturedNodeResizerProps = null;
  });
  afterEach(() => {
    _resetCanvasStoreForTests();
  });

  // W-CARDS — the "agrandir" hover action is now always present: there is
  // no more compact/chip summary tier to reserve it away from.
  it('shows the "agrandir" chevron at every zoomLevel (one constant card, no more compact/chip summary tier)', () => {
    const data = makeMissionData();
    const { rerender } = render(withActions(<MissionNodeCard data={data} zoomLevel="full" />));
    expect(screen.getByTestId('mission-node-expand-m1')).toBeInTheDocument();

    rerender(withActions(<MissionNodeCard data={data} zoomLevel="compact" />));
    expect(screen.getByTestId('mission-node-expand-m1')).toBeInTheDocument();

    rerender(withActions(<MissionNodeCard data={data} zoomLevel="chip" />));
    expect(screen.getByTestId('mission-node-expand-m1')).toBeInTheDocument();
  });

  it('clicking the chevron expands into the live panel (canvasStore.expandedPanels gains an entry)', () => {
    const data = makeMissionData();
    render(withActions(<MissionNodeCard data={data} zoomLevel="full" />));

    fireEvent.click(screen.getByTestId('mission-node-expand-m1'));

    expect(canvasStoreVanilla.getState().expandedPanels[makeRef('mission', 'm1')]).toEqual({ width: 520, height: 420 });
    expect(screen.getByTestId('live-mission-panel-m1')).toBeInTheDocument();
    // The normal card's own body (live-action line) is gone — replaced
    // wholesale by the live panel, never rendered alongside it.
    expect(screen.queryByTestId('mission-node-live-action')).not.toBeInTheDocument();
  });

  it('double-clicking the card (full zoom) expands it too (spec: "chevron AND double-click")', () => {
    const data = makeMissionData();
    render(withActions(<MissionNodeCard data={data} zoomLevel="full" />));

    fireEvent.doubleClick(screen.getByTestId('mission-node-m1'));

    expect(canvasStoreVanilla.getState().expandedPanels[makeRef('mission', 'm1')]).toBeDefined();
  });

  it('the live panel\'s own collapse button removes the expandedPanels entry, reverting to the normal card', () => {
    const data = makeMissionData();
    canvasStoreVanilla.getState().setExpandedPanel(makeRef('mission', 'm1'), { width: 520, height: 420 });
    render(withActions(<MissionNodeCard data={data} zoomLevel="full" />));

    fireEvent.click(screen.getByTestId('live-mission-panel-collapse-m1'));

    expect(canvasStoreVanilla.getState().expandedPanels[makeRef('mission', 'm1')]).toBeUndefined();
    expect(screen.getByTestId('mission-node-m1')).toBeInTheDocument(); // back to the normal card
  });

  it('NodeResizer onResizeEnd persists the panel\'s new size (feeds reconcilerZones.ts\'s effectiveChildSize on the next reconcile)', () => {
    const data = makeMissionData();
    canvasStoreVanilla.getState().setExpandedPanel(makeRef('mission', 'm1'), { width: 520, height: 420 });
    render(withActions(<MissionNodeCard data={data} zoomLevel="full" selected />));

    capturedNodeResizerProps?.onResizeEnd?.(null, { x: 0, y: 0, width: 640, height: 500 });

    expect(canvasStoreVanilla.getState().expandedPanels[makeRef('mission', 'm1')]).toEqual({ width: 640, height: 500 });
  });
});
