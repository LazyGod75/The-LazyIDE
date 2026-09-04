/* types.ts — Core types for the code intelligence graph.
   Models code structure as nodes + edges, similar to GitNexus but adapted
   for Lazy's Platform architecture and LazyBrain's knowledge graph patterns.
*/

// ── Node types ────────────────────────────────────────────────────

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'variable'
  | 'import'
  | 'file'
  | 'folder'
  | 'module'
  | 'route'
  | 'config';

export interface CodeNode {
  /** Unique ID: `${kind}:${filePath}:${name}` */
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  /** Exported symbols visible to other files. */
  isExported: boolean;
  /** Parameters for functions/methods. */
  params?: string[];
  /** Class heritage: extends/implements. */
  extends?: string[];
  /** Methods for classes. */
  methods?: string[];
  /** Cluster ID assigned by community detection. */
  cluster?: string;
  /** PageRank-style importance (0–1). */
  importance?: number;
}

// ── Edge types ────────────────────────────────────────────────────

export type EdgeType =
  | 'contains'      // file/folder → child
  | 'defines'       // file → symbol
  | 'calls'         // function → function
  | 'imports'       // file → file
  | 'extends'       // class → class
  | 'implements'    // class → interface
  | 'has_method'    // class → method
  | 'has_property'  // class → property
  | 'member_of'     // symbol → cluster
  | 'step_in_process' // symbol → process
  | 'handles_route' // route → handler
  | 'queries'       // function → ORM model
  | 'entry_point_of'; // symbol → process

export type EdgeConfidence = 'extracted' | 'inferred' | 'ambiguous';

export interface CodeEdge {
  source: string;
  target: string;
  type: EdgeType;
  confidence: EdgeConfidence;
  /** 0–1, how certain the edge is. */
  confidenceScore: number;
}

// ── Graph ─────────────────────────────────────────────────────────

export interface CodeGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
  /** Map: filePath → CodeNode[] for quick lookup. */
  fileIndex: Map<string, string[]>;
  /** Map: symbolName → CodeNode[] for disambiguation. */
  nameIndex: Map<string, string[]>;
  /** When the graph was built. */
  indexedAt: number;
  /** Last git commit hash at index time. */
  lastCommit: string | null;
  /** Project root path. */
  projectRoot: string;
  /** Per-file SHA-256 hashes for incremental indexing. */
  fileHashes?: Map<string, string>;
  /** Whether tree-sitter was used for the last build. */
  useTreeSitter?: boolean;
}

// ── Impact analysis (A1, A2) ──────────────────────────────────────

export type ImpactDirection = 'upstream' | 'downstream';

export interface ImpactResult {
  target: CodeNode;
  direction: ImpactDirection;
  levels: ImpactLevel[];
  totalAffected: number;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ImpactLevel {
  depth: number;
  label: string;
  symbols: ImpactSymbol[];
}

export interface ImpactSymbol {
  node: CodeNode;
  edgeType: EdgeType;
  confidence: number;
}

// ── 360° context view (A4) ────────────────────────────────────────

export interface ContextView {
  symbol: CodeNode;
  incoming: {
    calls: CodeNode[];
    imports: CodeNode[];
  };
  outgoing: {
    calls: CodeNode[];
    imports: CodeNode[];
  };
  processes: Array<{ name: string; step: number; total: number }>;
  cluster?: string;
}

// ── Trace (A7) ────────────────────────────────────────────────────

export interface TraceResult {
  from: CodeNode;
  to: CodeNode;
  path: TraceHop[];
  found: boolean;
}

export interface TraceHop {
  node: CodeNode;
  edge: CodeEdge;
}

// ── Process detection (A3) ────────────────────────────────────────

export interface ProcessFlow {
  id: string;
  name: string;
  steps: ProcessStep[];
  /** cross_community | intra_community */
  type: string;
  priority: number;
}

export interface ProcessStep {
  order: number;
  node: CodeNode;
  edgeType: EdgeType;
}

// ── Route detection (A9) ──────────────────────────────────────────

export interface RouteMapping {
  route: CodeNode;
  handler: CodeNode;
  /** Functions called by the handler. */
  consumers: CodeNode[];
}

// ── Git-diff impact (A5) ──────────────────────────────────────────

export interface DiffImpact {
  changedFiles: string[];
  changedSymbols: CodeNode[];
  affectedProcesses: ProcessFlow[];
  affectedClusters: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

// ── Rename (A6) ───────────────────────────────────────────────────

export interface RenamePreview {
  symbol: CodeNode;
  newName: string;
  changes: RenameChange[];
  filesAffected: number;
  totalEdits: number;
  graphEdits: number;
  textSearchEdits: number;
}

export interface RenameChange {
  filePath: string;
  line: number;
  oldText: string;
  newText: string;
  source: 'graph' | 'text';
}

// ── Cluster / community (for H) ───────────────────────────────────

export interface CodeCluster {
  id: string;
  label: string;
  nodeIds: string[];
  nodeCount: number;
  internalEdges: number;
  externalEdges: number;
  cohesion: number;
}

// ── Staleness (G3) ────────────────────────────────────────────────

export interface StalenessReport {
  isStale: boolean;
  lastCommit: string | null;
  currentCommit: string | null;
  changedFiles: string[];
  reason: string;
}

// ── Registry (E) ──────────────────────────────────────────────────

export interface RepoEntry {
  name: string;
  path: string;
  indexedAt: number;
  lastCommit: string | null;
  nodeCount: number;
  edgeCount: number;
}

export interface RepoGroup {
  name: string;
  members: Array<{ path: string; registryName: string }>;
  createdAt: number;
}

// ── Pipeline (G) ──────────────────────────────────────────────────

export type PipelinePhaseId =
  | 'scan'
  | 'structure'
  | 'parse'
  | 'routes'
  | 'orm'
  | 'crossFile'
  | 'resolve'
  | 'cluster'
  | 'processes';

export interface PipelinePhase {
  id: PipelinePhaseId;
  deps: PipelinePhaseId[];
  label: string;
  progress: number;
}

export interface PipelineProgress {
  phase: PipelinePhaseId;
  label: string;
  progress: number;
  overall: number;
  message?: string;
}

// ── Agent skills (H) ──────────────────────────────────────────────

export interface GeneratedSkill {
  name: string;
  cluster: CodeCluster;
  keyFiles: string[];
  entryPoints: string[];
  processes: string[];
  crossAreaConnections: string[];
  description: string;
}
