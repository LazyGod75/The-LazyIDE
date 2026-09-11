/**
 * MissionDetail.test.tsx
 *
 * Pause button: must never be a clickable dead end — either wired to a
 * real action, or clearly disabled with an honest tooltip. Pause is REAL
 * for managed missions (see agentsStore.pauseMission), but this suite runs
 * outside Tauri, so isManagedAgentAvailable() is always false here and the
 * native (one-shot process) path applies — Pause must render disabled with
 * an honest tooltip instead of a dead click.
 *
 * Intervene box: for managed missions the instruction is REALLY delivered
 * to the running agent at its next step (agentsStore.interveneMission ->
 * managedAgent's drainIntervenes queue); for native missions it stays
 * honestly queued-but-not-delivered mid-run (see agentsStore.interveneMission
 * and runtime.ts's isLiveAgentAvailable doc comment). Either way the UI must
 * delegate to the real interveneMission store action — never fake a
 * local-only write — and must never show a blanket "success" toast that
 * overstates what happened.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { MissionDetail } from '../components/agents/MissionDetail';
import type { JudgeVerdict, Mission } from '../lib/agents/types';

vi.mock('../i18n', () => ({
  useI18n: () => ({
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

const stopMissionSpy = vi.fn();
const updateMissionSpy = vi.fn();
const interveneMissionSpy = vi.fn();
// importOriginal keeps resolveProjectRoot REAL (only useAgentsStore is
// stubbed) — MissionDetail.tsx now imports resolveProjectRoot from this
// module (extracted from its own former local resolveRepoPath, see the
// repoPath/worktreePath regression suites below), and those suites mock
// invoke('get_project_root') directly to exercise that real resolution
// logic. A full-replacement mock factory would silently shadow it with
// undefined instead.
vi.mock('../components/agents/agentsStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents/agentsStore')>();
  const actionsStub = () => ({
    stopMission: stopMissionSpy,
    pauseMission: vi.fn(),
    resumeMission: vi.fn(),
    interveneMission: interveneMissionSpy,
    approveMission: vi.fn(),
    discardMission: vi.fn(),
    updateMission: updateMissionSpy,
    toggleLoop: vi.fn(),
    deleteLoop: vi.fn(),
    retryMission: vi.fn(),
    deleteMission: vi.fn(),
  });
  return {
    ...actual,
    useAgentsStore: actionsStub,
    // MissionDetail's children (Controls/Intervene/Checkpoints) now read the
    // narrow action-only context — same spies, same shape.
    useAgentsStoreActions: actionsStub,
  };
});

// evaluateMission is mocked so handleRunReview's call can be inspected
// directly — this is what the repoPath regression test below asserts on.
const fakeVerdict: JudgeVerdict = {
  score: 80,
  passed: true,
  risk: 'low',
  reviewers: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};
// resolveWorktreePath is kept REAL (via importOriginal) rather than mocked:
// MissionDetail.tsx now imports it too, and the worktreePath regression test
// below exercises the actual join logic end-to-end, not a stand-in.
const evaluateMissionSpy = vi.fn().mockResolvedValue(fakeVerdict);
vi.mock('../lib/agents/evaluator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/evaluator')>();
  return {
    ...actual,
    evaluateMission: (...args: unknown[]) => evaluateMissionSpy(...args),
    deriveJudgesApproved: () => '0/0 approve',
  };
});

const runningMission: Mission = {
  id: 'm-running',
  title: 'Running mission',
  status: 'running',
  model: 'sonnet',
};

const reviewMission: Mission = {
  id: 'm-review',
  title: 'Review mission',
  status: 'review',
  model: 'sonnet',
  worktree: 'agent/m-review-fix-thing',
};

beforeEach(() => {
  toastSpy.mockClear();
  stopMissionSpy.mockClear();
  updateMissionSpy.mockClear();
  interveneMissionSpy.mockClear();
});

describe('MissionDetail — Pause button', () => {
  it('renders Pause as disabled with an honest tooltip instead of a dead button', () => {
    render(<MissionDetail mission={runningMission} onBack={vi.fn()} />);
    const pauseBtn = screen.getByTestId('pause-btn');
    expect(pauseBtn).toBeDisabled();
    expect(pauseBtn).toHaveAttribute('title', 'agents.detail.pauseUnavailableTitle');
  });

  it('Stop stays wired to the real stopMission action (regression check)', () => {
    render(<MissionDetail mission={runningMission} onBack={vi.fn()} />);
    fireEvent.click(screen.getByText('agents.detail.stop'));
    expect(stopMissionSpy).toHaveBeenCalledWith('m-running');
  });
});

describe('MissionDetail — Intervene box', () => {
  it('shows an honest disclaimer that live steering is not wired to the agent', () => {
    render(<MissionDetail mission={runningMission} onBack={vi.fn()} />);
    expect(screen.getByTestId('intervene-disclaimer')).toBeInTheDocument();
  });

  it('does not show a fake success toast when recording a note', () => {
    render(<MissionDetail mission={runningMission} onBack={vi.fn()} />);
    const input = screen.getByPlaceholderText('agents.detail.interventionPlaceholder');
    fireEvent.change(input, { target: { value: 'check the logs' } });
    fireEvent.click(screen.getByTestId('intervene-submit-btn'));

    // Native engine in this suite (no Tauri simulated, see the file header) —
    // the toast must stay honest that nothing reached the running agent,
    // never a blanket "success". This file's useI18n mock (above) echoes the
    // raw key back instead of translating it (same convention the rest of
    // this suite relies on — see e.g. the 'agents.detail.stop' /
    // 'agents.detail.pauseUnavailableTitle' assertions elsewhere in this
    // file), so the queued/native-engine key is asserted directly rather
    // than by matching translated prose — see MissionDetailIntervene.tsx's
    // interventionQueuedManaged/interventionQueuedNative keys (2026-08 i18n
    // pass, previously hardcoded French literals here).
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const [message, type] = toastSpy.mock.calls[0];
    expect(type).toBe('info');
    expect(type).not.toBe('success');
    expect(message).not.toBe('agents.detail.interventionQueuedManaged');
    expect(message).toBe('agents.detail.interventionQueuedNative');
  });

  it('delegates the intervention to the real interveneMission store action instead of writing a local-only timeline entry', () => {
    render(<MissionDetail mission={runningMission} onBack={vi.fn()} />);
    const input = screen.getByPlaceholderText('agents.detail.interventionPlaceholder');
    fireEvent.change(input, { target: { value: 'check the logs' } });
    fireEvent.click(screen.getByTestId('intervene-submit-btn'));

    // Real delivery (managed: queued to the running agent; native: honestly
    // not delivered mid-run) is agentsStore.interveneMission's job now — see
    // agentsStore.test.tsx. The component only forwards the raw text.
    expect(interveneMissionSpy).toHaveBeenCalledTimes(1);
    expect(interveneMissionSpy).toHaveBeenCalledWith('m-running', 'check the logs');

    // MissionDetail/MissionDetailIntervene must not fake a local timeline
    // write of their own — that was the old, honest-but-fake behavior this
    // suite used to lock in, now superseded by the real store action.
    expect(updateMissionSpy).not.toHaveBeenCalled();
  });

  it('does not render the intervene box at all once the mission is no longer running', () => {
    render(<MissionDetail mission={{ ...runningMission, status: 'done' }} onBack={vi.fn()} />);
    expect(screen.queryByTestId('intervene-disclaimer')).not.toBeInTheDocument();
  });
});

// ── Run review — repoPath regression (tester "path canonicalize failed") ──
//
// Real in-app bug: handleRunReview called evaluateMission with
// repoPath: DEFAULT_REPO ('.'), a relative path. evaluateMission derives the
// tester's worktree cwd from repoPath, so run_shell tried to canonicalize a
// relative path against the Tauri process's own cwd (not the project root)
// and crashed with "path canonicalize failed" — see evaluator.ts's
// runManagedTester guard for the other half of this fix.
describe('MissionDetail — Run review (repoPath regression)', () => {
  const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    evaluateMissionSpy.mockClear();
    mockedInvoke.mockReset();
  });

  it('resolves the real absolute project root and passes it as repoPath — never the relative "."', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_project_root') {
        return Promise.resolve('C:\\Users\\user\\Documents\\cerveau\\Lazy');
      }
      return Promise.resolve(undefined);
    });

    render(<MissionDetail mission={reviewMission} onBack={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-review-btn'));

    await waitFor(() => expect(evaluateMissionSpy).toHaveBeenCalledTimes(1));

    const opts = evaluateMissionSpy.mock.calls[0][1] as { repoPath: string };
    expect(opts.repoPath).toBe('C:\\Users\\user\\Documents\\cerveau\\Lazy');
    expect(opts.repoPath).not.toBe('.');
  });

  it('falls back to "." (never throws) when get_project_root is unavailable — evaluator.ts guards the rest', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_project_root') return Promise.reject(new Error('no project set'));
      return Promise.resolve(undefined);
    });

    render(<MissionDetail mission={reviewMission} onBack={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-review-btn'));

    await waitFor(() => expect(evaluateMissionSpy).toHaveBeenCalledTimes(1));

    const opts = evaluateMissionSpy.mock.calls[0][1] as { repoPath: string };
    expect(opts.repoPath).toBe('.');
  });
});

// ── Run review — worktreePath regression (2nd path bug: Windows \\?\ mix) ──
//
// Real in-app bug: handleRunReview called evaluateMission with only
// repoPath, never worktreePath, so evaluateMission's own fallback
// reconstructed the tester's cwd as `${repoPath}/.lazy/worktrees/${branch}`
// with a hardcoded '/'. repoPath is get_project_root's canonicalize()
// result, which on Windows is \\?\-prefixed (verbatim); verbatim paths
// forbid forward slashes, so the mixed-separator string crashed Rust's
// Path::canonicalize() even though the worktree directory really existed —
// "Tester unavailable — run_shell failed: path canonicalize failed". Fixed
// by having MissionDetail.tsx compute worktreePath itself via
// resolveWorktreePath (real implementation here, not mocked — see the
// vi.mock('../lib/agents/evaluator', ...) importOriginal above) and pass it
// explicitly alongside repoPath.
describe('MissionDetail — Run review (worktreePath regression — Windows \\?\\ separator mixing)', () => {
  const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    evaluateMissionSpy.mockClear();
    mockedInvoke.mockReset();
  });

  it('passes an explicit worktreePath derived from mission.worktree, correctly joined with the SAME separator as a Windows \\\\?\\ repoPath — never mixed with "/"', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_project_root') {
        return Promise.resolve('\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy');
      }
      return Promise.resolve(undefined);
    });

    render(<MissionDetail mission={reviewMission} onBack={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-review-btn'));

    await waitFor(() => expect(evaluateMissionSpy).toHaveBeenCalledTimes(1));

    const opts = evaluateMissionSpy.mock.calls[0][1] as {
      repoPath: string;
      worktreePath?: string;
    };
    expect(opts.worktreePath).toBe(
      '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy\\.lazy\\worktrees\\agent-m-review-fix-thing',
    );
    // The exact defect: a reconstructed path mixing the \\?\ verbatim prefix
    // with a literal '/' is what broke Rust's canonicalize().
    expect(opts.worktreePath).not.toContain('/');
  });

  it('still passes worktreePath (relative, evaluator.ts\'s own guard rejects it honestly) even when get_project_root is unavailable', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_project_root') return Promise.reject(new Error('no project set'));
      return Promise.resolve(undefined);
    });

    render(<MissionDetail mission={reviewMission} onBack={vi.fn()} />);
    fireEvent.click(screen.getByTestId('run-review-btn'));

    await waitFor(() => expect(evaluateMissionSpy).toHaveBeenCalledTimes(1));

    const opts = evaluateMissionSpy.mock.calls[0][1] as {
      repoPath: string;
      worktreePath?: string;
    };
    // repoPath falls back to '.' (DEFAULT_REPO); worktreePath is still
    // computed (never undefined) — evaluator.ts's isAbsolutePath guard is
    // what turns this into an honest "no valid worktree" verdict, not a
    // crash, so MissionDetail must not special-case it here.
    expect(opts.worktreePath).toBe('./.lazy/worktrees/agent-m-review-fix-thing');
  });
});

// QA B14: "Diff" and "Logs" used to both just open this drawer with no
// further signal, landing on the exact same top-of-drawer view. focusSection
// now scrolls+flashes the real target section and reports back via
// onFocusHandled — see AgentsSpace.tsx's mission:focusSection subscriber for
// the producer side of this wire.
describe('MissionDetail — focusSection (QA B14)', () => {
  beforeAll(() => {
    // jsdom does not implement scrollIntoView (same stub as
    // MissionDetailTranscript.test.tsx's own beforeAll).
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('scrolls to and flashes the diff card, then reports the request handled', () => {
    const onFocusHandled = vi.fn();
    const missionWithDiff: Mission = {
      ...reviewMission,
      diffFiles: [{ filename: 'src/foo.ts', added: 3, removed: 1 }],
    };
    render(
      <MissionDetail mission={missionWithDiff} onBack={vi.fn()} focusSection="diff" onFocusHandled={onFocusHandled} />,
    );

    const diffCard = screen.getByTestId('diff-card');
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(diffCard.classList.contains('focus-flash')).toBe(true);
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
  });

  it('scrolls to and flashes the transcript section for focusSection="logs"', () => {
    const onFocusHandled = vi.fn();
    const missionWithLog: Mission = {
      ...reviewMission,
      actionTimeline: [{ time: '10:00', text: 'did something' }],
    };
    const { container } = render(
      <MissionDetail mission={missionWithLog} onBack={vi.fn()} focusSection="logs" onFocusHandled={onFocusHandled} />,
    );

    const section = container.querySelector('#mission-transcript-section');
    expect(section).not.toBeNull();
    expect(section!.classList.contains('focus-flash')).toBe(true);
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
  });

  it('honest no-op (still reports handled, never throws) when the requested section has nothing to show', () => {
    const onFocusHandled = vi.fn();
    // reviewMission has no diffFiles/diffSnippet — DiffCard renders null.
    render(<MissionDetail mission={reviewMission} onBack={vi.fn()} focusSection="diff" onFocusHandled={onFocusHandled} />);

    expect(screen.queryByTestId('diff-card')).not.toBeInTheDocument();
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
  });

  it('does nothing when focusSection is not set (every entry point other than Diff/Logs)', () => {
    const onFocusHandled = vi.fn();
    render(<MissionDetail mission={reviewMission} onBack={vi.fn()} onFocusHandled={onFocusHandled} />);

    expect(onFocusHandled).not.toHaveBeenCalled();
  });
});
