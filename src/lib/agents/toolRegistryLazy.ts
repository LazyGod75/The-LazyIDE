/* toolRegistryLazy — lazy tool-definition loading, layered on toolRegistry.ts.

   PROBLEM (recon): every surface's prompt included ALL tool defs on EVERY
   turn (toolRegistry.ts's buildToolSignatures() dumps all ~44 ACI-optimized
   descriptions into AGENT_SYSTEM_PROMPT, resent every ReAct step — see
   managedAgent.ts's per-step `system: lrSystemPrompt`). A mission that never
   touches git or MCP still paid for those tool defs every step. Modern
   harnesses (Claude Code, MCP tool-listing) instead show a small "core" set
   in full and defer the rest behind a lookup tool the model calls on demand.

   FIX: this module adds a metadata side-table (shortHint/tags/coreFor) per
   tool, kept in its OWN file (rather than inlined into toolRegistry.ts's ~45
   ToolDef literals, or grown inline in that already-~700-line file) —
   mirrors this codebase's established split convention for file-size
   cohesion (see managedAgentPolicy.ts's header: "Extracted from
   managedAgent.ts to keep that file under the project's 800-line ceiling").
   TOOL_META + toolRegistry.ts's ALL_TOOLS together ARE the "central registry
   {name, shortHint, fullDefinition, tags, coreFor}" the founder asked for —
   REGISTERED_TOOLS below is the merged view other rosters (assistantTools.ts)
   key off of.

   toolRegistry.ts's buildToolSignatures() is UNCHANGED (still renders every
   tool, in full) — nothing here alters its behavior. buildLazyToolBlock is
   the NEW entry point: core tools' full defs + a one-line index of the rest
   + the find_tool meta-tool (itself always core, defined in
   toolRegistry.ts's ORCHESTRATION_TOOLS) to fetch a non-core tool's full
   definition on demand.

   One-directional dependency: this module imports FROM toolRegistry.ts
   (ALL_TOOLS, ToolDef, renderToolSignatures) and is imported BY
   managedAgentPolicy.ts, toolRuntime.ts, managedAgent.ts, assistantTools.ts,
   assistantToolLoop.ts — never the other way around.
*/

import { ALL_TOOLS, renderToolSignatures } from './toolRegistry.js';
import type { ToolDef } from './toolRegistry.js';

// ── Vocabulary ────────────────────────────────────────────────────────

/** Fixed vocabulary the founder specified — kept small and orthogonal to
 *  ToolCategory (which groups by mechanism: navigation/edit/exec/... — tags
 *  group by DOMAIN, for suggestTools' keyword matching and find_tool's tag
 *  lookup). A tool may carry more than one tag (e.g. browser_screenshot is
 *  both 'web' and 'vision'). */
export type ToolTag = 'front' | 'web' | 'git' | 'brain' | 'files' | 'vision';

/** The three AI surfaces a tool's full definition can be "core" for — mirrors
 *  toolProfiles.ts's SurfaceName but named for THIS module's own vocabulary
 *  (mission = agent/managedAgent ReAct loop, codeur = assistant chat,
 *  manager = LazyManager). Declared independently rather than importing
 *  toolProfiles.ts's SurfaceName to avoid a cycle — toolProfiles.ts already
 *  imports FROM toolRegistry.ts/this module. */
export type ToolSurface = 'mission' | 'codeur' | 'manager';

export interface ToolMeta {
  /** ≤10-word summary shown in the lazy-loaded index line — NOT the full
   *  ACI-optimized description (that stays in ToolDef.description, fetched
   *  in full via find_tool for non-core tools). */
  shortHint: string;
  tags: ToolTag[];
  /** Surfaces whose prompt should show this tool's FULL definition inline,
   *  always — never just the index line. Empty for a tool that is always
   *  lazy-loaded everywhere. */
  coreFor: ToolSurface[];
}

/** The merged registry entry — ToolDef (mechanism) + ToolMeta (lazy-load
 *  metadata). This is the "central registry" other rosters read from. */
export interface RegisteredTool extends ToolDef, ToolMeta {}

// ── Metadata table ────────────────────────────────────────────────────

/** Metadata for every tool in ALL_TOOLS — kept in the SAME name-set as a
 *  registry-integrity invariant (see toolRegistry.test.ts's "every tool has
 *  metadata" test). Ordering mirrors toolRegistry.ts's category grouping. */
const TOOL_META: Record<string, ToolMeta> = {
  // Navigation
  read_file: { shortHint: 'Read a windowed file view with line numbers', tags: ['files'], coreFor: ['mission', 'codeur', 'manager'] },
  read_dir: { shortHint: 'List a directory\'s immediate children', tags: ['files'], coreFor: ['mission', 'codeur', 'manager'] },
  find_file: { shortHint: 'Find files repo-wide by name/glob pattern', tags: ['files'], coreFor: ['mission', 'manager'] },
  search_code: { shortHint: 'Search file contents repo-wide via ripgrep', tags: ['files'], coreFor: ['mission', 'codeur', 'manager'] },
  search_symbols: { shortHint: 'Find where a function/class/type is defined', tags: ['files'], coreFor: ['manager'] },
  goto_definition: { shortHint: 'Jump to a symbol\'s definition via LSP', tags: ['files'], coreFor: ['manager'] },
  find_references: { shortHint: 'Find all references to a symbol via LSP', tags: ['files'], coreFor: ['manager'] },
  get_diagnostics: { shortHint: 'Get LSP errors/warnings for a file or project', tags: ['files'], coreFor: ['manager'] },
  // Edit
  edit_file: { shortHint: 'Replace an exact string in a file', tags: ['files'], coreFor: ['mission'] },
  multi_edit: { shortHint: 'Apply several edits to one file atomically', tags: ['files'], coreFor: ['mission'] },
  write_file: { shortHint: 'Create a file or rewrite it entirely', tags: ['files'], coreFor: ['mission'] },
  undo_edit: { shortHint: 'Undo the last edit/write on a file', tags: ['files'], coreFor: [] },
  rename_file: { shortHint: 'Rename or move a file', tags: ['files'], coreFor: [] },
  delete_file: { shortHint: 'Delete a file or directory recursively', tags: ['files'], coreFor: [] },
  // Exec
  run_command: { shortHint: 'Run a shell command in the worktree', tags: ['files'], coreFor: ['mission'] },
  run_tests: { shortHint: 'Run the project test suite (auto-detected)', tags: ['files'], coreFor: ['mission'] },
  run_lint: { shortHint: 'Run the project linter (auto-detected)', tags: ['files'], coreFor: [] },
  run_build: { shortHint: 'Run the project build (auto-detected)', tags: ['files'], coreFor: [] },
  // Git
  git_status: { shortHint: 'Show working tree status (modified/added/untracked)', tags: ['git'], coreFor: ['mission', 'codeur', 'manager'] },
  git_diff: { shortHint: 'Show a unified diff of changes', tags: ['git'], coreFor: ['mission', 'codeur', 'manager'] },
  git_log: { shortHint: 'Show recent commit history', tags: ['git'], coreFor: ['codeur', 'manager'] },
  git_commit: { shortHint: 'Stage files and commit with a message', tags: ['git'], coreFor: [] },
  review_diff: { shortHint: 'Review all mission changes before FINAL', tags: ['git'], coreFor: ['mission', 'manager'] },
  git_create_pr: { shortHint: 'Push the branch and open a GitHub PR', tags: ['git'], coreFor: [] },
  // Web
  web_search: { shortHint: 'Search the web for current information', tags: ['web'], coreFor: ['codeur', 'manager'] },
  web_fetch: { shortHint: 'Fetch a URL as clean, structured HTML', tags: ['web'], coreFor: ['codeur', 'manager'] },
  // coreFor: ['mission'] ONLY (not codeur/manager, unlike web_fetch) — this
  // tool exists to fix the mission self-verification failure class (dead
  // ad-hoc server / find_tool round-trips burning the loop); always-visible
  // there is the point. The other surfaces don't have that failure mode, so
  // extending their toolProfiles.ts allow-list is a separate, out-of-scope
  // product decision, not silently bundled in here.
  check_url: { shortHint: 'Check a URL responds and optionally contains text', tags: ['web'], coreFor: ['mission'] },
  // Brain
  brain_query: { shortHint: 'Semantic fuzzy recall over project memory', tags: ['brain'], coreFor: ['mission', 'manager'] },
  brain_query_css: { shortHint: 'Deterministic CSS-selector recall over notes', tags: ['brain'], coreFor: ['manager'] },
  brain_neighbours: { shortHint: 'Follow a note\'s 1-hop supersession/entity graph', tags: ['brain'], coreFor: ['manager'] },
  brain_record: { shortHint: 'Record a discovery/success/failure to memory', tags: ['brain'], coreFor: ['mission'] },
  brain_synthesize: { shortHint: 'Summarize many brain hits into one view', tags: ['brain'], coreFor: ['manager'] },
  // Transform (W-CODE)
  list_transforms: { shortHint: 'List user-authored sandboxed JS transform tools', tags: ['files'], coreFor: [] },
  run_transform: { shortHint: 'Run one sandboxed JSON-in/JSON-out transform', tags: ['files'], coreFor: [] },
  // MCP
  mcp_list_tools: { shortHint: 'List tools from connected MCP servers', tags: ['web'], coreFor: [] },
  mcp_call: { shortHint: 'Call a tool on a connected MCP server', tags: ['web'], coreFor: [] },
  // Browser (visible Playwright automation)
  browser_open: { shortHint: 'Open a visible browser window for automation', tags: ['web', 'front'], coreFor: [] },
  browser_navigate: { shortHint: 'Navigate the open browser to a URL', tags: ['web', 'front'], coreFor: [] },
  browser_click: { shortHint: 'Click an element by selector, text, or ref', tags: ['web', 'front'], coreFor: [] },
  browser_fill: { shortHint: 'Fill an input field in the browser', tags: ['web', 'front'], coreFor: [] },
  browser_screenshot: { shortHint: 'Capture a description of the page state', tags: ['web', 'front', 'vision'], coreFor: [] },
  browser_snapshot: { shortHint: 'Get an accessibility-tree snapshot of the page', tags: ['web', 'front', 'vision'], coreFor: [] },
  browser_close: { shortHint: 'Close the browser window and clean up', tags: ['web', 'front'], coreFor: [] },
  // Orchestration
  delegate: { shortHint: 'Delegate a read-only sub-task to a sub-agent', tags: [], coreFor: [] },
  ask_user: { shortHint: 'Ask the human a clarifying question', tags: [], coreFor: ['mission', 'manager'] },
  find_tool: { shortHint: 'Look up a non-core tool\'s full definition', tags: [], coreFor: ['mission', 'codeur', 'manager'] },
};

/** Merged {ToolDef + ToolMeta} view, in ALL_TOOLS order — the actual "single
 *  source of truth" other rosters (assistantTools.ts) key off of. A tool
 *  missing from TOOL_META falls back to a derived meta rather than throwing —
 *  see the registry-integrity test for what actually enforces completeness
 *  (never silently ships a real gap unnoticed). */
export const REGISTERED_TOOLS: readonly RegisteredTool[] = ALL_TOOLS.map((tool) => {
  const meta = TOOL_META[tool.name] ?? { shortHint: tool.description.slice(0, 60), tags: [], coreFor: [] };
  return { ...tool, ...meta };
});

const REGISTERED_BY_NAME = new Map(REGISTERED_TOOLS.map((t) => [t.name, t]));

/** Get the merged {ToolDef + ToolMeta} entry for one tool by name. */
export function getRegisteredTool(name: string): RegisteredTool | undefined {
  return REGISTERED_BY_NAME.get(name);
}

// ── Core/index split ──────────────────────────────────────────────────

/** Approximate chars-per-token used for the honest before/after budget
 *  telemetry below — same ceil(chars/4) convention as brain/context.ts's
 *  estimateTokens, duplicated locally (not imported) so this module stays a
 *  dependency-free leaf alongside toolRegistry.ts. */
const CHARS_PER_TOKEN = 4;

/** Tool names always shown in full for a surface, regardless of coreFor —
 *  find_tool itself must always be fully defined, or the model has no way to
 *  learn how to call it. */
const ALWAYS_CORE = new Set(['find_tool']);

/** Resolves which tool names are "core" (full def shown) vs. "index-only"
 *  (one-line hint, fetchable via find_tool) for a surface, given an optional
 *  extra preload list (suggestTools' heuristic hits, or a caller-specified
 *  override) — unknown names in extraNames are ignored rather than throwing,
 *  since suggestTools/callers may pass a name that doesn't (yet) exist. */
function resolveCoreNames(
  surface: ToolSurface,
  extraNames: readonly string[] = [],
): { core: Set<string>; index: RegisteredTool[] } {
  const core = new Set<string>(ALWAYS_CORE);
  for (const t of REGISTERED_TOOLS) {
    if (t.coreFor.includes(surface)) core.add(t.name);
  }
  for (const name of extraNames) {
    if (REGISTERED_BY_NAME.has(name)) core.add(name);
  }
  const index = REGISTERED_TOOLS.filter((t) => !core.has(t.name));
  return { core, index };
}

/** Honest before/after budget for one surface's tool-definitions block —
 *  "before" = every tool's full def (the pre-existing, always-everything
 *  behavior); "after" = this surface's actual core+index lazy block. Both
 *  computed from the SAME renderer so the comparison is apples-to-apples. */
export interface ToolPromptBudget {
  surface: ToolSurface;
  totalTools: number;
  coreCount: number;
  indexCount: number;
  charsFull: number;
  charsLazy: number;
  tokensApproxFull: number;
  tokensApproxLazy: number;
  /** Rounded percent reduction in the tool-definitions block size (0 when charsFull is 0). */
  savingsPct: number;
}

export interface LazyToolBlock {
  /** The assembled prompt text: core tools' full defs + the non-core index. */
  text: string;
  coreNames: string[];
  indexNames: string[];
  budget: ToolPromptBudget;
}

/**
 * Builds the lazy-loaded tool-definitions block for one surface: core tools'
 * full ACI-optimized definitions, followed by a one-line index (name +
 * shortHint) for every other registered tool, which the model can expand via
 * find_tool. Pairs with toolRegistry.ts's buildToolSignatures(), which still
 * renders everything in full and is unchanged — this is the new, token-saving
 * path.
 */
export function buildLazyToolBlock(
  surface: ToolSurface,
  overlays?: Map<string, string>,
  extraToolNames: readonly string[] = [],
): LazyToolBlock {
  const { core, index } = resolveCoreNames(surface, extraToolNames);
  const coreTools = ALL_TOOLS.filter((t) => core.has(t.name));
  const coreSigs = renderToolSignatures(coreTools, overlays);
  const sortedIndex = [...index].sort((a, b) => a.name.localeCompare(b.name));
  const indexLines = sortedIndex.map((t) => `- ${t.name}: ${t.shortHint}`).join('\n');

  const sections = [
    'Tool signatures (core — full definitions, always shown):',
    coreSigs,
  ];
  if (sortedIndex.length > 0) {
    sections.push(
      'Other available tools (one-line hint only — call find_tool with the exact name, ' +
      'a tag, or a keyword to get the full definition BEFORE using one of these for the first time):',
      indexLines,
    );
  }
  const text = sections.join('\n');

  const charsFull = renderToolSignatures(ALL_TOOLS, overlays).length;
  const charsLazy = text.length;
  const savingsPct = charsFull > 0 ? Math.round((1 - charsLazy / charsFull) * 100) : 0;

  return {
    text,
    coreNames: [...core].sort(),
    indexNames: sortedIndex.map((t) => t.name),
    budget: {
      surface,
      totalTools: ALL_TOOLS.length,
      coreCount: core.size,
      indexCount: sortedIndex.length,
      charsFull,
      charsLazy,
      tokensApproxFull: Math.ceil(charsFull / CHARS_PER_TOKEN),
      tokensApproxLazy: Math.ceil(charsLazy / CHARS_PER_TOKEN),
      savingsPct,
    },
  };
}

/** Convenience accessor when only the telemetry numbers are needed (e.g. for
 *  a journal event), without re-deriving them from a separately-built block —
 *  computed via the exact same buildLazyToolBlock so the reported savings
 *  always match what was actually sent. */
export function getToolPromptBudget(
  surface: ToolSurface,
  overlays?: Map<string, string>,
  extraToolNames: readonly string[] = [],
): ToolPromptBudget {
  return buildLazyToolBlock(surface, overlays, extraToolNames).budget;
}

// ── find_tool (the on-demand lookup meta-tool) ─────────────────────────

/**
 * Finds tools matching a free-text query — exact name match first, then
 * name-substring, then tag, then a keyword found in the shortHint or full
 * description. Returns at most 5 matches, most-specific match tier first.
 * Pure and case-insensitive; used by both find_tool's execution
 * (toolRuntime.ts) and its own tests.
 */
export function findTool(query: string): RegisteredTool[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const exact = REGISTERED_TOOLS.find((t) => t.name.toLowerCase() === q);
  if (exact) return [exact];

  const byName = REGISTERED_TOOLS.filter((t) => t.name.toLowerCase().includes(q));
  if (byName.length > 0) return byName.slice(0, 5);

  const byTag = REGISTERED_TOOLS.filter((t) => t.tags.some((tag) => tag === q));
  if (byTag.length > 0) return byTag.slice(0, 5);

  const byKeyword = REGISTERED_TOOLS.filter(
    (t) => t.shortHint.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
  );
  return byKeyword.slice(0, 5);
}

/** Renders find_tool's result as the model observation string. */
export function formatFindToolResult(query: string): string {
  const matches = findTool(query);
  if (matches.length === 0) {
    return `No tool found matching "${query}". Try an exact tool name, or a keyword/tag like "git", "brain", "browser", "web".`;
  }
  return renderToolSignatures(matches, undefined);
}

// ── suggestTools (the BRAIN preload hook) ──────────────────────────────

/**
 * suggestTools — the BRAIN hook: a cheap, pure keyword/tag heuristic mapping
 * a mission's task text to tool names worth preloading in FULL at mission
 * start, alongside the surface's own core set (e.g. a title mentioning
 * "site"/"deploy the web app" preloads web_search/web_fetch; "push"/"open a
 * PR" preloads git_commit/git_create_pr). Deliberately NOT ML — a small,
 * inspectable rule table, easily replaced by a real classifier later without
 * changing its signature (taskText in, tool names out).
 */
const SUGGEST_RULES: ReadonlyArray<{ pattern: RegExp; tools: readonly string[] }> = [
  { pattern: /\b(site|website|web ?app|internet|url|api docs?|documentation|recherche web)\b/i, tools: ['web_search', 'web_fetch'] },
  { pattern: /\b(push|pousser|pull request|\bpr\b|release|publier|publish|merge)\b/i, tools: ['git_commit', 'git_create_pr', 'git_log'] },
  { pattern: /\b(screenshot|capture|visuel|visual|e2e|browser|navigateur|click|clique|playwright)\b/i, tools: ['browser_open', 'browser_navigate', 'browser_snapshot', 'browser_screenshot'] },
  { pattern: /\b(test|tests?unitaires?|spec|tdd)\b/i, tools: ['run_tests'] },
  { pattern: /\b(lint|eslint|style)\b/i, tools: ['run_lint'] },
  { pattern: /\b(build|compile|compiler|bundle)\b/i, tools: ['run_build'] },
  { pattern: /\b(symbol|symbole|definition|définition|refactor|references?|référence)\b/i, tools: ['search_symbols', 'goto_definition', 'find_references'] },
  { pattern: /\b(diagnostic|type ?error|erreur de type|tsc)\b/i, tools: ['get_diagnostics'] },
  { pattern: /\b(transform|w-code)\b/i, tools: ['list_transforms', 'run_transform'] },
  { pattern: /\b(undo|annuler|revert)\b/i, tools: ['undo_edit'] },
  { pattern: /\b(rename|renommer|move file|déplacer)\b/i, tools: ['rename_file'] },
  { pattern: /\b(delete|supprimer|remove file)\b/i, tools: ['delete_file'] },
  { pattern: /\b(mcp|slack|notion|sentry|linear|figma|datadog)\b/i, tools: ['mcp_list_tools', 'mcp_call'] },
  { pattern: /\b(structural recall|css selector|contradiction|active decisions?)\b/i, tools: ['brain_query_css', 'brain_neighbours'] },
];

export function suggestTools(taskText: string): string[] {
  if (!taskText || !taskText.trim()) return [];
  const hits = new Set<string>();
  for (const rule of SUGGEST_RULES) {
    if (rule.pattern.test(taskText)) {
      for (const name of rule.tools) {
        if (REGISTERED_BY_NAME.has(name)) hits.add(name);
      }
    }
  }
  return [...hits];
}
