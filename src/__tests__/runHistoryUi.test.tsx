/* runHistoryUi.test.tsx — fixture renders for the W8b history/inspector UI:
   StageGantt (SVG spans/live pulse/merged marker), RunHistoryDrawer (journal-
   fed sections + archive), DataInspector (honest empty rows, tokensSource
   badge, Table/JSON toggle + search). useI18n is mocked to `t: key => key`
   (same convention as MissionDetail.test.tsx) so assertions are locale-
   independent. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { StageGantt, formatStageDuration } from '../components/agents/canvas/history/StageGantt';
import { DataInspector } from '../components/agents/canvas/history/DataInspector';
import { RunHistoryDrawer } from '../components/agents/canvas/history/RunHistoryDrawer';
import type { Mission } from '../lib/agents/types';
import type { JournalEventRow } from '../lib/journal/eventTypes';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
}));

const mockInvoke = vi.mocked(invoke);

function baseMission(overrides: Partial<Mission> = {}): Mission {
  return { id: 'm-1', title: 'Test mission', status: 'running', model: 'sonnet', ...overrides };
}

function journalRow(overrides: Partial<JournalEventRow>): JournalEventRow {
  return {
    seq: 1,
    ts_ms: 1_000,
    project_id: 'proj-1',
    mission_id: 'm-1',
    agent_id: null,
    run_id: null,
    actor: 'system',
    type: 'mission.created',
    payload: '{}',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

// ── formatStageDuration ────────────────────────────────────────────

describe('formatStageDuration', () => {
  it('formats seconds, minutes, and hours honestly', () => {
    expect(formatStageDuration(500)).toBe('<1s');
    expect(formatStageDuration(40_000)).toBe('40s');
    expect(formatStageDuration(6 * 60_000)).toBe('6min');
    expect(formatStageDuration(80 * 60_000)).toBe('1h20');
    expect(formatStageDuration(120 * 60_000)).toBe('2h');
  });
});

// ── StageGantt ─────────────────────────────────────────────────────

describe('StageGantt', () => {
  it('renders an honest empty state when no row has any span', () => {
    render(<StageGantt rows={[{ id: 'm-1', label: 'Mission', spans: [] }]} nowMs={10_000} />);
    expect(screen.getByText('canvas.history.ganttEmpty')).toBeInTheDocument();
    expect(screen.queryByTestId('stage-gantt')).not.toBeInTheDocument();
  });

  it('renders one bar per closed span and a zero-width merged marker as a circle', () => {
    render(
      <StageGantt
        nowMs={10_000}
        rows={[
          {
            id: 'm-1',
            label: 'Mission',
            spans: [
              { stage: 'plan', startMs: 1_000, endMs: 2_000 },
              { stage: 'code', startMs: 2_000, endMs: 8_000 },
              { stage: 'merged', startMs: 9_000, endMs: 9_000 },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByTestId('gantt-span-m-1-plan')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-span-m-1-code')).toBeInTheDocument();
    const merged = screen.getByTestId('gantt-span-m-1-merged');
    expect(merged.tagName.toLowerCase()).toBe('circle');
    expect(screen.queryByTestId('gantt-live-pulse-m-1')).not.toBeInTheDocument();
  });

  it('renders a live pulse at the end of an open (endMs null) span', () => {
    render(
      <StageGantt
        nowMs={10_000}
        rows={[{ id: 'm-1', label: 'Mission', spans: [{ stage: 'code', startMs: 2_000, endMs: null }] }]}
      />,
    );
    expect(screen.getByTestId('gantt-live-pulse-m-1')).toBeInTheDocument();
  });

  it('renders comparison iteration rows alongside the primary', () => {
    render(
      <StageGantt
        nowMs={10_000}
        rows={[
          { id: 'm-1', label: 'Mission', spans: [{ stage: 'plan', startMs: 1_000, endMs: 2_000 }] },
          { id: 'm-i1', label: 'Iter 1', spans: [{ stage: 'plan', startMs: 3_000, endMs: 4_000 }] },
        ]}
      />,
    );
    expect(screen.getByTestId('gantt-row-m-1')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-row-m-i1')).toBeInTheDocument();
  });
});

// ── DataInspector ──────────────────────────────────────────────────

describe('DataInspector', () => {
  it('renders honest empty rows when the mission has no task/output/metrics/verdict', () => {
    render(<DataInspector mission={baseMission()} />);
    expect(screen.getByText('canvas.inspector.taskEmpty')).toBeInTheDocument();
    expect(screen.getByText('canvas.inspector.outputEmpty')).toBeInTheDocument();
    expect(screen.getByText('canvas.inspector.toolCallsEmpty')).toBeInTheDocument();
    expect(screen.getByText('canvas.inspector.metricsEmpty')).toBeInTheDocument();
    expect(screen.getByText('canvas.inspector.judgeEmpty')).toBeInTheDocument();
  });

  it('shows the real agentTask and structured tool calls parsed from the timeline', () => {
    const mission = baseMission({
      agentTask: 'Fix the login bug end to end',
      actionTimeline: [
        { time: '10:00', text: '[1] read_file: {"path":"src/foo.ts"}' },
        { time: '10:01', text: 'Observation: file contents…' },
        { time: '10:02', text: 'Résultat: bug fixed' },
      ],
    });
    render(<DataInspector mission={mission} />);
    expect(screen.getByText('Fix the login bug end to end')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-tool-calls')).toBeInTheDocument();
    expect(screen.getByText('#1 Read file')).toBeInTheDocument();
    expect(screen.getByText('Résultat: bug fixed')).toBeInTheDocument();
  });

  it('reports coarse-only timelines honestly instead of pretending they are tool calls', () => {
    const mission = baseMission({
      actionTimeline: [{ time: '10:00', text: 'Analyse du code en cours…' }],
    });
    render(<DataInspector mission={mission} />);
    expect(screen.getByText('canvas.inspector.toolCallsCoarse:1')).toBeInTheDocument();
  });

  it('shows the estimated badge only when tokensSource is not real/exact', () => {
    const metrics = { durationMs: 5_000, inputTokens: 100, outputTokens: 40, costUsd: 0.02, toolCount: 3 };
    const { rerender } = render(
      <DataInspector mission={baseMission({ agentMetrics: { ...metrics, tokensSource: 'estimated' } })} />,
    );
    expect(screen.getByTestId('inspector-estimated-badge')).toBeInTheDocument();

    rerender(<DataInspector mission={baseMission({ agentMetrics: { ...metrics, tokensSource: 'real' } })} />);
    expect(screen.queryByTestId('inspector-estimated-badge')).not.toBeInTheDocument();

    // Undefined = native/exact numbers (see AgentMetrics.tokensSource) — no badge.
    rerender(<DataInspector mission={baseMission({ agentMetrics: metrics })} />);
    expect(screen.queryByTestId('inspector-estimated-badge')).not.toBeInTheDocument();
  });

  it('renders the judge verdict as a structured table', () => {
    const mission = baseMission({
      judgeVerdict: {
        score: 85,
        passed: true,
        risk: 'low',
        reviewers: [{ role: 'tester', verdict: 'approve', summary: 'All tests green', score: 90 }],
        tests: { passed: 12, failed: 0 },
        createdAt: '2026-07-14T10:00:00.000Z',
      },
    });
    render(<DataInspector mission={mission} />);
    const table = screen.getByTestId('inspector-judge-table');
    expect(table).toHaveTextContent('85/100');
    expect(table).toHaveTextContent('mission.detail.evalPassed');
    expect(table).toHaveTextContent('low');
    expect(table).toHaveTextContent('All tests green');
  });

  // fix/canvas-ux R6a MINEUR #8 (final dogfood f29) — the judge table's
  // label column had no `whiteSpace` control, squeezing "Score"/"Résultat"/
  // "reviewer" one character per line once the panel got narrow. jsdom has
  // no real layout engine (can't prove visual wrapping — canvasTestEnv.ts's
  // own header notes the same limitation), so this asserts the STYLE fix
  // directly: every label cell in both tables carries `white-space: nowrap`.
  it('label columns (metrics + judge tables) never wrap — whiteSpace: nowrap on every label cell', () => {
    const mission = baseMission({
      agentMetrics: { durationMs: 5_000, inputTokens: 100, outputTokens: 40, costUsd: 0.02, toolCount: 3 },
      judgeVerdict: {
        score: 85,
        passed: true,
        risk: 'low',
        reviewers: [{ role: 'reviewer', verdict: 'approve', summary: 'All tests green', score: 90 }],
        createdAt: '2026-07-14T10:00:00.000Z',
      },
    });
    render(<DataInspector mission={mission} />);
    const judgeTable = screen.getByTestId('inspector-judge-table');
    const labelCells = judgeTable.querySelectorAll('tr > td:first-child');
    expect(labelCells.length).toBeGreaterThan(0);
    for (const cell of Array.from(labelCells)) {
      expect((cell as HTMLElement).style.whiteSpace).toBe('nowrap');
    }
  });

  // fix/canvas-ux R6a MINEUR #8 — tokensSource honesty NEXT TO the token
  // counts specifically (not just once near the whole "Métriques" section
  // title, see the section-level `inspector-estimated-badge` test above),
  // for the input-undercount honesty a sibling wave's evaluator/report work
  // depends on: always ONE of « estimé »/« réel », never silently absent.
  it('shows a per-value « estimé »/« réel » badge next to Tokens entrants/sortants specifically', () => {
    const metrics = { durationMs: 5_000, inputTokens: 100, outputTokens: 40, costUsd: 0.02, toolCount: 3 };
    const { rerender } = render(
      <DataInspector mission={baseMission({ agentMetrics: { ...metrics, tokensSource: 'estimated' } })} />,
    );
    expect(screen.getByTestId('inspector-tokens-source-badge-in')).toHaveTextContent('canvas.inspector.estimatedBadge');
    expect(screen.getByTestId('inspector-tokens-source-badge-out')).toHaveTextContent('canvas.inspector.estimatedBadge');

    rerender(<DataInspector mission={baseMission({ agentMetrics: { ...metrics, tokensSource: 'real' } })} />);
    expect(screen.getByTestId('inspector-tokens-source-badge-in')).toHaveTextContent('canvas.inspector.realBadge');
    expect(screen.getByTestId('inspector-tokens-source-badge-out')).toHaveTextContent('canvas.inspector.realBadge');

    // Undefined = native/exact numbers — still an explicit "réel", never absent.
    rerender(<DataInspector mission={baseMission({ agentMetrics: metrics })} />);
    expect(screen.getByTestId('inspector-tokens-source-badge-in')).toHaveTextContent('canvas.inspector.realBadge');
    expect(screen.getByTestId('inspector-tokens-source-badge-out')).toHaveTextContent('canvas.inspector.realBadge');

    // Non-token rows (duration/cost/tool-calls) never carry this badge.
    expect(screen.queryAllByTestId(/inspector-tokens-source-badge/)).toHaveLength(2);
  });

  it('toggles to JSON view and highlights search matches in it', () => {
    const mission = baseMission({ agentTask: 'deploy the artifact registry' });
    render(<DataInspector mission={mission} />);

    fireEvent.click(screen.getByTestId('inspector-view-json'));
    expect(screen.getByTestId('inspector-json')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('inspector-search'), { target: { value: 'registry' } });
    expect(screen.getAllByTestId('inspector-match').length).toBeGreaterThan(0);
  });

  it('highlights search matches in the table view', () => {
    const mission = baseMission({ agentTask: 'refactor payment flow' });
    render(<DataInspector mission={mission} />);
    fireEvent.change(screen.getByTestId('inspector-search'), { target: { value: 'payment' } });
    expect(screen.getAllByTestId('inspector-match').length).toBeGreaterThan(0);
  });
});

// ── RunHistoryDrawer ───────────────────────────────────────────────

describe('RunHistoryDrawer', () => {
  function mockJournal(rowsByMission: Record<string, JournalEventRow[]>, projectRows: JournalEventRow[] = []) {
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'journal_query_events') {
        const filter = (args ?? {}) as { missionId?: string; projectId?: string };
        if (filter.missionId) return Promise.resolve(rowsByMission[filter.missionId] ?? []);
        if (filter.projectId) return Promise.resolve(projectRows);
      }
      if (cmd === 'get_project_root') return Promise.resolve('C:\\repo');
      return Promise.resolve(undefined);
    });
  }

  it('renders the Gantt from real journal events and the totals from spend.tokens', async () => {
    mockJournal({
      'm-1': [
        journalRow({ seq: 1, ts_ms: 1_000, type: 'mission.created', payload: JSON.stringify({ title: 'T' }) }),
        journalRow({ seq: 2, ts_ms: 2_000, type: 'mission.started', payload: JSON.stringify({ model: 's' }) }),
        journalRow({
          seq: 3,
          ts_ms: 3_000,
          type: 'spend.tokens',
          payload: JSON.stringify({ tokensIn: 120, tokensOut: 30, costUsd: 0.05, source: 'real' }),
          tokens_in: 120,
          tokens_out: 30,
          cost_usd: 0.05,
        }),
        journalRow({ seq: 4, ts_ms: 9_000, type: 'mission.completed', payload: '{}' }),
      ],
    });

    render(<RunHistoryDrawer mission={baseMission()} />);

    await waitFor(() => expect(screen.getByTestId('stage-gantt')).toBeInTheDocument());
    expect(screen.getByTestId('gantt-span-m-1-plan')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-span-m-1-merged')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument(); // tokens in
    // Fix D (2026-08-19 dollar-kill incident) — credits, never a dollar
    // figure; this fixture's mission.started model ('s') is native rail, so
    // the figure is marked as a non-debited equivalent (≈, costNoDebit key
    // — this file mocks t() to the raw key, see this file's own header).
    expect(screen.getByText('≈5 canvas.node.creditsUnit (canvas.node.costNoDebit)')).toBeInTheDocument();
    expect(screen.getByTestId('history-event-log')).toBeInTheDocument();
  });

  it('shows honest empty states when the journal has nothing for the mission', async () => {
    mockJournal({});
    render(<RunHistoryDrawer mission={baseMission()} />);
    await waitFor(() => expect(screen.getByText('canvas.history.ganttEmpty')).toBeInTheDocument());
    expect(screen.getByText('canvas.history.eventsEmpty')).toBeInTheDocument();
    expect(screen.getByText('canvas.history.chainFiresEmpty')).toBeInTheDocument();
  });

  it('lists past missions from the project archive and loads one on click — even if gone from the canvas', async () => {
    mockJournal(
      {
        'm-1': [journalRow({ seq: 1, ts_ms: 1_000, type: 'mission.created', payload: JSON.stringify({ title: 'Live' }) })],
        'm-old': [
          journalRow({ seq: 10, ts_ms: 500, mission_id: 'm-old', type: 'mission.created', payload: JSON.stringify({ title: 'Archived one' }) }),
          journalRow({ seq: 11, ts_ms: 900, mission_id: 'm-old', type: 'mission.started', payload: '{}' }),
          journalRow({ seq: 12, ts_ms: 2_000, mission_id: 'm-old', type: 'mission.failed', payload: JSON.stringify({ reason: 'x' }) }),
        ],
      },
      [
        journalRow({ seq: 10, ts_ms: 500, mission_id: 'm-old', type: 'mission.created', payload: JSON.stringify({ title: 'Archived one' }) }),
        journalRow({ seq: 12, ts_ms: 2_000, mission_id: 'm-old', type: 'mission.failed', payload: JSON.stringify({ reason: 'x' }) }),
      ],
    );

    render(<RunHistoryDrawer mission={baseMission()} />);

    // The archive loads lazily on first expand (no project-wide journal scan
    // on plain drawer mount) — open the <details> to trigger it.
    const details = screen.getByTestId('history-archive');
    (details as HTMLDetailsElement).open = true;
    fireEvent(details, new Event('toggle', { bubbles: false }));

    // testid includes the generation index (0 = oldest — see
    // buildProjectArchive's (missionId, generation) keying, MAJEUR fix for
    // recycled mission ids) even though this fixture only has one generation.
    await waitFor(() => expect(screen.getByTestId('history-archive-row-m-old-0')).toBeInTheDocument());
    expect(screen.getByTestId('history-archive-row-m-old-0')).toHaveTextContent('Archived one');

    fireEvent.click(screen.getByTestId('history-archive-row-m-old-0'));

    // The drawer now views the ARCHIVED mission's history (banner + back button).
    await waitFor(() => expect(screen.getByText('canvas.history.archiveViewing:m-old')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('gantt-span-m-old-plan')).toBeInTheDocument());

    // Back to live restores the original mission's view.
    fireEvent.click(screen.getByTestId('history-back-to-live'));
    await waitFor(() => expect(screen.queryByText('canvas.history.archiveViewing:m-old')).not.toBeInTheDocument());
  });

  // ── MAJEUR (R3 dogfood): mission-id recycling ──────────────────────
  // A mission id can be reused by an unrelated later run. The drawer must
  // show the CURRENT generation's own Gantt/totals (never an older
  // generation's terminal status), list the older generation honestly under
  // "Générations précédentes", and the "Missions passées" archive must show
  // BOTH generations as distinct rows with only the current one clickable.

  it('a recycled mission id: current-generation Gantt never shows the older generation\'s terminal marker, and both generations are listed honestly', async () => {
    const oldGenEvents = [
      journalRow({ seq: 1, ts_ms: 1_000, mission_id: 'M9', type: 'mission.created', payload: JSON.stringify({ title: 'Old M9 (July)' }) }),
      journalRow({ seq: 2, ts_ms: 2_000, mission_id: 'M9', type: 'mission.completed', payload: '{}' }),
    ];
    const currentGenEvents = [
      journalRow({ seq: 3, ts_ms: 10_000, mission_id: 'M9', type: 'mission.created', payload: JSON.stringify({ title: 'New M9 (today)' }) }),
      journalRow({ seq: 4, ts_ms: 11_000, mission_id: 'M9', type: 'mission.started', payload: '{}' }),
    ];
    const combined = [...oldGenEvents, ...currentGenEvents];

    mockJournal({ M9: combined }, combined);

    render(<RunHistoryDrawer mission={baseMission({ id: 'M9' })} />);

    // Current generation's own Gantt (created -> started, still open) —
    // never the old generation's "merged" marker.
    await waitFor(() => expect(screen.getByTestId('stage-gantt')).toBeInTheDocument());
    expect(screen.queryByTestId('gantt-span-M9-merged')).not.toBeInTheDocument();

    // The older, finished generation is listed separately, never blended in.
    expect(screen.getByTestId('history-previous-generation-0')).toHaveTextContent('Old M9 (July)');

    // The project archive shows BOTH generations as distinct rows.
    const details = screen.getByTestId('history-archive');
    (details as HTMLDetailsElement).open = true;
    fireEvent(details, new Event('toggle', { bubbles: false }));

    await waitFor(() => expect(screen.getByTestId('history-archive-row-M9-0')).toBeInTheDocument());
    expect(screen.getByTestId('history-archive-row-M9-1')).toBeInTheDocument();

    // Only the CURRENT generation's row is clickable (a button) — the older
    // one is read-only (clicking it could only ever load the CURRENT
    // generation via the id, which would be misleading).
    expect(screen.getByTestId('history-archive-row-M9-0').tagName.toLowerCase()).toBe('div');
    expect(screen.getByTestId('history-archive-row-M9-1').tagName.toLowerCase()).toBe('button');
  });

  it('renders chain fires with source -> target when the journal recorded them', async () => {
    mockJournal({
      'm-1': [
        journalRow({ seq: 1, ts_ms: 1_000, type: 'mission.created', payload: JSON.stringify({ title: 'T' }) }),
        journalRow({
          seq: 2,
          ts_ms: 2_000,
          type: 'chain.fired',
          payload: JSON.stringify({ chainId: 'c1', sourceMissionId: 'm-1', targetRef: 'draft:d7', projectId: 'p' }),
        }),
      ],
    });
    render(<RunHistoryDrawer mission={baseMission()} />);
    await waitFor(() => expect(screen.getByTestId('history-chain-fires')).toBeInTheDocument());
    expect(screen.getByTestId('history-chain-fires')).toHaveTextContent('m-1 -> draft:d7');
  });
});
