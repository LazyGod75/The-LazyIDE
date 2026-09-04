#!/usr/bin/env node
/**
 * coverage-after-html.mjs — NO LLM.
 *
 * Compose a file-neuron the way the product now does (JSDoc + head/tail
 * excerpt inside #fn- / #bind-), then measure requiredTerm coverage of the
 * CSS-selected fragment. This is the honest post-change ceiling, independent
 * of the stale fixture brain (which is still signature-only until rescanned).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { estimateTokenCount } from '../lib/tokenize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const QUESTIONS = JSON.parse(readFileSync(join(HERE, '..', 'questions.json'), 'utf8'));

const require = createRequire(import.meta.url);

function toAnchorId(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function hasTerm(hay, term) {
  return Boolean(hay) && hay.toLowerCase().includes(String(term).toLowerCase());
}

function layer(text, terms) {
  const hits = terms.map((t) => hasTerm(text, t));
  const ok = hits.filter(Boolean).length;
  return {
    tokens: estimateTokenCount(text || ''),
    all: terms.length > 0 && ok === terms.length,
    ratio: terms.length ? ok / terms.length : 0,
    missing: terms.filter((t) => !hasTerm(text, t)),
  };
}

function precedingJsdoc(source, index) {
  const before = source.slice(0, index);
  const m = before.match(/(\/\*\*[\s\S]*?\*\/)\s*$/);
  if (!m) return '';
  const lines = m[1].split('\n');
  return lines.length > 20 ? lines.slice(0, 20).join('\n') : m[1];
}

function extractDecl(source, name) {
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
      return { comment, text: source.slice(start, i + 1), kind: classify(m[0]) };
    }
    i++;
  }
  if (brace < 0) return { comment, text: source.slice(start, start + 400), kind: classify(m[0]) };
  let depth = 0;
  for (let j = brace; j < Math.min(source.length, brace + 30000); j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) return { comment, text: source.slice(start, j + 1), kind: classify(m[0]) };
    }
  }
  return { comment, text: source.slice(start, brace + 1200), kind: classify(m[0]) };
}

function classify(head) {
  if (/\bfunction\b/.test(head) || /\bclass\b/.test(head)) return 'function';
  if (/\btype\b/.test(head) || /\binterface\b/.test(head) || /\bconst\b/.test(head)) return 'binding';
  return 'function';
}

function capHeadTail(text, head, tail) {
  const lines = text.split('\n');
  if (lines.length <= head + tail) return text;
  return [...lines.slice(0, head), '// …', ...lines.slice(-tail)].join('\n');
}

function extractCssFragment(html, selectorId) {
  const re = new RegExp(
    `<div[^>]*\\sid="${selectorId}"[^>]*>([\\s\\S]*?)<\\/div>`,
    'i',
  );
  const m = html.match(re);
  return m ? m[0] : '';
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
    .trim();
}

async function main() {
  const composerUrl = new URL(
    '../../../engine/src/annotator/blocks/composers/file-neuron.ts',
    import.meta.url,
  );
  const { composeFileNeuron } = await import(composerUrl.href);

  const rows = [];
  for (const q of QUESTIONS.questions) {
    const source = existsSync(join(REPO, q.lazyTarget.file))
      ? readFileSync(join(REPO, q.lazyTarget.file), 'utf8')
      : '';
    const hit = extractDecl(source, q.lazyTarget.symbol);
    const excerpt = hit ? capHeadTail(hit.text, 30, 20) : '';
    const jsdoc = hit?.comment ?? '';
    const isBinding = hit?.kind === 'binding';
    const node = {
      id: `file:${q.lazyTarget.file}`,
      title: q.lazyTarget.file,
      type: 'file',
      filePath: q.lazyTarget.file,
      projectRoot: '/repo',
      language: 'typescript',
      lineCount: source.split('\n').length,
      imports: [],
      exports: [q.lazyTarget.symbol],
      astFunctions: isBinding
        ? []
        : [
            {
              name: q.lazyTarget.symbol,
              startLine: 1,
              endLine: 2,
              params: [],
              isExported: true,
              jsdoc,
              excerpt,
            },
          ],
      astBindings: isBinding
        ? [
            {
              name: q.lazyTarget.symbol,
              kind: 'type',
              startLine: 1,
              endLine: 2,
              isExported: true,
              jsdoc,
              excerpt,
            },
          ]
        : [],
    };
    const html = composeFileNeuron(node, 0);
    const slug = toAnchorId(q.lazyTarget.symbol);
    const selId = isBinding ? `bind-${slug}` : `fn-${slug}`;
    const fragment = extractCssFragment(html, selId);
    const stripped = stripTags(fragment);
    const terms = q.groundTruth.requiredTerms;
    rows.push({
      id: q.id,
      category: q.category,
      selector: `#${selId}`,
      found: Boolean(fragment),
      css: layer(stripped, terms),
      source: layer(source, terms),
    });
  }

  const n = rows.length;
  const structural = rows.filter((r) => r.category === 'structural');
  const behavioral = rows.filter((r) => r.category === 'behavioral');
  const summary = {
    css_fn_or_bind: {
      full: rows.filter((r) => r.css.all).length,
      ceil: +(rows.filter((r) => r.css.all).length / n).toFixed(4),
      struct: +(structural.filter((r) => r.css.all).length / structural.length).toFixed(4),
      behav: +(behavioral.filter((r) => r.css.all).length / behavioral.length).toFixed(4),
      meanTokens: Math.round(rows.reduce((s, r) => s + r.css.tokens, 0) / n),
      meanRecall: +(rows.reduce((s, r) => s + r.css.ratio, 0) / n).toFixed(4),
    },
    source: {
      full: rows.filter((r) => r.source.all).length,
      ceil: +(rows.filter((r) => r.source.all).length / n).toFixed(4),
    },
  };

  const outPath = join(HERE, '..', 'results', 'coverage-after-html.json');
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2));

  console.log('\nAFTER (composed HTML + CSS #fn-/#bind- fragment)\n');
  const s = summary.css_fn_or_bind;
  console.log(
    `full=${s.full}/${n}  ceil=${(s.ceil * 100).toFixed(0)}%  struct=${(s.struct * 100).toFixed(0)}%  behav=${(s.behav * 100).toFixed(0)}%  meanTok=${s.meanTokens}  termRec=${(s.meanRecall * 100).toFixed(0)}%`,
  );
  for (const r of rows) {
    console.log(
      `${r.id} ${r.category.padEnd(11)} ${r.selector.padEnd(24)} all=${r.css.all} tok=${String(r.css.tokens).padStart(4)} miss=${r.css.missing.join('|') || '-'}`,
    );
  }
  console.log('\nWrote', outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
