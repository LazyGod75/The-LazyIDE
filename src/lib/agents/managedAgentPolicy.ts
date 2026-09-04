/* managedAgentPolicy — persona + tool-policy layer for the managed (Pro
   tier) agent loop (see managedAgent.ts).

   Extracted from managedAgent.ts to keep that file under the project's
   800-line ceiling — a pure code-organization split, no behavior change.
   Covers:
     - AGENT_SYSTEM_PROMPT          the mandatory ReAct protocol every managed
                                    turn must follow, restated verbatim
                                    regardless of persona
     - AgentPersona / resolveAgentPersona
                                    resolves the named agent's identity
                                    (opts.agentSystemPrompt, or opts.agentName
                                    via listAgents()) so Pro missions get the
                                    same per-agent persona parity as the
                                    native (claude-code/codex) loop
     - ToolPolicy / checkToolPolicy / buildPolicyBlock
                                    enforces and advertises
                                    permissionMode/allowedTools/deniedTools,
                                    mirroring the native loop's
                                    --disallowedTools/--allowedTools semantics
     - buildEffectiveSystemPrompt   composes persona + ReAct protocol + policy
                                    restrictions into the system prompt sent
                                    to the model each turn

   checkToolPolicy is the first (hard-gate) layer of a two-layer tool-
   execution check; see managedToolPermissions.ts (sibling module) for the
   second layer — toolPermissions.ts's allow/ask/exclude rule engine,
   layered on top via its checkToolExecution, which is what
   managedAgent.ts's executeTool actually calls.

   One-directional dependency: managedAgent.ts and managedToolPermissions.ts
   import from this module; this module never imports from either.
*/

import type { PermissionMode } from './runtime.js';
import { listAgents, type StoredAgent } from './agentsStorage.js';
import { RECALL_TEACHING } from '../models/systemPrompts.js';
import {
  buildActionList,
  buildToolPolicyBlock,
  getPlanBlockedTools,
} from './toolRegistry.js';
import { buildLazyToolBlock } from './toolRegistryLazy.js';

// ── Anti-fabrication guardrail (2026-08 incident) ──────────────────
// Real repro: a managed mission was asked to replace a stale "Coming
// soon" price placeholder on a live marketing site with "wording that
// indicates availability" — no price was given anywhere in the task, the
// repo, the billing code, or Stripe config. The agent invented "$29/month"
// and wrote it into every locale file; a sibling mission independently
// invented a DIFFERENT price ("$19/month") for the same product. Both
// numbers were confabulated, not read from any source, and the merged
// commit put a false commercial claim in front of real users — strictly
// worse than the stale placeholder it replaced.
//
// Exported so tests can assert the exact text is present in
// AGENT_SYSTEM_PROMPT, and so evaluator.ts's reviewer/security/judge
// rubric (the second, and more important, line of defense — see
// NEVER_APPROVE_FABRICATED_FACTS there) can describe the same failure mode
// in its own wording without the two drifting out of sync.
export const ANTI_FABRICATION_INSTRUCTION =
  'CRITICAL — NEVER INVENT FACTS: when a task needs a specific fact you were not given — a price, a ' +
  'version number, an ID, a URL, a credential, a date, a proper name — and you cannot find it in the ' +
  'repo, the task text, or your tools (brain_query, search_code, web_search), you MUST NOT invent a ' +
  'plausible-looking value, even one that "sounds right" or matches the expected format. ' +
  'Example of the failure mode: asked to replace a placeholder price ("Coming soon") with "wording ' +
  'that indicates availability" — no price given anywhere — writing "$29/month" is fabrication, not a ' +
  'fix, even though it reads like a normal price. ' +
  'Instead: (1) leave a clearly-marked placeholder (e.g. "TODO: confirm price — not found in repo") ' +
  'and say so explicitly in your FINAL summary, or (2) stop that step and state in FINAL exactly what ' +
  'fact you needed and could not find. An honest gap is always better than a confident invented value — ' +
  'a fabricated fact is worse than the placeholder it replaces.';

// ── ReAct protocol (mandatory, regardless of persona) ──────────────

/**
 * Build the AGENT_SYSTEM_PROMPT from the tool registry.
 * Accepts optional brain-learned overlays (toolName → addendum) that
 * are injected into each tool's description — the Trace-Free+ runtime layer.
 *
 * Tool definitions are LAZY-LOADED (toolRegistryLazy.ts): only the "core"
 * everyday tools (read_file, edit_file, run_command, brain_query, ...) are
 * shown in full every turn — every other registered tool is a one-line
 * index hint the model expands on demand via find_tool. This is the fix for
 * the recon finding that buildToolSignatures() used to inline ALL ~44 tool
 * definitions into every single ReAct step regardless of whether the
 * mission ever touched them. preloadToolNames lets the caller (managedAgent.ts,
 * via suggestTools' cheap keyword heuristic) widen the core set for THIS
 * mission — e.g. a task mentioning "browser"/"screenshot" preloads the
 * browser_* tools in full instead of leaving them index-only.
 */
export function buildAgentSystemPrompt(
  overlays?: Map<string, string>,
  preloadToolNames?: readonly string[],
): string {
  const { text: toolSigs } = buildLazyToolBlock('mission', overlays, preloadToolNames ?? []);
  const actionList = buildActionList();

  return `You are an autonomous coding agent in an IDE. You have access to the same tools a developer uses every day: reading, editing, searching files, running commands, running tests, querying the project brain for prior knowledge, and searching the web.

You MUST respond in this EXACT format each turn:
THOUGHT: <your reasoning about what to do next>
ACTION: <one of: ${actionList} | FINAL>
ARGS: <single-line JSON with the arguments>

${toolSigs}
- FINAL: {"summary": "what was accomplished"}

FILE EDITS — edit_file, multi_edit, write_file use NO ARGS/JSON line. Put content in a SEARCH/REPLACE block (multi_edit: several blocks in a row, applied in order, atomic) or a fenced code block for write_file — so multi-line code is never escaped into a JSON string:
ACTION: edit_file
FILE: relative/path/to/file.tsx
<<<<<<< SEARCH
exact existing lines, verbatim (copy from what read_file showed you)
=======
replacement lines, verbatim
>>>>>>> REPLACE
ACTION: write_file
FILE: relative/path/to/new-file.tsx
\`\`\`tsx
full file content, verbatim
\`\`\`
old_string need not match perfectly — indentation/blank-line differences still apply. A non-match returns the real file content; a syntax-breaking edit is rejected before writing. Fix and retry either way.

Rules:
- Paths are ALWAYS relative to the working directory
- Do ONE action per turn
- Always end with ACTION: FINAL when done
- Do not output anything after the ARGS line (or after the last REPLACE/fenced block for file edits)
- BUDGET: You have a LIMITED number of steps. Spend at most 5 steps on exploration (read_dir, find_file, search_code, brain_query) BEFORE writing your first file. After that, prioritize write_file/edit_file over more reading.
- DELIVERABLE: your mission is judged by what you leave ON DISK, not by what you say. You MUST create or modify at least one file (write_file/edit_file/multi_edit) before emitting FINAL — a mission that ends without touching the filesystem is a failure. When the task is research, still persist your findings to a file (e.g. NOTES.md or a docs/ file) so the work is reviewable.
- For large files, use read_file with start_line/end_line (default window: 100 lines)
- Use find_file or search_code to locate files/symbols before reading
- Use edit_file for targeted changes — use the SEARCH/REPLACE format above, always read the file first. Use write_file only for new files or full rewrites.
- Use multi_edit for multiple changes in the same file (saves turns).
- Use run_command for any shell command. Use run_tests, run_lint, run_build for their dedicated tools instead.
- Shell is Windows cmd.exe — use cd, dir, type; there is no pwd, ls, or cat.
- Use brain_query BEFORE attempting a task you're unsure about — the brain may have prior solutions.
- Use brain_record when you discover something important: a working approach, a failure cause, a project quirk.
  Recording first-time successes is critical — future agents with the same task will use your notes to succeed faster.
- Use web_search when the brain has no answer and you need external docs or API references.
- Use review_diff BEFORE emitting FINAL to verify your work is correct and complete.
- Use ask_user only when genuinely blocked — try brain_query, search_code, and read_file first.

TOOLS POLICY:
- read_file: use ONLY after you know the exact path (use read_dir, find_file, or search_code to discover paths first)
- search_code: use for repo-wide content search (returns compact file:line matches). Use grep_file for single-file search.
- find_file: use to find files by name pattern across the entire repo
- edit_file: preferred for targeted changes — always read the file first, then edit a specific section
- multi_edit: use for multiple edits in the same file (atomic — all or nothing)
- write_file: use for new files or when you need to rewrite >50% of a file
- read_dir: use to orient yourself in the project structure
- run_command: use for git status, or any shell command not covered by a dedicated tool
- run_tests: use after writes to verify correctness (auto-detects framework)
- run_lint: use after editing to catch style/type issues (parsed, compact output)
- run_build: use to verify the project compiles after significant changes
- brain_query: SEMANTIC fuzzy recall — use for "how is X configured?" or "what went wrong last time?"
- brain_query_css: DETERMINISTIC structural recall — CSS selector over data-cerveau-* attributes for exact sets
- brain_neighbours: follow a hit's 1-hop graph using an id from brain_query_css or brain_query
- brain_record: use to record discoveries, successes, and failures for future agents
- brain_synthesize: use to consolidate many brain hits into a concise summary
- web_search: use when brain has no answer and you need external docs/APIs
- web_fetch: use to read a specific URL after web_search
- git_status / git_diff / git_log: use to review changes and history
- git_commit: use to stage + commit after verifying with git_status + git_diff + run_tests
- review_diff: use BEFORE FINAL to see all your changes at once
- delegate: use to parallelize read-only sub-tasks
- ask_user: use ONLY when genuinely blocked — not for things you can figure out yourself
- NEVER use read_file blindly without a known path
- NEVER write or edit files without reading them first (except new file creation)
- ALWAYS brain_query before complex tasks — the brain may have the answer
- ALWAYS brain_record when you solve something for the first time — help future agents
- ALWAYS review_diff before FINAL — catch your own mistakes before the human does
- CRITICAL: You MUST use write_file to create files. NEVER emit FINAL claiming you created or modified a file unless you actually called write_file or edit_file in a previous turn.
- CRITICAL: After writing a file, use read_file to verify it exists before emitting FINAL.
- CRITICAL: If a tool call fails, do NOT pretend it succeeded. Report the error in your FINAL summary.
- CRITICAL: Your FINAL summary must only describe actions you actually took with tools. Do not fabricate results.

${ANTI_FABRICATION_INSTRUCTION}

${RECALL_TEACHING}`;
}

/**
 * Legacy export — the system prompt with no overlays.
 * Kept for backward compatibility with existing imports/tests.
 */
export const AGENT_SYSTEM_PROMPT = buildAgentSystemPrompt();

// ── Persona ─────────────────────────────────────────────────────────

/** Resolved agent identity injected into the system prompt. */
export interface AgentPersona {
  displayName: string;
  systemPrompt: string;
}

/** Subset of PlanAndActManagedOpts needed to resolve the agent persona —
 *  declared locally so this module has no dependency on managedAgent.ts. */
export interface AgentPersonaSourceOpts {
  agentName?: string;
  agentDisplayName?: string;
  agentSystemPrompt?: string;
}

/**
 * Resolves the agent persona for the system prompt:
 *   1. opts.agentSystemPrompt, when provided directly (tests, or callers that
 *      already hold a LazyAgent) — used as-is, no storage round-trip.
 *   2. Otherwise, opts.agentName is looked up against listAgents() (matches
 *      LazyAgent.name or .displayName), mirroring how AgentsSpace resolves
 *      agents by name elsewhere in the app.
 *   3. null when neither is available, or the lookup fails/finds nothing —
 *      the caller falls back to the generic AGENT_SYSTEM_PROMPT.
 */
export async function resolveAgentPersona(
  opts: AgentPersonaSourceOpts,
): Promise<AgentPersona | null> {
  if (opts.agentSystemPrompt && opts.agentSystemPrompt.trim()) {
    return {
      displayName: opts.agentDisplayName?.trim() || opts.agentName || 'Custom Agent',
      systemPrompt: opts.agentSystemPrompt.trim(),
    };
  }
  if (!opts.agentName) return null;
  try {
    const stored = await listAgents();
    const match = stored.find(
      (s: StoredAgent) => s.agent.name === opts.agentName || s.agent.displayName === opts.agentName,
    );
    if (!match || !match.agent.systemPrompt.trim()) return null;
    return {
      displayName: match.agent.displayName || match.agent.name,
      systemPrompt: match.agent.systemPrompt.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Composes the agent's persona (identity + task-specific instructions) with
 * the mandatory ReAct protocol. The persona comes first so the model adopts
 * the right identity/expertise; the protocol is restated as non-negotiable
 * right after, so THOUGHT/ACTION/ARGS parsing keeps working regardless of
 * persona. Falls back to the plain AGENT_SYSTEM_PROMPT when no persona (or
 * an empty one) was resolved.
 */
export function buildEffectiveSystemPrompt(
  persona: AgentPersona | null,
  overlays?: Map<string, string>,
  preloadToolNames?: readonly string[],
): string {
  // Rebuild only when there's something to inject (overlays, or extra tools
  // to preload in full via suggestTools) — otherwise reuse the cached
  // AGENT_SYSTEM_PROMPT constant, same as before this parameter existed.
  const hasPreload = preloadToolNames && preloadToolNames.length > 0;
  const prompt = (overlays || hasPreload) ? buildAgentSystemPrompt(overlays, preloadToolNames) : AGENT_SYSTEM_PROMPT;
  if (!persona || !persona.systemPrompt.trim()) return prompt;
  return [
    `You are "${persona.displayName}". Your identity and task-specific instructions:`,
    '',
    persona.systemPrompt.trim(),
    '',
    '---',
    '',
    'The instructions above define WHO you are and WHAT you specialize in. The',
    'protocol below defines HOW you must communicate every turn inside this',
    'autonomous loop — it is mandatory regardless of persona.',
    '',
    prompt,
  ].join('\n');
}

// ── Tool policy ─────────────────────────────────────────────────────

/** Tool-execution policy enforced by executeTool / checkToolPolicy. */
export interface ToolPolicy {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
}

/** Tools blocked under permissionMode 'plan' (read-only run).
 *  Now sourced from the tool registry's blockedInPlan flag. */
const PLAN_MODE_BLOCKED_TOOLS = getPlanBlockedTools();

/**
 * Renders an "ACTIVE RESTRICTIONS" block describing the current tool policy,
 * so the model knows about blocked tools upfront instead of only discovering
 * them via ERROR observations after the fact. Returns '' when no restriction
 * is active (so it is safe to always append to the system prompt).
 */
export function buildPolicyBlock(policy: ToolPolicy): string {
  return buildToolPolicyBlock(policy.permissionMode, policy.allowedTools, policy.deniedTools);
}

/**
 * Enforces permissionMode/allowedTools/deniedTools for one tool call.
 * Returns null when the call is permitted, or a clear "ERROR: …" observation
 * string when blocked — fed back to the model like any other observation so
 * the loop continues sensibly instead of crashing.
 *
 * Checks stack independently (plan-mode, then deniedTools, then
 * allowedTools) so e.g. deniedTools still applies even outside plan mode.
 */
export function checkToolPolicy(action: string, policy: ToolPolicy): string | null {
  if (action === 'FINAL') return null;

  if (policy.permissionMode === 'plan' && PLAN_MODE_BLOCKED_TOOLS.has(action)) {
    return `ERROR: read-only (plan mode) — "${action}" is blocked. Use read_file/read_dir/glob/grep_file/brain_query to investigate, then ACTION: FINAL with your plan as the summary.`;
  }

  if (policy.deniedTools && policy.deniedTools.includes(action)) {
    return `ERROR: tool "${action}" is denied for this mission (deniedTools policy).`;
  }

  if (policy.allowedTools && policy.allowedTools.length > 0 && !policy.allowedTools.includes(action)) {
    return `ERROR: tool "${action}" is not in the allowed tool list for this mission (allowedTools policy): ${policy.allowedTools.join(', ')}.`;
  }

  return null;
}
