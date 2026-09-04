/**
 * dream-conversation-indexing.test.ts
 *
 * Regression test for the root-cause bug found in the disk-vs-index drift
 * audit: dream.ts's processConversationBatch() wrote notes to disk via
 * writeNote() but never called indexNote() — every dream-ingested note
 * (data-cerveau-source="session:dream-*") was invisible to the SQLite index
 * (FTS + structural queries) until an unrelated `index-rebuild` happened to
 * sweep it up. Fixed alongside this test: indexNote() is now called
 * synchronously right after writeNote() for every note dream.ts writes.
 *
 * Fixture setup mirrors tests/dream-parallel.test.ts (fake ~/.claude/projects
 * conversation source).
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../src/util/config.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'dream-index-test-'));
}

function makeConversationJsonl(index: number): string {
  const userMsg = {
    type: 'user',
    message: {
      role: 'user',
      content: `We decided to use PostgreSQL for project ${index} because it has better JSONB support and full-text search capabilities compared to MySQL. This is an important architectural decision.`,
    },
  };
  const assistantMsg = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: `Agreed. PostgreSQL's JSONB indexing, full-text search, and window functions make it the right choice for project ${index}. We should use it consistently across all services.`,
    },
  };
  return `${JSON.stringify(userMsg)}\n${JSON.stringify(assistantMsg)}\n`;
}

function collectNoteFiles(brainPath: string): string[] {
  const notesDir = join(brainPath, 'notes');
  const results: string[] = [];
  function walk(dir: string): void {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.html')) results.push(full);
    }
  }
  walk(notesDir);
  return results;
}

let tmpRoot: string;
let fakeHome: string;
let brainPath: string;
let projectDir: string;

const FIXTURE_COUNT = 5;

beforeEach(() => {
  resetConfigForTests();

  tmpRoot = makeTmpDir();
  fakeHome = join(tmpRoot, 'home');
  brainPath = join(tmpRoot, 'brain');

  mkdirSync(join(brainPath, 'notes'), { recursive: true });
  mkdirSync(join(brainPath, '_cache'), { recursive: true });
  mkdirSync(join(brainPath, 'meta'), { recursive: true });
  mkdirSync(join(brainPath, 'knowledge-nodes'), { recursive: true });

  const configDir = join(tmpRoot, '.lazybrain');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, '.lazybrain-config.json'),
    JSON.stringify({ version: '1.0.0', brainPath, createdAt: new Date().toISOString() }),
    'utf-8',
  );

  const claudeProjectsDir = join(fakeHome, '.claude', 'projects');
  projectDir = join(claudeProjectsDir, 'C--Users-johndoe-Projects-testproject');
  mkdirSync(projectDir, { recursive: true });

  for (let i = 0; i < FIXTURE_COUNT; i++) {
    writeFileSync(join(projectDir, `conv-${i}.jsonl`), makeConversationJsonl(i), 'utf-8');
  }

  process.env.LAZYBRAIN_BRAIN_PATH = brainPath;
  process.env.LAZYBRAIN_CACHE_PATH = join(brainPath, '_cache');
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  const { closeDb } = await import('../src/indexer/fts.js');
  closeDb();
  resetConfigForTests();
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  process.env.USERPROFILE = process.env._ORIG_USERPROFILE ?? '';
  process.env.HOME = process.env._ORIG_HOME ?? '';
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows file-lock cleanup best-effort, same as dream-parallel.test.ts
  }
});

describe('dream conversation ingestion — every written note is indexed', () => {
  it('every note dream.ts writes to disk also lands in the SQLite notes table', async () => {
    const { runDream } = await import('../src/commands/dream.js');
    await runDream({ force: true, dryRun: false });

    const diskNotes = collectNoteFiles(brainPath);
    expect(diskNotes.length).toBeGreaterThan(0);

    const { countAllNotes } = await import('../src/indexer/fts.js');
    expect(countAllNotes()).toBe(diskNotes.length);
  });

  it('a structural query over data-cerveau-source finds a dream-ingested note via the fast (indexed) path', async () => {
    const { runDream } = await import('../src/commands/dream.js');
    await runDream({ force: true, dryRun: false });

    const { listAll } = await import('../src/indexer/fts.js');
    const dreamNotes = listAll({ includeExpired: true }).filter((n) =>
      (n.source ?? '').startsWith('session:dream-'),
    );
    expect(dreamNotes.length).toBeGreaterThan(0);
  });
});
