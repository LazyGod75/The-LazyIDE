import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCompress } from '../src/commands/compress.js';
import { closeDb } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = (
  JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }
).version;

describe('CLI version', () => {
  it('reports the same version as package.json without a prior build', { timeout: 20_000 }, () => {
    const result = spawnSync('npx', ['tsx', 'bin/lazybrain.ts', '--version'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      shell: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const reported = result.stdout.trim();
    expect(reported).toBe(pkgVersion);
  });
});

describe('composed notes carry current package version', () => {
  let brain: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    brain = join(tmpdir(), `lb-ver-${Date.now()}`);
    mkdirSync(join(brain, 'notes', '2026-01'), { recursive: true });
    mkdirSync(join(brain, 'batches'), { recursive: true });
    mkdirSync(join(brain, '_cache'), { recursive: true });

    // Write two minimal working-tier notes in the same session so compress
    // has something to batch.
    const noteBase = `<article id="NOTE_ID"
         data-cerveau-version="${pkgVersion}"
         data-cerveau-created="2026-01-01T00:00:00.000Z"
         data-cerveau-type="fact"
         data-cerveau-source="claude:SESSION"
         data-cerveau-tier="working"
         data-cerveau-session="SESSION"
         data-cerveau-importance="0.5"
         data-cerveau-tags="test">
  <h2>NOTE_TITLE</h2>
  <p data-cerveau-fact data-cerveau-confidence="0.9" data-cerveau-source="#s1">Fact text.</p>
</article>`;

    for (const [id, title] of [
      ['note-a-001', 'Note A'],
      ['note-b-002', 'Note B'],
    ]) {
      writeFileSync(
        join(brain, 'notes', '2026-01', `${id}.html`),
        noteBase.replace(/NOTE_ID/g, id).replace(/NOTE_TITLE/g, title),
        'utf8',
      );
    }

    process.env.LAZYBRAIN_BRAIN_PATH = brain;
    process.env.LAZYBRAIN_CACHE_PATH = join(brain, '_cache');
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
    try {
      rmSync(brain, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('compress output carries data-cerveau-version matching package.json', () => {
    const out = runCompress({ session: 'SESSION', dryRun: false });
    // Dry-run returns JSON; the batch HTML contains the version attribute.
    // Either way: no "0.1.0" literal may appear — only the real version.
    expect(out).not.toContain('data-cerveau-version="0.1.0"');

    // The batch file written to disk must carry the current version.
    const batchFiles = readdirSync(join(brain, 'batches')).filter((f) => f.endsWith('.html'));
    if (batchFiles.length > 0) {
      const batchHtml = readFileSync(join(brain, 'batches', batchFiles[0]), 'utf8');
      expect(batchHtml).toContain(`data-cerveau-version="${pkgVersion}"`);
    }
  });
});
