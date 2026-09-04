import { describe, it, expect } from 'vitest';
import { collectLiveTeamAgents, liveAgentWorkLine, liveAgentCursorLine } from '../lib/teams/liveTeamAgents';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Fix login',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: 100,
    urgent: false,
    ...overrides,
  };
}

function project(overrides: Partial<FleetProject> = {}): FleetProject {
  return {
    projectId: 'p1',
    root: '/tmp/p1',
    name: 'lazy',
    missions: [],
    ...overrides,
  };
}

describe('collectLiveTeamAgents', () => {
  it('keeps running/queued/review and drops done/failed', () => {
    const live = collectLiveTeamAgents([
      project({
        missions: [
          mission({ id: 'run', status: 'running', agentName: 'Coder', liveAction: 'Editing src/a.ts', updatedMs: 3 }),
          mission({ id: 'queue', status: 'queued', agentName: 'Reviewer', updatedMs: 2 }),
          mission({ id: 'rev', status: 'review', agentName: 'Judge', updatedMs: 1 }),
          mission({ id: 'done', status: 'done', agentName: 'Old', updatedMs: 9 }),
          mission({ id: 'fail', status: 'failed', agentName: 'Boom', updatedMs: 8 }),
        ],
      }),
    ]);
    expect(live.map((a) => a.missionId)).toEqual(['run', 'queue', 'rev']);
    expect(live[0].liveAction).toBe('Editing src/a.ts');
  });

  it('falls back to the model id when the mission has no agentName', () => {
    const live = collectLiveTeamAgents([
      project({ missions: [mission({ agentName: undefined, model: 'opus' })] }),
    ]);
    expect(live[0].agentName).toBe('opus');
  });

  it('exposes the first real diffFiles basename as cursorFile', () => {
    const live = collectLiveTeamAgents([
      project({
        missions: [
          mission({
            id: 'rev',
            status: 'review',
            liveAction: '',
            diffFiles: [{ filename: 'src/lib/auth.ts', added: 4, removed: 1 }],
          }),
        ],
      }),
    ]);
    expect(live[0].cursorFile).toBe('auth.ts');
  });
});

describe('liveAgentWorkLine', () => {
  it('turns a Write tool JSON step into verb + basename, never the raw JSON', () => {
    const raw = 'Write: Write {"file_path":"src/auth.ts","content":"x"}';
    expect(liveAgentWorkLine(raw)).toBe('écrit auth.ts');
    expect(liveAgentWorkLine(raw)).not.toContain('{');
  });

  it('passes already-human liveAction through unchanged', () => {
    expect(liveAgentWorkLine('Worktree prêt — démarrage du loop…')).toBe(
      'Worktree prêt — démarrage du loop…',
    );
  });
});

describe('liveAgentCursorLine', () => {
  it('review ignores a stale liveAction and uses the real diffFiles basename', () => {
    const t = (key: string, params?: Record<string, string | number>) => {
      if (params) return `${params.action} · ${params.project}`;
      return key;
    };
    const line = liveAgentCursorLine({
      missionId: 'rev',
      title: 'Fix login',
      status: 'review',
      agentName: 'Judge',
      liveAction: 'Running reviewer sub-agent…',
      cursorFile: 'auth.ts',
      projectName: 'lazy',
      projectId: 'p1',
      updatedMs: 1,
    }, t);
    expect(line).toBe('agents.status.review · auth.ts · lazy');
    expect(line).not.toContain('Running reviewer');
  });
});
