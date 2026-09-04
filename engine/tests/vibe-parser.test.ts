import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  VIBE_COMPACT_SUMMARY_PREFIX,
  extractVibeSummary,
  extractVibeToolFiles,
  findCompactionSummary,
  isCompactionSummary,
  parseVibeMessages,
  parseVibeMeta,
} from '../src/sources/vibe-parser.js';

const FIX = join(__dirname, 'fixtures', 'vibe', 'logs', 'session');
const MAIN = join(FIX, 'session_20260601_120000_a1b2c3d4');
const CHILD = join(FIX, 'session_20260601_140000_99887766');

describe('parseVibeMessages', () => {
  it('parses every valid line and skips corrupt ones', () => {
    const raw = readFileSync(join(MAIN, 'messages.jsonl'), 'utf8');
    const messages = parseVibeMessages(`${raw}\nnot json at all\n`);
    expect(messages).toHaveLength(5);
    expect(messages[0].role).toBe('user');
    expect(messages[1].tool_calls?.[0].function?.name).toBe('read');
  });
});

describe('parseVibeMeta', () => {
  it('parses meta.json fields', () => {
    const meta = parseVibeMeta(readFileSync(join(MAIN, 'meta.json'), 'utf8'));
    expect(meta?.session_id).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(meta?.git_branch).toBe('main');
    expect(meta?.environment?.working_directory).toBe('C:/proj/acme');
  });
  it('returns null on corrupt json', () => {
    expect(parseVibeMeta('{nope')).toBeNull();
  });
});

describe('extractVibeToolFiles', () => {
  it('double-parses function.arguments and relativises against the project root', () => {
    const messages = parseVibeMessages(readFileSync(join(MAIN, 'messages.jsonl'), 'utf8'));
    const { filesModified, filesRead } = extractVibeToolFiles(messages, 'C:/proj/acme');
    expect(filesRead).toEqual(['src/payments/stripe.ts']);
    expect(filesModified).toContain('src/payments/stripe.ts');
    expect(filesModified).toContain('src/payments/idempotency.ts');
  });
});

describe('extractVibeSummary', () => {
  it('keeps user decisions and assistant findings, skips role:tool and injected', () => {
    const messages = parseVibeMessages(readFileSync(join(MAIN, 'messages.jsonl'), 'utf8'));
    const text = extractVibeSummary(messages);
    expect(text).toContain('parameterized queries');
    expect(text).toContain('idempot');
    expect(text).not.toContain('export async function handleWebhook');
  });
});

describe('findCompactionSummary', () => {
  it('detects the injected compaction summary and strips the prefix', () => {
    const messages = parseVibeMessages(readFileSync(join(CHILD, 'messages.jsonl'), 'utf8'));
    const summary = findCompactionSummary(messages);
    expect(summary).toContain('idempotency bug');
    expect(summary).not.toContain('Another language model');
  });
  it('returns null when absent', () => {
    const messages = parseVibeMessages(readFileSync(join(MAIN, 'messages.jsonl'), 'utf8'));
    expect(findCompactionSummary(messages)).toBeNull();
  });

  // Task 6b: compaction prefix is a named constant and detection tolerates leading whitespace
  it('VIBE_COMPACT_SUMMARY_PREFIX is the exact Vibe literal prefix', () => {
    expect(VIBE_COMPACT_SUMMARY_PREFIX).toBe(
      'Another language model started to solve this problem',
    );
  });

  it('detects compaction summary with leading whitespace in content (v2.13+ inline injection)', () => {
    const msg = {
      role: 'user' as const,
      injected: true,
      content: `  \n${VIBE_COMPACT_SUMMARY_PREFIX}\nThe team fixed the webhook bug.`,
    };
    expect(isCompactionSummary(msg)).toBe(true);
    const result = findCompactionSummary([msg]);
    expect(result).toBe('The team fixed the webhook bug.');
    expect(result).not.toContain(VIBE_COMPACT_SUMMARY_PREFIX);
  });

  it('does not flag a non-injected message with the same prefix', () => {
    const msg = {
      role: 'user' as const,
      injected: false,
      content: `${VIBE_COMPACT_SUMMARY_PREFIX}\nSome body.`,
    };
    expect(isCompactionSummary(msg)).toBe(false);
  });

  it('returns null when the compaction body is empty after stripping prefix line', () => {
    // The prefix occupies the first line; only whitespace follows.
    const msg = {
      role: 'user' as const,
      injected: true,
      content: `${VIBE_COMPACT_SUMMARY_PREFIX}\n   \n`,
    };
    expect(findCompactionSummary([msg])).toBeNull();
  });
});

// Task 6a: tool rename search_replace → edit (v2.14), both names produce file attribution
describe('extractVibeToolFiles — tool-name compat', () => {
  it('attributes files from the pre-v2.14 search_replace tool name', () => {
    const jsonl = [
      JSON.stringify({ role: 'user', content: 'fix the bug' }),
      JSON.stringify({
        role: 'assistant',
        content: 'fixing',
        tool_calls: [
          {
            id: 'tc1',
            index: 0,
            type: 'function',
            function: {
              name: 'search_replace',
              arguments: JSON.stringify({ file_path: 'C:/proj/acme/src/auth/middleware.ts' }),
            },
          },
        ],
      }),
    ].join('\n');
    const messages = parseVibeMessages(jsonl);
    const { filesModified } = extractVibeToolFiles(messages, 'C:/proj/acme');
    expect(filesModified).toContain('src/auth/middleware.ts');
  });

  it('attributes files from the v2.14 edit tool name', () => {
    const jsonl = [
      JSON.stringify({
        role: 'assistant',
        content: 'editing',
        tool_calls: [
          {
            id: 'tc2',
            index: 0,
            type: 'function',
            function: {
              name: 'edit',
              arguments: JSON.stringify({ file_path: 'C:/proj/acme/src/payments/stripe.ts' }),
            },
          },
        ],
      }),
    ].join('\n');
    const messages = parseVibeMessages(jsonl);
    const { filesModified } = extractVibeToolFiles(messages, 'C:/proj/acme');
    expect(filesModified).toContain('src/payments/stripe.ts');
  });
});
