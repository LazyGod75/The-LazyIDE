/**
 * Token-efficient compression of file-neuron CodeNodes.
 *
 * Produces a compact, deterministic text representation of a file's structure
 * without any function bodies — analogous to Repomix signature-only mode and
 * the Aider repo-map approach (signatures + line references, PageRank-ranked).
 *
 * Two compression levels:
 *   - default: header + imports + exports + function signatures (name, params, startLine)
 *              + class skeletons (name, extends, method names)
 *   - skeletonOnly: header + exports + names only (no params), maximally compact
 *
 * Typical output sizes:
 *   - default:      ~40–120 tokens per file
 *   - skeletonOnly: ~15–40  tokens per file
 */

import type { EnrichmentItem } from '../annotator/blocks/composers/file-neuron.js';
import type { CodeNode } from '../graph/code-scanner.js';
import { estimateTokenCount } from '../util/tokenize.js';

export interface CompressOptions {
  /** When true, emit only header + exports + names (no params/lines). */
  skeletonOnly?: boolean;
  /**
   * Token budget for the compact "knowledge:" summary of decisions/bugs/ideas/
   * rules/qa attached by the conv→file-neuron enrichment pipeline. Default 200.
   * Set to 0 to omit the summary entirely.
   */
  enrichmentTokenBudget?: number;
}

/** Enrichment kinds surfaced in the compact recall summary, in priority order. */
const ENRICHMENT_KINDS = ['decisions', 'bugs', 'rules', 'qa', 'ideas'] as const;

/** Short, stable label per kind — keeps each summary line to a few tokens. */
const KIND_LABEL: Record<(typeof ENRICHMENT_KINDS)[number], string> = {
  decisions: 'Decision',
  bugs: 'Bug',
  rules: 'Rule',
  qa: 'Q&A',
  ideas: 'Idea',
};

/** Default token budget for the enrichment summary block. */
const DEFAULT_ENRICHMENT_TOKEN_BUDGET = 200;

/** Max characters of item text kept per summary line (before token budgeting). */
const MAX_LINE_TEXT_CHARS = 140;

interface RankedLine {
  line: string;
  confidence: number;
  date: string;
}

/**
 * Build a compact, token-budgeted summary of the decisions/bugs/rules/qa/ideas
 * attached to a file-neuron by the conv→file-neuron enrichment pipeline
 * (commands/conv-file-enrichment.ts).
 *
 * - Superseded items are excluded: recall should surface current knowledge,
 *   not a claim a later conversation already overrode.
 * - Ranked by confidence desc, then date desc (most-confident, most-recent
 *   first) — see conv-file-enrichment.ts's canonicalMerge confidence and
 *   applyRecencySuperseding date semantics.
 * - Truncated to `tokenBudget` tokens so a file with a long conversation
 *   history doesn't blow the recall context budget; at least one line is
 *   always kept when candidates exist, even if it alone exceeds the budget.
 *
 * Returns '' when the node carries no (non-superseded) enrichment.
 */
function buildEnrichmentSummary(node: CodeNode, tokenBudget: number): string {
  if (tokenBudget <= 0) return '';

  const candidates: RankedLine[] = [];
  for (const kind of ENRICHMENT_KINDS) {
    const items: EnrichmentItem[] = node[kind] ?? [];
    for (const item of items) {
      if (item.superseded) continue;
      const text = item.text.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_TEXT_CHARS);
      if (!text) continue;
      candidates.push({
        line: `${KIND_LABEL[kind]}: ${text}`,
        confidence: item.confidence,
        date: item.date,
      });
    }
  }
  if (candidates.length === 0) return '';

  candidates.sort((a, b) => b.confidence - a.confidence || b.date.localeCompare(a.date));

  const kept: string[] = [];
  let used = 0;
  for (const candidate of candidates) {
    const cost = estimateTokenCount(candidate.line);
    if (used + cost > tokenBudget && kept.length > 0) break;
    kept.push(candidate.line);
    used += cost;
  }
  return kept.join('\n');
}

/**
 * Produce a compact text representation of a CodeNode suitable for injection
 * into an LLM context window.
 *
 * Design principles:
 *   - No function bodies — only signatures
 *   - Deterministic (same input → same output)
 *   - One line per function/class where possible
 *   - `skeletonOnly` is strictly shorter than default
 *   - When the node carries conv→file-neuron enrichment (decisions/bugs/…), a
 *     compact top-N summary is appended in BOTH skeleton and default modes —
 *     so recalling a file surfaces "decided X because Y / bug: Z" alongside
 *     the code, even in the terser skeleton form used for lower-rank files.
 */
export function compressFileNeuron(node: CodeNode, opts: CompressOptions = {}): string {
  const { skeletonOnly = false, enrichmentTokenBudget = DEFAULT_ENRICHMENT_TOKEN_BUDGET } = opts;
  const lines: string[] = [];

  // Header: path (Nlines, lang)
  const lineInfo = node.lineCount > 0 ? `${node.lineCount}L` : '?L';
  lines.push(`${node.filePath} (${lineInfo}, ${node.language})`);

  if (skeletonOnly) {
    // Skeleton-only: exports + function/class names only
    if (node.exports.length > 0) {
      lines.push(`exports: ${node.exports.join(', ')}`);
    }
    const fnNames = (node.astFunctions ?? []).map((f) => f.name);
    if (fnNames.length > 0) {
      lines.push(`fns: ${fnNames.join(', ')}`);
    }
    const clsNames = (node.astClasses ?? []).map((c) => c.name);
    if (clsNames.length > 0) {
      lines.push(`cls: ${clsNames.join(', ')}`);
    }
    // Fallback: exports as names when no AST
    if (fnNames.length === 0 && clsNames.length === 0 && node.exports.length === 0) {
      // Still emit header only — that's the minimum
    }
  } else {
    // Default: full signatures
    if (node.imports.length > 0) {
      lines.push(`imports: ${node.imports.join(', ')}`);
    }
    if (node.exports.length > 0) {
      lines.push(`exports: ${node.exports.join(', ')}`);
    }

    // Functions: name(params) :startLine
    const fns = node.astFunctions ?? [];
    if (fns.length > 0) {
      lines.push('functions:');
      for (const fn of fns) {
        const params = fn.params.length > 0 ? fn.params.join(', ') : '';
        const lineRef = fn.startLine > 0 ? ` :${fn.startLine}` : '';
        lines.push(`  ${fn.name}(${params})${lineRef}`);
      }
    }

    // Classes: Name [extends X] { methodA, methodB }
    const classes = node.astClasses ?? [];
    if (classes.length > 0) {
      lines.push('classes:');
      for (const cls of classes) {
        const base = cls.extends ? ` extends ${cls.extends}` : '';
        const methods = cls.methods.length > 0 ? ` { ${cls.methods.join(', ')} }` : '';
        lines.push(`  ${cls.name}${base}${methods}`);
      }
    }
  }

  const enrichmentSummary = buildEnrichmentSummary(node, enrichmentTokenBudget);
  if (enrichmentSummary) {
    lines.push('knowledge:');
    for (const line of enrichmentSummary.split('\n')) {
      lines.push(`  ${line}`);
    }
  }

  return lines.join('\n');
}
