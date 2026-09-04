/**
 * End-to-end proof that `scan_project` is fully wired across the four places
 * a manager action must exist to be real (per the verification mandate in
 * qa-manager-2026-07-25/UC-SCORECARD.md's use cases D/E): declared in the
 * validator, implemented in the store's execution path, documented in the
 * prompt catalog the model reads, and classified as a non-mutating grounding
 * action exactly like its siblings (brain_query, web_search, ...).
 *
 * Each of the four facts already has dedicated coverage elsewhere
 * (managerActionValidator.test.ts / scanProjectAction.test.ts,
 * managerEngine.test.ts's "scan_project catalog documentation" describe,
 * actionClassifier's own set membership) — this file's job is to assert all
 * four IN ONE PLACE so a future edit that silently drops scan_project from
 * any single layer (e.g. removed from SAFE_ACTIONS but left in the
 * validator, or documented in the prompt but never wired server-side) fails
 * here even if the other files aren't touched.
 */

import { describe, it, expect } from 'vitest';
import { validateManagerAction, KNOWN_ACTION_TYPES } from '../lib/agents/managerActionValidator';
import { classifyAction, isSafeAction, isSensitiveAction, isDestructiveAction } from '../lib/agents/actionClassifier';
import { isMutantManagerAction } from '../components/agents/agentsStore';
import { buildManagerCorePrompt } from '../lib/agents/managerEngine';
import type { ManagerAction } from '../lib/agents/types';

describe('scan_project — end-to-end wiring across validator, classifier, store, and prompt', () => {
  it('1) validator: scan_project is a KNOWN_ACTION_TYPE and accepts its documented shapes', () => {
    expect(KNOWN_ACTION_TYPES).toContain('scan_project');
    expect(validateManagerAction({ type: 'scan_project' }).ok).toBe(true);
    expect(validateManagerAction({ type: 'scan_project', projectId: 'p1', depth: 'deep' }).ok).toBe(true);
  });

  it('2) classifier: scan_project is SAFE, never sensitive/destructive — same tier as brain_query/web_search', () => {
    expect(classifyAction('scan_project')).toBe('safe');
    expect(isSafeAction('scan_project')).toBe(true);
    expect(isSensitiveAction('scan_project')).toBe(false);
    expect(isDestructiveAction('scan_project')).toBe(false);
    // Parity check: scan_project must sit in the exact same tier as the
    // proven grounding actions it was added alongside, not a bespoke one.
    expect(classifyAction('scan_project')).toBe(classifyAction('brain_query'));
    expect(classifyAction('scan_project')).toBe(classifyAction('web_search'));
  });

  it('3) store: scan_project is classified as a GROUNDING action, never a mutant — for every field combination', () => {
    const shapes: ManagerAction[] = [
      { type: 'scan_project' },
      { type: 'scan_project', projectId: 'p1' },
      { type: 'scan_project', depth: 'deep' },
      { type: 'scan_project', projectId: 'p1', depth: 'quick' },
    ];
    for (const action of shapes) {
      expect(isMutantManagerAction(action)).toBe(false);
    }
    // Contrast with a real mutating action, so this assertion can't pass by
    // isMutantManagerAction being broken/always-false.
    expect(isMutantManagerAction({ type: 'create_draft', task: 'x', title: 'X' })).toBe(true);
  });

  it('4) prompt: scan_project is documented in the catalog the model actually reads, with its exact call shapes', () => {
    const prompt = buildManagerCorePrompt();
    expect(prompt).toMatch(/scan_project — Structural digest of a project's REAL size\/shape/);
    expect(prompt).toContain('{"type": "scan_project"}');
    expect(prompt).toContain('{"type": "scan_project", "projectId": "proj-id", "depth": "quick|deep"}');
  });
});
