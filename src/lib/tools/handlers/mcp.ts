/* MCP-domain tool handlers: mcp_list_tools/mcp_call.
   Extracted verbatim from toolRuntime.ts's executeTool switch. */

import type { ToolExecutionContext } from './types.js';

export async function mcpListTools(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const serverFilter = args.server ? String(args.server) : '';
  try {
    const { listMcpTools } = await import('../../mcp/mcpClient.js');
    const tools = await listMcpTools(serverFilter);
    if (tools.length === 0) return 'No MCP servers connected. Configure MCP servers in Settings → MCP.';
    return tools.map(t => `${t.server}/${t.name} — ${t.description}`).join('\n');
  } catch (err) {
    return `ERROR: mcp_list_tools failed: ${String(err)}`;
  }
}

export async function mcpCall(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const server = String(args.server ?? '');
  const tool = String(args.tool ?? '');
  const argumentsObj = (args.arguments && typeof args.arguments === 'object') ? args.arguments as Record<string, unknown> : {};
  if (!server) return 'ERROR: No MCP server name provided';
  if (!tool) return 'ERROR: No MCP tool name provided';
  try {
    const { callMcpTool } = await import('../../mcp/mcpClient.js');
    const result = await callMcpTool(server, tool, argumentsObj);
    const serialized = JSON.stringify(result);
    return serialized.length > 2000 ? serialized.slice(0, 2000) + '... (truncated)' : serialized;
  } catch (err) {
    return `ERROR: mcp_call failed: ${String(err)}`;
  }
}
