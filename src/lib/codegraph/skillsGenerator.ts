/* skillsGenerator.ts — Auto-generate agent skills from code communities (H).
   LazyBrain already has export-agents-md.ts which generates AGENTS.md from
   brain notes. This module does the equivalent for the CODE graph: detects
   functional areas (clusters), identifies entry points and key files, traces
   execution flows, and generates skill descriptions the agent can use.

   Output: GeneratedSkill[] that can be written as SKILL.md files or injected
   directly into the agent's system prompt.
*/

import type {
  CodeGraph, CodeCluster, ProcessFlow, GeneratedSkill, CodeNode,
} from './types.js';
import { detectClusters, detectProcesses } from './analyzer.js';

// ── Skill generation ──────────────────────────────────────────────

export function generateSkills(graph: CodeGraph): GeneratedSkill[] {
  const clusters = detectClusters(graph);
  const processes = detectProcesses(graph);

  // Build a map: nodeId → processes it participates in
  const nodeToProcesses = new Map<string, string[]>();
  for (const proc of processes) {
    for (const step of proc.steps) {
      const existing = nodeToProcesses.get(step.node.id) ?? [];
      existing.push(proc.name);
      nodeToProcesses.set(step.node.id, existing);
    }
  }

  const skills: GeneratedSkill[] = [];

  for (const cluster of clusters) {
    if (cluster.nodeCount < 3) continue; // Skip tiny clusters

    const skill = generateSkillForCluster(graph, cluster, processes);
    if (skill) skills.push(skill);
  }

  return skills.sort((a, b) => b.keyFiles.length - a.keyFiles.length);
}

function generateSkillForCluster(
  graph: CodeGraph,
  cluster: CodeCluster,
  allProcesses: ProcessFlow[],
): GeneratedSkill | null {
  // Get all nodes in this cluster
  const clusterNodes = cluster.nodeIds
    .map(id => graph.nodes.find(n => n.id === id))
    .filter((n): n is CodeNode => n !== undefined);

  if (clusterNodes.length < 3) return null;

  // Identify entry points: exported functions with no incoming calls
  const entryPoints: string[] = [];
  for (const node of clusterNodes) {
    if (node.kind !== 'function') continue;
    const incomingCalls = graph.edges.filter(
      e => e.target === node.id && e.type === 'calls',
    );
    if (node.isExported && incomingCalls.length === 0) {
      entryPoints.push(node.name);
    }
  }

  // Identify key files: files with the most symbols in this cluster
  const fileSymbolCount = new Map<string, number>();
  for (const node of clusterNodes) {
    if (node.kind === 'file' || node.kind === 'folder') continue;
    fileSymbolCount.set(node.filePath, (fileSymbolCount.get(node.filePath) ?? 0) + 1);
  }
  const keyFiles = Array.from(fileSymbolCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([fp]) => fp);

  // Find processes that involve this cluster
  const clusterNodeIds = new Set(cluster.nodeIds);
  const clusterProcesses = allProcesses.filter(proc =>
    proc.steps.some(step => clusterNodeIds.has(step.node.id)),
  );
  const processNames = clusterProcesses.map(p => p.name);

  // Find cross-area connections: edges from this cluster to other clusters
  const crossAreaConnections: string[] = [];
  for (const edge of graph.edges) {
    if (!clusterNodeIds.has(edge.source)) continue;
    const target = graph.nodes.find(n => n.id === edge.target);
    if (target && target.cluster && target.cluster !== cluster.id) {
      const connection = `${edge.source.split(':').pop()} → ${target.name} (${target.cluster})`;
      if (!crossAreaConnections.includes(connection)) {
        crossAreaConnections.push(connection);
      }
    }
  }

  // Generate description
  const label = cluster.label.replace('cluster:', '');
  const description = generateDescription(label, clusterNodes, entryPoints, clusterProcesses);

  return {
    name: label.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
    cluster,
    keyFiles,
    entryPoints,
    processes: processNames,
    crossAreaConnections: crossAreaConnections.slice(0, 10),
    description,
  };
}

function generateDescription(
  label: string,
  nodes: CodeNode[],
  entryPoints: string[],
  processes: ProcessFlow[],
): string {
  const functionCount = nodes.filter(n => n.kind === 'function').length;
  const classCount = nodes.filter(n => n.kind === 'class').length;
  const fileCount = new Set(nodes.map(n => n.filePath)).size;

  const parts: string[] = [];
  parts.push(`Functional area: ${label}`);
  parts.push(`Contains ${functionCount} functions, ${classCount} classes across ${fileCount} files.`);

  if (entryPoints.length > 0) {
    parts.push(`Entry points: ${entryPoints.slice(0, 5).join(', ')}`);
  }

  if (processes.length > 0) {
    parts.push(`Execution flows: ${processes.slice(0, 3).map(p => p.name).join(', ')}`);
  }

  return parts.join(' ');
}

// ── AGENTS.md generation from code graph (H2) ────────────────────

export const CODEGRAPH_BEGIN_MARKER = '<!-- codegraph:begin generated:do-not-edit -->';
export const CODEGRAPH_END_MARKER = '<!-- codegraph:end -->';

export function generateAgentsMd(skills: GeneratedSkill[]): string {
  const lines: string[] = ['## Code intelligence (auto-generated)'];
  lines.push('');
  lines.push('The following functional areas were detected in this codebase.');
  lines.push('Use these as context when working in each area:');
  lines.push('');

  for (const skill of skills) {
    lines.push(`### ${skill.cluster.label}`);
    lines.push('');
    lines.push(skill.description);
    lines.push('');

    if (skill.keyFiles.length > 0) {
      lines.push('**Key files:**');
      for (const file of skill.keyFiles) {
        lines.push(`  - \`${file}\``);
      }
      lines.push('');
    }

    if (skill.entryPoints.length > 0) {
      lines.push('**Entry points:**');
      for (const ep of skill.entryPoints) {
        lines.push(`  - \`${ep}\``);
      }
      lines.push('');
    }

    if (skill.processes.length > 0) {
      lines.push('**Execution flows:**');
      for (const proc of skill.processes) {
        lines.push(`  - ${proc}`);
      }
      lines.push('');
    }

    if (skill.crossAreaConnections.length > 0) {
      lines.push('**Cross-area connections:**');
      for (const conn of skill.crossAreaConnections) {
        lines.push(`  - ${conn}`);
      }
      lines.push('');
    }
  }

  lines.push('Use `code_query`, `code_context`, `code_impact` tools for deeper analysis.');

  return `${CODEGRAPH_BEGIN_MARKER}\n${lines.join('\n')}\n${CODEGRAPH_END_MARKER}`;
}

// ── Merge with existing AGENTS.md ─────────────────────────────────

export function mergeAgentsMd(
  existing: string,
  skills: GeneratedSkill[],
): string {
  const block = generateAgentsMd(skills);

  const beginCount = (existing.match(new RegExp(CODEGRAPH_BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  const endCount = (existing.match(new RegExp(CODEGRAPH_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;

  // Unbalanced markers — abort
  if (beginCount !== endCount || beginCount > 1) {
    return existing; // Don't corrupt user's file
  }

  if (beginCount === 1) {
    const start = existing.indexOf(CODEGRAPH_BEGIN_MARKER);
    const end = existing.indexOf(CODEGRAPH_END_MARKER) + CODEGRAPH_END_MARKER.length;
    return existing.slice(0, start) + block + existing.slice(end);
  }

  // No existing block — append
  if (existing.trim().length > 0) {
    return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
  }
  return `${block}\n`;
}
