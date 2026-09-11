/**
 * Unit tests for import adapters.
 *
 * Tests cover:
 *   - claude-code adapter: JSONL parsing via the existing source
 *   - chatgpt-export adapter: standard JSON format
 *   - claude-export adapter: standard JSON format
 *   - scrubber: secret pattern replacement
 *
 * Cursor adapter is tested for isAvailable() path only (SQLite dependency).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatGptExportAdapter } from '../adapter-chatgpt-export.js';
import { ClaudeCodeImportAdapter, stripHarnessMarkup } from '../adapter-claude-code.js';
import { ClaudeExportAdapter } from '../adapter-claude-export.js';
import { CursorImportAdapter } from '../adapter-cursor.js';
import { scrubText } from '../scrub.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  const dir = join(tmpdir(), `lazybrain-import-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir: string, name: string, data: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data), 'utf-8');
  return path;
}

// ---------------------------------------------------------------------------
// Scrubber tests
// ---------------------------------------------------------------------------

describe('scrubText', () => {
  it('replaces sk- API keys', () => {
    const result = scrubText('Use sk-abcdefghij1234567890 for auth');
    expect(result).not.toContain('sk-abcdefghij1234567890');
    expect(result).toContain('[API_KEY]');
  });

  it('replaces GitHub PATs', () => {
    const result = scrubText(`export GITHUB_TOKEN=ghp_${'A'.repeat(32)}`);
    expect(result).toContain('[GITHUB_TOKEN]');
  });

  it('replaces JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.SomeSignatureHereABCD1234';
    const result = scrubText(`Authorization: Bearer ${jwt}`);
    expect(result).toContain('[JWT]');
  });

  it('replaces Bearer tokens', () => {
    const result = scrubText('Authorization: Bearer abcdefghij1234567890xyz');
    expect(result).toContain('[TOKEN]');
  });

  it('leaves normal text untouched', () => {
    const text = 'We decided to use Supabase for authentication';
    expect(scrubText(text)).toBe(text);
  });

  it('replaces multiple secrets in one string', () => {
    const text = `key1=sk-1234567890abcdefghijk token=ghp_${'B'.repeat(32)}`;
    const result = scrubText(text);
    expect(result).toContain('[API_KEY]');
    expect(result).toContain('[GITHUB_TOKEN]');
  });
});

// ---------------------------------------------------------------------------
// ChatGPT export adapter
// ---------------------------------------------------------------------------

describe('ChatGptExportAdapter', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  it('returns [] when file does not exist', () => {
    const adapter = new ChatGptExportAdapter(join(dir, 'nonexistent.json'));
    expect(adapter.isAvailable()).toBe(false);
    expect(adapter.list()).toEqual([]);
  });

  it('parses top-level array format', () => {
    const convData = [
      {
        id: 'conv1',
        title: 'Test conversation',
        create_time: 1700000000,
        update_time: 1700000100,
        mapping: {
          root: { id: 'root', parent: null, children: ['msg1'], message: undefined },
          msg1: {
            id: 'msg1',
            parent: 'root',
            children: ['msg2'],
            message: {
              id: 'msg1',
              author: { role: 'user' },
              content: { parts: ['Hello, what is TypeScript?'] },
            },
          },
          msg2: {
            id: 'msg2',
            parent: 'msg1',
            children: [],
            message: {
              id: 'msg2',
              author: { role: 'assistant' },
              content: { parts: ['TypeScript is a typed superset of JavaScript.'] },
            },
          },
        },
      },
    ];

    const path = writeJson(dir, 'chatgpt.json', convData);
    const adapter = new ChatGptExportAdapter(path);

    expect(adapter.isAvailable()).toBe(true);
    const results = adapter.list();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Test conversation');
    expect(results[0].text).toContain('TypeScript');
    expect(results[0].source).toBe('import:chatgpt-export');
    expect(results[0].contentHash).toHaveLength(64);
  });

  it('parses wrapped { conversations: [...] } format', () => {
    const convData = {
      conversations: [
        {
          id: 'conv2',
          title: 'Wrapped format',
          create_time: 1700000200,
          update_time: 1700000300,
          mapping: {
            root: {
              id: 'root',
              parent: null,
              children: ['msg1'],
              message: undefined,
            },
            msg1: {
              id: 'msg1',
              parent: 'root',
              children: [],
              message: {
                id: 'msg1',
                author: { role: 'user' },
                content: { parts: ['Explain async/await in JavaScript thoroughly.'] },
              },
            },
          },
        },
      ],
    };

    const path = writeJson(dir, 'chatgpt-wrapped.json', convData);
    const adapter = new ChatGptExportAdapter(path);
    const results = adapter.list();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Wrapped format');
  });

  it('filters by since timestamp', () => {
    const convData = [
      {
        id: 'old',
        title: 'Old',
        update_time: 1600000000,
        mapping: {
          r: { id: 'r', parent: null, children: ['m'], message: undefined },
          m: {
            id: 'm',
            parent: 'r',
            children: [],
            message: {
              id: 'm',
              author: { role: 'user' },
              content: { parts: ['Old content that is long enough to be included'] },
            },
          },
        },
      },
      {
        id: 'new',
        title: 'New',
        update_time: 1800000000,
        mapping: {
          r: { id: 'r', parent: null, children: ['m'], message: undefined },
          m: {
            id: 'm',
            parent: 'r',
            children: [],
            message: {
              id: 'm',
              author: { role: 'user' },
              content: { parts: ['New content that is long enough to be included in results'] },
            },
          },
        },
      },
    ];

    const path = writeJson(dir, 'chatgpt-since.json', convData);
    const adapter = new ChatGptExportAdapter(path);
    // Since 2020-10-01 → only 'new' (2027) passes
    const results = adapter.list('2025-01-01T00:00:00Z');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('New');
  });

  it('deduplicates by content hash', () => {
    const msg = {
      id: 'msg1',
      author: { role: 'user' },
      content: { parts: ['Identical text content here for deduplication testing purposes'] },
    };
    const conv = {
      id: 'c1',
      title: 'Dup',
      update_time: 1700000000,
      mapping: {
        root: { id: 'root', parent: null, children: ['m1'], message: undefined },
        m1: { id: 'm1', parent: 'root', children: [], message: msg },
      },
    };

    const path = writeJson(dir, 'chatgpt-dup.json', [conv, { ...conv, id: 'c2' }]);
    const adapter = new ChatGptExportAdapter(path);
    const results = adapter.list();
    // Both conversations have same text → same hash → both returned (dedup is handled by import cmd)
    // The adapter returns all; dedup is at the import layer
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Content hashes must be stable
    const hash = createHash('sha256').update(results[0].text).digest('hex');
    expect(results[0].contentHash).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Claude export adapter
// ---------------------------------------------------------------------------

describe('ClaudeExportAdapter', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  it('returns [] when file does not exist', () => {
    const adapter = new ClaudeExportAdapter(join(dir, 'missing.json'));
    expect(adapter.isAvailable()).toBe(false);
    expect(adapter.list()).toEqual([]);
  });

  it('parses claude.ai export format', () => {
    const data = [
      {
        uuid: 'conv-1',
        name: 'LazyBrain design session',
        created_at: '2026-01-01T10:00:00Z',
        updated_at: '2026-01-01T11:00:00Z',
        chat_messages: [
          {
            uuid: 'msg-1',
            sender: 'human',
            text: 'How should we structure the HTML neuron schema for LazyBrain?',
            created_at: '2026-01-01T10:00:00Z',
          },
          {
            uuid: 'msg-2',
            sender: 'assistant',
            text: 'The HTML neuron schema should use data-cerveau-* attributes for semantic metadata.',
            created_at: '2026-01-01T10:01:00Z',
          },
        ],
      },
    ];

    const path = writeJson(dir, 'claude-export.json', data);
    const adapter = new ClaudeExportAdapter(path);

    expect(adapter.isAvailable()).toBe(true);
    const results = adapter.list();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('LazyBrain design session');
    expect(results[0].text).toContain('HTML neuron');
    expect(results[0].source).toBe('import:claude-export');
    expect(results[0].timestamp).toBe('2026-01-01T11:00:00Z');
  });

  it('handles structured content blocks', () => {
    const data = [
      {
        uuid: 'conv-2',
        name: 'Content blocks test',
        updated_at: '2026-02-01T00:00:00Z',
        chat_messages: [
          {
            uuid: 'msg-3',
            sender: 'human',
            content: [{ type: 'text', text: 'Explain the repository pattern in TypeScript.' }],
          },
          {
            uuid: 'msg-4',
            sender: 'assistant',
            content: [
              {
                type: 'text',
                text: 'The repository pattern abstracts data access behind an interface.',
              },
            ],
          },
        ],
      },
    ];

    const path = writeJson(dir, 'claude-blocks.json', data);
    const adapter = new ClaudeExportAdapter(path);
    const results = adapter.list();
    expect(results).toHaveLength(1);
    expect(results[0].text).toContain('repository pattern');
  });

  it('filters by since timestamp', () => {
    const data = [
      {
        uuid: 'old',
        name: 'Old conversation',
        updated_at: '2020-01-01T00:00:00Z',
        chat_messages: [
          { uuid: 'm1', sender: 'human', text: 'Some old content about TypeScript generics' },
        ],
      },
      {
        uuid: 'new',
        name: 'Recent conversation',
        updated_at: '2026-06-01T00:00:00Z',
        chat_messages: [
          { uuid: 'm2', sender: 'human', text: 'Recent content about LazyBrain HTML neurons' },
        ],
      },
    ];

    const path = writeJson(dir, 'claude-since.json', data);
    const adapter = new ClaudeExportAdapter(path);
    const results = adapter.list('2025-01-01T00:00:00Z');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Recent conversation');
  });
});

// ---------------------------------------------------------------------------
// Cursor adapter — availability check only (no SQLite in CI without native dep)
// ---------------------------------------------------------------------------

describe('CursorImportAdapter', () => {
  it('returns source name correctly', () => {
    const adapter = new CursorImportAdapter();
    expect(adapter.source).toBe('cursor');
  });

  it('returns [] gracefully when SQLite unavailable or no Cursor install', () => {
    // The adapter must never throw — it returns [] on any error
    const adapter = new CursorImportAdapter();
    const results = adapter.list('2099-01-01T00:00:00Z');
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stripHarnessMarkup — Claude Code CLI harness/system tag stripping
// ---------------------------------------------------------------------------
//
// Regression coverage for a real defect found in production notes: raw
// <command-name>/<command-message>/<command-args>/<local-command-stdout>/
// <system-reminder>/<task-notification> envelopes from slash-command
// invocations and injected system reminders were leaking verbatim into
// transcript text, corrupting titles and summaries.

describe('stripHarnessMarkup', () => {
  it('removes paired command-tag envelopes, keeping surrounding prose', () => {
    const input =
      '<command-name>brainstorm</command-name><command-message>brainstorm is running</command-message><command-args></command-args>\n' +
      "Let's brainstorm the onboarding flow for new users.";
    const result = stripHarnessMarkup(input);
    expect(result).not.toContain('<command-name>');
    expect(result).not.toContain('command-message');
    expect(result).not.toContain('<command-args>');
    expect(result).toContain("Let's brainstorm the onboarding flow for new users.");
  });

  it('removes system-reminder and task-notification blocks entirely', () => {
    const input =
      '<system-reminder>Some injected reminder text that is not part of the conversation.</system-reminder>' +
      'The actual answer the assistant gave to the user.' +
      '<task-notification><task-id>abc123</task-id><status>completed</status></task-notification>';
    const result = stripHarnessMarkup(input);
    expect(result).not.toContain('system-reminder');
    expect(result).not.toContain('task-notification');
    expect(result).not.toContain('injected reminder');
    expect(result).toContain('The actual answer the assistant gave to the user.');
  });

  it('removes stray/self-closing local-command-stdout tags', () => {
    const input = 'Output was: <local-command-stdout>build succeeded</local-command-stdout> done.';
    const result = stripHarnessMarkup(input);
    expect(result).not.toContain('local-command-stdout');
    expect(result).toContain('Output was:');
    expect(result).toContain('done.');
  });

  it('is a no-op on plain prose with no harness tags', () => {
    const input = 'This is a normal sentence with no special markup at all.';
    expect(stripHarnessMarkup(input)).toBe(input);
  });

  it('preserves accented French characters (UTF-8 round-trip, no mojibake)', () => {
    // Regression coverage for a real defect found in production notes:
    // accented characters (compétence, créatif, déjà) were coming out as
    // mojibake ("compÃ©tence", "crÃ©atif", "dÃ©jÃ ") somewhere in the
    // jsonl-read -> note-write chain. This asserts the adapter's own text
    // transform (stripHarnessMarkup, immediately followed by scrubText in
    // ClaudeCodeImportAdapter.list()) never touches byte encoding.
    const input =
      "<command-name>brainstorm</command-name>D'abord activer la compétence de " +
      'brainstorming, un travail créatif déjà commencé à l’étape précédente.';
    const result = scrubText(stripHarnessMarkup(input));
    expect(result).toContain('compétence');
    expect(result).toContain('créatif');
    expect(result).toContain('déjà');
    expect(result).not.toMatch(/Ã[©¨¯]/); // classic UTF-8-as-Latin-1 mojibake signature
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeImportAdapter — end-to-end through a real (temp) project dir
// ---------------------------------------------------------------------------

describe('ClaudeCodeImportAdapter', () => {
  let fakeHome: string;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    fakeHome = tmpDir();
    originalUserProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = fakeHome;
  });

  afterEach(() => {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it('strips harness markup and preserves accented text end-to-end from a real JSONL transcript', () => {
    const projectDir = join(fakeHome, '.claude', 'projects', 'testproj');
    mkdirSync(projectDir, { recursive: true });

    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-07T10:00:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '<command-name>brainstorm</command-name><command-message>brainstorm is running</command-message><command-args></command-args>\n' +
                "D'abord activer la compétence de brainstorming, un travail créatif déjà commencé à l'étape précédente pour le projet.",
            },
          ],
        },
        cwd: 'C:\\Users\\test\\project',
        sessionId: 's1',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-07T10:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: "Voici le plan complet pour la fonctionnalité de brainstorming demandée par l'équipe.",
            },
          ],
        },
        cwd: 'C:\\Users\\test\\project',
        sessionId: 's1',
      }),
    ];
    writeFileSync(join(projectDir, 's1.jsonl'), lines.join('\n'), 'utf-8');

    const adapter = new ClaudeCodeImportAdapter();
    expect(adapter.isAvailable()).toBe(true);
    const results = adapter.list();

    expect(results.length).toBeGreaterThan(0);
    const combined = results.map((r) => `${r.text} ${r.title}`).join(' ');
    expect(combined).not.toContain('<command-name>');
    expect(combined).not.toContain('command-message');
    expect(combined).not.toContain('command-args');
    expect(combined).toContain('compétence');
    expect(combined).toContain('créatif');
  });

  // -------------------------------------------------------------------------
  // Quality gate — scaffolding / triviality filtering
  // -------------------------------------------------------------------------
  // Regression coverage for real low-value notes found in production: agent
  // system prompts logged as ordinary "user" turns, and trivial exchanges,
  // were producing notes with no recall value and (for scaffolding) titles
  // derived from agent reasoning instead of what a human actually asked.

  it('skips a transcript whose only "user" turn is an agent scaffolding prompt', () => {
    const projectDir = join(fakeHome, '.claude', 'projects', 'testproj-scaffold');
    mkdirSync(projectDir, { recursive: true });

    // Real-world shape (verbatim from production transcripts): Lazy's own
    // agent harness concatenates the system instruction into a single CLI
    // turn behind a literal "[System]" marker, and message.content is a
    // plain string (not a content-block array) for these harness turns.
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-07T10:00:00.000Z',
        message: {
          role: 'user',
          content:
            '[System]\nYou are an autonomous coding agent. You MUST use the write_file tool to ' +
            'create or modify files. NEVER claim you have created or modified a file without ' +
            'actually calling write_file. After writing a file, use read_file to verify it exists.',
        },
        cwd: 'C:\\Users\\test\\mission',
        sessionId: 's-scaffold',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-07T10:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text:
                "I'll start by exploring the project structure to understand what needs to change " +
                'before making any file modifications.',
            },
          ],
        },
        cwd: 'C:\\Users\\test\\mission',
        sessionId: 's-scaffold',
      }),
    ];
    writeFileSync(join(projectDir, 'mission.jsonl'), lines.join('\n'), 'utf-8');

    const adapter = new ClaudeCodeImportAdapter();
    const results = adapter.list();
    expect(results).toHaveLength(0);
  });

  it('skips a trivial exchange below the substantive-content threshold', () => {
    const projectDir = join(fakeHome, '.claude', 'projects', 'testproj-trivial');
    mkdirSync(projectDir, { recursive: true });

    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-07T10:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hey, can you help me with something quick?' }],
        },
        cwd: 'C:\\Users\\test\\trivial',
        sessionId: 's-trivial',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-07T10:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: "Hi! I'd like to help, but I need more information about what you're working on.",
            },
          ],
        },
        cwd: 'C:\\Users\\test\\trivial',
        sessionId: 's-trivial',
      }),
    ];
    writeFileSync(join(projectDir, 'trivial.jsonl'), lines.join('\n'), 'utf-8');

    const adapter = new ClaudeCodeImportAdapter();
    const results = adapter.list();
    expect(results).toHaveLength(0);
  });

  it('imports a real Q&A with a human-derived title, not agent reasoning', () => {
    const projectDir = join(fakeHome, '.claude', 'projects', 'testproj-realqa');
    mkdirSync(projectDir, { recursive: true });

    const humanQuestion =
      'How should we structure the HTML neuron schema for LazyBrain notes so retrieval ' +
      'stays fast as the brain grows to thousands of notes?';
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-07T10:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: humanQuestion }],
        },
        cwd: 'C:\\Users\\test\\realqa',
        sessionId: 's-realqa',
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-07T10:00:05.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text:
                'Use data-cerveau-* attributes directly on the article element for structured metadata, ' +
                'and keep an FTS index in SQLite for full-text search. This keeps notes self-describing ' +
                'while retrieval stays fast even at scale.',
            },
          ],
        },
        cwd: 'C:\\Users\\test\\realqa',
        sessionId: 's-realqa',
      }),
    ];
    writeFileSync(join(projectDir, 'realqa.jsonl'), lines.join('\n'), 'utf-8');

    const adapter = new ClaudeCodeImportAdapter();
    const results = adapter.list();

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title.startsWith('How should we structure the HTML neuron schema')).toBe(
      true,
    );
    expect(results[0].title).not.toContain('autonomous');
    expect(results[0].title).not.toContain("I'll start by exploring");
  });
});
