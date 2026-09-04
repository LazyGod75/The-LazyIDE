/**
 * D88 — buildBrainDrivenContext is templates/orchestrators, not LazyBrain.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return { ...actual, getProviderMode: vi.fn() };
});
vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: { recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }) },
  })),
}));

import {
  buildBrainDrivenContext,
  buildTemplateOrchestratorContext,
} from '../lib/agents/managerContext';
import { recordTemplate, clearTemplates } from '../lib/agents/agentTemplates';
import { buildManagerDynamicContext, gatherManagerContext } from '../lib/agents/managerEngine';
import { getAllProjects, unregisterProject } from '../lib/agents/globalRuntime';

describe('buildTemplateOrchestratorContext (D88 honest name)', () => {
  beforeEach(() => {
    clearTemplates();
    for (const p of getAllProjects()) unregisterProject(p.projectId);
  });

  it('lists reusable templates, not LazyBrain neurons', () => {
    recordTemplate({ name: 'fix-auth', taskPattern: 'fix auth' });
    const ctx = buildTemplateOrchestratorContext('auth question');
    expect(ctx).toContain('Reusable templates');
    expect(ctx).toContain('fix-auth');
    expect(ctx).not.toMatch(/LazyBrain|#n\d+/);
  });

  it('keeps buildBrainDrivenContext as a compatible alias', () => {
    recordTemplate({ name: 'tmpl-alias', taskPattern: 'x' });
    expect(buildBrainDrivenContext('q')).toBe(buildTemplateOrchestratorContext('q'));
  });

  it('renders an honest header in the manager prompt', async () => {
    recordTemplate({ name: 'tmpl-prompt', taskPattern: 'x' });
    const ctx = await gatherManagerContext([], []);
    const dynamic = buildManagerDynamicContext(ctx);
    expect(dynamic).toContain('Agent templates & orchestrators (not LazyBrain recall)');
    expect(dynamic).not.toContain('Brain-Driven Context');
    expect(dynamic).toContain('tmpl-prompt');
  });
});
