/**
 * E1 — Multi-word FTS OR-fallback tests.
 *
 * Populates a real temp-dir brain with notes that each contain only one of
 * two distinct terms. A 2-token AND query returns 0 hits under FTS5 AND
 * semantics. After the fix, the OR-fallback returns both notes with halved
 * scores and deterministic ordering.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, indexNote, searchFts } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

let brainDir: string;

function setupNote(id: string, body: string): void {
  const html = `<article id="${id}" data-cerveau-type="reference"><h2>${id}</h2><p>${body}</p></article>`;
  const notesDir = join(brainDir, 'notes');
  writeFileSync(join(notesDir, `${id}.html`), html, 'utf8');
  indexNote({
    id,
    path: join(notesDir, `${id}.html`),
    html,
    sizeBytes: html.length,
    mtimeMs: Date.now(),
  });
}

describe('E1 — searchFts OR-fallback', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'lb-fts-'));
    mkdirSync(join(brainDir, 'notes'), { recursive: true });
    mkdirSync(join(brainDir, '_cache'), { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');
    resetConfigForTests();

    // Two notes: each contains only one of the two query tokens
    setupNote('note-alpha', 'The alpha token appears here exclusively and nowhere else');
    setupNote('note-omega', 'The omega token appears here exclusively and nowhere else');
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('2-token AND query with no single note matching returns both notes via OR fallback', () => {
    const hits = searchFts('alpha omega');
    const ids = hits.map((h) => h.id).sort();
    expect(ids).toContain('note-alpha');
    expect(ids).toContain('note-omega');
  });

  it('fallback hits have halved BM25 scores (≤ 50% of their direct single-term scores)', () => {
    const directAlpha = searchFts('alpha');
    const directOmega = searchFts('omega');
    const fallback = searchFts('alpha omega');

    const directAlphaScore = directAlpha.find((h) => h.id === 'note-alpha')?.bm25;
    const directOmegaScore = directOmega.find((h) => h.id === 'note-omega')?.bm25;
    const fallbackAlphaScore = fallback.find((h) => h.id === 'note-alpha')?.bm25;
    const fallbackOmegaScore = fallback.find((h) => h.id === 'note-omega')?.bm25;

    expect(directAlphaScore).toBeDefined();
    expect(directOmegaScore).toBeDefined();
    expect(fallbackAlphaScore).toBeDefined();
    expect(fallbackOmegaScore).toBeDefined();

    // OR-fallback scores must be scaled by 0.5
    if (directAlphaScore && fallbackAlphaScore) {
      expect(fallbackAlphaScore).toBeCloseTo(directAlphaScore * 0.5, 1);
    }
    if (directOmegaScore && fallbackOmegaScore) {
      expect(fallbackOmegaScore).toBeCloseTo(directOmegaScore * 0.5, 1);
    }
  });

  it('a query with a genuine AND match does NOT trigger fallback (full score preserved)', () => {
    // This note has both terms — AND query should succeed directly, no fallback.
    setupNote('note-both', 'The alpha and omega tokens both appear here together');

    const hits = searchFts('alpha omega');
    const bothHit = hits.find((h) => h.id === 'note-both');
    expect(bothHit).toBeDefined();
    // The AND-matched note is ranked first (highest score)
    expect(hits[0].id).toBe('note-both');
    // Its score is NOT halved — should be strictly higher than fallback scores
    const fallbackAlpha = hits.find((h) => h.id === 'note-alpha');
    if (bothHit && fallbackAlpha) {
      expect(bothHit.bm25).toBeGreaterThan(fallbackAlpha.bm25);
    }
  });

  it('single-token query is unaffected — no score halving', () => {
    const hits = searchFts('alpha');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const alphaHit = hits.find((h) => h.id === 'note-alpha');
    expect(alphaHit).toBeDefined();
    // Single-token: BM25 should be positive and consistent with direct search
    if (alphaHit) expect(alphaHit.bm25).toBeGreaterThan(0);
    // Omega note should NOT appear in a single-token 'alpha' search
    expect(hits.find((h) => h.id === 'note-omega')).toBeUndefined();
  });

  it('quoted-phrase query is not decomposed into OR fallback', () => {
    // '"alpha omega"' as an exact phrase — no note has both adjacent,
    // so result must be empty (not OR-expanded).
    const hits = searchFts('"alpha omega"');
    expect(hits.length).toBe(0);
  });

  it('results are ordered descending by bm25 score (deterministic)', () => {
    const hits = searchFts('alpha omega');
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].bm25).toBeGreaterThanOrEqual(hits[i].bm25);
    }
  });
});
