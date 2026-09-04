import { describe, it, expect } from 'vitest';
import { collectCodeLiveFiles } from '../lib/agents/codeLiveFiles';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';
import { basename } from '../lib/paths';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Test',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: Date.now(),
    urgent: false,
    ...overrides,
  };
}

function project(overrides: Partial<FleetProject> = {}): FleetProject {
  return {
    projectId: 'p1',
    root: '/tmp/docs',
    name: 'Lazy-Docs',
    missions: [],
    ...overrides,
  };
}

describe('collectCodeLiveFiles', () => {
  it('is empty when no mission has diffFiles', () => {
    expect(collectCodeLiveFiles([project({ missions: [mission()] })])).toEqual([]);
  });

  it('surfaces a review file so Code can show it without expanding the tree', () => {
    const m = mission({
      status: 'review',
      diffFiles: [{ filename: 'commands-git.mdx', added: 2, removed: 0 }],
    });
    const files = collectCodeLiveFiles([project({ missions: [m] })]);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('commands-git.mdx');
    expect(files[0].projectName).toBe('Lazy-Docs');
    expect(files[0].activity.kind).toBe('review');
    expect(basename(files[0].absPath)).toBe('commands-git.mdx');
  });

  it('does not invent a review file from stale liveAction', () => {
    const m = mission({ status: 'review', liveAction: '▊ écrit other.ts…' });
    expect(collectCodeLiveFiles([project({ missions: [m] })])).toEqual([]);
  });

  it('ranks a blocked question ahead of a review on another file', () => {
    const review = mission({
      id: 'rev',
      status: 'review',
      diffFiles: [{ filename: 'b.ts', added: 1, removed: 0 }],
    });
    const blocked = mission({
      id: 'q',
      diffFiles: [{ filename: 'a.ts', added: 1, removed: 0 }],
      pendingQuestion: 'Overwrite?',
    });
    const files = collectCodeLiveFiles([project({ missions: [review, blocked] })]);
    expect(files.map((f) => f.filename)).toEqual(['a.ts', 'b.ts']);
    expect(files[0].activity.kind).toBe('question');
    expect(files[1].activity.kind).toBe('review');
  });
});
