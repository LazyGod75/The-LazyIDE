/* pipeline.ts — Multi-phase indexing pipeline (DAG).
   Phases: scan → structure → parse → routes → orm → crossFile → resolve → cluster → processes
   Each phase has explicit deps and typed output.

   Supports:
   - Incremental indexing by per-file SHA-256 hash (only re-parse changed files)
   - Tree-sitter AST parsing with regex fallback
   - Staleness detection by git commit hash
*/

import type {
  CodeGraph, CodeNode,
  PipelinePhase, PipelinePhaseId, PipelineProgress,
  StalenessReport, ProcessFlow, CodeCluster,
} from './types.js';
import { scanFile, collectSourceFiles, type ScanResult } from './scanner.js';
import { resolveCrossFile, buildGraph } from './resolver.js';
import { detectProcesses, detectClusters } from './analyzer.js';
import { scanFileWithTreeSitter, isTreeSitterAvailable } from './treeSitterScanner.js';
import { sha256 } from './fileHash.js';
import { getLanguageConfig } from './languageRegistry.js';

// ── Phase definitions (DAG) ───────────────────────────────────────

export const PIPELINE_PHASES: PipelinePhase[] = [
  { id: 'scan', deps: [], label: 'Scanning files', progress: 0 },
  { id: 'structure', deps: ['scan'], label: 'Building file tree', progress: 0 },
  { id: 'parse', deps: ['structure'], label: 'Extracting symbols (AST)', progress: 0 },
  { id: 'routes', deps: ['parse'], label: 'Detecting API routes', progress: 0 },
  { id: 'orm', deps: ['parse'], label: 'Detecting ORM queries', progress: 0 },
  { id: 'crossFile', deps: ['parse', 'routes', 'orm'], label: 'Resolving cross-file references', progress: 0 },
  { id: 'resolve', deps: ['crossFile'], label: 'Resolving calls & heritage', progress: 0 },
  { id: 'cluster', deps: ['resolve'], label: 'Detecting communities', progress: 0 },
  { id: 'processes', deps: ['cluster', 'routes'], label: 'Tracing execution flows', progress: 0 },
];

// ── Pipeline runner ───────────────────────────────────────────────

export interface PipelineOptions {
  projectRoot: string;
  /** Current git commit hash (for staleness check). */
  currentCommit?: string | null;
  /** Previous indexed commit — if same as current, skip rebuild. */
  lastCommit?: string | null;
  /** Force full rebuild. */
  force?: boolean;
  /** Progress callback. */
  onProgress?: (p: PipelineProgress) => void;
  /** File system access. */
  readDir: (path: string) => Promise<Array<{ name: string; path: string; isDir: boolean }>>;
  readFile: (path: string) => Promise<string>;
  /** Previous graph (for incremental indexing). */
  previousGraph?: CodeGraph | null;
  /** Whether to prefer tree-sitter parsing. Default: true. */
  useTreeSitter?: boolean;
}

export interface PipelineResult {
  graph: CodeGraph;
  processes: ProcessFlow[];
  clusters: CodeCluster[];
  staleness: StalenessReport;
  skipped: boolean;
  /** Number of files re-parsed (incremental). */
  reparsedCount: number;
  /** Number of files skipped (unchanged). */
  skippedCount: number;
  /** Whether tree-sitter was used. */
  usedTreeSitter: boolean;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const noop = () => {};
  const onProgress = opts.onProgress ?? noop;
  const wantTreeSitter = opts.useTreeSitter !== false;

  // ── Staleness check (commit-level) ────────────────────────────
  const staleness = checkStaleness(opts.lastCommit ?? null, opts.currentCommit ?? null, []);

  if (!opts.force && !staleness.isStale && opts.previousGraph) {
    onProgress({ phase: 'processes', label: 'Index up to date', progress: 1, overall: 1 });
    return {
      graph: opts.previousGraph,
      processes: [],
      clusters: [],
      staleness,
      skipped: true,
      reparsedCount: 0,
      skippedCount: opts.previousGraph.nodes.filter(n => n.kind !== 'file' && n.kind !== 'folder').length,
      usedTreeSitter: opts.previousGraph.useTreeSitter ?? false,
    };
  }

  // ── Check tree-sitter availability ────────────────────────────
  let treeSitterReady = false;
  if (wantTreeSitter) {
    treeSitterReady = await isTreeSitterAvailable();
  }

  const totalPhases = PIPELINE_PHASES.length;
  let completedPhases = 0;

  function reportProgress(phase: PipelinePhaseId, label: string, phaseProgress: number): void {
    const overall = (completedPhases + phaseProgress) / totalPhases;
    onProgress({ phase, label, progress: phaseProgress, overall });
  }

  // ── Phase 1: scan ─────────────────────────────────────────────
  reportProgress('scan', 'Scanning files...', 0);
  const filePaths = await collectSourceFiles(opts.readDir, opts.projectRoot);
  reportProgress('scan', `Found ${filePaths.length} source files`, 1);
  completedPhases++;

  // ── Phase 2: structure ────────────────────────────────────────
  reportProgress('structure', 'Building file tree...', 0);
  const allFiles = new Set(filePaths);
  const folderNodes: CodeNode[] = [];
  const folderSet = new Set<string>();
  for (const fp of filePaths) {
    const parts = fp.split('/');
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      if (!folderSet.has(current)) {
        folderSet.add(current);
        folderNodes.push({
          id: `folder:${current}`,
          name: parts[i],
          kind: 'folder',
          filePath: current,
          startLine: 0,
          endLine: 0,
          language: '',
          isExported: false,
        });
      }
    }
  }
  reportProgress('structure', `${folderNodes.length} folders`, 1);
  completedPhases++;

  // ── Phase 3: parse (with incremental SHA-256 hashing) ─────────
  const parseLabel = treeSitterReady ? 'Parsing files (tree-sitter AST)...' : 'Parsing files (regex)...';
  reportProgress('parse', parseLabel, 0);

  // Get previous file hashes for incremental indexing
  const previousHashes = opts.previousGraph?.fileHashes ?? new Map<string, string>();

  const scanResults: ScanResult[] = [];
  const fileContents = new Map<string, string>();
  let parsed = 0;
  let skippedUnchanged = 0;

  // First pass: read all files and compute hashes
  const currentHashes = new Map<string, string>();
  for (const filePath of filePaths) {
    try {
      const content = await opts.readFile(filePath);
      fileContents.set(filePath, content);
      const hash = await sha256(content);
      currentHashes.set(filePath, hash);
    } catch {
      // Skip unreadable files
    }
  }

  // Determine which files need re-parsing
  const filesToParse: string[] = [];
  for (const [filePath, hash] of currentHashes) {
    const prevHash = previousHashes.get(filePath);
    if (prevHash === hash && opts.previousGraph && !opts.force) {
      // File unchanged — reuse cached nodes
      skippedUnchanged++;
      const prevNodes = opts.previousGraph.nodes.filter(n => n.filePath === filePath);
      const prevEdges = opts.previousGraph.edges.filter(
        e => prevNodes.some(n => n.id === e.source) || prevNodes.some(n => n.id === e.target),
      );
      if (prevNodes.length > 0) {
        scanResults.push({ nodes: prevNodes, edges: prevEdges, routes: [], ormQueries: [] });
      }
    } else {
      filesToParse.push(filePath);
    }
  }

  // Parse changed files (tree-sitter or regex fallback)
  for (const filePath of filesToParse) {
    const content = fileContents.get(filePath);
    if (!content) continue;

    let result: ScanResult | null = null;

    if (treeSitterReady) {
      const config = getLanguageConfig(filePath);
      if (config && config.functionNodeTypes.length > 0) {
        result = await scanFileWithTreeSitter(filePath, content);
      }
    }

    // Fallback to regex scanner
    if (!result) {
      result = scanFile(filePath, content);
    }

    scanResults.push(result);
    parsed++;
    if (parsed % 50 === 0 || parsed === filesToParse.length) {
      reportProgress('parse', `Parsed ${parsed}/${filesToParse.length} changed files`, parsed / Math.max(1, filesToParse.length));
    }
  }

  reportProgress('parse', `${parsed} re-parsed, ${skippedUnchanged} unchanged`, 1);
  completedPhases++;

  // ── Phase 4-5: routes + orm (merged with parse results) ───────
  reportProgress('routes', 'Detecting API routes...', 0);
  const allRoutes: ScanResult['routes'] = [];
  for (const sr of scanResults) {
    allRoutes.push(...sr.routes);
  }
  reportProgress('routes', `${allRoutes.length} routes detected`, 1);
  completedPhases++;

  reportProgress('orm', 'Detecting ORM queries...', 0);
  const allOrm: ScanResult['ormQueries'] = [];
  for (const sr of scanResults) {
    allOrm.push(...sr.ormQueries);
  }
  reportProgress('orm', `${allOrm.length} ORM queries detected`, 1);
  completedPhases++;

  // ── Phase 6-7: crossFile + resolve ────────────────────────────
  reportProgress('crossFile', 'Resolving cross-file references...', 0);
  const { nodes, edges } = resolveCrossFile(scanResults, allFiles, { fileContents });
  // Add folder nodes
  nodes.unshift(...folderNodes);
  reportProgress('crossFile', `${nodes.length} nodes, ${edges.length} edges`, 1);
  completedPhases++;

  reportProgress('resolve', 'Building graph...', 0);
  const graph = buildGraph(nodes, edges, opts.projectRoot, opts.currentCommit ?? null);
  graph.fileHashes = currentHashes;
  graph.useTreeSitter = treeSitterReady;
  reportProgress('resolve', 'Graph built', 1);
  completedPhases++;

  // ── Phase 8: cluster ──────────────────────────────────────────
  reportProgress('cluster', 'Detecting communities...', 0);
  const clusters = detectClusters(graph);
  // Assign cluster IDs to nodes
  for (const cluster of clusters) {
    for (const nodeId of cluster.nodeIds) {
      const node = graph.nodes.find(n => n.id === nodeId);
      if (node) node.cluster = cluster.id;
    }
  }
  reportProgress('cluster', `${clusters.length} communities detected`, 1);
  completedPhases++;

  // ── Phase 9: processes ────────────────────────────────────────
  reportProgress('processes', 'Tracing execution flows...', 0);
  const processes = detectProcesses(graph);
  // Add process-related edges to graph
  for (const proc of processes) {
    for (const step of proc.steps) {
      graph.edges.push({
        source: step.node.id,
        target: proc.id,
        type: 'step_in_process',
        confidence: 'inferred',
        confidenceScore: 0.7,
      });
    }
  }
  reportProgress('processes', `${processes.length} execution flows traced`, 1);
  completedPhases++;

  return {
    graph,
    processes,
    clusters,
    staleness,
    skipped: false,
    reparsedCount: parsed,
    skippedCount: skippedUnchanged,
    usedTreeSitter: treeSitterReady,
  };
}

// ── Staleness detection (G3) ──────────────────────────────────────

export function checkStaleness(
  lastCommit: string | null,
  currentCommit: string | null,
  changedFiles: string[],
): StalenessReport {
  if (!currentCommit) {
    return {
      isStale: true,
      lastCommit,
      currentCommit,
      changedFiles,
      reason: 'No current commit hash available',
    };
  }

  if (!lastCommit) {
    return {
      isStale: true,
      lastCommit,
      currentCommit,
      changedFiles,
      reason: 'No previous index — first build',
    };
  }

  if (lastCommit === currentCommit) {
    return {
      isStale: false,
      lastCommit,
      currentCommit,
      changedFiles: [],
      reason: 'Index is up to date',
    };
  }

  return {
    isStale: true,
    lastCommit,
    currentCommit,
    changedFiles,
    reason: `Index is behind: ${lastCommit.slice(0, 8)} → ${currentCommit.slice(0, 8)}`,
  };
}

