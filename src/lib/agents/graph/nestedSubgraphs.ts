/* nestedSubgraphs.ts — P8.2: Nested subgraph support.

   Allows a SubgraphNode to reference another GraphIR by id, enabling
   hierarchical composition of agent workflows. The parent graph treats
   the subgraph as a single node; the subgraph's nodes are expanded
   at execution time.

   This module provides the expansion logic: given a graph with subgraph
   nodes and a registry of subgraph IRs, produce a flattened graph that
   the wave executor can run.
*/

import type { GraphIR, GraphNode, GraphEdge } from './types.js';

export interface SubgraphRegistry {
  get(id: string): GraphIR | undefined;
}

/** Flatten a graph by expanding all SubgraphNodes into their child nodes. */
export function expandSubgraphs(
  ir: GraphIR,
  registry: SubgraphRegistry,
): GraphIR {
  const expandedNodes: GraphNode[] = [];
  const expandedEdges: GraphEdge[] = [];
  const nodeIdMap = new Map<string, string>(); // original node id → expanded id

  for (const node of ir.nodes) {
    if (node.kind === 'subgraph') {
      const subIr = resolveSubgraphRef(node.graph, registry);
      if (!subIr) {
        // Subgraph not found — keep as a task node with error description
        expandedNodes.push({
          ...node,
          kind: 'task',
          description: `[Subgraph not found: ${resolveGraphId(node.graph)}]`,
          contract: { proofs: [], acceptance: [] },
        } as unknown as GraphNode);
        nodeIdMap.set(node.id, node.id);
        continue;
      }

      // Expand subgraph nodes with prefixed IDs
      const prefix = `${node.id}__`;
      for (const subNode of subIr.nodes) {
        const expandedId = `${prefix}${subNode.id}`;
        nodeIdMap.set(subNode.id, expandedId);
        expandedNodes.push({
          ...subNode,
          id: expandedId,
        });
      }

      // Expand subgraph edges
      for (const subEdge of subIr.edges) {
        expandedEdges.push({
          ...subEdge,
          from: `${prefix}${subEdge.from}`,
          to: `${prefix}${subEdge.to}`,
        });
      }

      // Map the subgraph node's own id to its first entry node
      const entryNode = subIr.nodes.find((n) =>
        !subIr.edges.some((e) => e.to === n.id && e.kind === 'control'),
      );
      if (entryNode) {
        nodeIdMap.set(node.id, `${prefix}${entryNode.id}`);
      }
    } else {
      expandedNodes.push(node);
      nodeIdMap.set(node.id, node.id);
    }
  }

  // Remap parent edges to expanded node IDs
  for (const edge of ir.edges) {
    const fromId = nodeIdMap.get(edge.from) ?? edge.from;
    const toId = nodeIdMap.get(edge.to) ?? edge.to;
    expandedEdges.push({
      ...edge,
      from: fromId,
      to: toId,
    });
  }

  return {
    ...ir,
    nodes: expandedNodes,
    edges: expandedEdges,
  };
}

/** Validate that no subgraph references create a cycle. */
export function validateSubgraphDepth(
  ir: GraphIR,
  registry: SubgraphRegistry,
  maxDepth = 10,
): { ok: boolean; error?: string } {
  const visited = new Set<string>();

  function check(subgraphId: string, depth: number): { ok: boolean; error?: string } {
    if (depth > maxDepth) {
      return { ok: false, error: `Max subgraph depth (${maxDepth}) exceeded` };
    }
    if (visited.has(subgraphId)) {
      return { ok: false, error: `Circular subgraph reference: ${subgraphId}` };
    }
    visited.add(subgraphId);

    const subIr = registry.get(subgraphId);
    if (!subIr) return { ok: true };

    for (const node of subIr.nodes) {
      if (node.kind === 'subgraph') {
        const gid = resolveGraphId(node.graph);
        const result = check(gid, depth + 1);
        if (!result.ok) return result;
      }
    }

    visited.delete(subgraphId);
    return { ok: true };
  }

  for (const node of ir.nodes) {
    if (node.kind === 'subgraph') {
      const gid = resolveGraphId(node.graph);
      const result = check(gid, 1);
      if (!result.ok) return result;
    }
  }

  return { ok: true };
}

function resolveGraphId(graph: GraphIR | { graphId: string }): string {
  if ('graphId' in graph) return graph.graphId;
  return graph.id;
}

function resolveSubgraphRef(graph: GraphIR | { graphId: string }, registry: SubgraphRegistry): GraphIR | undefined {
  if ('graphId' in graph) return registry.get(graph.graphId);
  return graph; // inline GraphIR
}
