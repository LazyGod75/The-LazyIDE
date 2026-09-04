/**
 * Tests for canvas/draftLaunch.ts — the shared draft-launch primitive (W4
 * dedup of useCanvasEditing.ts's handleLaunchDraft + the manager executor's
 * launch_draft action). Covers: draft-not-found, cross-project refusal
 * (never launches, never switches), and a successful launch's atomic
 * remapDraftToMission (position preserved, chains rewritten).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { launchDraft } from '../components/agents/canvas/draftLaunch';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef, type DraftSpec } from '../components/agents/canvas/canvasTypes';
import { getEngineReadiness } from '../lib/models/entitlement';

// BUG-4: draftLaunch now gates on getEngineReadiness(undefined, draft.model)
// before calling addMission. Mocked here (real engineReasonKey kept, only
// the readiness function itself is stubbed) so each test can pin the exact
// readiness shape without wiring the real CLI-detection/subscription cache.
vi.mock('../lib/models/entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/entitlement')>();
  return { ...actual, getEngineReadiness: vi.fn() };
});
const mockedGetEngineReadiness = vi.mocked(getEngineReadiness);

beforeEach(() => {
  _resetCanvasStoreForTests();
  // Neutral default for the pre-existing tests below, which predate the
  // gate and don't care about it: always ready.
  mockedGetEngineReadiness.mockReturnValue({ mode: 'cli', ready: true });
});

function draft(overrides: Partial<DraftSpec> & { id: string }): DraftSpec {
  return { title: `Draft ${overrides.id}`, task: 'do the thing', createdBy: 'user', ...overrides };
}

describe('launchDraft', () => {
  it('refuses honestly when the draft does not exist', async () => {
    const addMission = vi.fn();
    const result = await launchDraft('missing', { addMission, activeProjectId: 'proj-1' });
    expect(result).toEqual({ ok: false, reasonKey: 'canvas.draftLaunch.notFound' });
    expect(addMission).not.toHaveBeenCalled();
  });

  it('refuses honestly (never launches, never switches) when the draft belongs to a different project', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'D1', projectId: 'proj-other' }));
    const addMission = vi.fn();

    const result = await launchDraft('D1', { addMission, activeProjectId: 'proj-active' });

    expect(result).toEqual({ ok: false, reasonKey: 'canvas.draftLaunch.inactiveProject' });
    expect(addMission).not.toHaveBeenCalled();
    // The draft is untouched — no silent removal/remap on refusal.
    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === 'D1')).toBe(true);
  });

  it('launches a Transverse draft (no projectId) regardless of the active project', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'D1' }));
    const addMission = vi.fn().mockResolvedValue('M-new-1');

    const result = await launchDraft('D1', { addMission, activeProjectId: 'proj-active' });

    expect(result).toEqual({ ok: true, missionId: 'M-new-1' });
    expect(addMission).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Draft D1', agentTask: 'do the thing', permissionMode: 'acceptEdits', mode: 'agent' }),
    );
  });

  it('on success, atomically remaps the draft to the new mission (position preserved, chains rewritten)', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'D1', projectId: 'proj-active' }));
    canvasStoreVanilla.getState().setPosition(makeRef('draft', 'D1'), { x: 42, y: 7 });
    canvasStoreVanilla.getState().addChain({
      id: 'chain-1',
      sourceRef: makeRef('mission', 'M-upstream'),
      targetRef: makeRef('draft', 'D1'),
      condition: 'success',
      createdBy: 'user',
    });

    const addMission = vi.fn().mockResolvedValue('M-new-1');
    const result = await launchDraft('D1', { addMission, activeProjectId: 'proj-active' });

    expect(result).toEqual({ ok: true, missionId: 'M-new-1' });
    const state = canvasStoreVanilla.getState();
    // Draft gone, mission node takes its position.
    expect(state.drafts.some((d) => d.id === 'D1')).toBe(false);
    expect(state.positions[makeRef('mission', 'M-new-1')]).toEqual({ x: 42, y: 7 });
    expect(state.positions[makeRef('draft', 'D1')]).toBeUndefined();
    // The chain that used to point at the draft now points at the real mission.
    expect(state.chains.find((c) => c.id === 'chain-1')?.targetRef).toBe(makeRef('mission', 'M-new-1'));
  });

  // ── 2026-08-05 fix: normalized cross-project comparison (same bug family
  // as canvasDigest.ts's resolveProjectRootById — see normalizeForMembershipCompare) ──
  describe('cross-project comparison normalization', () => {
    it('launches when the draft projectId and active projectId differ only by drive-letter case', async () => {
      canvasStoreVanilla.getState().addDraft(draft({ id: 'D1', projectId: 'c:\\foo\\bar' }));
      const addMission = vi.fn().mockResolvedValue('M-new-1');

      const result = await launchDraft('D1', { addMission, activeProjectId: 'C:\\foo\\bar' });

      expect(result).toEqual({ ok: true, missionId: 'M-new-1' });
      expect(addMission).toHaveBeenCalled();
    });

    it('launches when the draft projectId and active projectId differ only by slash direction', async () => {
      canvasStoreVanilla.getState().addDraft(draft({ id: 'D1', projectId: 'C:/foo/bar' }));
      const addMission = vi.fn().mockResolvedValue('M-new-1');

      const result = await launchDraft('D1', { addMission, activeProjectId: 'C:\\foo\\bar' });

      expect(result).toEqual({ ok: true, missionId: 'M-new-1' });
      expect(addMission).toHaveBeenCalled();
    });

    it('still refuses honestly when the projects are genuinely different (normalization is not a fuzzy match)', async () => {
      canvasStoreVanilla.getState().addDraft(draft({ id: 'D1', projectId: 'C:\\foo\\bar' }));
      const addMission = vi.fn();

      const result = await launchDraft('D1', { addMission, activeProjectId: 'C:\\foo\\baz' });

      expect(result).toEqual({ ok: false, reasonKey: 'canvas.draftLaunch.inactiveProject' });
      expect(addMission).not.toHaveBeenCalled();
    });
  });

  it('falls back to the default model label when the draft carries none', async () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'D1', model: undefined }));
    const addMission = vi.fn().mockResolvedValue('M-new-1');

    await launchDraft('D1', { addMission, activeProjectId: null });

    expect(addMission).toHaveBeenCalledWith(expect.objectContaining({ modelLabel: 'sonnet' }));
  });

  // ── BUG-4: engine preflight gate ──────────────────────────────────
  describe('engine readiness gate', () => {
    it('launches when the engine is ready, passing draft.model through to the readiness check', async () => {
      canvasStoreVanilla.getState().addDraft(draft({ id: 'D1', model: 'claude-sonnet-5' }));
      const addMission = vi.fn().mockResolvedValue('M-new-1');
      mockedGetEngineReadiness.mockReturnValue({ mode: 'cli', ready: true });

      const result = await launchDraft('D1', { addMission, activeProjectId: null });

      expect(result).toEqual({ ok: true, missionId: 'M-new-1' });
      expect(addMission).toHaveBeenCalled();
      expect(mockedGetEngineReadiness).toHaveBeenCalledWith(undefined, 'claude-sonnet-5');
    });

    it('refuses honestly with the readiness reasonKey and never calls addMission when the engine is not ready (e.g. Pro wallet empty)', async () => {
      canvasStoreVanilla.getState().addDraft(draft({ id: 'D1', model: 'anthropic/claude-sonnet-5' }));
      const addMission = vi.fn();
      mockedGetEngineReadiness.mockReturnValue({ mode: 'pro', ready: false, reason: 'pro-no-credits' });

      const result = await launchDraft('D1', { addMission, activeProjectId: null });

      expect(result).toEqual({ ok: false, reasonKey: 'engine.reason.pro-no-credits' });
      expect(addMission).not.toHaveBeenCalled();
      // The draft is untouched — no silent removal/remap on refusal.
      expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === 'D1')).toBe(true);
    });
  });
});
