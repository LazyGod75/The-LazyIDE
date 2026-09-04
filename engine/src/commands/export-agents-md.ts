/**
 * Project the brain into an AGENTS.md digest that Vibe auto-loads into its
 * system prompt (user-level $VIBE_HOME/AGENTS.md or project-root AGENTS.md).
 *
 * Ownership contract: LazyBrain owns ONLY the block between the markers.
 * Human prose outside is never touched. Unbalanced markers abort the write.
 * Deterministic: same brain state -> byte-identical block (notes sorted by id).
 *
 * Two-level dedup (spec §3.4): a fact renders at exactly one level —
 *   user target    -> cross-project pointer + recall instructions (no per-project facts)
 *   project target -> active decisions/warnings scoped to the cwd.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { listAll } from '../indexer/fts.js';
import { vibeHome } from '../sources/vibe.js';
import { readNote } from '../store/reader.js';
import { estimateTokenCount } from '../util/tokenize.js';

export const LB_BEGIN_MARKER = '<!-- lazybrain:begin generated:do-not-edit -->';
export const LB_END_MARKER = '<!-- lazybrain:end -->';

export interface ExportAgentsMdOptions {
  target: 'user' | 'project';
  /** Project cwd to scope facts (project target). Defaults to process.cwd(). */
  cwd?: string;
  /** Override the output file (tests). */
  outFile?: string;
  /** Token budget for the generated block. */
  maxTokens?: number;
  pretty?: boolean;
}

export interface ExportAgentsMdReport {
  written: boolean;
  outFile: string;
  tokens: number;
  items: number;
  reason?: string;
}

export async function runExportAgentsMd(
  opts: ExportAgentsMdOptions,
): Promise<ExportAgentsMdReport> {
  const maxTokens = opts.maxTokens ?? 1200;
  const outFile =
    opts.outFile ??
    (opts.target === 'user'
      ? join(vibeHome(), 'AGENTS.md')
      : join(resolve(opts.cwd ?? process.cwd()), 'AGENTS.md'));

  const block =
    opts.target === 'user'
      ? renderUserBlock()
      : renderProjectBlock(resolve(opts.cwd ?? process.cwd()), maxTokens);

  const existing = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  const beginCount = countOccurrences(existing, LB_BEGIN_MARKER);
  const endCount = countOccurrences(existing, LB_END_MARKER);
  if (beginCount !== endCount || beginCount > 1) {
    return {
      written: false,
      outFile,
      tokens: 0,
      items: 0,
      reason: `unbalanced lazybrain markers in ${outFile} (begin=${beginCount}, end=${endCount}) — fix manually`,
    };
  }

  if (beginCount === 1 && existing.indexOf(LB_END_MARKER) < existing.indexOf(LB_BEGIN_MARKER)) {
    return {
      written: false,
      outFile,
      tokens: 0,
      items: 0,
      reason: `lazybrain markers out of order in ${outFile} (end before begin) — fix manually`,
    };
  }

  const wrapped = `${LB_BEGIN_MARKER}\n${block.text}\n${LB_END_MARKER}`;
  let next: string;
  if (beginCount === 1) {
    const start = existing.indexOf(LB_BEGIN_MARKER);
    const end = existing.indexOf(LB_END_MARKER) + LB_END_MARKER.length;
    next = existing.slice(0, start) + wrapped + existing.slice(end);
  } else if (existing.trim().length > 0) {
    next = `${existing.replace(/\s*$/, '')}\n\n${wrapped}\n`;
  } else {
    next = `${wrapped}\n`;
  }

  if (next !== existing) writeFileSync(outFile, next, 'utf8');
  return {
    written: true,
    outFile,
    tokens: estimateTokenCount(block.text),
    items: block.items,
  };
}

// ---------------------------------------------------------------------------

interface RenderedBlock {
  text: string;
  items: number;
}

function renderUserBlock(): RenderedBlock {
  const lines = [
    '## Persistent memory (LazyBrain)',
    '',
    'This machine has a LazyBrain HTML memory brain. Before re-deciding anything,',
    'recall settled knowledge with the CLI (deterministic, <30ms, $0):',
    '',
    '```bash',
    'lazybrain search "<topic>" --top 5 --strip',
    'lazybrain query \'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])\'',
    '```',
    '',
    "Project-scoped facts live in each project's own AGENTS.md (generated).",
  ];
  return { text: lines.join('\n'), items: 1 };
}

function renderProjectBlock(cwd: string, maxTokens: number): RenderedBlock {
  const needle = cwd.replace(/\\/g, '/').toLowerCase();
  const now = new Date().toISOString();
  // Include notes that have a future valid_until (active decisions) but exclude
  // notes whose valid_until is in the past (actually expired/invalidated).
  const candidates = listAll({ includeExpired: true })
    .filter((n) => {
      const vu = n.valid_until;
      if (vu && vu.trim() !== '' && vu < now) return false; // truly expired
      return n.type === 'decision' || (n.importance ?? 0) >= 0.7;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const decisions: string[] = [];
  const warnings: string[] = [];
  let scanned = 0;
  for (const n of candidates) {
    if (scanned >= 300) break; // hard cap on file reads
    scanned += 1;
    let html: string;
    try {
      html = readNote(n.path).html;
    } catch {
      continue;
    }
    const noteCwd = extractAttr(html, 'data-cerveau-cwd');
    if (!noteCwd || !noteCwd.replace(/\\/g, '/').toLowerCase().startsWith(needle)) continue;

    const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
    const tldr =
      document.querySelector('section[data-section="tldr"] p')?.textContent?.trim() ??
      document.querySelector('details[open] summary')?.textContent?.trim() ??
      '';
    if (tldr && n.type === 'decision') decisions.push(`- ${tldr} \`[#${n.id}]\``);
    for (const aside of Array.from(document.querySelectorAll('aside[role="doc-warning"]'))) {
      const w = aside.textContent?.trim();
      if (w) warnings.push(`- ${w.slice(0, 200)} \`[#${n.id}]\``);
    }
  }

  return assembleProjectBlock(dedupe(decisions), dedupe(warnings), maxTokens);
}

function assembleProjectBlock(
  decisions: string[],
  warnings: string[],
  maxTokens: number,
): RenderedBlock {
  const build = (d: string[], w: string[]): string => {
    const lines: string[] = ['## Project memory (LazyBrain — generated, do not edit)'];
    if (d.length > 0) lines.push('', '### Settled decisions (do not re-litigate)', ...d);
    if (w.length > 0) lines.push('', '### Warnings / anti-patterns', ...w);
    if (d.length === 0 && w.length === 0) {
      lines.push('', '_No settled project facts yet. Run `lazybrain dream` after a few sessions._');
    }
    lines.push('', 'Recall more: `lazybrain search "<topic>" --top 5 --strip`');
    return lines.join('\n');
  };

  const d = [...decisions];
  const w = [...warnings];
  let text = build(d, w);
  while (estimateTokenCount(text) > maxTokens && (d.length > 0 || w.length > 0)) {
    if (w.length > 0) w.pop();
    else d.pop();
    text = build(d, w);
  }
  return { text, items: d.length + w.length };
}

function extractAttr(html: string, attr: string): string | null {
  const m = html.match(new RegExp(`${attr}="([^"]*)"`));
  return m ? m[1] : null;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
