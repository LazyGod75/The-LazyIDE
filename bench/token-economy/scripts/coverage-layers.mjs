#!/usr/bin/env node
/**
 * coverage-layers.mjs — NO LLM.
 *
 * For every token-economy question, measure whether each requiredTerm is
 * present in successive layers, and how many tokens each layer costs.
 *
 * Layers:
 *   source            — raw file on disk (oracle upper bound)
 *   neuron_html       — current fixture file-neuron (what the brain stores)
 *   neuron_stripped   — tag-stripped neuron (what stripTags would inject)
 *   strip_prompt_240  — first 240 chars of stripped note (current stripNoteToPrompt fallback)
 *   tldr              — section[data-section="tldr"]
 *   architecture      — section[data-section="architecture"]
 *   children          — section[data-section="children"] (signatures only today)
 *   symbol_anchor     — the one <h3 id="fn-X"> heading
 *   source_fn_window  — source lines of the target function (brace-matched),
 *                       i.e. the content we WOULD store if the neuron kept a
 *                       CSS-selectable body excerpt
 *
 * Output: JSON + a printed table. The numbers decide whether embedding
 * function bodies (or another CSS section) is worth doing.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokenCount } from '../lib/tokenize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const QUESTIONS = JSON.parse(readFileSync(join(HERE, '..', 'questions.json'), 'utf8'));
const FIXTURE =
  process.env.LAZYBRAIN_FIXTURE_BRAIN ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-David-Documents-cerveau/32ad4d7b-6319-4de8-bacd-f12144290e18/scratchpad/brain-fixture/brain';

function hasTerm(hay, term) {
  if (!hay) return false;
  return hay.toLowerCase().includes(String(term).toLowerCase());
}

function termHits(hay, terms) {
  return terms.map((t) => ({ term: t, present: hasTerm(hay, t) }));
}

function coverage(hits) {
  const n = hits.length;
  const ok = hits.filter((h) => h.present).length;
  return { present: ok, total: n, ratio: n ? ok / n : 0, all: n > 0 && ok === n };
}

function stripTags(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(h[1-6]|p|div|section|br|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function section(html, id) {
  const re = new RegExp(`<section[^>]*data-section="${id}"[^>]*>([\\s\\S]*?)</section>`, 'i');
  const m = html.match(re);
  return m ? m[0] : '';
}

function toAnchorId(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractSymbolAnchor(html, symbol) {
  if (!symbol) return '';
  const id = toAnchorId(symbol);
  for (const tag of ['fn', 'cls']) {
    const re = new RegExp(`<h3 id="${tag}-${id}"[^>]*>[\\s\\S]*?</h3>`, 'i');
    const m = html.match(re);
    if (m) return m[0];
  }
  return '';
}

/** Brace-match the first function/const/class whose identifier equals `symbol`. */
function extractSourceFnWindow(source, symbol) {
  if (!source || !symbol) return '';
  const ident = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(
    String.raw`(?:export\s+(?:async\s+)?(?:function|class|const|let|type|interface)\s+|` +
      String.raw`(?:async\s+)?function\s+|` +
      String.raw`(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+)?|` +
      String.raw`const\s+|let\s+|class\s+|type\s+|interface\s+|` +
      String.raw`(?:public|private|protected|static|async)\s+)*` +
      ident +
      String.raw`\b`,
  );
  const m = startRe.exec(source);
  if (!m) return '';
  const start = m.index;
  // Walk forward to first `{` or `=` then match braces / take a bounded window.
  let i = start;
  const limit = Math.min(source.length, start + 8000);
  let brace = -1;
  while (i < limit) {
    const ch = source[i];
    if (ch === '{') {
      brace = i;
      break;
    }
    if (ch === ';' && i > start + ident.length + 8) {
      // type alias / const without body
      return source.slice(start, i + 1);
    }
    i++;
  }
  if (brace < 0) return source.slice(start, Math.min(start + 400, source.length));
  let depth = 0;
  for (let j = brace; j < Math.min(source.length, brace + 12000); j++) {
    const ch = source[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  return source.slice(start, brace + 800);
}

function layerStats(text, terms) {
  const hits = termHits(text, terms);
  return {
    tokens: estimateTokenCount(text || ''),
    chars: (text || '').length,
    ...coverage(hits),
    missing: hits.filter((h) => !h.present).map((h) => h.term),
  };
}

function main() {
  if (!existsSync(FIXTURE)) {
    console.error('Fixture brain missing:', FIXTURE);
    process.exit(1);
  }
  const notesDir = join(FIXTURE, 'notes', '2026-08');
  const noteFiles = existsSync(notesDir) ? readdirSync(notesDir).filter((f) => f.endsWith('.html')) : [];

  const neuronByCodeFile = new Map();
  for (const f of noteFiles) {
    if (!f.startsWith('file-')) continue;
    const html = readFileSync(join(notesDir, f), 'utf8');
    const codeFile = (html.match(/data-code-file="([^"]+)"/) || [])[1];
    const project = (html.match(/data-code-project="([^"]+)"/) || [])[1] || '';
    if (!codeFile) continue;
    const key = `${project}::${codeFile}`;
    neuronByCodeFile.set(key, html);
    // also index by filename for fallback
    if (!neuronByCodeFile.has(codeFile)) neuronByCodeFile.set(codeFile, html);
  }

  function resolveNeuron(relFile) {
    const codeFile = relFile.split('/').pop();
    const dirSeg = relFile.split('/').slice(-2, -1)[0] || '';
    const wantProject = `code-${dirSeg}`;
    const exact = neuronByCodeFile.get(`${wantProject}::${codeFile}`);
    if (exact) return exact;
    // fallback: any neuron whose data-code-file matches and source path contains the corpus dir
    for (const [k, html] of neuronByCodeFile) {
      if (!k.endsWith('::' + codeFile) && k !== codeFile) continue;
      const src = (html.match(/data-cerveau-source="([^"]+)"/) || [])[1] || '';
      if (src.replace(/\\/g, '/').includes(relFile.split('/').slice(0, -1).join('/'))) return html;
    }
    return neuronByCodeFile.get(codeFile) || '';
  }

  const rows = [];
  for (const q of QUESTIONS.questions) {
    const rel = q.lazyTarget.file;
    const symbol = q.lazyTarget.symbol;
    const terms = q.groundTruth.requiredTerms;
    const abs = join(REPO, rel);
    const source = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    const neuron = resolveNeuron(rel);
    const stripped = stripTags(neuron);
    const tldr = stripTags(section(neuron, 'tldr'));
    const architecture = stripTags(section(neuron, 'architecture'));
    const children = stripTags(section(neuron, 'children'));
    const anchor = stripTags(extractSymbolAnchor(neuron, symbol));
    const fnWindow = extractSourceFnWindow(source, symbol);
    const prompt240 = stripped.slice(0, 240);
    // Hybrid CSS target: signature + function body (what a surgical CSS
    // selector `h3#fn-X + pre.body, h3#fn-X` would inject if we stored the body).
    const cssTarget = [anchor, fnWindow].filter(Boolean).join('\n');

    const layers = {
      source: layerStats(source, terms),
      neuron_html: layerStats(neuron, terms),
      neuron_stripped: layerStats(stripped, terms),
      strip_prompt_240: layerStats(prompt240, terms),
      tldr: layerStats(tldr, terms),
      architecture: layerStats(architecture, terms),
      children: layerStats(children, terms),
      symbol_anchor: layerStats(anchor, terms),
      source_fn_window: layerStats(fnWindow, terms),
      css_sig_plus_body: layerStats(cssTarget, terms),
    };

    rows.push({
      id: q.id,
      category: q.category,
      file: rel,
      symbol,
      terms,
      neuronFound: Boolean(neuron),
      fnWindowFound: Boolean(fnWindow),
      layers,
    });
  }

  const layerNames = [
    'source',
    'neuron_html',
    'neuron_stripped',
    'strip_prompt_240',
    'tldr',
    'architecture',
    'children',
    'symbol_anchor',
    'source_fn_window',
    'css_sig_plus_body',
  ];

  const summary = {};
  for (const name of layerNames) {
    const n = rows.length;
    const allHits = rows.filter((r) => r.layers[name].all).length;
    const meanTokens = Math.round(rows.reduce((s, r) => s + r.layers[name].tokens, 0) / n);
    const meanRatio =
      rows.reduce((s, r) => s + r.layers[name].ratio, 0) / n;
    const structural = rows.filter((r) => r.category === 'structural');
    const behavioral = rows.filter((r) => r.category === 'behavioral');
    summary[name] = {
      questionsFullyCovered: allHits,
      n,
      accuracyCeiling: +(allHits / n).toFixed(4),
      meanTokens,
      meanTermRecall: +meanRatio.toFixed(4),
      structuralCeiling: +(
        structural.filter((r) => r.layers[name].all).length / structural.length
      ).toFixed(4),
      behavioralCeiling: +(
        behavioral.filter((r) => r.layers[name].all).length / behavioral.length
      ).toFixed(4),
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    fixture: FIXTURE,
    note: 'This is a COVERAGE ceiling (is the fact even stored / selectable), not an answering-model score. A layer cannot beat its coverage ceiling no matter how good retrieval is.',
    summary,
    rows,
  };

  const outPath = join(HERE, '..', 'results', 'coverage-layers.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('\nCOVERAGE CEILING (requiredTerms present in layer / 24 questions)\n');
  console.log(
    'layer'.padEnd(22),
    'full'.padStart(6),
    'ceil'.padStart(8),
    'struct'.padStart(8),
    'behav'.padStart(8),
    'meanTok'.padStart(9),
    'termRec'.padStart(8),
  );
  for (const name of layerNames) {
    const s = summary[name];
    console.log(
      name.padEnd(22),
      String(s.questionsFullyCovered).padStart(6),
      (s.accuracyCeiling * 100).toFixed(0).padStart(7) + '%',
      (s.structuralCeiling * 100).toFixed(0).padStart(7) + '%',
      (s.behavioralCeiling * 100).toFixed(0).padStart(7) + '%',
      String(s.meanTokens).padStart(9),
      (s.meanTermRecall * 100).toFixed(0).padStart(7) + '%',
    );
  }

  console.log('\nPer-question: which layers fully cover requiredTerms\n');
  for (const r of rows) {
    const winners = layerNames.filter((n) => r.layers[n].all).join(',') || '(none)';
    const missNeuron = r.layers.neuron_stripped.missing.join('|') || '-';
    const missBody = r.layers.source_fn_window.missing.join('|') || '-';
    console.log(
      `${r.id} ${r.category.padEnd(11)} fnWin=${r.fnWindowFound ? 'Y' : 'N'} neuronFull=${r.layers.neuron_stripped.all} bodyFull=${r.layers.source_fn_window.all}  cover=[${winners}]  missNeuron=${missNeuron}  missBody=${missBody}`,
    );
  }
  console.log('\nWrote', outPath);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
