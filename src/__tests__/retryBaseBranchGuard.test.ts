/**
 * retryBaseBranchGuard.test.ts — pure-logic coverage for the shared rule
 * extracted from agentsStore.tsx's retryMission (see that module's own doc
 * comment for the full "M9/M10 dead-end approval" incident this closes).
 */

import { describe, it, expect } from 'vitest';
import { isRetryBaseBranchChangeBlocked, extractRequestedRetryBaseBranch } from '../lib/agents/retryBaseBranchGuard';

describe('isRetryBaseBranchChangeBlocked', () => {
  it('is not blocked when both are absent', () => {
    expect(isRetryBaseBranchChangeBlocked(undefined, undefined)).toBe(false);
  });

  it('is not blocked when the requested branch matches the original', () => {
    expect(isRetryBaseBranchChangeBlocked('main', 'main')).toBe(false);
  });

  it('is not blocked when the requested branch is blank/whitespace-only (not a real request)', () => {
    expect(isRetryBaseBranchChangeBlocked('main', '   ')).toBe(false);
  });

  it('is blocked when a real, different branch is requested', () => {
    expect(isRetryBaseBranchChangeBlocked('main', 'feat/other')).toBe(true);
  });

  it('is blocked when a branch is requested but the original had none', () => {
    expect(isRetryBaseBranchChangeBlocked(undefined, 'feat/other')).toBe(true);
  });
});

describe('extractRequestedRetryBaseBranch', () => {
  it('reads modifications.baseBranch first', () => {
    expect(extractRequestedRetryBaseBranch({ modifications: { baseBranch: 'feat/a' }, baseBranch: 'feat/b' })).toBe('feat/a');
  });

  it('falls back to the top-level baseBranch', () => {
    expect(extractRequestedRetryBaseBranch({ baseBranch: 'feat/b' })).toBe('feat/b');
  });

  it('is undefined when neither is set', () => {
    expect(extractRequestedRetryBaseBranch({})).toBeUndefined();
  });
});
