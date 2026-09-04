/* toolProfiles.test.ts — tests for per-surface tool permission profiles.

   Verifies that each surface (assistant, manager, agent) gets the correct
   set of allowed/denied tools, and that isToolAllowed enforces the boundary.
*/

import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_PROFILE,
  MANAGER_PROFILE,
  AGENT_PROFILE,
  getToolProfile,
  isToolAllowed,
  getToolsForSurface,
  buildSurfaceToolSignatures,
  buildSurfaceActionList,
} from '../lib/tools/toolProfiles';
import type { SurfaceName } from '../lib/tools/toolProfiles';

describe('toolProfiles — profile definitions', () => {
  it('ASSISTANT_PROFILE allows read-only + web + brain + git-read + orchestration', () => {
    expect(ASSISTANT_PROFILE.surface).toBe('assistant');
    expect(ASSISTANT_PROFILE.allowedTools).toContain('read_file');
    expect(ASSISTANT_PROFILE.allowedTools).toContain('web_search');
    expect(ASSISTANT_PROFILE.allowedTools).toContain('web_fetch');
    expect(ASSISTANT_PROFILE.allowedTools).toContain('brain_query');
    expect(ASSISTANT_PROFILE.allowedTools).toContain('git_status');
    expect(ASSISTANT_PROFILE.allowedTools).toContain('ask_user');
  });

  it('ASSISTANT_PROFILE denies destructive edits, exec, and git commits', () => {
    expect(ASSISTANT_PROFILE.deniedTools).toContain('write_file');
    expect(ASSISTANT_PROFILE.deniedTools).toContain('edit_file');
    expect(ASSISTANT_PROFILE.deniedTools).toContain('delete_file');
    expect(ASSISTANT_PROFILE.deniedTools).toContain('run_command');
    expect(ASSISTANT_PROFILE.deniedTools).toContain('run_tests');
    expect(ASSISTANT_PROFILE.deniedTools).toContain('git_commit');
  });

  it('MANAGER_PROFILE allows read + web + brain + delegate, denies edits + exec', () => {
    expect(MANAGER_PROFILE.surface).toBe('manager');
    expect(MANAGER_PROFILE.allowedTools).toContain('read_file');
    expect(MANAGER_PROFILE.allowedTools).toContain('web_search');
    expect(MANAGER_PROFILE.allowedTools).toContain('brain_query');
    expect(MANAGER_PROFILE.allowedTools).toContain('delegate');
    expect(MANAGER_PROFILE.deniedTools).toContain('write_file');
    expect(MANAGER_PROFILE.deniedTools).toContain('run_command');
    expect(MANAGER_PROFILE.deniedTools).toContain('git_commit');
  });

  it('AGENT_PROFILE allows all tools and denies none', () => {
    expect(AGENT_PROFILE.surface).toBe('agent');
    expect(AGENT_PROFILE.deniedTools).toHaveLength(0);
    // Should have every tool in allowedTools
    expect(AGENT_PROFILE.allowedTools).toContain('write_file');
    expect(AGENT_PROFILE.allowedTools).toContain('run_command');
    expect(AGENT_PROFILE.allowedTools).toContain('git_commit');
    expect(AGENT_PROFILE.allowedTools).toContain('web_search');
    expect(AGENT_PROFILE.allowedTools).toContain('brain_query');
  });
});

describe('toolProfiles — isToolAllowed', () => {
  it('allows read_file for all surfaces', () => {
    expect(isToolAllowed('read_file', 'assistant')).toBe(true);
    expect(isToolAllowed('read_file', 'manager')).toBe(true);
    expect(isToolAllowed('read_file', 'agent')).toBe(true);
  });

  it('allows web_search for all surfaces', () => {
    expect(isToolAllowed('web_search', 'assistant')).toBe(true);
    expect(isToolAllowed('web_search', 'manager')).toBe(true);
    expect(isToolAllowed('web_search', 'agent')).toBe(true);
  });

  it('denies write_file for assistant and manager, allows for agent', () => {
    expect(isToolAllowed('write_file', 'assistant')).toBe(false);
    expect(isToolAllowed('write_file', 'manager')).toBe(false);
    expect(isToolAllowed('write_file', 'agent')).toBe(true);
  });

  it('denies run_command for assistant and manager, allows for agent', () => {
    expect(isToolAllowed('run_command', 'assistant')).toBe(false);
    expect(isToolAllowed('run_command', 'manager')).toBe(false);
    expect(isToolAllowed('run_command', 'agent')).toBe(true);
  });

  it('denies git_commit for assistant and manager, allows for agent', () => {
    expect(isToolAllowed('git_commit', 'assistant')).toBe(false);
    expect(isToolAllowed('git_commit', 'manager')).toBe(false);
    expect(isToolAllowed('git_commit', 'agent')).toBe(true);
  });
});

describe('toolProfiles — getToolProfile', () => {
  it('returns the correct profile for each surface', () => {
    expect(getToolProfile('assistant')).toBe(ASSISTANT_PROFILE);
    expect(getToolProfile('manager')).toBe(MANAGER_PROFILE);
    expect(getToolProfile('agent')).toBe(AGENT_PROFILE);
  });

  it('throws for unknown surface', () => {
    expect(() => getToolProfile('unknown' as SurfaceName)).toThrow();
  });
});

describe('toolProfiles — getToolsForSurface', () => {
  it('returns only allowed tools for assistant', () => {
    const tools = getToolsForSurface('assistant');
    const names = tools.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('web_search');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_command');
  });

  it('returns all tools for agent', () => {
    const tools = getToolsForSurface('agent');
    const names = tools.map(t => t.name);
    expect(names).toContain('write_file');
    expect(names).toContain('run_command');
    expect(names).toContain('git_commit');
  });
});

describe('toolProfiles — buildSurfaceToolSignatures', () => {
  it('builds tool signatures for assistant without destructive tools', () => {
    const sigs = buildSurfaceToolSignatures('assistant');
    expect(sigs).toContain('- read_file:');
    expect(sigs).toContain('- web_search:');
    expect(sigs).not.toContain('- write_file:');
    expect(sigs).not.toContain('- run_command:');
  });
});

describe('toolProfiles — buildSurfaceActionList', () => {
  it('includes FINAL in the action list', () => {
    const list = buildSurfaceActionList('assistant');
    expect(list).toContain('FINAL');
  });

  it('includes read_file but not write_file for assistant', () => {
    const list = buildSurfaceActionList('assistant');
    expect(list).toContain('read_file');
    expect(list).not.toContain('write_file');
  });

  it('includes all tools for agent', () => {
    const list = buildSurfaceActionList('agent');
    expect(list).toContain('write_file');
    expect(list).toContain('run_command');
  });
});
