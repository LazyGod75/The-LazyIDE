/**
 * Tests for the harness-hardening pass (2026-08-15) on
 * src/lib/tools/handlers/files.ts's editFile/multiEdit/writeFile:
 *
 *   - task #2: the matching cascade (exact -> indent-normalized ->
 *     blank-line-stripped) actually applies inside editFile/multiEdit, and
 *     a total match failure feeds real file content back to the model.
 *   - task #3: a syntax-breaking edit is REJECTED before it is written —
 *     the file on disk is never touched, and the model gets the error back.
 *
 * checkSyntax (treeSitterScanner.ts) is mocked here so these tests exercise
 * files.ts's own wiring, not tree-sitter/WASM itself (see
 * treeSitterScanner.ts for that module's own responsibilities).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { executeTool } from '../lib/tools/toolRuntime';
import type { ToolExecutionContext } from '../lib/tools/toolRuntime';

const { mockCheckSyntax } = vi.hoisted(() => ({
  mockCheckSyntax: vi.fn().mockResolvedValue({ supported: false, ok: true, errors: [] }),
}));
vi.mock('../lib/codegraph/treeSitterScanner', () => ({
  checkSyntax: (...args: unknown[]) => mockCheckSyntax(...args),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({
    brain: { capture: vi.fn().mockResolvedValue(undefined), recall: vi.fn().mockResolvedValue({ nodes: [], tokensSaved: 0, injectedContext: '' }) },
  }),
}));
vi.mock('../lib/models/costStore', () => ({ recordRecallSaving: vi.fn() }));
vi.mock('../lib/journal/journal', () => ({ emitBuffered: vi.fn() }));

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

function makeCtx(): ToolExecutionContext {
  return { rootPath: '/tmp/project', policy: {}, agentMode: 'default' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckSyntax.mockResolvedValue({ supported: false, ok: true, errors: [] });
  localStorage.clear();
});

describe('editFile — matching cascade (task #2)', () => {
  it('applies an exact match unchanged', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('const a = 1;\nconst b = 2;\n');
      return Promise.resolve(undefined);
    });

    const result = await executeTool(
      'edit_file',
      { path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 99;' },
      makeCtx(),
    );

    expect(result).toContain('Successfully edited');
    expect(result).not.toContain('matched via');
    const writeCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'write_file');
    expect((writeCall![1] as { content: string }).content).toBe('const a = 99;\nconst b = 2;\n');
  });

  it('applies an edit whose old_string only differs in indentation (indent-normalized tier)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('function foo() {\n\tconst a = 1;\n}\n');
      return Promise.resolve(undefined);
    });

    const result = await executeTool(
      'edit_file',
      {
        path: 'a.ts',
        old_string: 'function foo() {\n  const a = 1;\n}',
        new_string: 'function foo() {\n  const a = 2;\n}',
      },
      makeCtx(),
    );

    expect(result).toContain('Successfully edited');
    expect(result).toContain('indent-normalized');
    const writeCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'write_file');
    expect((writeCall![1] as { content: string }).content).toBe('function foo() {\n  const a = 2;\n}\n');
  });

  it('on total match failure, returns an error carrying a snippet of the REAL file content (not just a bare rejection)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('const realThing = 1;\nconst other = 2;\n');
      return Promise.resolve(undefined);
    });

    const result = await executeTool(
      'edit_file',
      { path: 'a.ts', old_string: 'const totallyDifferent = 999;', new_string: 'x' },
      makeCtx(),
    );

    expect(result).toContain('ERROR');
    expect(result).toContain('old_string not found');
    // The real file content must be surfaced, not just the failure.
    expect(result).toContain('realThing');
    // Never written.
    expect(mockedInvoke).not.toHaveBeenCalledWith('write_file', expect.anything());
  });
});

describe('multi_edit — matching cascade, atomic on failure', () => {
  it('applies edits via the cascade in order, atomically', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('const a = 1;\nconst b = 2;\n');
      return Promise.resolve(undefined);
    });

    const result = await executeTool(
      'multi_edit',
      {
        path: 'a.ts',
        edits: [
          { old_string: 'const a = 1;', new_string: 'const a = 10;' },
          { old_string: 'const b = 2;', new_string: 'const b = 20;' },
        ],
      },
      makeCtx(),
    );

    expect(result).toContain('Successfully applied 2 edits');
    const writeCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'write_file');
    expect((writeCall![1] as { content: string }).content).toBe('const a = 10;\nconst b = 20;\n');
  });

  it('applies no edits when any one fails to match (atomic)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('const a = 1;\n');
      return Promise.resolve(undefined);
    });

    const result = await executeTool(
      'multi_edit',
      {
        path: 'a.ts',
        edits: [
          { old_string: 'const a = 1;', new_string: 'const a = 10;' },
          { old_string: 'const nope = 999;', new_string: 'x' },
        ],
      },
      makeCtx(),
    );

    expect(result).toContain('ERROR');
    expect(result).toContain('No edits applied');
    expect(mockedInvoke).not.toHaveBeenCalledWith('write_file', expect.anything());
  });
});

describe('syntax guardrail (task #3) — reject and never persist a syntax-breaking edit', () => {
  it('editFile: REJECTS a syntax-breaking edit before writing, and reports the error', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('function foo() {\n  return 1;\n}\n');
      return Promise.resolve(undefined);
    });
    mockCheckSyntax.mockResolvedValue({
      supported: true,
      ok: false,
      errors: [{ line: 2, snippet: 'return 1' }],
    });

    const result = await executeTool(
      'edit_file',
      { path: 'a.ts', old_string: 'return 1;', new_string: 'return 1' /* missing semicolon, malformed on purpose */ },
      makeCtx(),
    );

    expect(result).toContain('ERROR');
    expect(result).toContain('REJECTED');
    expect(result).toContain('syntax error');
    expect(result).toContain('line 2');
    // The critical assertion: write_file must never be reached — the file
    // on disk is untouched, not merely reverted after the fact.
    expect(mockedInvoke).not.toHaveBeenCalledWith('write_file', expect.anything());
  });

  it('writeFile: REJECTS syntax-breaking content and never writes it to disk', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.reject('path canonicalize failed: not found (os error 2)');
      return Promise.resolve(undefined);
    });
    mockCheckSyntax.mockResolvedValue({
      supported: true,
      ok: false,
      errors: [{ line: 1, snippet: 'function broken(' }],
    });

    const result = await executeTool(
      'write_file',
      { path: 'broken.ts', content: 'function broken(' },
      makeCtx(),
    );

    expect(result).toContain('ERROR');
    expect(result).toContain('REJECTED');
    expect(mockedInvoke).not.toHaveBeenCalledWith('write_file', expect.anything());
  });

  it('multi_edit: REJECTS when the combined result breaks syntax, applying nothing', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('const a = 1;\n');
      return Promise.resolve(undefined);
    });
    mockCheckSyntax.mockResolvedValue({
      supported: true,
      ok: false,
      errors: [{ line: 1, snippet: 'const a = (' }],
    });

    const result = await executeTool(
      'multi_edit',
      { path: 'a.ts', edits: [{ old_string: 'const a = 1;', new_string: 'const a = (' }] },
      makeCtx(),
    );

    expect(result).toContain('REJECTED');
    expect(mockedInvoke).not.toHaveBeenCalledWith('write_file', expect.anything());
  });

  it('a file the checker cannot validate (supported: false) still writes normally — never blocks on an unsupported language', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('hello world\n');
      return Promise.resolve(undefined);
    });
    mockCheckSyntax.mockResolvedValue({ supported: false, ok: true, errors: [] });

    const result = await executeTool(
      'edit_file',
      { path: 'notes.txt', old_string: 'hello world', new_string: 'hello there' },
      makeCtx(),
    );

    expect(result).toContain('Successfully edited');
    expect(mockedInvoke).toHaveBeenCalledWith('write_file', expect.anything());
  });

  it('a syntax check that throws is treated as best-effort (never blocks a write it could not validate)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('const a = 1;\n');
      return Promise.resolve(undefined);
    });
    mockCheckSyntax.mockRejectedValue(new Error('WASM init failed'));

    const result = await executeTool(
      'edit_file',
      { path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      makeCtx(),
    );

    expect(result).toContain('Successfully edited');
    expect(mockedInvoke).toHaveBeenCalledWith('write_file', expect.anything());
  });
});
