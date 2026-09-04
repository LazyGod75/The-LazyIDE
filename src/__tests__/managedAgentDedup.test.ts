/**
 * Tests for managedAgentDedup — the V5 identical-call dedup helpers used by
 * managedAgent.ts's main loop. See managedAgent.test.ts's "V5 identical-call
 * dedup" describe block for the integration-level coverage through
 * planAndActManaged; these are focused unit tests for the pure helpers
 * themselves.
 */

import { describe, it, expect } from 'vitest';
import {
  DEDUPE_ELIGIBLE_TOOLS,
  canonicalizeToolArgs,
  dedupKeyFor,
  dedupNudgeObservation,
} from '../lib/agents/managedAgentDedup';

describe('canonicalizeToolArgs', () => {
  it('produces the same string regardless of key order', () => {
    const a = canonicalizeToolArgs({ path: 'src/index.ts', start_line: 1, end_line: 50 });
    const b = canonicalizeToolArgs({ end_line: 50, path: 'src/index.ts', start_line: 1 });
    expect(a).toBe(b);
  });

  it('produces different strings for different values', () => {
    const a = canonicalizeToolArgs({ path: 'a.ts' });
    const b = canonicalizeToolArgs({ path: 'b.ts' });
    expect(a).not.toBe(b);
  });

  it('preserves array element order (order is meaningful there)', () => {
    const a = canonicalizeToolArgs({ edits: [{ old_string: 'x' }, { old_string: 'y' }] });
    const b = canonicalizeToolArgs({ edits: [{ old_string: 'y' }, { old_string: 'x' }] });
    expect(a).not.toBe(b);
  });

  it('sorts keys recursively in nested objects', () => {
    const a = canonicalizeToolArgs({ outer: { b: 1, a: 2 } });
    const b = canonicalizeToolArgs({ outer: { a: 2, b: 1 } });
    expect(a).toBe(b);
  });
});

describe('dedupKeyFor', () => {
  it('returns a key for a dedup-eligible tool (read_file)', () => {
    expect(dedupKeyFor('read_file', { path: 'x.ts' })).toBe('read_file:{"path":"x.ts"}');
  });

  it('returns a key for each tool explicitly named in the assignment (read_dir, find_file, search_code)', () => {
    expect(dedupKeyFor('read_dir', { path: '.' })).not.toBeNull();
    expect(dedupKeyFor('find_file', { pattern: '*.ts' })).not.toBeNull();
    expect(dedupKeyFor('search_code', { pattern: 'foo' })).not.toBeNull();
  });

  it('returns null for exempt (side-effectful/state-reading) tools', () => {
    expect(dedupKeyFor('run_command', { command: 'npm test' })).toBeNull();
    expect(dedupKeyFor('run_tests', {})).toBeNull();
    expect(dedupKeyFor('run_build', {})).toBeNull();
    expect(dedupKeyFor('git_status', {})).toBeNull();
    expect(dedupKeyFor('git_diff', { path: '' })).toBeNull();
  });

  it('returns null for write/mutating tools', () => {
    expect(dedupKeyFor('write_file', { path: 'x.ts', content: 'a' })).toBeNull();
    expect(dedupKeyFor('edit_file', { path: 'x.ts', old_string: 'a', new_string: 'b' })).toBeNull();
  });

  it('DEDUPE_ELIGIBLE_TOOLS matches dedupKeyFor exactly', () => {
    for (const tool of DEDUPE_ELIGIBLE_TOOLS) {
      expect(dedupKeyFor(tool, {})).not.toBeNull();
    }
    expect(dedupKeyFor('not_a_real_tool', {})).toBeNull();
  });
});

describe('dedupNudgeObservation', () => {
  it('references the step the call first ran at and instructs the model not to repeat', () => {
    const msg = dedupNudgeObservation(3);
    expect(msg).toContain('step 3');
    expect(msg.toLowerCase()).toContain('do not repeat');
  });
});
