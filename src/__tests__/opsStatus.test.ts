import { describe, it, expect } from 'vitest';
import { parseOpsStatusJson } from '../lib/brain/opsStatus';

describe('parseOpsStatusJson', () => {
  it('reads the camelCase snapshot rust writes to _cache/ops-status.json', () => {
    const parsed = parseOpsStatusJson(
      JSON.stringify({
        updatedAt: '2026-09-03T00:00:00Z',
        phase: 'running',
        step: 'dream',
        pid: 4242,
        timeoutSecs: 600,
        brainPath: 'C:/brains/team',
      }),
    );
    expect(parsed).toEqual({
      updatedAt: '2026-09-03T00:00:00Z',
      phase: 'running',
      step: 'dream',
      pid: 4242,
      timeoutSecs: 600,
      detail: null,
      brainPath: 'C:/brains/team',
    });
  });

  it('returns null on garbage so a missing/older binary cannot crash readers', () => {
    expect(parseOpsStatusJson('not json')).toBeNull();
    expect(parseOpsStatusJson('{}')).toBeNull();
  });
});
