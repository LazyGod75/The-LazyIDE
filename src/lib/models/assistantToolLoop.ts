/* assistantToolLoop — extends the brain ReAct loop with general tool directives.

   The assistant chat surface already has a ReAct loop (brainSearchLoop.ts)
   that handles BRAIN_SEARCH / BRAIN_QUERY_CSS / BRAIN_NEIGHBOURS directives.
   This module adds support for additional tool directives the assistant can
   emit, routed through the shared toolRuntime:

     WEB_SEARCH: <query>        → web_search tool
     WEB_FETCH: <url>           → web_fetch tool
     READ_FILE: <path>          → read_file tool
     READ_DIR: <path>           → read_dir tool
     SEARCH_CODE: <pattern>     → search_code tool
     GIT_STATUS:                → git_status tool
     GIT_DIFF: <path>           → git_diff tool
     GIT_LOG: <count>           → git_log tool
     FIND_TOOL: <name/keyword>  → find_tool tool (lazy tool loading, see
                                  toolRegistryLazy.ts — returns the fuller
                                  registry description for a tool already
                                  listed above, when its one-liner wasn't enough)

   These are ONLY enabled when the corresponding tools are advertised in
   req.tools — the loop checks the tool list before executing any directive.

   The module re-uses brainSearchLoop's dedup, round-cap, and forced-final
   logic by composing with the existing loop rather than duplicating it.
*/

import { executeTool } from '../tools/toolRuntime.js';
import type { ToolExecutionContext } from '../tools/toolRuntime.js';
import { isToolAllowed } from '../tools/toolProfiles.js';
import type { StreamChatRequest, StreamEvent, Translate } from './types.js';
import { extractThinkingText } from './streamEvents.js';
import { capMessageHistory } from './messageHistory.js';
import {
  executeBrainDirective,
  describeBrainDirective,
  isBrainDirectiveError,
  stripInvisibleLines,
} from './brainSearchLoop.js';
import { parseBrainDirective } from '../brain/brainTool.js';
import type { BrainDirective } from '../brain/brainTool.js';

// ── Tool directive parsing ────────────────────────────────────────

/** Maximum total rounds (brain + tool) before forcing a final answer. */
export const MAX_TOOL_ROUNDS = 5;

export type ToolDirectiveKind =
  | 'web_search'
  | 'web_fetch'
  | 'read_file'
  | 'read_dir'
  | 'search_code'
  | 'git_status'
  | 'git_diff'
  | 'git_log'
  | 'find_tool';

export interface ToolDirective {
  kind: ToolDirectiveKind;
  arg: string;
}

/** Map directive keyword → tool name + arg extraction. */
const TOOL_DIRECTIVE_MAP: Record<string, { kind: ToolDirectiveKind; tool: string; needsArg: boolean }> = {
  'WEB_SEARCH': { kind: 'web_search', tool: 'web_search', needsArg: true },
  'WEB_FETCH': { kind: 'web_fetch', tool: 'web_fetch', needsArg: true },
  'READ_FILE': { kind: 'read_file', tool: 'read_file', needsArg: true },
  'READ_DIR': { kind: 'read_dir', tool: 'read_dir', needsArg: true },
  'SEARCH_CODE': { kind: 'search_code', tool: 'search_code', needsArg: true },
  'GIT_STATUS': { kind: 'git_status', tool: 'git_status', needsArg: false },
  'GIT_DIFF': { kind: 'git_diff', tool: 'git_diff', needsArg: true },
  'GIT_LOG': { kind: 'git_log', tool: 'git_log', needsArg: true },
  'FIND_TOOL': { kind: 'find_tool', tool: 'find_tool', needsArg: true },
};

const TOOL_DIRECTIVE_PATTERN = new RegExp(
  `(${Object.keys(TOOL_DIRECTIVE_MAP).join('|')}):[ \\t]*([^\\n\\r]*)`,
  'g',
);

// Matches a general tool-directive line (WEB_SEARCH, READ_FILE, ...) and its
// argument to the end of the line — the same "keyword: value to end-of-line"
// shape as brainSearchLoop.ts's BRAIN_SEARCH_DIRECTIVE_RE, but for THIS
// module's own directive set, which stripInvisibleLines has no knowledge of
// (it was written before these directives existed and only strips
// reasoning/usage markers + the three BRAIN_* directives). Used by
// stripVisibleDirectives below so a tool-directive line never leaks into the
// visible transcript — see that function's doc comment.
const TOOL_DIRECTIVE_LINE_RE = new RegExp(
  `(${Object.keys(TOOL_DIRECTIVE_MAP).join('|')}):[^\\n\\r]*`,
  'g',
);

/**
 * Strip general tool-directive lines from visible text, THEN delegate to
 * brainSearchLoop's stripInvisibleLines for its existing reasoning/usage/
 * BRAIN_* stripping. A directive is detected from the RAW turnText accumulated
 * per round (see withAssistantToolLoop/withAssistantToolLoopEvents) only
 * AFTER that round finishes streaming — exactly like BRAIN_SEARCH already
 * works — so without this, a directive line would flow into the visible
 * per-chunk yield during the very round that contains it, before the loop
 * ever gets a chance to intercept it.
 *
 * Composed as a SECOND line-drop pass over stripInvisibleLines' own output
 * (rather than duplicating its whole algorithm, or pre-stripping before it)
 * so the "line disappears entirely; genuine blank paragraph breaks survive"
 * contract stays byte-identical to brainSearchLoop.ts's — pre-stripping
 * first would hand stripInvisibleLines an already-blank line it cannot
 * distinguish from a real paragraph break, leaving a stray empty line
 * instead of fully dropping it.
 */
function stripVisibleDirectives(text: string): string {
  const withoutBrain = stripInvisibleLines(text);
  return withoutBrain
    .split('\n')
    .map(line => {
      const wasBlank = line.trim() === '';
      const cleaned = line.replace(TOOL_DIRECTIVE_LINE_RE, '').trimEnd();
      return { cleaned, keep: wasBlank || cleaned.trim() !== '' };
    })
    .filter(entry => entry.keep)
    .map(entry => entry.cleaned)
    .join('\n');
}

/** Parse a model turn for a tool directive (WEB_SEARCH, READ_FILE, etc.). */
export function parseToolDirective(text: string): ToolDirective | null {
  if (!text.trim()) return null;

  let match: RegExpExecArray | null;
  let directive: ToolDirective | null = null;
  TOOL_DIRECTIVE_PATTERN.lastIndex = 0;
  while ((match = TOOL_DIRECTIVE_PATTERN.exec(text)) !== null) {
    const keyword = match[1];
    const arg = match[2].trim();
    const entry = TOOL_DIRECTIVE_MAP[keyword];
    if (!entry) continue;
    if (entry.needsArg && !arg) continue;
    directive = { kind: entry.kind, arg };
  }

  return directive;
}

// ── Tool directive execution ──────────────────────────────────────

/** Build the args record for a tool directive. */
function toolDirectiveArgs(directive: ToolDirective): Record<string, unknown> {
  switch (directive.kind) {
    case 'web_search':
      return { query: directive.arg };
    case 'web_fetch':
      return { url: directive.arg };
    case 'read_file':
      return { path: directive.arg };
    case 'read_dir':
      return { path: directive.arg || '.' };
    case 'search_code':
      return { pattern: directive.arg };
    case 'git_status':
      return {};
    case 'git_diff':
      return { path: directive.arg };
    case 'git_log':
      return { count: directive.arg ? Number(directive.arg) : 10 };
    case 'find_tool':
      return { query: directive.arg };
  }
}

/** Human-readable status line for a tool directive. `t` is optional and
 *  threaded from StreamChatRequest.t (see its doc comment) — omitting it
 *  falls back to the ORIGINAL hardcoded French, never a behavior change.
 *  'find_tool' has no matching i18n key yet, so it always stays French. */
function toolDirectiveStatusLine(directive: ToolDirective, t?: Translate): string {
  switch (directive.kind) {
    case 'web_search':
      return `\n\n🔍 ${t ? t('assistant.tool.webSearch', { value: directive.arg }) : `Recherche web : ${directive.arg}`}\n\n`;
    case 'web_fetch':
      return `\n\n🌐 ${t ? t('assistant.tool.webFetch', { value: directive.arg }) : `Récupération web : ${directive.arg}`}\n\n`;
    case 'read_file':
      return `\n\n📂 ${t ? t('assistant.tool.readFile', { value: directive.arg }) : `Lecture fichier : ${directive.arg}`}\n\n`;
    case 'read_dir':
      return `\n\n📂 ${t ? t('assistant.tool.readDir', { value: directive.arg || '.' }) : `Listing dossier : ${directive.arg || '.'}`}\n\n`;
    case 'search_code':
      return `\n\n🔎 ${t ? t('assistant.tool.searchCode', { value: directive.arg }) : `Recherche code : ${directive.arg}`}\n\n`;
    case 'git_status':
      return `\n\n📋 ${t ? t('assistant.tool.gitStatus') : 'Git status'}\n\n`;
    case 'git_diff':
      return `\n\n📋 ${t ? t('assistant.tool.gitDiff', { value: directive.arg }) : `Git diff : ${directive.arg}`}\n\n`;
    case 'git_log':
      return `\n\n📋 ${t ? t('assistant.tool.gitLog', { value: directive.arg || '10' }) : `Git log (${directive.arg || '10'})`}\n\n`;
    case 'find_tool':
      return `\n\n🔧 Détail de l'outil : ${directive.arg}\n\n`;
  }
}

/** Observation header for appending tool results to conversation history. */
function toolDirectiveObservationHeader(directive: ToolDirective): string {
  return `[${directive.kind} results for "${directive.arg}"]`;
}

/** Tool name for structured events. */
function toolDirectiveToolName(directive: ToolDirective): string {
  return directive.kind;
}

/** Tool input for structured events. */
function toolDirectiveToolInput(directive: ToolDirective): Record<string, string> {
  const args = toolDirectiveArgs(directive);
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    result[k] = String(v);
  }
  return result;
}

// ── Combined directive parsing ────────────────────────────────────

/** A unified directive — either a brain directive or a tool directive. */
export type UnifiedDirective =
  | { type: 'brain'; directive: BrainDirective }
  | { type: 'tool'; directive: ToolDirective };

/** Parse a model turn for either brain or tool directives.
 *  Tool directives take priority over brain directives when both are present
 *  (the model chose to use a tool rather than memory — respect that choice). */
export function parseUnifiedDirective(text: string): UnifiedDirective | null {
  const toolDir = parseToolDirective(text);
  if (toolDir) return { type: 'tool', directive: toolDir };

  const brainDir = parseBrainDirective(text);
  if (brainDir) return { type: 'brain', directive: brainDir };

  return null;
}

// ── Extended ReAct loop ───────────────────────────────────────────

const THINKING_PART_ID = 'thinking';
const ANSWER_PART_ID = 'answer';

function* classifyChunk(text: string): Generator<StreamEvent> {
  const thinking = extractThinkingText(text);
  if (thinking) yield { type: 'thinking', id: THINKING_PART_ID, text: thinking };
  const visible = stripVisibleDirectives(text);
  if (visible) yield { type: 'text', id: ANSWER_PART_ID, text: visible };
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Fallback project root when req.projectRoot is absent (callers that
 *  predate that field, or a test/mock built before it existed) — reads the
 *  same 'lazy.projectRoot' localStorage key AppContext's registerProject/
 *  switchProject now write as a defensive backstop (see AppContext.tsx).
 *  Prefer req.projectRoot (the live AppContext value threaded through
 *  assistantStore.tsx) wherever a request is available — see the two
 *  rootPath call sites below. */
function getProjectRoot(): string {
  try {
    return localStorage.getItem('lazy.projectRoot') ?? '.';
  } catch {
    return '.';
  }
}

/**
 * Extended ReAct loop that supports BOTH brain directives (BRAIN_SEARCH,
 * BRAIN_QUERY_CSS, BRAIN_NEIGHBOURS) and tool directives (WEB_SEARCH,
 * READ_FILE, etc.). Used by the assistant chat surface.
 *
 * When no tools are advertised, this is a transparent pass-through (single
 * turn, no extra calls) — identical to the pre-shim behavior.
 */
export async function* withAssistantToolLoop(
  req: StreamChatRequest,
  runTurn: (messages: Array<{ role: string; content: string }>) => AsyncIterable<string>,
): AsyncGenerator<string> {
  // Capped defensively (see messageHistory.ts) — the primary cap already
  // happens where req.messages is built (assistantStore.tsx), but this
  // module is what actually resends `messages` on every tool round, so it
  // stays bounded here too regardless of caller.
  let messages: Array<{ role: string; content: string }> = capMessageHistory(req.messages).map(m => ({
    role: m.role,
    content: m.content,
  }));

  const toolsEnabled = Array.isArray(req.tools) && req.tools.length > 0;
  const searchedQueries = new Set<string>();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const isForcedFinal = round >= MAX_TOOL_ROUNDS;

    let turnText = '';
    let lineBuffer = '';

    for await (const chunk of runTurn(messages)) {
      turnText += chunk;
      lineBuffer += chunk;
      const newlineIdx = lineBuffer.lastIndexOf('\n');
      if (newlineIdx === -1) continue;
      const completeText = lineBuffer.slice(0, newlineIdx + 1);
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      const visible = stripVisibleDirectives(completeText);
      if (visible) yield visible;
    }
    if (lineBuffer) {
      const visible = stripVisibleDirectives(lineBuffer);
      if (visible) yield visible;
    }

    if (req.signal?.aborted) return;
    if (!toolsEnabled || isForcedFinal) return;

    const unified = parseUnifiedDirective(turnText);
    if (!unified) return;

    // Build dedup key
    const dedupKey = unified.type === 'brain'
      ? `brain:${unified.directive.kind}:${normalizeQuery(unified.directive.arg)}`
      : `tool:${unified.directive.kind}:${normalizeQuery(unified.directive.arg)}`;

    if (searchedQueries.has(dedupKey)) {
      // Model is stuck — nudge it to answer
      const nudge = 'You already have the results above. Do NOT search again. Write your final answer for the user now.';
      const nudgeMessages = [
        ...messages,
        { role: 'assistant', content: turnText },
        { role: 'user', content: nudge },
      ];
      let nudgeLineBuffer = '';
      for await (const chunk of runTurn(nudgeMessages)) {
        nudgeLineBuffer += chunk;
        const newlineIdx = nudgeLineBuffer.lastIndexOf('\n');
        if (newlineIdx === -1) continue;
        const completeText = nudgeLineBuffer.slice(0, newlineIdx + 1);
        nudgeLineBuffer = nudgeLineBuffer.slice(newlineIdx + 1);
        const visible = stripVisibleDirectives(completeText);
        if (visible) yield visible;
      }
      if (nudgeLineBuffer) {
        const visible = stripVisibleDirectives(nudgeLineBuffer);
        if (visible) yield visible;
      }
      return;
    }

    searchedQueries.add(dedupKey);

    if (unified.type === 'brain') {
      // Delegate to existing brain directive execution
      const presentation = describeBrainDirective(unified.directive, req.t);
      yield presentation.statusLine;
      const recalled = await executeBrainDirective(unified.directive, req.sessionId);
      if (req.signal?.aborted) return;
      messages = [
        ...messages,
        { role: 'assistant', content: turnText },
        { role: 'user', content: `${presentation.observationHeader}\n${recalled}` },
      ];
    } else {
      // Execute tool directive via shared runtime
      const dir = unified.directive;
      const toolName = toolDirectiveToolName(dir);

      // Check if this tool is allowed for the assistant surface
      if (!isToolAllowed(toolName, 'assistant')) {
        yield `\n\n⚠️ Outil ${toolName} non disponible sur cette surface.\n\n`;
        messages = [
          ...messages,
          { role: 'assistant', content: turnText },
          { role: 'user', content: `[${toolName} is not available on the assistant surface. Use a different approach.]` },
        ];
        continue;
      }

      yield toolDirectiveStatusLine(dir, req.t);

      const args = toolDirectiveArgs(dir);
      const rootPath = req.projectRoot ?? getProjectRoot();
      const ctx: ToolExecutionContext = {
        rootPath,
        policy: {},
        agentMode: 'default',
      };

      let result: string;
      try {
        result = await executeTool(toolName, args, ctx);
      } catch (err) {
        result = `ERROR: ${String(err)}`;
      }
      if (req.signal?.aborted) return;

      messages = [
        ...messages,
        { role: 'assistant', content: turnText },
        { role: 'user', content: `${toolDirectiveObservationHeader(dir)}\n${result}` },
      ];
    }
  }

  // Safety net
  const finalMessages = [
    ...messages,
    { role: 'user', content: 'Provide your final answer now using the results above; do NOT emit any directives.' },
  ];
  let safetyLineBuffer = '';
  for await (const chunk of runTurn(finalMessages)) {
    if (req.signal?.aborted) return;
    safetyLineBuffer += chunk;
    const newlineIdx = safetyLineBuffer.lastIndexOf('\n');
    if (newlineIdx === -1) continue;
    const completeText = safetyLineBuffer.slice(0, newlineIdx + 1);
    safetyLineBuffer = safetyLineBuffer.slice(newlineIdx + 1);
    const visible = stripVisibleDirectives(completeText);
    if (visible) yield visible;
  }
  if (safetyLineBuffer) {
    const visible = stripVisibleDirectives(safetyLineBuffer);
    if (visible) yield visible;
  }
}

/**
 * Structured-event counterpart to withAssistantToolLoop — yields typed
 * StreamEvents (thinking / tool-call / text) for the assistant chat UI.
 */
export async function* withAssistantToolLoopEvents(
  req: StreamChatRequest,
  runTurn: (messages: Array<{ role: string; content: string }>) => AsyncIterable<string>,
): AsyncGenerator<StreamEvent> {
  // See the same guard in withAssistantToolLoop above.
  let messages: Array<{ role: string; content: string }> = capMessageHistory(req.messages).map(m => ({
    role: m.role,
    content: m.content,
  }));

  const toolsEnabled = Array.isArray(req.tools) && req.tools.length > 0;
  const searchedQueries = new Set<string>();

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const isForcedFinal = round >= MAX_TOOL_ROUNDS;

    let turnText = '';
    let lineBuffer = '';

    for await (const chunk of runTurn(messages)) {
      turnText += chunk;
      lineBuffer += chunk;
      const newlineIdx = lineBuffer.lastIndexOf('\n');
      if (newlineIdx === -1) continue;
      const completeText = lineBuffer.slice(0, newlineIdx + 1);
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      yield* classifyChunk(completeText);
    }
    if (lineBuffer) {
      yield* classifyChunk(lineBuffer);
    }

    if (req.signal?.aborted) return;
    if (!toolsEnabled || isForcedFinal) return;

    const unified = parseUnifiedDirective(turnText);
    if (!unified) return;

    const dedupKey = unified.type === 'brain'
      ? `brain:${unified.directive.kind}:${normalizeQuery(unified.directive.arg)}`
      : `tool:${unified.directive.kind}:${normalizeQuery(unified.directive.arg)}`;

    if (searchedQueries.has(dedupKey)) {
      const nudge = 'You already have the results above. Do NOT search again. Write your final answer for the user now.';
      const nudgeMessages = [
        ...messages,
        { role: 'assistant', content: turnText },
        { role: 'user', content: nudge },
      ];
      let nudgeLineBuffer = '';
      for await (const chunk of runTurn(nudgeMessages)) {
        nudgeLineBuffer += chunk;
        const newlineIdx = nudgeLineBuffer.lastIndexOf('\n');
        if (newlineIdx === -1) continue;
        const completeText = nudgeLineBuffer.slice(0, newlineIdx + 1);
        nudgeLineBuffer = nudgeLineBuffer.slice(newlineIdx + 1);
        yield* classifyChunk(completeText);
      }
      if (nudgeLineBuffer) yield* classifyChunk(nudgeLineBuffer);
      return;
    }

    searchedQueries.add(dedupKey);

    if (unified.type === 'brain') {
      const presentation = describeBrainDirective(unified.directive, req.t);
      const toolId = `${presentation.toolName}-${round}`;
      yield { type: 'tool', id: toolId, name: presentation.toolName, input: presentation.toolInput, status: 'running' };
      const recalled = await executeBrainDirective(unified.directive, req.sessionId);
      if (req.signal?.aborted) return;
      const isError = isBrainDirectiveError(recalled);
      yield {
        type: 'tool', id: toolId, name: presentation.toolName,
        input: presentation.toolInput, status: isError ? 'error' : 'done',
        resultSummary: recalled.slice(0, 160),
      };
      messages = [
        ...messages,
        { role: 'assistant', content: turnText },
        { role: 'user', content: `${presentation.observationHeader}\n${recalled}` },
      ];
    } else {
      const dir = unified.directive;
      const toolName = toolDirectiveToolName(dir);
      const toolId = `${toolName}-${round}`;

      if (!isToolAllowed(toolName, 'assistant')) {
        yield {
          type: 'tool', id: toolId, name: toolName,
          input: toolDirectiveToolInput(dir), status: 'error',
          resultSummary: `${toolName} is not available on the assistant surface`,
        };
        messages = [
          ...messages,
          { role: 'assistant', content: turnText },
          { role: 'user', content: `[${toolName} is not available on the assistant surface. Use a different approach.]` },
        ];
        continue;
      }

      yield { type: 'tool', id: toolId, name: toolName, input: toolDirectiveToolInput(dir), status: 'running' };

      const args = toolDirectiveArgs(dir);
      const rootPath = req.projectRoot ?? getProjectRoot();
      const ctx: ToolExecutionContext = { rootPath, policy: {}, agentMode: 'default' };

      let result: string;
      try {
        result = await executeTool(toolName, args, ctx);
      } catch (err) {
        result = `ERROR: ${String(err)}`;
      }
      if (req.signal?.aborted) return;

      const isError = result.startsWith('ERROR:');
      yield {
        type: 'tool', id: toolId, name: toolName,
        input: toolDirectiveToolInput(dir), status: isError ? 'error' : 'done',
        resultSummary: result.slice(0, 160),
      };

      messages = [
        ...messages,
        { role: 'assistant', content: turnText },
        { role: 'user', content: `${toolDirectiveObservationHeader(dir)}\n${result}` },
      ];
    }
  }

  // Safety net
  const finalMessages = [
    ...messages,
    { role: 'user', content: 'Provide your final answer now using the results above; do NOT emit any directives.' },
  ];
  let safetyLineBuffer = '';
  for await (const chunk of runTurn(finalMessages)) {
    if (req.signal?.aborted) return;
    safetyLineBuffer += chunk;
    const newlineIdx = safetyLineBuffer.lastIndexOf('\n');
    if (newlineIdx === -1) continue;
    const completeText = safetyLineBuffer.slice(0, newlineIdx + 1);
    safetyLineBuffer = safetyLineBuffer.slice(newlineIdx + 1);
    yield* classifyChunk(completeText);
  }
  if (safetyLineBuffer) yield* classifyChunk(safetyLineBuffer);
}
