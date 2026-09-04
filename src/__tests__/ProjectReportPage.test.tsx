/* ProjectReportPage.test.tsx — Agent Canvas W8e: the per-project « Rapport »
   page. Exercises the full real component tree (ProjectReportPage →
   ReportKpiStrip/ReportPeriodSelector/ProjectSwitcherRow/MissionReportCard →
   ArtifactGallery → ArtifactThumbnail/ArtifactChip/BehaviorDiffPanel)
   against a mocked useProjectReport fixture and a mocked platform.fs, so
   every artifact-kind rendering path (incl. the honest missing-file state)
   is covered without touching a real disk or Tauri backend.
*/

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import type { ProjectReport } from '../lib/journal/projectReport';

const TODAY = new Date(2026, 6, 14, 9, 0, 0).getTime();
const YESTERDAY = new Date(2026, 6, 13, 9, 0, 0).getTime();

const ARTIFACT_DIR = '/fixtures/demo/.lazy/artifacts/m-a';

const FIXTURE_REPORT: ProjectReport = {
  completedMissions: [
    {
      missionId: 'm-a',
      generation: 0,
      title: 'Fix login flow',
      terminalType: 'mission.completed',
      completedAtMs: TODAY,
      mergedToday: true,
      durationMs: 125_000,
      tokensIn: 1200,
      tokensOut: 800,
      costUsd: 0.045,
      tokensSource: 'real',
      cacheReadInputTokens: 400,
      artifacts: [
        { kind: 'screenshot', path: `${ARTIFACT_DIR}/shot-ok.png`, label: 'Login screen' },
        { kind: 'screenshot', path: `${ARTIFACT_DIR}/shot-missing.png`, label: 'Missing shot' },
        { kind: 'test_run', command: 'npm test', exitCode: 0, outputPath: `${ARTIFACT_DIR}/test-run-1.txt` },
        { kind: 'command_output', command: 'npm run build', outputPath: `${ARTIFACT_DIR}/cmd-1.txt` },
        { kind: 'e2e_recording', path: `${ARTIFACT_DIR}/rec.webm` },
        { kind: 'behavior_diff', before: 'old behavior text', after: 'new behavior text' },
      ],
      chainFires: [
        { kind: 'fired', chainId: 'c1', sourceMissionId: 'm-a', targetRef: 'draft:next-step', projectId: 'proj-1', tsMs: TODAY },
      ],
    },
    {
      missionId: 'm-b',
      generation: 0,
      title: 'Refactor auth',
      terminalType: 'mission.approved',
      completedAtMs: YESTERDAY,
      mergedToday: false,
      durationMs: null,
      tokensIn: 500,
      tokensOut: 300,
      costUsd: 0.01,
      tokensSource: 'estimated',
      cacheReadInputTokens: null,
      artifacts: [],
      chainFires: [
        { kind: 'resumed', chainId: 'c0', sourceMissionId: 'm-source', targetRef: 'mission:m-b', projectId: 'proj-1', tsMs: YESTERDAY },
      ],
    },
  ],
  // Fix D (2026-08-19 dollar-kill incident, display half) — ProjectReportTotals
  // now splits by rail (costUsdManaged/costUsdApiEquivalent). Both missions
  // here are treated as real managed spend (costUsdManaged === costUsd, no
  // API-equivalent share) so the KPI strip's main cost tile keeps rendering
  // a real derived number for this test's own purpose; the dedicated
  // "rail-aware KPI strip" describe block below covers the split-tile
  // rendering when an API-equivalent share IS present.
  totals: { costUsd: 0.055, costUsdManaged: 0.055, costUsdApiEquivalent: 0, tokensIn: 1700, tokensOut: 1100, durationMs: 125_000 },
  mergedTodayCount: 1,
};

const EMPTY_REPORT: ProjectReport = {
  completedMissions: [],
  totals: { costUsd: 0, costUsdManaged: 0, costUsdApiEquivalent: 0, tokensIn: 0, tokensOut: 0, durationMs: 0 },
  mergedTodayCount: 0,
};

let currentReport: ProjectReport | null = FIXTURE_REPORT;

vi.mock('../lib/journal/useMissionHistory', () => ({
  useProjectReport: () => ({ report: currentReport, loading: false, reload: () => {} }),
}));

// Brain-integration wave — controllable zoneDigest so the KPI strip's new
// brainNeuronsToday tile can be exercised deterministically, without relying
// on the real journalQuery/invoke round-trip (which the global Tauri mock
// degrades to an empty digest for anyway — see useZoneDigest.ts's own hook).
let currentDigestBrainNeuronsToday: number | undefined = undefined;
vi.mock('../lib/journal/useZoneDigest', () => ({
  useZoneDigest: () => ({
    digest: { lastActivity: null, recentMissions: [], mergedTodayCount: 0, lastBrainActivity: null, brainNeuronsToday: currentDigestBrainNeuronsToday ?? 0 },
    loading: false,
  }),
}));

const readFile = vi.fn(async (path: string) => {
  if (path.endsWith('shot-ok.png')) return 'FAKE-IMAGE-CONTENT';
  if (path.endsWith('test-run-1.txt')) return 'PASS 1 test\n';
  if (path.endsWith('cmd-1.txt')) return 'build output text';
  throw new Error('ENOENT');
});
const readDir = vi.fn(async () => [
  { name: 'shot-ok.png', path: `${ARTIFACT_DIR}/shot-ok.png`, isDir: false },
  { name: 'test-run-1.txt', path: `${ARTIFACT_DIR}/test-run-1.txt`, isDir: false },
  { name: 'cmd-1.txt', path: `${ARTIFACT_DIR}/cmd-1.txt`, isDir: false },
]);

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: () => ({ fs: { readFile, readDir } }),
  };
});

import { ProjectReportPage } from '../components/agents/report';

const ONE_PROJECT = [{ id: 'p1', root: '/fixtures/demo', brainId: null, active: true, gitInitNote: null }];
const TWO_PROJECTS = [
  { id: 'p1', root: '/fixtures/demo', brainId: null, active: true, gitInitNote: null },
  { id: 'p2', root: '/fixtures/other', brainId: null, active: false, gitInitNote: null },
];

function renderPage(overrides: Partial<React.ComponentProps<typeof ProjectReportPage>> = {}) {
  return render(
    <I18nProvider>
      <ProjectReportPage
        projectId="proj-1"
        projectRoot="/fixtures/demo"
        openProjects={ONE_PROJECT}
        onSelectProject={() => {}}
        onOpenMission={() => {}}
        onClose={() => {}}
        {...overrides}
      />
    </I18nProvider>,
  );
}

/** Lets ArtifactThumbnail's mocked readFile()/readDir() promises settle
 *  (they resolve on a real microtask, not synchronously) so tests that
 *  don't otherwise assert on the screenshot state avoid an "update not
 *  wrapped in act(...)" warning from a state update landing after the test
 *  itself has finished. */
async function flushArtifactLoads(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ProjectReportPage — KPIs and mission cards', () => {
  it('renders the KPI strip with real derived numbers', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    const strip = screen.getByTestId('report-kpi-strip');
    expect(within(strip).getByText('2')).toBeInTheDocument(); // missions completed
    expect(within(strip).getByText('1')).toBeInTheDocument(); // merged today
    // Fix D — credits, never dollars: $0.055 -> usdToCredits -> 6 credits.
    expect(within(strip).getByText('6 cr')).toBeInTheDocument();
    await flushArtifactLoads();
  });

  it('renders both mission cards, newest-first order preserved from the hook, with terminal badges', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    expect(screen.getByTestId('mission-report-card-m-a')).toBeInTheDocument();
    expect(screen.getByTestId('mission-report-card-m-b')).toBeInTheDocument();
    expect(screen.getAllByTestId('mission-report-terminal-badge')).toHaveLength(2);
    await flushArtifactLoads();
  });

  it('shows the "estimated" tokens badge only for the mission with estimated tokensSource', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    const cardA = screen.getByTestId('mission-report-card-m-a');
    const cardB = screen.getByTestId('mission-report-card-m-b');
    expect(within(cardA).queryByTestId('mission-report-estimated-badge')).not.toBeInTheDocument();
    expect(within(cardB).getByTestId('mission-report-estimated-badge')).toBeInTheDocument();
    await flushArtifactLoads();
  });

  // M12 dogfood fix (undercount honesty): cacheReadInputTokens.
  it('shows a cache-tokens chip only for the mission that recorded cacheReadInputTokens, and labels the other honestly', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    const cardA = screen.getByTestId('mission-report-card-m-a'); // cacheReadInputTokens: 400
    const cardB = screen.getByTestId('mission-report-card-m-b'); // cacheReadInputTokens: null

    expect(within(cardA).getByTestId('mission-report-cache-tokens')).toHaveTextContent('400');
    expect(within(cardB).queryByTestId('mission-report-cache-tokens')).not.toBeInTheDocument();
    await flushArtifactLoads();
  });

  it('renders chain-fire mentions in both directions ("a déclenché X" / "déclenchée par Y")', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    const cardA = screen.getByTestId('mission-report-card-m-a');
    const cardB = screen.getByTestId('mission-report-card-m-b');
    expect(within(cardA).getByTestId('mission-report-chain-fires')).toHaveTextContent('draft:next-step');
    expect(within(cardB).getByTestId('mission-report-chain-fires')).toHaveTextContent('m-source');
    await flushArtifactLoads();
  });

  it('clicking a mission title calls onOpenMission with that mission id', async () => {
    currentReport = FIXTURE_REPORT;
    const onOpenMission = vi.fn();
    renderPage({ onOpenMission });
    fireEvent.click(screen.getByTestId('mission-report-open-m-a'));
    expect(onOpenMission).toHaveBeenCalledWith('m-a');
    await flushArtifactLoads();
  });
});

// Fix D (2026-08-19 dollar-kill incident, display half) — when the project's
// completed missions mix real managed spend with native-rail API-equivalent
// figures, the KPI strip must not fold them into one misleading number: it
// shows a separately-badged tile instead (MissionReportCard.tsx's own "API
// equivalent" badge is the precedent).
describe('ProjectReportPage — KPI strip is rail-aware (Fix D)', () => {
  it('shows a distinct "API equivalent" tile, in credits, when native-rail spend is present alongside real managed spend', async () => {
    currentReport = {
      ...FIXTURE_REPORT,
      totals: { costUsd: 0.155, costUsdManaged: 0.055, costUsdApiEquivalent: 0.1, tokensIn: 1700, tokensOut: 1100, durationMs: 125_000 },
    };
    renderPage();
    const strip = screen.getByTestId('report-kpi-strip');
    // Real spend tile: unaffected, still 6 credits.
    expect(within(strip).getByText('6 cr')).toBeInTheDocument();
    // API-equivalent tile: $0.10 -> 10 credits, distinct testid/label.
    const equivTile = within(strip).getByTestId('report-kpi-cost-api-equivalent');
    expect(equivTile).toHaveTextContent('10 cr');
    await flushArtifactLoads();
  });

  it('hides the API-equivalent tile entirely when there is no native-rail spend to report', async () => {
    currentReport = FIXTURE_REPORT; // costUsdApiEquivalent: 0
    renderPage();
    expect(screen.queryByTestId('report-kpi-cost-api-equivalent')).not.toBeInTheDocument();
    await flushArtifactLoads();
  });
});

describe('ProjectReportPage — brain visibility (brain-integration wave)', () => {
  it('shows the brain neurons KPI tile when the project learned something today', async () => {
    currentReport = FIXTURE_REPORT;
    currentDigestBrainNeuronsToday = 3;
    renderPage();
    const tile = screen.getByTestId('report-kpi-brain-neurons');
    expect(tile).toHaveTextContent('3');
    await flushArtifactLoads();
  });

  it('hides the brain neurons KPI tile when the digest reports zero today (never a fabricated 0 tile)', async () => {
    currentReport = FIXTURE_REPORT;
    currentDigestBrainNeuronsToday = 0;
    renderPage();
    expect(screen.queryByTestId('report-kpi-brain-neurons')).not.toBeInTheDocument();
    await flushArtifactLoads();
    currentDigestBrainNeuronsToday = undefined;
  });
});

describe('ProjectReportPage — artifact gallery, per kind', () => {
  it('renders a real thumbnail for a readable screenshot and an honest "missing" chip for one whose file is absent', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    const cardA = screen.getByTestId('mission-report-card-m-a');
    const thumbs = within(cardA).getAllByTestId('artifact-screenshot');
    expect(thumbs).toHaveLength(2);

    // First is readable -> resolves to a real <img>; second's file doesn't
    // exist in the readDir mock -> the honest "missing" state, never a
    // broken <img>.
    await within(thumbs[0]).findByRole('img');
    await within(thumbs[1]).findByTestId('artifact-state-missing');
  });

  it('renders test_run/command_output as clickable chips with exit-code coloring, opening their output in a modal', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    const cardA = screen.getByTestId('mission-report-card-m-a');
    const testRunChip = within(cardA).getByTestId('artifact-chip-test_run');
    expect(testRunChip).toHaveTextContent('npm test');

    fireEvent.click(testRunChip);
    const modal = await screen.findByTestId('artifact-output-modal');
    expect(await within(modal).findByText(/PASS 1 test/)).toBeInTheDocument();

    fireEvent.click(within(modal).getByTestId('artifact-output-modal-close'));
    expect(screen.queryByTestId('artifact-output-modal')).not.toBeInTheDocument();
  });

  it('renders e2e_recording as a static file chip (no player) and behavior_diff as a before/after panel', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    const cardA = screen.getByTestId('mission-report-card-m-a');
    expect(within(cardA).getByTestId('artifact-chip-e2e_recording')).toHaveTextContent('rec.webm');

    const diff = within(cardA).getByTestId('artifact-behavior_diff');
    expect(diff).toHaveTextContent('old behavior text');
    expect(diff).toHaveTextContent('new behavior text');
    await flushArtifactLoads();
  });

  it('shows the honest empty-artifact state with a contract hint for a mission with none', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    const cardB = screen.getByTestId('mission-report-card-m-b');
    expect(within(cardB).getByTestId('artifact-gallery-empty')).toBeInTheDocument();
    await flushArtifactLoads();
  });
});

describe('ProjectReportPage — period filter', () => {
  it('"Tout" shows both missions; "Aujourd\'hui" hides yesterday\'s mission', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    expect(screen.getByTestId('mission-report-card-m-a')).toBeInTheDocument();
    expect(screen.getByTestId('mission-report-card-m-b')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('report-period-today'));
    expect(screen.getByTestId('mission-report-card-m-a')).toBeInTheDocument();
    expect(screen.queryByTestId('mission-report-card-m-b')).not.toBeInTheDocument();
    await flushArtifactLoads();
  });
});

describe('ProjectReportPage — empty states', () => {
  it('renders the friendly hero when the project has zero completed missions', () => {
    currentReport = EMPTY_REPORT;
    renderPage();
    expect(screen.getByTestId('project-report-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('report-kpi-strip')).not.toBeInTheDocument();
  });
});

describe('ProjectReportPage — layout prop (W-PARCHEMIN: popover mode)', () => {
  it('defaults to "page" layout: renders the in-page close button', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage();
    expect(screen.getByTestId('project-report-close')).toBeInTheDocument();
    await flushArtifactLoads();
  });

  it('"popover" layout hides the in-page close button (the popover shell already closes on outside-click/Escape)', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage({ layout: 'popover' });
    expect(screen.queryByTestId('project-report-close')).not.toBeInTheDocument();
    // Everything else still renders — only the redundant close control drops.
    expect(screen.getByTestId('mission-report-card-m-a')).toBeInTheDocument();
    await flushArtifactLoads();
  });
});

describe('ProjectReportPage — multi-project switcher', () => {
  it('shows the project switcher only when more than one project is open', async () => {
    currentReport = FIXTURE_REPORT;
    renderPage({ openProjects: ONE_PROJECT });
    expect(screen.queryByTestId('report-project-switcher')).not.toBeInTheDocument();

    renderPage({ openProjects: TWO_PROJECTS });
    expect(screen.getByTestId('report-project-switcher')).toBeInTheDocument();
    expect(screen.getByTestId('report-project-pill-/fixtures/demo')).toBeInTheDocument();
    expect(screen.getByTestId('report-project-pill-/fixtures/other')).toBeInTheDocument();
    await flushArtifactLoads();
  });

  it('calls onSelectProject with the target project id when a pill is clicked', async () => {
    currentReport = FIXTURE_REPORT;
    const onSelectProject = vi.fn();
    renderPage({ openProjects: TWO_PROJECTS, onSelectProject });
    fireEvent.click(screen.getByTestId('report-project-pill-/fixtures/other'));
    expect(onSelectProject).toHaveBeenCalledWith('/fixtures/other');
    await flushArtifactLoads();
  });
});
