/* codeTools.ts — ChatTool definitions exposing code intelligence to the AI assistant (C).
   Instead of GitNexus's MCP tools, these are ChatTool definitions that plug into
   Lazy's existing tool system (same pattern as brain_search, search_replace).

   The managed provider runs a client-side ReAct shim: the model emits a directive
   line, the provider parses it, executes the tool, and continues with results.

   Tools exposed:
     - code_query: hybrid search over the code graph
     - code_context: 360° symbol view (callers, callees, processes)
     - code_impact: blast radius analysis before changes
     - code_trace: shortest call path between two symbols
     - code_detect_changes: git-diff impact (pre-commit)
     - code_rename: multi-file rename preview
*/

import type { ChatTool } from '../models/types.js';
import { wrapResultWithSavings, estimateCorpusSizeFromNodes } from './tokenSavings.js';

// ── Directive parsing ─────────────────────────────────────────────

export const CODE_QUERY_DIRECTIVE = 'CODE_QUERY:';
export const CODE_CONTEXT_DIRECTIVE = 'CODE_CONTEXT:';
export const CODE_IMPACT_DIRECTIVE = 'CODE_IMPACT:';
export const CODE_TRACE_DIRECTIVE = 'CODE_TRACE:';
export const CODE_DETECT_CHANGES_DIRECTIVE = 'CODE_DETECT_CHANGES:';
export const CODE_RENAME_DIRECTIVE = 'CODE_RENAME:';

// ── Tool definitions ──────────────────────────────────────────────

export const CODE_QUERY_TOOL: ChatTool = {
  name: 'code_query',
  description:
    'Search the code knowledge graph for symbols, files, and execution flows. ' +
    'Returns process-grouped results: matching symbols with their file paths, ' +
    'cluster assignments, and any execution flows they participate in. ' +
    'Use this instead of grep when you need architectural context.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language or symbol name to search for.',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return (default: 10).',
      },
    },
    required: ['query'],
  },
};

export const CODE_CONTEXT_TOOL: ChatTool = {
  name: 'code_context',
  description:
    'Get a 360-degree view of a symbol: who calls it (incoming calls), ' +
    'what it calls (outgoing calls), what imports it, and which execution ' +
    'flows it participates in. Use before modifying a function to understand ' +
    'its full dependency surface.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The symbol name (function, class, method) to inspect.',
      },
    },
    required: ['name'],
  },
};

export const CODE_IMPACT_TOOL: ChatTool = {
  name: 'code_impact',
  description:
    'Analyze the blast radius of changing a symbol. Returns affected symbols ' +
    'grouped by depth with confidence scores and risk level (low/medium/high). ' +
    'ALWAYS use this before modifying a function or class to avoid breaking changes.',
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'The symbol name to analyze.',
      },
      direction: {
        type: 'string',
        enum: ['upstream', 'downstream'],
        description: 'upstream = what depends on this; downstream = what this depends on.',
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum traversal depth (default: 3).',
      },
    },
    required: ['target'],
  },
};

export const CODE_TRACE_TOOL: ChatTool = {
  name: 'code_trace',
  description:
    'Find the shortest call path between two symbols. Useful for debugging ' +
    'how function A eventually calls function B through intermediate calls.',
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Starting symbol name.' },
      to: { type: 'string', description: 'Target symbol name.' },
    },
    required: ['from', 'to'],
  },
};

export const CODE_DETECT_CHANGES_TOOL: ChatTool = {
  name: 'code_detect_changes',
  description:
    'Map uncommitted git changes to affected symbols, processes, and clusters. ' +
    'Returns a risk assessment before you commit. Use before committing to ' +
    'understand the full impact of your changes.',
  input_schema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['all', 'staged', 'unstaged'],
        description: 'Which changes to analyze (default: all).',
      },
    },
  },
};

export const CODE_RENAME_TOOL: ChatTool = {
  name: 'code_rename',
  description:
    'Preview a multi-file coordinated rename of a symbol. Returns all edit ' +
    'locations with confidence source (graph vs text search). Use dry_run ' +
    'mode to review before applying.',
  input_schema: {
    type: 'object',
    properties: {
      symbol_name: { type: 'string', description: 'Current symbol name.' },
      new_name: { type: 'string', description: 'New name for the symbol.' },
      dry_run: {
        type: 'boolean',
        description: 'If true (default), only preview without applying changes.',
      },
    },
    required: ['symbol_name', 'new_name'],
  },
};

// ── All code tools ────────────────────────────────────────────────

export const ALL_CODE_TOOLS: ChatTool[] = [
  CODE_QUERY_TOOL,
  CODE_CONTEXT_TOOL,
  CODE_IMPACT_TOOL,
  CODE_TRACE_TOOL,
  CODE_DETECT_CHANGES_TOOL,
  CODE_RENAME_TOOL,
];

// ── Directive parsing ─────────────────────────────────────────────

export interface ParsedCodeDirective {
  tool: string;
  args: Record<string, string>;
}

/** Parse a model turn for any CODE_* directive. Returns the last one found. */
export function parseCodeDirective(text: string): ParsedCodeDirective | null {
  if (!text.trim()) return null;

  const directives: Array<{ prefix: string; tool: string }> = [
    { prefix: CODE_QUERY_DIRECTIVE, tool: 'code_query' },
    { prefix: CODE_CONTEXT_DIRECTIVE, tool: 'code_context' },
    { prefix: CODE_IMPACT_DIRECTIVE, tool: 'code_impact' },
    { prefix: CODE_TRACE_DIRECTIVE, tool: 'code_trace' },
    { prefix: CODE_DETECT_CHANGES_DIRECTIVE, tool: 'code_detect_changes' },
    { prefix: CODE_RENAME_DIRECTIVE, tool: 'code_rename' },
  ];

  let result: ParsedCodeDirective | null = null;

  for (const { prefix, tool } of directives) {
    const pattern = new RegExp(`${prefix.replace(':', ':')}[ \\t]*([^\\n\\r]+)`, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1].trim();
      if (!raw) continue;
      // Parse args: either JSON or key=value pairs
      const args = parseArgs(raw);
      result = { tool, args };
    }
  }

  return result;
}

function parseArgs(raw: string): Record<string, string> {
  // Try JSON first
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        result[key] = String(value);
      }
      return result;
    }
  } catch {
    // Not JSON — try key=value
  }

  // Parse key=value pairs separated by spaces
  const args: Record<string, string> = {};
  const parts = raw.split(/\s+/);
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx > 0) {
      args[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    }
  }
  // If no key=value, treat the whole thing as the primary query/name
  if (Object.keys(args).length === 0) {
    args.query = raw;
  }
  return args;
}

// ── Result formatting (for injecting back into the conversation) ──

export function formatCodeQueryResult(
  hits: Array<{ name: string; kind: string; filePath: string; cluster?: string }>,
  corpusNodeCount?: number,
): string {
  if (hits.length === 0) return 'No matching symbols found in the code graph.';
  const lines = hits.map(h =>
    `  - ${h.name} [${h.kind}] → ${h.filePath}${h.cluster ? ` (cluster: ${h.cluster})` : ''}`,
  );
  const result = `Code graph query results:\n${lines.join('\n')}`;
  if (corpusNodeCount && corpusNodeCount > 0) {
    return wrapResultWithSavings(result, estimateCorpusSizeFromNodes(corpusNodeCount));
  }
  return result;
}

export function formatImpactResult(
  target: string,
  direction: string,
  levels: Array<{ depth: number; label: string; symbols: Array<{ name: string; kind: string; filePath: string; confidence: number }> }>,
  totalAffected: number,
  riskLevel: string,
  corpusNodeCount?: number,
): string {
  const lines = [`IMPACT ANALYSIS: ${target} (${direction})`];
  lines.push(`Risk: ${riskLevel.toUpperCase()} — ${totalAffected} symbols affected`);
  for (const level of levels) {
    lines.push(`\nDepth ${level.depth} (${level.label}):`);
    for (const sym of level.symbols) {
      lines.push(`  - ${sym.name} [${sym.kind}] → ${sym.filePath} (confidence: ${(sym.confidence * 100).toFixed(0)}%)`);
    }
  }
  const result = lines.join('\n');
  if (corpusNodeCount && corpusNodeCount > 0) {
    return wrapResultWithSavings(result, estimateCorpusSizeFromNodes(corpusNodeCount));
  }
  return result;
}

export function formatContextResult(
  name: string,
  context: {
    incoming: { calls: Array<{ name: string; filePath: string }>; imports: Array<{ name: string; filePath: string }> };
    outgoing: { calls: Array<{ name: string; filePath: string }>; imports: Array<{ name: string; filePath: string }> };
    processes: Array<{ name: string; step: number; total: number }>;
    cluster?: string;
  } | null,
  corpusNodeCount?: number,
): string {
  if (!context) return `Symbol "${name}" not found in the code graph.`;
  const lines = [`360° CONTEXT: ${name}`];
  if (context.cluster) lines.push(`Cluster: ${context.cluster}`);
  lines.push(`\nIncoming calls (${context.incoming.calls.length}):`);
  for (const c of context.incoming.calls) lines.push(`  ← ${c.name} → ${c.filePath}`);
  lines.push(`\nOutgoing calls (${context.outgoing.calls.length}):`);
  for (const c of context.outgoing.calls) lines.push(`  → ${c.name} → ${c.filePath}`);
  if (context.processes.length > 0) {
    lines.push(`\nExecution flows:`);
    for (const p of context.processes) lines.push(`  ${p.name} (step ${p.step}/${p.total})`);
  }
  const result = lines.join('\n');
  if (corpusNodeCount && corpusNodeCount > 0) {
    return wrapResultWithSavings(result, estimateCorpusSizeFromNodes(corpusNodeCount));
  }
  return result;
}
