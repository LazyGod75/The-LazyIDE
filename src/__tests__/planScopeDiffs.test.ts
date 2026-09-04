import { describe, it, expect } from 'vitest';
import { firstNonNull } from '../lib/brain/firstNonNull';
import { loadPlanScopeDiffs, usablePlanDiff } from '../lib/agents/planScopeDiffs';

describe('firstNonNull', () => {
  it('resolves the first non-null without waiting for a hanging miss', async () => {
    const started = Date.now();
    const value = await firstNonNull([
      new Promise<string | null>(() => {}),
      Promise.resolve('http-hit'),
    ]);
    expect(value).toBe('http-hit');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('returns null when every job misses', async () => {
    expect(await firstNonNull([Promise.resolve(null), Promise.reject(new Error('x'))])).toBeNull();
  });
});

describe('usablePlanDiff', () => {
  it('drops empty, no-changes, and ERROR payloads', () => {
    expect(usablePlanDiff('')).toBeNull();
    expect(usablePlanDiff('No changes')).toBeNull();
    expect(usablePlanDiff('ERROR: git_diff failed')).toBeNull();
    expect(usablePlanDiff('+ok')).toBe('+ok');
  });
});

describe('loadPlanScopeDiffs', () => {
  it('joins only real diffs and never invents a hunk', async () => {
    const text = await loadPlanScopeDiffs(['src/a.ts', 'src/b.ts'], async (path) => {
      if (path === 'src/a.ts') return 'diff --git a/src/a.ts\n+x';
      return 'No changes';
    });
    expect(text).toContain('src/a.ts');
    expect(text).toContain('+x');
    expect(text).not.toContain('src/b.ts');
  });
});
