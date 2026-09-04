/**
 * generatePlanRouting.test.ts — routing parity fix (2026-08-04): generate_plan
 * used to always fall back to the ACTIVE project the instant its own
 * `action.projectId` was blank, even when the objective/steps named a
 * DIFFERENT open project by absolute path or by name — the exact defect
 * launch_mission already had fixed (2026-08-03, missions M9/M10) but that
 * was never ported to generate_plan (real 2026-08-02 escalation: three
 * unrelated plans, proposed while `lazy-backoffice` happened to be active,
 * all silently materialized inside ITS zone — see agentsStore.tsx's own
 * `generate_plan` case comment).
 *
 * `resolveMentionedProjectRoot` is the shared pure-ish helper both
 * launch_mission and generate_plan now call; this suite exercises it
 * directly (no need to render the full store/hook for a pure routing
 * decision) with `listProjects` mocked to control the open-project list.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn().mockResolvedValue(undefined),
  emitBuffered: vi.fn(),
}));

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

const { mockListProjects } = vi.hoisted(() => ({ mockListProjects: vi.fn() }));

vi.mock('../lib/platform/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform/tauri')>();
  return {
    ...actual,
    listProjects: mockListProjects,
  };
});

import { resolveMentionedProjectRoot } from '../components/agents/agentsStore';

describe('resolveMentionedProjectRoot', () => {
  it('routes by absolute path mention when exactly one open project owns it', async () => {
    mockListProjects.mockResolvedValue([
      { root: 'C:\\root\\lazy-backoffice' },
      { root: 'C:\\root\\LazySite-internet' },
    ]);
    const result = await resolveMentionedProjectRoot(
      'Fix the pricing bug at C:\\root\\LazySite-internet\\src\\pricing.ts',
    );
    expect(result?.root).toBe('C:\\root\\LazySite-internet');
  });

  it('routes by an open project\'s bare NAME mentioned in prose when no absolute path matches (the real generate_plan escalation shape)', async () => {
    mockListProjects.mockResolvedValue([
      { root: 'C:\\root\\lazy-backoffice' },
      { root: 'C:\\root\\LazySite-internet' },
    ]);
    const result = await resolveMentionedProjectRoot(
      'Ship the homepage redesign for lazy-backoffice this week',
    );
    expect(result?.root).toBe('C:\\root\\lazy-backoffice');
  });

  it('absolute-path scan wins over the name scan when both are present', async () => {
    mockListProjects.mockResolvedValue([
      { root: 'C:\\root\\lazy-backoffice' },
      { root: 'C:\\root\\LazySite-internet' },
    ]);
    // Mentions the WRONG project by name ("lazy-backoffice") but the RIGHT
    // one by real absolute path — the path scan runs first and, once it
    // finds a match, the name scan never even runs (see the helper's own
    // "owners.size === 0" guard).
    const result = await resolveMentionedProjectRoot(
      'Not lazy-backoffice — actually ship C:\\root\\LazySite-internet\\src\\home.tsx',
    );
    expect(result?.root).toBe('C:\\root\\LazySite-internet');
  });

  it('returns undefined when the mention is ambiguous (matches more than one open project) — never a coin-flip', async () => {
    mockListProjects.mockResolvedValue([
      { root: 'C:\\root\\lazy-backoffice' },
      { root: 'C:\\root\\lazy-marketng' },
    ]);
    const result = await resolveMentionedProjectRoot(
      'Sync data between lazy-backoffice and lazy-marketng',
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when nothing in the text mentions any open project', async () => {
    mockListProjects.mockResolvedValue([{ root: 'C:\\root\\lazy-backoffice' }]);
    const result = await resolveMentionedProjectRoot('Add a login screen with email + password');
    expect(result).toBeUndefined();
  });

  it('returns undefined (never throws) when listProjects fails — web/test environment with no project directory', async () => {
    mockListProjects.mockRejectedValue(new Error('no Tauri project directory'));
    const result = await resolveMentionedProjectRoot('Fix the bug at C:\\root\\lazy-backoffice\\src\\index.ts');
    expect(result).toBeUndefined();
  });
});
