/**
 * Unit tests for the LazyManager-level agent loop (src/cli/lib/agentLoop.ts).
 *
 * The LLM is injected as a mock — no network, no API key, no cost.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeTool,
  extractJsonObject,
  resolveSafe,
  runAgentLoop,
} from '../cli/lib/agentLoop.js';

const dirs: string[] = [];

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lazy-agentloop-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scripted LLM: returns the given replies in order. */
function scriptedLlm(replies: Array<{ content: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }>) {
  let i = 0;
  return async (): Promise<{ content: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }> => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply;
  };
}

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"tool":"read_dir","args":{"path":"."}}')).toEqual({
      tool: 'read_dir',
      args: { path: '.' },
    });
  });

  it('parses JSON inside a markdown fence', () => {
    expect(extractJsonObject('```json\n{"finish":"done"}\n```')).toEqual({ finish: 'done' });
  });

  it('returns null on garbage', () => {
    expect(extractJsonObject('hello world')).toBeNull();
  });
});

describe('resolveSafe', () => {
  it('allows paths inside the workdir', () => {
    const wd = makeWorkdir();
    expect(resolveSafe(wd, 'a/b.ts').startsWith(wd)).toBe(true);
  });

  it('refuses paths that escape the workdir', () => {
    const wd = makeWorkdir();
    expect(() => resolveSafe(wd, '../evil.txt')).toThrow(/escapes workdir/);
  });
});

describe('executeTool', () => {
  const ctx = { bashTimeoutMs: 5000, readCapBytes: 512 };

  it('write_file creates parent dirs and content', async () => {
    const wd = makeWorkdir();
    const obs = await executeTool(wd, 'write_file', { path: 'src/util.ts', content: 'export const x = 1;' }, ctx);
    expect(obs).toContain('Wrote');
    expect(readFileSync(join(wd, 'src/util.ts'), 'utf8')).toBe('export const x = 1;');
  });

  it('edit_file replaces one exact occurrence', async () => {
    const wd = makeWorkdir();
    writeFileSync(join(wd, 'a.py'), 'def clamp(v):\n    return v\n', 'utf8');
    const obs = await executeTool(
      wd,
      'edit_file',
      { path: 'a.py', old_text: 'return v', new_text: 'return max(0, min(v, 100))' },
      ctx,
    );
    expect(obs).toContain('1 replacement');
    expect(readFileSync(join(wd, 'a.py'), 'utf8')).toContain('max(0, min(v, 100))');
  });

  it('edit_file refuses ambiguous old_text', async () => {
    const wd = makeWorkdir();
    writeFileSync(join(wd, 'a.txt'), 'duplicate\nduplicate\n', 'utf8');
    const obs = await executeTool(wd, 'edit_file', { path: 'a.txt', old_text: 'duplicate', new_text: 'x' }, ctx);
    expect(obs).toContain('occurs 2 times');
  });

  it('find_file and search_code work across languages', async () => {
    const wd = makeWorkdir();
    mkdirSync(join(wd, 'lib'), { recursive: true });
    writeFileSync(join(wd, 'lib/clamp.py'), 'def clamp(v):\n    pass\n', 'utf8');
    writeFileSync(join(wd, 'lib/util.rs'), 'fn clamp() {}\n', 'utf8');
    const found = await executeTool(wd, 'find_file', { pattern: '**/*.py' }, ctx);
    expect(found).toContain('lib/clamp.py');
    const searched = await executeTool(wd, 'search_code', { pattern: 'clamp' }, ctx);
    expect(searched).toContain('clamp.py');
    expect(searched).toContain('util.rs');
  });

  it('read_file truncates beyond the cap', async () => {
    const wd = makeWorkdir();
    writeFileSync(join(wd, 'big.ts'), 'x'.repeat(1000), 'utf8');
    const obs = await executeTool(wd, 'read_file', { path: 'big.ts' }, ctx);
    expect(obs).toContain('[truncated');
  });
});

describe('runAgentLoop', () => {
  it('runs tools and finishes via JSON-in-prose fallback (ok=true)', async () => {
    const wd = makeWorkdir();
    const llm = scriptedLlm([
      { content: JSON.stringify({ tool: 'write_file', args: { path: 'answer.txt', content: '42' } }) },
      { content: JSON.stringify({ finish: 'wrote the answer' }) },
    ]);
    const events: string[] = [];
    const result = await runAgentLoop({
      workdir: wd,
      task: 'Write answer.txt containing 42, then finish.',
      llm,
      maxSteps: 10,
      onEvent: (e) => events.push(e.type),
    });
    expect(result.ok).toBe(true);
    expect(result.stoppedBy).toBe('finish');
    expect(result.summary).toBe('wrote the answer');
    expect(result.toolCalls).toBe(1);
    expect(readFileSync(join(wd, 'answer.txt'), 'utf8')).toBe('42');
    expect(events).toContain('tool');
    expect(events).toContain('final');
  });

  it('runs tools via structured function calling (OpenAI-style tool_calls)', async () => {
    const wd = makeWorkdir();
    const llm = scriptedLlm([
      {
        content: '',
        toolCalls: [{ name: 'write_file', args: { path: 'src/lib.py', content: 'def clamp(v):\n    return v\n' } }],
      },
      { content: '', toolCalls: [{ name: 'finish', args: { summary: 'file written' } }] },
    ]);
    const result = await runAgentLoop({ workdir: wd, task: 'Create src/lib.py.', llm, maxSteps: 10 });
    expect(result.ok).toBe(true);
    expect(result.stoppedBy).toBe('finish');
    expect(result.toolCalls).toBe(1);
    expect(readFileSync(join(wd, 'src/lib.py'), 'utf8')).toContain('def clamp');
  });

  it('stops at max-steps when the agent never finishes (ok=false)', async () => {
    const wd = makeWorkdir();
    const llm = scriptedLlm([{ content: JSON.stringify({ tool: 'read_dir', args: { path: '.' } }) }]);
    const result = await runAgentLoop({ workdir: wd, task: 'Do nothing forever.', llm, maxSteps: 3 });
    expect(result.ok).toBe(false);
    expect(result.stoppedBy).toBe('max-steps');
    expect(result.toolCalls).toBe(3);
  });

  it('reports an error when the LLM throws', async () => {
    const wd = makeWorkdir();
    const llm = async (): Promise<never> => {
      throw new Error('api down');
    };
    const result = await runAgentLoop({ workdir: wd, task: 'Any task', llm });
    expect(result.ok).toBe(false);
    expect(result.stoppedBy).toBe('error');
    expect(result.lastError).toContain('api down');
  });

  it('does not let the agent escape the workdir', async () => {
    const wd = makeWorkdir();
    const llm = scriptedLlm([{ content: JSON.stringify({ tool: 'write_file', args: { path: '../evil.txt', content: 'x' } }) }]);
    const result = await runAgentLoop({ workdir: wd, task: 'Try to escape.', llm, maxSteps: 2 });
    expect(result.ok).toBe(false);
    expect(existsSync(join(wd, '../evil.txt'))).toBe(false);
  });
});

