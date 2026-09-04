/* assistantTools — ChatTool definitions for the assistant chat surface.

   These are the tool advertisements the model sees in its system prompt,
   telling it which directives it can emit during the ReAct loop. Each
   ChatTool here corresponds to a directive parsed by assistantToolLoop.ts
   and executed through the shared toolRuntime.

   Only tools allowed by the ASSISTANT_PROFILE (toolProfiles.ts) are
   advertised — the profile is the single source of truth for permissions.
*/

import type { ChatTool } from './types.js';

// ── ChatTool definitions for the assistant ────────────────────────

const WEB_SEARCH_TOOL: ChatTool = {
  name: 'web_search',
  description:
    'Search the web for current information. Emit "WEB_SEARCH: <query>" on its own line to search. ' +
    'Use when the question requires up-to-date information not in your training data or the brain memory. ' +
    'Returns titled results with URLs and snippets.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      max_results: { type: 'number', description: 'Optional max results (default 8).' },
    },
    required: ['query'],
  },
};

const WEB_FETCH_TOOL: ChatTool = {
  name: 'web_fetch',
  description:
    'Fetch the content of a web page. Emit "WEB_FETCH: <url>" on its own line. ' +
    'Use after web_search to read a specific result page in detail. ' +
    'Returns the page content (truncated to ~6000 chars).',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' },
      max_chars: { type: 'number', description: 'Optional max chars (default 6000).' },
    },
    required: ['url'],
  },
};

const READ_FILE_TOOL: ChatTool = {
  name: 'read_file',
  description:
    'Read a file from the project. Emit "READ_FILE: <relative/path>" on its own line. ' +
    'Returns a windowed view (100 lines default) with line numbers. ' +
    'Use to inspect code when the user asks about a specific file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file.' },
      start_line: { type: 'number', description: 'Optional start line (default 1).' },
      end_line: { type: 'number', description: 'Optional end line.' },
    },
    required: ['path'],
  },
};

const READ_DIR_TOOL: ChatTool = {
  name: 'read_dir',
  description:
    'List directory contents. Emit "READ_DIR: <relative/path>" on its own line. ' +
    'Returns a compact listing of files and subdirectories.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the directory (default ".").' },
    },
  },
};

const SEARCH_CODE_TOOL: ChatTool = {
  name: 'search_code',
  description:
    'Search code content across the project using ripgrep. Emit "SEARCH_CODE: <pattern>" on its own line. ' +
    'Returns matching lines with file paths and line numbers (max 50). ' +
    'Use to find where a function, class, or pattern is defined or used.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regex pattern to search for.' },
      file_glob: { type: 'string', description: 'Optional file glob filter (e.g. "*.ts").' },
    },
    required: ['pattern'],
  },
};

const GIT_STATUS_TOOL: ChatTool = {
  name: 'git_status',
  description:
    'Show git working tree status. Emit "GIT_STATUS:" on its own line. ' +
    'Returns modified/added/deleted files.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const GIT_DIFF_TOOL: ChatTool = {
  name: 'git_diff',
  description:
    'Show git diff for a file or the whole working tree. Emit "GIT_DIFF: <path>" or "GIT_DIFF:" for all changes. ' +
    'Returns the diff output.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional file path to diff (empty = all changes).' },
    },
  },
};

const GIT_LOG_TOOL: ChatTool = {
  name: 'git_log',
  description:
    'Show recent git commits. Emit "GIT_LOG: <count>" on its own line (e.g. "GIT_LOG: 10"). ' +
    'Returns one-line commit messages.',
  input_schema: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'Number of commits to show (default 10).' },
    },
  },
};

// Lazy tool loading (toolRegistryLazy.ts) — every tool above is already
// "core" for the codeur/assistant surface (see TOOL_META's coreFor:'codeur'
// entries), so this list stays small on purpose. find_tool still earns its
// keep here: it returns the FULLER ACI-optimized description from the
// central registry (cross-tool dependencies, output semantics, edge cases)
// for a tool whose one-line directive description above wasn't enough.
const FIND_TOOL_TOOL: ChatTool = {
  name: 'find_tool',
  description:
    'Look up the fuller usage details of one of the tools above. Emit "FIND_TOOL: <name>" on its own line. ' +
    'Use only when a tool\'s one-line description above left you unsure how to call it correctly.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The tool name (or a keyword/tag) to look up.' },
    },
    required: ['query'],
  },
};

// ── Assistant tool set ────────────────────────────────────────────

/** All ChatTool definitions available to the assistant surface, mapped
 *  from the ASSISTANT_PROFILE's allowed tool names. Every name here is also
 *  registered with coreFor:'codeur' in toolRegistry.ts/toolRegistryLazy.ts's
 *  TOOL_META (see toolRegistry.test.ts's cross-registry integrity check) —
 *  the central registry is the single source of truth this roster must not
 *  drift from. */
export const ASSISTANT_TOOLS: ChatTool[] = [
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  READ_FILE_TOOL,
  READ_DIR_TOOL,
  SEARCH_CODE_TOOL,
  GIT_STATUS_TOOL,
  GIT_DIFF_TOOL,
  GIT_LOG_TOOL,
  FIND_TOOL_TOOL,
];

/** Get the full tool list for the assistant — brain tools + general tools.
 *  Used by assistantStore.tsx to populate req.tools. */
export function getAssistantToolList(brainEnabled: boolean): ChatTool[] | undefined {
  const tools: ChatTool[] = [];

  if (brainEnabled) {
    // Brain tools are imported from brainTool.ts to avoid circular deps
    // They're added by the caller (assistantStore) which already imports them.
    // Here we only add the non-brain tools.
  }

  tools.push(...ASSISTANT_TOOLS);
  return tools.length > 0 ? tools : undefined;
}
