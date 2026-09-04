/* toolRuntime — shared tool execution engine used by all AI surfaces.

   Extracted from managedAgent.ts so the assistant chat, LazyManager, and
   agent missions all share ONE implementation of read_file / web_search /
   brain_query / etc. Each surface selects which tools are available via a
   ToolProfile (toolProfiles.ts) — the runtime itself is surface-agnostic.

   The runtime is a pure function of (action, args, ctx) where ctx carries
   the root path (worktree for agents, projectRoot for assistant) and the
   permission profile to enforce. No dependency on "mission" or "worktree"
   concepts — just a root directory and policy.

   W-CODE — `list_transforms`/`run_transform` (below) are the ONLY custom-
   tool kind wired into a real dynamic dispatch here, unlike
   projectCommandTools.ts's "commande de projet" (still just run_command
   with an allowlisted string) or declarativeTools.ts's `web_read`/
   `file_read` (never wired into this switch at all — those execute only via
   compile.ts's rendered markdown for NATIVE claude-code-CLI missions).
   This is deliberately MANAGED-mission-only, and that scope is not an
   oversight: a native claude-code-CLI mission has no primitive to invoke a
   sandboxed in-process JS function the way this switch can — its only
   execution primitive is Bash, and rendering the function body into a
   shell command (`node -e "..."`) would hand it full Node ambient
   authority (fs, network, child processes), defeating transformSandbox.ts's
   entire safe-by-construction guarantee. See compile.ts's
   buildClaudeCodeAgentMd for how a native agent still sees the catalog as
   documentation-only, and transformSandbox.ts's header for the sandbox
   itself.

   Each tool action's implementation lives in handlers/<domain>.ts, grouped
   by domain (files, search, shell, git, network, brain, meta, mcp,
   browser) — see handlers/index.ts for the full action → handler map.
   executeTool itself is: policy gate, approval gate (cloud_* tools), lookup, call.
*/

import { checkToolExecution } from '../agents/managedToolPermissions.js';
import { interceptAction } from '../agents/approval/approvalGate.js';
import type { PageContext } from '../agents/approval/approvalTypes.js';
import { toolHandlers } from './handlers/index.js';
import { maskObservation } from '../bots/secretMasking.js';
import { enrichApprovalPageContext } from '../bots/botApprovalScreenshot.js';
export { resolvePath } from './handlers/shared.js';
export type { ToolExecutionContext } from './handlers/types.js';
import type { ToolExecutionContext } from './handlers/types.js';

/** Minimal page context assembled from a cloud tool call's own args. The
 *  classifier can work with just the URL and target text; ARIA role and
 *  input type would require a live browser session query (future work). */
function buildPageContext(args: Record<string, unknown>): PageContext {
  return {
    url: typeof args.url === 'string' ? args.url : undefined,
    targetText: typeof args.text === 'string' ? args.text : undefined,
    targetRole: undefined,
    inputType: undefined,
  };
}

/**
 * Execute a single tool action. Returns a string observation for the model.
 * Never throws — errors are caught and returned as "ERROR: ..." strings so
 * the calling loop always makes progress.
 *
 * Cloud (cloud_*) tools pass through the approval gate when a mission context
 * is present: denied/cancelled outcomes become observations, edited outcomes
 * swap in the edited args, and 'allow' proceeds to the handler.
 */
export async function executeTool(
  action: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  const { policy, agentMode } = ctx;

  const blocked = checkToolExecution(action, args, policy, agentMode);
  if (blocked) return blocked;

  let finalArgs = args;
  if (action.startsWith('cloud_') && ctx.missionId) {
    const outcome = await interceptAction({
      missionId: ctx.missionId,
      tool: action,
      args,
      page: enrichApprovalPageContext(ctx.missionId, buildPageContext(args)),
      autonomy: ctx.autonomy ?? 'supervised',
      signal: ctx.abortSignal,
    });
    if (outcome.kind === 'denied') return outcome.observation;
    if (outcome.kind === 'cancelled') return outcome.observation;
    if (outcome.kind === 'edited') finalArgs = outcome.args;
  }

  const handler = toolHandlers[action];
  if (!handler) return `Unknown tool: ${action}`;
  const result = await handler(finalArgs, ctx);
  // Mask secrets in cloud tool observations before they reach the agent context.
  if (action.startsWith('cloud_')) {
    return maskObservation(result);
  }
  return result;
}
