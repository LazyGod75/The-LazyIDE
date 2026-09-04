/**
 * brain_query_css (lazybrain query --pretty) is how the manager/IDE injects
 * a CSS hit. Slicing that text at 240 chars made surgical #fn- excerpts
 * unusable: the JSDoc + body never reached the model (measured: strip_prompt_240
 * coverage ceiling 8% vs 58% for the uncapped excerpt).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runQuery } from '../src/commands/query.js';
import { closeDb } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

const MARKER = 'UNIQUE_FINALLY_TREE_DELETE_SENTINEL_SHOULD_NOT_BE_TRUNCATED';
const PAD = 'x'.repeat(300);

describe('runQuery --pretty does not truncate a CSS hit', () => {
  const savedEnv = { ...process.env };
  let brainDir: string;

  beforeEach(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'lb-query-pretty-'));
    mkdirSync(join(brainDir, 'notes'), { recursive: true });
    mkdirSync(join(brainDir, '_cache'), { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');
    resetConfigForTests();
    const html = `<article id="file-ast-parser" data-cerveau-type="file-neuron">
      <section class="symbol" id="fn-parsefile" data-cerveau-symbol="parseFile" data-cerveau-symbol-kind="function">
        <h3>parseFile()</h3>
        <pre data-section="excerpt"><code>${PAD}\n  } finally {\n    tree.delete(); // ${MARKER}\n  }</code></pre>
      </section>
    </article>`;
    writeFileSync(join(brainDir, 'notes', 'file-ast-parser.html'), html, 'utf8');
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('returns the full #fn-parsefile excerpt, including text past char 240', () => {
    const out = runQuery({ selector: '#fn-parsefile', pretty: true });
    expect(out).toContain(MARKER);
    expect(out).toContain('finally');
    expect(out).toContain('tree.delete');
    expect(out.length).toBeGreaterThan(240);
  });
});
