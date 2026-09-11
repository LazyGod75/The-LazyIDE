/**
 * inject-turn-real-brain.test.ts — End-to-end proof that `inject-context
 * --mode turn` returns real, scored, budget-bounded content against a
 * genuinely populated brain.
 *
 * Unlike turn-inject-quality.test.ts (which mocks retrieval/router.js and
 * indexer/fts.js to test the formatting/gating logic in isolation), this
 * file runs the REAL pipeline end to end, no mocks: a real temp brain on
 * disk, real file-neuron HTML (composeFileNeuron — exactly what `lazybrain
 * graph --cwd` writes for a code-scanned project), a real SQLite FTS index
 * (indexNote), and the real retrieval router (route()).
 *
 * This is the direct regression test for the confirmed IDE bug: the Rust
 * side (src-tauri/src/commands/brain/search.rs) used to bypass `inject-context
 * --mode turn` entirely because of a stale "returns empty in the bundled
 * sidecar even with a populated brain" comment. Reproducing with the real
 * CLI (both engine/dist/bin/lazybrain.js and the bundled
 * src-tauri/resources/lazybrain/lazybrain.js) shows turn mode returns real
 * scored content today — this test pins that behavior in the fast unit-test
 * suite so it cannot silently regress again.
 *
 * No ONNX embeddings required — and deliberately made impossible rather than
 * just unrequested: LAZYBRAIN_MODELS_PATH is pointed at an always-empty
 * directory inside the per-test tmpDir, so getEmbedder()'s isModelCached()
 * check is false regardless of what the HOST machine happens to have cached
 * under its real ~/.lazybrain/models (this dev box has the multilingual
 * model pre-downloaded — without this override the test would silently pass
 * on this machine while being non-hermetic/CI-unsafe, and would additionally
 * trip an unrelated latent bug: embeddings.ts's saveCache() does not create
 * its cache directory before writing embeddings.bin into it, which throws
 * ENOENT for a fresh temp brain — out of scope for this task, sidestepped
 * rather than fixed here). With no embedder, L2_L3_HYBRID cleanly collapses
 * to pure L2 keyword search — deterministic and fast for CI. The query is
 * chosen to literally share tokens with the seeded file-neuron's
 * exports/path so keyword-only retrieval still finds it for real (see
 * MIN_SCORE_BY_LEVEL.L2 = 0.01 in session-inject.ts).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import { runInit } from '../src/commands/init.js';
import { runInjectContext, runTurnInjectDetailed } from '../src/commands/inject-context.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { closeDb, indexNote } from '../src/indexer/fts.js';
import { readNote } from '../src/store/reader.js';
import { writeNote } from '../src/store/writer.js';
import { resetConfigForTests } from '../src/util/config.js';

const AUTH_NODE: CodeNode = {
  id: 'file:src/auth.ts',
  title: 'src/auth.ts',
  type: 'file',
  filePath: 'src/auth.ts',
  projectRoot: '/fixture-project',
  language: 'typescript',
  lineCount: 43,
  imports: [],
  exports: [
    'AuthTokenPair',
    'rotateRefreshToken',
    'signAccessToken',
    'signRefreshToken',
    'validateSession',
  ],
};

const BILLING_NODE: CodeNode = {
  id: 'file:src/billing.ts',
  title: 'src/billing.ts',
  type: 'file',
  filePath: 'src/billing.ts',
  projectRoot: '/fixture-project',
  language: 'typescript',
  lineCount: 34,
  imports: [],
  exports: ['Subscription', 'computeProration', 'applyWebhookEvent'],
};

describe('inject-context --mode turn — real populated brain (no mocks)', () => {
  let tmpDir: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lb-turn-real-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    // Always-empty per-test dir — see the file-header comment for why this
    // deliberately forces getEmbedder() to degrade to null/L2 rather than
    // relying on the host machine's real model cache being absent.
    process.env.LAZYBRAIN_MODELS_PATH = join(tmpDir, '.lazybrain', '_no-models-here');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });

    // Seed two real file-neurons, exactly as `lazybrain graph --cwd` would
    // for a small TypeScript project (codeNodesToNotes -> composeFileNeuron
    // -> writeNote -> indexNote, same pipeline as commands/graph.ts).
    for (const node of [AUTH_NODE, BILLING_NODE]) {
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

  it('runTurnInjectDetailed returns non-empty, scored, budget-bounded content for a real matching query', async () => {
    const result = await runTurnInjectDetailed({
      query: 'how does auth validateSession work',
      cwd: '/fixture-project',
      maxTokens: 500,
    });

    expect(result.text).not.toBe('');
    // A real retrieval level was reported — not the "short-circuited before
    // route() ran" null (see TurnInjectResult's doc comment).
    expect(result.levelUsed).not.toBeNull();
    expect(['L1', 'L2', 'L2_L3_HYBRID', 'L3', 'L4']).toContain(result.levelUsed);
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.tokens).toBeLessThanOrEqual(500);
    expect(result.sectionsCount).toBeGreaterThan(0);
    // The matching file must actually be named in the output.
    expect(result.text).toMatch(/auth\.ts/);
  });

  it('the CLI-facing runInjectContext(mode: turn) wrapper returns the same non-empty text', async () => {
    const text = await runInjectContext({
      mode: 'turn',
      query: 'how does auth validateSession work',
      cwd: '/fixture-project',
      maxTokens: 500,
    });

    expect(text).not.toBe('');
    expect(text).toMatch(/auth\.ts/);
  });

  it('respects an explicit ~500-token budget — output never exceeds it', async () => {
    const result = await runTurnInjectDetailed({
      query: 'how does auth validateSession work',
      cwd: '/fixture-project',
      maxTokens: 60,
    });

    expect(result.tokens).toBeLessThanOrEqual(60);
  });

  it('returns empty for a query with no real relevance (score-floor gate still works on real data)', async () => {
    const result = await runTurnInjectDetailed({
      query: 'kubernetes ingress nginx cert-manager rollout strategy',
      cwd: '/fixture-project',
      maxTokens: 500,
    });

    expect(result.text).toBe('');
  });

  it('nudge "tool" reaches the real formatted output end to end', async () => {
    const result = await runTurnInjectDetailed({
      query: 'how does auth validateSession work',
      cwd: '/fixture-project',
      maxTokens: 500,
      nudge: 'tool',
    });

    expect(result.text).toMatch(/brain_search|BRAIN_SEARCH/);
    expect(result.text).not.toMatch(/lazybrain-recall/i);
  });
});
