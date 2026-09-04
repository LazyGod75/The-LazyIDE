/**
 * Integration test: the app write path (`store`) runs contradiction detection.
 *
 * The desktop app writes every in-editor neuron via `lazybrain store` (never
 * `capture`), so this is where contradiction detection has to fire. We store a
 * "use Postgres" decision, then a contradicting "switch to SQLite, no more
 * Postgres" decision, and assert BOTH notes end up cross-linked with
 * data-cerveau-conflict-with + the "contradiction" saliency marker, and that
 * the DB reflects it (conflict_with / saliency_kind columns).
 *
 * Uses a REAL temp brain + SQLite DB (no fts mock) to exercise the full
 * store -> detectContradictions -> annotate -> index pipeline.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const NOTE_POSTGRES = `<article id="2026-07-04-decision-db-postgres"
  data-cerveau-version="1"
  data-cerveau-created="2026-07-04T10:00:00Z"
  data-cerveau-source="session:store:contradiction-test"
  data-cerveau-type="decision"
  data-cerveau-tags="database decision backend">
  <h1>Decision: database</h1>
  <p data-cerveau-fact="1">Decision: on utilise Postgres pour la base</p>
</article>`;

const NOTE_SQLITE = `<article id="2026-07-04-decision-db-sqlite"
  data-cerveau-version="1"
  data-cerveau-created="2026-07-04T11:00:00Z"
  data-cerveau-source="session:store:contradiction-test"
  data-cerveau-type="decision"
  data-cerveau-tags="database decision backend">
  <h1>Decision: database (update)</h1>
  <p data-cerveau-fact="1">Decision: finalement on passe sur SQLite, plus de Postgres</p>
</article>`;

let tmpDir: string;
let brainDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-store-contra-'));
  brainDir = join(tmpDir, 'brain');
  mkdirSync(join(brainDir, 'notes'), { recursive: true });
  mkdirSync(join(brainDir, '_cache'), { recursive: true });

  process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
  process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');
  process.env.LAZYBRAIN_TELEMETRY = '0';

  const { resetConfigForTests } = await import('../../util/config.js');
  resetConfigForTests();
  // Drop any DB connection a previous test opened against a different brain
  // so the next getDb() reopens against this test's temp brain.
  const { closeDb } = await import('../../indexer/fts.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../indexer/fts.js');
  closeDb();
  const { resetConfigForTests } = await import('../../util/config.js');
  resetConfigForTests();
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  delete process.env.LAZYBRAIN_TELEMETRY;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe('store path — contradiction detection', () => {
  it('cross-links a new decision that contradicts an existing one', async () => {
    const { runStore } = await import('../store.js');

    const first = JSON.parse(await runStore({ html: NOTE_POSTGRES })) as { id: string; path: string };
    const second = JSON.parse(await runStore({ html: NOTE_SQLITE })) as { id: string; path: string };

    // New note (SQLite) points at the note it contradicts (Postgres) and is
    // stamped with the contradiction saliency marker.
    const secondHtml = readFileSync(second.path, 'utf8');
    expect(secondHtml).toContain(`data-cerveau-conflict-with="${first.id}"`);
    expect(secondHtml).toContain('data-cerveau-saliency-kind="contradiction"');

    // Old note (Postgres) is back-annotated so the contradiction is visible
    // from BOTH sides (whichever note the wiki opens).
    const firstHtml = readFileSync(first.path, 'utf8');
    expect(firstHtml).toContain(`data-cerveau-conflict-with="${second.id}"`);
    expect(firstHtml).toContain('data-cerveau-saliency-kind="contradiction"');

    // The DB index reflects the signal on the new note (this is what the
    // /_api/note-meta route reads and serializes to the frontend).
    const { getNoteById } = await import('../../indexer/fts.js');
    const indexed = getNoteById(second.id);
    expect(indexed?.conflict_with).toContain(first.id);
    expect(indexed?.saliency_kind).toBe('contradiction');
  });

  it('does not flag a note that contradicts nothing', async () => {
    const { runStore } = await import('../store.js');

    const only = JSON.parse(await runStore({ html: NOTE_POSTGRES })) as { id: string; path: string };
    const html = readFileSync(only.path, 'utf8');
    expect(html).not.toContain('data-cerveau-conflict-with');

    const { getNoteById } = await import('../../indexer/fts.js');
    const indexed = getNoteById(only.id);
    expect(indexed?.conflict_with == null || indexed?.conflict_with === '').toBe(true);
  });
});
