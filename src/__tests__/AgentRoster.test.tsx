/**
 * AgentRoster.test.tsx — cockpit roster + journal-backed agent stats
 * (audit follow-up: T2.7 required per-agent-identity stats from
 * `journal_agent_stats`, not the in-memory mission store).
 *
 * Covers:
 *   - existing behavior preserved: grouping by agentName/model, status
 *     pills, empty state, mission click routing
 *   - stats merge: runs / success rate / avg cost rendered from
 *     queryAgentStats rows keyed by agent identity
 *   - loading skeleton while the first stats query is in flight
 *   - honest "—" cells when the journal has no rows for an identity
 *     (never a fabricated 0/0%/$0)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import type { Mission } from '../lib/agents/types';
import type { AgentStatsOut } from '../lib/journal/projections';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en', setLocale: vi.fn(), LOCALES: [] }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({ t: (key: string) => key, locale: 'en', setLocale: vi.fn(), LOCALES: [] }),
}));

const queryAgentStatsSpy = vi.fn();
vi.mock('../lib/journal/projections', () => ({
  queryAgentStats: (...args: unknown[]) => queryAgentStatsSpy(...args),
}));

import { AgentRoster } from '../components/agents/AgentRoster';

// ── Fixtures ─────────────────────────────────────────────────────────

function mission(id: string, overrides: Partial<Mission> = {}): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status: 'running',
    model: 'sonnet',
    createdAt: 1_000,
    ...overrides,
  } as Mission;
}

function statsRow(agentId: string, overrides: Partial<AgentStatsOut> = {}): AgentStatsOut {
  return {
    agent_id: agentId,
    runs: 5,
    completed: 4,
    failed: 1,
    total_tokens: 10_000,
    total_cost_usd: 1.25,
    last_active_ms: 2_000,
    ...overrides,
  };
}

const MISSIONS: Mission[] = [
  mission('m1', { agentName: 'test-writer', status: 'running', createdAt: 3_000 }),
  mission('m2', { agentName: 'test-writer', status: 'done', createdAt: 1_000 }),
  mission('m3', { agentName: 'security-reviewer', status: 'review', createdAt: 2_000 }),
];

const onMissionClick = vi.fn();

function renderRoster(missions: Mission[] = MISSIONS) {
  return render(<AgentRoster missions={missions} onMissionClick={onMissionClick} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  queryAgentStatsSpy.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Existing behavior preserved ─────────────────────────────────────

describe('AgentRoster — grouping and status pills (existing behavior)', () => {
  it('groups missions by agent identity and keeps status pills', async () => {
    renderRoster();

    expect(await screen.findByTestId('roster-agent-test-writer')).toBeInTheDocument();
    expect(screen.getByTestId('roster-agent-security-reviewer')).toBeInTheDocument();

    // test-writer: 1 running + 1 done pills; security-reviewer: 1 review.
    const testWriter = screen.getByTestId('roster-agent-test-writer');
    expect(testWriter.textContent).toContain('agents.roster.running');
    expect(testWriter.textContent).toContain('agents.roster.done');
    const reviewer = screen.getByTestId('roster-agent-security-reviewer');
    expect(reviewer.textContent).toContain('agents.roster.review');
  });

  it('falls back to model as the group key when agentName is absent', async () => {
    renderRoster([mission('m9', { agentName: undefined, model: 'haiku' })]);
    expect(await screen.findByTestId('roster-agent-haiku')).toBeInTheDocument();
  });

  it('clicking a group selects its most recent mission', async () => {
    renderRoster();
    fireEvent.click(await screen.findByTestId('roster-agent-test-writer'));
    // m1 (createdAt 3000) is more recent than m2 (1000).
    expect(onMissionClick).toHaveBeenCalledWith('m1');
  });

  it('renders the empty state with zero missions (and never crashes on stats)', async () => {
    renderRoster([]);
    expect(screen.getByTestId('agent-roster')).toBeInTheDocument();
    expect(screen.getByText('agents.roster.emptyTitle')).toBeInTheDocument();
    // Flush the in-flight stats resolution so its setState lands inside act.
    await act(async () => {});
  });
});

// ── Journal-backed stats (audit follow-up) ──────────────────────────

describe('AgentRoster — journal-backed stats merge', () => {
  it('renders runs, success rate, and avg cost from queryAgentStats', async () => {
    queryAgentStatsSpy.mockResolvedValue([
      statsRow('test-writer', { runs: 5, completed: 4, failed: 1, total_cost_usd: 1.25 }),
    ]);
    renderRoster();

    const statsCell = await screen.findByTestId('roster-agent-stats-test-writer');
    await waitFor(() => {
      // runs = 5; success = 4/(4+1) = 80%; avg cost = 1.25/5 = $0.25 ->
      // usdToCredits -> 25 credits (Fix D: credits, never a dollar figure).
      // The unit itself now goes through the real 'canvas.node.creditsUnit'
      // i18n key (AgentRoster.tsx, matching CostChip.tsx/MissionNode.tsx's
      // own credits-unit label) instead of a hardcoded 'cr' string — this
      // file's own `t` mock above echoes the raw key back rather than
      // resolving the real 'cr' locale string (same convention this file
      // already uses for every other label assertion, e.g. the
      // 'agents.roster.running' pill check above).
      expect(statsCell.textContent).toContain('5');
      expect(statsCell.textContent).toContain('80%');
      expect(statsCell.textContent).toContain('25 canvas.node.creditsUnit');
      expect(statsCell.textContent).not.toContain('$');
    });
  });

  it('shows a loading skeleton while the first stats query is in flight', async () => {
    let resolveStats: (rows: AgentStatsOut[]) => void = () => undefined;
    queryAgentStatsSpy.mockReturnValue(
      new Promise<AgentStatsOut[]>((resolve) => {
        resolveStats = resolve;
      }),
    );
    renderRoster();

    // In flight: skeleton blocks visible, no dash placeholders yet.
    expect(screen.getAllByTestId('stat-cell-skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByText('—')).not.toBeInTheDocument();

    await act(async () => {
      resolveStats([]);
    });
    await waitFor(() => {
      expect(screen.queryAllByTestId('stat-cell-skeleton')).toHaveLength(0);
    });
  });

  it('renders an honest dash (never 0) for identities with no journal rows', async () => {
    // Journal knows test-writer only; security-reviewer has no rows.
    queryAgentStatsSpy.mockResolvedValue([statsRow('test-writer')]);
    renderRoster();

    const reviewerStats = await screen.findByTestId('roster-agent-stats-security-reviewer');
    await waitFor(() => {
      expect(reviewerStats.textContent).toContain('—');
      expect(reviewerStats.textContent).not.toContain('$0.00');
      expect(reviewerStats.textContent).not.toContain('0%');
    });
  });

  it('shows dash for success rate and avg cost when journal rows carry zero terminal events/runs', async () => {
    // Agent seen in the journal (e.g. only mission.step events): runs > 0
    // is possible with completed+failed === 0 — success rate must be "—",
    // not "NaN%" or a fabricated 0%.
    queryAgentStatsSpy.mockResolvedValue([
      statsRow('test-writer', { runs: 2, completed: 0, failed: 0, total_cost_usd: 0 }),
    ]);
    renderRoster();

    const statsCell = await screen.findByTestId('roster-agent-stats-test-writer');
    await waitFor(() => {
      expect(statsCell.textContent).toContain('2'); // runs are real
      expect(statsCell.textContent).toContain('—'); // success rate honest dash
      expect(statsCell.textContent).not.toContain('NaN');
    });
  });

  it('degrades to dashes when the stats query resolves [] (backend unavailable)', async () => {
    queryAgentStatsSpy.mockResolvedValue([]);
    renderRoster();

    const statsCell = await screen.findByTestId('roster-agent-stats-test-writer');
    await waitFor(() => {
      expect(statsCell.textContent).toContain('—');
    });
    // The roster itself (grouping, pills) still renders fully.
    expect(screen.getByTestId('roster-agent-security-reviewer')).toBeInTheDocument();
  });
});
