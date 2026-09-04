/* assistantToolLoop.test.ts — tests for the extended ReAct loop's directive parsing.

   Verifies that parseToolDirective correctly detects WEB_SEARCH, WEB_FETCH,
   READ_FILE, etc. directives, and that parseUnifiedDirective prioritizes
   tool directives over brain directives.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseToolDirective,
  parseUnifiedDirective,
  withAssistantToolLoop,
  MAX_TOOL_ROUNDS,
} from '../lib/models/assistantToolLoop';
import { hasToolDirectives } from '../lib/models/toolDirectiveNames';
import { ASSISTANT_TOOLS } from '../lib/models/assistantTools';
import { BRAIN_SEARCH_TOOL, STRUCTURAL_BRAIN_TOOLS } from '../lib/brain/brainTool';
import type { ChatTool, StreamChatRequest } from '../lib/models/types';

// The seam assistantToolLoop.ts calls to actually invoke a tool directive
// (see managedProviderToolLoop.test.ts's identical mock) — captures the
// ToolExecutionContext.rootPath a directive round executes with, without
// needing a real Tauri runtime. '../lib/tools/toolProfiles' is left
// UNMOCKED so the real assistant-surface permission check still runs
// (read_file is allowed there).
const mockExecuteTool = vi.fn();
vi.mock('../lib/tools/toolRuntime', () => ({
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
}));

describe('parseToolDirective', () => {
  it('parses WEB_SEARCH directive', () => {
    const result = parseToolDirective('Let me search.\nWEB_SEARCH: rust async runtime benchmarks\n');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('web_search');
    expect(result!.arg).toBe('rust async runtime benchmarks');
  });

  it('parses WEB_FETCH directive', () => {
    const result = parseToolDirective('WEB_FETCH: https://example.com/article');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('web_fetch');
    expect(result!.arg).toBe('https://example.com/article');
  });

  it('parses READ_FILE directive', () => {
    const result = parseToolDirective('READ_FILE: src/lib/tools/toolRuntime.ts');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('read_file');
    expect(result!.arg).toBe('src/lib/tools/toolRuntime.ts');
  });

  it('parses READ_DIR directive', () => {
    const result = parseToolDirective('READ_DIR: src/lib');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('read_dir');
    expect(result!.arg).toBe('src/lib');
  });

  it('parses SEARCH_CODE directive', () => {
    const result = parseToolDirective('SEARCH_CODE: function executeTool');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('search_code');
    expect(result!.arg).toBe('function executeTool');
  });

  it('parses GIT_STATUS directive (no arg required)', () => {
    const result = parseToolDirective('GIT_STATUS:');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('git_status');
    expect(result!.arg).toBe('');
  });

  it('parses GIT_DIFF directive', () => {
    const result = parseToolDirective('GIT_DIFF: src/lib/tools/toolRuntime.ts');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('git_diff');
    expect(result!.arg).toBe('src/lib/tools/toolRuntime.ts');
  });

  it('parses GIT_LOG directive', () => {
    const result = parseToolDirective('GIT_LOG: 5');
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('git_log');
    expect(result!.arg).toBe('5');
  });

  it('returns null when no directive is present', () => {
    expect(parseToolDirective('Just a normal response.')).toBeNull();
    expect(parseToolDirective('')).toBeNull();
  });

  it('returns null when a directive requiring an arg has no arg', () => {
    expect(parseToolDirective('WEB_SEARCH:')).toBeNull();
    expect(parseToolDirective('READ_FILE:')).toBeNull();
  });

  it('takes the LAST directive when multiple are present', () => {
    const result = parseToolDirective('WEB_SEARCH: first\nWEB_SEARCH: second');
    expect(result).not.toBeNull();
    expect(result!.arg).toBe('second');
  });
});

describe('parseUnifiedDirective', () => {
  it('prioritizes tool directives over brain directives', () => {
    const text = 'BRAIN_SEARCH: how does auth work\nWEB_SEARCH: latest auth best practices 2026';
    const result = parseUnifiedDirective(text);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('tool');
    expect(result!.directive.kind).toBe('web_search');
  });

  it('returns brain directive when no tool directive is present', () => {
    const text = 'Let me check memory.\nBRAIN_SEARCH: postgres migration decisions';
    const result = parseUnifiedDirective(text);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('brain');
  });

  it('returns null when no directive is present', () => {
    expect(parseUnifiedDirective('Just a normal answer.')).toBeNull();
  });
});

describe('hasToolDirectives', () => {
  it('returns true when assistant tools are advertised', () => {
    expect(hasToolDirectives(ASSISTANT_TOOLS)).toBe(true);
  });

  it('returns true when any tool directive tool is in the list', () => {
    const tools: ChatTool[] = [
      { name: 'web_search', description: '', input_schema: {} },
    ];
    expect(hasToolDirectives(tools)).toBe(true);
  });

  it('returns false when only brain tools are advertised', () => {
    expect(hasToolDirectives([BRAIN_SEARCH_TOOL, ...STRUCTURAL_BRAIN_TOOLS])).toBe(false);
  });

  it('returns false for empty or undefined tools', () => {
    expect(hasToolDirectives(undefined)).toBe(false);
    expect(hasToolDirectives([])).toBe(false);
  });
});

describe('MAX_TOOL_ROUNDS', () => {
  it('is at least 3 to allow meaningful tool use', () => {
    expect(MAX_TOOL_ROUNDS).toBeGreaterThanOrEqual(3);
  });
});

describe('ASSISTANT_TOOLS', () => {
  it('includes web_search and web_fetch', () => {
    const names = ASSISTANT_TOOLS.map(t => t.name);
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
  });

  it('includes read_file, read_dir, search_code', () => {
    const names = ASSISTANT_TOOLS.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('read_dir');
    expect(names).toContain('search_code');
  });

  it('includes git tools', () => {
    const names = ASSISTANT_TOOLS.map(t => t.name);
    expect(names).toContain('git_status');
    expect(names).toContain('git_diff');
    expect(names).toContain('git_log');
  });

  it('does NOT include destructive tools', () => {
    const names = ASSISTANT_TOOLS.map(t => t.name);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('run_command');
    expect(names).not.toContain('git_commit');
  });

  it('every tool has name, description, and input_schema', () => {
    for (const tool of ASSISTANT_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeDefined();
      expect(typeof tool.input_schema).toBe('object');
    }
  });
});

// ── req.projectRoot wiring (trust bug fix) ──────────────────────────
//
// assistantToolLoop.ts's getProjectRoot() used to be the ONLY source for a
// tool directive's rootPath, reading a 'lazy.projectRoot' localStorage key
// no code path ever wrote — every Codeur tool call (search_code/read_file/
// read_dir/git_*) silently executed against '.' (the backend process's own
// cwd) instead of the open project. The fix threads the LIVE AppContext
// projectRoot through StreamChatRequest.projectRoot (assistantStore.tsx);
// these tests prove withAssistantToolLoop actually uses it, in priority
// over the old localStorage fallback.
describe('withAssistantToolLoop — req.projectRoot wiring', () => {
  const baseReq: StreamChatRequest = {
    messages: [{ id: 'u1', role: 'user', content: 'what does README.md say?' }],
    model: { id: 'claude-haiku-4-5', label: 'Haiku', provider: 'anthropic' },
    mode: 'ask',
    tools: [{ name: 'read_file', description: '', input_schema: {} }],
  };

  beforeEach(() => {
    mockExecuteTool.mockReset();
    localStorage.clear();
  });

  /** First round emits a READ_FILE directive; the second (forced-final)
   *  round answers plainly so the loop terminates after exactly one tool
   *  execution. */
  function makeRunTurn() {
    let call = 0;
    return async function* runTurn(): AsyncIterable<string> {
      call += 1;
      yield call === 1 ? 'READ_FILE: README.md\n' : 'Final answer.\n';
    };
  }

  async function drain(gen: AsyncGenerator<string>): Promise<void> {
    for await (const _chunk of gen) { /* drain */ }
  }

  it('executes the tool directive with rootPath = req.projectRoot when provided', async () => {
    mockExecuteTool.mockResolvedValueOnce('# Lazy IDE\ncontent');
    // A stale localStorage value must NOT win over the live req.projectRoot.
    localStorage.setItem('lazy.projectRoot', 'STALE_FALLBACK_ROOT');

    const req: StreamChatRequest = { ...baseReq, projectRoot: 'C:/Users/user/Documents/real-project' };
    await drain(withAssistantToolLoop(req, makeRunTurn()));

    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'README.md' },
      expect.objectContaining({ rootPath: 'C:/Users/user/Documents/real-project' }),
    );
  });

  it('falls back to the localStorage lazy.projectRoot reader when req.projectRoot is absent', async () => {
    mockExecuteTool.mockResolvedValueOnce('content');
    localStorage.setItem('lazy.projectRoot', '/legacy/fallback/root');

    await drain(withAssistantToolLoop(baseReq, makeRunTurn()));

    expect(mockExecuteTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'README.md' },
      expect.objectContaining({ rootPath: '/legacy/fallback/root' }),
    );
  });

  it('falls back to "." when neither req.projectRoot nor localStorage has a value', async () => {
    mockExecuteTool.mockResolvedValueOnce('content');

    await drain(withAssistantToolLoop(baseReq, makeRunTurn()));

    expect(mockExecuteTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'README.md' },
      expect.objectContaining({ rootPath: '.' }),
    );
  });
});
