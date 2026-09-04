/* mcpRegistry — persistent configuration of MCP (Model Context Protocol)
   server connections. Stores server configs in localStorage and provides
   helpers to list/add/remove/update servers.

   Server configs describe how to connect to an MCP server:
   - stdio transport: command + args + env (e.g. npx -y @modelcontextprotocol/server-sentry)
   - sse transport: url + headers (e.g. https://api.sentry.dev/mcp/sse)

   The actual connection lifecycle is managed by mcpClient.ts, which reads
   configs from this registry.
*/

export type McpTransport = 'stdio' | 'sse';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse transport
  url?: string;
  headers?: Record<string, string>;
  // general
  enabled: boolean;
  createdAt: string;
}

const STORAGE_KEY = 'lazy.mcp.servers';

export function listServerConfigs(): McpServerConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as McpServerConfig[];
  } catch {
    return [];
  }
}

export function saveServerConfigs(servers: McpServerConfig[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
  } catch {
    // ignore
  }
}

export function addServerConfig(config: Omit<McpServerConfig, 'id' | 'createdAt'>): McpServerConfig {
  const servers = listServerConfigs();
  const newConfig: McpServerConfig = {
    ...config,
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  servers.push(newConfig);
  saveServerConfigs(servers);
  return newConfig;
}

export function updateServerConfig(id: string, updates: Partial<McpServerConfig>): void {
  const servers = listServerConfigs();
  const idx = servers.findIndex((s) => s.id === id);
  if (idx >= 0) {
    servers[idx] = { ...servers[idx], ...updates };
    saveServerConfigs(servers);
  }
}

export function removeServerConfig(id: string): void {
  const servers = listServerConfigs().filter((s) => s.id !== id);
  saveServerConfigs(servers);
}

// ── Preset server configs for common services ──────────────────────

export interface McpPreset {
  name: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: string[]; // env var names the user needs to provide
  url?: string;
  headers?: string[];
}

export const MCP_PRESETS: McpPreset[] = [
  {
    name: 'Sentry',
    description: 'Access Sentry errors, releases, and project data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sentry'],
    env: ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'],
  },
  {
    name: 'Slack',
    description: 'Access Slack channels, messages, and workspaces',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  },
  {
    name: 'Notion',
    description: 'Access Notion pages, databases, and workspaces',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-notion'],
    env: ['NOTION_API_KEY'],
  },
  {
    name: 'Linear',
    description: 'Access Linear issues, projects, and teams',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-linear'],
    env: ['LINEAR_API_KEY'],
  },
  {
    name: 'Figma',
    description: 'Access Figma files, components, and design data',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-figma'],
    env: ['FIGMA_ACCESS_TOKEN'],
  },
  {
    name: 'GitHub',
    description: 'Access GitHub repos, issues, PRs, and actions',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    name: 'Filesystem',
    description: 'Access local filesystem (sandboxed to specified directories)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: [],
  },
  {
    name: 'PostgreSQL',
    description: 'Access PostgreSQL databases (read-only by default)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: ['DATABASE_URL'],
  },
  {
    name: 'Brave Search',
    description: 'Web search via Brave Search API',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: ['BRAVE_API_KEY'],
  },
  {
    name: 'Datadog',
    description: 'Access Datadog metrics, logs, and dashboards',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-datadog'],
    env: ['DATADOG_API_KEY', 'DATADOG_APP_KEY'],
  },
];
