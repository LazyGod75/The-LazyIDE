/* systemPrompts — shared system-prompt assembly for all chat providers.
   Single source of truth for mode base prompts, rules injection, brain
   context, and the epistemic guardrail. Providers must NOT define their own
   per-mode prompt maps.
*/

import { buildRulesSystemPrompt } from '../ai/lazyRules.js';
import { buildPromptBrainContext } from '../brain/context.js';
import { hasBrainSearchTool, hasStructuralBrainTools } from '../brain/brainTool.js';
import { hasToolDirectives } from './toolDirectiveNames.js';
import { applyOutputStyles, type OutputStyleSelectionEntry } from '../assistant/outputStyles.js';
import type { BrainRecallResult } from '../platform/types.js';
import type { ChatMode, ChatTool } from './types.js';

// ── Epistemic guardrail ───────────────────────────────────────────────────────
// Exported so tests or callers can assert on the exact text.
export const EPISTEMIC_GUARDRAIL =
  'IMPORTANT: If you do not have brain/memory context that answers a factual question about this project, say so explicitly rather than answering from general training knowledge or guessing.';

// ── Tool grounding ─────────────────────────────────────────────────────────────
// Exported so tests can assert the exact instruction is injected when the
// brain_search tool is offered.
export const BRAIN_SEARCH_GROUNDING =
  'The project/brain memory context for this question is often ALREADY provided above — read it and ANSWER DIRECTLY from it, citing #ids. ' +
  'Only when that provided context does NOT contain what you need, emit a single line `BRAIN_SEARCH: <query>` on its own line (nothing after it) to fetch more, then answer. ' +
  'Do not narrate that you are searching, and do not emit BRAIN_SEARCH if you can already answer.';

// ── Structural tool grounding ───────────────────────────────────────────────
// Teaches the directive-line syntax for the two STRUCTURAL recall tools. These
// text-convention providers (managed proxy / CLI backends) do NOT render tool
// JSON schemas to the model — a tool is "callable" only if its directive line
// is taught in the prompt text — so advertising brain_query_css /
// brain_neighbours in opts.tools is inert without this. Injected only when
// those tools are actually offered (assistant chat, once the shared ReAct loop
// can fire the directives — see brainSearchLoop.ts), mirroring
// BRAIN_SEARCH_GROUNDING above. Exported so tests can assert exact presence.
export const STRUCTURAL_BRAIN_GROUNDING =
  'For a DETERMINISTIC, exact set (every active decision, every warning, notes touching a file path, contradictions), you can instead emit a single line ' +
  '`BRAIN_QUERY_CSS: <css-selector>` on its own line — a CSS selector over the notes\' data-cerveau-* attributes, ' +
  'e.g. article[data-cerveau-type="decision"]:not([data-cerveau-valid-until]) for live decisions, aside[role="doc-warning"] for warnings, or data[value*="src/auth"] for a file path. ' +
  'Use data-cerveau-tags~="bug" (whole-word tag match) for bug notes — the reliable selector today, since the more specific per-item data-cerveau-kind="bug" is declared ' +
  'but not yet written by any capture path. Use data-cerveau-about for file-scoped queries, ' +
  'e.g. article[data-cerveau-tags~="bug"][data-cerveau-about="file:src/payments/stripe.ts"] for bugs on a specific file. ' +
  'Use data-cerveau-org-id="<uuid>" to scope to a team/org (team brains only) and data-cerveau-dept for a department once that field is populated. ' +
  'To follow a note\'s graph one hop (supersession chains, shared entities), emit `BRAIN_NEIGHBOURS: <note-id>` with an #id from a prior hit. ' +
  'Same rules as BRAIN_SEARCH: the directive goes alone on its own line with nothing after it, do not narrate, and only when the provided context is insufficient. Then answer from the hits, citing #ids.';

// ── Assistant tool grounding ─────────────────────────────────────────────────
// Teaches the directive-line syntax for general tools (web_search, web_fetch,
// read_file, etc.) available on the assistant surface. Injected when any of
// those tools are advertised in opts.tools.
export const ASSISTANT_TOOL_GROUNDING =
  'You have access to additional tools beyond brain memory. Emit a directive on its own line (nothing after it) to use one:\n' +
  '- `WEB_SEARCH: <query>` — search the web for current information.\n' +
  '- `WEB_FETCH: <url>` — fetch the content of a web page.\n' +
  '- `READ_FILE: <relative/path>` — read a file from the project (100 lines default).\n' +
  '- `READ_DIR: <relative/path>` — list directory contents.\n' +
  '- `SEARCH_CODE: <regex pattern>` — search code across the project with ripgrep.\n' +
  '- `GIT_STATUS:` — show git working tree status.\n' +
  '- `GIT_DIFF: <path>` — show git diff for a file (or all changes if path is empty).\n' +
  '- `GIT_LOG: <count>` — show recent git commits (default 10).\n' +
  '- `FIND_TOOL: <name or keyword>` — look up the fuller usage details of one of the tools above (rarely needed; only when its one-line description here left you unsure how to call it).\n' +
  'Use these ONLY when the answer is not already in the provided context or brain memory. ' +
  'After the tool returns results, use them to write your answer. Do not narrate that you are using a tool — just emit the directive line.';

// ── Tool policy ────────────────────────────────────────────────────────────────
// R11 — injected when tools are offered, before the epistemic guardrail.
export const TOOL_POLICY =
  'TOOL USAGE POLICY: Answer from the brain/memory context already provided when it is sufficient. ' +
  'Use brain_search ONLY when that context lacks the answer — never for general programming knowledge. ' +
  'Prefer precise targeted queries, and cite brain results with #id references.';

// ── Recall teaching ───────────────────────────────────────────────────────────
// Condensed from the original LazyBrain recall recipe: WHEN to consult project
// memory, HOW to query it (topic/entity extraction, not the user's verbatim
// sentence), HOW to interpret what comes back (citations, staleness, confidence,
// tier, anti-patterns), and — now that the structural tools actually exist in
// the app — WHEN to reach for DETERMINISTIC structural recall instead of fuzzy
// search.
//
// Still agnostic about the SEMANTIC-search MECHANISM: it never names
// "brain_search"/"brain_query", because that concrete syntax differs per surface
// (BRAIN_SEARCH_GROUNDING's directive here, the ACTION: brain_query contract in
// managedAgentPolicy.ts, the conditional brain_search MCP hint in runtime.ts,
// the brain_query JSON action in managerEngine.ts) and each surface teaches its
// own. It DOES now name brain_query_css / brain_neighbours: unlike the semantic
// path, those have ONE canonical spelling shared across every surface that wired
// them (the managed-agent ACTION dispatcher in managedAgent.ts and the native
// brain-MCP server brain-search-server.mjs), and naming them is the whole point
// of finally exposing the CSS-selector + graph-hop recall power. On a surface
// that does not (yet) offer them as callable tools — e.g. the assistant's
// free-text BRAIN_SEARCH loop — the guidance still teaches the SHAPE of a good
// structural request. Exported so every surface wires the identical string in
// and tests can assert exact presence.
export const RECALL_TEACHING = `MEMORY RECALL — when and how to use project memory:
- WHEN: check memory when the user references past work ("did we", "have we", "earlier", "previously", "last time"; FR "déjà", "comme on a vu", "on avait dit"), a past decision/commit/branch/library choice, or a recurring problem (auth, deploy, migration). Also check proactively at the start of a non-trivial task in a familiar project. Skip trivial messages ("ok", "thanks", "oui").
- HOW TO QUERY: extract the TOPIC/entities, not the user's verbatim sentence — e.g. "why did we switch off Postgres" -> search "postgres sqlite migration". Only search when the context already provided does not contain the answer.
- STRUCTURAL vs SEMANTIC: for a deterministic, exact SET — "every decision still active", "every warning", "notes touching a file path", "contradictions" — use brain_query_css with a CSS selector over the data-cerveau-* attributes instead of a fuzzy search: e.g. article[data-cerveau-type="decision"]:not([data-cerveau-valid-until]) for live decisions, aside[role="doc-warning"] for warnings, data[value*="src/auth"] for a path. Use data-cerveau-tags~="bug" for bug notes (whole-word tag match — the reliable selector today; the more specific data-cerveau-kind="bug" is declared but not yet written by any capture path) and data-cerveau-about for file-scoped queries (e.g. article[data-cerveau-about="file:src/payments/stripe.ts"]). Use data-cerveau-org-id="<uuid>" to scope a team brain to one org. For HOW a named function/const/type is implemented, prefer #fn-<slug> (functions) or #bind-<slug> (type/const) or [data-cerveau-symbol="ExactName"] — those hits already carry JSDoc + a head/tail body excerpt; do not dump the whole file-neuron. Follow any hit's graph with brain_neighbours (what replaced it, what else shares its entities). Where these are offered as tools, call them; otherwise treat this as the shape of a precise structural request.
- HOW TO USE RESULTS: cite facts with their #id. A note marked superseded or carrying a valid-until date is stale — do not trust it. Confidence below 0.5 is unreliable. Prefer working-tier notes over archival for current state. Treat anti-pattern/doc-warning notes as "do not redo this". Quote the relevant fact — never dump raw results.`;

// ── Per-mode base prompts ─────────────────────────────────────────────────────
const MODE_BASE_PROMPTS: Record<ChatMode, string> = {
  ask:  'You are a helpful read-only coding assistant. Answer questions about the code; you cannot modify files.',
  plan: 'You are a senior software architect. Investigate the codebase and return a concise numbered implementation plan; do NOT modify any files.',
  edit: 'You are a coding assistant with full file access. Apply the requested changes directly using your tools, then briefly summarize what you changed.',
  // Single-shot, non-agentic code transform (Ctrl+K inline-edit, auto-fix —
  // see InlineEditBar.tsx / autoFix.ts). Deliberately NOT the 'edit' prompt
  // above: the caller treats the entire response as literal replacement
  // code, so any tool use or narration corrupts the file. Wording is
  // model-agnostic (no backend-specific terms) since it flows through every
  // provider — see systemPrompts.ts header and codeOutputSanitizer.ts for
  // the output-side guard that fails safe if a backend narrates anyway.
  transform:
    'You are a precise code transformation function, not an autonomous agent. ' +
    'You are given a code snippet and an instruction. ' +
    'Respond with ONLY the replacement code for that snippet, ready to paste in verbatim — nothing else. ' +
    'Do not use any tools (no file reads, no file writes, no search, no shell commands). ' +
    'Do not explain, narrate, plan, or describe what you are doing or did. Do not restate the instruction. ' +
    'Do not wrap the code in markdown fences. Your entire response must be the replacement code and nothing more.',
};

// ── Options ───────────────────────────────────────────────────────────────────

export interface BuildSystemPromptOpts {
  /** Raw rules text from a .lazyrules file, if present. */
  rulesContext?: string | null;
  /** Startup context from the brain's highlights mode — injected only on the first user turn. */
  startupContext?: string;
  /** Semantic skill injection — skills relevant to the user's message, loaded from the brain. */
  skillContext?: string;
  /** Tools the model may invoke this turn. When brain_search is present, a
      grounding line teaching the BRAIN_SEARCH directive is appended. */
  tools?: ChatTool[];
  /**
   * Whether the CALLING provider actually intercepts and executes the
   * directive lines (BRAIN_SEARCH, BRAIN_QUERY_CSS, BRAIN_NEIGHBOURS,
   * WEB_SEARCH, READ_FILE, ...) this prompt would otherwise teach — i.e. it
   * runs assistantToolLoop.ts's withAssistantToolLoop/withAssistantToolLoopEvents
   * (or brainSearchLoop.ts's variants, for a brain-only caller). Every
   * real chat provider that DOES (anthropicProvider, claudeCodeProvider,
   * cliBackendProvider, managedProvider) passes `true` explicitly.
   *
   * Defaults to TRUE when omitted — existing callers are unaffected — with
   * ONE deliberate opt-out today: webAnthropicProvider.ts passes `false`
   * because it streams raw SSE text with no ReAct loop to intercept
   * anything it might emit. A fail-OPEN default (rather than fail-closed)
   * was chosen to avoid touching every existing call site/test under time
   * pressure; a future provider that forgets to wire a loop will NOT be
   * caught by this flag alone — see the invariant this exists to protect:
   * a provider must never be taught directive syntax it cannot execute
   * (root cause of the 2026-07 managed-provider READ_FILE hallucination
   * defect — see managedProvider.ts's header for the full incident).
   */
  supportsToolLoop?: boolean;
  /** Selected output styles to inject into the system prompt (terse prose, less code, etc.). */
  outputStyles?: OutputStyleSelectionEntry[];
}

// ── Public assembler ──────────────────────────────────────────────────────────

/**
 * Assemble the full system prompt in order:
 *   (a) per-mode base prompt
 *   (b) project rules (if opts.rulesContext is present)
 *   (c) startup context from brain highlights mode (first turn only, before per-turn recall)
 *   (d) brain context block (if brainRecall is non-empty)
 *   (e) tool policy (if opts.tools is non-empty)
 *   (f) tool grounding (if opts.tools advertises brain_search)
 *   (g) recall teaching — when/how to consult and interpret memory (every
 *       mode except 'transform', whose entire response is treated as literal
 *       replacement code — see MODE_BASE_PROMPTS.transform's doc comment)
 *   (h) epistemic guardrail (always last)
 *
 * When brain context is present a short grounding line is also appended
 * before the guardrail, directing the model to treat that context as the
 * primary source for project-specific questions.
 */
export function buildSystemPrompt(
  mode: ChatMode,
  brainRecall: BrainRecallResult | null | undefined,
  opts: BuildSystemPromptOpts = {},
): string {
  const parts: string[] = [];

  // (a) base prompt
  parts.push(MODE_BASE_PROMPTS[mode] ?? MODE_BASE_PROMPTS.ask);

  // (b) project rules
  const rulesBlock = buildRulesSystemPrompt(opts.rulesContext ?? null);
  if (rulesBlock) {
    parts.push(rulesBlock);
  }

  // (c) startup context (brain highlights, first turn only)
  if (opts.startupContext && opts.startupContext.trim()) {
    parts.push(
      'Recent project context (recent sessions + salient notes):\n' +
      `<brain_startup_context>\n${opts.startupContext.trim()}\n</brain_startup_context>`,
    );
  }

  // (d) brain context (per-turn recall)
  const brainBlock = buildPromptBrainContext(brainRecall);
  if (brainBlock) {
    parts.push(brainBlock);
    parts.push(
      'The project memory context above is your primary source for project-specific questions. Prefer it over general training knowledge when answering questions about this codebase.',
    );
  }

  // (d-bis) skill context — semantic skill injection from the brain
  if (opts.skillContext && opts.skillContext.trim()) {
    parts.push(opts.skillContext.trim());
  }

  // Gate every directive-teaching section below on the calling provider
  // actually being able to run the loop that intercepts what it teaches —
  // see supportsToolLoop's doc comment. Fails OPEN (true) when omitted.
  const toolLoopCapable = opts.supportsToolLoop !== false;

  // (e) tool policy — injected when any tools are offered
  if (opts.tools && opts.tools.length > 0 && toolLoopCapable) {
    parts.push(TOOL_POLICY);
  }

  // (f) tool grounding — teach the on-demand memory-search directive.
  if (toolLoopCapable && hasBrainSearchTool(opts.tools)) {
    parts.push(BRAIN_SEARCH_GROUNDING);
  }

  // (f2) structural tool grounding — teach the deterministic CSS-query and
  // graph-hop directives when those tools are offered (assistant chat only).
  if (toolLoopCapable && hasStructuralBrainTools(opts.tools)) {
    parts.push(STRUCTURAL_BRAIN_GROUNDING);
  }

  // (f3) assistant tool grounding — teach the directive-line syntax for
  // general tools (web_search, read_file, etc.) when any are offered.
  if (toolLoopCapable && hasToolDirectives(opts.tools)) {
    parts.push(ASSISTANT_TOOL_GROUNDING);
  }

  // (g) recall teaching — when/how to consult and interpret memory. Skipped
  // for 'transform': that mode's entire response is treated as literal
  // replacement code (see MODE_BASE_PROMPTS.transform's doc comment), so any
  // extra instruction — even this concise one — risks the model narrating
  // instead of emitting pure code.
  if (mode !== 'transform') {
    parts.push(RECALL_TEACHING);
  }

  // (h) epistemic guardrail — always last
  parts.push(EPISTEMIC_GUARDRAIL);

  let prompt = parts.join('\n\n');

  // (i) output styles — inject deterministic, cache-safe style instructions
  if (opts.outputStyles && opts.outputStyles.length > 0) {
    const result = applyOutputStyles(prompt, opts.outputStyles);
    if (result.applied) prompt = result.systemPrompt;
  }

  return prompt;
}
