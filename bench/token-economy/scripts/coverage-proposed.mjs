#!/usr/bin/env node
/**
 * coverage-proposed.mjs — NO LLM.
 *
 * Simulate the HTML we would emit if file-neurons stored CSS-selectable
 * excerpts (preceding comment + body, type aliases, const decls, file header)
 * and measure coverage ceiling + token cost of SURGICAL injection
 * (only the target symbol) vs dumping the whole proposed neuron.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokenCount } from '../lib/tokenize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const QUESTIONS = JSON.parse(readFileSync(join(HERE, '..', 'questions.json'), 'utf8'));

function hasTerm(hay, term) {
  return Boolean(hay) && hay.toLowerCase().includes(String(term).toLowerCase());
}

function layer(text, terms) {
  const hits = terms.map((t) => hasTerm(text, t));
  const ok = hits.filter(Boolean).length;
  return {
    tokens: estimateTokenCount(text || ''),
    chars: (text || '').length,
    present: ok,
    total: terms.length,
    all: terms.length > 0 && ok === terms.length,
    ratio: terms.length ? ok / terms.length : 0,
    missing: terms.filter((t) => !hasTerm(text, t)),
  };
}

function leadingCommentsAndHeader(source) {
  const header = [];
  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length && /^\s*$/.test(lines[i])) i++;
  if (lines[i] && lines[i].includes('/*')) {
    const start = i;
    while (i < lines.length && !lines[i].includes('*/')) i++;
    header.push(lines.slice(start, i + 1).join('\n'));
  }
  return header.join('\n');
}

function precedingComment(source, index) {
  const before = source.slice(0, index);
  const m = before.match(/(\/\*\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n\s*\/\/[^\n]*)*)\s*$/);
  return m ? m[1].trim() : '';
}

function extractDecl(source, kind, name) {
  const ident = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = {
    function: new RegExp(
      String.raw`(?:export\s+)?(?:async\s+)?function\s+${ident}\s*\(`,
    ),
    class: new RegExp(String.raw`(?:export\s+)?class\s+${ident}\b`),
    const: new RegExp(String.raw`(?:export\s+)?const\s+${ident}\b`),
    type: new RegExp(String.raw`(?:export\s+)?type\s+${ident}\b`),
    interface: new RegExp(String.raw`(?:export\s+)?interface\s+${ident}\b`),
    anyIdent: new RegExp(String.raw`\b${ident}\b`),
  };
  const re = patterns[kind] || patterns.anyIdent;
  const m = re.exec(source);
  if (!m) return { found: false, text: '', comment: '' };
  const start = m.index;
  const comment = precedingComment(source, start);
  let i = start;
  const limit = Math.min(source.length, start + 16000);
  let brace = -1;
  while (i < limit) {
    if (source[i] === '{') {
      brace = i;
      break;
    }
    if (source[i] === ';' && i > start + name.length + 4) {
      return { found: true, text: source.slice(start, i + 1), comment };
    }
    i++;
  }
  if (brace < 0) return { found: true, text: source.slice(start, start + 400), comment };
  let depth = 0;
  for (let j = brace; j < Math.min(source.length, brace + 20000); j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) return { found: true, text: source.slice(start, j + 1), comment };
    }
  }
  return { found: true, text: source.slice(start, brace + 1200), comment };
}

function capLines(text, maxLines) {
  if (!text) return '';
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n/* … ${lines.length - maxLines} more lines truncated */`;
}

function main() {
  const caps = [12, 24, 40, 80];
  const rows = [];

  for (const q of QUESTIONS.questions) {
    const abs = join(REPO, q.lazyTarget.file);
    const source = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    const terms = q.groundTruth.requiredTerms;
    const symbol = q.lazyTarget.symbol;
    const header = leadingCommentsAndHeader(source);

    const attempts = [
      extractDecl(source, 'function', symbol),
      extractDecl(source, 'const', symbol),
      extractDecl(source, 'type', symbol),
      extractDecl(source, 'interface', symbol),
      extractDecl(source, 'class', symbol),
    ];
    const hit = attempts.find((a) => a.found) || { found: false, text: '', comment: '' };

    const byCap = {};
    for (const cap of caps) {
      const body = capLines(hit.text, cap);
      const surgical = [hit.comment, body].filter(Boolean).join('\n');
      const surgicalPlusHeader = [header, hit.comment, body].filter(Boolean).join('\n');
      byCap[`cap${cap}`] = {
        surgical: layer(surgical, terms),
        surgicalPlusHeader: layer(surgicalPlusHeader, terms),
        bodyOnly: layer(body, terms),
        commentOnly: layer(hit.comment, terms),
        headerOnly: layer(header, terms),
      };
    }

    rows.push({
      id: q.id,
      category: q.category,
      symbol,
      file: q.lazyTarget.file,
      declFound: hit.found,
      bodyLines: hit.text ? hit.text.split('\n').length : 0,
      commentChars: hit.comment.length,
      headerChars: header.length,
      source: layer(source, terms),
      byCap,
    });
  }

  function summarize(pick) {
    const n = rows.length;
    const full = rows.filter((r) => pick(r).all).length;
    const structural = rows.filter((r) => r.category === 'structural');
    const behavioral = rows.filter((r) => r.category === 'behavioral');
    return {
      full,
      n,
      ceil: +(full / n).toFixed(4),
      struct: +(structural.filter((r) => pick(r).all).length / structural.length).toFixed(4),
      behav: +(behavioral.filter((r) => pick(r).all).length / behavioral.length).toFixed(4),
      meanTokens: Math.round(rows.reduce((s, r) => s + pick(r).tokens, 0) / n),
      meanRecall: +(rows.reduce((s, r) => s + pick(r).ratio, 0) / n).toFixed(4),
    };
  }

  const summary = {
    source: summarize((r) => r.source),
  };
  for (const cap of caps) {
    summary[`cap${cap}_surgical`] = summarize((r) => r.byCap[`cap${cap}`].surgical);
    summary[`cap${cap}_surgicalPlusHeader`] = summarize((r) => r.byCap[`cap${cap}`].surgicalPlusHeader);
    summary[`cap${cap}_bodyOnly`] = summarize((r) => r.byCap[`cap${cap}`].bodyOnly);
  }
  summary.commentOnly = summarize((r) => r.byCap.cap40.commentOnly);
  summary.headerOnly = summarize((r) => r.byCap.cap40.headerOnly);

  const out = { generatedAt: new Date().toISOString(), summary, rows };
  const outPath = join(HERE, '..', 'results', 'coverage-proposed.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('\nPROPOSED FILE-NEURON COVERAGE (surgical inject of target symbol)\n');
  console.log(
    'variant'.padEnd(32),
    'full'.padStart(5),
    'ceil'.padStart(7),
    'struct'.padStart(7),
    'behav'.padStart(7),
    'tok'.padStart(6),
    'recall'.padStart(7),
  );
  for (const [name, s] of Object.entries(summary)) {
    console.log(
      name.padEnd(32),
      String(s.full).padStart(5),
      (s.ceil * 100).toFixed(0).padStart(6) + '%',
      (s.struct * 100).toFixed(0).padStart(6) + '%',
      (s.behav * 100).toFixed(0).padStart(6) + '%',
      String(s.meanTokens).padStart(6),
      (s.meanRecall * 100).toFixed(0).padStart(6) + '%',
    );
  }

  console.log('\nPer question @ cap40 surgical vs +header\n');
  for (const r of rows) {
    const s = r.byCap.cap40.surgical;
    const h = r.byCap.cap40.surgicalPlusHeader;
    console.log(
      `${r.id} ${r.category.padEnd(11)} lines=${String(r.bodyLines).padStart(4)} surg=${s.all} +hdr=${h.all} missSurg=${s.missing.join('|') || '-'} missHdr=${h.missing.join('|') || '-'}`,
    );
  }
  console.log('\nWrote', outPath);
}

main();
