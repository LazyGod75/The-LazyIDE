/**
 * Config (c) — LazyBrain full subtree dump: the CONTROL that isolates
 * "does the hierarchy help" from "does attribute filtering help" (b).
 *
 * Same skeleton as (b) (the directory's file list), but instead of pulling
 * only the one matching symbol/tldr, this dumps the FULL stripped
 * file-neuron content — tldr + imports/exports + every function/class
 * signature — for EVERY file-neuron in that directory. Structure narrows
 * WHERE to look (the directory); nothing narrows WHAT is included from
 * there.
 */

import { extractFullNoteText, listFileNeuronsInDir } from '../lazyFixture.mjs';
import { estimateTokenCount } from '../tokenize.mjs';
import { resolveCorpusDir } from '../corpus.mjs';
import { readFileSync } from 'node:fs';

export const CONFIG_ID = 'lazy_full_subtree';

export function run(question, corpusDirs) {
  const { file } = question.lazyTarget;
  const corpusDir = resolveCorpusDir(file, corpusDirs);
  if (!corpusDir) throw new Error(`No corpusDir matches lazyTarget.file ${file}`);

  const notes = listFileNeuronsInDir(corpusDir).sort((a, b) => a.codeFile.localeCompare(b.codeFile));
  const skeleton = `[SKELETON] ${corpusDir}/\n${notes.map((n) => `  ${n.codeFile}`).join('\n')}`;

  const dumps = notes.map((n) => {
    const html = readFileSync(n.htmlPath, 'utf-8');
    return `--- ${n.codeFile} ---\n${extractFullNoteText(html)}`;
  });

  const contextText = `${skeleton}\n\n[FULL SUBTREE DUMP — no attribute filtering]\n${dumps.join('\n\n')}`;
  return {
    configId: CONFIG_ID,
    contextText,
    tokenCount: estimateTokenCount(contextText),
    meta: { corpusDir, fileCount: notes.length },
  };
}
