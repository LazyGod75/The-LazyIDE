/* managedAgentVisualMeta.ts — which managed-loop tools warrant a canvas
   animation. Lookup table, not a 21-branch if-ladder. Undefined for file
   reads/writes, git, shell — those are not visually interesting enough. */

export type VisualToolIcon = 'browser' | 'mcp' | 'web';

export interface VisualToolMeta {
  label: string;
  icon: VisualToolIcon;
  detail?: string;
}

interface VisualToolSpec {
  label: string;
  icon: VisualToolIcon;
  detail?: string;
  detailKeys?: readonly string[];
}

const VISUAL_TOOLS: Record<string, VisualToolSpec> = {
  browser_open: { label: 'Browser Open', icon: 'browser', detail: 'Opening Chromium window…' },
  browser_navigate: { label: 'Browser Navigate', icon: 'browser', detailKeys: ['url'] },
  browser_click: { label: 'Browser Click', icon: 'browser', detailKeys: ['selector', 'text', 'ref'] },
  browser_fill: { label: 'Browser Fill', icon: 'browser', detailKeys: ['selector'] },
  browser_screenshot: { label: 'Browser Screenshot', icon: 'browser', detail: 'Capturing page…' },
  browser_snapshot: { label: 'Browser Snapshot', icon: 'browser', detail: 'Accessibility tree…' },
  browser_close: { label: 'Browser Close', icon: 'browser', detail: 'Closing browser…' },
  mcp_list_tools: { label: 'MCP List Tools', icon: 'mcp', detail: 'Discovering MCP tools…' },
  web_fetch: { label: 'Web Fetch', icon: 'web', detailKeys: ['url'] },
  web_search: { label: 'Web Search', icon: 'web', detailKeys: ['query'] },
};

function firstDefinedArg(args: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null) return String(args[key]);
  }
  return '';
}

export function getVisualToolMeta(
  action: string,
  args: Record<string, unknown>,
): VisualToolMeta | undefined {
  if (action === 'mcp_call') {
    const server = String(args.serverName ?? '');
    const tool = String(args.toolName ?? '');
    return { label: `MCP Call: ${server}`, icon: 'mcp', detail: tool };
  }
  const spec = VISUAL_TOOLS[action];
  if (!spec) return undefined;
  const detail = spec.detailKeys ? firstDefinedArg(args, spec.detailKeys) : spec.detail;
  return { label: spec.label, icon: spec.icon, detail };
}
