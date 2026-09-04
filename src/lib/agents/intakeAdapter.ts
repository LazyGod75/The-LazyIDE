/* intakeAdapter.ts — P7.4: GitHub/Linear issue intake.

   Converts external issue tracker items (GitHub Issues, Linear issues)
   into mission drafts that can be launched on the canvas.

   Pure transformation — no network calls here. The caller fetches issues
   from the provider's API and passes the normalized items to `intakeToDraft`.
*/

import type { DraftSpec } from '../../components/agents/canvas/canvasTypes.js';

/** A normalized issue from any tracker (GitHub, Linear, etc.). */
export interface IntakeIssue {
  id: string;
  source: 'github' | 'linear';
  title: string;
  body: string;
  labels: string[];
  assignee?: string;
  url: string;
  /** Priority from the source system (1=urgent, 2=high, 3=medium, 4=low). */
  priority?: number;
}

/** Configuration for intake-to-draft conversion. */
export interface IntakeConfig {
  projectId: string;
  /** Default model for intake-generated drafts. */
  defaultModel: string;
  /** Default agent name (optional). */
  defaultAgentName?: string;
  /** Label → autonomy level mapping. */
  labelAutonomyMap?: Record<string, 'manual' | 'supervised' | 'yolo'>;
}

/** Convert an intake issue into a canvas DraftSpec. */
export function intakeToDraft(
  issue: IntakeIssue,
  config: IntakeConfig,
): DraftSpec {
  const autonomy = resolveAutonomy(issue.labels, config.labelAutonomyMap);

  const task = buildTaskFromIssue(issue, autonomy);

  return {
    id: `intake-${issue.source}-${issue.id}`,
    title: issue.title,
    task,
    model: config.defaultModel,
    agentName: config.defaultAgentName,
    projectId: config.projectId,
    createdBy: 'manager',
  };
}

/** Convert multiple issues into drafts. */
export function intakeToDrafts(
  issues: IntakeIssue[],
  config: IntakeConfig,
): DraftSpec[] {
  return issues.map((issue) => intakeToDraft(issue, config));
}

/** Build a task prompt from an issue. */
function buildTaskFromIssue(
  issue: IntakeIssue,
  autonomy: 'manual' | 'supervised' | 'yolo',
): string {
  const lines: string[] = [
    `# ${issue.title}`,
    '',
    issue.body,
    '',
    `## Context`,
    `- Source: ${issue.source} #${issue.id}`,
    `- URL: ${issue.url}`,
  ];

  if (issue.labels.length > 0) {
    lines.push(`- Labels: ${issue.labels.join(', ')}`);
  }
  if (issue.assignee) {
    lines.push(`- Assignee: ${issue.assignee}`);
  }
  if (issue.priority) {
    lines.push(`- Priority: ${priorityLabel(issue.priority)}`);
  }

  lines.push(`- Autonomy: ${autonomy}`);

  return lines.join('\n');
}

function resolveAutonomy(
  labels: string[],
  map?: Record<string, 'manual' | 'supervised' | 'yolo'>,
): 'manual' | 'supervised' | 'yolo' {
  if (!map) return 'supervised';
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (map[lower]) return map[lower];
  }
  return 'supervised';
}

function priorityLabel(p: number): string {
  switch (p) {
    case 1: return 'Urgent';
    case 2: return 'High';
    case 3: return 'Medium';
    case 4: return 'Low';
    default: return 'Unknown';
  }
}

/** Fetch GitHub issues from a repo (requires gh CLI or API token). */
export async function fetchGitHubIssues(
  repo: string,
  token?: string,
): Promise<IntakeIssue[]> {
  const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=50`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status}`);
  }

  const items = await resp.json() as Array<{
    number: number;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    assignee: { login: string } | null;
    html_url: string;
  }>;

  return items
    .filter((item) => !('pull_request' in item))
    .map((item) => ({
      id: String(item.number),
      source: 'github' as const,
      title: item.title,
      body: item.body ?? '',
      labels: item.labels.map((l) => l.name),
      assignee: item.assignee?.login,
      url: item.html_url,
    }));
}

/** Fetch Linear issues (requires API key). */
export async function fetchLinearIssues(
  apiKey: string,
  teamId?: string,
): Promise<IntakeIssue[]> {
  const query = teamId
    ? `query { issues(filter: { team: { id: { eq: "${teamId}" } }, state: { type: { eq: "started" } } }) { nodes { id title description url labels { nodes { name } } assignee { name } priority } } }`
    : `query { issues(filter: { state: { type: { eq: "started" } } }) { nodes { id title description url labels { nodes { name } } assignee { name } priority } } }`;

  const resp = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) {
    throw new Error(`Linear API error: ${resp.status}`);
  }

  const data = await resp.json() as {
    data: {
      issues: {
        nodes: Array<{
          id: string;
          title: string;
          description: string | null;
          url: string;
          labels: { nodes: Array<{ name: string }> };
          assignee: { name: string } | null;
          priority: number | null;
        }>;
      };
    };
  };

  return data.data.issues.nodes.map((node) => ({
    id: node.id,
    source: 'linear' as const,
    title: node.title,
    body: node.description ?? '',
    labels: node.labels.nodes.map((l) => l.name),
    assignee: node.assignee?.name,
    url: node.url,
    priority: node.priority ?? undefined,
  }));
}
