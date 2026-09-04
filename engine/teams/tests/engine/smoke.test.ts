/**
 * Final smoke test — create a brain, store 2 notes, search, render one.
 * Pastes real CLI output for the final verification transcript.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngine } from '../../src/engine/facade.js';

const brainsDir = join(tmpdir(), `lbt-smoke-${randomUUID().slice(0, 8)}`);
mkdirSync(brainsDir, { recursive: true });

const engine = createEngine({ brainsDir });
const TEAM = 'smoke-team';

let note1Id: string;
let note2Id: string;

beforeAll(async () => {
  await engine.ensureTeamBrain(TEAM);

  const r1 = await engine.storeNote({
    teamSlug: TEAM,
    authorUsername: 'alice',
    type: 'decision',
    tags: ['arch'],
    text: 'We chose TypeScript for all new services.',
  });
  note1Id = r1.noteId;

  const r2 = await engine.storeNote({
    teamSlug: TEAM,
    authorUsername: 'bob',
    type: 'episodic',
    text: 'Deployed the API gateway with zero downtime.',
  });
  note2Id = r2.noteId;
});

afterAll(async () => {
  await engine.shutdown();
  try {
    if (existsSync(brainsDir)) rmSync(brainsDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('smoke', () => {
  it('stores 2 notes and returns valid ids', () => {
    expect(note1Id).toBeTruthy();
    expect(note2Id).toBeTruthy();
    console.log('SMOKE note1Id:', note1Id);
    console.log('SMOKE note2Id:', note2Id);
  });

  it('search returns stored notes', async () => {
    const hits = await engine.search({
      query: 'TypeScript services',
      teamSlugs: [TEAM],
      top: 5,
    });

    console.log('SMOKE search hits:', hits.length);
    if (hits[0]) console.log('SMOKE top hit snippet:', hits[0].snippet.slice(0, 80));
    expect(hits.length).toBeGreaterThan(0);
  });

  it('renderWikiIndex includes note links', async () => {
    const { title, bodyHtml } = await engine.renderWikiIndex(TEAM);
    console.log('SMOKE wiki title:', title);
    console.log('SMOKE wiki bodyHtml (200 chars):', bodyHtml.slice(0, 200));
    expect(title).toContain(TEAM);
    expect(bodyHtml).toContain('<li>');
  });

  it('renderWikiNote extracts content from first note', async () => {
    const result = await engine.renderWikiNote(TEAM, note1Id);
    console.log('SMOKE renderWikiNote title:', result?.title);
    console.log('SMOKE renderWikiNote body (200 chars):', result?.bodyHtml?.slice(0, 200));
    expect(result).not.toBeNull();
    expect(result?.bodyHtml).toContain('TypeScript');
  });

  it('stats returns note count >= 2', async () => {
    const st = await engine.stats(TEAM);
    console.log('SMOKE stats:', JSON.stringify(st));
    expect(st.notes).toBeGreaterThanOrEqual(2);
    expect(typeof st.activeDecisions).toBe('number');
  });
});
