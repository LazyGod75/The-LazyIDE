/* analyzer.ts — Graph analysis: impact (blast radius), 360° context,
   trace (shortest path), process detection, rename preview, git-diff impact.
   These are the core "smart tools" that make the agent reliable.
*/

import type {
  CodeGraph, CodeNode, CodeEdge,
  ImpactResult, ImpactDirection, ImpactLevel, ImpactSymbol,
  ContextView, TraceResult, TraceHop,
  ProcessFlow, ProcessStep,
  RouteMapping, DiffImpact, RenamePreview, RenameChange,
  CodeCluster, EdgeType,
} from './types.js';

// ── Graph helpers ─────────────────────────────────────────────────

function nodeById(graph: CodeGraph, id: string): CodeNode | undefined {
  return graph.nodes.find(n => n.id === id);
}

function nodesByName(graph: CodeGraph, name: string): CodeNode[] {
  const ids = graph.nameIndex.get(name) ?? [];
  return ids.map(id => nodeById(graph, id)).filter((n): n is CodeNode => n !== undefined);
}

function edgesFrom(graph: CodeGraph, nodeId: string): CodeEdge[] {
  return graph.edges.filter(e => e.source === nodeId);
}

function edgesTo(graph: CodeGraph, nodeId: string): CodeEdge[] {
  return graph.edges.filter(e => e.target === nodeId);
}

// ── Impact analysis (A2) ──────────────────────────────────────────

export function analyzeImpact(
  graph: CodeGraph,
  targetName: string,
  direction: ImpactDirection = 'upstream',
  opts?: { maxDepth?: number; minConfidence?: number; relationTypes?: EdgeType[] },
): ImpactResult {
  const maxDepth = opts?.maxDepth ?? 3;
  const minConfidence = opts?.minConfidence ?? 0.5;
  const relationTypes = opts?.relationTypes ?? ['calls', 'imports', 'extends', 'implements'];

  const candidates = nodesByName(graph, targetName);
  const target = candidates[0];
  if (!target) {
    return {
      target: { id: '', name: targetName, kind: 'function', filePath: '', startLine: 0, endLine: 0, language: '', isExported: false },
      direction, levels: [], totalAffected: 0, riskLevel: 'low',
    };
  }

  const visited = new Set<string>([target.id]);
  const levels: ImpactLevel[] = [];

  let currentLayer = [target.id];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextLayer: string[] = [];
    const symbols: ImpactSymbol[] = [];

    for (const nodeId of currentLayer) {
      const edges = direction === 'upstream' ? edgesTo(graph, nodeId) : edgesFrom(graph, nodeId);
      for (const edge of edges) {
        if (!relationTypes.includes(edge.type)) continue;
        if (edge.confidenceScore < minConfidence) continue;

        const otherId = direction === 'upstream' ? edge.source : edge.target;
        if (visited.has(otherId)) continue;
        visited.add(otherId);

        const otherNode = nodeById(graph, otherId);
        if (!otherNode) continue;

        nextLayer.push(otherId);
        symbols.push({ node: otherNode, edgeType: edge.type, confidence: edge.confidenceScore });
      }
    }

    if (symbols.length === 0) break;

    const label = depth === 1 ? 'WILL BREAK' : depth === 2 ? 'LIKELY AFFECTED' : `DEPTH ${depth}`;
    levels.push({ depth, label, symbols });
    currentLayer = nextLayer;
  }

  const totalAffected = levels.reduce((sum, l) => sum + l.symbols.length, 0);
  const riskLevel = totalAffected > 20 ? 'high' : totalAffected > 5 ? 'medium' : 'low';

  return { target, direction, levels, totalAffected, riskLevel };
}

// ── 360° context view (A4) ────────────────────────────────────────

export function buildContext(graph: CodeGraph, name: string): ContextView | null {
  const candidates = nodesByName(graph, name);
  const symbol = candidates[0];
  if (!symbol) return null;

  const incomingCalls: CodeNode[] = [];
  const incomingImports: CodeNode[] = [];
  const outgoingCalls: CodeNode[] = [];
  const outgoingImports: CodeNode[] = [];

  for (const edge of edgesTo(graph, symbol.id)) {
    const source = nodeById(graph, edge.source);
    if (!source) continue;
    if (edge.type === 'calls') incomingCalls.push(source);
    else if (edge.type === 'imports') incomingImports.push(source);
  }

  for (const edge of edgesFrom(graph, symbol.id)) {
    const target = nodeById(graph, edge.target);
    if (!target) continue;
    if (edge.type === 'calls') outgoingCalls.push(target);
    else if (edge.type === 'imports') outgoingImports.push(target);
  }

  // Find processes this symbol participates in
  const processes: Array<{ name: string; step: number; total: number }> = [];
  for (const edge of edgesTo(graph, symbol.id)) {
    if (edge.type === 'step_in_process') {
      const proc = nodeById(graph, edge.source);
      if (proc) {
        const allSteps = edgesFrom(graph, proc.id).filter(e => e.type === 'step_in_process');
        const stepNum = allSteps.findIndex(e => e.target === symbol.id) + 1;
        processes.push({ name: proc.name, step: stepNum, total: allSteps.length });
      }
    }
  }

  return {
    symbol,
    incoming: { calls: incomingCalls, imports: incomingImports },
    outgoing: { calls: outgoingCalls, imports: outgoingImports },
    processes,
    cluster: symbol.cluster,
  };
}

// ── Trace (A7) ────────────────────────────────────────────────────

export function findTrace(
  graph: CodeGraph,
  fromName: string,
  toName: string,
): TraceResult {
  const fromCandidates = nodesByName(graph, fromName);
  const toCandidates = nodesByName(graph, toName);
  const from = fromCandidates[0];
  const to = toCandidates[0];

  if (!from || !to) {
    return {
      from: from ?? { id: '', name: fromName, kind: 'function', filePath: '', startLine: 0, endLine: 0, language: '', isExported: false },
      to: to ?? { id: '', name: toName, kind: 'function', filePath: '', startLine: 0, endLine: 0, language: '', isExported: false },
      path: [], found: false,
    };
  }

  // BFS shortest path
  const queue: Array<{ nodeId: string; path: TraceHop[] }> = [{ nodeId: from.id, path: [] }];
  const visited = new Set<string>([from.id]);

  while (queue.length > 0) {
    const { nodeId, path } = queue.shift()!;
    if (nodeId === to.id) {
      return { from, to, path, found: true };
    }

    for (const edge of edgesFrom(graph, nodeId)) {
      if (edge.type !== 'calls' && edge.type !== 'has_method') continue;
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      const targetNode = nodeById(graph, edge.target);
      if (!targetNode) continue;
      queue.push({ nodeId: edge.target, path: [...path, { node: targetNode, edge }] });
    }
  }

  return { from, to, path: [], found: false };
}

// ── Process detection (A3) ────────────────────────────────────────

export function detectProcesses(graph: CodeGraph): ProcessFlow[] {
  // Entry points: exported functions with no incoming calls, or route handlers
  const entryPoints = graph.nodes.filter(node => {
    if (node.kind !== 'function') return false;
    const incoming = edgesTo(graph, node.id).filter(e => e.type === 'calls');
    return node.isExported && incoming.length === 0;
  });

  const processes: ProcessFlow[] = [];
  let procCounter = 0;

  for (const entry of entryPoints) {
    const steps = traceProcess(graph, entry.id, new Set(), 15);
    if (steps.length < 2) continue;

    const procId = `proc_${++procCounter}`;
    const name = entry.name.replace(/^(handle|on|process|run|execute)_?/, '') || entry.name;
    const clusters = new Set(steps.map(s => s.node.cluster).filter(Boolean));
    const type = clusters.size > 1 ? 'cross_community' : 'intra_community';

    processes.push({
      id: procId,
      name: name.charAt(0).toUpperCase() + name.slice(1) + 'Flow',
      steps,
      type,
      priority: 1 / (1 + steps.length),
    });
  }

  return processes.sort((a, b) => b.priority - a.priority);
}

function traceProcess(
  graph: CodeGraph,
  startId: string,
  visited: Set<string>,
  maxDepth: number,
): ProcessStep[] {
  if (visited.has(startId) || maxDepth <= 0) return [];
  visited.add(startId);

  const startNode = nodeById(graph, startId);
  if (!startNode) return [];

  const steps: ProcessStep[] = [{ order: 0, node: startNode, edgeType: 'entry_point_of' }];
  let currentId = startId;
  let order = 1;

  for (let i = 0; i < maxDepth; i++) {
    const outEdges = edgesFrom(graph, currentId)
      .filter(e => e.type === 'calls')
      .sort((a, b) => b.confidenceScore - a.confidenceScore);

    if (outEdges.length === 0) break;
    const best = outEdges[0];
    if (visited.has(best.target)) break;
    visited.add(best.target);

    const nextNode = nodeById(graph, best.target);
    if (!nextNode) break;

    steps.push({ order: order++, node: nextNode, edgeType: best.type });
    currentId = best.target;
  }

  return steps;
}

// ── Route mapping (A9) ────────────────────────────────────────────

export function mapRoutes(graph: CodeGraph): RouteMapping[] {
  const routes = graph.nodes.filter(n => n.kind === 'route');
  const mappings: RouteMapping[] = [];

  for (const route of routes) {
    const handlerEdges = edgesFrom(graph, route.id).filter(e => e.type === 'handles_route');
    const handler = handlerEdges[0] ? nodeById(graph, handlerEdges[0].target) : undefined;
    if (!handler) continue;

    const consumerEdges = edgesFrom(graph, handler.id).filter(e => e.type === 'calls');
    const consumers = consumerEdges
      .map(e => nodeById(graph, e.target))
      .filter((n): n is CodeNode => n !== undefined);

    mappings.push({ route, handler, consumers });
  }

  return mappings;
}

// ── Git-diff impact (A5) ──────────────────────────────────────────

export function analyzeDiffImpact(
  graph: CodeGraph,
  changedFiles: string[],
  changedLineRanges?: Map<string, Array<[number, number]>>,
): DiffImpact {
  const changedSymbols: CodeNode[] = [];

  for (const file of changedFiles) {
    const nodeIds = graph.fileIndex.get(file) ?? [];
    for (const id of nodeIds) {
      const node = nodeById(graph, id);
      if (!node || node.kind === 'file') continue;

      // If we have line ranges, check if the symbol overlaps
      if (changedLineRanges) {
        const ranges = changedLineRanges.get(file) ?? [];
        const overlaps = ranges.some(([start, end]) =>
          node.startLine <= end && node.endLine >= start,
        );
        if (!overlaps) continue;
      }

      changedSymbols.push(node);
    }
  }

  // Find affected processes
  const processes = detectProcesses(graph);
  const affectedProcesses = processes.filter(proc =>
    proc.steps.some(step => changedSymbols.some(cs => cs.id === step.node.id)),
  );

  // Find affected clusters
  const affectedClusters = new Set(
    changedSymbols.map(s => s.cluster).filter(Boolean) as string[],
  );

  const riskLevel =
    changedSymbols.length > 15 ? 'high' :
    changedSymbols.length > 5 ? 'medium' : 'low';

  return {
    changedFiles,
    changedSymbols,
    affectedProcesses,
    affectedClusters: Array.from(affectedClusters),
    riskLevel,
  };
}

// ── Rename preview (A6) ───────────────────────────────────────────

export function previewRename(
  graph: CodeGraph,
  symbolName: string,
  newName: string,
  fileContents: Map<string, string>,
): RenamePreview | null {
  const candidates = nodesByName(graph, symbolName);
  const symbol = candidates[0];
  if (!symbol) return null;

  const changes: RenameChange[] = [];
  const affectedFiles = new Set<string>();

  // Graph-based: find all callers and the definition
  const callers = edgesTo(graph, symbol.id).filter(e => e.type === 'calls');
  for (const edge of callers) {
    const caller = nodeById(graph, edge.source);
    if (!caller) continue;
    const content = fileContents.get(caller.filePath);
    if (!content) continue;

    const lines = content.split('\n');
    const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, 'g');
    for (let i = Math.max(0, caller.startLine - 1); i < Math.min(lines.length, caller.endLine); i++) {
      pattern.lastIndex = 0;
      while (pattern.exec(lines[i]) !== null) {
        changes.push({
          filePath: caller.filePath,
          line: i + 1,
          oldText: symbolName,
          newText: newName,
          source: 'graph',
        });
        affectedFiles.add(caller.filePath);
      }
    }
  }

  // Definition file
  const defContent = fileContents.get(symbol.filePath);
  if (defContent) {
    const lines = defContent.split('\n');
    const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, 'g');
    for (let i = Math.max(0, symbol.startLine - 1); i < Math.min(lines.length, symbol.endLine); i++) {
      pattern.lastIndex = 0;
      while (pattern.exec(lines[i]) !== null) {
        changes.push({
          filePath: symbol.filePath,
          line: i + 1,
          oldText: symbolName,
          newText: newName,
          source: 'graph',
        });
        affectedFiles.add(symbol.filePath);
      }
    }
  }

  const graphEdits = changes.length;

  // Text-based: search all files for the name (lower confidence)
  for (const [filePath, content] of fileContents) {
    if (affectedFiles.has(filePath)) continue;
    const lines = content.split('\n');
    const pattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, 'g');
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      while (pattern.exec(lines[i]) !== null) {
        changes.push({
          filePath,
          line: i + 1,
          oldText: symbolName,
          newText: newName,
          source: 'text',
        });
        affectedFiles.add(filePath);
      }
    }
  }

  return {
    symbol,
    newName,
    changes,
    filesAffected: affectedFiles.size,
    totalEdits: changes.length,
    graphEdits,
    textSearchEdits: changes.length - graphEdits,
  };
}

// ── Community detection / clustering ──────────────────────────────

export function detectClusters(graph: CodeGraph): CodeCluster[] {
  // Simple label propagation: group by file directory + shared edges
  const clusterMap = new Map<string, string[]>();
  const assigned = new Map<string, string>();

  // Initial: cluster by directory
  for (const node of graph.nodes) {
    if (node.kind === 'file' || node.kind === 'folder') continue;
    const dir = node.filePath.includes('/')
      ? node.filePath.slice(0, node.filePath.lastIndexOf('/'))
      : 'root';
    const clusterId = `cluster:${dir}`;
    assigned.set(node.id, clusterId);
    const members = clusterMap.get(clusterId) ?? [];
    members.push(node.id);
    clusterMap.set(clusterId, members);
  }

  // Refine: merge clusters with high inter-connectivity
  // (simplified Louvain — a full implementation would use modularity optimization)
  const clusters: CodeCluster[] = [];
  for (const [clusterId, memberIds] of clusterMap) {
    if (memberIds.length < 2) continue;

    let internalEdges = 0;
    let externalEdges = 0;

    for (const memberId of memberIds) {
      for (const edge of graph.edges) {
        if (edge.source === memberId || edge.target === memberId) {
          const otherId = edge.source === memberId ? edge.target : edge.source;
          if (assigned.get(otherId) === clusterId) {
            internalEdges++;
          } else {
            externalEdges++;
          }
        }
      }
    }

    const cohesion = memberIds.length > 0
      ? internalEdges / (internalEdges + externalEdges || 1)
      : 0;

    clusters.push({
      id: clusterId,
      label: clusterId.replace('cluster:', ''),
      nodeIds: memberIds,
      nodeCount: memberIds.length,
      internalEdges: internalEdges / 2, // counted twice
      externalEdges,
      cohesion,
    });
  }

  return clusters.sort((a, b) => b.nodeCount - a.nodeCount);
}

// ── Helpers ───────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
