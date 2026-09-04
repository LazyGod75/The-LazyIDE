/**
 * lib/lazyFixture.mjs — reads the isolated, throwaway LazyBrain fixture that
 * was code-scanned (via the REAL `lazybrain graph --cwd <dir>` CLI, the
 * production code-scanner + file-neuron composer — see
 * bench/token-economy/README-FIXTURE.txt for the exact commands) from the
 * same corpusDirs as everything else in this harness.
 *
 * This module does NOT touch David's real brain. It only ever reads
 * LAZYBRAIN_FIXTURE_BRAIN, an isolated directory outside the repo, and never
 * falls back to brain discovery — if the env var is missing this throws
 * rather than silently scanning ~/Documents for a real brain.
 *
 * Extraction is done by direct regex/string parsing of the generated
 * file-neuron HTML rather than shelling out to `lazybrain query` for every
 * lookup — this is a harness-side convenience, not a different retrieval
 * mechanism: `lazybrain query "#fn-picklevel" --strip` was verified by hand
 * to return exactly the same heading text this module extracts (see the
 * design notes in run.mjs). The CONTENT (what the notes contain) is 100%
 * produced by the real production pipeline; only the "give me node X's
 * text" step is inlined for speed (no repeated process spawns for 24
 * questions x 2 LazyBrain configs).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function requireFixtureBrainDir() {
  const dir = process.env.LAZYBRAIN_FIXTURE_BRAIN;
  if (!dir) {
    throw new Error(
      'LAZYBRAIN_FIXTURE_BRAIN is not set. Refusing to fall back to brain discovery ' +
        '(which could resolve to a real brain, e.g. David\'s). Set it to the isolated ' +
        'scratch brain built by scripts/build-fixture-brain.mjs.',
    );
  }
  return dir;
}

let _index = null;

/**
 * Scan every file-neuron note under the fixture brain's notes/ tree once,
 * building an in-memory index keyed by "<projectSegment>::<data-code-file>"
 * — the exact two fields buildArticleId() (file-neuron.ts) derives a note's
 * persisted id from, so this lookup key is stable even though the id itself
 * is silently truncated at 80 chars for long paths.
 */
export function buildFileNeuronIndex() {
  if (_index) return _index;
  const brainDir = requireFixtureBrainDir();
  const notesDir = join(brainDir, 'notes');
  const index = new Map();
  const monthDirs = safeReaddir(notesDir);
  for (const month of monthDirs) {
    const monthPath = join(notesDir, month);
    const files = safeReaddir(monthPath).filter((f) => f.endsWith('.html'));
    for (const f of files) {
      const htmlPath = join(monthPath, f);
      const html = readFileSync(htmlPath, 'utf-8');
      if (!html.includes('data-cerveau-type="file-neuron"')) continue;
      const id = matchAttr(html, 'id');
      const codeFile = matchAttr(html, 'data-code-file');
      const codeProject = matchAttr(html, 'data-code-project'); // "code-<projectSegment>"
      if (!id || !codeFile || !codeProject) continue;
      const projectSegment = codeProject.replace(/^code-/, '');
      const key = `${projectSegment}::${codeFile}`;
      index.set(key, { id, htmlPath, codeFile, projectSegment });
    }
  }
  _index = index;
  return index;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function matchAttr(html, attr) {
  const m = html.match(new RegExp(`${attr}="([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * Look up a file-neuron by its repo-relative path, e.g.
 * "engine/src/retrieval/router.ts" scanned with --cwd
 * ".../engine/src/retrieval" (projectSegment "retrieval", data-code-file
 * "router.ts").
 */
export function findFileNeuron(corpusDir, relPathFromRepoRoot) {
  const index = buildFileNeuronIndex();
  const projectSegment = corpusDir.split('/').filter(Boolean).pop();
  const codeFile = relPathFromRepoRoot.slice(corpusDir.length).replace(/^\//, '');
  const key = `${projectSegment}::${codeFile}`;
  const hit = index.get(key);
  if (!hit) return null;
  return { ...hit, html: readFileSync(hit.htmlPath, 'utf-8') };
}

/** List every file-neuron whose projectSegment matches this corpusDir's last path segment. */
export function listFileNeuronsInDir(corpusDir) {
  const index = buildFileNeuronIndex();
  const projectSegment = corpusDir.split('/').filter(Boolean).pop();
  const out = [];
  for (const [key, val] of index) {
    if (key.startsWith(`${projectSegment}::`)) out.push(val);
  }
  return out;
}

/**
 * Extract the rendered heading text for a specific symbol anchor
 * ("#fn-<name>" or "#cls-<name>", toAnchorId() rule: lowercase, non-alnum
 * runs -> single hyphen). Mirrors exactly what
 * `lazybrain query "#fn-<name>" --strip` returns (verified by hand).
 * Returns null if the symbol has no anchor (e.g. a top-level const —
 * file-neurons only anchor functions/classes, not constants; this is a
 * real, honest gap in the attribute-filtering path, not a harness bug).
 */
export function extractSymbolAnchorText(html, symbolName) {
  const anchorId = toAnchorId(symbolName);
  for (const tag of ['fn', 'cls', 'bind']) {
    const divRe = new RegExp(`<div[^>]*\\sid="${tag}-${anchorId}"[^>]*>([\\s\\S]*?)<\\/div>`, 'i');
    const dm = html.match(divRe);
    if (dm) return stripTags(dm[1]).trim();
    const h3Re = new RegExp(`<h3 id="${tag}-${anchorId}"[^>]*>([\\s\\S]*?)</h3>`, 'i');
    const hm = html.match(h3Re);
    if (hm) return stripTags(hm[1]).trim();
  }
  return null;
}

function toAnchorId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Extract the one-line TLDR ("typescript file with N functions (M lines)"). */
export function extractTldr(html) {
  const m = html.match(/<section data-section="tldr">\s*<p>([\s\S]*?)<\/p>/i);
  return m ? stripTags(m[1]).trim() : '';
}

/**
 * Full stripped text of a file-neuron note: every section's tag-stripped
 * text, in document order. This is a lightweight regex-based stripper (not
 * byte-identical to engine/src/retrieval/strip.ts's stripTags, which is
 * owned by another workstream on this branch) — good enough fidelity for
 * token-economy measurement since it removes the same class of information
 * (markup), not content.
 */
export function extractFullNoteText(html) {
  const bodyMatch = html.match(/<article[^>]*>([\s\S]*)<\/article>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  return stripTags(body).replace(/\n{3,}/g, '\n\n').trim();
}

function stripTags(fragment) {
  return fragment
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
