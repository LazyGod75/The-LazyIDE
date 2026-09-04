import { describe, it, expect, vi } from 'vitest';
import { appendAfterEditCheckpoint } from '../lib/agents/afterEditCheckpoint';
import { withRunDefaults, runtimeLabel } from '../lib/agents/runMissionOpts';

describe('appendAfterEditCheckpoint', () => {
  it('stays silent when there is no undo snapshot (new file create)', () => {
    const out = appendAfterEditCheckpoint({
      action: 'write_file',
      observation: 'Successfully wrote src/new.ts',
      files: ['src/new.ts'],
      hasCheckpoint: () => false,
    });
    expect(out).toBe('Successfully wrote src/new.ts');
  });

  it('names the real path when an undo snapshot exists', () => {
    const hasCheckpoint = vi.fn((path: string) => path === 'src/foo.ts');
    const out = appendAfterEditCheckpoint({
      action: 'edit_file',
      observation: 'Successfully edited src/foo.ts',
      files: ['src/foo.ts'],
      hasCheckpoint,
    });
    expect(out).toContain('undo_edit on src/foo.ts');
    expect(out).not.toMatch(/cp-[a-z0-9]+/i);
  });
});

describe('withRunDefaults', () => {
  it('fills omitted signals without inventing caps', () => {
    const onUpdate = vi.fn();
    const n = withRunDefaults({ onUpdate });
    expect(n.stopSignal()).toBe(false);
    expect(n.pauseSignal()).toBe(false);
    expect(n.drainIntervenes()).toEqual([]);
    expect(n.getBudgetCapUsd()).toBeUndefined();
    expect(n.getMaxDurationMs()).toBeUndefined();
  });
});

describe('runtimeLabel', () => {
  it('uses t when present, otherwise the fallback', () => {
    expect(runtimeLabel(undefined, 'k', 'Stoppé')).toBe('Stoppé');
    expect(runtimeLabel((key) => `T:${key}`, 'agents.runtime.stopped', 'Stoppé')).toBe('T:agents.runtime.stopped');
  });
});
