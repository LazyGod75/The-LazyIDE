import { describe, it, expect } from 'vitest';
import { findFileActivity, isFileInProgress, matchesScopePaths, fileActivityDotChrome, fileActivityWhoLine } from '../lib/agents/codeFileActivity';
import type { FleetMission } from '../lib/agents/fleetMissions';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Test mission',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: Date.now(),
    urgent: false,
    ...overrides,
  };
}

describe('findFileActivity', () => {
  it('returns null when no mission touches the file', () => {
    expect(findFileActivity('src/a.ts', 'a.ts', [mission()])).toBeNull();
  });

  it('matches a running mission via diffFiles', () => {
    const m = mission({ diffFiles: [{ filename: 'src/components/PricingTable.tsx', added: 10, removed: 2 }] });
    const activity = findFileActivity('src/components/PricingTable.tsx', 'PricingTable.tsx', [m]);
    expect(activity).toEqual({ kind: 'run', mission: m });
  });

  it('matches a running mission via liveAction free text fallback', () => {
    const m = mission({ liveAction: '▊ écrit PricingTable.tsx…' });
    const activity = findFileActivity('src/components/PricingTable.tsx', 'PricingTable.tsx', [m]);
    expect(activity).toEqual({ kind: 'run', mission: m });
  });

  it('prioritizes a pending question over a plain run match', () => {
    const runOnly = mission({ id: 'm-run', diffFiles: [{ filename: 'a.ts', added: 1, removed: 0 }] });
    const blocked = mission({ id: 'm-blocked', diffFiles: [{ filename: 'a.ts', added: 1, removed: 0 }], pendingQuestion: 'Should I proceed?' });
    const activity = findFileActivity('a.ts', 'a.ts', [runOnly, blocked]);
    expect(activity).toEqual({ kind: 'question', mission: blocked });
  });

  it('matches a failed mission via diffFiles', () => {
    const m = mission({ status: 'failed', diffFiles: [{ filename: 'src/engine/backtest.py', added: 5, removed: 1 }] });
    const activity = findFileActivity('src/engine/backtest.py', 'backtest.py', [m]);
    expect(activity).toEqual({ kind: 'failed', mission: m });
  });

  it('matches a review mission via diffFiles so Code can show the cursor', () => {
    const m = mission({
      status: 'review',
      diffFiles: [{ filename: 'src/auth.ts', added: 2, removed: 0 }],
    });
    expect(findFileActivity('src/auth.ts', 'auth.ts', [m])).toEqual({ kind: 'review', mission: m });
  });

  it('does not match a review mission from stale liveAction', () => {
    const m = mission({ status: 'review', liveAction: '▊ écrit other.ts…' });
    expect(findFileActivity('other.ts', 'other.ts', [m])).toBeNull();
  });

  it('does not match a failed mission with no diffFiles reference', () => {
    const m = mission({ status: 'failed', diffFiles: [{ filename: 'other.py', added: 1, removed: 0 }] });
    expect(findFileActivity('backtest.py', 'backtest.py', [m])).toBeNull();
  });
});

describe('fileActivityDotChrome', () => {
  it('does not paint a blocked question as a failure', () => {
    expect(fileActivityDotChrome('question').color).toBe('var(--color-warning)');
    expect(fileActivityDotChrome('failed').color).toBe('var(--color-danger)');
    expect(fileActivityDotChrome('review').color).toBe('var(--color-warning)');
    expect(fileActivityDotChrome('review').animation).toContain('blinkDot');
  });
});

describe('fileActivityWhoLine', () => {
  it('names the agent and the live file, never raw JSON', () => {
    const activity = findFileActivity(
      'src/auth.ts',
      'auth.ts',
      [mission({ agentName: 'Coder', liveAction: 'Write: Write {"file_path":"src/auth.ts","content":"x"}' })],
    );
    expect(activity).not.toBeNull();
    expect(fileActivityWhoLine(activity!)).toBe('Coder · écrit auth.ts');
    expect(fileActivityWhoLine(activity!)).not.toContain('{');
  });

  it('surfaces the real pending question instead of inventing copy', () => {
    const activity = findFileActivity(
      'a.ts',
      'a.ts',
      [mission({ agentName: 'Coder', diffFiles: [{ filename: 'a.ts', added: 1, removed: 0 }], pendingQuestion: 'Overwrite auth.rs?' })],
    );
    expect(fileActivityWhoLine(activity!)).toBe('Coder · Overwrite auth.rs?');
  });

  it('falls back to the model id when the mission has no agentName', () => {
    const activity = findFileActivity(
      'a.ts',
      'a.ts',
      [mission({ agentName: undefined, model: 'opus', liveAction: '▊ écrit a.ts…' })],
    );
    expect(fileActivityWhoLine(activity!)).toMatch(/^opus · /);
  });

  it('review who-line uses the status + real file, never a stale liveAction', () => {
    const activity = findFileActivity(
      'src/auth.ts',
      'auth.ts',
      [mission({
        status: 'review',
        agentName: 'Judge',
        liveAction: 'Running reviewer sub-agent…',
        diffFiles: [{ filename: 'src/auth.ts', added: 2, removed: 0 }],
      })],
    );
    expect(activity?.kind).toBe('review');
    const t = (key: string) => key;
    expect(fileActivityWhoLine(activity!, t)).toBe('Judge · agents.status.review · auth.ts');
    expect(fileActivityWhoLine(activity!, t)).not.toContain('Running reviewer');
  });
});

describe('isFileInProgress', () => {
  it('is true only when the matching diffFiles entry is inProgress', () => {
    const m = mission({ diffFiles: [{ filename: 'a.ts', added: 1, removed: 0, inProgress: true }] });
    expect(isFileInProgress('a.ts', 'a.ts', m)).toBe(true);
  });

  it('is false when the file is not marked inProgress', () => {
    const m = mission({ diffFiles: [{ filename: 'a.ts', added: 1, removed: 0 }] });
    expect(isFileInProgress('a.ts', 'a.ts', m)).toBe(false);
  });
});

describe('matchesScopePaths', () => {
  it('matches an exact path', () => {
    expect(matchesScopePaths('src/auth.rs', ['src/auth.rs'])).toBe(true);
  });

  it('matches a path under a scope directory prefix', () => {
    expect(matchesScopePaths('src/server/anticheat/detection.rs', ['src/server/anticheat'])).toBe(true);
  });

  it('does not match a sibling path with a shared prefix', () => {
    expect(matchesScopePaths('src/server-extra/x.rs', ['src/server'])).toBe(false);
  });

  it('returns false for an empty scope list', () => {
    expect(matchesScopePaths('src/a.ts', [])).toBe(false);
  });
});
