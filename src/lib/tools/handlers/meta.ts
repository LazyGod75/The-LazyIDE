/* Meta/catalog-domain tool handlers: transform catalog, delegation,
   ask_user, and the lazy tool-registry lookup find_tool.
   Extracted verbatim from toolRuntime.ts's executeTool switch. */

import { listTransformTools } from '../../agents/transformTools.js';
import type { TransformTool } from '../../agents/transformTools.js';
import { runTransformSandbox } from '../../agents/transformSandbox.js';
import { formatFindToolResult } from '../../agents/toolRegistryLazy.js';
import type { ToolExecutionContext } from './types.js';

export async function listTransforms(_args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  try {
    const tools = await listTransformTools();
    if (tools.length === 0) return 'No transformation tools defined for this project.';
    return tools.map((t) => `${t.id} — ${t.name}: ${t.description}`).join('\n');
  } catch (err) {
    return `ERROR: list_transforms failed: ${String(err)}`;
  }
}

export async function runTransform(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const toolId = String(args.tool_id ?? '');
  if (!toolId) return 'ERROR: No tool_id provided — call list_transforms first to find one.';
  let tools: TransformTool[];
  try {
    tools = await listTransformTools();
  } catch (err) {
    return `ERROR: run_transform failed to load the transformation catalog: ${String(err)}`;
  }
  const tool = tools.find((t) => t.id === toolId);
  if (!tool) return `ERROR: no transformation tool with id "${toolId}" — call list_transforms to see valid ids.`;
  const outcome = await runTransformSandbox(tool.code, args.input);
  if (!outcome.ok) return `ERROR: transformation "${tool.name}" failed: ${outcome.error ?? 'unknown error'}`;
  const serialized = JSON.stringify(outcome.result ?? null);
  const truncated = serialized.length > 2000 ? serialized.slice(0, 2000) + '... (truncated)' : serialized;
  return `Transformation "${tool.name}" result:\n${truncated}`;
}

export async function delegate(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const task = String(args.task ?? '');
  if (!task) return 'ERROR: No task provided for delegation';
  return `[delegated] Sub-task queued: ${task}. Note: delegation requires a sub-agent runtime — for now, handle this task directly with the available tools.`;
}

export async function askUser(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const question = String(args.question ?? '');
  if (!question) return 'ERROR: No question provided';
  // W-COST (quick-reply wave) — the tool's own schema (toolRegistry.ts)
  // already asks the model for "2-4 options when possible", but until
  // now this handler silently dropped `args.options` on the floor: it
  // never made it into the observation text, so missionQuestion.ts's
  // extractor (and every UI built on it — AttentionInbox's inbox item,
  // MissionNode's pendingQuestion badge) never saw them, and the human
  // always fell back to typing a free-text answer even when the agent
  // had offered a clean multiple-choice. Encoded as a trailing
  // `missionQuestion.ts`-parseable suffix (see its OPTIONS_MARKER doc
  // comment) rather than a second return value, since this string IS the
  // real actionTimeline observation persisted for the mission — no
  // separate channel exists to carry structured data alongside it today.
  // The old "Note: use the intervene mechanism..." sentence is dropped:
  // it was pure prose filler (no test/consumer keys off it — verified),
  // and freeing that space matters because managedAgent.ts's onAction
  // truncates the whole observation to 120 chars, and options need to
  // fit within that budget more than a reminder sentence does.
  const rawOptions = Array.isArray(args.options) ? args.options : [];
  const options = rawOptions.map((o) => String(o).trim()).filter((o) => o.length > 0);
  const optionsSuffix = options.length > 0 ? `\n<<<OPTIONS>>>${JSON.stringify(options)}` : '';
  return `Question for user: ${question}${optionsSuffix}`;
}

// Lazy tool loading (toolRegistryLazy.ts) — most tools are advertised as
// a one-line index hint only; find_tool fetches a tool's full definition
// (schema + ACI-optimized description) on demand, by exact name,
// substring, tag, or keyword. Read-only/documentation lookup only — it
// never grants execution rights the caller's ToolProfile doesn't already
// allow (checkToolExecution still gates the actual tool call).
export async function findTool(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const query = String(args.query ?? '');
  if (!query.trim()) return 'ERROR: find_tool requires a "query" argument (tool name, tag, or keyword).';
  return formatFindToolResult(query);
}
