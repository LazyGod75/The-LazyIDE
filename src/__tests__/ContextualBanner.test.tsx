import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ContextualBanner } from '../components/editor/codespace/ContextualBanner';
import type { CodeBanner } from '../lib/agents/codeBanner';
import type { FleetMission } from '../lib/agents/fleetMissions';

// Minimal passthrough i18n — mirrors the convention already used by
// BrainContextBanner.test.tsx for components that call useI18n()
// unconditionally.
vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../lib/agents/missionQuestion', () => ({
  recordMissionAnswer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/journal/projectId', () => ({
  projectIdFromRoot: vi.fn(() => 'project-1'),
}));

const pauseMission = vi.fn();
const resumeMission = vi.fn();
const interveneMission = vi.fn();
const retryMission = vi.fn();
const setSelectedMissionId = vi.fn();

let agentsStoreAvailable = true;
vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStoreOptional: () => (agentsStoreAvailable
    ? { pauseMission, resumeMission, interveneMission, retryMission, setSelectedMissionId }
    : null),
  useAgentsStoreActionsOptional: () => (agentsStoreAvailable
    ? { pauseMission, resumeMission, interveneMission, retryMission, setSelectedMissionId }
    : null),
  resolveProjectRoot: vi.fn().mockResolvedValue('/repo'),
}));

afterEach(() => {
  vi.clearAllMocks();
  agentsStoreAvailable = true;
});

function makeMission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Refactor pricing table',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: Date.now(),
    urgent: false,
    ...overrides,
  };
}

const noop = () => undefined;

describe('ContextualBanner — B18 pause/resume', () => {
  it('shows the "run" text + Pause button for an actively-running (non-paused) mission', () => {
    const banner: CodeBanner = { kind: 'run', mission: makeMission({ paused: false }) };
    render(<ContextualBanner banner={banner} onFollowCursor={noop} onDismiss={noop} />);

    expect(screen.getByText(/codespace\.banner\.run/)).toBeInTheDocument();
    expect(screen.getByText('codespace.banner.pauseAgent')).toBeInTheDocument();
    expect(screen.queryByText('codespace.banner.resumeAgent')).not.toBeInTheDocument();
  });

  it('clicking Pause calls agentsStore.pauseMission and keeps the banner mounted (no onDismiss)', () => {
    const banner: CodeBanner = { kind: 'run', mission: makeMission({ paused: false }) };
    const onDismiss = vi.fn();
    render(<ContextualBanner banner={banner} onFollowCursor={noop} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('codespace.banner.pauseAgent'));

    expect(pauseMission).toHaveBeenCalledWith('m1');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('shows the "paused" text + Resume button once the mission is paused (Mission.paused mirrored on FleetMission)', () => {
    const banner: CodeBanner = { kind: 'run', mission: makeMission({ paused: true }) };
    render(<ContextualBanner banner={banner} onFollowCursor={noop} onDismiss={noop} />);

    expect(screen.getByText(/codespace\.banner\.paused/)).toBeInTheDocument();
    expect(screen.getByText('codespace.banner.resumeAgent')).toBeInTheDocument();
    expect(screen.queryByText('codespace.banner.pauseAgent')).not.toBeInTheDocument();
  });

  it('clicking Resume calls agentsStore.resumeMission with the mission id', () => {
    const banner: CodeBanner = { kind: 'run', mission: makeMission({ paused: true }) };
    const onDismiss = vi.fn();
    render(<ContextualBanner banner={banner} onFollowCursor={noop} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('codespace.banner.resumeAgent'));

    expect(resumeMission).toHaveBeenCalledWith('m1');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('renders no Pause/Resume button when no agentsStore is available (e.g. AgentsSpace never mounted)', () => {
    agentsStoreAvailable = false;
    const banner: CodeBanner = { kind: 'run', mission: makeMission({ paused: false }) };
    render(<ContextualBanner banner={banner} onFollowCursor={noop} onDismiss={noop} />);

    expect(screen.queryByText('codespace.banner.pauseAgent')).not.toBeInTheDocument();
    expect(screen.queryByText('codespace.banner.resumeAgent')).not.toBeInTheDocument();
  });

  it('renders nothing for banner.kind === "none"', () => {
    const { container } = render(
      <ContextualBanner banner={{ kind: 'none' }} onFollowCursor={noop} onDismiss={noop} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not paint a blocked question as a failure, and names the agent', () => {
    const banner: CodeBanner = {
      kind: 'question',
      mission: makeMission({ agentName: 'Coder', pendingQuestion: 'Overwrite a.ts?' }),
      question: 'Overwrite a.ts?',
    };
    render(<ContextualBanner banner={banner} onFollowCursor={noop} onDismiss={noop} />);
    const root = screen.getByTestId('code-contextual-banner');
    expect(root).toHaveAttribute('data-kind', 'question');
    expect(screen.getByTestId('code-contextual-banner-cursor').textContent).toContain('Coder');
    expect(screen.getByTestId('code-contextual-banner-cursor').textContent).toContain('Overwrite a.ts?');
  });

  it('shows a review banner with the file cursor and Open in Cockpit, never Pause', () => {
    const banner: CodeBanner = {
      kind: 'review',
      mission: makeMission({
        status: 'review',
        agentName: 'Judge',
        liveAction: 'Running reviewer sub-agent…',
        diffFiles: [{ filename: 'src/auth.ts', added: 2, removed: 0 }],
      }),
    };
    render(<ContextualBanner banner={banner} onFollowCursor={noop} onDismiss={noop} />);
    const root = screen.getByTestId('code-contextual-banner');
    expect(root).toHaveAttribute('data-kind', 'review');
    expect(screen.getByText(/codespace\.banner\.review/)).toBeInTheDocument();
    expect(screen.getByTestId('code-contextual-banner-cursor').textContent).toContain('Judge');
    expect(screen.getByTestId('code-contextual-banner-cursor').textContent).toContain('auth.ts');
    expect(screen.getByTestId('code-contextual-banner-cursor').textContent).not.toContain('Running reviewer');
    expect(screen.getByText('codespace.banner.openInCockpit')).toBeInTheDocument();
    expect(screen.queryByText('codespace.banner.pauseAgent')).not.toBeInTheDocument();
  });
});
