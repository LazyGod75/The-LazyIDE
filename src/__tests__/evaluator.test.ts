/**
 * Tests for evaluator.ts's mode-aware evaluation pipeline:
 *   - buildUnavailableVerdict() when no Tauri runtime is present
 *   - evaluateLive() (native CLI, claude-code) — regression coverage for the
 *     shared-helper refactor (buildReviewerTask/buildSecurityTask/
 *     buildJudgeTask/aggregateVerdict)
 *   - evaluateScripted() (pro/live-key/mock — no engine) — regression coverage
 *   - evaluateManaged() (Pro/managed subscription) — the fix under test:
 *     tester via run_shell (ground truth, no LLM), reviewer/security/judge
 *     via streamManagedAgentTurn, so a Pro user gets a real verdict instead
 *     of the "Test runner unavailable — use the desktop app…" placeholder
 *     and a fabricated score of 0.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ── Mock getProviderMode so each test controls the active mode directly;
// getDefaultModelIdForMode and everything else in models/index stays real. ──
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(),
  };
});

// ── Mock managedProvider's streamManagedAgentTurn (the managed LLM call) ──
vi.mock('../lib/models/managedProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/managedProvider')>();
  return {
    ...actual,
    streamManagedAgentTurn: vi.fn(),
  };
});

// ── Mock platform — evaluateScripted / evaluateLive's fallback use `tests`;
// hasNoTestScriptConfigured (evaluator.ts) uses `fs.readFile` to probe
// package.json's "test" script BEFORE running anything. Hoisted so
// individual tests can grab `mockReadFile` directly (vi.mock's factory runs
// before the top-level `const` below would otherwise be initialized). ──
const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    tests: { run: vi.fn().mockRejectedValue(new Error('not available in test')) },
    fs: { readFile: mockReadFile },
  })),
}));

import {
  evaluateMission,
  resolveWorktreePath,
  deriveJudgesApproved,
  isVerificationMission,
  buildVerificationMissionReviewers,
  looksLikeAskedButNeverRan,
  looksLikeVacuousApproval,
  isVerdictScoreAvailable,
  formatVerdictScoreLine,
  parseReviewerResult,
  JUDGE_UNAVAILABLE_PROVIDER_REASON,
} from '../lib/agents/evaluator';
import type { Mission, MissionContract, JudgeVerdict, ReviewerVerdict } from '../lib/agents/types';
import { getProviderMode } from '../lib/models/index';
import { streamManagedAgentTurn } from '../lib/models/managedProvider';
import { getPlatform } from '../lib/platform';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListen = listen as ReturnType<typeof vi.fn>;
const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;
const mockedStream = streamManagedAgentTurn as ReturnType<typeof vi.fn>;
const mockedGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

/** Toggle the global flag that isTauriRuntime() reads. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'Fix the thing',
    status: 'review',
    model: 'anthropic/claude-sonnet-5',
    ...overrides,
  };
}

/** Builds a valid MissionContract fixture — proofs/gates/shareToTeam are
 *  required fields the objective-grading tests below don't exercise, so a
 *  single helper fills them with the pre-proof-gate default shape
 *  (no required proofs, both gates off, not shared) rather than repeating
 *  the same three fields at every call site. */
function makeContract(overrides: Partial<MissionContract> & Pick<MissionContract, 'objective' | 'model' | 'permissionMode' | 'budgetCapUsd'>): MissionContract {
  return {
    proofs: [],
    gates: { evaluators: false, humanApprove: false },
    shareToTeam: false,
    ...overrides,
  };
}

/** Creates an async generator that yields a single text chunk — mirrors
 *  managedAgent.test.ts's helper for streamManagedAgentTurn responses. */
async function* makeStream(text: string): AsyncIterable<string> {
  yield text;
}

/** Configures listen() to immediately resolve the "done" event for any
 *  agent_run-style evalId with the given result text, so runEvaluatorAgent
 *  (native path) doesn't hang forever waiting on an event that never fires
 *  under the default global mock (see src/__tests__/setup.ts). */
function mockAgentRunDone(resultText: string, exitCode = 0): void {
  mockedListen.mockImplementation((eventName: unknown, handler: unknown) => {
    const name = String(eventName);
    const cb = handler as (event: { payload: { result: string; exit_code: number } }) => void;
    if (name.startsWith('agent://done/')) {
      Promise.resolve().then(() => cb({ payload: { result: resultText, exit_code: exitCode } }));
    }
    return Promise.resolve(() => undefined);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedInvoke.mockResolvedValue(undefined);
  mockedListen.mockResolvedValue(() => undefined);
  // Default: a package.json WITH a real "test" script, so every existing
  // test in this file keeps exercising the real tester path unless it
  // explicitly overrides this (see the "no test script configured" describe
  // block below).
  mockReadFile.mockReset().mockResolvedValue(JSON.stringify({ scripts: { test: 'vitest run' } }));
  setTauriRuntime(true);
});

// ── No Tauri runtime at all ─────────────────────────────────────────

describe('evaluateMission — no Tauri runtime', () => {
  it('returns the honest unavailable placeholder, never a fabricated pass', async () => {
    setTauriRuntime(false);
    const onProgress = vi.fn();

    const verdict = await evaluateMission(makeMission(), { repoPath: '/repo', onProgress });

    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBe(0);
    expect(verdict.reviewers).toHaveLength(1);
    expect(verdict.reviewers[0].role).toBe('judge');
    expect(mockedStream).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());
  });
});

// ── Trust-critical defect #1 (M53 forensics) — diff coverage gap ───────────
// runtime.ts's Step C populates mission.diffIncompleteFiles when
// reviewPreflight.ts's detectDiffCoverageGap finds worktree content the
// computed diff doesn't represent. evaluateMission must refuse to run the
// normal judge pipeline in that case — reviewing a partial diff as if it
// were complete is exactly the M53 failure mode (README-only diff, real
// 19-file scaffold rejected unseen).

describe('evaluateMission — diff coverage gap (trust-critical defect #1)', () => {
  it('refuses to run judges and returns an explicit, never-fabricated verdict when files are missing from the diff', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    const onProgress = vi.fn();

    const verdict = await evaluateMission(
      makeMission({ diffIncompleteFiles: ['package.json', 'src/App.tsx'] }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1', onProgress },
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.scoreUnavailable).toBe(true);
    expect(verdict.reviewers).toHaveLength(1);
    expect(verdict.reviewers[0].inconclusive).toBe(true);
    expect(verdict.reviewers[0].summary).toContain('package.json');
    expect(verdict.reviewers[0].summary).toContain('src/App.tsx');

    // The whole point: no tester/reviewer/security/judge sub-agent ever ran
    // against the incomplete diff.
    expect(mockedInvoke).not.toHaveBeenCalledWith('agent_run', expect.anything());
    expect(mockedStream).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Diff incomplete'));
  });

  it('runs the normal judge pipeline as usual when diffIncompleteFiles is absent', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockAgentRunDone(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }));

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    expect(verdict.passed).toBe(true);
    const agentRunCalls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'agent_run');
    expect(agentRunCalls).toHaveLength(4);
  });

  it('runs the normal judge pipeline as usual when diffIncompleteFiles is an empty array', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockAgentRunDone(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }));

    const verdict = await evaluateMission(makeMission({ diffIncompleteFiles: [] }), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    expect(verdict.passed).toBe(true);
  });
});

// ── Trust-critical defect #2 (M2 forensics) — empty deliverable ───────────
// runtime.ts's Step C sets mission.emptyDeliverable when the mission's diff
// is genuinely EMPTY (reviewPreflight.ts's isDiffGenuinelyEmpty) AND it does
// not read as a legitimate diff-less verification/investigation task
// (isVerificationMission). evaluateMission must refuse to run the normal
// judge pipeline in that case — a mission that produced nothing must never
// collect an "approve" from any role (M2's exact failure: security approved
// "no code = no risk", the judge leaned on that, 1/2 approve on a mission
// that did nothing).

describe('evaluateMission — empty deliverable (trust-critical defect #2, M2 repro)', () => {
  it('refuses to run judges and returns an explicit, never-fabricated failure when the mission produced nothing — M2 repro', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    const onProgress = vi.fn();

    const verdict = await evaluateMission(
      makeMission({
        title: 'Consolider la base de code sur une branche de travail : intégrer le scaffold de M40',
        emptyDeliverable: true,
        diffFiles: [],
        diffSnippet: [],
        diffAdded: 0,
        diffRemoved: 0,
      }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-2', onProgress },
    );

    // Honest failure, never a fabricated pass.
    expect(verdict.passed).toBe(false);
    expect(verdict.scoreUnavailable).toBe(true);
    expect(verdict.reviewers).toHaveLength(1);
    expect(verdict.reviewers[0].inconclusive).toBe(true);
    expect(verdict.reviewers[0].summary).toMatch(/no deliverable|empty/i);

    // The whole point of M2: no role — tester, reviewer, security, judge —
    // ever gets a chance to report "approve" on a mission that did nothing.
    expect(verdict.reviewers.every((r) => r.verdict !== 'approve')).toBe(true);
    expect(mockedInvoke).not.toHaveBeenCalledWith('agent_run', expect.anything());
    expect(mockedStream).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('no deliverable'));
  });

  it('runs the normal judge pipeline as usual when emptyDeliverable is false (real diff present)', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockAgentRunDone(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }));

    const verdict = await evaluateMission(
      makeMission({ emptyDeliverable: false, diffFiles: [{ filename: 'src/x.ts', added: 3, removed: 0 }] }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    expect(verdict.passed).toBe(true);
  });

  it('runs the normal judge pipeline as usual when emptyDeliverable is absent (legacy missions predating this field)', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockAgentRunDone(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }));

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    expect(verdict.passed).toBe(true);
  });
});

// ── Native CLI (claude-code) — regression after the shared-helper refactor ──

describe('evaluateMission — native CLI (claude-code) regression', () => {
  it('spawns tester/reviewer/security/judge via agent_run and aggregates a passing verdict', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockAgentRunDone(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }));

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const agentRunCalls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'agent_run');
    expect(agentRunCalls).toHaveLength(4);
    const ids = agentRunCalls.map((c: unknown[]) => (c[1] as { req: { id: string } }).req.id);
    expect(ids).toEqual([
      'mission-1-tester',
      'mission-1-reviewer',
      'mission-1-security',
      'mission-1-judge',
    ]);

    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(80);
    expect(verdict.reviewers.map((r) => r.role)).toEqual(['tester', 'reviewer', 'security', 'judge']);
    expect(mockedStream).not.toHaveBeenCalled();
  });
});

// ── Native CLI (claude-code) — model ids (DEFECT C) ─────────────────────────
// Real QA capture (2026-07): every native sub-agent (tester/reviewer/
// security/judge) failed identically with "Evaluator exited with code 1".
// Root cause: evaluateLive hardcoded the bare aliases 'haiku'/'sonnet' as
// agent_run's `model` field — neither a valid native Anthropic id
// (registry.ts's ALL_MODELS, e.g. 'claude-haiku-4-5') nor an OpenRouter id —
// so the `claude` CLI rejected --model at startup, before doing any work,
// uniformly for every sub-agent.

describe('evaluateMission — native CLI (claude-code) — model ids (DEFECT C)', () => {
  it('uses full native Anthropic ids for every sub-agent, never the bare aliases the claude CLI rejects', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockAgentRunDone(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }));

    await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const agentRunCalls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'agent_run');
    const modelById: Record<string, string> = {};
    for (const call of agentRunCalls) {
      const req = (call[1] as { req: { id: string; model: string } }).req;
      modelById[req.id] = req.model;
    }

    // Cheap tier: tester/reviewer/security.
    expect(modelById['mission-1-tester']).toBe('claude-haiku-4-5');
    expect(modelById['mission-1-reviewer']).toBe('claude-haiku-4-5');
    expect(modelById['mission-1-security']).toBe('claude-haiku-4-5');
    // Stronger tier: judge.
    expect(modelById['mission-1-judge']).toBe('claude-sonnet-5');

    for (const model of Object.values(modelById)) {
      expect(model).not.toBe('haiku');
      expect(model).not.toBe('sonnet');
    }
  });
});

// ── Native CLI (claude-code) — honest error surfacing (DEFECT C) ───────────
// agent_run (agent.rs) always emits BOTH agent://done and agent://error
// together whenever the claude CLI process fails — done carries only the
// bare exit code, error carries the real reason (stderr / is_error detail).
// runEvaluatorAgent used to resolve as soon as EITHER event arrived, so the
// done event's generic message always won the race and the real reason was
// silently discarded.

describe('evaluateMission — native CLI (claude-code) — real error surfaced, not a bare exit code (DEFECT C)', () => {
  it('prefers the detailed agent://error message over the generic "Evaluator exited with code N"', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');

    // Every sub-agent's done event fires first (as Rust actually emits it)
    // reporting exit_code 1, with NO detail; the companion error event
    // fires shortly after with the real reason — mirrors agent_run's actual
    // contract (both events, done first) rather than the done-only shape
    // mockAgentRunDone provides.
    mockedListen.mockImplementation((eventName: unknown, handler: unknown) => {
      const name = String(eventName);
      if (name.startsWith('agent://done/')) {
        const cb = handler as (event: { payload: { result: string; exit_code: number } }) => void;
        Promise.resolve().then(() => cb({ payload: { result: '', exit_code: 1 } }));
      } else if (name.startsWith('agent://error/')) {
        const cb = handler as (event: { payload: string }) => void;
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => cb({ payload: "agent_run: 'claude' exited with code 1 — Unsupported model 'haiku'" }));
      }
      return Promise.resolve(() => undefined);
    });

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.summary).toContain("Unsupported model 'haiku'");
    expect(tester?.summary).not.toContain('Evaluator exited with code 1');
  });
});

// ── Native CLI (claude-code) — never hangs (DEFECT C) ───────────────────────

describe('evaluateMission — native CLI (claude-code) — never hangs on a bad spawn (DEFECT C)', () => {
  it('settles with an honest error instead of hanging forever when agent_run itself rejects before any event fires', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    // No done/error event will ever fire for any evalId — the old bug hung
    // forever in exactly this situation because invoke().catch() recorded
    // the error but never resolved the waiting promise.
    mockedListen.mockResolvedValue(() => undefined);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'agent_run') {
        return Promise.reject(new Error('ensure_repo_in_project: worktree_path is outside the project root'));
      }
      return Promise.resolve(undefined);
    });

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.verdict).toBe('request_changes');
    expect(tester?.summary).toContain('ensure_repo_in_project');
    expect(verdict.passed).toBe(false);
  });

  it('falls back to the generic exit-code message (without hanging) if the error event never arrives after a failing done event', async () => {
    vi.useFakeTimers();
    try {
      mockedGetProviderMode.mockReturnValue('claude-code');
      mockedListen.mockImplementation((eventName: unknown, handler: unknown) => {
        const name = String(eventName);
        if (name === 'agent://done/mission-1-tester') {
          const cb = handler as (event: { payload: { result: string; exit_code: number } }) => void;
          Promise.resolve().then(() => cb({ payload: { result: '', exit_code: 1 } }));
        } else if (name.startsWith('agent://done/')) {
          // reviewer/security/judge succeed normally — only the tester
          // exercises the grace-period fallback in this test.
          const cb = handler as (event: { payload: { result: string; exit_code: number } }) => void;
          Promise.resolve().then(() =>
            cb({
              payload: {
                result: JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }),
                exit_code: 0,
              },
            }),
          );
        }
        // agent://error/ deliberately never fires for any evalId.
        return Promise.resolve(() => undefined);
      });

      const missionPromise = evaluateMission(makeMission(), {
        repoPath: '/repo',
        worktreePath: '/repo/.lazy/worktrees/mission-1',
      });

      // Let the queued done-event microtasks run, then advance past the
      // tester's grace window (see EVALUATOR_ERROR_GRACE_MS in evaluator.ts).
      await vi.advanceTimersByTimeAsync(1000);

      const verdict = await missionPromise;
      const tester = verdict.reviewers.find((r) => r.role === 'tester');
      expect(tester?.summary).toContain('Evaluator exited with code 1');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Scripted fallback (pro / live-key / mock — no engine) — unchanged ──────

describe('evaluateMission — scripted fallback (pro/live-key/mock, no engine)', () => {
  it('mode="mock": a real, passing test run now lets the mission pass — reviewer/judge (no LLM in this mode) are honest non-votes, not a fabricated veto', async () => {
    mockedGetProviderMode.mockReturnValue('mock');
    mockedGetPlatform.mockReturnValue({
      tests: {
        run: vi.fn().mockResolvedValue({
          ok: true,
          tool: 'npm',
          total: 5,
          passed: 5,
          failed: 0,
          durationMs: 10,
          failures: [],
          raw: '',
        }),
      },
      // getPlatform is a mockReturnValue override here, which — unlike
      // mockReturnValueOnce — persists across every LATER test in this file
      // (vi.clearAllMocks() in beforeEach clears call history, not this
      // implementation override). Keeping `fs.readFile` wired to the same
      // shared mockReadFile as the module-level factory default means a
      // later test in this file that forgets to re-override getPlatform
      // still gets a working hasNoTestScriptConfigured probe instead of a
      // silent "fs is undefined" -> always-inconclusive false positive.
      fs: { readFile: mockReadFile },
    });

    const verdict = await evaluateMission(makeMission(), { repoPath: '/repo' });

    // Bug fixed here: this mode used to hardcode passed=false unconditionally,
    // so even a genuinely passing real test run could never clear evaluation.
    // B25: tester is conclusive; judge leaves the placeholder once any
    // conclusive vote exists. Reviewer stays inconclusive without a diff.
    expect(verdict.passed).toBe(true);
    expect(verdict.reviewers.map((r) => r.role)).toEqual(['tester', 'reviewer', 'judge']);
    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.inconclusive).toBeFalsy();
    expect(tester?.verdict).toBe('approve');
    expect(verdict.reviewers.find((r) => r.role === 'reviewer')?.inconclusive).toBe(true);
    expect(verdict.reviewers.find((r) => r.role === 'judge')?.inconclusive).toBeFalsy();
    expect(verdict.reviewers.find((r) => r.role === 'judge')?.verdict).toBe('approve');
    expect(mockedStream).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalledWith('agent_run', expect.anything());
    expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());
  });

  it('mode="mock" + real diff: scripted reviewer leaves the placeholder (B25)', async () => {
    mockedGetProviderMode.mockReturnValue('mock');
    mockedGetPlatform.mockReturnValue({
      tests: {
        run: vi.fn().mockResolvedValue({
          ok: true,
          tool: 'npm',
          total: 2,
          passed: 2,
          failed: 0,
          durationMs: 5,
          output: 'ok',
        }),
      },
      fs: { readFile: mockReadFile },
    });
    mockReadFile.mockResolvedValue(JSON.stringify({ scripts: { test: 'vitest run' } }));

    const verdict = await evaluateMission(
      makeMission({
        diffSnippet: ['@@ -1 +1 @@', '-old', '+new helper'],
        diffFiles: [{ filename: 'src/lib/foo.ts', added: 1, removed: 1 }],
      }),
      { repoPath: '/repo' },
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.reviewers.find((r) => r.role === 'reviewer')?.inconclusive).toBeFalsy();
    expect(verdict.reviewers.find((r) => r.role === 'reviewer')?.verdict).toBe('approve');
    expect(verdict.reviewers.find((r) => r.role === 'judge')?.inconclusive).toBeFalsy();
  });

  it('mode="mock": the real test runner is called against the mission worktree, never the stale base repoPath', async () => {
    mockedGetProviderMode.mockReturnValue('mock');
    const runFn = vi.fn().mockResolvedValue({
      ok: true,
      tool: 'npm',
      total: 1,
      passed: 1,
      failed: 0,
      durationMs: 5,
      failures: [],
      raw: '',
    });
    mockedGetPlatform.mockReturnValue({ tests: { run: runFn }, fs: { readFile: mockReadFile } });

    await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    // Bug fixed here: evaluateScripted used to be called with opts.repoPath
    // (pre-mission base state), silently grading the wrong code instead of
    // the mission's own diff.
    expect(runFn).toHaveBeenCalledWith('/repo/.lazy/worktrees/mission-1');
    expect(runFn).not.toHaveBeenCalledWith('/repo');
  });

  it('mode="mock": test runner genuinely unavailable — the tester is inconclusive (non-vote), never a fabricated rejection; this alone must not read as "reviewed and rejected"', async () => {
    mockedGetProviderMode.mockReturnValue('mock');
    mockedGetPlatform.mockReturnValue({
      tests: { run: vi.fn().mockRejectedValue(new Error('run_tests: no recognised test tool found')) },
      fs: { readFile: mockReadFile },
    });

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.inconclusive).toBe(true);
    expect(tester?.summary).toContain('Test runner unavailable');

    // Every role is a non-vote in this mode when the runner itself could not
    // run (no LLM reviewer/judge exists here either) — the honest outcome is
    // "could not evaluate" (0/0, score unavailable), never the old "0/2
    // approve" shape, which reads as two real reviewers having actively
    // rejected the work when neither ever ran.
    expect(deriveJudgesApproved(verdict)).toBe('0/0 approve');
    expect(verdict.scoreUnavailable).toBe(true);
  });
});

// ── B25 — live judge when a rail exists; honest inconclusive otherwise ──

describe('evaluateMission — B25 live-vs-placeholder routing', () => {
  it('prefers the managed (Pro) live judge pipeline over scripted placeholders', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') {
        return Promise.resolve({ stdout: 'Tests  1 passed (1)', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }),
      JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }),
      JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80, risk: 'low' }),
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const onProgress = vi.fn();
    const verdict = await evaluateMission(makeMission({ model: 'anthropic/claude-sonnet-4' }), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/m',
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(expect.stringMatching(/managed \(Pro\) evaluation/i));
    expect(mockedStream).toHaveBeenCalled();
    expect(verdict.scoreUnavailable).not.toBe(true);
    expect(verdict.reviewers.some((r) => r.role === 'judge' && r.inconclusive !== true)).toBe(true);
  });

  it('marks unavailable / no-runtime as scoreUnavailable — never a fabricated pass', async () => {
    setTauriRuntime(false);
    const verdict = await evaluateMission(makeMission(), { repoPath: '/repo' });
    expect(verdict.passed).toBe(false);
    expect(verdict.scoreUnavailable).toBe(true);
    expect(mockedStream).not.toHaveBeenCalled();
  });
});

// ── Managed (Pro) mode — the fix under test ─────────────────────────────

describe('evaluateMission — managed (Pro) mode', () => {
  beforeEach(() => {
    mockedGetProviderMode.mockReturnValue('managed');
  });

  it('produces a real numeric verdict: tester via run_shell, reviewer/security/judge via the managed LLM', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') {
        return Promise.resolve({ stdout: 'Tests  12 passed (12)', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(undefined);
    });

    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'Clean diff', score: 88 }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'No issues', score: 95 }), // security
      JSON.stringify({ verdict: 'approve', summary: 'Ship it', score: 90, risk: 'low' }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const onProgress = vi.fn();
    const verdict = await evaluateMission(makeMission({ model: 'anthropic/claude-opus-5' }), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
      onProgress,
    });

    // Tester ran via run_shell in the worktree — not agent_run/listen.
    expect(mockedInvoke).toHaveBeenCalledWith('run_shell', {
      command: 'npm test',
      cwd: '/repo/.lazy/worktrees/mission-1',
      timeoutMs: 120000,
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith('agent_run', expect.anything());
    expect(mockedListen).not.toHaveBeenCalled();

    // Reviewer/security/judge all went through the managed provider with the
    // mission's own (OpenRouter-format) model.
    expect(mockedStream).toHaveBeenCalledTimes(3);
    for (const invocation of mockedStream.mock.calls) {
      expect(invocation[0].model).toBe('anthropic/claude-opus-5');
    }

    expect(verdict.reviewers.map((r) => r.role)).toEqual(['tester', 'reviewer', 'security', 'judge']);
    expect(verdict.tests).toEqual({ passed: 12, failed: 0 });
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(90); // judge's own score wins
    expect(verdict.risk).toBe('low');

    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('managed'));
  });

  // fix/canvas-ux R10 — same leak class as the manager's sanitizeManagerDisplayText
  // fix (managerEngine.ts): a managed/reasoning-model sub-agent can spill whole
  // "[reasoning]…" lines ahead of its actual JSON verdict. Before this fix
  // parseReviewerResult read that raw text verbatim, so the leak rode straight
  // into ReviewerVerdict.summary — visible in Cockpit's "Rejeter avec feedback"
  // popover and the gate.failed journal payload.
  it('strips leaked [reasoning] channel lines from reviewer/security/judge summaries', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') {
        return Promise.resolve({ stdout: 'Tests  12 passed (12)', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(undefined);
    });

    const responses = [
      // reviewer — reasoning line (ANSI-prefixed, the real wire marker) ahead of the JSON verdict
      '\x1b[reasoning]Let me check the diff for style issues first.\n' +
        JSON.stringify({ verdict: 'approve', summary: 'Clean diff', score: 88 }),
      // security — bare "[reasoning]" tag (no ANSI byte), the shape QA actually saw leak
      '[reasoning]Scanning for hardcoded secrets.\n' +
        JSON.stringify({ verdict: 'approve', summary: 'No issues', score: 95 }),
      // judge — no JSON at all, forcing the heuristic text-fallback path
      '\x1b[reasoning]Aggregating reviewer verdicts now.\nLooks good, I approve this change.',
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(makeMission({ model: 'anthropic/claude-opus-5' }), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    for (const r of verdict.reviewers) {
      expect(r.summary).not.toContain('[reasoning]');
    }
    const reviewer = verdict.reviewers.find((r) => r.role === 'reviewer');
    expect(reviewer?.summary).toBe('Clean diff');
    const security = verdict.reviewers.find((r) => r.role === 'security');
    expect(security?.summary).toBe('No issues');
    const judge = verdict.reviewers.find((r) => r.role === 'judge');
    expect(judge?.summary).toContain('Looks good, I approve this change.');
  });

  it('tester failure (run_shell rejects) is honest — no fabricated pass — but reviewer/security/judge still run', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.reject(new Error('cwd is not a directory'));
      return Promise.resolve(undefined);
    });

    const responses = [
      JSON.stringify({ verdict: 'request_changes', summary: 'Cannot confirm tests pass', score: 40 }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'No security issues', score: 90 }), // security
      JSON.stringify({ verdict: 'request_changes', summary: 'No test evidence', score: 30, risk: 'medium' }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.verdict).toBe('request_changes');
    expect(tester?.summary).toContain('run_shell failed');
    // The old bug's canned message must be gone from the new path.
    expect(tester?.summary).not.toContain('desktop app');

    // Reviewer/security/judge still ran despite the tester failure.
    expect(mockedStream).toHaveBeenCalledTimes(3);
    expect(verdict.score).toBe(30); // real judge score, not a fabricated 0
    expect(verdict.passed).toBe(false);
  });

  it('a non-absolute worktreePath (e.g. derived from repoPath ".") is rejected before run_shell — honest "no valid path", not a canonicalize crash — reviewer/security/judge still run', async () => {
    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'ok', score: 90 }), // security
      JSON.stringify({ verdict: 'request_changes', summary: 'no test evidence', score: 40, risk: 'medium' }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    // Mirrors the real bug: MissionDetail.tsx used to call evaluateMission
    // with repoPath: '.' and no explicit worktreePath, so evaluateMission's
    // own fallback derived a relative worktreePath ('./.lazy/worktrees/…').
    const verdict = await evaluateMission(makeMission(), { repoPath: '.' });

    // The guard must reject the bad path BEFORE ever invoking run_shell.
    expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.verdict).toBe('request_changes');
    expect(tester?.summary).toContain('no valid worktree path');
    expect(tester?.summary).not.toMatch(/canonicalize/i);

    // Reviewer/security/judge are unaffected — in managed mode they only
    // ever call the LLM (runManagedEvaluatorAgent), never touch cwd/fs.
    expect(mockedStream).toHaveBeenCalledTimes(3);
    expect(verdict.reviewers.map((r) => r.role)).toEqual(['tester', 'reviewer', 'security', 'judge']);
    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBe(40); // real judge score, not a fabricated 0
  });

  it('an explicit absolute worktreePath is still used even when repoPath itself is relative (worktreePath takes precedence)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '2 passed (2)', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });
    mockedStream.mockImplementation(() =>
      makeStream(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80, risk: 'low' })),
    );

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '.',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    expect(mockedInvoke).toHaveBeenCalledWith('run_shell', {
      command: 'npm test',
      cwd: '/repo/.lazy/worktrees/mission-1',
      timeoutMs: 120000,
    });
    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.verdict).toBe('approve');
  });

  // ── Windows \\?\ separator-mixing regression (2nd path bug in this pipeline) ──
  //
  // Real in-app bug: MissionDetail.tsx passed only repoPath (never
  // worktreePath), so evaluateMission's own fallback reconstructed the
  // tester cwd as `${repoPath}/.lazy/worktrees/${branch}` with a hardcoded
  // '/'. repoPath is get_project_root's canonicalize() result, which on
  // Windows is \\?\-prefixed (verbatim) — verbatim paths forbid forward
  // slashes, so the mixed-separator string made Rust's Path::canonicalize()
  // fail even though the worktree directory really existed on disk.

  it('a Windows \\\\?\\ verbatim worktreePath passed explicitly is used byte-for-byte as cwd — no re-join, no separator mixing', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '1 passed (1)', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });
    mockedStream.mockImplementation(() =>
      makeStream(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80, risk: 'low' })),
    );

    const verbatimRepo = '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy';
    const verbatimWorktree = `${verbatimRepo}\\.lazy\\worktrees\\agent-m-review-fix-thing`;

    await evaluateMission(makeMission({ worktree: 'agent/m-review-fix-thing' }), {
      repoPath: verbatimRepo,
      worktreePath: verbatimWorktree,
    });

    expect(mockedInvoke).toHaveBeenCalledWith('run_shell', {
      command: 'npm test',
      cwd: verbatimWorktree,
      timeoutMs: 120000,
    });
    const runShellCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'run_shell');
    const cwdUsed = (runShellCall?.[1] as { cwd: string }).cwd;
    // A mixed-separator verbatim path (backslash prefix + literal forward
    // slashes appended) is exactly what broke Rust's canonicalize() — assert
    // the cwd actually used never mixes separators.
    expect(cwdUsed).not.toContain('/');
    expect(cwdUsed).toBe(verbatimWorktree);
  });

  it('falls back to reconstructing worktreePath from repoPath + mission.worktree using the SAME separator as repoPath — never a hardcoded "/" — when opts.worktreePath is not provided', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '1 passed (1)', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });
    mockedStream.mockImplementation(() =>
      makeStream(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80, risk: 'low' })),
    );

    await evaluateMission(makeMission({ worktree: 'agent/m-review-fix-thing' }), {
      repoPath: '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy',
      // No worktreePath — exercises evaluateMission's own fallback.
    });

    expect(mockedInvoke).toHaveBeenCalledWith('run_shell', {
      command: 'npm test',
      cwd: '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy\\.lazy\\worktrees\\agent-m-review-fix-thing',
      timeoutMs: 120000,
    });
  });

  it('reviewer sub-agent failure degrades gracefully and the pipeline continues to security/judge', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '3 passed (3)', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    mockedStream
      .mockImplementationOnce(() => {
        throw new Error('proxy 500');
      })
      .mockImplementationOnce(() => makeStream(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 90 })))
      .mockImplementationOnce(() =>
        makeStream(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 85, risk: 'low' })),
      );

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const reviewer = verdict.reviewers.find((r) => r.role === 'reviewer');
    expect(reviewer?.verdict).toBe('request_changes');
    expect(reviewer?.summary).toContain('Reviewer sub-agent failed');

    const security = verdict.reviewers.find((r) => r.role === 'security');
    expect(security?.verdict).toBe('approve');

    const judge = verdict.reviewers.find((r) => r.role === 'judge');
    expect(judge?.verdict).toBe('approve');
    expect(verdict.score).toBe(85);
  });

  describe('model resolution — reuses the mission model, then AccessSettings, then getDefaultModelIdForMode', () => {
    beforeEach(() => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'run_shell') return Promise.resolve({ stdout: '1 passed (1)', stderr: '', exitCode: 0 });
        return Promise.resolve(undefined);
      });
      mockedStream.mockImplementation(() =>
        makeStream(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80, risk: 'low' })),
      );
    });

    it("uses mission.model directly when it is already an OpenRouter-format id", async () => {
      await evaluateMission(makeMission({ model: 'anthropic/claude-opus-5' }), {
        repoPath: '/repo',
        worktreePath: '/wt',
      });
      expect(mockedStream.mock.calls[0][0].model).toBe('anthropic/claude-opus-5');
    });

    it('falls back to the saved AccessSettings model when mission.model has no "/"', async () => {
      localStorage.setItem('lazy.accessSettings', JSON.stringify({ model: 'anthropic/claude-haiku-4.5' }));
      await evaluateMission(makeMission({ model: 'haiku' }), {
        repoPath: '/repo',
        worktreePath: '/wt',
      });
      expect(mockedStream.mock.calls[0][0].model).toBe('anthropic/claude-haiku-4.5');
    });

    it('falls back to getDefaultModelIdForMode("managed") when neither mission.model nor AccessSettings has one', async () => {
      await evaluateMission(makeMission({ model: 'haiku' }), {
        repoPath: '/repo',
        worktreePath: '/wt',
      });
      expect(mockedStream.mock.calls[0][0].model).toBe('anthropic/claude-sonnet-5');
    });
  });
});

// ── DEFECT 1: eval-infra failure vs real test failure ──────────────────────
// Acceptance-test bug (2026-07): a mission's auto-evaluation scored a perfectly
// good change 0 / request_changes because an evaluator sub-agent could not run
// the test suite (it was stuck in plan mode / read-only) and the judge
// penalized the change for the EVALUATOR's own inability to execute. These
// tests pin the two-part fix: (1) an evaluator-infrastructure failure ("could
// not run the tests") is a NON-VOTE — it must never sink an otherwise-fine
// change to request_changes/0 — while (2) a REAL test failure ("tests ran and
// failed") still fails the change.

/** Configure the native (claude-code) agent_run path per evalId suffix:
 *  - 'reject'  → invoke('agent_run') rejects synchronously (infra failure:
 *    the sub-agent could not run — e.g. ensure_repo_in_project blew up).
 *  - a payload → invoke resolves and the agent://done event fires with that
 *    JSON as the sub-agent's result (exit 0).
 *  Any role not present in the map simply never fires (also an infra failure).
 */
function mockNativePerRole(
  roles: Record<string, 'reject' | Record<string, unknown>>,
): void {
  const roleOf = (name: string): string | undefined =>
    ['tester', 'reviewer', 'security', 'judge'].find((r) => name.endsWith(`-${r}`));

  mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === 'agent_run') {
      const id = (args as { req: { id: string } }).req.id;
      const role = roleOf(id);
      if (role && roles[role] === 'reject') {
        return Promise.reject(
          new Error('ensure_repo_in_project: worktree_path is outside the project root'),
        );
      }
      return Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  });

  mockedListen.mockImplementation((eventName: unknown, handler: unknown) => {
    const name = String(eventName);
    if (name.startsWith('agent://done/')) {
      const role = roleOf(name);
      const spec = role ? roles[role] : undefined;
      if (spec && spec !== 'reject') {
        const cb = handler as (e: { payload: { result: string; exit_code: number } }) => void;
        Promise.resolve().then(() =>
          cb({ payload: { result: JSON.stringify(spec), exit_code: 0 } }),
        );
      }
    }
    return Promise.resolve(() => undefined);
  });
}

/** Like mockNativePerRole, but for tests that need to control the RAW text a
 *  native sub-agent's `agent://done` event carries verbatim (rather than a
 *  JSON object mockNativePerRole would JSON.stringify) — needed for the
 *  "asked-but-never-ran" fixtures below, whose raw transcript text matters
 *  (blocked-approval keyword markers ahead of the JSON verdict), not just the
 *  parsed JSON shape. Every role in `rawByRole` fires its done event
 *  (exit_code 0) with that exact string; any role NOT present never fires
 *  (same "absent = infra failure" contract as mockNativePerRole). */
function mockNativePerRoleRaw(rawByRole: Record<string, string>): void {
  const roleOf = (name: string): string | undefined =>
    ['tester', 'reviewer', 'security', 'judge'].find((r) => name.endsWith(`-${r}`));

  mockedInvoke.mockImplementation((cmd: string) => (cmd === 'agent_run' ? Promise.resolve(undefined) : Promise.resolve(undefined)));

  mockedListen.mockImplementation((eventName: unknown, handler: unknown) => {
    const name = String(eventName);
    if (name.startsWith('agent://done/')) {
      const role = roleOf(name);
      const raw = role ? rawByRole[role] : undefined;
      if (raw !== undefined) {
        const cb = handler as (e: { payload: { result: string; exit_code: number } }) => void;
        Promise.resolve().then(() => cb({ payload: { result: raw, exit_code: 0 } }));
      }
    }
    return Promise.resolve(() => undefined);
  });
}

describe('evaluateMission — eval-infra failure is a non-vote, not a rejection (DEFECT 1)', () => {
  it('native: a tester that COULD NOT RUN (agent_run rejects) does not sink an otherwise-approved change — no request_changes/0', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    // Tester cannot run (infra); reviewer/security/judge all approve with real scores.
    mockNativePerRole({
      tester: 'reject',
      reviewer: { verdict: 'approve', summary: 'clean', score: 80 },
      security: { verdict: 'approve', summary: 'no issues', score: 90 },
      judge: { verdict: 'approve', summary: 'ship it', score: 88, risk: 'low' },
    });

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    // The tester's failure is flagged as inconclusive (it could not run) — a
    // non-vote — NOT counted as a code rejection.
    expect(tester?.inconclusive).toBe(true);
    expect(tester?.summary).toContain('ensure_repo_in_project');

    // The otherwise-fine change is NOT rejected and NOT scored 0.
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(88); // the judge's own real score, never a forced 0
  });

  it('native: even if the JUDGE itself could not run, an all-approve change still passes with a real score (fallback to conclusive consensus)', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    // Both the tester AND the judge sub-agents fail to run (infra); only the
    // reviewer + security actually produced verdicts.
    mockNativePerRole({
      tester: 'reject',
      reviewer: { verdict: 'approve', summary: 'clean', score: 80 },
      security: { verdict: 'approve', summary: 'no issues', score: 90 },
      judge: 'reject',
    });

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    expect(verdict.reviewers.find((r) => r.role === 'tester')?.inconclusive).toBe(true);
    expect(verdict.reviewers.find((r) => r.role === 'judge')?.inconclusive).toBe(true);

    // Judge is inconclusive → fall back to the conclusive reviewers' consensus
    // (both approve). Score is their average, never dragged to 0 by the two
    // infra failures.
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(85); // round(avg(80, 90))
  });

  it('native: a REAL test failure (tester RAN and tests failed) still fails the change — the contrast case', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    // Tester actually ran and reports real failures; judge agrees it fails.
    mockNativePerRole({
      tester: {
        verdict: 'request_changes',
        summary: '5 tests failed',
        score: 10,
        tests: { passed: 3, failed: 5 },
      },
      reviewer: { verdict: 'approve', summary: 'code ok', score: 80 },
      security: { verdict: 'approve', summary: 'no issues', score: 85 },
      judge: { verdict: 'request_changes', summary: 'tests are red', score: 15, risk: 'high' },
    });

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    // A tester that RAN is NEVER marked inconclusive — its failure is a real vote.
    expect(tester?.inconclusive).toBeFalsy();
    expect(tester?.verdict).toBe('request_changes');

    // Real failures still fail: passed=false, and the tester's real counts survive.
    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBe(15);
    expect(verdict.tests).toEqual({ passed: 3, failed: 5 });
  });

  it('managed: a tester that COULD NOT RUN (run_shell rejects) is inconclusive — an otherwise-approved change still passes', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.reject(new Error('cwd is not a directory'));
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'clean diff', score: 80 }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'no issues', score: 90 }), // security
      JSON.stringify({ verdict: 'approve', summary: 'ship it', score: 85, risk: 'low' }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.inconclusive).toBe(true);
    expect(tester?.summary).toContain('run_shell failed');

    // Only the tester was inconclusive; reviewer/security/judge approve → the
    // change passes with the judge's real score, never a forced 0.
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(85);
  });

  it('managed: a JUDGE that hits a definitive provider error (402) is inconclusive with the judge_unavailable_provider reason — an otherwise-approved change still passes, never a reject vote, never an exception (2026-08-05 DeepSeek 402 incident)', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'Tests  5 passed (5)', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });
    const { ProviderDefinitiveError } = await import('../lib/models/byokProviders');

    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'clean diff', score: 80 }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'no issues', score: 90 }), // security
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => {
      idx += 1;
      if (idx === 3) {
        // Judge call — the exact incident shape: DeepSeek 402 mid-evaluation.
        throw new ProviderDefinitiveError(402, 'deepseek', 'Insufficient Balance');
      }
      return makeStream(responses[idx - 1]);
    });

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    // Never hung, never threw out of the pipeline: evaluateMission resolved.
    expect(mockedStream).toHaveBeenCalledTimes(3);

    const judge = verdict.reviewers.find((r) => r.role === 'judge');
    expect(judge).toBeDefined();
    // Non-vote, not a rejection.
    expect(judge?.inconclusive).toBe(true);
    expect(judge?.verdict).not.toBe('reject');
    // Distinct, stable reason marker so downstream UI can tell "could not
    // run" apart from "ran and rejected" — see JUDGE_UNAVAILABLE_PROVIDER_REASON's doc comment.
    expect(judge?.summary).toContain(JUDGE_UNAVAILABLE_PROVIDER_REASON);
    expect(judge?.summary).toContain('Insufficient Balance');

    // The judge's own infra failure never drags the verdict down — the
    // conclusive non-judge reviewers (reviewer+security, both approve)
    // decide instead (DEFECT 1 non-vote rule), never a forced reject/0.
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(85); // round(avg(80, 90))
  });

  it('deriveJudgesApproved excludes an inconclusive reviewer from the denominator ("2/2", not "2/3")', () => {
    const reviewers: ReviewerVerdict[] = [
      { role: 'tester', verdict: 'request_changes', summary: 'could not run', inconclusive: true },
      { role: 'reviewer', verdict: 'approve', summary: 'ok' },
      { role: 'security', verdict: 'approve', summary: 'ok' },
      { role: 'judge', verdict: 'approve', summary: 'ok' },
    ];
    const verdict: JudgeVerdict = {
      score: 85,
      passed: true,
      risk: 'low',
      reviewers,
      createdAt: '2026-07-04T00:00:00.000Z',
    };
    expect(deriveJudgesApproved(verdict)).toBe('2/2 approve');
  });
});

// ── R11 — judge-score honesty: a judge (and, in this repro, every other
// role) that returns UNPARSABLE prose instead of JSON must never be trusted
// for `passed`, and the aggregate `score` must never silently fabricate a
// `0` without flagging it — the exact real-world bug: a judge's raw text
// failed to parse as JSON, a crude keyword-scan heuristic still detected
// "approve" in it (so the OLD code trusted that for `passed: true`), while
// `score` fell back to averaging every reviewer's score — which, since none
// of them had one either, silently became `0`: a fabricated « Verdict 0/100 »
// on what the heuristic itself had just called a PASSING mission.
describe('evaluateMission — judge-score honesty: unparsable-JSON path (R11)', () => {
  it('native: every role returns unparsable prose (no JSON) — passed derives honestly from the reviewers\' own heuristic consensus, and score is flagged scoreUnavailable instead of a fabricated 0/100', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');

    const rawByRole: Record<string, string> = {
      tester: 'Ran the suite manually and everything looks fine, I approve.',
      reviewer: 'Code reads cleanly, no concerns — I approve this diff.',
      security: 'No secrets or injection risks found — I approve.',
      judge: 'Aggregating the reviews above, I approve this change overall.',
    };
    mockedListen.mockImplementation((eventName: unknown, handler: unknown) => {
      const name = String(eventName);
      const role = ['tester', 'reviewer', 'security', 'judge'].find((r) => name.endsWith(`-${r}`));
      if (name.startsWith('agent://done/') && role) {
        const cb = handler as (e: { payload: { result: string; exit_code: number } }) => void;
        Promise.resolve().then(() => cb({ payload: { result: rawByRole[role], exit_code: 0 } }));
      }
      return Promise.resolve(() => undefined);
    });

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    // Every role "ran" (exit code 0) — none is an infra-failure non-vote —
    // but none produced parsable JSON, so none has a numeric score.
    for (const r of verdict.reviewers) {
      expect(r.inconclusive).toBeFalsy();
      expect(r.score).toBeUndefined();
      expect(r.verdict).toBe('approve'); // the heuristic text-fallback still reads "approve"
    }

    // `passed` derives from the conclusive NON-JUDGE reviewers' consensus
    // (tester/reviewer/security all heuristically "approve") — never a
    // blind trust of the judge's own equally-unparsable "approve" guess.
    expect(verdict.passed).toBe(true);
    // No real number exists anywhere — honestly flagged, never a bare 0.
    expect(verdict.scoreUnavailable).toBe(true);
    expect(verdict.score).toBe(0);
  });

  it('native: only the judge is unparsable, but reviewer/security/tester DID produce real scores — the honest reviewer-average wins, never scoreUnavailable', async () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    mockedListen.mockImplementation((eventName: unknown, handler: unknown) => {
      const name = String(eventName);
      const cb = handler as (e: { payload: { result: string; exit_code: number } }) => void;
      if (!name.startsWith('agent://done/')) return Promise.resolve(() => undefined);
      let result: string;
      if (name.endsWith('-tester')) result = JSON.stringify({ verdict: 'approve', summary: 'tests ok', score: 82 });
      else if (name.endsWith('-reviewer')) result = JSON.stringify({ verdict: 'approve', summary: 'clean', score: 80 });
      else if (name.endsWith('-security')) result = JSON.stringify({ verdict: 'approve', summary: 'no issues', score: 90 });
      else result = 'Looks good overall, I approve.'; // judge — no JSON at all
      Promise.resolve().then(() => cb({ payload: { result, exit_code: 0 } }));
      return Promise.resolve(() => undefined);
    });

    const verdict = await evaluateMission(makeMission(), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-1',
    });

    const judge = verdict.reviewers.find((r) => r.role === 'judge');
    expect(judge?.score).toBeUndefined();
    expect(judge?.inconclusive).toBeFalsy();

    // A real signal DOES exist (the three other conclusive reviewers all
    // have scores) — so this is never "unavailable", it's the honest average.
    expect(verdict.scoreUnavailable).toBeUndefined();
    expect(verdict.passed).toBe(true); // reviewer consensus, not the judge's shaky guess
    expect(verdict.score).toBe(84); // round(avg(82, 80, 90))
  });
});

// ── MAJEUR (R3 dogfood): tester false-negative on no-test repos ───────────
// A repo with no `npm test` script (or no package.json at all) used to make
// the tester fail STRUCTURALLY — npm's own "Missing script" exit code was
// indistinguishable from a real test failure, dragging the judge score to
// ~20-30 and forcing every merge on that project to need a manual override.
// hasNoTestScriptConfigured (evaluator.ts) now detects this BEFORE running
// anything (via platform.fs.readFile on package.json) and marks the tester
// inconclusive — a non-vote, per DEFECT 1's existing contract — instead of
// letting it read as a code rejection.

describe('evaluateMission — no test script configured (tester false-negative fix)', () => {
  describe('managed (Pro) mode', () => {
    beforeEach(() => {
      mockedGetProviderMode.mockReturnValue('managed');
    });

    it('no package.json at all: tester is inconclusive, run_shell is never invoked, judge scores on the remaining reviewers', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory, package.json'));

      const responses = [
        JSON.stringify({ verdict: 'approve', summary: 'clean diff', score: 82 }), // reviewer
        JSON.stringify({ verdict: 'approve', summary: 'no issues', score: 92 }), // security
        JSON.stringify({ verdict: 'approve', summary: 'ship it', score: 87, risk: 'low' }), // judge
      ];
      let idx = 0;
      mockedStream.mockImplementation(() => makeStream(responses[idx++]));

      const verdict = await evaluateMission(makeMission(), {
        repoPath: '/repo',
        worktreePath: '/repo/.lazy/worktrees/mission-1',
      });

      const tester = verdict.reviewers.find((r) => r.role === 'tester');
      expect(tester?.inconclusive).toBe(true);
      expect(tester?.summary).toContain('No test script configured');
      expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());

      // The judge score is NOT dragged down by the structural absence — the
      // real judge score (from the conclusive reviewers) wins, never a ~20-30.
      expect(verdict.passed).toBe(true);
      expect(verdict.score).toBe(87);
    });

    it('package.json with no "test" script: tester is inconclusive (not a ~20 score)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ scripts: { build: 'tsc' } }));

      const responses = [
        JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }),
        JSON.stringify({ verdict: 'approve', summary: 'ok', score: 90 }),
        JSON.stringify({ verdict: 'approve', summary: 'ok', score: 85, risk: 'low' }),
      ];
      let idx = 0;
      mockedStream.mockImplementation(() => makeStream(responses[idx++]));

      const verdict = await evaluateMission(makeMission(), {
        repoPath: '/repo',
        worktreePath: '/repo/.lazy/worktrees/mission-1',
      });

      const tester = verdict.reviewers.find((r) => r.role === 'tester');
      expect(tester?.inconclusive).toBe(true);
      expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());
      expect(verdict.score).toBe(85);
    });

    it('package.json with npm init\'s own placeholder test script: treated the same as "no test script"', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      );
      mockedStream.mockImplementation(() =>
        makeStream(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80, risk: 'low' })),
      );

      const verdict = await evaluateMission(makeMission(), {
        repoPath: '/repo',
        worktreePath: '/repo/.lazy/worktrees/mission-1',
      });

      const tester = verdict.reviewers.find((r) => r.role === 'tester');
      expect(tester?.inconclusive).toBe(true);
      expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());
    });

    it('a REAL test script still runs normally through run_shell (regression: the detector must not false-positive)', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ scripts: { test: 'vitest run' } }));
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'run_shell') return Promise.resolve({ stdout: '4 passed (4)', stderr: '', exitCode: 0 });
        return Promise.resolve(undefined);
      });
      mockedStream.mockImplementation(() =>
        makeStream(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80, risk: 'low' })),
      );

      const verdict = await evaluateMission(makeMission(), {
        repoPath: '/repo',
        worktreePath: '/repo/.lazy/worktrees/mission-1',
      });

      const tester = verdict.reviewers.find((r) => r.role === 'tester');
      expect(tester?.inconclusive).toBeFalsy();
      expect(tester?.verdict).toBe('approve');
      expect(mockedInvoke).toHaveBeenCalledWith('run_shell', expect.objectContaining({ command: 'npm test' }));
    });
  });

  describe('native CLI (claude-code) mode', () => {
    it('no package.json at all: tester is inconclusive without ever spawning the tester sub-agent via agent_run', async () => {
      mockedGetProviderMode.mockReturnValue('claude-code');
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      mockAgentRunDone(JSON.stringify({ verdict: 'approve', summary: 'ok', score: 85 }));

      const verdict = await evaluateMission(makeMission(), {
        repoPath: '/repo',
        worktreePath: '/repo/.lazy/worktrees/mission-1',
      });

      const agentRunCalls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'agent_run');
      const ids = agentRunCalls.map((c: unknown[]) => (c[1] as { req: { id: string } }).req.id);
      // Only reviewer/security/judge spawn — never mission-1-tester.
      expect(ids).toEqual(['mission-1-reviewer', 'mission-1-security', 'mission-1-judge']);

      const tester = verdict.reviewers.find((r) => r.role === 'tester');
      expect(tester?.inconclusive).toBe(true);
      expect(tester?.summary).toContain('No test script configured');
      expect(verdict.passed).toBe(true);
      expect(verdict.score).toBe(85); // the judge's own real score, never a fabricated ~20-30
    });
  });
});

// ── Verification-mission judging (M12 dogfood fix, BLOQUANT #3) ────────────
// A verification mission ("vérifier que le build passe") never touches a
// file on purpose — before this fix, the reviewer/security LLM sub-agents
// were still handed an empty diff and read "no diff" as "nothing was done",
// scoring the mission ~20/request_changes even when its verification
// command genuinely passed. isVerificationMission/buildVerificationMission-
// Reviewers replace that with judging on the tester's own verification
// output: approve when it passed, inconclusive (never a fabricated pass,
// never a false "no diff" rejection) when the tester itself could not run.

describe('isVerificationMission', () => {
  it('is true for a French verification title with no diff', () => {
    expect(isVerificationMission(makeMission({ title: 'Vérifier que le build passe', diffSnippet: [], diffFiles: [] }))).toBe(true);
  });

  it('is true for an English verification title with no diff', () => {
    expect(isVerificationMission(makeMission({ title: 'Verify the tests pass', diffSnippet: [], diffFiles: [] }))).toBe(true);
  });

  it('is false when the mission has a real diff, even if the title mentions "verify"', () => {
    expect(
      isVerificationMission(
        makeMission({ title: 'Verify and fix the build', diffSnippet: ['+ fixed'], diffFiles: [{ filename: 'a.ts', added: 1, removed: 0 }] }),
      ),
    ).toBe(false);
  });

  it('is false for an ordinary code-change mission with no diff yet', () => {
    expect(isVerificationMission(makeMission({ title: 'Add dark mode toggle', diffSnippet: [], diffFiles: [] }))).toBe(false);
  });
});

describe('buildVerificationMissionReviewers', () => {
  const verificationMission = makeMission({ title: 'Vérifier que le build passe', diffSnippet: [], diffFiles: [] });

  it('returns null for a non-verification mission (caller falls through to the normal LLM path)', () => {
    const testerVerdict: ReviewerVerdict = { role: 'tester', verdict: 'approve', summary: 'ok' };
    expect(buildVerificationMissionReviewers(makeMission({ diffSnippet: [] }), testerVerdict)).toBeNull();
  });

  it('verify-mission-with-passing-output → approve (reviewer and security mirror the tester)', () => {
    const testerVerdict: ReviewerVerdict = { role: 'tester', verdict: 'approve', summary: 'npm run build exited 0', score: 90 };
    const reviewers = buildVerificationMissionReviewers(verificationMission, testerVerdict)!;

    expect(reviewers).not.toBeNull();
    expect(reviewers.map((r) => r.role)).toEqual(['tester', 'reviewer', 'security']);
    expect(reviewers[1].verdict).toBe('approve');
    expect(reviewers[2].verdict).toBe('approve');
    expect(reviewers[1].inconclusive).toBeFalsy();
    expect(reviewers[2].inconclusive).toBeFalsy();
  });

  it('verify-mission-blocked → inconclusive (never a fabricated pass, never a "no diff" rejection)', () => {
    const testerVerdict: ReviewerVerdict = {
      role: 'tester',
      verdict: 'request_changes',
      summary: 'Tester unavailable — run_shell failed: cwd is not a directory.',
      inconclusive: true,
    };
    const reviewers = buildVerificationMissionReviewers(verificationMission, testerVerdict)!;

    expect(reviewers).not.toBeNull();
    expect(reviewers.every((r) => r.inconclusive)).toBe(true);
    // Honesty check: the summary must explain WHY (evaluator infra limit),
    // never read as "no diff was submitted" / "nothing was done".
    expect(reviewers[1].summary.toLowerCase()).not.toContain('no diff');
    expect(reviewers[2].summary.toLowerCase()).not.toContain('no diff');
  });

  it('a real verification failure (build genuinely broken) still requests changes, not a silent pass', () => {
    const testerVerdict: ReviewerVerdict = { role: 'tester', verdict: 'request_changes', summary: 'Build exited 1: TypeError', score: 10 };
    const reviewers = buildVerificationMissionReviewers(verificationMission, testerVerdict)!;

    expect(reviewers[1].verdict).toBe('request_changes');
    expect(reviewers[2].verdict).toBe('request_changes');
    expect(reviewers[1].inconclusive).toBeFalsy();
  });
});

describe('evaluateMission — verification mission judging, full pipeline (managed mode)', () => {
  beforeEach(() => {
    mockedGetProviderMode.mockReturnValue('managed');
  });

  it('verify-mission-with-passing-output: judges on the tester output, approves, and skips the LLM reviewer/security calls', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '5 passed (5)', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });
    // Only the judge calls the managed LLM now — reviewer/security are
    // derived from the tester's own output, never handed an empty diff.
    mockedStream.mockImplementation(() =>
      makeStream(JSON.stringify({ verdict: 'approve', summary: 'verification confirmed', score: 92, risk: 'low' })),
    );

    const verdict = await evaluateMission(
      makeMission({ title: 'Vérifier que le build passe', diffSnippet: [], diffFiles: [] }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    expect(mockedStream).toHaveBeenCalledTimes(1); // judge only
    expect(verdict.reviewers.map((r) => r.role)).toEqual(['tester', 'reviewer', 'security', 'judge']);
    expect(verdict.reviewers.find((r) => r.role === 'reviewer')?.verdict).toBe('approve');
    expect(verdict.reviewers.find((r) => r.role === 'security')?.verdict).toBe('approve');
    expect(verdict.passed).toBe(true);
  });

  it('verify-mission-blocked: tester could not run → reviewer/security are inconclusive, never a fabricated "no diff" rejection', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.reject(new Error('cwd is not a directory'));
      return Promise.resolve(undefined);
    });
    mockedStream.mockImplementation(() =>
      makeStream(JSON.stringify({ verdict: 'request_changes', summary: 'no signal available', score: 0, risk: 'medium' })),
    );

    const verdict = await evaluateMission(
      makeMission({ title: 'Verify the build passes', diffSnippet: [], diffFiles: [] }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    const reviewer = verdict.reviewers.find((r) => r.role === 'reviewer');
    const security = verdict.reviewers.find((r) => r.role === 'security');
    expect(tester?.inconclusive).toBe(true);
    expect(reviewer?.inconclusive).toBe(true);
    expect(security?.inconclusive).toBe(true);
    expect(reviewer?.summary.toLowerCase()).not.toContain('no diff');
  });

  it('a non-verification mission with no diff yet still runs the normal LLM reviewer/security path (regression)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '2 passed (2)', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'ok', score: 80 }),
      JSON.stringify({ verdict: 'approve', summary: 'ok', score: 90 }),
      JSON.stringify({ verdict: 'approve', summary: 'ok', score: 85, risk: 'low' }),
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(
      makeMission({ title: 'Add dark mode toggle', diffSnippet: [], diffFiles: [] }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    expect(mockedStream).toHaveBeenCalledTimes(3); // reviewer + security + judge, unaffected
    expect(verdict.reviewers.map((r) => r.role)).toEqual(['tester', 'reviewer', 'security', 'judge']);
  });
});

// ── resolveWorktreePath — unit coverage for the join logic itself ──────────
//
// Exported so MissionDetail.tsx can compute an explicit worktreePath up
// front (see its handleRunReview) instead of relying on evaluateMission's
// internal fallback. Must mirror the Rust side's agent_create_worktree_inner
// (repo_dir.join(".lazy").join("worktrees").join(safe_branch)) exactly:
// same separator throughout, never a hardcoded '/'.

describe('resolveWorktreePath', () => {
  it('joins with backslash and keeps a Windows \\\\?\\ verbatim prefix internally consistent — never mixes in a "/"', () => {
    const result = resolveWorktreePath('\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy', {
      id: 'mission-1',
      worktree: 'agent/m-review-fix-thing',
    });

    expect(result).toBe(
      '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy\\.lazy\\worktrees\\agent-m-review-fix-thing',
    );
    expect(result).not.toContain('/');
  });

  it('joins with forward slash for a POSIX-style repoPath', () => {
    const result = resolveWorktreePath('/repo', { id: 'mission-1', worktree: undefined });
    expect(result).toBe('/repo/.lazy/worktrees/mission-1');
  });

  it('trims a trailing separator from repoPath before joining (no double separator)', () => {
    const result = resolveWorktreePath('C:\\Users\\user\\Lazy\\', {
      id: 'mission-1',
      worktree: 'agent/x',
    });
    expect(result).toBe('C:\\Users\\user\\Lazy\\.lazy\\worktrees\\agent-x');
  });

  it('falls back to mission.id when mission.worktree is absent', () => {
    const result = resolveWorktreePath('/repo', { id: 'm-42' });
    expect(result).toBe('/repo/.lazy/worktrees/m-42');
  });

  it('sanitizes non-alphanumeric branch characters the same way the Rust side does, so the reconstructed path matches the real directory', () => {
    const result = resolveWorktreePath('/repo', { id: 'm-1', worktree: 'agent/weird.branch name!' });
    expect(result).toBe('/repo/.lazy/worktrees/agent-weird-branch-name-');
  });
});

// ── R13 — shared verdict-score formatting (the "Verdict 0/100" residual fix) ──
// R11 fixed nodeChrome.tsx's node-chip score display to gate on
// `verdict.scoreUnavailable`; R12's dogfood run still saw a bare "0/100" on
// OTHER surfaces (MissionDetailJudge's ScoreRing, DataInspector's inspector
// table, approveGate's merge-block reason, managerAdvice/learningLoop/
// runtime/managerEngine's text lines) because each re-derived its own ad hoc
// check. isVerdictScoreAvailable/formatVerdictScoreLine are now the ONE
// shared source every one of those call sites goes through.

describe('isVerdictScoreAvailable / formatVerdictScoreLine (shared verdict-score rule)', () => {
  it('a real, parsable score is available and formats as "N/100"', () => {
    const verdict = { score: 82, scoreUnavailable: undefined } as unknown as JudgeVerdict;
    expect(isVerdictScoreAvailable(verdict)).toBe(true);
    expect(formatVerdictScoreLine(verdict)).toBe('82/100');
  });

  it('rounds a non-integer score', () => {
    const verdict = { score: 84.6 } as unknown as JudgeVerdict;
    expect(formatVerdictScoreLine(verdict)).toBe('85/100');
  });

  it('a scoreUnavailable=true verdict is never available, regardless of the placeholder score value', () => {
    const verdict = { score: 0, scoreUnavailable: true } as unknown as JudgeVerdict;
    expect(isVerdictScoreAvailable(verdict)).toBe(false);
    expect(formatVerdictScoreLine(verdict)).toBe('score indisponible');
    expect(formatVerdictScoreLine(verdict, 'N/A')).toBe('N/A');
  });
});

// ── R13 — "asked-but-never-ran" (M18 false-pass dogfood fix) ───────────────
// Real captured feedback on M18 (a chain-fired verification mission, "vérifie
// que le build passe"): "Tu n'as pas réellement exécuté `npm run build` — tu
// t'es arrêté à la demande d'approbation pour la commande Bash et tu as
// rapporté ça comme résultat final." — the tester sub-agent got stuck at a
// pending/blocked Bash-approval request and STILL free-wrote a confident
// "approve" JSON verdict. looksLikeAskedButNeverRan / guardAgainstAskedButNeverRan
// detect this from the raw transcript and force inconclusive — never a pass.

describe('looksLikeAskedButNeverRan', () => {
  it('is true for the real M18 feedback shape (FR blocked-approval phrase, approve JSON, no execution evidence)', () => {
    const raw =
      "J'ai tenté d'exécuter `npm run build` mais je me suis arrêté à la demande d'approbation pour la commande Bash.\n" +
      JSON.stringify({ verdict: 'approve', summary: 'Le build passe', score: 90 });
    expect(looksLikeAskedButNeverRan(raw)).toBe(true);
  });

  it('is true for an English "waiting for approval" phrase with no execution evidence', () => {
    const raw = 'The command is waiting for approval before it can run. I approve this change.';
    expect(looksLikeAskedButNeverRan(raw)).toBe(true);
  });

  it('is false when the same approval phrase is followed by real execution evidence (an exit-code marker)', () => {
    const raw =
      "Le premier essai attendait une demande d'approbation, mais après ré-essai:\n[exit 0]\nBuild succeeded.";
    expect(looksLikeAskedButNeverRan(raw)).toBe(false);
  });

  it('is false when the same approval phrase is followed by real pass/fail counts', () => {
    const raw = "demande d'approbation reçue puis exécutée: 12 passed, 0 failed";
    expect(looksLikeAskedButNeverRan(raw)).toBe(false);
  });

  it('is false for an ordinary clean pass with no approval language at all', () => {
    expect(looksLikeAskedButNeverRan(JSON.stringify({ verdict: 'approve', summary: 'all good', score: 85 }))).toBe(
      false,
    );
  });
});

describe('evaluateMission — native CLI, asked-but-never-ran false-pass guard (R13, M18 fixture)', () => {
  beforeEach(() => {
    mockedGetProviderMode.mockReturnValue('claude-code');
  });

  /** M18-shaped fixture: a verification mission whose tester sub-agent got
   *  stuck at a blocked Bash-approval request but still claims 'approve'. */
  const M18_TESTER_RAW =
    "J'ai tenté d'exécuter `npm run build` mais je me suis arrêté à la demande d'approbation pour la commande Bash " +
    'et je rapporte ceci comme résultat final.\n' +
    JSON.stringify({ verdict: 'approve', summary: 'Le build passe', score: 90 });

  it('a verification mission whose tester is asked-but-never-ran is inconclusive, never approve — no fabricated pass', async () => {
    mockNativePerRoleRaw({
      tester: M18_TESTER_RAW,
      // judge never actually attempted execution — a clean, honest JSON.
      judge: JSON.stringify({
        verdict: 'request_changes',
        summary: 'No conclusive signal available',
        score: 20,
        risk: 'medium',
      }),
    });

    const verdict = await evaluateMission(
      makeMission({ title: 'Vérifie que le build passe', diffSnippet: [], diffFiles: [] }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.inconclusive).toBe(true);
    expect(tester?.verdict).not.toBe('approve');
    expect(tester?.summary).toContain('never received an executed result');

    // Verification matrix mirrors the guarded tester — reviewer/security are
    // ALSO inconclusive, never a fabricated "no diff" rejection either.
    const reviewer = verdict.reviewers.find((r) => r.role === 'reviewer');
    const security = verdict.reviewers.find((r) => r.role === 'security');
    expect(reviewer?.inconclusive).toBe(true);
    expect(security?.inconclusive).toBe(true);

    // Overall verdict must never read as a pass.
    expect(verdict.passed).toBe(false);
  });

  it('a judge that ALSO hits the same blocked-approval shape is guarded too — total blockage never scores a fabricated 0/100 as if it were real signal', async () => {
    mockNativePerRoleRaw({
      tester: M18_TESTER_RAW,
      judge: M18_TESTER_RAW.replace('Le build passe', 'Verdict final'),
    });

    const verdict = await evaluateMission(
      makeMission({ title: 'Vérifie que le build passe', diffSnippet: [], diffFiles: [] }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    expect(verdict.reviewers.find((r) => r.role === 'tester')?.inconclusive).toBe(true);
    expect(verdict.reviewers.find((r) => r.role === 'judge')?.inconclusive).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.scoreUnavailable).toBe(true);
  });

  it('verdict consistency: the SAME blocked-verification transcript always maps to the SAME (inconclusive) verdict, run twice', async () => {
    const runOnce = async (): Promise<JudgeVerdict> => {
      mockNativePerRoleRaw({
        tester: M18_TESTER_RAW,
        judge: JSON.stringify({ verdict: 'request_changes', summary: 'no signal', score: 20, risk: 'medium' }),
      });
      return evaluateMission(makeMission({ title: 'Vérifie que le build passe', diffSnippet: [], diffFiles: [] }), {
        repoPath: '/repo',
        worktreePath: '/repo/.lazy/worktrees/mission-1',
      });
    };

    const first = await runOnce();
    const second = await runOnce();

    expect(second.passed).toBe(first.passed);
    expect(second.passed).toBe(false);
    expect(second.reviewers.find((r) => r.role === 'tester')?.inconclusive).toBe(
      first.reviewers.find((r) => r.role === 'tester')?.inconclusive,
    );
    expect(second.reviewers.map((r) => ({ role: r.role, inconclusive: !!r.inconclusive, verdict: r.verdict }))).toEqual(
      first.reviewers.map((r) => ({ role: r.role, inconclusive: !!r.inconclusive, verdict: r.verdict })),
    );
  });

  it('a tester approval-mention that DID actually execute (real exit/pass evidence present) is NOT guarded — regression', async () => {
    mockNativePerRoleRaw({
      tester:
        "Une première tentative a nécessité une approbation, ré-essayée avec succès: [exit 0]\n" +
        JSON.stringify({ verdict: 'approve', summary: 'Build succeeded after retry', score: 88 }),
      judge: JSON.stringify({ verdict: 'approve', summary: 'ship it', score: 88, risk: 'low' }),
    });

    const verdict = await evaluateMission(
      makeMission({ title: 'Vérifie que le build passe', diffSnippet: [], diffFiles: [] }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    const tester = verdict.reviewers.find((r) => r.role === 'tester');
    expect(tester?.inconclusive).toBeFalsy();
    expect(tester?.verdict).toBe('approve');
    expect(verdict.passed).toBe(true);
  });
});

// ── Vacuous-approval guard (trust-critical defect #2, M2 forensics) ───────
// Real captured M2 feedback: security approved an empty repo as risk-free
// ("Repository est vierge avec seed initial. Aucun code source détecté —
// pas de risques…"), and the final judge leaned on that approval
// ("L'agent security confirme l'absence de risques…"). The PRIMARY defense
// is evaluateMission's own mission.emptyDeliverable short-circuit (see the
// describe block above) — these tests cover the defense-in-depth backstop:
// a role must never be able to express "nothing to check, therefore fine"
// as an approval, REGARDLESS of what mission-level diff fields say.

describe('looksLikeVacuousApproval', () => {
  it('is true for the real M2 security verdict (FR "no source code detected" + approve)', () => {
    const raw =
      'Repository est vierge avec seed initial. Aucun code source détecté — pas de risques de secrets ' +
      'codés en dur, injections, authentification manquante…\n' +
      JSON.stringify({ verdict: 'approve', summary: 'Aucun risque de sécurité détecté', score: 95 });
    expect(looksLikeVacuousApproval(raw)).toBe(true);
  });

  it('is true for the real M2 judge verdict (FR "without source code" + approve)', () => {
    const raw =
      "Le dépôt ne contient qu'un commit de seed, sans code source. L'agent security confirme " +
      "l'absence de risques…\n" +
      JSON.stringify({ verdict: 'approve', summary: 'Mission conforme', score: 90, risk: 'low' });
    expect(looksLikeVacuousApproval(raw)).toBe(true);
  });

  it('is true for an English "nothing to review" / "no code provided" phrase', () => {
    expect(looksLikeVacuousApproval('There is nothing to review here, so I approve.')).toBe(true);
    expect(looksLikeVacuousApproval('No code was provided for this change.')).toBe(true);
  });

  it('is false for an ordinary, legitimate approval with real findings ("no issues"/"no security issues")', () => {
    expect(looksLikeVacuousApproval(JSON.stringify({ verdict: 'approve', summary: 'No issues', score: 90 }))).toBe(
      false,
    );
    expect(
      looksLikeVacuousApproval(JSON.stringify({ verdict: 'approve', summary: 'No security issues found', score: 92 })),
    ).toBe(false);
  });

  it('is false for a clean pass with no "nothing to review" language at all', () => {
    expect(looksLikeVacuousApproval(JSON.stringify({ verdict: 'approve', summary: 'Clean diff, ship it', score: 88 }))).toBe(
      false,
    );
  });
});

describe('evaluateMission — native CLI, vacuous-approval guard (defense-in-depth, M2 shape)', () => {
  beforeEach(() => {
    mockedGetProviderMode.mockReturnValue('claude-code');
  });

  const M2_SECURITY_RAW =
    'Repository est vierge avec seed initial. Aucun code source détecté — pas de risques de secrets ' +
    'codés en dur, injections, authentification manquante…\n' +
    JSON.stringify({ verdict: 'approve', summary: 'Aucun risque de sécurité détecté', score: 95 });

  const M2_JUDGE_RAW =
    "Le dépôt ne contient qu'un commit de seed, sans code source. L'agent security confirme " +
    "l'absence de risques…\n" +
    JSON.stringify({ verdict: 'approve', summary: 'Mission conforme, aucun risque', score: 90, risk: 'low' });

  it('security approving on "no code = no risk" is downgraded to inconclusive, never approve — never a positive vote for the judge to lean on', async () => {
    mockNativePerRoleRaw({
      tester: JSON.stringify({ verdict: 'request_changes', summary: 'No test evidence', score: 30 }),
      reviewer: JSON.stringify({ verdict: 'request_changes', summary: "Aucun diff n'a été fourni", score: 10 }),
      security: M2_SECURITY_RAW,
      judge: JSON.stringify({ verdict: 'request_changes', summary: 'No conclusive evidence of any work', score: 15, risk: 'high' }),
    });

    const verdict = await evaluateMission(makeMission({ title: 'Consolider la base de code' }), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-2',
    });

    const security = verdict.reviewers.find((r) => r.role === 'security');
    expect(security?.verdict).not.toBe('approve');
    expect(security?.inconclusive).toBe(true);
    expect(security?.summary).toContain('Overridden');
  });

  it('a judge that ALSO leans on vacuous "no code = no risk" reasoning is guarded too — the exact M2 failure (1/2 approve) cannot reproduce', async () => {
    mockNativePerRoleRaw({
      tester: JSON.stringify({ verdict: 'request_changes', summary: 'No test evidence', score: 30 }),
      reviewer: JSON.stringify({ verdict: 'request_changes', summary: "Aucun diff n'a été fourni", score: 10 }),
      security: M2_SECURITY_RAW,
      judge: M2_JUDGE_RAW,
    });

    const verdict = await evaluateMission(makeMission({ title: 'Consolider la base de code' }), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-2',
    });

    const security = verdict.reviewers.find((r) => r.role === 'security');
    const judge = verdict.reviewers.find((r) => r.role === 'judge');
    expect(security?.verdict).not.toBe('approve');
    expect(judge?.verdict).not.toBe('approve');
    expect(judge?.inconclusive).toBe(true);

    // No role in the whole verdict reads as 'approve' — the exact M2
    // failure (1/2 approve on a mission that did nothing) cannot occur.
    expect(verdict.reviewers.every((r) => r.verdict !== 'approve')).toBe(true);
    expect(verdict.passed).toBe(false);

    // deriveJudgesApproved must not count security's vacuous approval as a
    // vote either — "0/2 approve" (tester + reviewer, both real conclusive
    // non-votes-for-approve), never "1/2 approve" as M2 actually showed.
    expect(deriveJudgesApproved(verdict)).toBe('0/2 approve');
  });
});

describe('evaluateMission — managed (Pro) mode, vacuous-approval guard (defense-in-depth, M2 shape)', () => {
  beforeEach(() => {
    mockedGetProviderMode.mockReturnValue('managed');
  });

  it('a managed security role approving on "no code = no risk" is downgraded to inconclusive, never approve', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '', stderr: 'no tests', exitCode: 1 });
      return Promise.resolve(undefined);
    });

    const responses = [
      JSON.stringify({ verdict: 'request_changes', summary: "Aucun diff n'a été fourni", score: 10 }), // reviewer
      'Repository est vierge avec seed initial. Aucun code source détecté — pas de risques.\n' +
        JSON.stringify({ verdict: 'approve', summary: 'Aucun risque de sécurité détecté', score: 95 }), // security
      JSON.stringify({ verdict: 'request_changes', summary: 'No conclusive evidence of any work', score: 15, risk: 'high' }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(makeMission({ title: 'Consolider la base de code' }), {
      repoPath: '/repo',
      worktreePath: '/repo/.lazy/worktrees/mission-2',
    });

    const security = verdict.reviewers.find((r) => r.role === 'security');
    expect(security?.verdict).not.toBe('approve');
    expect(security?.inconclusive).toBe(true);
    expect(verdict.reviewers.every((r) => r.verdict !== 'approve')).toBe(true);
    expect(verdict.passed).toBe(false);
  });
});

// ── Judge grades against the mission's stated objective (2026-08 fix) ──────
//
// Real repro: a mission "crée un fichier hello.txt à la racine contenant
// exactement le mot BONJOUR" was carried out correctly (the file existed
// with exactly that content) and still scored 15/100 with its merge
// blocked. The app's own explanation: "les évaluateurs considèrent qu'une
// simple création de fichier texte n'a pas de valeur de code à examiner."
// Root cause: buildReviewerTask/buildSecurityTask/buildJudgeTask never told
// the sub-agents WHAT the mission actually asked for (only a generic
// code-quality rubric), and the old NEVER_APPROVE_NOTHING_TO_REVIEW /
// buildJudgeTask wording explicitly forced a reject for any diff read as
// having "no meaningful code" or being "trivial" — which is exactly what a
// correct one-line text-file deliverable looks like. Fixed by feeding every
// role the mission's real objective (missionObjectiveText: contract.objective
// -> agentTask -> title) and grading against it instead.
describe("evaluateMission — judge grades against the mission's stated objective (2026-08 fix, 15/100 non-code repro)", () => {
  describe('objective text flows into every sub-agent prompt', () => {
    it('native (claude-code): reviewer/security/judge prompts include the mission contract objective, and no longer contain the old blanket "no meaningful code" reject instruction', async () => {
      mockedGetProviderMode.mockReturnValue('claude-code');
      mockAgentRunDone(JSON.stringify({ verdict: 'approve', summary: 'Matches the objective', score: 95 }));

      const objective = 'Crée un fichier hello.txt à la racine contenant exactement le mot BONJOUR';
      await evaluateMission(
        makeMission({
          title: 'crée un fichier hello.txt',
          contract: makeContract({
            objective,
            model: 'anthropic/claude-sonnet-5',
            permissionMode: 'acceptEdits',
            budgetCapUsd: 5,
          }),
        }),
        { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
      );

      const agentRunCalls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'agent_run');
      const taskById: Record<string, string> = {};
      for (const call of agentRunCalls) {
        const req = (call[1] as { req: { id: string; task: string } }).req;
        taskById[req.id] = req.task;
      }

      expect(taskById['mission-1-reviewer']).toContain(objective);
      expect(taskById['mission-1-security']).toContain(objective);
      expect(taskById['mission-1-judge']).toContain(objective);
      expect(taskById['mission-1-reviewer']).not.toMatch(/no meaningful code to review/i);
      expect(taskById['mission-1-judge']).not.toMatch(/empty\/trivial/i);
    });

    it('managed: falls back to agentTask when contract.objective is absent', async () => {
      mockedGetProviderMode.mockReturnValue('managed');
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'run_shell') return Promise.resolve({ stdout: '', stderr: 'no tests', exitCode: 1 });
        return Promise.resolve(undefined);
      });
      const responses = [
        JSON.stringify({ verdict: 'approve', summary: 'Matches the objective', score: 95 }), // reviewer
        JSON.stringify({ verdict: 'approve', summary: 'No security surface', score: 95 }), // security
        JSON.stringify({ verdict: 'approve', summary: 'Objective met', score: 95, risk: 'low' }), // judge
      ];
      let idx = 0;
      mockedStream.mockImplementation(() => makeStream(responses[idx++]));

      await evaluateMission(
        makeMission({ title: 'Fallback title', agentTask: 'Créer hello.txt contenant BONJOUR' }),
        { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
      );

      for (const call of mockedStream.mock.calls) {
        const content = (call[0] as { messages: Array<{ content: string }> }).messages[0].content;
        expect(content).toContain('Créer hello.txt contenant BONJOUR');
      }
    });
  });

  it('a correct non-code deliverable (hello.txt matching the objective exactly) passes with a real high score — the 15/100 repro, fixed', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '', stderr: 'no tests', exitCode: 1 });
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({
        verdict: 'approve',
        summary:
          'hello.txt exists at the repo root and contains exactly "BONJOUR", matching the objective. ' +
          'Not source code, so code-quality criteria do not apply.',
        score: 95,
      }),
      JSON.stringify({
        verdict: 'approve',
        summary: 'Plain text file, no executable logic, nothing to flag',
        score: 100,
      }),
      JSON.stringify({
        verdict: 'approve',
        summary: 'Objective fully met by a minimal, correct deliverable',
        score: 95,
        risk: 'low',
      }),
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(
      makeMission({
        title: 'crée un fichier hello.txt',
        diffSnippet: ['+++ hello.txt', '+BONJOUR'],
        contract: makeContract({
          objective: 'Crée un fichier hello.txt à la racine contenant exactement le mot BONJOUR',
          model: 'anthropic/claude-sonnet-5',
          permissionMode: 'acceptEdits',
          budgetCapUsd: 5,
        }),
      }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    expect(verdict.passed).toBe(true);
    expect(verdict.scoreUnavailable).not.toBe(true);
    expect(verdict.score).toBeGreaterThanOrEqual(80);
  });

  it('a deliverable that does NOT meet its stated objective still fails — the fix grades leniently against non-code rubrics, not against the objective itself', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '', stderr: 'no tests', exitCode: 1 });
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'hello.txt exists but contains "HELLO" instead of the required "BONJOUR" — does not match the stated objective.',
        score: 20,
      }),
      JSON.stringify({ verdict: 'approve', summary: 'No security surface', score: 90 }),
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'Content does not match the objective',
        score: 15,
        risk: 'medium',
      }),
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(
      makeMission({
        title: 'crée un fichier hello.txt',
        diffSnippet: ['+++ hello.txt', '+HELLO'],
        contract: makeContract({
          objective: 'Crée un fichier hello.txt à la racine contenant exactement le mot BONJOUR',
          model: 'anthropic/claude-sonnet-5',
          permissionMode: 'acceptEdits',
          budgetCapUsd: 5,
        }),
      }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBeLessThan(50);
  });

  it('genuinely poor code still fails — the fix is not a leniency backdoor', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') {
        return Promise.resolve({ stdout: 'Tests  0 passed, 3 failed', stderr: '', exitCode: 1 });
      }
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({
        verdict: 'reject',
        summary: 'Mutates shared state directly, no error handling, 300-line function — real code-quality violations.',
        score: 10,
      }),
      JSON.stringify({ verdict: 'request_changes', summary: 'Hardcoded API key found in source', score: 5 }),
      JSON.stringify({ verdict: 'reject', summary: 'Tests fail and code quality is genuinely poor', score: 8, risk: 'high' }),
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(
      makeMission({
        title: 'Add payment processing',
        diffSnippet: ['+function processPayment(...) { /* 300 lines, mutates global state */ }'],
        contract: makeContract({
          objective: 'Add a payment processing module with proper validation',
          model: 'anthropic/claude-sonnet-5',
          permissionMode: 'acceptEdits',
          budgetCapUsd: 5,
        }),
      }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBeLessThan(20);
  });
});

// ── Sibling risk: deletions, renames, docs-only, config-only diffs ─────────
// Same category of mishandling as the non-code text-file repro above — a
// deletion/rename/docs/config diff has just as little "code quality" for
// the old rubric to grab onto. The fix is diff-shape-agnostic (it grades
// against the objective, not against what TYPE of diff it is), so the same
// prompt change covers all four without special-casing any of them.
describe('evaluateMission — objective grading also covers deletions, renames, docs-only, and config-only diffs (sibling risk)', () => {
  it.each([
    ['deletion', ['--- a/old-file.ts', '+++ /dev/null', '-export function unused() {}']],
    ['rename', ['rename from old-name.ts', 'rename to new-name.ts']],
    ['docs-only', ['+++ README.md', '+## New section', '+Some docs text.']],
    ['config-only', ['+++ config.json', '+  "flag": true']],
  ])('%s diff: reviewer/security/judge prompts still carry the objective and the non-code grading rule', async (_kind, diffSnippet) => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '', stderr: 'no tests', exitCode: 1 });
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'Matches the objective', score: 90 }),
      JSON.stringify({ verdict: 'approve', summary: 'No security surface', score: 90 }),
      JSON.stringify({ verdict: 'approve', summary: 'Objective met', score: 90, risk: 'low' }),
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const objective = 'Remove the unused old-file.ts module';
    const verdict = await evaluateMission(
      makeMission({
        title: 'cleanup',
        diffSnippet,
        contract: makeContract({
          objective,
          model: 'anthropic/claude-sonnet-5',
          permissionMode: 'acceptEdits',
          budgetCapUsd: 5,
        }),
      }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    for (const call of mockedStream.mock.calls) {
      const content = (call[0] as { messages: Array<{ content: string }> }).messages[0].content;
      expect(content).toContain(objective);
      expect(content).toMatch(/MUST NOT be used to penalize/);
    }
    expect(verdict.passed).toBe(true);
  });
});

// ── B4: parseReviewerResult — malformed LLM output shape validation ────
//
// A sub-agent LLM's response can be syntactically valid JSON while still
// having the wrong SHAPE (a hallucinated structure, or a field of the wrong
// type) — this repo has no schema-validation library, so the fix is a plain
// manual shape check with a safe fallback per field, never a crash or an
// incoherent ReviewerVerdict.
describe('parseReviewerResult — malformed LLM output', () => {
  it('falls back to safe defaults when JSON fields have the wrong runtime type', () => {
    const raw = JSON.stringify({ verdict: 12345, summary: { nested: 'oops' }, score: 'high' });
    const result = parseReviewerResult(raw, 'reviewer');
    expect(result.verdict).toBe('request_changes');
    expect(typeof result.summary).toBe('string');
    expect(result.score).toBeUndefined();
  });

  it('rejects a verdict string outside the known literal set', () => {
    const raw = JSON.stringify({ verdict: 'maybe', summary: 'looks fine', score: 80 });
    const result = parseReviewerResult(raw, 'security');
    expect(result.verdict).toBe('request_changes');
    // A valid-shaped summary/score is still honoured — only the invalid
    // field falls back, not the whole object.
    expect(result.summary).toBe('looks fine');
    expect(result.score).toBe(80);
  });

  it('rejects a null verdict instead of propagating it', () => {
    const raw = JSON.stringify({ verdict: null, summary: 'no opinion', score: 50 });
    const result = parseReviewerResult(raw, 'judge');
    expect(result.verdict).toBe('request_changes');
  });

  it('handles non-JSON free text via the keyword heuristic (existing behaviour, unaffected)', () => {
    const result = parseReviewerResult('I approve this change, looks solid.', 'reviewer');
    expect(result.verdict).toBe('approve');
  });

  it('accepts a well-formed verdict object unchanged (regression pin)', () => {
    const raw = JSON.stringify({ verdict: 'reject', summary: 'security issue found', score: 10 });
    const result = parseReviewerResult(raw, 'security');
    expect(result).toEqual({
      role: 'security',
      verdict: 'reject',
      summary: 'security issue found',
      score: 10,
    });
  });
});

// ── Fabrication check (2026-08 incident) ────────────────────────────
//
// Real repro: a mission asked to replace a stale "Coming soon" price
// placeholder with wording that merely "indicates availability" — no price
// was given anywhere in the objective, the repo, or Stripe config — had its
// implementer invent "$29/month" across every locale file, and the
// reviewer/security/judge rubric APPROVED it: it only ever checked "does
// this satisfy the objective" and "is the code well-formed", and a
// fabricated, well-formatted price satisfies both. buildReviewerTask/
// buildSecurityTask/buildJudgeTask now carry an explicit fabrication-check
// instruction (see NEVER_APPROVE_FABRICATED_FACTS(_JUDGE) in evaluator.ts).
describe('evaluateMission — fabrication check in the reviewer/security/judge rubric', () => {
  it('the fabrication-check instruction reaches the reviewer, security, and judge prompts (managed path)', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '', stderr: 'no tests', exitCode: 1 });
      return Promise.resolve(undefined);
    });
    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'Matches the objective', score: 90 }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'No security surface', score: 90 }), // security
      JSON.stringify({ verdict: 'approve', summary: 'Objective met', score: 90, risk: 'low' }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    await evaluateMission(
      makeMission({
        title: 'Update pro plan copy',
        agentTask: 'Replace the placeholder price wording with copy that indicates the plan is available.',
      }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    expect(mockedStream.mock.calls.length).toBe(3);
    for (const call of mockedStream.mock.calls) {
      const content = (call[0] as { messages: Array<{ content: string }> }).messages[0].content;
      expect(content).toMatch(/FABRICATION CHECK/);
    }
  });

  it('rejects when a reviewer flags an unsourced factual claim invented by the implementer', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '', stderr: 'no tests', exitCode: 1 });
      return Promise.resolve(undefined);
    });
    // The objective never mentions a price — only "indicate availability" —
    // so a reviewer that spots an invented "$29/month" in the diff correctly
    // flags it per NEVER_APPROVE_FABRICATED_FACTS and must not be overruled.
    const responses = [
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'Diff introduces "$29/month" which appears nowhere in the objective or repo — fabricated price.',
        score: 15,
      }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'No security surface', score: 90 }), // security
      JSON.stringify({
        verdict: 'request_changes',
        summary: 'Reviewer flagged a fabricated price not sourced from the objective or repo — disqualifying.',
        score: 10,
        risk: 'medium',
      }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(
      makeMission({
        title: 'Update pro plan copy',
        agentTask: 'Replace the placeholder price wording with copy that indicates the plan is available. ' +
          'Do not change anything else.',
      }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    const reviewer = verdict.reviewers.find((r) => r.role === 'reviewer');
    expect(reviewer?.verdict).toBe('request_changes');
    expect(reviewer?.summary).toMatch(/fabricated/i);
    expect(verdict.passed).toBe(false);
  });

  it('a diff whose facts ARE derivable from the objective still passes (no false positive)', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: '', stderr: 'no tests', exitCode: 1 });
      return Promise.resolve(undefined);
    });
    // The objective ITSELF states the specific value ("2.4.0"), so a diff
    // that writes that exact value is sourced from the objective, not
    // invented — the fabrication check must not block it.
    const objective = 'Bump the version string in package.json to exactly "2.4.0".';
    const responses = [
      JSON.stringify({ verdict: 'approve', summary: 'Version set to 2.4.0 as specified in the objective', score: 95 }), // reviewer
      JSON.stringify({ verdict: 'approve', summary: 'No security surface', score: 95 }), // security
      JSON.stringify({ verdict: 'approve', summary: 'Objective met exactly', score: 95, risk: 'low' }), // judge
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => makeStream(responses[idx++]));

    const verdict = await evaluateMission(
      makeMission({
        title: 'Bump version',
        contract: makeContract({
          objective,
          model: 'anthropic/claude-sonnet-5',
          permissionMode: 'acceptEdits',
          budgetCapUsd: 5,
        }),
      }),
      { repoPath: '/repo', worktreePath: '/repo/.lazy/worktrees/mission-1' },
    );

    for (const call of mockedStream.mock.calls) {
      const content = (call[0] as { messages: Array<{ content: string }> }).messages[0].content;
      expect(content).toContain(objective);
    }
    expect(verdict.passed).toBe(true);
  });
});
