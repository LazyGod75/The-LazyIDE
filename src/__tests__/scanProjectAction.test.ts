/**
 * Tests for the `scan_project` manager action's WIRING (as opposed to the
 * digest content itself, covered by projectDigest.test.ts):
 *   - managerActionValidator accepts/rejects the right shapes
 *   - it is registered as a KNOWN_ACTION_TYPE
 *   - it classifies as a GROUNDING action (never mutant), exactly like
 *     brain_query/web_search/... — see agentsStore.tsx's
 *     `isMutantManagerAction`/`mergeManagerActions` ("last mutating pass
 *     wins" rule): a grounding action must survive every pass and must
 *     never be treated as something a later pass can "supersede".
 *
 * Whether scan_project is auto-allowed without an approval prompt is decided
 * by actionClassifier.ts's SAFE_ACTIONS set (outside this task's locked
 * perimeter — see the final report) — not re-asserted here.
 */

import { describe, it, expect } from 'vitest';
import { validateManagerAction, KNOWN_ACTION_TYPES } from '../lib/agents/managerActionValidator';
import { isMutantManagerAction, mergeManagerActions } from '../components/agents/agentsStore';
import type { ManagerAction } from '../lib/agents/types';

describe('validateManagerAction — scan_project', () => {
  it('accepts scan_project with no fields at all (both optional)', () => {
    expect(validateManagerAction({ type: 'scan_project' }).ok).toBe(true);
  });

  it('accepts scan_project with a string projectId and depth "quick"', () => {
    expect(validateManagerAction({ type: 'scan_project', projectId: 'p1', depth: 'quick' }).ok).toBe(true);
  });

  it('accepts scan_project with depth "deep"', () => {
    expect(validateManagerAction({ type: 'scan_project', depth: 'deep' }).ok).toBe(true);
  });

  it('rejects scan_project with a non-string projectId', () => {
    const result = validateManagerAction({ type: 'scan_project', projectId: 42 });
    expect(result.ok).toBe(false);
  });

  it('rejects scan_project with an invalid depth value', () => {
    const result = validateManagerAction({ type: 'scan_project', depth: 'thorough' });
    expect(result.ok).toBe(false);
  });

  it('is registered in KNOWN_ACTION_TYPES', () => {
    expect(KNOWN_ACTION_TYPES).toContain('scan_project');
  });
});

describe('isMutantManagerAction — scan_project is a grounding action, never mutant', () => {
  it('classifies scan_project (with or without fields) as non-mutant', () => {
    const actions: ManagerAction[] = [
      { type: 'scan_project' },
      { type: 'scan_project', projectId: 'p1' },
      { type: 'scan_project', depth: 'deep' },
      { type: 'scan_project', projectId: 'p1', depth: 'deep' },
    ];
    for (const action of actions) {
      expect(isMutantManagerAction(action)).toBe(false);
    }
  });
});

describe('mergeManagerActions — scan_project follows the grounding-action rule', () => {
  it('is kept from BOTH passes (never superseded), unlike a real mutating action', () => {
    const turn1: ManagerAction[] = [
      { type: 'scan_project', depth: 'quick' },
      { type: 'create_draft', task: 'wrong plan', title: 'Wrong' },
    ];
    const turn2: ManagerAction[] = [
      { type: 'scan_project', depth: 'deep' },
      { type: 'create_draft', task: 'right plan', title: 'Right' },
    ];

    const result = mergeManagerActions(turn1, turn2);

    // Both scan_project calls survive (grounding — never dropped/superseded).
    expect(result.actions).toContainEqual(turn1[0]);
    expect(result.actions).toContainEqual(turn2[0]);
    // Only turn-2's mutating create_draft executes.
    expect(result.actions).not.toContainEqual(turn1[1]);
    expect(result.actions).toContainEqual(turn2[1]);
    expect(result.supersededMutantCount).toBe(1);
  });

  it('single-pass scan_project alongside a mutating action: nothing superseded', () => {
    const turn1: ManagerAction[] = [
      { type: 'scan_project' },
      { type: 'create_draft', task: 'a', title: 'A' },
    ];
    const result = mergeManagerActions(turn1, []);
    expect(result.supersededMutantCount).toBe(0);
    expect(result.actions).toEqual(expect.arrayContaining(turn1));
  });
});
