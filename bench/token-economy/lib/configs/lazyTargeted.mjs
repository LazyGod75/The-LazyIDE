/**
 * Config (b) — LazyBrain targeted retrieval: skeleton + tag/attribute-
 * filtered leaf.
 *
 * skeleton = the file list of the directory containing the target file (the
 *   codebase's own layout — no LLM extraction, no ranking).
 * leaf     = ONLY the specific matched attribute: the target symbol's
 *   file-neuron anchor heading (function/class signature) when the question
 *   targets a real AST symbol, else the file's one-line TLDR. This is the
 *   "attribute-filtered" arm: it deliberately does NOT include the rest of
 *   the file's file-neuron content.
 */

import { extractSymbolAnchorText, extractTldr, findFileNeuron, listFileNeuronsInDir } from '../lazyFixture.mjs';
import { estimateTokenCount } from '../tokenize.mjs';
import { resolveCorpusDir } from '../corpus.mjs';

export const CONFIG_ID = 'lazy_targeted';

export function run(question, corpusDirs) {
  const { file, symbol } = question.lazyTarget;
  const corpusDir = resolveCorpusDir(file, corpusDirs);
  if (!corpusDir) throw new Error(`No corpusDir matches lazyTarget.file ${file}`);

  const siblingFiles = listFileNeuronsInDir(corpusDir).map((n) => n.codeFile).sort();
  const skeleton = `[SKELETON] ${corpusDir}/\n${siblingFiles.map((f) => `  ${f}`).join('\n')}`;

  const note = findFileNeuron(corpusDir, file);
  let leaf;
  let leafKind;
  if (!note) {
    leaf = '(no file-neuron found for this file in the fixture brain)';
    leafKind = 'missing';
  } else {
    const anchorText = symbol ? extractSymbolAnchorText(note.html, symbol) : null;
    if (anchorText) {
      leaf = `${file}#${symbol}: ${anchorText}`;
      leafKind = 'symbol-anchor';
    } else {
      leaf = `${file} (tldr): ${extractTldr(note.html)}`;
      leafKind = 'tldr-fallback';
    }
  }

  const contextText = `${skeleton}\n\n[LEAF — attribute-filtered]\n${leaf}`;
  return {
    configId: CONFIG_ID,
    contextText,
    tokenCount: estimateTokenCount(contextText),
    meta: { corpusDir, siblingFileCount: siblingFiles.length, leafKind },
  };
}
