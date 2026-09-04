/* Shared types for tool handlers — extracted from toolRuntime.ts.

   Each domain module (files.ts, git.ts, ...) imports ToolHandler/
   ToolExecutionContext from here rather than from toolRuntime.ts itself:
   toolRuntime.ts imports the handler modules to build its dispatch table,
   so a handler importing back from toolRuntime.ts would create a cycle.
   toolRuntime.ts re-exports ToolExecutionContext from here so external
   importers (managedAgent.ts, tests, ...) see no change. */

import type { ToolPolicy } from '../../agents/managedAgentPolicy.js';
import type { AgentPermissionMode } from '../../agents/managedToolPermissions.js';

export interface ToolExecutionContext {
  /** Root directory for resolving relative paths. Worktree for agents,
   *  projectRoot for the assistant chat. */
  rootPath: string;
  /** Permission policy — blocks tools not allowed for this surface. */
  policy: ToolPolicy;
  /** Permission mode axis (auto/ask/exclude) — mirrors managedToolPermissions. */
  agentMode: AgentPermissionMode;
  /**
   * P-SEARCH (additive, optional) — present ONLY for a real mission run
   * (managedAgent.ts's local `executeTool` wrapper threads its own
   * missionId/agentName/projectId through); absent for the assistant/
   * codeur chat and the LazyManager, which have no mission/project of
   * their own. Never read by `checkToolExecution`/policy enforcement —
   * this module stays "a pure function of (action, args, ctx)" for every
   * OTHER tool case (this file's own header) — used SOLELY to enrich the
   * `web_search` case with the canvas-visible context needed to show a
   * SearchNode surface next to the calling agent's mission (see
   * 'canvas:webSearchResult' in lib/bus.ts and this case's own comment).
   */
  missionId?: string;
  agentName?: string;
  projectId?: string;
  /** Autonomy mode for the approval gate — only relevant for cloud_* tools.
   *  'manual' = gate every non-readonly cloud action; 'supervised' = class/rules
   *  decide (default); 'yolo' = only credentials are gated. */
  autonomy?: 'manual' | 'supervised' | 'yolo';
  /** AbortSignal for the current mission — when aborted, a pending approval
   *  resolves as 'cancelled' so the agent loop unblocks immediately. */
  abortSignal?: AbortSignal;
}

/** Signature every extracted tool-case handler conforms to: a pure-ish
 *  async function of (args, ctx) returning the string observation the
 *  model sees. Mirrors executeTool's own contract — never throws, errors
 *  are caught internally and returned as "ERROR: ..." strings. */
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<string>;
