import { describe, expect, it } from 'vitest';

/**
 * tool-trace.test.ts — TDD for Task 2: tool-trace conv-to-code matching
 *
 * Tests the extraction of file paths from JSONL tool_use entries and their
 * attachment as data-cerveau-files-modified / data-cerveau-files-read attributes
 * on conversation note HTML via the production path (annotateSession).
 *
 * Attribute values are COMMA-separated (matching buildToolAttrs in template.ts).
 */

import { type ToolTraceResult, extractToolTraceFiles } from '../src/commands/dream-tool-trace.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeAssistantLine(
  toolName: string,
  filePath: string,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_test',
          name: toolName,
          input: { file_path: filePath, ...extra },
        },
      ],
    },
  });
}

function makeAssistantLineMultiEdit(filePath: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_test',
          name: 'MultiEdit',
          input: {
            file_path: filePath,
            edits: [
              { old_string: 'foo', new_string: 'bar' },
              { old_string: 'baz', new_string: 'qux' },
            ],
          },
        },
      ],
    },
  });
}

function makeUserLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

// A full JSONL fixture: Edit, Write (same file as Edit — dedup), and Read
const PROJECT_ROOT = 'C:/Users/user/Documents/Acme/acme-app';

const FIXTURE_JSONL = [
  makeUserLine('fix the calorie calculation'),
  makeAssistantLine('Edit', `${PROJECT_ROOT}/src/cal/calculator.ts`),
  makeAssistantLine('Write', `${PROJECT_ROOT}/src/cal/calculator.ts`), // duplicate of Edit path
  makeAssistantLine('Write', `${PROJECT_ROOT}/src/cal/utils.ts`),
  makeAssistantLine('Read', `${PROJECT_ROOT}/src/cal/constants.ts`),
  makeUserLine('looks good'),
].join('\n');

// ---------------------------------------------------------------------------
// Tests for extractToolTraceFiles()
// ---------------------------------------------------------------------------

describe('extractToolTraceFiles — path extraction from JSONL', () => {
  it('returns empty lists for a conversation with no tool calls', () => {
    const jsonl = [makeUserLine('hello'), makeUserLine('world')].join('\n');
    const result: ToolTraceResult = extractToolTraceFiles(jsonl, PROJECT_ROOT);
    expect(result.filesModified).toHaveLength(0);
    expect(result.filesRead).toHaveLength(0);
  });

  it('extracts Edit paths into filesModified', () => {
    const jsonl = makeAssistantLine('Edit', `${PROJECT_ROOT}/src/app.ts`);
    const result = extractToolTraceFiles(jsonl, PROJECT_ROOT);
    expect(result.filesModified).toContain('src/app.ts');
  });

  it('extracts Write paths into filesModified', () => {
    const jsonl = makeAssistantLine('Write', `${PROJECT_ROOT}/src/util.ts`);
    const result = extractToolTraceFiles(jsonl, PROJECT_ROOT);
    expect(result.filesModified).toContain('src/util.ts');
  });

  it('extracts MultiEdit file_path into filesModified', () => {
    const jsonl = makeAssistantLineMultiEdit(`${PROJECT_ROOT}/src/multi.ts`);
    const result = extractToolTraceFiles(jsonl, PROJECT_ROOT);
    expect(result.filesModified).toContain('src/multi.ts');
    expect(result.filesRead).not.toContain('src/multi.ts');
  });

  it('extracts Read paths into filesRead, not filesModified', () => {
    const jsonl = makeAssistantLine('Read', `${PROJECT_ROOT}/src/constants.ts`);
    const result = extractToolTraceFiles(jsonl, PROJECT_ROOT);
    expect(result.filesRead).toContain('src/constants.ts');
    expect(result.filesModified).not.toContain('src/constants.ts');
  });

  it('deduplicates when the same file appears in multiple Edit/Write calls', () => {
    const jsonl = [
      makeAssistantLine('Edit', `${PROJECT_ROOT}/src/cal/calculator.ts`),
      makeAssistantLine('Write', `${PROJECT_ROOT}/src/cal/calculator.ts`),
    ].join('\n');
    const result = extractToolTraceFiles(jsonl, PROJECT_ROOT);
    expect(result.filesModified.filter((p) => p === 'src/cal/calculator.ts')).toHaveLength(1);
  });

  it('produces forward-slash relative paths regardless of OS separator in input', () => {
    // Windows absolute path with backslashes
    const winPath = 'C:\\Users\\user\\Documents\\Acme\\acme-app\\src\\app.ts';
    const winRoot = 'C:\\Users\\user\\Documents\\Acme\\acme-app';
    const jsonl = makeAssistantLine('Edit', winPath);
    const result = extractToolTraceFiles(jsonl, winRoot);
    expect(result.filesModified).toContain('src/app.ts');
    expect(result.filesModified[0]).not.toContain('\\');
  });

  it('handles the full fixture with Edit, Write (dup), Write, Read correctly', () => {
    const result = extractToolTraceFiles(FIXTURE_JSONL, PROJECT_ROOT);

    // Edit + Write of same path → deduplicated to 1 entry
    // Plus the second Write → total 2 modified
    expect(result.filesModified).toHaveLength(2);
    expect(result.filesModified).toContain('src/cal/calculator.ts');
    expect(result.filesModified).toContain('src/cal/utils.ts');

    // Read path is read-only, not in modified
    expect(result.filesRead).toHaveLength(1);
    expect(result.filesRead).toContain('src/cal/constants.ts');

    // Read path must NOT appear in filesModified
    expect(result.filesModified).not.toContain('src/cal/constants.ts');
  });

  it('skips Bash with no file_path — both filesModified and filesRead are empty', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
      },
    });
    const result = extractToolTraceFiles(jsonl, PROJECT_ROOT);
    expect(result.filesModified).toHaveLength(0);
    expect(result.filesRead).toHaveLength(0);
  });

  it('handles malformed / non-JSON lines gracefully without throwing', () => {
    const jsonl = [
      'not json',
      makeAssistantLine('Edit', `${PROJECT_ROOT}/src/app.ts`),
      '{bad',
    ].join('\n');
    expect(() => extractToolTraceFiles(jsonl, PROJECT_ROOT)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: verify production HTML output via annotateSession
// (attributes are COMMA-separated per buildToolAttrs in template.ts)
// ---------------------------------------------------------------------------

import { annotateSession } from '../src/annotator/heuristic.js';

describe('annotateSession — production path emits comma-separated file-trace attributes', () => {
  const BASE_INPUT = {
    sessionId: 'dream-test-1',
    text: 'We decided to use TypeScript for the calorie calculator because of type safety.',
    timestamp: '2026-05-28T10:00:00Z',
    cwd: PROJECT_ROOT,
  };

  it('carries data-cerveau-files-modified with comma-separated paths when files were edited', () => {
    const { html } = annotateSession({
      ...BASE_INPUT,
      filesModified: ['src/cal/calculator.ts', 'src/cal/utils.ts'],
    });
    expect(html).toContain('data-cerveau-files-modified=');
    expect(html).toContain('src/cal/calculator.ts');
    expect(html).toContain('src/cal/utils.ts');
    // Comma delimiter — not space-separated
    expect(html).toMatch(
      /data-cerveau-files-modified="[^"]*src\/cal\/calculator\.ts,src\/cal\/utils\.ts[^"]*"/,
    );
  });

  it('carries data-cerveau-files-read with comma-separated paths when files were read', () => {
    const { html } = annotateSession({
      ...BASE_INPUT,
      filesRead: ['src/cal/constants.ts'],
    });
    expect(html).toContain('data-cerveau-files-read=');
    expect(html).toContain('src/cal/constants.ts');
  });

  it('omits data-cerveau-files-modified when no files were modified', () => {
    const { html } = annotateSession({
      ...BASE_INPUT,
      filesRead: ['src/cal/constants.ts'],
    });
    // annotateSession merges filesModified with paths from text — the text doesn't
    // mention any file paths, so the attribute should be absent.
    expect(html).not.toContain('data-cerveau-files-modified=');
  });

  it('produces valid note HTML even when no tool calls occurred', () => {
    const { html } = annotateSession({ ...BASE_INPUT });
    expect(html).not.toContain('data-cerveau-files-read=');
    // Still a valid note HTML
    expect(html).toContain('<article');
    expect(html).toContain('data-cerveau-source=');
  });
});
