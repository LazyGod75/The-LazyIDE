/**
 * Tests for the persona + tool-policy module (extracted from managedAgent.ts
 * to keep that file under the project's 800-line ceiling — see
 * managedAgent.ts's header comment):
 *   - checkToolPolicy()            permission/tool-policy enforcement
 *   - buildPolicyBlock()           system-prompt restriction banner
 *   - buildEffectiveSystemPrompt() persona + ReAct protocol composition
 *   - resolveAgentPersona()        agentName/agentSystemPrompt resolution
 *
 * These were previously exercised only indirectly (via managedAgent.test.ts's
 * planAndActManaged suite for resolveAgentPersona, or directly-but-from-
 * managedAgent.ts for the other three). Moved here verbatim (imports
 * re-pointed at managedAgentPolicy.ts) plus new direct resolveAgentPersona
 * coverage, since it is now a standalone exported function of its own module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock agentsStorage's listAgents (used by resolveAgentPersona) ─────────
vi.mock('../lib/agents/agentsStorage', () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}));

import {
  checkToolPolicy,
  buildPolicyBlock,
  buildEffectiveSystemPrompt,
  resolveAgentPersona,
  AGENT_SYSTEM_PROMPT,
  ANTI_FABRICATION_INSTRUCTION,
} from '../lib/agents/managedAgentPolicy';
import { listAgents } from '../lib/agents/agentsStorage';
import { RECALL_TEACHING } from '../lib/models/systemPrompts';

const mockedListAgents = listAgents as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedListAgents.mockResolvedValue([]);
});

/** Builds a listAgents()-shaped stored-agent record for resolveAgentPersona tests. */
function makeStoredAgent(overrides: { name: string; displayName: string; systemPrompt: string }) {
  return {
    scope: 'project' as const,
    agent: {
      id: 'agent-1',
      name: overrides.name,
      displayName: overrides.displayName,
      description: 'Test agent',
      color: 'green',
      tags: [],
      systemPrompt: overrides.systemPrompt,
      modelTier: 'sonnet',
      triggers: { manual: true },
      scope: 'project' as const,
      createdAt: new Date().toISOString(),
    },
  };
}

// ── checkToolPolicy ───────────────────────────────────────────────

describe('checkToolPolicy', () => {
  it('allows any tool when no policy is set', () => {
    expect(checkToolPolicy('write_file', {})).toBeNull();
    expect(checkToolPolicy('run_command', {})).toBeNull();
  });

  it('always allows FINAL, regardless of policy', () => {
    expect(checkToolPolicy('FINAL', { permissionMode: 'plan', deniedTools: ['FINAL'] })).toBeNull();
  });

  it.each(['write_file', 'edit_file', 'run_command', 'run_tests', 'brain_record'])(
    'plan mode blocks %s with a read-only error',
    (tool) => {
      const result = checkToolPolicy(tool, { permissionMode: 'plan' });
      expect(result).not.toBeNull();
      expect(result).toContain('ERROR');
      expect(result!.toLowerCase()).toContain('read-only');
      expect(result!.toLowerCase()).toContain('plan mode');
    },
  );

  it.each(['read_file', 'read_dir', 'glob', 'grep_file', 'brain_query'])(
    'plan mode allows read-only tool %s',
    (tool) => {
      expect(checkToolPolicy(tool, { permissionMode: 'plan' })).toBeNull();
    },
  );

  it('does not block write tools outside plan mode', () => {
    expect(checkToolPolicy('write_file', { permissionMode: 'acceptEdits' })).toBeNull();
    expect(checkToolPolicy('write_file', { permissionMode: 'full' })).toBeNull();
    expect(checkToolPolicy('write_file', {})).toBeNull();
  });

  it('blocks a tool present in deniedTools', () => {
    const result = checkToolPolicy('run_command', { deniedTools: ['run_command'] });
    expect(result).not.toBeNull();
    expect(result).toContain('ERROR');
    expect(result!.toLowerCase()).toContain('denied');
  });

  it('deniedTools applies even outside plan mode', () => {
    const result = checkToolPolicy('read_file', { permissionMode: 'full', deniedTools: ['read_file'] });
    expect(result).not.toBeNull();
  });

  it('does not block tools absent from deniedTools', () => {
    expect(checkToolPolicy('read_file', { deniedTools: ['run_command'] })).toBeNull();
  });

  it('when allowedTools is non-empty, blocks tools not in the list', () => {
    const result = checkToolPolicy('write_file', { allowedTools: ['read_file', 'grep_file'] });
    expect(result).not.toBeNull();
    expect(result).toContain('ERROR');
    expect(result!.toLowerCase()).toContain('allowed');
  });

  it('when allowedTools is non-empty, permits tools in the list', () => {
    expect(checkToolPolicy('read_file', { allowedTools: ['read_file', 'grep_file'] })).toBeNull();
  });

  it('an empty allowedTools array does not restrict anything', () => {
    expect(checkToolPolicy('write_file', { allowedTools: [] })).toBeNull();
  });

  it('stacks checks: deniedTools blocks even when also in allowedTools', () => {
    const result = checkToolPolicy('write_file', {
      allowedTools: ['write_file', 'read_file'],
      deniedTools: ['write_file'],
    });
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('denied');
  });
});

// ── buildPolicyBlock ──────────────────────────────────────────────

describe('buildPolicyBlock', () => {
  it('returns an empty string when no policy is active', () => {
    expect(buildPolicyBlock({})).toBe('');
  });

  it('mentions plan mode and the blocked tools when permissionMode is plan', () => {
    const block = buildPolicyBlock({ permissionMode: 'plan' });
    expect(block).toContain('PLAN MODE');
    expect(block).toContain('write_file');
    expect(block).toContain('run_command');
  });

  it('lists deniedTools', () => {
    const block = buildPolicyBlock({ deniedTools: ['run_command', 'brain_record'] });
    expect(block).toContain('DENIED TOOLS');
    expect(block).toContain('run_command');
    expect(block).toContain('brain_record');
  });

  it('lists allowedTools', () => {
    const block = buildPolicyBlock({ allowedTools: ['read_file', 'glob'] });
    expect(block).toContain('ALLOWED TOOLS ONLY');
    expect(block).toContain('read_file');
    expect(block).toContain('glob');
  });

  it('combines multiple active restrictions', () => {
    const block = buildPolicyBlock({ permissionMode: 'plan', deniedTools: ['brain_record'] });
    expect(block).toContain('PLAN MODE');
    expect(block).toContain('DENIED TOOLS');
  });
});

// ── buildEffectiveSystemPrompt ─────────────────────────────────────

describe('buildEffectiveSystemPrompt', () => {
  it('falls back to the generic protocol when persona is null', () => {
    const prompt = buildEffectiveSystemPrompt(null);
    expect(prompt).toContain('THOUGHT:');
    expect(prompt).toContain('ACTION:');
    expect(prompt).toContain('ARGS:');
  });

  it('falls back to the generic protocol when persona has an empty systemPrompt', () => {
    const prompt = buildEffectiveSystemPrompt({ displayName: 'Empty Agent', systemPrompt: '   ' });
    expect(prompt).toContain('THOUGHT:');
    expect(prompt).not.toContain('Empty Agent');
  });

  it('includes the persona displayName and systemPrompt when provided', () => {
    const prompt = buildEffectiveSystemPrompt({
      displayName: 'Security Reviewer',
      systemPrompt: 'You are a senior security engineer. Review for vulnerabilities.',
    });
    expect(prompt).toContain('Security Reviewer');
    expect(prompt).toContain('You are a senior security engineer. Review for vulnerabilities.');
  });

  it('still includes the mandatory ReAct protocol alongside the persona', () => {
    const prompt = buildEffectiveSystemPrompt({
      displayName: 'Test Writer',
      systemPrompt: 'You write tests following TDD.',
    });
    expect(prompt).toContain('THOUGHT:');
    expect(prompt).toContain('ACTION:');
    expect(prompt).toContain('ARGS:');
    // Persona text appears before the protocol restatement
    expect(prompt.indexOf('Test Writer')).toBeLessThan(prompt.indexOf('THOUGHT:'));
  });
});

// ── resolveAgentPersona ────────────────────────────────────────────
// Newly-direct coverage: previously a module-private helper in
// managedAgent.ts, exercised only indirectly via planAndActManaged's
// "persona" describe block (managedAgent.test.ts). Now a standalone
// exported function of managedAgentPolicy.ts.

describe('resolveAgentPersona', () => {
  it('uses agentSystemPrompt directly when provided, without calling listAgents()', async () => {
    const persona = await resolveAgentPersona({
      agentName: 'ignored-name',
      agentDisplayName: 'Security Reviewer',
      agentSystemPrompt: 'You are a senior security engineer.',
    });
    expect(persona).toEqual({
      displayName: 'Security Reviewer',
      systemPrompt: 'You are a senior security engineer.',
    });
    expect(mockedListAgents).not.toHaveBeenCalled();
  });

  it('falls back to agentName, then "Custom Agent", for displayName when agentDisplayName is absent', async () => {
    const withAgentName = await resolveAgentPersona({
      agentName: 'sec-reviewer',
      agentSystemPrompt: 'Be thorough.',
    });
    expect(withAgentName?.displayName).toBe('sec-reviewer');

    const withNeither = await resolveAgentPersona({ agentSystemPrompt: 'Be thorough.' });
    expect(withNeither?.displayName).toBe('Custom Agent');
  });

  it('returns null and skips listAgents() when neither agentName nor agentSystemPrompt is given', async () => {
    const persona = await resolveAgentPersona({});
    expect(persona).toBeNull();
    expect(mockedListAgents).not.toHaveBeenCalled();
  });

  it('resolves via listAgents() by name when agentSystemPrompt is not provided directly', async () => {
    mockedListAgents.mockResolvedValueOnce([
      makeStoredAgent({
        name: 'test-writer',
        displayName: 'Test Writer',
        systemPrompt: 'You are a TDD expert. Write tests first.',
      }),
    ]);

    const persona = await resolveAgentPersona({ agentName: 'test-writer' });
    expect(mockedListAgents).toHaveBeenCalled();
    expect(persona).toEqual({
      displayName: 'Test Writer',
      systemPrompt: 'You are a TDD expert. Write tests first.',
    });
  });

  it('resolves via listAgents() by displayName too', async () => {
    mockedListAgents.mockResolvedValueOnce([
      makeStoredAgent({
        name: 'internal-slug',
        displayName: 'Docs Writer',
        systemPrompt: 'Write clear docs.',
      }),
    ]);

    const persona = await resolveAgentPersona({ agentName: 'Docs Writer' });
    expect(persona?.displayName).toBe('Docs Writer');
  });

  it('returns null when agentName does not match any stored agent', async () => {
    mockedListAgents.mockResolvedValueOnce([]);
    const persona = await resolveAgentPersona({ agentName: 'unknown-agent' });
    expect(persona).toBeNull();
  });

  it('returns null when the matched agent has an empty/whitespace-only systemPrompt', async () => {
    mockedListAgents.mockResolvedValueOnce([
      makeStoredAgent({ name: 'blank-agent', displayName: 'Blank Agent', systemPrompt: '   ' }),
    ]);
    const persona = await resolveAgentPersona({ agentName: 'blank-agent' });
    expect(persona).toBeNull();
  });

  it('returns null when listAgents() throws (storage failure never propagates)', async () => {
    mockedListAgents.mockRejectedValueOnce(new Error('storage unavailable'));
    const persona = await resolveAgentPersona({ agentName: 'any-agent' });
    expect(persona).toBeNull();
  });
});

// ── RECALL_TEACHING wiring ──────────────────────────────────────────
// The managed (Pro tier) ReAct loop already had a bare-bones brain_query
// mention ("Use brain_query BEFORE attempting a task you're unsure about")
// but none of the WHEN/topic-extraction/result-interpretation teaching from
// the original LazyBrain recall recipe. RECALL_TEACHING is appended verbatim
// to AGENT_SYSTEM_PROMPT so it reaches the model regardless of persona (see
// buildEffectiveSystemPrompt, which restates AGENT_SYSTEM_PROMPT in full
// after any persona text).

describe('AGENT_SYSTEM_PROMPT — RECALL_TEACHING', () => {
  it('includes RECALL_TEACHING verbatim', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain(RECALL_TEACHING);
  });

  it('still keeps the mandatory ReAct protocol and the brain_query/brain_record tool signatures', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain('THOUGHT:');
    expect(AGENT_SYSTEM_PROMPT).toContain('ACTION:');
    expect(AGENT_SYSTEM_PROMPT).toContain('brain_query');
    expect(AGENT_SYSTEM_PROMPT).toContain('brain_record');
  });
});

describe('buildEffectiveSystemPrompt — RECALL_TEACHING reaches both branches', () => {
  it('includes RECALL_TEACHING when no persona is resolved (generic fallback)', () => {
    const prompt = buildEffectiveSystemPrompt(null);
    expect(prompt).toContain(RECALL_TEACHING);
  });

  it('includes RECALL_TEACHING alongside a resolved persona (not just the fallback path)', () => {
    const prompt = buildEffectiveSystemPrompt({
      displayName: 'Security Reviewer',
      systemPrompt: 'You are a senior security engineer. Review for vulnerabilities.',
    });
    expect(prompt).toContain(RECALL_TEACHING);
    expect(prompt).toContain('Security Reviewer');
  });
});

// ── ANTI_FABRICATION_INSTRUCTION (2026-08 fabricated-price incident) ───────
// Real repro: a mission asked to replace a "Coming soon" price placeholder
// with wording that merely "indicates availability" (no price given
// anywhere) had its implementer invent "$29/month" across every locale file
// — a sibling mission invented a DIFFERENT price for the same product. The
// mission agent's own system prompt never told it what to do when a
// required fact was simply absent, so it guessed instead of saying so. This
// asserts the concrete anti-fabrication instruction (with its example) is
// actually present in the prompt sent to every managed mission, regardless
// of persona.

describe('AGENT_SYSTEM_PROMPT — ANTI_FABRICATION_INSTRUCTION', () => {
  it('includes ANTI_FABRICATION_INSTRUCTION verbatim', () => {
    expect(AGENT_SYSTEM_PROMPT).toContain(ANTI_FABRICATION_INSTRUCTION);
  });

  it('is concrete, not vague: names the kinds of facts and gives the price-fabrication example', () => {
    expect(ANTI_FABRICATION_INSTRUCTION).toMatch(/price/i);
    expect(ANTI_FABRICATION_INSTRUCTION).toContain('$29/month');
    expect(ANTI_FABRICATION_INSTRUCTION.toLowerCase()).toContain('coming soon');
  });

  it('tells the agent what to do instead of inventing a value: placeholder or stop and report', () => {
    expect(ANTI_FABRICATION_INSTRUCTION.toLowerCase()).toContain('todo');
    expect(ANTI_FABRICATION_INSTRUCTION.toLowerCase()).toMatch(/stop that step|could not find/);
  });
});

describe('buildEffectiveSystemPrompt — ANTI_FABRICATION_INSTRUCTION reaches both branches', () => {
  it('includes it when no persona is resolved (generic fallback)', () => {
    const prompt = buildEffectiveSystemPrompt(null);
    expect(prompt).toContain(ANTI_FABRICATION_INSTRUCTION);
  });

  it('includes it alongside a resolved persona (not just the fallback path)', () => {
    const prompt = buildEffectiveSystemPrompt({
      displayName: 'Pricing Copy Agent',
      systemPrompt: 'You update marketing copy across locales.',
    });
    expect(prompt).toContain(ANTI_FABRICATION_INSTRUCTION);
    expect(prompt).toContain('Pricing Copy Agent');
  });
});
