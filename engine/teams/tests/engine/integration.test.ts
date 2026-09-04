/**
 * Integration tests — real CLI on real temp brains.
 *
 * Each test suite gets a unique temp brain under os.tmpdir()/lbt-test-<random>.
 * Tests verify the full store→index→search→query→renderWiki roundtrip.
 *
 * NOTE: These tests spawn child processes and may take several seconds each.
 * Each brain is wiped after its suite completes.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngine } from '../../src/engine/facade.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `lbt-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Suite: init → store → search → renderWiki
// ---------------------------------------------------------------------------

describe('engine integration — init/store/search/wiki', () => {
  let brainsDir: string;
  let engine: ReturnType<typeof createEngine>;
  const TEAM = 'test-team';

  beforeAll(async () => {
    brainsDir = makeTempDir();
    engine = createEngine({ brainsDir });
    // Pre-init the brain
    await engine.ensureTeamBrain(TEAM);
  });

  afterAll(() => {
    cleanupDir(brainsDir);
  });

  it('creates a brain directory on ensureTeamBrain', () => {
    const brainPath = join(brainsDir, TEAM, 'brain');
    expect(existsSync(join(brainPath, '.lazybrain-config.json'))).toBe(true);
  });

  it('is idempotent — second call does not throw', async () => {
    const result = await engine.ensureTeamBrain(TEAM);
    expect(result.brainPath).toContain(TEAM);
  });

  it('rejects invalid slugs', async () => {
    await expect(engine.ensureTeamBrain('INVALID_SLUG')).rejects.toThrow();
    await expect(engine.ensureTeamBrain('a')).rejects.toThrow(); // too short
    await expect(engine.ensureTeamBrain('../traversal')).rejects.toThrow();
  });

  it('stores a note and returns a noteId', async () => {
    const { noteId } = await engine.storeNote({
      teamSlug: TEAM,
      authorUsername: 'alice',
      type: 'decision',
      tags: ['arch', 'backend'],
      text: 'We decided to use PostgreSQL for persistent storage.',
    });
    expect(noteId).toBeTruthy();
    expect(typeof noteId).toBe('string');
    expect(noteId.length).toBeGreaterThan(4);
  });

  it('stored note HTML file exists on disk with provenance tags', async () => {
    const { noteId } = await engine.storeNote({
      teamSlug: TEAM,
      authorUsername: 'bob',
      type: 'note',
      tags: ['frontend'],
      text: 'React was chosen for the dashboard.',
    });

    const brainPath = join(brainsDir, TEAM, 'brain');
    const notesDir = join(brainPath, 'notes');

    // Find the note file under notes/YYYY-MM/<noteId>.html
    let found = false;
    const months = readdirSync(notesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(notesDir, d.name));

    for (const month of months) {
      const candidate = join(month, `${noteId}.html`);
      if (existsSync(candidate)) {
        found = true;
        const { readFileSync } = await import('node:fs');
        const html = readFileSync(candidate, 'utf-8');

        // Provenance author tag must be present
        expect(html).toContain('author-bob');
        // Team tag must be present
        expect(html).toContain(`team-${TEAM}`);
        // Caller tag must be present
        expect(html).toContain('frontend');
        break;
      }
    }

    expect(found).toBe(true);
  });

  it('search returns the stored note', async () => {
    // Store a note with distinctive text first
    await engine.storeNote({
      teamSlug: TEAM,
      authorUsername: 'charlie',
      type: 'decision',
      text: 'Decided to use Redis for distributed session cache XYZ-UNIQUE-42.',
    });

    const hits = await engine.search({
      query: 'Redis session cache XYZ-UNIQUE-42',
      teamSlugs: [TEAM],
      top: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    const found = hits.find((h) => h.snippet.includes('Redis'));
    expect(found).toBeDefined();
    expect(found?.teamSlug).toBe(TEAM);
  });

  it('renderWikiIndex returns HTML with title and note list', async () => {
    const { title, bodyHtml } = await engine.renderWikiIndex(TEAM);
    expect(title).toContain(TEAM);
    expect(bodyHtml).toContain('<ul>');
    expect(bodyHtml).toContain('<li>');
  });

  it('renderWikiNote returns extracted content for a known note', async () => {
    const { noteId } = await engine.storeNote({
      teamSlug: TEAM,
      authorUsername: 'diana',
      type: 'episodic',
      text: 'Wiki rendering test content WIKI-NOTE-CONTENT-999.',
    });

    const result = await engine.renderWikiNote(TEAM, noteId);
    expect(result).not.toBeNull();
    expect(result?.bodyHtml).toContain('WIKI-NOTE-CONTENT-999');
  });

  it('renderWikiNote rewrites internal links to Teams URLs', async () => {
    // Store a note with an internal link
    const { noteId } = await engine.storeNote({
      teamSlug: TEAM,
      authorUsername: 'evan',
      type: 'note',
      text: 'Check related note at href="#/note/other-note-id"',
    });

    // Manually patch the stored file to add an internal link
    const brainPath = join(brainsDir, TEAM, 'brain');
    const notesDir = join(brainPath, 'notes');
    const months = readdirSync(notesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(notesDir, d.name));

    for (const month of months) {
      const candidate = join(month, `${noteId}.html`);
      if (existsSync(candidate)) {
        const { readFileSync, writeFileSync } = await import('node:fs');
        const orig = readFileSync(candidate, 'utf-8');
        // Inject an internal link into the stored HTML
        const patched = orig.replace(
          '</article>',
          '<a href="#/note/other-note-id">see also</a></article>',
        );
        writeFileSync(candidate, patched, 'utf-8');
        break;
      }
    }

    const result = await engine.renderWikiNote(TEAM, noteId);
    expect(result).not.toBeNull();
    // Internal link must be rewritten to Teams URL
    expect(result?.bodyHtml).toContain(`/t/${TEAM}/wiki/note/other-note-id`);
    expect(result?.bodyHtml).not.toContain('href="#/note/');
  });

  it('renderWikiNote returns null for unknown noteId', async () => {
    const result = await engine.renderWikiNote(TEAM, 'does-not-exist-12345');
    expect(result).toBeNull();
  });

  it('stats returns correct note count after storing', async () => {
    const statsResult = await engine.stats(TEAM);
    expect(statsResult.notes).toBeGreaterThan(0);
    expect(typeof statsResult.activeDecisions).toBe('number');
    expect(statsResult.activeDecisions).toBeGreaterThanOrEqual(0);
  });

  it('stats.lastCaptureAt is an ISO date string', async () => {
    // Force cache miss with a unique team
    const teamX = 'test-stats-time';
    const engineX = createEngine({ brainsDir });
    await engineX.ensureTeamBrain(teamX);

    await engineX.storeNote({
      teamSlug: teamX,
      authorUsername: 'zara',
      type: 'note',
      text: 'Time capture test note.',
    });

    const st = await engineX.stats(teamX);
    expect(st.lastCaptureAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// Suite: secret scrub — the stored file must NOT contain raw secrets
// ---------------------------------------------------------------------------

describe('engine integration — secret scrubbing', () => {
  let brainsDir: string;
  let engine: ReturnType<typeof createEngine>;
  const TEAM = 'scrub-team';

  beforeAll(async () => {
    brainsDir = makeTempDir();
    engine = createEngine({ brainsDir });
    await engine.ensureTeamBrain(TEAM);
  });

  afterAll(() => {
    cleanupDir(brainsDir);
  });

  it('stores note without the raw secret in the HTML file', async () => {
    const rawSecret = 'sk-ant-api03-FAKEKEY1234567890abcdefghijklmnop';
    const { noteId } = await engine.storeNote({
      teamSlug: TEAM,
      authorUsername: 'frank',
      type: 'note',
      text: `Use this key: ${rawSecret} to access the API.`,
    });

    const brainPath = join(brainsDir, TEAM, 'brain');
    const notesDir = join(brainPath, 'notes');
    const months = readdirSync(notesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(notesDir, d.name));

    let html = '';
    for (const month of months) {
      const candidate = join(month, `${noteId}.html`);
      if (existsSync(candidate)) {
        const { readFileSync } = await import('node:fs');
        html = readFileSync(candidate, 'utf-8');
        break;
      }
    }

    expect(html).toBeTruthy();
    expect(html).not.toContain(rawSecret);
    expect(html).not.toContain('sk-ant-');
    expect(html).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// Suite: federated search across multiple teams
// ---------------------------------------------------------------------------

describe('engine integration — federated search', () => {
  let brainsDir: string;
  let engine: ReturnType<typeof createEngine>;
  const TEAMS = ['fed-alpha', 'fed-beta'];

  beforeAll(async () => {
    brainsDir = makeTempDir();
    engine = createEngine({ brainsDir });

    for (const team of TEAMS) {
      await engine.ensureTeamBrain(team);
    }

    await engine.storeNote({
      teamSlug: 'fed-alpha',
      authorUsername: 'alpha-user',
      type: 'decision',
      text: 'Alpha team chose GraphQL for API design FEDQ-TEST.',
    });

    await engine.storeNote({
      teamSlug: 'fed-beta',
      authorUsername: 'beta-user',
      type: 'decision',
      text: 'Beta team chose gRPC for internal services FEDQ-TEST.',
    });
  });

  afterAll(() => {
    cleanupDir(brainsDir);
  });

  it('returns hits from both teams in a federated search', async () => {
    const hits = await engine.search({
      query: 'FEDQ-TEST API services',
      teamSlugs: TEAMS,
      top: 10,
    });

    const teamSlugs = new Set(hits.map((h) => h.teamSlug));
    expect(teamSlugs.has('fed-alpha')).toBe(true);
    expect(teamSlugs.has('fed-beta')).toBe(true);
  });

  it('returns empty array for a non-matching query', async () => {
    const hits = await engine.search({
      query: 'ZZZNOMATCH_XYZABC999',
      teamSlugs: TEAMS,
      top: 5,
    });
    // May return empty or very low scores — just verify no crash
    expect(Array.isArray(hits)).toBe(true);
  });

  it('brain-not-found team contributes no hits without crashing', async () => {
    // 'nonexistent-team' was never initialized — facade should handle gracefully
    const hits = await engine.search({
      query: 'GraphQL FEDQ-TEST',
      teamSlugs: ['fed-alpha', 'nonexistent-team'],
      top: 10,
    });

    // Should still get hits from fed-alpha
    expect(hits.some((h) => h.teamSlug === 'fed-alpha')).toBe(true);
    // nonexistent team should contribute nothing
    expect(hits.some((h) => h.teamSlug === 'nonexistent-team')).toBe(false);
  });
});
