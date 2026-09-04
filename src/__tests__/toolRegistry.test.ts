/**
 * Tests for the tool registry, tool profiles, and tool traces modules.
 *
 * toolRegistry.ts — central tool definitions, ACI-optimized descriptions,
 *   system-prompt generation, plan-mode blocking.
 * learnedToolProfiles.ts — brain-powered learning layer, addendum extraction.
 * toolTraces.ts — trace capture, error classification, convention detection.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Mock platform (toolProfiles imports getPlatform for brain.capture) ──
// vi.hoisted so the mock fn is created before vi.mock's factory runs (which
// itself is hoisted above these imports) — lets individual tests override
// it (mockRejectedValueOnce) without redefining the whole module.
const { mockCapture } = vi.hoisted(() => ({
  mockCapture: vi.fn().mockResolvedValue({ id: 'test-id', path: '/mock', sizeBytes: 0, attrsCount: 0 }),
}));
vi.mock('../lib/platform', () => ({
  getPlatform: () => ({
    brain: {
      capture: mockCapture,
    },
  }),
}));

// ── Mock brainTool (toolProfiles imports runBrainQueryCss) ──
vi.mock('../lib/brain/brainTool', () => ({
  runBrainQueryCss: vi.fn().mockResolvedValue('0 matches'),
  runBrainNeighbours: vi.fn().mockResolvedValue('(no neighbours)'),
}));

import {
  ALL_TOOLS,
  getTool,
  getToolNames,
  getToolsByCategory,
  getPlanBlockedTools,
  buildToolSignatures,
  buildActionList,
  buildToolPolicyBlock,
} from '../lib/agents/toolRegistry';

import {
  REGISTERED_TOOLS,
  getRegisteredTool,
  buildLazyToolBlock,
  getToolPromptBudget,
  findTool,
  formatFindToolResult,
  suggestTools,
} from '../lib/agents/toolRegistryLazy';

import { ASSISTANT_TOOLS } from '../lib/models/assistantTools';

import {
  buildAddendumFromTraces,
  saveToolProfile,
  type ToolTraceRecord,
} from '../lib/agents/learnedToolProfiles';

import {
  TraceBuffer,
  classifyError,
  detectConvention,
} from '../lib/agents/toolTraces';

// ── toolRegistry tests ─────────────────────────────────────────────

describe('toolRegistry', () => {
  describe('ALL_TOOLS', () => {
    it('contains a comprehensive set of tools (20+)', () => {
      expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(20);
    });

    it('includes all indispensable tools', () => {
      const names = getToolNames();
      // Navigation
      expect(names).toContain('read_file');
      expect(names).toContain('read_dir');
      expect(names).toContain('search_code');
      expect(names).toContain('find_file');
      // Edit
      expect(names).toContain('edit_file');
      expect(names).toContain('write_file');
      expect(names).toContain('multi_edit');
      // Exec
      expect(names).toContain('run_command');
      expect(names).toContain('run_tests');
      // Git
      expect(names).toContain('git_status');
      expect(names).toContain('git_diff');
      expect(names).toContain('review_diff');
      // Web
      expect(names).toContain('web_search');
      expect(names).toContain('web_fetch');
      // Brain
      expect(names).toContain('brain_query');
      expect(names).toContain('brain_query_css');
      expect(names).toContain('brain_neighbours');
      expect(names).toContain('brain_record');
      // Orchestration
      expect(names).toContain('ask_user');
    });

    it('has unique tool names', () => {
      const names = getToolNames();
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it('every tool has a non-empty description (ACI-optimized)', () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.description.length).toBeGreaterThan(50);
      }
    });

    it('every tool has a schema string', () => {
      // 2026-08-15 (harness hardening, task #1): edit_file/multi_edit/
      // write_file no longer document a JSON ARGS shape — their schema is
      // the SEARCH/REPLACE (or fenced-CONTENT) ReAct block text instead
      // (see searchReplaceProtocol.ts's header for why file content must
      // never round-trip through JSON.parse). Every OTHER tool is unaffected
      // and keeps the JSON-shape invariant.
      const FILE_CONTENT_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file']);
      for (const tool of ALL_TOOLS) {
        expect(tool.schema).toBeTruthy();
        if (FILE_CONTENT_TOOLS.has(tool.name)) {
          expect(tool.schema).toContain('ACTION:');
        } else {
          expect(tool.schema).toContain('{');
        }
      }
    });
  });

  describe('getTool', () => {
    it('returns the tool definition by name', () => {
      const tool = getTool('read_file');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('read_file');
      expect(tool!.category).toBe('navigation');
    });

    it('returns undefined for unknown tools', () => {
      expect(getTool('nonexistent_tool')).toBeUndefined();
    });
  });

  describe('getToolsByCategory', () => {
    it('returns tools filtered by category', () => {
      const brainTools = getToolsByCategory('brain');
      expect(brainTools.length).toBeGreaterThanOrEqual(4);
      expect(brainTools.every(t => t.category === 'brain')).toBe(true);
    });

    it('returns empty array for unknown category', () => {
      // @ts-expect-error — testing invalid category
      expect(getToolsByCategory('nonexistent')).toEqual([]);
    });
  });

  describe('getPlanBlockedTools', () => {
    it('blocks write/edit/exec tools in plan mode', () => {
      const blocked = getPlanBlockedTools();
      expect(blocked.has('write_file')).toBe(true);
      expect(blocked.has('edit_file')).toBe(true);
      expect(blocked.has('multi_edit')).toBe(true);
      expect(blocked.has('run_command')).toBe(true);
      expect(blocked.has('run_tests')).toBe(true);
      expect(blocked.has('git_commit')).toBe(true);
      expect(blocked.has('brain_record')).toBe(true);
    });

    it('allows read-only tools in plan mode', () => {
      const blocked = getPlanBlockedTools();
      expect(blocked.has('read_file')).toBe(false);
      expect(blocked.has('read_dir')).toBe(false);
      expect(blocked.has('search_code')).toBe(false);
      expect(blocked.has('brain_query')).toBe(false);
      expect(blocked.has('git_status')).toBe(false);
      expect(blocked.has('review_diff')).toBe(false);
      expect(blocked.has('web_search')).toBe(false);
    });
  });

  describe('buildToolSignatures', () => {
    it('produces a multi-line string with all tool names and schemas', () => {
      const sigs = buildToolSignatures();
      expect(sigs).toContain('read_file:');
      expect(sigs).toContain('write_file:');
      expect(sigs).toContain('web_search:');
      expect(sigs).toContain('brain_query:');
      expect(sigs.split('\n').length).toBeGreaterThan(20);
    });

    it('injects brain overlays into descriptions when provided', () => {
      const overlays = new Map([['run_command', 'Always use --cwd flag']]);
      const sigs = buildToolSignatures(overlays);
      expect(sigs).toContain('PROJECT KNOWLEDGE: Always use --cwd flag');
    });

    it('does not inject overlay text when no overlays', () => {
      const sigs = buildToolSignatures();
      expect(sigs).not.toContain('PROJECT KNOWLEDGE:');
    });
  });

  describe('buildActionList', () => {
    it('produces a pipe-separated list including FINAL', () => {
      const list = buildActionList();
      expect(list).toContain('read_file');
      expect(list).toContain('FINAL');
      expect(list).toContain(' | ');
    });
  });

  describe('buildToolPolicyBlock', () => {
    it('returns empty string when no restrictions', () => {
      expect(buildToolPolicyBlock(undefined, undefined, undefined)).toBe('');
    });

    it('includes PLAN MODE block for plan mode', () => {
      const block = buildToolPolicyBlock('plan');
      expect(block).toContain('PLAN MODE');
      expect(block).toContain('BLOCKED');
    });

    it('includes denied tools', () => {
      const block = buildToolPolicyBlock(undefined, undefined, ['run_command', 'write_file']);
      expect(block).toContain('DENIED TOOLS');
      expect(block).toContain('run_command');
    });

    it('includes allowed tools', () => {
      const block = buildToolPolicyBlock(undefined, ['read_file', 'brain_query'], undefined);
      expect(block).toContain('ALLOWED TOOLS');
      expect(block).toContain('read_file');
    });
  });
});

// ── toolProfiles tests ─────────────────────────────────────────────

describe('toolProfiles', () => {
  describe('buildAddendumFromTraces', () => {
    it('returns null with fewer than 2 traces', () => {
      const traces: ToolTraceRecord[] = [
        { toolName: 'run_command', args: '{}', success: true, timestamp: 1 },
      ];
      expect(buildAddendumFromTraces('run_command', traces)).toBeNull();
    });

    it('extracts failure patterns from repeated errors', () => {
      const traces: ToolTraceRecord[] = [
        { toolName: 'edit_file', args: '{}', success: false, errorType: 'match_failed', timestamp: 1 },
        { toolName: 'edit_file', args: '{}', success: false, errorType: 'match_failed', timestamp: 2 },
        { toolName: 'edit_file', args: '{}', success: false, errorType: 'match_failed', timestamp: 3 },
      ];
      const addendum = buildAddendumFromTraces('edit_file', traces);
      expect(addendum).not.toBeNull();
      expect(addendum).toContain('match_failed');
      expect(addendum).toContain('3');
    });

    it('extracts convention patterns from successful runs', () => {
      const traces: ToolTraceRecord[] = [
        { toolName: 'run_command', args: '{}', success: true, convention: 'command: npm test', timestamp: 1 },
        { toolName: 'run_command', args: '{}', success: true, convention: 'command: npm test', timestamp: 2 },
      ];
      const addendum = buildAddendumFromTraces('run_command', traces);
      expect(addendum).not.toBeNull();
      expect(addendum).toContain('npm test');
    });

    it('includes correction when a failed pattern was later resolved', () => {
      const traces: ToolTraceRecord[] = [
        { toolName: 'run_command', args: '{}', success: false, errorType: 'timeout', timestamp: 1 },
        { toolName: 'run_command', args: '{}', success: false, errorType: 'timeout', timestamp: 2 },
        { toolName: 'run_command', args: '{}', success: true, errorType: 'timeout', convention: 'use --timeout 60', timestamp: 3 },
      ];
      const addendum = buildAddendumFromTraces('run_command', traces);
      expect(addendum).toContain('Fix:');
      expect(addendum).toContain('--timeout 60');
    });

    it('returns null when no patterns found', () => {
      const traces: ToolTraceRecord[] = [
        { toolName: 'read_file', args: '{}', success: true, timestamp: 1 },
        { toolName: 'read_file', args: '{}', success: true, timestamp: 2 },
      ];
      expect(buildAddendumFromTraces('read_file', traces)).toBeNull();
    });
  });
});

// ── toolTraces tests ───────────────────────────────────────────────

describe('toolTraces', () => {
  describe('TraceBuffer', () => {
    it('records and retrieves traces', () => {
      const buf = new TraceBuffer();
      buf.record({ toolName: 'read_file', args: '{}', success: true, timestamp: 1 });
      buf.record({ toolName: 'write_file', args: '{}', success: false, errorType: 'permission', timestamp: 2 });
      expect(buf.size).toBe(2);
      expect(buf.getTracesForTool('read_file').length).toBe(1);
      expect(buf.getTracesForTool('write_file').length).toBe(1);
    });

    it('clears traces', () => {
      const buf = new TraceBuffer();
      buf.record({ toolName: 'read_file', args: '{}', success: true, timestamp: 1 });
      buf.clear();
      expect(buf.size).toBe(0);
    });

    it('processAtMissionEnd does not throw with <2 traces per tool', async () => {
      const buf = new TraceBuffer();
      buf.record({ toolName: 'read_file', args: '{}', success: true, timestamp: 1 });
      await expect(buf.processAtMissionEnd()).resolves.not.toThrow();
    });
  });

  describe('classifyError', () => {
    it('classifies not_found errors', () => {
      expect(classifyError('ERROR: file not found')).toBe('not_found');
      expect(classifyError('ERROR: No such file or directory')).toBe('not_found');
    });

    it('classifies permission errors', () => {
      expect(classifyError('ERROR: permission denied')).toBe('permission');
    });

    it('classifies timeout errors', () => {
      expect(classifyError('ERROR: command timed out')).toBe('timeout');
    });

    it('classifies match_failed errors', () => {
      expect(classifyError('ERROR: old_string not found in file')).toBe('match_failed');
    });

    it('classifies syntax errors', () => {
      expect(classifyError('ERROR: syntax error in pattern')).toBe('syntax');
    });

    it('returns undefined for non-error observations', () => {
      expect(classifyError('Successfully wrote file.ts')).toBeUndefined();
    });

    it('returns "other" for unrecognized errors', () => {
      expect(classifyError('ERROR: something weird happened')).toBe('other');
    });
  });

  describe('detectConvention', () => {
    it('detects test/lint/build commands', () => {
      const conv = detectConvention('run_command', { command: 'npm test' }, 'all tests passed');
      expect(conv).toBe('command: npm test');
    });

    it('does not detect convention for non-test commands', () => {
      const conv = detectConvention('run_command', { command: 'echo hello' }, 'hello');
      expect(conv).toBeUndefined();
    });

    it('detects test pass convention', () => {
      const conv = detectConvention('run_tests', {}, 'Tests: 5 passed, 0 failed');
      expect(conv).toBe('tests pass with current config');
    });

    it('returns undefined for failed commands', () => {
      const conv = detectConvention('run_command', { command: 'npm test' }, 'ERROR: tests failed');
      expect(conv).toBeUndefined();
    });
  });
});

// ── Web tools tests ────────────────────────────────────────────────

// ── saveToolProfile: platform.brain.capture() must be awaited ──────
//
// Previously an un-awaited platform.brain.capture() call here let ANY
// rejection escape as an unhandled promise rejection (the calling try/catch
// had already exited by the time the promise settled) — most commonly a
// duplicate note's "Note already exists" conflict (see captureQueue.ts's
// module header and managedAgent.ts's identical FINAL-handler fix).

describe('learnedToolProfiles — saveToolProfile capture is awaited (conflict-as-success)', () => {
  it('a "Note already exists" conflict is swallowed as success — no unhandled rejection, no warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCapture.mockRejectedValueOnce(
      new Error('lazybrain: Note already exists: notes/2026-07/tool-profile-run_command.html. Pass overwrite to replace.'),
    );

    await expect(
      saveToolProfile('run_command', 'Prefer npm over yarn in this project', 3),
    ).resolves.toBeUndefined();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('web tools (registry definitions)', () => {
  describe('web_search', () => {
    it('is defined with correct category and plan-mode flag', () => {
      const tool = getTool('web_search');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('web');
      expect(tool!.blockedInPlan).toBe(false);
    });

    it('description mentions DuckDuckGo, structured results, and cross-tool guidance', () => {
      const tool = getTool('web_search');
      expect(tool!.description).toContain('DuckDuckGo');
      expect(tool!.description).toContain('title');
      expect(tool!.description).toContain('snippet');
      expect(tool!.description).toContain('web_fetch');
      expect(tool!.description).toContain('brain_query');
    });

    it('schema includes query and max_results', () => {
      const tool = getTool('web_search');
      expect(tool!.schema).toContain('query');
      expect(tool!.schema).toContain('max_results');
    });
  });

  describe('web_fetch', () => {
    it('is defined with correct category and plan-mode flag', () => {
      const tool = getTool('web_fetch');
      expect(tool).toBeDefined();
      expect(tool!.category).toBe('web');
      expect(tool!.blockedInPlan).toBe(false);
    });

    it('description mentions HTML preservation, Cloudflare, redirects, and Brain compatibility', () => {
      const tool = getTool('web_fetch');
      expect(tool!.description).toContain('HTML');
      expect(tool!.description).toContain('Cloudflare');
      expect(tool!.description).toContain('redirect');
      expect(tool!.description).toContain('brain_record');
      expect(tool!.description).toContain('data-cerveau');
      expect(tool!.description).toContain('timeout_secs');
    });

    it('schema includes url, max_chars, and timeout_secs', () => {
      const tool = getTool('web_fetch');
      expect(tool!.schema).toContain('url');
      expect(tool!.schema).toContain('max_chars');
      expect(tool!.schema).toContain('timeout_secs');
    });
  });

  describe('buildToolSignatures includes web tools', () => {
    it('contains web_search and web_fetch in the generated signatures', () => {
      const sigs = buildToolSignatures();
      expect(sigs).toContain('web_search:');
      expect(sigs).toContain('web_fetch:');
    });
  });
});

// ── toolRegistryLazy — lazy tool loading (core/index split + find_tool) ──

describe('toolRegistryLazy', () => {
  describe('registry integrity', () => {
    it('REGISTERED_TOOLS has one merged entry per ALL_TOOLS entry, no dups', () => {
      expect(REGISTERED_TOOLS.length).toBe(ALL_TOOLS.length);
      const names = REGISTERED_TOOLS.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('every registered tool carries real metadata (shortHint, tags, coreFor)', () => {
      for (const tool of REGISTERED_TOOLS) {
        expect(tool.shortHint).toBeTruthy();
        expect(tool.shortHint.length).toBeLessThan(80); // roughly ≤10 words
        expect(Array.isArray(tool.tags)).toBe(true);
        expect(Array.isArray(tool.coreFor)).toBe(true);
      }
    });

    it('tags only use the founder-specified vocabulary', () => {
      const allowed = new Set(['front', 'web', 'git', 'brain', 'files', 'vision']);
      for (const tool of REGISTERED_TOOLS) {
        for (const tag of tool.tags) {
          expect(allowed.has(tag)).toBe(true);
        }
      }
    });

    it('find_tool itself is registered and core for every surface', () => {
      const tool = getRegisteredTool('find_tool');
      expect(tool).toBeDefined();
      expect(tool!.coreFor).toEqual(expect.arrayContaining(['mission', 'codeur', 'manager']));
    });

    it('getRegisteredTool returns undefined for an unknown name', () => {
      expect(getRegisteredTool('not_a_real_tool')).toBeUndefined();
    });

    it('every ASSISTANT_TOOLS name is registered with coreFor including "codeur" (cross-registry SSOT check)', () => {
      for (const chatTool of ASSISTANT_TOOLS) {
        const registered = getRegisteredTool(chatTool.name);
        expect(registered, `${chatTool.name} missing from toolRegistryLazy`).toBeDefined();
        expect(registered!.coreFor).toContain('codeur');
      }
    });
  });

  describe('buildLazyToolBlock', () => {
    it('shows core tools in full and non-core tools as a one-line index only', () => {
      const { text, coreNames, indexNames } = buildLazyToolBlock('mission');
      // A core tool's full ACI-optimized description is present verbatim.
      expect(coreNames).toContain('read_file');
      expect(text).toContain('Read a file and return a windowed view');
      // A non-core tool appears ONLY as its shortHint index line, not its full description.
      expect(indexNames).toContain('browser_click');
      expect(text).toContain('browser_click:');
      expect(text).not.toContain('Playwright snapshot ref');
    });

    it('find_tool is always core, even though it is not in any coreFor list explicitly required', () => {
      const { coreNames } = buildLazyToolBlock('codeur');
      expect(coreNames).toContain('find_tool');
    });

    it('extraToolNames (suggestTools preload) widens the core set for one call', () => {
      const withoutPreload = buildLazyToolBlock('mission');
      expect(withoutPreload.coreNames).not.toContain('browser_open');

      const withPreload = buildLazyToolBlock('mission', undefined, ['browser_open']);
      expect(withPreload.coreNames).toContain('browser_open');
      expect(withPreload.text).toContain('Open a visible browser window (Chromium via Playwright)');
    });

    it('an unknown extraToolNames entry is ignored, not thrown', () => {
      expect(() => buildLazyToolBlock('mission', undefined, ['not_a_real_tool'])).not.toThrow();
      const { coreNames } = buildLazyToolBlock('mission', undefined, ['not_a_real_tool']);
      expect(coreNames).not.toContain('not_a_real_tool');
    });

    it('injects brain overlays into core tools\' descriptions', () => {
      const overlays = new Map([['read_file', 'Always check .gitignore first']]);
      const { text } = buildLazyToolBlock('mission', overlays);
      expect(text).toContain('PROJECT KNOWLEDGE: Always check .gitignore first');
    });

    it('different surfaces produce different core sets', () => {
      const mission = buildLazyToolBlock('mission');
      const codeur = buildLazyToolBlock('codeur');
      expect(mission.coreNames).toContain('edit_file'); // mission-only core tool
      expect(codeur.coreNames).not.toContain('edit_file');
      expect(codeur.coreNames).toContain('git_log'); // codeur-core tool
    });
  });

  describe('getToolPromptBudget — honest before/after telemetry', () => {
    it('reports a real reduction in the tool-definitions block size', () => {
      const budget = getToolPromptBudget('mission');
      expect(budget.totalTools).toBe(ALL_TOOLS.length);
      expect(budget.coreCount + budget.indexCount).toBe(budget.totalTools);
      expect(budget.charsLazy).toBeLessThan(budget.charsFull);
      expect(budget.tokensApproxLazy).toBeLessThan(budget.tokensApproxFull);
      expect(budget.savingsPct).toBeGreaterThan(0);
    });

    it('matches the budget embedded in buildLazyToolBlock\'s own output for the same inputs', () => {
      const budget = getToolPromptBudget('codeur', undefined, ['web_search']);
      const block = buildLazyToolBlock('codeur', undefined, ['web_search']);
      expect(budget).toEqual(block.budget);
    });

    it('a wider preload list never reports MORE savings than a narrower one', () => {
      const narrow = getToolPromptBudget('mission');
      const wide = getToolPromptBudget('mission', undefined, ['browser_open', 'browser_navigate', 'mcp_call']);
      expect(wide.charsLazy).toBeGreaterThanOrEqual(narrow.charsLazy);
      expect(wide.savingsPct).toBeLessThanOrEqual(narrow.savingsPct);
    });
  });

  describe('findTool', () => {
    it('returns an exact match by name', () => {
      const matches = findTool('read_file');
      expect(matches).toHaveLength(1);
      expect(matches[0].name).toBe('read_file');
    });

    it('is case-insensitive', () => {
      expect(findTool('READ_FILE')[0]?.name).toBe('read_file');
    });

    it('matches by name substring when there is no exact match', () => {
      const matches = findTool('browser_');
      expect(matches.length).toBeGreaterThan(1);
      expect(matches.every((t) => t.name.includes('browser_'))).toBe(true);
    });

    it('matches by tag', () => {
      const matches = findTool('vision');
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((t) => t.tags.includes('vision'))).toBe(true);
    });

    it('matches by a keyword in the shortHint or description', () => {
      const matches = findTool('Cloudflare');
      expect(matches.some((t) => t.name === 'web_fetch')).toBe(true);
    });

    it('caps results at 5', () => {
      const matches = findTool('files'); // a broad tag with many hits
      expect(matches.length).toBeLessThanOrEqual(5);
    });

    it('returns an empty array for an empty query', () => {
      expect(findTool('')).toEqual([]);
      expect(findTool('   ')).toEqual([]);
    });

    it('returns an empty array when nothing matches', () => {
      expect(findTool('xyzzy_not_a_real_tool_or_keyword')).toEqual([]);
    });
  });

  describe('formatFindToolResult', () => {
    it('renders the full definition (schema + description) for a match', () => {
      const result = formatFindToolResult('browser_click');
      expect(result).toContain('browser_click:');
      expect(result).toContain('Click an element in the browser');
    });

    it('returns an honest "no match" message instead of throwing', () => {
      const result = formatFindToolResult('xyzzy_not_a_real_tool');
      expect(result).toContain('No tool found matching');
      expect(result).toContain('xyzzy_not_a_real_tool');
    });
  });

  describe('suggestTools', () => {
    it('suggests web tools for a web-flavored task', () => {
      expect(suggestTools('Deploy the new marketing website')).toEqual(
        expect.arrayContaining(['web_search', 'web_fetch']),
      );
    });

    it('suggests git PR tools for a release-flavored task', () => {
      expect(suggestTools('Push the branch and open a pull request')).toEqual(
        expect.arrayContaining(['git_commit', 'git_create_pr']),
      );
    });

    it('suggests browser tools for an e2e/visual task', () => {
      expect(suggestTools('Take a screenshot to verify the new browser flow')).toEqual(
        expect.arrayContaining(['browser_open', 'browser_screenshot']),
      );
    });

    it('understands French keywords too', () => {
      expect(suggestTools('Publier une nouvelle release et pousser la branche')).toEqual(
        expect.arrayContaining(['git_commit', 'git_create_pr']),
      );
    });

    it('returns an empty array for a task with no matching keywords', () => {
      expect(suggestTools('Fix the typo in the changelog')).toEqual([]);
    });

    it('returns an empty array for empty/blank input', () => {
      expect(suggestTools('')).toEqual([]);
      expect(suggestTools('   ')).toEqual([]);
    });

    it('never suggests a name that is not a real registered tool', () => {
      const allNames = new Set(REGISTERED_TOOLS.map((t) => t.name));
      const suggestions = suggestTools('site web push pull request screenshot test lint build mcp slack');
      for (const name of suggestions) {
        expect(allNames.has(name)).toBe(true);
      }
    });
  });

  describe('prompt-assembly — non-core defs absent by default, injectable on demand', () => {
    it('a non-core tool\'s full description is absent from the default lazy block', () => {
      const { text } = buildLazyToolBlock('mission');
      // browser_navigate is not core for 'mission' — its full description
      // text must not leak into the prompt, only its shortHint index line.
      expect(text).not.toContain('Navigate the browser to a URL. Requires browser_open first.');
      expect(text).toContain('browser_navigate: Navigate the open browser to a URL');
    });

    it('the SAME tool\'s full description IS present once fetched via find_tool', () => {
      const observation = formatFindToolResult('browser_navigate');
      expect(observation).toContain('Navigate the browser to a URL. Requires browser_open first.');
    });

    it('preloading via suggestTools makes a tool core without calling find_tool', () => {
      const preload = suggestTools('run the e2e browser test with a screenshot');
      const { text, coreNames } = buildLazyToolBlock('mission', undefined, preload);
      expect(coreNames).toContain('browser_open');
      expect(text).toContain('Open a visible browser window (Chromium via Playwright)');
    });
  });
});
