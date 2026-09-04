import { describe, it, expect } from 'vitest';
import {
  AGENT_EXPORT_KIND,
  AGENT_EXPORT_VERSION,
  agentExportFileName,
  buildAgentExportEnvelope,
  parseAgentExportEnvelope,
  remapImportedAgent,
} from '../lib/agents/agentImportExport';
import { createNewAgent } from '../lib/agents/agentDef';
import type { LazyAgent } from '../lib/agents/agentDef';
import type { ProjectCommandTool } from '../lib/agents/projectCommandTools';

function validAgent(overrides: Partial<LazyAgent> = {}): LazyAgent {
  return createNewAgent({
    name: 'my-reviewer',
    displayName: 'My Reviewer',
    description: 'Use this agent to review code for correctness, style, and security issues across the whole repository.',
    systemPrompt: 'You are a careful senior reviewer.',
    modelTier: 'sonnet',
    ...overrides,
  });
}

function tool(overrides: Partial<ProjectCommandTool> = {}): ProjectCommandTool {
  return {
    id: 'pctool-1',
    name: 'Run tests',
    command: 'npm test',
    description: 'Runs the full test suite.',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('buildAgentExportEnvelope', () => {
  it('produces a versioned envelope with the agent embedded verbatim', () => {
    const agent = validAgent();
    const envelope = buildAgentExportEnvelope(agent, [], 1000);
    expect(envelope.version).toBe(AGENT_EXPORT_VERSION);
    expect(envelope.kind).toBe(AGENT_EXPORT_KIND);
    expect(envelope.exportedAtMs).toBe(1000);
    expect(envelope.agent).toEqual(agent);
    expect(envelope.projectCommandTools).toEqual([]);
  });

  it('embeds only the project-command tools this agent actually references', () => {
    const t1 = tool({ id: 't1' });
    const t2 = tool({ id: 't2', name: 'Build' });
    const agent = validAgent({ projectCommandTools: ['t1'] });
    const envelope = buildAgentExportEnvelope(agent, [t1, t2]);
    expect(envelope.projectCommandTools).toEqual([t1]);
  });

  it('embeds an empty array when the agent references no project-command tools', () => {
    const envelope = buildAgentExportEnvelope(validAgent(), [tool()]);
    expect(envelope.projectCommandTools).toEqual([]);
  });
});

describe('parseAgentExportEnvelope — good input', () => {
  it('round-trips a real envelope', () => {
    const agent = validAgent({ projectCommandTools: ['pctool-1'] });
    const envelope = buildAgentExportEnvelope(agent, [tool()]);
    const raw = JSON.parse(JSON.stringify(envelope));
    const parsed = parseAgentExportEnvelope(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.agent.name).toBe(agent.name);
    expect(parsed?.projectCommandTools).toHaveLength(1);
  });

  it('accepts an agent with no optional fields set at all', () => {
    const agent = validAgent();
    const minimal: LazyAgent = {
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      color: 'violet',
      tags: [],
      systemPrompt: agent.systemPrompt,
      modelTier: 'sonnet',
      triggers: { manual: true },
      scope: 'project',
      createdAt: agent.createdAt,
    };
    const envelope = buildAgentExportEnvelope(minimal);
    const parsed = parseAgentExportEnvelope(JSON.parse(JSON.stringify(envelope)));
    expect(parsed).not.toBeNull();
  });
});

describe('parseAgentExportEnvelope — malformed input rejected honestly', () => {
  it('rejects a non-object', () => {
    expect(parseAgentExportEnvelope('not an object')).toBeNull();
    expect(parseAgentExportEnvelope(null)).toBeNull();
    expect(parseAgentExportEnvelope(42)).toBeNull();
  });

  it('rejects the wrong version', () => {
    const envelope = buildAgentExportEnvelope(validAgent());
    expect(parseAgentExportEnvelope({ ...envelope, version: 2 })).toBeNull();
  });

  it('rejects the wrong kind', () => {
    const envelope = buildAgentExportEnvelope(validAgent());
    expect(parseAgentExportEnvelope({ ...envelope, kind: 'something-else' })).toBeNull();
  });

  it('rejects a missing agent field', () => {
    const envelope = buildAgentExportEnvelope(validAgent());
    const { agent, ...rest } = envelope;
    void agent;
    expect(parseAgentExportEnvelope(rest)).toBeNull();
  });

  it('rejects an agent with a bad color enum', () => {
    const envelope = buildAgentExportEnvelope(validAgent());
    const bad = { ...envelope, agent: { ...envelope.agent, color: 'ultraviolet' } };
    expect(parseAgentExportEnvelope(bad)).toBeNull();
  });

  it('rejects an agent with a non-kebab-case name (validateAgent domain rule)', () => {
    const envelope = buildAgentExportEnvelope(validAgent());
    const bad = { ...envelope, agent: { ...envelope.agent, name: 'My Agent' } };
    expect(parseAgentExportEnvelope(bad)).toBeNull();
  });

  it('rejects an agent missing a required systemPrompt', () => {
    const envelope = buildAgentExportEnvelope(validAgent());
    const bad = { ...envelope, agent: { ...envelope.agent, systemPrompt: '' } };
    expect(parseAgentExportEnvelope(bad)).toBeNull();
  });

  it('rejects triggers.manual !== true', () => {
    const envelope = buildAgentExportEnvelope(validAgent());
    const bad = { ...envelope, agent: { ...envelope.agent, triggers: { manual: false } } };
    expect(parseAgentExportEnvelope(bad)).toBeNull();
  });

  it('rejects a malformed embedded project-command tool', () => {
    const envelope = buildAgentExportEnvelope(validAgent(), [tool()]);
    const bad = { ...envelope, projectCommandTools: [{ id: 't1' }] };
    expect(parseAgentExportEnvelope(bad)).toBeNull();
  });

  it('rejects a non-array projectCommandTools field', () => {
    const envelope = buildAgentExportEnvelope(validAgent());
    expect(parseAgentExportEnvelope({ ...envelope, projectCommandTools: 'nope' })).toBeNull();
  });
});

describe('agentExportFileName', () => {
  it('slugifies the agent name and appends the .lazyagent.json extension', () => {
    const name = agentExportFileName('My Cool Agent!!', 0);
    expect(name).toMatch(/^my-cool-agent-.*\.lazyagent\.json$/);
  });

  it('falls back to "agent" when the name has no usable characters', () => {
    const name = agentExportFileName('!!!', 0);
    expect(name.startsWith('agent-')).toBe(true);
  });
});

describe('remapImportedAgent', () => {
  it('mints a fresh id, never reusing the exported one', () => {
    const agent = validAgent();
    const envelope = buildAgentExportEnvelope(agent);
    const imported = remapImportedAgent(envelope, { idFactory: () => 'fresh-id' });
    expect(imported.id).toBe('fresh-id');
    expect(imported.id).not.toBe(agent.id);
  });

  it('defaults the imported scope to project', () => {
    const agent = validAgent({ scope: 'user' });
    const envelope = buildAgentExportEnvelope(agent);
    const imported = remapImportedAgent(envelope);
    expect(imported.scope).toBe('project');
  });

  it('honors an explicit scope override', () => {
    const envelope = buildAgentExportEnvelope(validAgent());
    const imported = remapImportedAgent(envelope, { scope: 'user' });
    expect(imported.scope).toBe('user');
  });

  it('carries over every other field verbatim', () => {
    const agent = validAgent({ tags: ['a', 'b'], color: 'cyan', modelTier: 'opus' });
    const envelope = buildAgentExportEnvelope(agent);
    const imported = remapImportedAgent(envelope);
    expect(imported.tags).toEqual(['a', 'b']);
    expect(imported.color).toBe('cyan');
    expect(imported.modelTier).toBe('opus');
    expect(imported.displayName).toBe(agent.displayName);
  });

  it('resets createdAt to a fresh timestamp', () => {
    const agent = validAgent({ createdAt: new Date(0).toISOString() });
    const envelope = buildAgentExportEnvelope(agent);
    const imported = remapImportedAgent(envelope);
    expect(new Date(imported.createdAt).getTime()).toBeGreaterThan(0);
  });
});
