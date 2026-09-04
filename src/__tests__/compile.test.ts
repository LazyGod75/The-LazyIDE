import { describe, it, expect } from 'vitest';
import { buildClaudeCodeAgentMd, compileToClaudeCodeWeb, getWebMockFile } from '../lib/agents/compile';
import { createAgentTemplate, createNewAgent } from '../lib/agents/agentDef';
import type { LazyAgent } from '../lib/agents/agentDef';
import type { ProjectCommandTool } from '../lib/agents/projectCommandTools';
import type { DeclarativeTool } from '../lib/agents/declarativeTools';
import type { TransformTool } from '../lib/agents/transformTools';

function makeAgent(overrides: Partial<LazyAgent> = {}): LazyAgent {
  return createNewAgent({
    name: 'security-reviewer',
    displayName: 'Security Reviewer',
    description: 'Use this agent to review code for security vulnerabilities and exposed secrets.',
    systemPrompt: 'You are a senior security engineer. Review for vulnerabilities.',
    color: 'red',
    tags: ['security'],
    modelTier: 'sonnet',
    permissionMode: 'plan',
    maxTurns: 20,
    tools: { deny: ['WebSearch', 'computer'] },
    scope: 'project',
    ...overrides,
  });
}

describe('buildClaudeCodeAgentMd', () => {
  it('starts and ends with --- (frontmatter)', () => {
    const md = buildClaudeCodeAgentMd(makeAgent());
    const lines = md.split('\n');
    expect(lines[0]).toBe('---');
    const closingIdx = lines.indexOf('---', 1);
    expect(closingIdx).toBeGreaterThan(0);
  });

  it('contains name field', () => {
    const md = buildClaudeCodeAgentMd(makeAgent());
    expect(md).toContain('name: security-reviewer');
  });

  it('contains description field', () => {
    const agent = makeAgent();
    const md = buildClaudeCodeAgentMd(agent);
    expect(md).toContain(`description: ${agent.description}`);
  });

  it('maps sonnet tier to claude-sonnet-5', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ modelTier: 'sonnet' }));
    expect(md).toContain('model: claude-sonnet-5');
  });

  it('maps haiku tier to claude-haiku-4-5', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ modelTier: 'haiku' }));
    expect(md).toContain('model: claude-haiku-4-5');
  });

  it('maps opus tier to claude-opus-5', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ modelTier: 'opus' }));
    expect(md).toContain('model: claude-opus-5');
  });

  it('maps inherit tier to claude-sonnet-5 (default)', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ modelTier: 'inherit' }));
    expect(md).toContain('model: claude-sonnet-5');
  });

  it('includes deny tools when set', () => {
    const md = buildClaudeCodeAgentMd(makeAgent());
    expect(md).toContain('tools:');
    expect(md).toContain('deny: [WebSearch, computer]');
  });

  it('includes allow tools when set', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ tools: { allow: ['Read', 'Write', 'Edit'] } }));
    expect(md).toContain('allow: [Read, Write, Edit]');
  });

  it('omits tools block when tools is undefined', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ tools: undefined }));
    expect(md).not.toContain('tools:');
  });

  it('includes permissionMode when not "default"', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ permissionMode: 'plan' }));
    expect(md).toContain('permissionMode: plan');
  });

  it('omits permissionMode when "default"', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ permissionMode: 'default' }));
    expect(md).not.toContain('permissionMode:');
  });

  it('omits permissionMode when undefined', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ permissionMode: undefined }));
    expect(md).not.toContain('permissionMode:');
  });

  it('includes maxTurns when set', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ maxTurns: 20 }));
    expect(md).toContain('maxTurns: 20');
  });

  it('includes color field', () => {
    const md = buildClaudeCodeAgentMd(makeAgent({ color: 'red' }));
    expect(md).toContain('color: red');
  });

  it('body (after frontmatter) contains the systemPrompt', () => {
    const agent = makeAgent();
    const md = buildClaudeCodeAgentMd(agent);
    const bodyStart = md.indexOf('---\n\n') + 5;
    const body = md.slice(bodyStart);
    expect(body.trim()).toBe(agent.systemPrompt);
  });
});

describe('buildClaudeCodeAgentMd — project commands (W-BYO row 2)', () => {
  function pctool(overrides: Partial<ProjectCommandTool> = {}): ProjectCommandTool {
    return {
      id: 'pc1',
      name: 'Run tests',
      command: 'npm test',
      description: 'Runs the full suite.',
      createdAt: new Date(0).toISOString(),
      ...overrides,
    };
  }

  it('renders an attached tool when permissionMode qualifies (acceptEdits)', () => {
    const agent = makeAgent({ permissionMode: 'acceptEdits', projectCommandTools: ['pc1'] });
    const md = buildClaudeCodeAgentMd(agent, [pctool()]);
    expect(md).toContain('## Available project commands');
    expect(md).toContain('**Run tests**: `npm test` — Runs the full suite.');
  });

  it('renders an attached tool when permissionMode is full', () => {
    const agent = makeAgent({ permissionMode: 'full', projectCommandTools: ['pc1'] });
    const md = buildClaudeCodeAgentMd(agent, [pctool()]);
    expect(md).toContain('## Available project commands');
  });

  it('omits the section entirely when permissionMode does not qualify (plan)', () => {
    const agent = makeAgent({ permissionMode: 'plan', projectCommandTools: ['pc1'] });
    const md = buildClaudeCodeAgentMd(agent, [pctool()]);
    expect(md).not.toContain('## Available project commands');
  });

  it('omits the section when the agent references no project commands', () => {
    const agent = makeAgent({ permissionMode: 'acceptEdits', projectCommandTools: [] });
    const md = buildClaudeCodeAgentMd(agent, [pctool()]);
    expect(md).not.toContain('## Available project commands');
  });

  it('renders only the tools the agent actually references, not the whole catalog', () => {
    const agent = makeAgent({ permissionMode: 'full', projectCommandTools: ['pc1'] });
    const md = buildClaudeCodeAgentMd(agent, [pctool({ id: 'pc1' }), pctool({ id: 'pc2', name: 'Build' })]);
    expect(md).toContain('Run tests');
    expect(md).not.toContain('**Build**');
  });

  it('defaults to no project-command tools when the param is omitted', () => {
    const agent = makeAgent({ permissionMode: 'full', projectCommandTools: ['pc1'] });
    const md = buildClaudeCodeAgentMd(agent);
    expect(md).not.toContain('## Available project commands');
  });
});

describe('buildClaudeCodeAgentMd — declarative tools (W-PROVE row 3)', () => {
  function webTool(overrides: Partial<Extract<DeclarativeTool, { kind: 'web_read' }>> = {}): DeclarativeTool {
    return {
      kind: 'web_read',
      id: 'dt1',
      name: 'API status',
      description: 'Reads the public API status.',
      allowedHost: 'api.example.com',
      createdAt: new Date(0).toISOString(),
      ...overrides,
    };
  }

  function fileTool(overrides: Partial<Extract<DeclarativeTool, { kind: 'file_read' }>> = {}): DeclarativeTool {
    return {
      kind: 'file_read',
      id: 'dt2',
      name: 'Changelog',
      description: 'Reads the changelog.',
      path: 'CHANGELOG.md',
      createdAt: new Date(0).toISOString(),
      ...overrides,
    };
  }

  it('renders an attached web_read tool regardless of permissionMode (plan qualifies too — no code execution to gate)', () => {
    const agent = makeAgent({ permissionMode: 'plan', declarativeTools: ['dt1'] });
    const md = buildClaudeCodeAgentMd(agent, [], [webTool()]);
    expect(md).toContain('## Available declarative tools');
    expect(md).toContain('**API status**: GET https://api.example.com');
  });

  it('renders an attached file_read tool', () => {
    const agent = makeAgent({ permissionMode: 'plan', declarativeTools: ['dt2'] });
    const md = buildClaudeCodeAgentMd(agent, [], [fileTool()]);
    expect(md).toContain('**Changelog**: read `CHANGELOG.md`');
  });

  it('omits the section when the agent references no declarative tools', () => {
    const agent = makeAgent({ declarativeTools: [] });
    const md = buildClaudeCodeAgentMd(agent, [], [webTool(), fileTool()]);
    expect(md).not.toContain('## Available declarative tools');
  });

  it('renders only the tools the agent actually references, not the whole catalog', () => {
    const agent = makeAgent({ declarativeTools: ['dt1'] });
    const md = buildClaudeCodeAgentMd(agent, [], [webTool(), fileTool()]);
    expect(md).toContain('API status');
    expect(md).not.toContain('**Changelog**');
  });

  it('defaults to no declarative tools when the param is omitted', () => {
    const agent = makeAgent({ declarativeTools: ['dt1'] });
    const md = buildClaudeCodeAgentMd(agent, []);
    expect(md).not.toContain('## Available declarative tools');
  });

  it('both catalogs can render side by side', () => {
    const agent = makeAgent({ permissionMode: 'full', projectCommandTools: ['pc1'], declarativeTools: ['dt1'] });
    const md = buildClaudeCodeAgentMd(
      agent,
      [{ id: 'pc1', name: 'Run tests', command: 'npm test', description: 'Runs the full suite.', createdAt: new Date(0).toISOString() }],
      [webTool()],
    );
    expect(md).toContain('## Available project commands');
    expect(md).toContain('## Available declarative tools');
  });
});

describe('buildClaudeCodeAgentMd — transform tools (W-CODE)', () => {
  function transformTool(overrides: Partial<TransformTool> = {}): TransformTool {
    return {
      id: 'tt1',
      name: 'Double items',
      description: 'Doubles every number in input.items.',
      code: 'return input.items.map((x) => x * 2);',
      createdAt: new Date(0).toISOString(),
      ...overrides,
    };
  }

  it('renders an attached transform tool regardless of permissionMode — no permission mode to gate a pure computation', () => {
    const agent = makeAgent({ permissionMode: 'plan', transformTools: ['tt1'] });
    const md = buildClaudeCodeAgentMd(agent, [], [], [transformTool()]);
    expect(md).toContain('## Available transformation tools (managed missions only)');
    expect(md).toContain('**Double items** (id: `tt1`)');
  });

  it('omits the section when the agent references no transform tools', () => {
    const agent = makeAgent({ transformTools: [] });
    const md = buildClaudeCodeAgentMd(agent, [], [], [transformTool()]);
    expect(md).not.toContain('## Available transformation tools');
  });

  it('renders only the tools the agent actually references, not the whole catalog', () => {
    const agent = makeAgent({ transformTools: ['tt1'] });
    const md = buildClaudeCodeAgentMd(agent, [], [], [transformTool(), transformTool({ id: 'tt2', name: 'Other' })]);
    expect(md).toContain('Double items');
    expect(md).not.toContain('**Other**');
  });

  it('defaults to no transform tools when the param is omitted', () => {
    const agent = makeAgent({ transformTools: ['tt1'] });
    const md = buildClaudeCodeAgentMd(agent, [], []);
    expect(md).not.toContain('## Available transformation tools');
  });

  it('all three catalogs (project commands, declarative, transform) can render side by side', () => {
    const agent = makeAgent({
      permissionMode: 'full',
      projectCommandTools: ['pc1'],
      declarativeTools: ['dt1'],
      transformTools: ['tt1'],
    });
    const md = buildClaudeCodeAgentMd(
      agent,
      [{ id: 'pc1', name: 'Run tests', command: 'npm test', description: 'Runs the full suite.', createdAt: new Date(0).toISOString() }],
      [{ kind: 'web_read', id: 'dt1', name: 'API status', description: 'Reads status.', allowedHost: 'api.example.com', createdAt: new Date(0).toISOString() }],
      [transformTool()],
    );
    expect(md).toContain('## Available project commands');
    expect(md).toContain('## Available declarative tools');
    expect(md).toContain('## Available transformation tools (managed missions only)');
  });

  it('documents that native missions cannot call it in-process, unlike a managed mission', () => {
    const agent = makeAgent({ transformTools: ['tt1'] });
    const md = buildClaudeCodeAgentMd(agent, [], [], [transformTool()]);
    expect(md).toMatch(/no equivalent primitive to run them in-process/);
  });
});

describe('compileToClaudeCodeWeb', () => {
  it('returns agentMdPath at expected location', () => {
    const agent = makeAgent();
    const result = compileToClaudeCodeWeb(agent, '/workspace');
    expect(result.agentMdPath).toBe('/workspace/.claude/agents/security-reviewer.md');
  });

  it('stores content in web mock map', () => {
    const agent = makeAgent();
    const result = compileToClaudeCodeWeb(agent, '/workspace');
    const stored = getWebMockFile(result.agentMdPath);
    expect(stored).toBe(result.content);
  });

  it('returns skillMdPath when brainScope is set', () => {
    const agent = makeAgent({ brainScope: 'project' });
    const result = compileToClaudeCodeWeb(agent, '/workspace');
    expect(result.skillMdPath).toBe('/workspace/.claude/skills/security-reviewer/SKILL.md');
  });

  it('returns skillMdPath when skills array is non-empty', () => {
    const agent = makeAgent({ skills: ['some-skill'] });
    const result = compileToClaudeCodeWeb(agent, '/workspace');
    expect(result.skillMdPath).toBeDefined();
  });

  it('does not produce skillMdPath without brainScope or skills', () => {
    const agent = makeAgent({ brainScope: undefined, skills: undefined });
    const result = compileToClaudeCodeWeb(agent, '/workspace');
    expect(result.skillMdPath).toBeUndefined();
  });

  it('template security-reviewer compiles correctly', () => {
    const tmpl = createAgentTemplate('security-reviewer');
    const agent = createNewAgent({ ...tmpl, scope: 'project' });
    const result = compileToClaudeCodeWeb(agent, '/repo');
    expect(result.content).toContain('name: security-reviewer');
    expect(result.content).toContain('permissionMode: plan');
    expect(result.content).toContain('color: red');
  });
});
