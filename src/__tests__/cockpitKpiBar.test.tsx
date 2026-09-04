import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { CockpitKpiBar } from '../components/agents/CockpitKpiBar';
import {
  recordUsage,
  recordBrainSavings,
  recordMissionCompleted,
  __resetUsageHistory,
} from '../lib/models/usageHistory';
import { recordRecallSaving, resetCost } from '../lib/models/costStore';
import type { Mission } from '../lib/agents/types';
import type { PoolStatusEntry } from '../lib/agents/scheduler';

// ── scheduler mock — the KPI tile must be driven by the REAL scheduler's
// poolStatus() (running/cap/queued per pool), not the durable per-project
// mission queue. Default: no pool has activity (tile hidden), overridden
// per test below.
const mockPoolStatus = vi.fn<() => PoolStatusEntry[]>(() => []);
vi.mock('../lib/agents/scheduler', () => ({
  poolStatus: () => mockPoolStatus(),
}));

const MOCK_MISSIONS: Mission[] = [
  { id: 'm1', title: 'Fix auth bug', status: 'running', model: 'Haiku 4.5' },
  { id: 'm2', title: 'Add tests', status: 'review', model: 'Sonnet 4.6' },
  { id: 'm3', title: 'Refactor DB', status: 'done', model: 'Haiku 4.5' },
  { id: 'm4', title: 'Update docs', status: 'queued', model: 'Haiku 4.5' },
];

function renderBar(missions: Mission[] = MOCK_MISSIONS) {
  return render(
    <I18nProvider>
      <CockpitKpiBar missions={missions} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  __resetUsageHistory();
  resetCost();
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('lazy:usageHistory');
    // Force English locale for deterministic assertions
    localStorage.setItem('lazy.locale', 'en');
  }
  mockPoolStatus.mockReset();
  mockPoolStatus.mockReturnValue([]);
});

describe('CockpitKpiBar — window selector', () => {
  it('renders all three window buttons', () => {
    renderBar([]);
    expect(screen.getByTestId('window-today')).toBeInTheDocument();
    expect(screen.getByTestId('window-7d')).toBeInTheDocument();
    expect(screen.getByTestId('window-all')).toBeInTheDocument();
  });

  it('today button is initially active', () => {
    renderBar([]);
    const todayBtn = screen.getByTestId('window-today');
    // Active button gets background #7C5CFF — jsdom normalizes to rgb()
    expect(todayBtn.style.background).toBe('rgb(124, 92, 255)');
  });

  it('clicking 7d makes it active and deactivates today', () => {
    renderBar([]);
    fireEvent.click(screen.getByTestId('window-7d'));
    expect(screen.getByTestId('window-7d').style.background).toBe('rgb(124, 92, 255)');
    expect(screen.getByTestId('window-today').style.background).not.toBe('rgb(124, 92, 255)');
  });

  it('switches through all windows without crash', () => {
    renderBar([]);
    fireEvent.click(screen.getByTestId('window-7d'));
    fireEvent.click(screen.getByTestId('window-all'));
    fireEvent.click(screen.getByTestId('window-today'));
    expect(screen.getByTestId('window-today')).toBeInTheDocument();
  });
});

describe('CockpitKpiBar — zero state', () => {
  it('renders the banner with zero missions and no usage', () => {
    renderBar([]);
    // Should not throw
    expect(screen.getByTestId('window-today')).toBeInTheDocument();
  });

  it('shows 0 credits when no cost recorded', () => {
    renderBar([]);
    // Multiple metrics show "0" at zero state — cost is one of them
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(1);
  });

  it('shows formatted zero tokens', () => {
    renderBar([]);
    // totalTokens = 0 → "0"
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(1);
  });
});

describe('CockpitKpiBar — token display', () => {
  it('shows formatted token total after recording usage', () => {
    recordUsage({ inputTokens: 1000, outputTokens: 500, costUsd: 0, model: 'test' });
    renderBar([]);
    // 1500 total → "1.5k"
    expect(screen.getByText('1.5k')).toBeInTheDocument();
  });

  it('formats large token counts in millions', () => {
    recordUsage({ inputTokens: 1_000_000, outputTokens: 240_000, costUsd: 0, model: 'test' });
    renderBar([]);
    // 1_240_000 → "1.24M"
    expect(screen.getByText('1.24M')).toBeInTheDocument();
  });
});

describe('CockpitKpiBar — cost display', () => {
  it('shows formatted cost after recording', () => {
    recordUsage({ inputTokens: 0, outputTokens: 0, costUsd: 2.5, model: 'test' });
    renderBar([]);
    // 2.5 USD → 250 credits
    expect(screen.getByText('250')).toBeInTheDocument();
  });

  it('accumulates cost across multiple calls', () => {
    recordUsage({ inputTokens: 0, outputTokens: 0, costUsd: 1.0, model: 'test' });
    recordUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0.5, model: 'test' });
    renderBar([]);
    // 1.5 USD → 150 credits
    expect(screen.getByText('150')).toBeInTheDocument();
  });
});

describe('CockpitKpiBar — brain savings', () => {
  it('shows brain token savings', () => {
    recordBrainSavings(5000);
    renderBar([]);
    // 5000 → "5.0k"
    expect(screen.getByText('5.0k')).toBeInTheDocument();
  });

  it('shows percentage when usage is also recorded', () => {
    recordUsage({ inputTokens: 4000, outputTokens: 1000, costUsd: 0, model: 'test' });
    recordBrainSavings(5000);
    renderBar([]);
    // brainPct = 5000 / (5000 + 5000) = 50%
    expect(screen.getByText(/50%/)).toBeInTheDocument();
  });

  // Root-cause regression coverage: recordBrainSavings alone (Codeur chat's
  // only wired path, pre-fix) is not how mission/tool/manager recalls save —
  // they go through costStore.recordRecallSaving. Prove the tile reflects
  // THAT path too, end to end (recordRecallSaving -> usageHistory -> KPI).
  it('reflects a mission-sourced recall recorded via recordRecallSaving', () => {
    recordRecallSaving({ tokensSaved: 6020 }, 'mission');
    renderBar([]);
    // 6020 → "6.0k"
    expect(screen.getByText('6.0k')).toBeInTheDocument();
  });

  it('accumulates recalls from every wired surface (codeur/mission/manager/tool) into one honest total', () => {
    recordRecallSaving({ tokensSaved: 1000 }, 'codeur');
    recordRecallSaving({ tokensSaved: 2000 }, 'mission');
    recordRecallSaving({ tokensSaved: 1500 }, 'manager');
    recordRecallSaving({ tokensSaved: 500 }, 'tool');
    renderBar([]);
    // 1000 + 2000 + 1500 + 500 = 5000 → "5.0k"
    expect(screen.getByText('5.0k')).toBeInTheDocument();
  });

  it('never records a discarded/empty recall (e.g. an unused scope-fallback candidate)', () => {
    recordRecallSaving({ tokensSaved: 0 }, 'codeur');
    recordRecallSaving(null, 'mission');
    renderBar([]);
    // Honest zero — no fake floor.
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(1);
  });

  it('shows a tooltip explaining the estimation method, even at the honest zero', () => {
    renderBar([]);
    expect(screen.getByText('Brain saved').closest('div')).toHaveAttribute(
      'title',
      'estimate: full context avoided minus context actually injected, measured on every recall',
    );
  });

  it('keeps the same tooltip once real savings are recorded', () => {
    recordRecallSaving({ tokensSaved: 3000 }, 'mission');
    renderBar([]);
    expect(screen.getByText('Brain saved').closest('div')).toHaveAttribute(
      'title',
      'estimate: full context avoided minus context actually injected, measured on every recall',
    );
  });
});

describe('CockpitKpiBar — missions from props', () => {
  it('counts live missions from the missions prop', () => {
    recordMissionCompleted();
    recordMissionCompleted();
    renderBar(MOCK_MISSIONS);
    // 2 missions completed → should see "2" for completed count
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders with empty missions array', () => {
    renderBar([]);
    expect(screen.getByTestId('window-today')).toBeInTheDocument();
  });
});

// ── Scheduler pool tile (T2.8 audit fix) ────────────────────────────
// The tile used to be driven by the durable per-project mission queue
// (listQueue), which measures a completely different thing than the
// scheduler's actual concurrency pools. It must now reflect the REAL
// scheduler poolStatus(): total running/cap slots and queued backlog
// summed across pools, plus a per-pool breakdown.
describe('CockpitKpiBar — scheduler pool tile', () => {
  it('does not render the Scheduler tile when no pool has activity', () => {
    mockPoolStatus.mockReturnValue([]);
    renderBar([]);
    expect(screen.queryByText(/Scheduler/i)).not.toBeInTheDocument();
  });

  it('renders total running/cap and queued summed across pools, plus a per-pool breakdown', () => {
    mockPoolStatus.mockReturnValue([
      { pool: 'claude-cli', running: 1, cap: 2, queued: 3 },
      { pool: 'managed', running: 2, cap: 4, queued: 0 },
    ]);
    renderBar([]);

    expect(screen.getByText('Scheduler')).toBeInTheDocument();
    // 1+2 running / 2+4 cap
    expect(screen.getByText('3/6')).toBeInTheDocument();
    // 3+0 queued, plus the per-pool breakdown
    expect(screen.getByText(/3 queued/)).toBeInTheDocument();
    expect(screen.getByText(/claude-cli 1\/2/)).toBeInTheDocument();
    expect(screen.getByText(/managed 2\/4/)).toBeInTheDocument();
  });
});
