import { describe, it, expect } from 'vitest';
import { detectStuckPattern, type AgentStepRecord } from '../stuckDetector';

function rec(overrides: Partial<AgentStepRecord> = {}): AgentStepRecord {
  return {
    action: 'read_file',
    argsSignature: '{"path":"a.ts"}',
    observation: 'some content',
    isError: false,
    ...overrides,
  };
}

describe('detectStuckPattern — repeated-identical-failure', () => {
  it('flags the same action erroring 3 times, even with successes interleaved', () => {
    const history: AgentStepRecord[] = [
      rec({ action: 'edit_file', observation: 'ERROR: not found', isError: true }),
      rec({ action: 'read_file', observation: 'ok', isError: false }),
      rec({ action: 'edit_file', observation: 'ERROR: not found', isError: true }),
      rec({ action: 'read_file', observation: 'ok', isError: false }),
      rec({ action: 'edit_file', observation: 'ERROR: not found', isError: true }),
    ];
    const verdict = detectStuckPattern(history);
    expect(verdict.stuck).toBe(true);
    expect(verdict.reason).toBe('repeated_identical_failure');
    expect(verdict.message).toContain('edit_file');
  });

  it('does not flag 2 failures — below the default threshold of 3', () => {
    const history: AgentStepRecord[] = [
      rec({ action: 'edit_file', observation: 'ERROR: x', isError: true }),
      rec({ action: 'read_file', observation: 'ok', isError: false }),
      rec({ action: 'edit_file', observation: 'ERROR: x', isError: true }),
    ];
    expect(detectStuckPattern(history).stuck).toBe(false);
  });

  it('does not conflate failures from two DIFFERENT actions', () => {
    const history: AgentStepRecord[] = [
      rec({ action: 'edit_file', observation: 'ERROR: a', isError: true }),
      rec({ action: 'write_file', observation: 'ERROR: b', isError: true }),
      rec({ action: 'run_command', observation: 'ERROR: c', isError: true }),
    ];
    // 3 errors total, but no single action failed 3 times.
    expect(detectStuckPattern(history).stuck).toBe(false);
  });

  it('respects a custom identicalFailureThreshold', () => {
    const history: AgentStepRecord[] = [
      rec({ action: 'edit_file', observation: 'ERROR: a', isError: true }),
      rec({ action: 'edit_file', observation: 'ERROR: a', isError: true }),
    ];
    expect(detectStuckPattern(history, { identicalFailureThreshold: 2 }).stuck).toBe(true);
  });
});

describe('detectStuckPattern — repeated-action-observation', () => {
  it('flags the exact same (action, args, observation) repeating 4 times, with no errors involved', () => {
    const history: AgentStepRecord[] = [
      rec({ observation: 'nudge: already ran this at step 1' }),
      rec({ observation: 'nudge: already ran this at step 1' }),
      rec({ observation: 'nudge: already ran this at step 1' }),
      rec({ observation: 'nudge: already ran this at step 1' }),
    ];
    const verdict = detectStuckPattern(history);
    expect(verdict.stuck).toBe(true);
    expect(verdict.reason).toBe('repeated_action_observation');
    expect(verdict.message).toContain('read_file');
  });

  it('does not flag 3 repeats — below the default threshold of 4', () => {
    const history: AgentStepRecord[] = [rec(), rec(), rec()];
    expect(detectStuckPattern(history).stuck).toBe(false);
  });

  it('does not flag repeats whose observation genuinely differs each time', () => {
    const history: AgentStepRecord[] = [
      rec({ observation: 'v1' }),
      rec({ observation: 'v2' }),
      rec({ observation: 'v3' }),
      rec({ observation: 'v4' }),
    ];
    expect(detectStuckPattern(history).stuck).toBe(false);
  });

  it('does not flag repeats whose ARGS genuinely differ each time', () => {
    const history: AgentStepRecord[] = [
      rec({ argsSignature: '{"path":"a.ts"}' }),
      rec({ argsSignature: '{"path":"b.ts"}' }),
      rec({ argsSignature: '{"path":"c.ts"}' }),
      rec({ argsSignature: '{"path":"d.ts"}' }),
    ];
    expect(detectStuckPattern(history).stuck).toBe(false);
  });
});

describe('detectStuckPattern — window and priority', () => {
  it('only inspects the most recent `window` steps — an old failure streak ages out', () => {
    const oldFailures: AgentStepRecord[] = [
      rec({ action: 'edit_file', observation: 'ERROR: a', isError: true }),
      rec({ action: 'edit_file', observation: 'ERROR: a', isError: true }),
      rec({ action: 'edit_file', observation: 'ERROR: a', isError: true }),
    ];
    // Varied, non-repeating filler — must not itself trip
    // repeated-action-observation, so this test isolates the aging-out
    // property of pattern 1 alone.
    const recentOk: AgentStepRecord[] = [
      rec({ observation: 'v1' }),
      rec({ observation: 'v2' }),
      rec({ observation: 'v3' }),
      rec({ observation: 'v4' }),
      rec({ observation: 'v5' }),
      rec({ observation: 'v6' }),
      rec({ observation: 'v7' }),
    ];
    const history = [...oldFailures, ...recentOk];
    // window=5 (default 10 would still see the old failures here since total
    // is 10 — use a tight window to prove aging-out works).
    expect(detectStuckPattern(history, { window: 5 }).stuck).toBe(false);
  });

  it('prefers repeated-identical-failure over repeated-action-observation when both would match', () => {
    const history: AgentStepRecord[] = [
      rec({ action: 'edit_file', observation: 'ERROR: same', isError: true }),
      rec({ action: 'edit_file', observation: 'ERROR: same', isError: true }),
      rec({ action: 'edit_file', observation: 'ERROR: same', isError: true }),
      rec({ action: 'edit_file', observation: 'ERROR: same', isError: true }),
    ];
    const verdict = detectStuckPattern(history);
    expect(verdict.reason).toBe('repeated_identical_failure');
  });

  it('returns not-stuck for an empty history', () => {
    expect(detectStuckPattern([]).stuck).toBe(false);
  });
});
