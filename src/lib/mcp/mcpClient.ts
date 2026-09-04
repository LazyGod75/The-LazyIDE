/* mcpClient — MCP (Model Context Protocol) client for connecting to external
   MCP servers via stdio or SSE transport.

   This module manages the lifecycle of MCP server connections:
   - For stdio servers: spawns a child process via the Tauri `mcp_spawn_server`
     Rust command, communicates via JSON-RPC 2.0 over stdin/stdout
   - For SSE servers: uses HTTP POST + Server-Sent Events via the Tauri
     `mcp_sse_call` Rust command

   The MCP protocol is JSON-RPC 2.0. We implement:
   1. initialize — handshake with the server
   2. tools/list — discover available tools
   3. tools/call — invoke a tool

   Server configs come from mcpRegistry.ts (persisted in localStorage).
   Connections are lazily established on first use and cached.
*/

import { invoke } from '@tauri-apps/api/core';
import { listServerConfigs, type McpServerConfig } from './mcpRegistry.js';

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface ConnectedServer {
  config: McpServerConfig;
  initialized: boolean;
  tools: McpToolInfo[];
}

const connectedServers = new Map<string, ConnectedServer>();

// ── JSON-RPC helpers ───────────────────────────────────────────────

let nextRequestId = 1;

function makeRpcRequest(method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: nextRequestId++,
    method,
    params,
  });
}

// ── Connection management ──────────────────────────────────────────

async function ensureConnected(config: McpServerConfig): Promise<ConnectedServer> {
  const existing = connectedServers.get(config.id);
  if (existing?.initialized) return existing;

  if (config.transport === 'stdio') {
    if (!config.command) throw new Error(`MCP server "${config.name}" has no command`);

    // Spawn the MCP server process via Rust
    await invoke('mcp_spawn_server', {
      id: config.id,
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
    });

    // Send initialize request
    const initRequest = makeRpcRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lazy-ide', version: '1.0.0' },
    });

    const initResponse = await invoke<string>('mcp_call_server', {
      id: config.id,
      message: initRequest,
      timeoutMs: 15000,
    });

    const initResult = JSON.parse(initResponse);
    if (initResult.error) {
      throw new Error(`MCP initialize failed for "${config.name}": ${initResult.error.message}`);
    }

    // Send initialized notification
    const initializedNotif = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    await invoke('mcp_send_server_stdin', { id: config.id, message: initializedNotif });

    // List tools
    const toolsRequest = makeRpcRequest('tools/list', {});
    const toolsResponse = await invoke<string>('mcp_call_server', {
      id: config.id,
      message: toolsRequest,
      timeoutMs: 10000,
    });

    const toolsResult = JSON.parse(toolsResponse);
    const tools: McpToolInfo[] = (toolsResult.result?.tools ?? []).map((t: Record<string, unknown>) => ({
      server: config.name,
      name: String(t.name ?? ''),
      description: String(t.description ?? ''),
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    const server: ConnectedServer = { config, initialized: true, tools };
    connectedServers.set(config.id, server);
    return server;
  }

  if (config.transport === 'sse') {
    if (!config.url) throw new Error(`MCP server "${config.name}" has no URL`);

    // For SSE, we use HTTP-based communication
    const initResponse = await invoke<string>('mcp_sse_call', {
      url: config.url,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lazy-ide', version: '1.0.0' },
      },
      headers: config.headers ?? {},
      timeoutMs: 15000,
    });

    const initResult = JSON.parse(initResponse);
    if (initResult.error) {
      throw new Error(`MCP initialize failed for "${config.name}": ${initResult.error.message}`);
    }

    // List tools
    const toolsResponse = await invoke<string>('mcp_sse_call', {
      url: config.url,
      method: 'tools/list',
      params: {},
      headers: config.headers ?? {},
      timeoutMs: 10000,
    });

    const toolsResult = JSON.parse(toolsResponse);
    const tools: McpToolInfo[] = (toolsResult.result?.tools ?? []).map((t: Record<string, unknown>) => ({
      server: config.name,
      name: String(t.name ?? ''),
      description: String(t.description ?? ''),
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));

    const server: ConnectedServer = { config, initialized: true, tools };
    connectedServers.set(config.id, server);
    return server;
  }

  throw new Error(`Unknown transport "${config.transport}" for server "${config.name}"`);
}

// ── Public API ─────────────────────────────────────────────────────

export async function listMcpTools(serverFilter?: string): Promise<McpToolInfo[]> {
  const configs = listServerConfigs().filter((c) => c.enabled);
  const filtered = serverFilter ? configs.filter((c) => c.name === serverFilter) : configs;
  const allTools: McpToolInfo[] = [];

  for (const config of filtered) {
    try {
      const server = await ensureConnected(config);
      allTools.push(...server.tools);
    } catch (err) {
      // Skip failed servers but don't abort the whole list
      console.warn(`MCP server "${config.name}" failed to connect:`, err);
    }
  }

  return allTools;
}

export async function callMcpTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const configs = listServerConfigs().filter((c) => c.enabled && c.name === serverName);
  if (configs.length === 0) {
    throw new Error(`MCP server "${serverName}" not found or not enabled`);
  }

  const config = configs[0];
  await ensureConnected(config);

  if (config.transport === 'stdio') {
    const request = makeRpcRequest('tools/call', {
      name: toolName,
      arguments: args,
    });

    const response = await invoke<string>('mcp_call_server', {
      id: config.id,
      message: request,
      timeoutMs: 30000,
    });

    const result = JSON.parse(response);
    if (result.error) {
      throw new Error(`MCP tool "${serverName}/${toolName}" error: ${result.error.message}`);
    }

    // MCP tools/call returns { content: [{ type: "text", text: "..." }] }
    const content = result.result?.content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter((c: Record<string, unknown>) => c.type === 'text')
        .map((c: Record<string, unknown>) => String(c.text ?? ''));
      if (textParts.length > 0) {
        try {
          return JSON.parse(textParts.join('\n'));
        } catch {
          return textParts.join('\n');
        }
      }
    }
    return result.result;
  }

  if (config.transport === 'sse') {
    const response = await invoke<string>('mcp_sse_call', {
      url: config.url!,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      headers: config.headers ?? {},
      timeoutMs: 30000,
    });

    const result = JSON.parse(response);
    if (result.error) {
      throw new Error(`MCP tool "${serverName}/${toolName}" error: ${result.error.message}`);
    }

    const content = result.result?.content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter((c: Record<string, unknown>) => c.type === 'text')
        .map((c: Record<string, unknown>) => String(c.text ?? ''));
      if (textParts.length > 0) {
        try {
          return JSON.parse(textParts.join('\n'));
        } catch {
          return textParts.join('\n');
        }
      }
    }
    return result.result;
  }

  throw new Error(`Unknown transport for server "${serverName}"`);
}

export async function disconnectServer(serverId: string): Promise<void> {
  const server = connectedServers.get(serverId);
  if (!server) return;

  if (server.config.transport === 'stdio') {
    try {
      await invoke('mcp_stop_server', { id: serverId });
    } catch {
      // ignore
    }
  }

  connectedServers.delete(serverId);
}

export async function disconnectAll(): Promise<void> {
  for (const id of connectedServers.keys()) {
    await disconnectServer(id);
  }
}

export function getConnectedServers(): string[] {
  return [...connectedServers.keys()].filter((id) => connectedServers.get(id)?.initialized);
}
