/**
 * pendingApprovalLabelDistinct.test.ts — double-emission fix (real audit
 * finding, 2026-07-28): "deux approbations de lancement de brouillon
 * identiques et indiscernables" observed in the pending-approval queue.
 *
 * Two independent halves of the fix, both covered here:
 *   1. describePendingAction('launch_draft', ...) used to return the SAME
 *      fixed string ('Lancer le brouillon') no matter which draft was
 *      targeted — two pending entries for two different drafts (or a
 *      genuine duplicate emission of the same draft) were visually
 *      identical, so the user had no way to tell what each one actually
 *      does. It must now always name the real target.
 *   2. mergeManagerActions used to dedupe byte-identical repeats only
 *      ACROSS the two grounding passes (turn-1 vs turn-2), never WITHIN a
 *      single pass's own mutating actions — if the model's own response
 *      repeated the exact same mutating action twice in one turn, both
 *      copies reached the execution loop and, for a gate-deferred action,
 *      both queued their own separate PendingApprovalAction.
 */
import { describe, it, expect } from 'vitest';
import { describePendingAction, describePendingActionDetail, mergeManagerActions, isMutantManagerAction } from '../components/agents/agentsStore';
import type { ManagerAction } from '../lib/agents/types';

describe('describePendingAction — launch_draft names its real target', () => {
  it('two different draftIds produce two distinguishable labels', () => {
    const a = describePendingAction({ type: 'launch_draft', draftId: 'draft-abc-123' });
    const b = describePendingAction({ type: 'launch_draft', draftId: 'draft-xyz-789' });
    expect(a).not.toBe(b);
    expect(a).toContain('draft-abc-123');
    expect(b).toContain('draft-xyz-789');
  });

  it('falls back to draftAlias when no draftId is present', () => {
    const label = describePendingAction({ type: 'launch_draft', draftAlias: 'a' });
    expect(label).toContain('a');
  });

  it('never returns the old bare, target-less string', () => {
    const label = describePendingAction({ type: 'launch_draft', draftId: 'draft-1' });
    expect(label).not.toBe('Lancer le brouillon');
  });
});

// ── Truncation-reachability fix (real user report, 2026-08-01 QA): the
// approval card showed "Lancer la mission : Audite le projet
// C:\...\BackOfficeGameON : stack réel (" — cut mid-sentence in the DOM
// itself, asking the user to approve something he could not fully read. ──
describe('describePendingAction — truncation never dangles mid-word without an ellipsis', () => {
  it('a launch_mission task longer than 80 chars is truncated with a trailing ellipsis, not a raw cut', () => {
    const task = 'Audite le projet C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON : stack réel (Electron + JS + Python), routes IPC, et propose un plan de modernisation';
    const label = describePendingAction({ type: 'launch_mission', task });

    expect(label.length).toBeLessThan(`Lancer la mission : ${task}`.length);
    expect(label.endsWith('…')).toBe(true);
  });

  it('a short launch_mission task is never truncated at all', () => {
    const task = 'fix the bug';
    const label = describePendingAction({ type: 'launch_mission', task });
    expect(label).toBe(`Lancer la mission : ${task}`);
  });
});

describe('describePendingActionDetail — full, untruncated counterpart to describePendingAction', () => {
  it('launch_mission: carries the COMPLETE task text, never cut, even far beyond the compact label\'s 80-char budget', () => {
    const task = 'Audite le projet C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON : stack réel (Electron + JS + Python), routes IPC, et propose un plan de modernisation';
    const action: ManagerAction = { type: 'launch_mission', task };

    const compact = describePendingAction(action);
    const detail = describePendingActionDetail(action);

    expect(detail).toBe(`Lancer la mission : ${task}`);
    expect(detail).toContain(task);
    expect(detail.length).toBeGreaterThan(compact.length);
  });

  it('launch_best_of_n and create_loop also expose their full, untruncated task', () => {
    const longTask = 'a'.repeat(200);
    expect(describePendingActionDetail({ type: 'launch_best_of_n', n: 3, task: longTask })).toContain(longTask);
    expect(describePendingActionDetail({ type: 'create_loop', task: longTask, cadence: 'daily' })).toContain(longTask);
  });

  it('every other action type falls back to the SAME text as the compact label (nothing to truncate in the first place)', () => {
    const action: ManagerAction = { type: 'stop_all' };
    expect(describePendingActionDetail(action)).toBe(describePendingAction(action));
  });
});

describe('mergeManagerActions — collapses exact-duplicate mutants within a single pass', () => {
  it('two byte-identical launch_draft actions in the SAME turn collapse to one', () => {
    const turn1: ManagerAction[] = [
      { type: 'launch_draft', draftId: 'draft-1' },
      { type: 'launch_draft', draftId: 'draft-1' }, // exact repeat — real duplicate emission
    ];

    const result = mergeManagerActions(turn1, []);

    const mutants = result.actions.filter(isMutantManagerAction);
    expect(mutants).toHaveLength(1);
    expect(mutants[0]).toEqual({ type: 'launch_draft', draftId: 'draft-1' });
  });

  it('two DIFFERENT launch_draft actions in the same turn both survive — never over-collapsed', () => {
    const turn1: ManagerAction[] = [
      { type: 'launch_draft', draftId: 'draft-1' },
      { type: 'launch_draft', draftId: 'draft-2' },
    ];

    const result = mergeManagerActions(turn1, []);

    expect(result.actions.filter(isMutantManagerAction)).toHaveLength(2);
  });

  it('a duplicate within the WINNING pass (turn-2) also collapses', () => {
    const turn1: ManagerAction[] = [{ type: 'create_draft', task: 'old', title: 'Old' }];
    const turn2: ManagerAction[] = [
      { type: 'launch_draft', draftId: 'draft-9' },
      { type: 'launch_draft', draftId: 'draft-9' },
    ];

    const result = mergeManagerActions(turn1, turn2);

    expect(result.actions.filter(isMutantManagerAction)).toHaveLength(1);
  });
});
