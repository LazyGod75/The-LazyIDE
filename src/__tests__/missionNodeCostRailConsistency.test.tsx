/**
 * missionNodeCostRailConsistency.test.tsx
 *
 * 2026-08-19 dollar-kill incident follow-up — the flagrant display defect:
 * MissionNode.tsx rendered `liveMetricsLabel` (a raw "$X.XX · N tok" chip,
 * via MetaChip) immediately next to CostChip, which already said "No debit
 * — subscription" for the SAME native-rail mission at the SAME moment — one
 * chip implied real spend, the other said there was none.
 *
 * Proves both chips are now rail-aware and consistent:
 *   - a native-rail mission never renders a raw "$" figure in EITHER chip,
 *     and both agree it is a non-debited equivalent;
 *   - a managed-rail mission still shows its REAL cost (in credits) in both
 *     chips, unaffected.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { MissionNodeCard } from '../components/agents/canvas/nodes/MissionNode';
import {
  CanvasActionsProvider,
  DEFAULT_CANVAS_ACTIONS,
} from '../components/agents/canvas/chrome/CanvasActionsContext';
import type { MissionNodeData } from '../components/agents/canvas/canvasTypes';
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { Mission } from '../lib/agents/types';

// @xyflow/react's NodeResizer needs a live RF node context this fixture
// render never provides — stubbed to a no-op, same convention as
// canvasNodes.test.tsx (see that file's own header comment).
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, NodeResizer: () => null };
});

let storedMissions: Mission[] = [];
vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStoreOptional: () => ({ missions: storedMissions }),
  useAgentsStoreActionsOptional: () => null,
  useAgentsStoreMissionsOptional: () => storedMissions,
  resolveProjectRoot: vi.fn(),
}));

function makeFullMission(overrides: Partial<Mission>): Mission {
  return {
    id: 'm1',
    title: 'Fix login bug',
    status: 'running',
    model: 'sonnet',
    agentMetrics: {
      durationMs: 12_000,
      inputTokens: 15_000,
      outputTokens: 800,
      costUsd: 0.07,
      toolCount: 4,
    },
    ...overrides,
  };
}

function makeMissionData(missionOverrides: Partial<FleetMission> = {}): MissionNodeData {
  return {
    mission: {
      id: 'm1',
      title: 'Fix login bug',
      status: 'running',
      stage: 'code',
      model: 'sonnet',
      updatedMs: Date.now(),
      urgent: false,
      ...missionOverrides,
    },
    projectId: 'p1',
    isActiveProject: true,
  };
}

function renderCard(data: MissionNodeData) {
  return render(
    <I18nProvider>
      <CanvasActionsProvider value={DEFAULT_CANVAS_ACTIONS}>
        <MissionNodeCard data={data} zoomLevel="full" />
      </CanvasActionsProvider>
    </I18nProvider>,
  );
}

describe('MissionNode — cost chip rail consistency (2026-08-19 dollar-kill incident)', () => {
  it('a native-rail mission never shows a raw "$" figure, and both the metrics chip and the cost chip agree it is non-debited', () => {
    storedMissions = [makeFullMission({ model: 'claude-haiku-4-5' })];
    const data = makeMissionData({ model: 'claude-haiku-4-5' });
    renderCard(data);

    const metricsChip = screen.getByTestId('mission-node-metrics-chip');
    const costChip = screen.getByTestId('mission-node-cost-chip-m1');

    // Neither chip renders a raw dollar figure.
    expect(metricsChip.textContent).not.toContain('$');
    expect(costChip.textContent).not.toContain('$');

    // The cost chip explicitly says "no debit" — the metrics chip must
    // never contradict it with what looks like a real spent amount. Both
    // report the SAME credits-equivalent figure ($0.07 -> 7 credits),
    // marked "≈" in both places.
    expect(metricsChip.textContent).toContain('≈7');
    expect(costChip.textContent).toContain('≈7');
    expect(costChip.title).toBeTruthy(); // costNoDebitTitle tooltip present
  });

  it('a managed-rail mission still shows its REAL cost (credits) in both chips — unaffected', () => {
    storedMissions = [makeFullMission({ model: 'anthropic/claude-sonnet-5' })];
    const data = makeMissionData({ model: 'anthropic/claude-sonnet-5' });
    renderCard(data);

    const metricsChip = screen.getByTestId('mission-node-metrics-chip');
    const costChip = screen.getByTestId('mission-node-cost-chip-m1');

    expect(metricsChip.textContent).not.toContain('$');
    expect(costChip.textContent).not.toContain('$');
    // No "≈" — this is real, exact spend, not an equivalent.
    expect(metricsChip.textContent).toContain('7 cr');
    expect(metricsChip.textContent).not.toContain('≈');
    expect(costChip.textContent).toContain('7 cr');
    expect(costChip.textContent).not.toContain('≈');
  });
});
