/**
 * recall-budget-saturation.test.ts — MEASURE whether turn-mode budgets
 * 150 / 500 / 1500 / 3000 actually change injected content on a corpus
 * large enough to overflow 500 tokens.
 *
 * Why this exists: the IDE sidecar and cold CLI both request maxTokens=1500
 * (search.rs / BRAIN_RECALL_MAX_TOKENS), and the engine hook default is 150.
 * Changing any of those without measuring saturation is guesswork. This file
 * also proved that hardcoded route() topK=5 made every budget identical
 * (125 tokens / 5 files) — turnRecallTopK() is the measured fix.
 *
 * Corpus: 40 real file-neurons that all share a distinctive token so L2
 * retrieval returns many hits. No embeddings (LAZYBRAIN_MODELS_PATH empty).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import { runTurnInjectDetailed } from '../src/commands/inject-context.js';
import { runInit } from '../src/commands/init.js';
import { runServe } from '../src/commands/serve.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { closeDb, indexNote } from '../src/indexer/fts.js';
import { route } from '../src/retrieval/router.js';
import { readNote } from '../src/store/reader.js';
import { writeNote } from '../src/store/writer.js';
import { resetConfigForTests } from '../src/util/config.js';

const SHARED = 'rotateRefreshToken';
const FILE_COUNT = 40;
const BUDGETS = [150, 500, 1500, 3000] as const;

function makeNode(i: number): CodeNode {
  const name = `mod${String(i).padStart(2, '0')}`;
  return {
    id: `file:src/${name}.ts`,
    title: `src/${name}.ts`,
    type: 'file',
    filePath: `src/${name}.ts`,
    projectRoot: '/fixture-project',
    language: 'typescript',
    lineCount: 80 + i,
    imports: [],
    exports: [SHARED, `${name}Handler`, `${name}Schema`, `parse${name}`],
  };
}

function uniqueFilesInText(text: string): string[] {
  const hits = text.match(/src\/mod\d+\.ts/g) ?? [];
  return [...new Set(hits)].sort();
}

describe('turn-mode recall budget saturation (real populated brain)', () => {
  let tmpDir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lb-recall-budget-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    process.env.LAZYBRAIN_MODELS_PATH = join(tmpDir, '.lazybrain', '_no-models-here');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });

    for (const node of Array.from({ length: FILE_COUNT }, (_, i) => makeNode(i))) {
      const html = composeFileNeuron(node);
      const written = writeNote(html, { overwrite: true });
      indexNote(readNote(written.path));
    }
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('reports tokens, unique files, and whether 500 vs 1500 actually differs', async () => {
    const query = `how does ${SHARED} work across the typescript modules`;
    const rows: Array<{
      budget: number;
      tokens: number;
      sections: number;
      uniqueFiles: number;
      ms: number;
      saturated: boolean;
    }> = [];

    for (const budget of BUDGETS) {
      const t0 = Date.now();
      const result = await runTurnInjectDetailed({
        query,
        cwd: '/fixture-project',
        maxTokens: budget,
        nudge: 'tool',
        // Unique session so session-dedup does not starve later budgets.
        sessionId: `budget-${budget}`,
        skipTelemetry: true,
      });
      const uniqueFiles = uniqueFilesInText(result.text).length;
      rows.push({
        budget,
        tokens: result.tokens,
        sections: result.sectionsCount,
        uniqueFiles,
        ms: Date.now() - t0,
        saturated: result.tokens >= budget * 0.9,
      });
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ bench: 'recall-budget-saturation', rows }, null, 2));

    const at150 = rows.find((r) => r.budget === 150)!;
    const at500 = rows.find((r) => r.budget === 500)!;
    const at1500 = rows.find((r) => r.budget === 1500)!;
    const at3000 = rows.find((r) => r.budget === 3000)!;

    expect(at150.tokens).toBeGreaterThan(0);
    expect(at150.tokens).toBeLessThanOrEqual(150);
    expect(at500.tokens).toBeLessThanOrEqual(500);
    expect(at1500.tokens).toBeLessThanOrEqual(1500);
    expect(at3000.tokens).toBeLessThanOrEqual(3000);

    // After topK scaled with budget, a wider budget must retrieve more
    // (the pre-fix world was 125 tokens / 5 files at every budget).
    expect(at500.sections).toBeGreaterThan(at150.sections);
    expect(at1500.sections).toBeGreaterThan(at500.sections);
    expect(at500.tokens).toBeGreaterThan(at150.tokens);
    expect(at1500.tokens).toBeGreaterThan(at500.tokens);
  });

  it('measures whether route() topK (not maxTokens) is the recall ceiling', async () => {
    const query = `how does ${SHARED} work across the typescript modules`;
    const rows: Array<{ topK: number; hits: number; uniqueFiles: number; ms: number }> = [];

    for (const topK of [5, 10, 20, 40] as const) {
      const t0 = Date.now();
      const result = await route({
        query,
        topK,
        level: 'auto',
        cwd: '/fixture-project',
        hydrateNote: true,
        skipTelemetry: true,
      });
      const files = new Set(
        result.hits
          .map((h) => h.note?.title ?? '')
          .filter((t) => /^src\/mod\d+\.ts$/.test(t)),
      );
      rows.push({
        topK,
        hits: result.hits.length,
        uniqueFiles: files.size,
        ms: Date.now() - t0,
      });
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ bench: 'recall-topk', rows, corpus: FILE_COUNT }, null, 2));

    expect(rows[0]!.hits).toBe(5);
    expect(rows[1]!.hits).toBe(10);
    expect(rows[2]!.hits).toBe(20);
    expect(rows[3]!.hits).toBe(40);
  });

  it('serves the same 1500-token budget over HTTP /_api/recall (warm sidecar path)', async () => {
    const server = await runServe({ port: 0, bind: '127.0.0.1' });
    const port = (server.address() as AddressInfo).port;
    const query = encodeURIComponent(`how does ${SHARED} work across the typescript modules`);
    const url = `http://127.0.0.1:${port}/_api/recall?q=${query}&maxTokens=1500&nudge=tool&cwd=${encodeURIComponent('/fixture-project')}`;
    const t0 = Date.now();
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(url, (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => resolve(raw));
        })
        .on('error', reject);
    });
    const ms = Date.now() - t0;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    const json = JSON.parse(body) as { text?: string; tokens?: number; level?: string };
    const uniqueFiles = uniqueFilesInText(json.text ?? '').length;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      bench: 'recall-http-1500',
      port,
      tokens: json.tokens,
      uniqueFiles,
      level: json.level,
      textChars: (json.text ?? '').length,
      ms,
    }));

    expect(json.tokens).toBeGreaterThan(0);
    expect(json.tokens).toBeLessThanOrEqual(1500);
    expect(uniqueFiles).toBeGreaterThan(5);
    expect(json.text).toMatch(/rotateRefreshToken/);
  });

  it('recalls a camelCase identifier (agent symbol lookup, not a 3-word sentence)', async () => {
    const result = await runTurnInjectDetailed({
      query: SHARED,
      cwd: '/fixture-project',
      maxTokens: 1500,
      nudge: 'tool',
      sessionId: 'symbol-lookup',
      skipTelemetry: true,
    });
    expect(result.levelUsed).not.toBeNull();
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.text).toMatch(/rotateRefreshToken/);
  });

  it('serves identifier lookup over HTTP /_api/recall', async () => {
    const server = await runServe({ port: 0, bind: '127.0.0.1' });
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/_api/recall?q=${encodeURIComponent(SHARED)}&maxTokens=1500&nudge=tool&cwd=${encodeURIComponent('/fixture-project')}`;
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(url, (res) => {
          let raw = '';
          res.on('data', (chunk) => {
            raw += chunk;
          });
          res.on('end', () => resolve(raw));
        })
        .on('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    const json = JSON.parse(body) as { text?: string; tokens?: number; level?: string | null };
    expect(json.level).not.toBeNull();
    expect(json.tokens).toBeGreaterThan(0);
    expect(json.text).toMatch(/rotateRefreshToken/);
  });
});
