/**
 * canvasZoneGhostRows.test.tsx — fix/canvas-ux R4d, dogfood defect #7 (R4c
 * flag): ProjectGroupNode's empty-zone "recent missions" ghost rows used to
 * key exclusively by `missionId` (`key={mission.missionId}`). A mission id
 * can be RECYCLED across generations (missionHistory.ts's own generation-
 * scoping concept — a retried/re-run mission keeps the same id but is a
 * distinct terminal row), so `lib/journal/zoneDigest.ts`'s `recentMissions`
 * CAN legitimately contain two entries sharing the same `missionId`. Two
 * React children with the identical key silently collapse/misrender
 * (React only guarantees identity by key, not by array position) — the
 * fix keys by `${missionId}-${index}` (an index-stable composite, the
 * documented fallback for the ideal (missionId, generation) key until
 * zoneDigest.ts itself surfaces a generation field — out of this file's
 * writable set, see nodes/ProjectGroupNode.tsx's own comment at the fix).
 *
 * Isolated in its own file (rather than added to canvasNodes.test.tsx)
 * specifically so mocking `useZoneDigest` here can't affect that file's
 * own (much larger) ProjectGroupNodeCard suite, which relies on the REAL
 * hook's honest "no Tauri backend" null digest.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { ProjectGroupNodeCard } from '../components/agents/canvas/nodes/ProjectGroupNode';
import type { ProjectNodeData } from '../components/agents/canvas/canvasTypes';
import type { ZoneDigest } from '../lib/journal/zoneDigest';

const RECYCLED_DIGEST: ZoneDigest = {
  lastActivity: { type: 'mission.completed', atMs: Date.now() },
  recentMissions: [
    // Same missionId, two DIFFERENT generations (a retried mission: it
    // failed once, was retried under the same id, then completed) — the
    // exact shape that collided under `key={mission.missionId}`.
    { missionId: 'm-retried', title: 'payment-flow-stripe (run 2)', terminalType: 'mission.completed', atMs: Date.now() },
    { missionId: 'm-retried', title: 'payment-flow-stripe (run 1)', terminalType: 'mission.failed', atMs: Date.now() - 60_000 },
  ],
  mergedTodayCount: 0,
  lastBrainActivity: null,
  brainNeuronsToday: 0,
};

vi.mock('../lib/journal/useZoneDigest', () => ({
  useZoneDigest: () => ({ digest: RECYCLED_DIGEST, loading: false }),
}));

function makeProjectData(overrides: Partial<ProjectNodeData> = {}): ProjectNodeData {
  return {
    projectId: 'p1',
    root: '/repo/p1',
    name: 'demo-shop',
    color: 'hsl(220 65% 62%)',
    collapsed: false,
    isActive: true,
    counts: { running: 0, urgent: 0, review: 0, failed: 0, done: 0, total: 0 },
    hasChildren: false,
    ...overrides,
  };
}

describe('ProjectGroupNode — recent-missions ghost rows, recycled-id key collision (fix/canvas-ux R4d defect #7)', () => {
  it('renders BOTH generations of a recycled mission id as distinct rows, never collapsed to one', () => {
    render(
      <I18nProvider>
        <ProjectGroupNodeCard data={makeProjectData()} />
      </I18nProvider>,
    );

    const rows = screen.getAllByTestId('zone-digest-mission-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('payment-flow-stripe (run 2)');
    expect(rows[1]).toHaveTextContent('payment-flow-stripe (run 1)');
  });
});
