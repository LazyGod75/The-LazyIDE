/* canvasGitExport.ts — P8.4: Canvas↔code git export.

   Exports a canvas (drafts, chains, routers, joins, contests) as a
   deterministic directory structure that can be committed to git, and
   imports it back. This enables version-controlling agent workflows
   alongside the code they operate on.

   Export format:
     .lazy/canvas/
       workflow.yaml          — human-readable YAML overview
       nodes/
         <id>.json            — one file per draft/router/join
       edges/
         <id>.json            — one file per chain
       contests/
         <id>.json            — one file per contest
       manifest.json          — version, export date, node count
*/

import type { DraftSpec, Chain, RouterSpec, JoinSpec, ContestSpec } from '../../components/agents/canvas/canvasTypes.js';

export interface CanvasExportData {
  drafts: DraftSpec[];
  chains: Chain[];
  routers: RouterSpec[];
  joins: JoinSpec[];
  contests: ContestSpec[];
}

export interface CanvasManifest {
  version: 1;
  exportedAt: number;
  nodeCount: number;
  edgeCount: number;
  contestCount: number;
}

/** Serialize canvas data into a directory of files (as a map of path → content). */
export function exportCanvasToFiles(data: CanvasExportData): Map<string, string> {
  const files = new Map<string, string>();

  // Manifest
  const manifest: CanvasManifest = {
    version: 1,
    exportedAt: Date.now(),
    nodeCount: data.drafts.length + data.routers.length + data.joins.length,
    edgeCount: data.chains.length,
    contestCount: data.contests.length,
  };
  files.set('.lazy/canvas/manifest.json', JSON.stringify(manifest, null, 2));

  // Nodes
  for (const draft of data.drafts) {
    files.set(`.lazy/canvas/nodes/${draft.id}.json`, JSON.stringify(draft, null, 2));
  }
  for (const router of data.routers) {
    files.set(`.lazy/canvas/nodes/${router.id}.json`, JSON.stringify(router, null, 2));
  }
  for (const join of data.joins) {
    files.set(`.lazy/canvas/nodes/${join.id}.json`, JSON.stringify(join, null, 2));
  }

  // Edges
  for (const chain of data.chains) {
    files.set(`.lazy/canvas/edges/${chain.id}.json`, JSON.stringify(chain, null, 2));
  }

  // Contests
  for (const contest of data.contests) {
    files.set(`.lazy/canvas/contests/${contest.id}.json`, JSON.stringify(contest, null, 2));
  }

  return files;
}

/** Import canvas data from a map of files (as produced by exportCanvasToFiles). */
export function importCanvasFromFiles(files: Map<string, string>): CanvasExportData {
  const drafts: DraftSpec[] = [];
  const chains: Chain[] = [];
  const routers: RouterSpec[] = [];
  const joins: JoinSpec[] = [];
  const contests: ContestSpec[] = [];

  for (const [path, content] of files) {
    if (path.startsWith('.lazy/canvas/nodes/')) {
      const parsed = JSON.parse(content);
      if ('task' in parsed) drafts.push(parsed as DraftSpec);
      else if ('branches' in parsed) routers.push(parsed as RouterSpec);
      else if ('mode' in parsed) joins.push(parsed as JoinSpec);
    } else if (path.startsWith('.lazy/canvas/edges/')) {
      chains.push(JSON.parse(content) as Chain);
    } else if (path.startsWith('.lazy/canvas/contests/')) {
      contests.push(JSON.parse(content) as ContestSpec);
    }
  }

  return { drafts, chains, routers, joins, contests };
}

/** Generate a human-readable YAML overview of the canvas. */
export function exportCanvasYamlOverview(data: CanvasExportData): string {
  const lines: string[] = [
    `# Canvas export — ${new Date().toISOString()}`,
    `# ${data.drafts.length} drafts, ${data.chains.length} chains, ${data.routers.length} routers, ${data.joins.length} joins`,
    '',
    'nodes:',
  ];

  for (const draft of data.drafts) {
    lines.push(`  - id: ${draft.id}`);
    lines.push(`    title: "${escapeYaml(draft.title)}"`);
    lines.push(`    model: ${draft.model ?? 'default'}`);
    if (draft.agentName) lines.push(`    agent: ${draft.agentName}`);
  }

  lines.push('', 'edges:');
  for (const chain of data.chains) {
    lines.push(`  - id: ${chain.id}`);
    lines.push(`    from: ${chain.sourceRef}`);
    lines.push(`    to: ${chain.targetRef}`);
    if (chain.disabled) lines.push('    disabled: true');
  }

  if (data.contests.length > 0) {
    lines.push('', 'contests:');
    for (const contest of data.contests) {
      lines.push(`  - id: ${contest.id}`);
      lines.push(`    status: ${contest.status}`);
      if (contest.winnerId) lines.push(`    winner: ${contest.winnerId}`);
      lines.push(`    contestants: [${contest.missionIds.join(', ')}]`);
    }
  }

  return lines.join('\n');
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}
