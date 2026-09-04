/**
 * A11 — compact "other projects" digest from the existing fleet registry.
 * Read-only: registerProject / setProjectMissions (globalRuntime), no bots/solari.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registerProject,
  unregisterProject,
  getAllProjects,
  setProjectMissions,
} from '../lib/agents/globalRuntime';
import { buildOtherProjectsDigest } from '../lib/agents/managerContext';
import { buildManagerDynamicContext, gatherManagerContext } from '../lib/agents/managerEngine';
import type { Mission } from '../lib/agents/types';

function makeMission(id: string, title: string, status: Mission['status']): Mission {
  return {
    id,
    title,
    status,
    agentName: 'Coder',
    model: 'sonnet',
    agentTask: 'do stuff',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Mission;
}

describe('buildOtherProjectsDigest (A11)', () => {
  beforeEach(() => {
    for (const p of getAllProjects()) unregisterProject(p.projectId);
  });

  afterEach(() => {
    for (const p of getAllProjects()) unregisterProject(p.projectId);
  });

  it('returns undefined when the fleet is empty', () => {
    expect(buildOtherProjectsDigest()).toBeUndefined();
    expect(buildOtherProjectsDigest(['M1'])).toBeUndefined();
  });

  it('omits missions already on the active board', () => {
    registerProject('active', '/active', 'Active');
    setProjectMissions('active', [makeMission('M1', 'Active work', 'running')]);
    expect(buildOtherProjectsDigest(['M1'])).toBeUndefined();
  });

  it('lists missions from other registered projects', () => {
    registerProject('active', '/active', 'Active');
    registerProject('other', '/other', 'Other App');
    setProjectMissions('active', [makeMission('M1', 'Active work', 'running')]);
    setProjectMissions('other', [
      makeMission('M9', 'Deploy preview', 'review'),
      makeMission('M10', 'Fix auth', 'running'),
    ]);

    const digest = buildOtherProjectsDigest(['M1']);
    expect(digest).toBeDefined();
    expect(digest).toContain('Other App: M9 "Deploy preview" [review]');
    expect(digest).toContain('Other App: M10 "Fix auth" [running]');
    expect(digest).not.toMatch(/\bM1\b/);
  });

  it('is injected into the dynamic prompt via gatherManagerContext', async () => {
    registerProject('active', '/active', 'Active');
    registerProject('other', '/other', 'Other App');
    const active = [makeMission('M1', 'Active work', 'running')];
    setProjectMissions('active', active);
    setProjectMissions('other', [makeMission('M9', 'Deploy preview', 'review')]);

    const ctx = await gatherManagerContext([], active);
    expect(ctx.otherProjectsDigest).toContain('M9');
    const dynamic = buildManagerDynamicContext(ctx);
    expect(dynamic).toContain('Other projects (compact');
    expect(dynamic).toContain('Deploy preview');
    expect(dynamic).toContain('M9');
  });
});
