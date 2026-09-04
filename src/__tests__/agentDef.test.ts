import { describe, it, expect } from 'vitest';
import {
  validateAgent,
  createAgentTemplate,
  createNewAgent,
  AGENT_COLOR_MAP,
} from '../lib/agents/agentDef';
import type { LazyAgent } from '../lib/agents/agentDef';

// Minimal valid agent
const validAgent: Partial<LazyAgent> = {
  name: 'my-agent',
  displayName: 'My Agent',
  systemPrompt: 'You are a helpful assistant that performs tasks autonomously and efficiently.',
  modelTier: 'sonnet',
  description:
    'Use this agent when you need to automate coding tasks, refactor code, write tests, or review pull requests for correctness and quality.',
};

describe('validateAgent', () => {
  it('returns valid=true for a well-formed agent', () => {
    const result = validateAgent(validAgent);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('error when name is missing', () => {
    const result = validateAgent({ ...validAgent, name: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('name is required'))).toBe(true);
  });

  it('error when name is not kebab-case', () => {
    const result = validateAgent({ ...validAgent, name: 'My Agent' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('kebab-case'))).toBe(true);
  });

  it('error when displayName is missing', () => {
    const result = validateAgent({ ...validAgent, displayName: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('displayName is required'))).toBe(true);
  });

  it('error when systemPrompt is missing', () => {
    const result = validateAgent({ ...validAgent, systemPrompt: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('systemPrompt is required'))).toBe(true);
  });

  it('error when modelTier is missing', () => {
    const { modelTier: _omit, ...rest } = validAgent;
    const result = validateAgent(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('modelTier is required'))).toBe(true);
  });

  it('warning when description has fewer than 20 words', () => {
    const result = validateAgent({ ...validAgent, description: 'Short description only.' });
    expect(result.warnings.some(w => w.includes('description has'))).toBe(true);
  });

  it('no warning when description has 20+ words', () => {
    // validAgent.description has 20+ words
    const result = validateAgent(validAgent);
    expect(result.warnings.filter(w => w.includes('description has'))).toHaveLength(0);
  });

  it('name with numbers and hyphens is valid', () => {
    const result = validateAgent({ ...validAgent, name: 'agent-42-test' });
    expect(result.valid).toBe(true);
  });

  it('name with uppercase letters is invalid', () => {
    const result = validateAgent({ ...validAgent, name: 'MyAgent' });
    expect(result.valid).toBe(false);
  });
});

describe('createAgentTemplate', () => {
  it('security-reviewer template has correct name and color', () => {
    const tmpl = createAgentTemplate('security-reviewer');
    expect(tmpl.name).toBe('security-reviewer');
    expect(tmpl.color).toBe('red');
    expect(tmpl.permissionMode).toBe('plan');
  });

  it('security-reviewer template denies WebSearch', () => {
    const tmpl = createAgentTemplate('security-reviewer');
    expect(tmpl.tools?.deny).toContain('WebSearch');
  });

  it('test-writer template has correct name and color', () => {
    const tmpl = createAgentTemplate('test-writer');
    expect(tmpl.name).toBe('test-writer');
    expect(tmpl.color).toBe('green');
    expect(tmpl.effort).toBe('high');
  });

  it('refactor template has correct name and uses violet', () => {
    const tmpl = createAgentTemplate('refactor');
    expect(tmpl.name).toBe('refactor-cleaner');
    expect(tmpl.color).toBe('violet');
  });

  it('all templates have manual:true trigger', () => {
    const keys = ['security-reviewer', 'test-writer', 'refactor'] as const;
    for (const key of keys) {
      const tmpl = createAgentTemplate(key);
      expect(tmpl.triggers.manual).toBe(true);
    }
  });

  it('all templates have a modelTier set', () => {
    const keys = ['security-reviewer', 'test-writer', 'refactor'] as const;
    for (const key of keys) {
      const tmpl = createAgentTemplate(key);
      expect(tmpl.modelTier).toBeTruthy();
    }
  });
});

describe('createNewAgent', () => {
  it('generates a unique id each time', () => {
    const a1 = createNewAgent();
    const a2 = createNewAgent();
    expect(a1.id).not.toBe(a2.id);
  });

  it('defaults color to violet', () => {
    const agent = createNewAgent();
    expect(agent.color).toBe('violet');
  });

  it('defaults modelTier to sonnet', () => {
    const agent = createNewAgent();
    expect(agent.modelTier).toBe('sonnet');
  });

  it('defaults scope to project', () => {
    const agent = createNewAgent();
    expect(agent.scope).toBe('project');
  });

  it('defaults triggers.manual to true', () => {
    const agent = createNewAgent();
    expect(agent.triggers.manual).toBe(true);
  });

  it('partial overrides are applied', () => {
    const agent = createNewAgent({ name: 'my-agent', color: 'cyan' });
    expect(agent.name).toBe('my-agent');
    expect(agent.color).toBe('cyan');
  });

  it('createdAt is a valid ISO date string', () => {
    const agent = createNewAgent();
    expect(() => new Date(agent.createdAt)).not.toThrow();
    expect(new Date(agent.createdAt).getTime()).toBeGreaterThan(0);
  });
});

describe('AGENT_COLOR_MAP', () => {
  it('all colors map to a hex string', () => {
    for (const [_color, hex] of Object.entries(AGENT_COLOR_MAP)) {
      expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
