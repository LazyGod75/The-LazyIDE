/* toolProfiles — per-surface tool permission profiles.

   Defines which tools are available to each AI surface in the IDE:
     - assistant:  the chat assistant (read-only + web + brain, no destructive edits)
     - manager:    the LazyManager orchestrator (read + web + brain + delegate)
     - agent:      autonomous coding agents (full access, same as before)

   A profile is a simple allow-list of tool names. The shared toolRuntime
   checks the profile before executing any tool — blocked tools return an
   explanatory message instead of executing.

   This module is the single source of truth for surface→tool mapping.
   assistantStore.tsx, the manager, and managedAgent.ts all import from here.
*/

import { ALL_TOOLS } from '../agents/toolRegistry.js';
import type { ToolDef } from '../agents/toolRegistry.js';

// ── Profile definition ────────────────────────────────────────────

export type SurfaceName = 'assistant' | 'manager' | 'agent';

export interface ToolProfile {
  /** Surface name — identifies which AI surface this profile is for. */
  surface: SurfaceName;
  /** Tool names this surface is allowed to execute. */
  allowedTools: readonly string[];
  /** Tool names explicitly blocked (overrides allowedTools if both match). */
  deniedTools: readonly string[];
  /** Human-readable description of the profile for debugging/logging. */
  description: string;
}

// ── Tool name sets ────────────────────────────────────────────────

const ALL_TOOL_NAMES = ALL_TOOLS.map(t => t.name);

const READ_ONLY_NAV = [
  'read_file', 'read_dir', 'find_file', 'glob',
  'search_code', 'search_symbols',
  'goto_definition', 'find_references', 'get_diagnostics',
] as const;

const WEB_TOOLS = ['web_search', 'web_fetch'] as const;

const BRAIN_TOOLS = [
  'brain_query', 'brain_query_css', 'brain_neighbours',
  'brain_synthesize', 'brain_record',
] as const;

const GIT_READ_TOOLS = ['git_status', 'git_diff', 'git_log', 'review_diff'] as const;

const GIT_WRITE_TOOLS = ['git_commit'] as const;

const EDIT_TOOLS = [
  'write_file', 'edit_file', 'multi_edit', 'undo_edit',
  'rename_file', 'delete_file',
] as const;

const EXEC_TOOLS = ['run_command', 'run_tests', 'run_lint', 'run_build'] as const;

// find_tool (toolRegistryLazy.ts) is a read-only lookup meta-tool — granted
// on every profile alongside delegate/ask_user, since knowing a non-core
// tool's full definition never itself grants execution rights (the profile's
// own allowedTools list still gates the actual call).
const ORCHESTRATION_TOOLS = ['delegate', 'ask_user', 'find_tool'] as const;

// Cloud tools are Solari-hosted browser/desktop/sandbox actions. They are
// agent-only: the assistant and manager surfaces never touch the cloud. The
// full 31-name list mirrors the C1 cloud-handler registry (the readonly set
// in approvalTypes.ts plus the non-readonly actions).
const CLOUD_TOOLS = [
  'cloud_browser_open',
  'cloud_browser_close',
  'cloud_browser_navigate',
  'cloud_browser_read_page',
  'cloud_browser_click',
  'cloud_browser_type',
  'cloud_browser_screenshot',
  'cloud_browser_scroll',
  'cloud_browser_wait',
  'cloud_browser_replay_url',
  'cloud_browser_profiles_list',
  'cloud_browser_profile_save',
  'cloud_desktop_open',
  'cloud_desktop_close',
  'cloud_desktop_screenshot',
  'cloud_desktop_stream_url',
  'cloud_desktop_mouse_click',
  'cloud_desktop_mouse_move',
  'cloud_desktop_keyboard_type',
  'cloud_desktop_keyboard_hotkey',
  'cloud_desktop_exec',
  'cloud_desktop_clipboard_get',
  'cloud_desktop_clipboard_set',
  'cloud_desktop_file_write',
  'cloud_sandbox_open',
  'cloud_sandbox_close',
  'cloud_sandbox_read_file',
  'cloud_sandbox_file_list',
  'cloud_sandbox_write_file',
  'cloud_sandbox_exec',
  'cloud_sandbox_preview_url',
] as const;

// ── Profiles ──────────────────────────────────────────────────────

/** Assistant profile: read-only + web + brain + git-read.
 *  No destructive file edits, no command execution, no git commits.
 *  The assistant helps understand and explain — it doesn't modify code directly.
 */
export const ASSISTANT_PROFILE: ToolProfile = {
  surface: 'assistant',
  allowedTools: [
    ...READ_ONLY_NAV,
    ...WEB_TOOLS,
    ...BRAIN_TOOLS,
    ...GIT_READ_TOOLS,
    ...ORCHESTRATION_TOOLS,
  ],
  deniedTools: [
    ...EDIT_TOOLS,
    ...EXEC_TOOLS,
    ...GIT_WRITE_TOOLS,
  ],
  description: 'Assistant chat: read-only + web + brain + git-read. No edits, no exec, no commits.',
};

/** Manager profile: same as assistant plus delegation and git-read.
 *  The LazyManager orchestrates missions — it can read, search the web,
 *  query the brain, and delegate to agents, but doesn't edit files directly.
 */
export const MANAGER_PROFILE: ToolProfile = {
  surface: 'manager',
  allowedTools: [
    ...READ_ONLY_NAV,
    ...WEB_TOOLS,
    ...BRAIN_TOOLS,
    ...GIT_READ_TOOLS,
    ...ORCHESTRATION_TOOLS,
  ],
  deniedTools: [
    ...EDIT_TOOLS,
    ...EXEC_TOOLS,
    ...GIT_WRITE_TOOLS,
  ],
  description: 'LazyManager: read + web + brain + delegate. No direct edits or exec.',
};

/** Agent profile: full access to all tools.
 *  Autonomous coding agents can read, write, execute, search the web,
 *  query the brain, and use git — same as the pre-profile behavior.
 */
export const AGENT_PROFILE: ToolProfile = {
  surface: 'agent',
  allowedTools: [...ALL_TOOL_NAMES, ...CLOUD_TOOLS],
  deniedTools: [],
  description: 'Agent: full tool access (read, write, exec, web, brain, git, orchestration, cloud).',
};

// ── Registry ──────────────────────────────────────────────────────

const PROFILES = new Map<SurfaceName, ToolProfile>([
  ['assistant', ASSISTANT_PROFILE],
  ['manager', MANAGER_PROFILE],
  ['agent', AGENT_PROFILE],
]);

/** Get the tool profile for a given surface. */
export function getToolProfile(surface: SurfaceName): ToolProfile {
  const profile = PROFILES.get(surface);
  if (!profile) {
    throw new Error(`Unknown tool profile surface: ${surface}`);
  }
  return profile;
}

/** Check if a tool is allowed for a given surface. */
export function isToolAllowed(toolName: string, surface: SurfaceName): boolean {
  const profile = getToolProfile(surface);
  if (profile.deniedTools.includes(toolName)) return false;
  if (profile.allowedTools.length === 0) return true; // empty allow-list = allow all
  return profile.allowedTools.includes(toolName);
}

/** Get the list of ToolDefs available for a surface (for system prompt building). */
export function getToolsForSurface(surface: SurfaceName): ToolDef[] {
  const profile = getToolProfile(surface);
  return ALL_TOOLS.filter(t => profile.allowedTools.includes(t.name));
}

/** Build the tool-signature block for a surface's system prompt. */
export function buildSurfaceToolSignatures(surface: SurfaceName): string {
  const tools = getToolsForSurface(surface);
  const lines: string[] = [];
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.schema}`);
    lines.push(`  ${tool.description}`);
  }
  return lines.join('\n');
}

/** Build the pipe-separated ACTION list for a surface's ReAct prompt. */
export function buildSurfaceActionList(surface: SurfaceName): string {
  const tools = getToolsForSurface(surface);
  return [...tools.map(t => t.name), 'FINAL'].join(' | ');
}
