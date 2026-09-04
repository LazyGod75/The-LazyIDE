/* toolDirectiveNames — standalone set of tool names that map to assistant
   tool directives, extracted here to avoid a circular import between
   systemPrompts.ts and assistantToolLoop.ts.

   systemPrompts.ts needs hasToolDirectives() at module-eval time to build
   prompts, and assistantToolLoop.ts imports executeTool → toolRuntime →
   managedToolPermissions → managedAgentPolicy → systemPrompts (RECALL_TEACHING).
   Keeping the name set here breaks that cycle.
*/

import type { ChatTool } from './types.js';

const TOOL_DIRECTIVE_NAMES = new Set([
  'web_search',
  'web_fetch',
  'read_file',
  'read_dir',
  'search_code',
  'git_status',
  'git_diff',
  'git_log',
  'find_tool',
]);

/** Check if any tool directives are available given the advertised tools. */
export function hasToolDirectives(tools?: ReadonlyArray<ChatTool>): boolean {
  return Array.isArray(tools) && tools.some(t => TOOL_DIRECTIVE_NAMES.has(t.name));
}
