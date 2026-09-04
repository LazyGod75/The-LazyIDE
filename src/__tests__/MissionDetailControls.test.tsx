/**
 * MissionDetailControls.test.tsx
 *
 * Regression coverage for the "Approve & merge is a silent no-op that LIES"
 * defect: MissionDetailControls used to pass a hardcoded DEFAULT_REPO = '.'
 * to approveMission/discardMission/force-approve instead of the real opened
 * project root. Rust's ensure_repo_in_project_root canonicalizes '.' to the
 * Tauri process's own cwd (not the opened project) and rejects the call as
 * "outside project root" — which agentsStore.tsx used to swallow
 * unconditionally, so the UI still showed success (see
 * agentsStore.mergeHonesty.test.tsx for that half of the fix).
 *
 * Fixed by resolving the real project root (agentsStore.tsx's shared,
 * exported resolveProjectRoot) before every one of these calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MissionDetailControls } from '../components/agents/MissionDetailControls';
import { ApproveBlockedError } from '../components/agents/approveGate';
import type { Mission } from '../lib/agents/types';
import type { RevertableMission } from '../components/agents/agentsStore';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
}));

const toastSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const approveMissionSpy = vi.fn();
const discardMissionSpy = vi.fn();
const revertMissionSpy = vi.fn();
const resolveProjectRootSpy = vi.fn();
const toggleLoopSpy = vi.fn();
const deleteLoopSpy = vi.fn();
const retryMissionSpy = vi.fn();
vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStore: () => ({
    stopMission: vi.fn(),
    pauseMission: vi.fn(),
    resumeMission: vi.fn(),
    takeoverMission: vi.fn(),
    returnFromTakeover: vi.fn(),
    approveMission: approveMissionSpy,
    discardMission: discardMissionSpy,
    revertMission: revertMissionSpy,
    toggleLoop: toggleLoopSpy,
    deleteLoop: deleteLoopSpy,
    retryMission: retryMissionSpy,
    deleteMission: vi.fn(),
  }),
  resolveProjectRoot: () => resolveProjectRootSpy(),
}));

const REAL_ROOT = 'C:\\Users\\user\\Documents\\cerveau\\Lazy';

const reviewMission: Mission = {
  id: 'm-review',
  title: 'Review mission',
  status: 'review',
  model: 'sonnet',
  worktree: 'agent/m-review-fix-thing',
};

// DEFECT B: MissionCard/MissionDetail showed no Pause/Delete for a loop — root
// cause was addMission never copying input.loopConfig onto the stored Mission
// (see agentsStore.test.tsx's create_loop tests + agentsStore.tsx's addMission
// fix), so mission.loopConfig was always undefined and this whole block (gated
// on `mission.loopConfig &&`) could never render. These tests exercise the
// block directly with a mission that DOES carry loopConfig (the now-correct
// shape) and prove the buttons wire to the real store methods.
const loopMission: Mission = {
  id: 'm-loop',
  title: 'Loop: watch tests',
  status: 'queued',
  model: 'haiku',
  worktree: '',
  loopConfig: {
    cadence: '15m',
    stopCondition: { kind: 'manual' },
    enabled: true,
    nextRunAt: '2026-01-01T00:15:00.000Z',
    iterationCount: 2,
    iterationMissionIds: ['M13', 'M14'],
  },
};

beforeEach(() => {
  toastSpy.mockClear();
  approveMissionSpy.mockReset().mockResolvedValue(undefined);
  discardMissionSpy.mockReset().mockResolvedValue(undefined);
  revertMissionSpy.mockReset().mockResolvedValue(undefined);
  resolveProjectRootSpy.mockReset().mockResolvedValue(REAL_ROOT);
  toggleLoopSpy.mockReset().mockResolvedValue(undefined);
  deleteLoopSpy.mockReset().mockResolvedValue(undefined);
  retryMissionSpy.mockReset();
});

describe('MissionDetailControls — loop controls (DEFECT B)', () => {
  it('shows cadence, iteration count and next-run for a loop mission', () => {
    render(
      <MissionDetailControls
        mission={loopMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    expect(screen.getByText('15m')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('Pause really flips the loop\'s enabled flag via toggleLoop, not just stops a run', () => {
    render(
      <MissionDetailControls
        mission={loopMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByText('agents.detail.pause'));

    expect(toggleLoopSpy).toHaveBeenCalledWith('m-loop', false);
  });

  it('Resume flips enabled back to true when the loop is already paused', () => {
    const pausedLoop: Mission = {
      ...loopMission,
      loopConfig: { ...loopMission.loopConfig!, enabled: false },
    };
    render(
      <MissionDetailControls
        mission={pausedLoop}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByText('agents.detail.resume'));

    expect(toggleLoopSpy).toHaveBeenCalledWith('m-loop', true);
  });

  it('Supprimer really unregisters the loop via deleteLoop and navigates back', () => {
    const onBackSpy = vi.fn();
    render(
      <MissionDetailControls
        mission={loopMission}
        onBack={onBackSpy}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByText('agents.detail.deleteLoop'));

    expect(deleteLoopSpy).toHaveBeenCalledWith('m-loop');
    expect(onBackSpy).toHaveBeenCalled();
  });
});

describe('MissionDetailControls — real repo path (no more DEFAULT_REPO=".")', () => {
  it('Approve & merge passes the real resolved project root, never "."', async () => {
    render(
      <MissionDetailControls
        mission={reviewMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('approve-btn'));

    await waitFor(() => expect(approveMissionSpy).toHaveBeenCalledTimes(1));
    expect(approveMissionSpy).toHaveBeenCalledWith('m-review', REAL_ROOT);
    expect(approveMissionSpy.mock.calls[0][1]).not.toBe('.');
  });

  it('Rejeter (discard) passes the real resolved project root, never "."', async () => {
    render(
      <MissionDetailControls
        mission={reviewMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('discard-btn'));

    await waitFor(() => expect(discardMissionSpy).toHaveBeenCalledTimes(1));
    expect(discardMissionSpy).toHaveBeenCalledWith('m-review', REAL_ROOT);
    expect(discardMissionSpy.mock.calls[0][1]).not.toBe('.');
  });

  it('force-approve passes the real resolved project root, never "."', async () => {
    approveMissionSpy.mockRejectedValueOnce(new ApproveBlockedError('Évaluation manquante'));

    render(
      <MissionDetailControls
        mission={reviewMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    // First click is blocked (no verdict) -> reveals the force-approve button.
    fireEvent.click(screen.getByTestId('approve-btn'));
    await waitFor(() => expect(screen.getByTestId('force-approve-btn')).toBeInTheDocument());

    approveMissionSpy.mockClear();
    approveMissionSpy.mockResolvedValueOnce(undefined);

    fireEvent.click(screen.getByTestId('force-approve-btn'));

    await waitFor(() => expect(approveMissionSpy).toHaveBeenCalledTimes(1));
    expect(approveMissionSpy).toHaveBeenCalledWith('m-review', REAL_ROOT, { force: true });
  });
});

describe('MissionDetailControls — revert button visible after approve (T1.7 / run-6c)', () => {
  // Mirrors the EXACT state approveMission (agentsStore.tsx) produces for a
  // mission that just went through "Approve & merge": status -> 'done',
  // merged -> true, plus the additive mergeSha captured from
  // agent_merge_worktree (T1.7 — see RevertableMission in agentsStore.tsx).
  const doneMission: RevertableMission = {
    id: 'm-done',
    title: 'Approved mission',
    status: 'done',
    model: 'sonnet',
    worktree: 'agent/m-done-fix-thing',
    merged: true,
  };

  it('renders the revert button for a mission that was just approved+merged to done', () => {
    const missionWithSha: RevertableMission = { ...doneMission, mergeSha: 'deadbeef00000000000000000000000000000001' };
    render(
      <MissionDetailControls
        mission={missionWithSha}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    expect(screen.getByTestId('revert-btn')).toBeInTheDocument();
  });

  it('still renders the revert button even when no mergeSha was captured (pre-T1.7 approval, or web/mock mode) — revertMission itself surfaces that error on click, the button is not gated on it', () => {
    render(
      <MissionDetailControls
        mission={doneMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    expect(screen.getByTestId('revert-btn')).toBeInTheDocument();
  });

  it('clicking revert calls revertMission with the resolved project root, after a confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const missionWithSha: RevertableMission = { ...doneMission, mergeSha: 'deadbeef00000000000000000000000000000001' };
    render(
      <MissionDetailControls
        mission={missionWithSha}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('revert-btn'));

    await waitFor(() => expect(revertMissionSpy).toHaveBeenCalledTimes(1));
    expect(revertMissionSpy).toHaveBeenCalledWith('m-done', REAL_ROOT);
  });

  it('hides the revert button once the mission has already been reverted', () => {
    render(
      <MissionDetailControls
        mission={{ ...doneMission, mergeSha: 'deadbeef00000000000000000000000000000001', reverted: true } as Mission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    expect(screen.queryByTestId('revert-btn')).not.toBeInTheDocument();
  });
});

describe('MissionDetailControls — honesty on real failure (no fake success)', () => {
  it('shows an error toast and does NOT navigate away when approveMission rejects for real', async () => {
    approveMissionSpy.mockRejectedValueOnce(new Error('agent_merge_worktree failed: outside project root'));
    const onBackSpy = vi.fn();

    render(
      <MissionDetailControls
        mission={reviewMission}
        onBack={onBackSpy}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('approve-btn'));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    const [message, type] = toastSpy.mock.calls[0];
    expect(type).toBe('error');
    expect(message).toMatch(/outside project root/);
    expect(onBackSpy).not.toHaveBeenCalled();
  });

  it('shows an error toast and does NOT navigate away when discardMission rejects for real', async () => {
    discardMissionSpy.mockRejectedValueOnce(new Error('agent_discard_worktree failed: outside project root'));
    const onBackSpy = vi.fn();

    render(
      <MissionDetailControls
        mission={reviewMission}
        onBack={onBackSpy}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('discard-btn'));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    const [message, type] = toastSpy.mock.calls[0];
    expect(type).toBe('error');
    expect(message).toMatch(/outside project root/);
    expect(onBackSpy).not.toHaveBeenCalled();
  });
});

// ── QA B15: Retry reachable for a judge-rejected 'review' mission ──────
//
// A rejected judge verdict leaves status 'review' (never 'failed' — see
// approveGate.ts's isJudgeRejected doc comment), so the review block's
// Approve/Discard/SaveAsAgent trio used to be the ONLY options; Retry was
// gated on status === 'failed', which this common case never reaches.
describe('MissionDetailControls — retry reachable for a judge-rejected review mission (QA B15)', () => {
  const rejectedReviewMission: Mission = {
    ...reviewMission,
    id: 'm-rejected',
    judgeVerdict: { score: 20, passed: false, risk: 'high', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z' },
  };

  it('shows a Retry button for a review mission the judge rejected', () => {
    render(
      <MissionDetailControls
        mission={rejectedReviewMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    expect(screen.getByTestId('review-retry-btn')).toBeInTheDocument();
  });

  it('clicking it calls retryMission and navigates back, same as the failed/cancelled path', () => {
    const onBackSpy = vi.fn();
    render(
      <MissionDetailControls
        mission={rejectedReviewMission}
        onBack={onBackSpy}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('review-retry-btn'));

    expect(retryMissionSpy).toHaveBeenCalledWith('m-rejected');
    expect(onBackSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT show Retry for a review mission still awaiting a verdict (not yet rejected)', () => {
    render(
      <MissionDetailControls
        mission={reviewMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    expect(screen.queryByTestId('review-retry-btn')).not.toBeInTheDocument();
  });

  it('does NOT show Retry for a review mission the judge actually approved', () => {
    const approvedReviewMission: Mission = {
      ...reviewMission,
      id: 'm-approved',
      judgeVerdict: { score: 95, passed: true, risk: 'low', reviewers: [], createdAt: '2026-07-01T00:00:00.000Z' },
    };
    render(
      <MissionDetailControls
        mission={approvedReviewMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    expect(screen.queryByTestId('review-retry-btn')).not.toBeInTheDocument();
  });
});

// â”€â”€ Retry-with-edit friction fix â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Human-facing counterpart to the manager's retry_mission "modifications.task"
// lever: a "Retry with edited task" button, pre-filled with the CURRENT task
// via window.prompt, so a badly-worded instruction can be corrected from the
// mission card itself instead of forcing a "Cloner" detour.
describe('MissionDetailControls â€” retry with edited task (friction fix)', () => {
  const failedMission: Mission = {
    id: 'm-failed',
    title: 'Failed mission',
    status: 'failed',
    model: 'sonnet',
    worktree: 'agent/m-failed-fix-thing',
    agentTask: 'the original (wrong) task text',
  };

  it('pre-fills the prompt with the current task and calls retryMission with the edited text', () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('the corrected task text');
    const onBackSpy = vi.fn();
    render(
      <MissionDetailControls
        mission={failedMission}
        onBack={onBackSpy}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('retry-edit-btn'));

    expect(promptSpy).toHaveBeenCalledWith(
      'agents.retry.editPrompt',
      'the original (wrong) task text',
    );
    expect(retryMissionSpy).toHaveBeenCalledWith('m-failed', { newTask: 'the corrected task text' });
    expect(onBackSpy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the prompt is cancelled (null)', () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    const onBackSpy = vi.fn();
    render(
      <MissionDetailControls
        mission={failedMission}
        onBack={onBackSpy}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('retry-edit-btn'));

    expect(retryMissionSpy).not.toHaveBeenCalled();
    expect(onBackSpy).not.toHaveBeenCalled();
  });

  it('does nothing when the edited text is identical to the current task (no real correction)', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('the original (wrong) task text');
    render(
      <MissionDetailControls
        mission={failedMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('retry-edit-btn'));

    expect(retryMissionSpy).toHaveBeenCalledWith('m-failed', undefined);
  });

  it('is also reachable from the Done state, alongside the plain Retry button', () => {
    const doneMission: Mission = { ...failedMission, id: 'm-done-2', status: 'done' };
    vi.spyOn(window, 'prompt').mockReturnValue('corrected');
    render(
      <MissionDetailControls
        mission={doneMission}
        onBack={vi.fn()}
        onSaveAsAgent={vi.fn()}
        isManagedEngine={false}
      />,
    );

    fireEvent.click(screen.getByTestId('retry-edit-btn'));

    expect(retryMissionSpy).toHaveBeenCalledWith('m-done-2', { newTask: 'corrected' });
  });
});
