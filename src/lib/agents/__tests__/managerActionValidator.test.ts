import { describe, expect, it } from 'vitest';
import { validateManagerAction } from '../managerActionValidator';

describe('validateManagerAction — launch_mission', () => {
  it('accepts a plain task-only launch', () => {
    expect(validateManagerAction({ type: 'launch_mission', task: 'do x' })).toEqual({ ok: true });
  });

  it('rejects a missing task', () => {
    const r = validateManagerAction({ type: 'launch_mission' });
    expect(r.ok).toBe(false);
  });

  // Regression (2026-08-03, mission M8 out_of_scope_path): the manager can
  // target another OPEN project via projectId — the validator must not
  // reject the field that routes the launch away from the active project.
  it('accepts an optional string projectId', () => {
    expect(validateManagerAction({ type: 'launch_mission', task: 'do x', projectId: 'lazy-backoffice' })).toEqual({ ok: true });
  });

  it('rejects a non-string projectId when present', () => {
    const r = validateManagerAction({ type: 'launch_mission', task: 'do x', projectId: 42 });
    expect(r.ok).toBe(false);
  });

  // Cross-project READ access (confirmed gap, live run): extraReadableProjectIds
  // lets the manager declare which OTHER open projects this mission's agent
  // may read from — the validator must accept a well-formed list and reject
  // anything that is not an array of non-empty strings.
  it('accepts an optional string array extraReadableProjectIds', () => {
    expect(
      validateManagerAction({ type: 'launch_mission', task: 'do x', extraReadableProjectIds: ['other-project'] }),
    ).toEqual({ ok: true });
  });

  it('accepts launch_mission with no extraReadableProjectIds at all (unchanged default)', () => {
    expect(validateManagerAction({ type: 'launch_mission', task: 'do x' })).toEqual({ ok: true });
  });

  it('rejects a non-array extraReadableProjectIds', () => {
    const r = validateManagerAction({ type: 'launch_mission', task: 'do x', extraReadableProjectIds: 'other-project' });
    expect(r.ok).toBe(false);
  });

  it('rejects an extraReadableProjectIds array containing a non-string entry', () => {
    const r = validateManagerAction({ type: 'launch_mission', task: 'do x', extraReadableProjectIds: ['ok', 42] });
    expect(r.ok).toBe(false);
  });

  it('rejects an extraReadableProjectIds array containing an empty string', () => {
    const r = validateManagerAction({ type: 'launch_mission', task: 'do x', extraReadableProjectIds: [''] });
    expect(r.ok).toBe(false);
  });
});
