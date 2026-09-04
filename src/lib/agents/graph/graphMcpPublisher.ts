/* graphMcpPublisher.ts — P7.6: Publish graph as MCP server.

   Converts a GraphIR into an MCP (Model Context Protocol) server definition
   that external agents can connect to. Each node in the graph becomes an
   MCP tool that can be invoked independently.

   This enables sharing agent workflows with external MCP-compatible clients
   (Claude Desktop, other IDEs, etc.) as callable tools.
*/

import type { GraphIR, GraphNode } from './types.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface McpServerDefinition {
  name: string;
  version: string;
  tools: McpToolDefinition[];
}

/** Convert a GraphIR into an MCP server definition. */
export function graphToMcpServer(
  ir: GraphIR,
  options?: { serverName?: string; version?: string },
): McpServerDefinition {
  const tools = ir.nodes.map((node) => nodeToMcpTool(node));

  return {
    name: options?.serverName ?? `lazy-graph-${ir.id}`,
    version: options?.version ?? '1.0.0',
    tools,
  };
}

function nodeToMcpTool(node: GraphNode): McpToolDefinition {
  const name = sanitizeToolName(node.id);
  const description = getNodeDescription(node);

  const properties: Record<string, { type: string; description: string }> = {
    input: {
      type: 'string',
      description: 'Input text for the task',
    },
  };

  if (node.kind === 'contest') {
    properties.n = {
      type: 'number',
      description: 'Number of contestants (optional, uses node default)',
    };
  }

  if (node.kind === 'form') {
    properties.response = {
      type: 'string',
      description: 'User response to the form prompt',
    };
  }

  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
    },
  };
}

function getNodeDescription(node: GraphNode): string {
  switch (node.kind) {
    case 'task':
      return node.description;
    case 'contest':
      return node.description;
    case 'form':
      return node.prompt;
    case 'interrupt':
      return node.reason;
    case 'router':
      return `Router: ${node.label ?? node.id}`;
    case 'join':
      return `Join node (${node.mode}): ${node.label ?? node.id}`;
    case 'loop':
      return `Loop: ${node.label ?? node.id}`;
    default:
      return node.label ?? node.id;
  }
}

function sanitizeToolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
}

/** Generate an MCP server config JSON (for Claude Desktop, etc.). */
export function generateMcpConfig(
  server: McpServerDefinition,
  command: string,
  args?: string[],
): Record<string, unknown> {
  return {
    mcpServers: {
      [server.name]: {
        command,
        args: args ?? [],
        env: {
          LAZY_GRAPH_TOOLS: JSON.stringify(server.tools.map((t) => t.name)),
        },
      },
    },
  };
}
