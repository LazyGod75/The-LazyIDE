import { describe, it, expect } from 'vitest';
import { makeRef, parseRef, projectColor } from '../components/agents/canvas/canvasTypes';

describe('makeRef / parseRef', () => {
  it('round-trips every node kind', () => {
    expect(parseRef(makeRef('project', 'p1'))).toEqual({ kind: 'project', id: 'p1' });
    expect(parseRef(makeRef('mission', 'm1'))).toEqual({ kind: 'mission', id: 'm1' });
    expect(parseRef(makeRef('loop', 'l1'))).toEqual({ kind: 'loop', id: 'l1' });
    expect(parseRef(makeRef('schedule', 's1'))).toEqual({ kind: 'schedule', id: 's1' });
    expect(parseRef(makeRef('draft', 'd1'))).toEqual({ kind: 'draft', id: 'd1' });
    expect(parseRef(makeRef('note', 'n1'))).toEqual({ kind: 'note', id: 'n1' });
  });

  it('keeps ids containing colons intact (id may itself embed ":")', () => {
    expect(parseRef('mission:proj:m1')).toEqual({ kind: 'mission', id: 'proj:m1' });
  });

  it('returns null on malformed refs instead of throwing', () => {
    expect(parseRef('')).toBeNull();
    expect(parseRef('nokind')).toBeNull();
    expect(parseRef(':noKind')).toBeNull();
    expect(parseRef('mission:')).toBeNull();
    expect(parseRef('bogus:m1')).toBeNull();
  });
});

describe('projectColor', () => {
  it('is deterministic for the same projectId', () => {
    expect(projectColor('proj-abc')).toBe(projectColor('proj-abc'));
  });

  it('varies across different projectIds (no collision for these fixtures)', () => {
    const colors = new Set(['proj-a', 'proj-b', 'proj-c'].map(projectColor));
    expect(colors.size).toBe(3);
  });

  it('returns a well-formed hsl() string', () => {
    expect(projectColor('proj-x')).toMatch(/^hsl\(\d{1,3}, \d+%, \d+%\)$/);
  });
});
