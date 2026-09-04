/**
 * toolRuntime.transform.test.ts — W-CODE execution-wiring proof: the
 * `list_transforms`/`run_transform` tool cases in lib/tools/toolRuntime.ts
 * are the ONLY custom-tool kind actually dispatched for a MANAGED mission
 * (see toolRuntime.ts's own header for why declarativeTools/
 * projectCommandTools are NOT wired the same way, and why this one is
 * deliberately managed-mission-only). This file proves: discovery
 * (list_transforms), successful execution (run_transform with a real
 * transform), unknown tool_id handling, missing tool_id handling, and that
 * a failing/timing-out transformation surfaces as an honest ERROR
 * observation rather than throwing and crashing the calling mission loop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { executeTool } from '../lib/tools/toolRuntime';
import type { ToolExecutionContext } from '../lib/tools/toolRuntime';
import { saveTransformTool, generateTransformToolId, _resetTransformToolsForTests } from '../lib/agents/transformTools';

function makeCtx(): ToolExecutionContext {
  return {
    rootPath: '/tmp/project',
    policy: {},
    agentMode: 'default',
  };
}

beforeEach(() => {
  _resetTransformToolsForTests();
  localStorage.clear();
});

describe('executeTool — list_transforms', () => {
  it('reports an empty catalog honestly', async () => {
    const result = await executeTool('list_transforms', {}, makeCtx());
    expect(result).toBe('No transformation tools defined for this project.');
  });

  it('lists every saved tool by id, name, and description', async () => {
    const id = generateTransformToolId();
    await saveTransformTool({
      id,
      name: 'Double items',
      description: 'Doubles every number in input.items.',
      code: 'return input.items.map((x) => x * 2);',
      createdAt: new Date().toISOString(),
    });

    const result = await executeTool('list_transforms', {}, makeCtx());
    expect(result).toContain(id);
    expect(result).toContain('Double items');
    expect(result).toContain('Doubles every number in input.items.');
  });
});

describe('executeTool — run_transform', () => {
  it('requires a tool_id and says so honestly instead of guessing', async () => {
    const result = await executeTool('run_transform', { input: {} }, makeCtx());
    expect(result).toMatch(/^ERROR: No tool_id provided/);
  });

  it('reports an unknown tool_id honestly, pointing back at list_transforms', async () => {
    const result = await executeTool('run_transform', { tool_id: 'does-not-exist', input: {} }, makeCtx());
    expect(result).toMatch(/^ERROR: no transformation tool with id "does-not-exist"/);
    expect(result).toMatch(/list_transforms/);
  });

  it('runs a real attached transformation and returns its JSON result', async () => {
    const id = generateTransformToolId();
    await saveTransformTool({
      id,
      name: 'Double items',
      description: 'Doubles every number in input.items.',
      code: 'return input.items.map((x) => x * 2);',
      createdAt: new Date().toISOString(),
    });

    const result = await executeTool('run_transform', { tool_id: id, input: { items: [1, 2, 3] } }, makeCtx());
    expect(result).toContain('Transformation "Double items" result:');
    expect(result).toContain('[2,4,6]');
  });

  it('surfaces a sandbox failure (thrown exception) as an honest ERROR, never throwing itself', async () => {
    const id = generateTransformToolId();
    await saveTransformTool({
      id,
      name: 'Broken transform',
      description: 'Deliberately throws.',
      code: 'return input.doesNotExist.nested;',
      createdAt: new Date().toISOString(),
    });

    const result = await executeTool('run_transform', { tool_id: id, input: {} }, makeCtx());
    expect(result).toMatch(/^ERROR: transformation "Broken transform" failed:/);
  });

  it('surfaces a timeout as an honest ERROR rather than hanging the mission loop', async () => {
    const id = generateTransformToolId();
    await saveTransformTool({
      id,
      name: 'Infinite loop',
      description: 'Deliberately never returns.',
      code: 'while (true) {}',
      createdAt: new Date().toISOString(),
    });

    const result = await executeTool('run_transform', { tool_id: id, input: {} }, makeCtx());
    expect(result).toMatch(/^ERROR: transformation "Infinite loop" failed:/);
  }, 10_000);
});
