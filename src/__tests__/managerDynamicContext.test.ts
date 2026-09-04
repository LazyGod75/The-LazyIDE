import { describe, it, expect } from 'vitest';
import {
  presentSection,
  groundedResultBlock,
  formatVisibleMissionLines,
  MAX_MANAGER_MISSION_LINES,
} from '../lib/agents/managerDynamicContext';
import type { Mission } from '../lib/agents/types';

function missionAt(id: string, overrides: Partial<Mission> = {}): Mission {
  return { id, title: `Mission ${id}`, status: 'done', model: 'sonnet', ...overrides } as Mission;
}

describe('managerDynamicContext helpers', () => {
  it('presentSection omits undefined and keeps a present string', () => {
    expect(presentSection(undefined, (v) => `X${v}`)).toBe('');
    expect(presentSection('hi', (v) => `X${v}`)).toBe('Xhi');
  });

  it('presentSection trim drops whitespace-only the way startup context did', () => {
    expect(presentSection('   ', (v) => `X${v}`, true)).toBe('');
    expect(presentSection('  note  ', (v) => `X${v}`, true)).toBe('Xnote');
  });

  it('groundedResultBlock is omitted when the lookup never ran', () => {
    expect(groundedResultBlock('T', undefined, 'do not invent')).toBe('');
    expect(groundedResultBlock('T', 'real', 'cite it')).toContain('### T');
    expect(groundedResultBlock('T', 'real', 'cite it')).toContain('real');
  });

  it('formatVisibleMissionLines drops archived and keeps the most recent cap', () => {
    const missions = [
      missionAt('M1'),
      missionAt('M2', { archived: true }),
      ...Array.from({ length: MAX_MANAGER_MISSION_LINES + 3 }, (_, i) => missionAt(`N${i + 1}`)),
    ];
    const lines = formatVisibleMissionLines(missions);
    expect(lines.some((l) => l.startsWith('- M2:'))).toBe(false);
    expect(lines.some((l) => l.startsWith('- M1:'))).toBe(false);
    expect(lines[lines.length - 1]).toMatch(/- N\d+:/);
    expect(lines).toHaveLength(MAX_MANAGER_MISSION_LINES);
  });

  it('formatVisibleMissionLines includes real branch/reason, never placeholders', () => {
    const [line] = formatVisibleMissionLines([
      missionAt('M6', { worktree: 'agent/M6-x', statusReason: 'CLI session limit', agentName: 'coder' }),
    ]);
    expect(line).toContain('branch=agent/M6-x');
    expect(line).toContain('reason=CLI session limit');
    expect(line).toContain('@coder');
  });
});
