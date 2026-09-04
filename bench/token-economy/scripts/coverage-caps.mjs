#!/usr/bin/env node
/** Measure body-cap strategies: linear vs head+tail. NO LLM. */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokenCount } from '../lib/tokenize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const QUESTIONS = JSON.parse(readFileSync(join(HERE, '..', 'questions.json'), 'utf8'));

function hasTerm(hay, term) {
  return Boolean(hay) && hay.toLowerCase().includes(String(term).toLowerCase());
}
function allCovered(text, terms) {
  return terms.every((t) => hasTerm(text, t));
}

function precedingJsdoc(source, index) {
  const before = source.slice(0, index);
  const m = before.match(/(\/\*\*[\s\S]*?\*\/)\s*$/);
  if (!m) return '';
  const lines = m[1].split('\n');
  return lines.length > 20 ? lines.slice(0, 20).join('\n') : m[1];
}

function extractAny(source, name) {
  const ident = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    String.raw`(?:export\s+)?(?:async\s+)?(?:function|class|const|type|interface|let)\s+${ident}\b`,
  );
  const m = re.exec(source);
  if (!m) return null;
  const start = m.index;
  const comment = precedingJsdoc(source, start);
  let i = start;
  const limit = Math.min(source.length, start + 20000);
  let brace = -1;
  while (i < limit) {
    if (source[i] === '{') {
      brace = i;
      break;
    }
    if (source[i] === ';' && i > start + name.length + 4) {
      return { comment, text: source.slice(start, i + 1) };
    }
    i++;
  }
  if (brace < 0) return { comment, text: source.slice(start, start + 400) };
  let depth = 0;
  for (let j = brace; j < Math.min(source.length, brace + 30000); j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) return { comment, text: source.slice(start, j + 1) };
    }
  }
  return { comment, text: source.slice(start, brace + 1200) };
}

function linear(text, n) {
  const lines = text.split('\n');
  if (lines.length <= n) return text;
  return lines.slice(0, n).join('\n') + '\n// …';
}

function headTail(text, head, tail) {
  const lines = text.split('\n');
  if (lines.length <= head + tail) return text;
  return [...lines.slice(0, head), '// …', ...lines.slice(-tail)].join('\n');
}

function main() {
  const variants = [
    ['lin40', (t) => linear(t, 40)],
    ['lin80', (t) => linear(t, 80)],
    ['ht20_15', (t) => headTail(t, 20, 15)],
    ['ht30_20', (t) => headTail(t, 30, 20)],
    ['ht40_20', (t) => headTail(t, 40, 20)],
    ['full', (t) => t],
  ];
  const acc = Object.fromEntries(variants.map(([k]) => [k, { full: 0, tokens: 0 }]));
  const n = QUESTIONS.questions.length;
  for (const q of QUESTIONS.questions) {
    const source = existsSync(join(REPO, q.lazyTarget.file))
      ? readFileSync(join(REPO, q.lazyTarget.file), 'utf8')
      : '';
    const hit = extractAny(source, q.lazyTarget.symbol);
    for (const [k, fn] of variants) {
      const body = hit ? fn(hit.text) : '';
      const text = hit ? [hit.comment, body].filter(Boolean).join('\n') : '';
      if (allCovered(text, q.groundTruth.requiredTerms)) acc[k].full++;
      acc[k].tokens += estimateTokenCount(text);
    }
  }
  console.log('strategy'.padEnd(12), 'ceil'.padStart(6), 'meanTok'.padStart(8));
  for (const [k, v] of Object.entries(acc)) {
    console.log(k.padEnd(12), ((v.full / n) * 100).toFixed(0).padStart(5) + '%', String(Math.round(v.tokens / n)).padStart(8));
  }
}
main();
