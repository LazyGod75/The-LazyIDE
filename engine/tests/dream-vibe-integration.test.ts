import { cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDream } from '../src/commands/dream.js';
import { closeDb } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

describe('dream --agent vibe (integration over fixtures)', () => {
  let brain: string;
  let vibeHome: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    brain = mkdtempSync(join(tmpdir(), 'lb-brain-'));
    vibeHome = mkdtempSync(join(tmpdir(), 'lb-vh-'));
    cpSync(join(__dirname, 'fixtures', 'vibe'), vibeHome, { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brain;
    // Keep cache inside the brain temp dir so fingerprints never bleed across
    // test runs even though all mkdtemp dirs share the same parent (tmpdir()).
    process.env.LAZYBRAIN_CACHE_PATH = join(brain, '_cache');
    process.env.VIBE_HOME = vibeHome;
    resetConfigForTests();
  });

  afterEach(() => {
    // Close the FTS SQLite singleton so the next test gets a fresh handle
    // pointed at the correct cache path.
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('creates vibe notes with provenance and compaction lineage', async () => {
    const report = await runDream({ agent: 'vibe', maxNotes: 0 });
    expect(report.conversationsProcessed).toBeGreaterThanOrEqual(3);

    const notesRoot = join(brain, 'notes');
    const allHtml: string[] = [];
    for (const month of readdirSync(notesRoot)) {
      for (const f of readdirSync(join(notesRoot, month))) {
        allHtml.push(readFileSync(join(notesRoot, month, f), 'utf8'));
      }
    }
    const joined = allHtml.join('\n');
    expect(joined).toContain('data-cerveau-agent="vibe"');
    expect(joined).toContain('data-cerveau-source-kind="plan"');
    expect(joined).toContain('data-cerveau-source-kind="compaction-summary"');
    expect(joined).toContain('data-cerveau-session-parent="a1b2c3d4e5f60718293a4b5c6d7e8f90"');
    expect(joined).toContain('data-cerveau-git-commit="deadbeef12345678"');
  }, 30_000);

  it('is incremental: second run skips everything', async () => {
    await runDream({ agent: 'vibe', maxNotes: 0 });
    // Reset config so the second call re-reads env (not strictly needed since
    // env is unchanged, but mirrors the pattern in dream-parallel.test.ts).
    resetConfigForTests();
    const second = await runDream({ agent: 'vibe', maxNotes: 0 });
    expect(second.conversationsProcessed).toBe(0);
    expect(second.conversationsSkipped).toBeGreaterThanOrEqual(3);
  }, 30_000);
});
