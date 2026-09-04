/**
 * Config (e) — lazy_search: the REAL product retrieval path, added after a
 * review flagged that lazy_targeted/lazy_full_subtree are benchmark-authored
 * simulations (extractSymbolAnchorText/toAnchorId exist ONLY in
 * bench/token-economy — grep the repo, they are not in engine/src). This
 * config instead shells out to the actual shipped CLI:
 *
 *   lazybrain search "<question text>" --strip --top <N>
 *
 * — engine/src/commands/search.ts's runSearch(), which calls the real
 * adaptive router (route(), engine/src/retrieval/router.ts, L1-L4:
 * FTS/BM25 -> bi-encoder -> hybrid RRF -> cross-encoder rerank) and formats
 * each hit with stripNoteToPrompt() (engine/src/retrieval/strip.ts) — the
 * exact function the product uses for `search --strip` output and the basis
 * of the IDE's per-turn recall workaround path (see commit 923a11b: before
 * mode=turn was restored, the IDE literally called `search --strip --top 6`).
 *
 * This is not a second invented config: every step (query text -> route() ->
 * stripNoteToPrompt()) is the product's own code, run against the SAME
 * fixture brain as every other config, with no harness-side reinterpretation
 * of the note HTML (contrast lazyFixture.mjs, which regex-extracts fragments
 * itself for configs b/c).
 *
 * KNOWN PROPERTY (found while wiring this in, see mission report): each hit
 * is rendered by stripNoteToPrompt(), which for a note with no
 * `[data-cerveau-fact]` elements (true for every file-neuron — facts are a
 * capture-note construct) falls back to `note.text.split('\n').join(' ')
 * .slice(0, 240)` — the FIRST 240 characters of the whole stripped note,
 * counted from the top (breadcrumb/infobox/tldr/architecture/children come
 * before any enrichment section in composeFileNeuron's part order). For any
 * file-neuron whose architecture+children sections exceed ~240 characters —
 * true for nearly every non-trivial file — the decisions/bugs/rules sections
 * an enrichment pass adds are physically past the truncation point and can
 * never appear in this config's injected text, independent of --top. This is
 * a property of the shipped stripNoteToPrompt() formatter, not of this
 * harness.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokenCount } from '../tokenize.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url)).replace(/[\\/]$/, '');
const ENGINE_DIR = join(REPO_ROOT, 'engine');
const LAZYBRAIN_CLI = join(ENGINE_DIR, 'dist', 'bin', 'lazybrain.js');

export const CONFIG_ID = 'lazy_search';

/**
 * @param {number} topK how many hits `search --top` returns (the product's
 *   own knob — analogous in spirit to the token budgets other configs vary,
 *   though this one varies result COUNT rather than a hard character cap,
 *   because that is the real CLI's only exposed control).
 */
export function run(question, corpusDirs, topK = 5) {
  const brainDir = process.env.LAZYBRAIN_FIXTURE_BRAIN;
  if (!brainDir) {
    throw new Error(
      'LAZYBRAIN_FIXTURE_BRAIN is not set. Refusing to fall back to brain discovery.',
    );
  }

  let contextText;
  let errorMsg = null;
  try {
    const out = execFileSync(
      process.execPath,
      [LAZYBRAIN_CLI, 'search', question.question, '--strip', '--top', String(topK)],
      {
        cwd: ENGINE_DIR,
        env: { ...process.env, LAZYBRAIN_BRAIN_PATH: brainDir },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    contextText = out.trim();
  } catch (err) {
    // A failed/timed-out real-retrieval call is itself a legitimate
    // (negative) data point — record it as empty context rather than
    // silently retrying or falling back to a different mechanism.
    errorMsg = err instanceof Error ? err.message : String(err);
    contextText = '';
  }

  return {
    configId: CONFIG_ID,
    contextText,
    tokenCount: estimateTokenCount(contextText),
    meta: { topK, cliError: errorMsg },
  };
}
