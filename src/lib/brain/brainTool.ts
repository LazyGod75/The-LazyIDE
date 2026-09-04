/* brainTool — on-demand memory search tool definition + directive parsing.

   Exposes a generic `brain_search` tool the chat model can invoke mid-response
   (agentic retrieval, like an "@memory" command). The managed provider runs a
   client-side ReAct shim: it instructs the model to emit a single line

       BRAIN_SEARCH: <query>

   and nothing after it. After a streaming turn completes, the provider parses
   that directive (see parseBrainSearchDirective), recalls from the persistent
   brain, then continues a fresh turn with the results appended.

   Nothing here is tied to a specific brain implementation — the tool is a plain
   description + JSON schema, and the directive is plain text.
*/

import { getPlatform } from '../platform/index.js';
import type { ChatTool } from '../models/types.js';

/** Directive keyword the model emits to request a memory search. */
export const BRAIN_SEARCH_DIRECTIVE = 'BRAIN_SEARCH:';

/** Directive keywords the model emits to request a STRUCTURAL recall — the
 *  text-convention analogs of BRAIN_SEARCH_DIRECTIVE for the two structural
 *  tools (see BRAIN_QUERY_CSS_TOOL / BRAIN_NEIGHBOURS_TOOL below and
 *  parseBrainDirective). Same one-line-on-its-own convention. */
export const BRAIN_QUERY_CSS_DIRECTIVE = 'BRAIN_QUERY_CSS:';
export const BRAIN_NEIGHBOURS_DIRECTIVE = 'BRAIN_NEIGHBOURS:';

/** Default number of memory hits to recall for a tool search. */
export const BRAIN_SEARCH_DEFAULT_TOP = 8;

/**
 * The `brain_search` tool definition advertised to the model and threaded into
 * the system prompt grounding. Generic: "brain" here means whatever persistent
 * memory the platform is wired to.
 */
export const BRAIN_SEARCH_TOOL: ChatTool = {
  name: 'brain_search',
  description:
    'Search the persistent brain memory for notes, decisions, code context, and past conversations. ' +
    'Brain context for the current question is often ALREADY provided in the system prompt — answer from it directly when it suffices. ' +
    'Use this tool ONLY when that provided context does not contain what you need. ' +
    'Returns memory hits with #ids to cite.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The natural-language query to search the brain memory for.',
      },
      top: {
        type: 'number',
        description: 'Optional maximum number of memory hits to return.',
      },
    },
    required: ['query'],
  },
};

/** Returns true when the given tool list advertises the brain_search tool. */
export function hasBrainSearchTool(tools?: ReadonlyArray<ChatTool>): boolean {
  return Array.isArray(tools) && tools.some(tool => tool.name === BRAIN_SEARCH_TOOL.name);
}

// ── Structural recall tools ─────────────────────────────────────────────────
//
// brain_search is SEMANTIC (fuzzy vector recall). These two are STRUCTURAL:
// deterministic CSS-selector queries over the notes' data-cerveau-* attributes,
// plus a 1-hop graph follow — the original LazyBrain recall power. They execute
// through getPlatform().brain (Tauri: the brain_query_css / brain_neighbours
// Rust commands, which spawn the bundled `lazybrain query` / `lazybrain
// neighbours` CLI with the project brain pinned), exactly the way brain_search
// executes through getPlatform().brain.recallScoped().

/**
 * `brain_query_css` — deterministic structural memory query. The description
 * teaches the model the data-cerveau-* CSS vocabulary so it can form a selector.
 */
export const BRAIN_QUERY_CSS_TOOL: ChatTool = {
  name: 'brain_query_css',
  description:
    'Run a CSS selector over the project brain notes for a DETERMINISTIC, exact structural answer ' +
    '(use this, not brain_search, when the question is a precise set: "all active decisions", "all warnings", ' +
    '"notes touching a file path", "contradictions"). Each note is an <article> carrying data-cerveau-* attributes. ' +
    'Vocabulary: data-cerveau-type (decision|rule|episodic|...); data-cerveau-valid-until (PRESENT means stale/superseded — ' +
    'exclude it with :not([data-cerveau-valid-until]) for still-active notes); data-cerveau-saliency-kind (e.g. "contradiction"); ' +
    'data-cerveau-tier (working|archival); data-cerveau-confidence. Warnings/anti-patterns are <aside role="doc-warning">. ' +
    'File paths and code refs are <data value="src/..."> (use data[value*="src/auth"]). ' +
    'data-cerveau-tags (space-separated free-text tags — match a whole word with ~=, e.g. article[data-cerveau-tags~="bug"] for bug notes: ' +
    'this is the reliable way to find bugs today — the more specific per-item data-cerveau-kind="bug" tag is declared but not yet written by any capture path). ' +
    'data-cerveau-kind (decision|bug|rule|idea|qa|warning|activity — sparse in practice, prefer data-cerveau-tags for "bug" until a capture path populates it); ' +
    'data-cerveau-about (file:src/... — the file path this item is about); ' +
    'data-cerveau-author-id (uuid of author); data-cerveau-org-id (uuid of the team/org a note was captured under — team brains only, absent on solo notes); ' +
    'data-cerveau-dept (department slug — stamped from org membership on capture); ' +
    'data-cerveau-project (project slug); data-cerveau-status (resolved|open|...). ' +
    'Example: article[data-cerveau-type="decision"]:not([data-cerveau-valid-until]) → every decision still in force. ' +
    'article[data-cerveau-tags~="bug"] → every note tagged bug. ' +
    'article[data-cerveau-org-id="<uuid>"] → every note captured under that org. ' +
    '#fn-parsefile or [data-cerveau-symbol="parseFile"] → that function\'s JSDoc + head/tail body excerpt. ' +
    '#bind-nudgestyle → a type/const binding excerpt. Prefer these over dumping a whole file-neuron. ' +
    'Returns note #ids + text per hit; follow a hit with brain_neighbours.',
  input_schema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description:
          'A CSS selector applied per-note over the data-cerveau-* HTML, e.g. ' +
          'aside[role="doc-warning"] or [data-cerveau-saliency-kind="contradiction"].',
      },
      limit: {
        type: 'number',
        description: 'Optional max hits to return (default 50, capped at 200).',
      },
    },
    required: ['selector'],
  },
};

/**
 * `brain_neighbours` — follow a note's graph one hop. Chains from any hit id
 * returned by brain_query_css or brain_search.
 */
export const BRAIN_NEIGHBOURS_TOOL: ChatTool = {
  name: 'brain_neighbours',
  description:
    "Follow a note's graph: return the 1-hop neighbours of a note #id — supersession chains " +
    '(replaces / replaced-by / supersedes), triples, and shared entities/clusters — so you can chain from a hit ' +
    '("what replaced this decision?", "what else touches auth?"). Pass an id from a brain_query_css or brain_search hit ' +
    '(a leading # is optional). Example: brain_neighbours with id "decision-oauth-pkce-2026-06-01".',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The note id to expand (with or without a leading #).',
      },
    },
    required: ['id'],
  },
};

/** All structural recall tools, in the order they should be advertised. */
export const STRUCTURAL_BRAIN_TOOLS: ReadonlyArray<ChatTool> = [
  BRAIN_QUERY_CSS_TOOL,
  BRAIN_NEIGHBOURS_TOOL,
];

/** Returns true when the given tool list advertises EITHER structural tool
 *  (brain_query_css / brain_neighbours). Used to gate the structural-directive
 *  grounding in systemPrompts.ts, mirroring hasBrainSearchTool above. */
export function hasStructuralBrainTools(tools?: ReadonlyArray<ChatTool>): boolean {
  return (
    Array.isArray(tools) &&
    tools.some(
      tool => tool.name === BRAIN_QUERY_CSS_TOOL.name || tool.name === BRAIN_NEIGHBOURS_TOOL.name,
    )
  );
}

/**
 * Execute `brain_query_css` — deterministic CSS-selector recall over the brain.
 * Delegates to the platform brain (Tauri: the brain_query_css Rust command),
 * mirroring how brain_search recalls through getPlatform().brain. Never throws:
 * a backend failure is returned as an explanatory string so a tool loop keeps
 * making progress, same contract as recallForDirective.
 */
export async function runBrainQueryCss(selector: string, limit?: number): Promise<string> {
  const trimmed = selector.trim();
  if (!trimmed) return 'brain_query_css: empty selector — provide a CSS selector.';
  try {
    const out = (await getPlatform().brain.queryCss(trimmed, limit)).trim();
    return out || '0 matches';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `(brain_query_css unavailable: ${message})`;
  }
}

/**
 * Execute `brain_neighbours` — 1-hop graph follow for a note id. Delegates to
 * the platform brain (Tauri: the brain_neighbours Rust command). Never throws,
 * same contract as runBrainQueryCss.
 */
export async function runBrainNeighbours(id: string): Promise<string> {
  const trimmed = id.trim();
  if (!trimmed) return 'brain_neighbours: empty id — provide a note id.';
  try {
    const out = (await getPlatform().brain.neighbours(trimmed)).trim();
    return out || `(no neighbours for ${trimmed})`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `(brain_neighbours unavailable: ${message})`;
  }
}

/**
 * Parse a model turn for a `BRAIN_SEARCH: <query>` directive.
 *
 * Returns the trimmed query string when found, or null when the turn contains
 * no directive (i.e. the model produced a normal answer). Reasoning-channel
 * lines (prefixed with the reasoning escape) are stripped before matching, and
 * the LAST directive in the turn wins so a model that searches more than once
 * in a single emission still advances.
 */
export function parseBrainSearchDirective(text: string): string | null {
  if (!text.trim()) return null;

  // Match the directive ANYWHERE in the turn — reasoning-capable models often
  // emit it inline inside a reasoning-channel line (e.g.
  // "\x1b[reasoning]...BRAIN_SEARCH: how is auth built") with no leading
  // newline, so a strict line-start match (after stripping reasoning lines)
  // would miss it entirely. Capture to end-of-line; the LAST directive wins so
  // a model that searches more than once in one emission still advances.
  const pattern = /BRAIN_SEARCH:[ \t]*([^\n\r]+)/g;
  let match: RegExpExecArray | null;
  let query: string | null = null;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (candidate) query = candidate;
  }

  return query;
}

// ── Unified directive parsing (semantic + structural) ───────────────────────
//
// The text-convention ReAct loop recognizes THREE directives the model can
// emit — BRAIN_SEARCH: (semantic recall), BRAIN_QUERY_CSS: (deterministic
// CSS-selector query), and BRAIN_NEIGHBOURS: (1-hop graph follow). They share
// one canonical parse so every loop copy (brainSearchLoop.ts's two loops +
// managedProvider/managedProviderEvents) detects them identically.

/** The kind of a parsed brain directive. */
export type BrainDirectiveKind = 'search' | 'query_css' | 'neighbours';

export interface BrainDirective {
  kind: BrainDirectiveKind;
  /** Verbatim argument: a query (search), a CSS selector (query_css), or a
   *  note id (neighbours). Passed to the platform method as-is — the Rust side
   *  handles it safely (no shell). */
  arg: string;
}

const DIRECTIVE_KIND_BY_KEYWORD: Record<string, BrainDirectiveKind> = {
  SEARCH: 'search',
  QUERY_CSS: 'query_css',
  NEIGHBOURS: 'neighbours',
};

/**
 * Parse a model turn for ANY brain directive — BRAIN_SEARCH:, BRAIN_QUERY_CSS:,
 * or BRAIN_NEIGHBOURS: — and return the LAST one of any kind (so a model that
 * emits more than one directive in a single turn still advances), or null when
 * none is present.
 *
 * Matched ANYWHERE in the turn, not just at line start, for the same reason as
 * parseBrainSearchDirective above: reasoning-capable models often emit the
 * directive inline inside a reasoning-channel line with no leading newline.
 * A strict keyword list (no catch-all) keeps this from misfiring on prose that
 * merely says "search:".
 */
export function parseBrainDirective(text: string): BrainDirective | null {
  if (!text.trim()) return null;

  const pattern = /BRAIN_(SEARCH|QUERY_CSS|NEIGHBOURS):[ \t]*([^\n\r]+)/g;
  let match: RegExpExecArray | null;
  let directive: BrainDirective | null = null;
  while ((match = pattern.exec(text)) !== null) {
    const arg = match[2].trim();
    if (arg) directive = { kind: DIRECTIVE_KIND_BY_KEYWORD[match[1]], arg };
  }

  return directive;
}
