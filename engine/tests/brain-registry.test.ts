/**
 * brain-registry.test.ts — T0.8: multi-tenant brain engine.
 *
 * One `lazybrain serve` process must be able to host N brains: request
 * routing by an optional `brainId`, LRU-3 hot handles, and byte-for-byte
 * compatibility for requests that never mention a brainId (the existing
 * single-brain flow).
 *
 * Written before src/server/brain-registry.ts exists — TDD red first.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, indexNote } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface JsonResponse {
  status: number;
  // Loose JSON shape (test-only): mirrors JSON.parse's own return type
  // without writing a literal `any` annotation.
  json: ReturnType<typeof JSON.parse>;
}

let port: number;

function httpGetJson(path: string): Promise<JsonResponse> {
  return new Promise((resolvePromise, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolvePromise({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : null });
        });
      })
      .on('error', reject);
  });
}

function httpPostJson(path: string, payload: unknown): Promise<JsonResponse> {
  return new Promise((resolvePromise, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolvePromise({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// Brain fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;

function makeBrainDir(label: string): string {
  const dir = join(tmpRoot, label);
  mkdirSync(join(dir, 'notes'), { recursive: true });
  mkdirSync(join(dir, '_cache'), { recursive: true });
  return dir;
}

/** Seed a note into whichever brain is active in the current async context. */
function seedNote(id: string, body: string): void {
  const html = `<article id="${id}" data-cerveau-type="reference"><h2>${id}</h2><p>${body}</p></article>`;
  indexNote({ id, path: `${id}.html`, html, sizeBytes: html.length, mtimeMs: Date.now() });
}

// ---------------------------------------------------------------------------
// Test setup — one real `serve` process (default brain) per test, additional
// brains registered on top of it through the registry under test.
// ---------------------------------------------------------------------------

let defaultBrainDir: string;
let server: Server | undefined;

describe('brain-registry — multi-tenant engine (T0.8)', () => {
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'lb-brain-registry-'));
    defaultBrainDir = makeBrainDir('default-brain');

    process.env.LAZYBRAIN_BRAIN_PATH = defaultBrainDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(defaultBrainDir, '_cache');
    resetConfigForTests();

    const { resetBrainRegistryForTests } = await import('../src/server/brain-registry.js');
    resetBrainRegistryForTests();

    const { runServe } = await import('../src/commands/serve.js');
    server = await runServe({ port: 0, bind: '127.0.0.1' });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise) => {
      if (server) {
        server.close(() => resolvePromise());
        server = undefined;
      } else {
        resolvePromise();
      }
    });
    closeDb();
    const { resetBrainRegistryForTests } = await import('../src/server/brain-registry.js');
    resetBrainRegistryForTests();
    process.env = { ...savedEnv };
    resetConfigForTests();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // (b) idempotent open
  // -------------------------------------------------------------------------

  it('opening the same brain path twice returns the same brainId (idempotent)', async () => {
    const { openBrain, listBrains } = await import('../src/server/brain-registry.js');
    const dir = makeBrainDir('brain-idempotent');

    const first = await openBrain(dir);
    const second = await openBrain(dir);

    expect(second.brainId).toBe(first.brainId);
    expect(listBrains().filter((b) => b.brainPath.includes('brain-idempotent'))).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // (a) isolation — capture in A is visible in A only
  // -------------------------------------------------------------------------

  it('a note captured in brain A is found scoped to A and absent from brain B', async () => {
    const { openBrain, withBrain } = await import('../src/server/brain-registry.js');
    const dirA = makeBrainDir('brain-a');
    const dirB = makeBrainDir('brain-b');
    const { brainId: idA } = await openBrain(dirA);
    const { brainId: idB } = await openBrain(dirB);

    withBrain(idA, () => seedNote('note-alpha-only', 'uniquealphamarker appears only in brain A'));

    const notesA = await httpGetJson(`/_api/notes?brainId=${idA}`);
    expect(notesA.status).toBe(200);
    expect(notesA.json.some((n: { id: string }) => n.id === 'note-alpha-only')).toBe(true);

    const notesB = await httpGetJson(`/_api/notes?brainId=${idB}`);
    expect(notesB.status).toBe(200);
    expect(notesB.json.some((n: { id: string }) => n.id === 'note-alpha-only')).toBe(false);

    // The real search route (not just the raw listing) must respect brainId too.
    const searchA = await httpGetJson(`/_api/search?q=uniquealphamarker&brainId=${idA}`);
    expect(searchA.status).toBe(200);
    expect(searchA.json.results.some((r: { id: string }) => r.id === 'note-alpha-only')).toBe(true);

    const searchB = await httpGetJson(`/_api/search?q=uniquealphamarker&brainId=${idB}`);
    expect(searchB.status).toBe(200);
    expect(searchB.json.results.some((r: { id: string }) => r.id === 'note-alpha-only')).toBe(
      false,
    );
  });

  // -------------------------------------------------------------------------
  // (d) default-brain compatibility
  // -------------------------------------------------------------------------

  it('requests without brainId hit the default env-configured brain, unchanged', async () => {
    seedNote('note-default-only', 'defaultbrainmarker text');

    const res = await httpGetJson('/_api/notes');
    expect(res.status).toBe(200);
    expect(res.json.some((n: { id: string }) => n.id === 'note-default-only')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (c) LRU-3 hot cap + lazy reopen after demotion
  // -------------------------------------------------------------------------

  it('a 4th hot brain demotes the LRU brain; a later request to it still succeeds (lazy reopen)', async () => {
    const { openBrain, getBrain, withBrain } = await import('../src/server/brain-registry.js');

    const dir1 = makeBrainDir('brain-1');
    const { brainId: id1 } = await openBrain(dir1);
    // Seed real data + close-worthy handles for brain 1 BEFORE it gets demoted,
    // so the later re-fetch proves a genuine close+reopen, not a first open.
    withBrain(id1, () => seedNote('note-in-brain-1', 'persisted before demotion'));

    const { brainId: id2 } = await openBrain(makeBrainDir('brain-2'));
    const { brainId: id3 } = await openBrain(makeBrainDir('brain-3'));
    const { brainId: id4 } = await openBrain(makeBrainDir('brain-4'));

    // Cap of 3 hot brains — id1 (least recently used) is demoted, not deleted.
    expect(getBrain(id1)?.hot).toBe(false);
    expect(getBrain(id1)).toBeDefined();
    expect([id2, id3, id4].every((id) => getBrain(id)?.hot === true)).toBe(true);
    expect([id1, id2, id3, id4].filter((id) => getBrain(id)?.hot).length).toBe(3);

    // Accessing the demoted brain must still work (lazy reopen of its handles).
    const res = await httpGetJson(`/_api/notes?brainId=${id1}`);
    expect(res.status).toBe(200);
    expect(res.json.some((n: { id: string }) => n.id === 'note-in-brain-1')).toBe(true);

    // The access re-promotes it to hot.
    expect(getBrain(id1)?.hot).toBe(true);
  });

  it('an unknown brainId returns 404 instead of crashing the server', async () => {
    const res = await httpGetJson('/_api/notes?brainId=does-not-exist');
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Management routes
  // -------------------------------------------------------------------------

  it('POST /brains/open + GET /brains reflect registered brains', async () => {
    const dir = makeBrainDir('brain-managed');

    const opened = await httpPostJson('/brains/open', { brainPath: dir });
    expect(opened.status).toBe(200);
    expect(typeof opened.json.brainId).toBe('string');

    const listed = await httpGetJson('/brains');
    expect(listed.status).toBe(200);
    expect(
      listed.json.brains.some((b: { brainId: string }) => b.brainId === opened.json.brainId),
    ).toBe(true);
  });

  it('POST /brains/open without a brainPath returns 400', async () => {
    const res = await httpPostJson('/brains/open', {});
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Registry labels (spec §5.3/§10 follow-up): 'project' | 'team' | 'trunk'
  // -------------------------------------------------------------------------

  describe('brain labels', () => {
    it('a brand-new brain defaults to the project label', async () => {
      const { openBrain, listBrains } = await import('../src/server/brain-registry.js');
      const dir = makeBrainDir('brain-label-default');

      const { brainId, label } = await openBrain(dir);

      expect(label).toBe('project');
      expect(listBrains().find((b) => b.brainId === brainId)?.label).toBe('project');
    });

    it('opening with an explicit label registers it under that label', async () => {
      const { openBrain } = await import('../src/server/brain-registry.js');
      const dir = makeBrainDir('brain-label-team');

      const { label } = await openBrain(dir, { label: 'team' });

      expect(label).toBe('team');
    });

    it("re-opening WITHOUT a label keeps the brain's existing label (no silent downgrade)", async () => {
      const { openBrain } = await import('../src/server/brain-registry.js');
      const dir = makeBrainDir('brain-label-keep');

      const first = await openBrain(dir, { label: 'trunk' });
      const second = await openBrain(dir);

      expect(first.label).toBe('trunk');
      expect(second.label).toBe('trunk');
      expect(second.brainId).toBe(first.brainId);
    });

    it("re-opening WITH a label updates an existing entry's label", async () => {
      const { openBrain } = await import('../src/server/brain-registry.js');
      const dir = makeBrainDir('brain-label-update');

      const first = await openBrain(dir, { label: 'project' });
      const second = await openBrain(dir, { label: 'team' });

      expect(second.brainId).toBe(first.brainId);
      expect(second.label).toBe('team');
    });

    it('POST /brains/open accepts a label and GET /brains reports it', async () => {
      const dir = makeBrainDir('brain-managed-labeled');

      const opened = await httpPostJson('/brains/open', { brainPath: dir, label: 'trunk' });
      expect(opened.status).toBe(200);
      expect(opened.json.label).toBe('trunk');

      const listed = await httpGetJson('/brains');
      const entry = listed.json.brains.find(
        (b: { brainId: string }) => b.brainId === opened.json.brainId,
      );
      expect(entry?.label).toBe('trunk');
    });

    it('POST /brains/open with an unrecognized label falls back to project instead of rejecting the request', async () => {
      const dir = makeBrainDir('brain-bad-label');

      const opened = await httpPostJson('/brains/open', { brainPath: dir, label: 'bogus' });

      expect(opened.status).toBe(200);
      expect(opened.json.label).toBe('project');
    });
  });

  // -------------------------------------------------------------------------
  // Team-scope federated search filters by label (spec §10 follow-up):
  // replaces the old brainPath.includes('/teams/') heuristic that no
  // registration code ever satisfied.
  // -------------------------------------------------------------------------

  describe('team-scope federated search filters by label', () => {
    it('scope=team only searches team- and trunk-labeled brains, excluding project brains', async () => {
      const { openBrain, withBrain } = await import('../src/server/brain-registry.js');

      const { brainId: projectId } = await openBrain(makeBrainDir('scope-project'));
      const { brainId: teamId } = await openBrain(makeBrainDir('scope-team'), { label: 'team' });
      const { brainId: trunkId } = await openBrain(makeBrainDir('scope-trunk'), { label: 'trunk' });

      withBrain(projectId, () =>
        seedNote('note-project-only', 'scopemarker lives in the project brain'),
      );
      withBrain(teamId, () => seedNote('note-team-only', 'scopemarker lives in the team brain'));
      withBrain(trunkId, () => seedNote('note-trunk-only', 'scopemarker lives in the trunk brain'));

      const teamScoped = await httpGetJson('/_api/search?q=scopemarker&scope=team&top=10');
      expect(teamScoped.status).toBe(200);
      const teamIds = teamScoped.json.results.map((r: { id: string }) => r.id);
      expect(teamIds).toContain('note-team-only');
      expect(teamIds).toContain('note-trunk-only');
      expect(teamIds).not.toContain('note-project-only');
    });

    it('scope=all-open still searches every registered brain regardless of label', async () => {
      const { openBrain, withBrain } = await import('../src/server/brain-registry.js');

      const { brainId: projectId } = await openBrain(makeBrainDir('allopen-project'));
      const { brainId: teamId } = await openBrain(makeBrainDir('allopen-team'), { label: 'team' });

      withBrain(projectId, () =>
        seedNote('note-allopen-project', 'allopenmarker in the project brain'),
      );
      withBrain(teamId, () => seedNote('note-allopen-team', 'allopenmarker in the team brain'));

      const res = await httpGetJson('/_api/search?q=allopenmarker&scope=all-open&top=10');
      expect(res.status).toBe(200);
      const ids = res.json.results.map((r: { id: string }) => r.id);
      expect(ids).toContain('note-allopen-project');
      expect(ids).toContain('note-allopen-team');
    });

    it('scope=team returns an honest empty result (not an error) when no team/trunk brains are registered', async () => {
      const res = await httpGetJson('/_api/search?q=anything&scope=team&top=10');
      expect(res.status).toBe(200);
      expect(res.json.results).toEqual([]);
    });
  });
});
