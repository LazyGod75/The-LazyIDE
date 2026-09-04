/**
 * Code scanner: scans project directories referenced in conversation notes
 * to create code-aware nodes and edges. This is the bridge between
 * LazyBrain's conversational memory and actual codebase structure.
 *
 * Two scan modes:
 * - scanProject()      — synchronous, regex-based (legacy, always available)
 * - scanProjectAsync() — async, uses AST via ast-parser.ts when available,
 *                        falls back to regex per file on parse failure.
 */

import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { AggregateNeuronDescriptor } from '../annotator/blocks/composers/aggregate-neuron.js';
import {
  type EnrichmentItem,
  type FileNeuronEnrichment,
  composeFileNeuron,
} from '../annotator/blocks/composers/file-neuron.js';
import { getLogger } from '../util/logger.js';
import { parseFile } from './ast-parser.js';

/**
 * Maximum number of file-neuron notes written per project.
 * When exceeded, only the highest-importance (highest fan-in) files are kept.
 * Override with the LAZYBRAIN_MAX_FILE_NEURONS environment variable.
 */
const MAX_FILE_NEURONS_PER_PROJECT =
  Number.parseInt(process.env.LAZYBRAIN_MAX_FILE_NEURONS ?? '400', 10) || 400;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeNode {
  id: string; // "file:relative/path" or "module:name"
  title: string;
  type: 'file' | 'module' | 'config' | 'test' | 'document';
  filePath: string; // relative to project root
  projectRoot: string; // absolute project root
  language: string; // ts, js, py, etc.
  lineCount: number;
  imports: string[]; // other files/modules this file imports
  exports: string[]; // names exported
  /** Populated by scanProjectAsync() when AST parsing succeeds */
  astFunctions?: Array<{
    name: string;
    startLine: number;
    endLine: number;
    params: string[];
    isExported: boolean;
    jsdoc?: string;
    excerpt?: string;
  }>;
  /** Populated by scanProjectAsync() when AST parsing succeeds */
  astClasses?: Array<{
    name: string;
    methods: string[];
    isExported: boolean;
    extends?: string;
    startLine?: number;
    endLine?: number;
    jsdoc?: string;
    excerpt?: string;
  }>;
  /** Type aliases / interfaces / non-function consts (TS), when AST parsing succeeds. */
  astBindings?: Array<{
    name: string;
    kind: 'type' | 'interface' | 'const';
    startLine: number;
    endLine: number;
    isExported: boolean;
    jsdoc?: string;
    excerpt?: string;
  }>;
  /** True when imports/exports were extracted via AST rather than regex */
  astParsed?: boolean;
  /**
   * Conversational knowledge attached by the conv→file-neuron enrichment
   * pipeline (commands/conv-file-enrichment.ts). Absent on a fresh code scan
   * (scanProject/scanProjectAsync never populate these); populated when the
   * node is parsed back from an already-enriched file-neuron's rendered HTML
   * (graph/file-neuron-parse.ts), which is what lets a re-enrich or re-scan
   * pass merge with — instead of erasing — what conversations already
   * surfaced about this file. See composeFileNeuron's FileNeuronEnrichment.
   */
  decisions?: EnrichmentItem[];
  bugs?: EnrichmentItem[];
  ideas?: EnrichmentItem[];
  rules?: EnrichmentItem[];
  qa?: EnrichmentItem[];
  warnings?: EnrichmentItem[];
  activities?: EnrichmentItem[];
}

export interface CodeEdge {
  source: string;
  target: string;
  type: 'imports' | 'contains' | 'tested-by' | 'configures';
  confidence: 'extracted';
  confidenceScore: 1.0;
}

export interface CodeScanResult {
  projectRoot: string;
  projectName: string;
  nodes: CodeNode[];
  edges: CodeEdge[];
  stats: {
    files: number;
    modules: number;
    languages: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.swift',
  '.dart',
  '.lua',
  '.php',
]);

const CONFIG_EXTENSIONS = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.env',
  '.xml',
  '.graphql',
  '.prisma',
  '.sql',
]);

const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.adoc']);

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '__pycache__',
  '.expo',
  '.cache',
  'coverage',
  '.turbo',
  '.vercel',
  'vendor',
  'target',
  'venv',
  '.venv',
  'env',
  '.env',
]);

function classifyFile(ext: string, filePath: string): CodeNode['type'] {
  if (filePath.includes('test') || filePath.includes('spec') || filePath.includes('__tests__'))
    return 'test';
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  if (DOC_EXTENSIONS.has(ext)) return 'document';
  if (CODE_EXTENSIONS.has(ext)) return 'file';
  return 'file';
}

function detectLanguage(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.c': 'c',
    '.cpp': 'cpp',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.dart': 'dart',
    '.php': 'php',
    '.lua': 'lua',
  };
  return map[ext] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Import/export extraction (lightweight, no tree-sitter)
// ---------------------------------------------------------------------------

function extractImports(content: string, language: string): string[] {
  const imports: string[] = [];

  if (language === 'typescript' || language === 'javascript') {
    // import ... from 'module' and export ... from 'module'
    const esm = content.matchAll(/(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g);
    for (const m of esm) imports.push(m[1]);
    // require('module')
    const cjs = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of cjs) imports.push(m[1]);
  } else if (language === 'python') {
    // import module / from module import ...
    const py = content.matchAll(/(?:from\s+(\S+)\s+import|^import\s+(\S+))/gm);
    for (const m of py) imports.push(m[1] ?? m[2]);
  }

  // Filter to relative imports only (internal project dependencies)
  return [...new Set(imports.filter((i) => i.startsWith('.') || i.startsWith('/')))];
}

function extractExports(content: string, language: string): string[] {
  const exports: string[] = [];

  if (language === 'typescript' || language === 'javascript') {
    const named = content.matchAll(
      /export\s+(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g,
    );
    for (const m of named) exports.push(m[1]);
    if (/export\s+default/.test(content)) exports.push('default');
  }

  return [...new Set(exports)];
}

// ---------------------------------------------------------------------------
// Import path resolution
// ---------------------------------------------------------------------------

function resolveImport(
  fromPath: string,
  importPath: string,
  nodes: Map<string, CodeNode>,
): string | null {
  const dir = fromPath.split('/').slice(0, -1).join('/');
  const parts = importPath.split('/');
  let resolved = dir;

  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') {
      resolved = resolved.split('/').slice(0, -1).join('/');
    } else {
      resolved = resolved ? `${resolved}/${part}` : part;
    }
  }

  // Try common extensions in priority order
  const candidates = [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    `${resolved}.js`,
    `${resolved}.jsx`,
    `${resolved}.py`,
    `${resolved}/index.ts`,
    `${resolved}/index.js`,
  ];

  for (const candidate of candidates) {
    if (nodes.has(candidate)) return candidate;
  }

  return null;
}

function guessTestedFile(testPath: string, nodes: Map<string, CodeNode>): string | null {
  const stripped = testPath
    .replace(/\.test\.(ts|tsx|js|jsx)$/, '.$1')
    .replace(/\.spec\.(ts|tsx|js|jsx)$/, '.$1')
    .replace(/__tests__\//, '')
    .replace(/tests?\//, '');

  if (nodes.has(stripped) && stripped !== testPath) return stripped;
  return null;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const MAX_FILES = 500; // cap per project to avoid memory explosion
const MAX_FILE_SIZE = 100_000; // 100KB — skip huge generated files
// Cap recursion depth as defense-in-depth against pathological directory
// trees and self-referential NTFS junctions/symlinks. MAX_FILES alone caps
// total work, but a shallow, wide reparse-point loop could still recurse
// very deep before hitting it; MAX_DEPTH bounds that independently.
const MAX_DEPTH = 20;

export function scanProject(projectRoot: string): CodeScanResult | null {
  if (!existsSync(projectRoot)) return null;

  const projectName = basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const languages: Record<string, number> = {};

  function walk(dir: string, depth: number): void {
    if (nodes.length >= MAX_FILES) return;
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[] | undefined;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (!entries) return;

    for (const entry of entries) {
      if (nodes.length >= MAX_FILES) break;

      if (entry.isDirectory()) {
        // Skip NTFS junctions / symlinked directories: readdirSync flags
        // reparse points as symbolic-link dirents. Following them risks
        // unbounded/self-referential recursion (e.g. a junction pointing
        // back at an ancestor directory) — safer to just not traverse them.
        if (entry.isSymbolicLink()) continue;
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(join(dir, entry.name), depth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext) && !CONFIG_EXTENSIONS.has(ext)) continue;

      const fullPath = join(dir, entry.name);
      let stat: ReturnType<typeof statSync> | undefined;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat || stat.size > MAX_FILE_SIZE) continue;

      const relPath = relative(projectRoot, fullPath).replace(/\\/g, '/');
      const type = classifyFile(ext, relPath);
      const language = detectLanguage(ext);

      let content: string;
      try {
        content = readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }

      const lineCount = content.split('\n').length;
      const imports = extractImports(content, language);
      const fileExports = extractExports(content, language);

      nodes.push({
        id: `file:${relPath}`,
        title: relPath,
        type,
        filePath: relPath,
        projectRoot,
        language,
        lineCount,
        imports,
        exports: fileExports,
      });

      languages[language] = (languages[language] ?? 0) + 1;
    }
  }

  walk(projectRoot, 0);

  // Build import edges by resolving relative imports to actual file nodes
  const fileNodesByPath = new Map(nodes.map((n) => [n.filePath, n]));

  for (const node of nodes) {
    for (const imp of node.imports) {
      const resolved = resolveImport(node.filePath, imp, fileNodesByPath);
      if (resolved) {
        edges.push({
          source: node.id,
          target: `file:${resolved}`,
          type: 'imports',
          confidence: 'extracted',
          confidenceScore: 1.0,
        });
      }
    }

    // Test files → tested-by edges on the source file
    if (node.type === 'test') {
      const testedFile = guessTestedFile(node.filePath, fileNodesByPath);
      if (testedFile) {
        edges.push({
          source: `file:${testedFile}`,
          target: node.id,
          type: 'tested-by',
          confidence: 'extracted',
          confidenceScore: 1.0,
        });
      }
    }
  }

  return {
    projectRoot,
    projectName,
    nodes,
    edges,
    stats: {
      files: nodes.length,
      modules: nodes.filter((n) => n.type === 'file').length,
      languages,
    },
  };
}

// ---------------------------------------------------------------------------
// Note generation — ALL source files rendered as file-neurons
// ---------------------------------------------------------------------------

/**
 * Convert a CodeScanResult to HTML note strings.
 * Every scanned source file (file + test types) becomes a file-neuron page.
 * No cap on the number of files — all are rendered.
 * HTML generation is delegated to composeFileNeuron for DRY output.
 *
 * @param result                 Scan result to render.
 * @param existingEnrichmentById Optional lookup of node id → enrichment already
 *   attached to that file-neuron (e.g. from
 *   `extractFileNeuronStubsFromHtml(readAllNotes())`). When provided, a node
 *   whose id has existing enrichment keeps it on re-scan instead of losing it.
 *
 * Returns HTML strings — the caller writes them with writeNote().
 */
/** Maximum number of see-also links per file-neuron. */
const MAX_SEE_ALSO_LINKS = 5;

/**
 * Derive see-also links for a CodeNode from real graph edges and topic siblings.
 *
 * Priority:
 *   1. Direct edges: files this node imports or that import this node
 *      (type: 'imports' | 'tested-by' | 'configures').
 *   2. Topic siblings: source files that share the same parent directory
 *      (nearest topic-path siblings within the same project).
 *
 * Cross-project links are excluded — we only link within the same project root
 * to avoid cross-project link pollution. The result is capped at
 * MAX_SEE_ALSO_LINKS entries, de-duplicated, and sorted by directness first
 * (direct edges before topic siblings).
 *
 * @param node       The CodeNode whose see-also list is being built.
 * @param allNodes   All nodes in the CodeScanResult (same project).
 * @param edges      All edges in the CodeScanResult.
 * @returns          At most MAX_SEE_ALSO_LINKS see-also entries.
 */
function buildFileNeuronSeeAlso(
  node: CodeNode,
  allNodes: readonly CodeNode[],
  edges: readonly CodeEdge[],
): Array<{ id: string; title: string }> {
  const seen = new Set<string>([node.id]);
  const result: Array<{ id: string; title: string }> = [];

  // Build a map: node.id → node for fast lookup
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));

  // 1. Direct edge peers: nodes this file imports or that import this file
  for (const edge of edges) {
    if (result.length >= MAX_SEE_ALSO_LINKS) break;
    let peerId: string | null = null;
    if (
      (edge.type === 'imports' || edge.type === 'tested-by' || edge.type === 'configures') &&
      edge.source === node.id
    ) {
      peerId = edge.target;
    } else if (
      (edge.type === 'imports' || edge.type === 'tested-by' || edge.type === 'configures') &&
      edge.target === node.id
    ) {
      peerId = edge.source;
    }

    if (peerId !== null && !seen.has(peerId)) {
      const peer = nodeById.get(peerId);
      if (peer && (peer.type === 'file' || peer.type === 'test')) {
        seen.add(peerId);
        result.push({ id: peerId, title: peer.filePath });
      }
    }
  }

  // 2. Topic siblings: files in the same parent directory (nearest neighbours)
  if (result.length < MAX_SEE_ALSO_LINKS) {
    const normalizedPath = node.filePath.replace(/\\/g, '/');
    const lastSlash = normalizedPath.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? normalizedPath.slice(0, lastSlash) : '';

    for (const sibling of allNodes) {
      if (result.length >= MAX_SEE_ALSO_LINKS) break;
      if (seen.has(sibling.id)) continue;
      if (sibling.type !== 'file' && sibling.type !== 'test') continue;
      const siblingPath = sibling.filePath.replace(/\\/g, '/');
      const siblingSlash = siblingPath.lastIndexOf('/');
      const siblingDir = siblingSlash >= 0 ? siblingPath.slice(0, siblingSlash) : '';
      if (siblingDir === parentDir) {
        seen.add(sibling.id);
        result.push({ id: sibling.id, title: sibling.filePath });
      }
    }
  }

  return result;
}

export function codeNodesToNotes(
  result: CodeScanResult,
  existingEnrichmentById?: ReadonlyMap<string, FileNeuronEnrichment>,
): string[] {
  const { nodes, edges } = result;
  if (nodes.length === 0) return [];

  // Compute fan-in: how many other nodes import each node
  const fanIn = new Map<string, number>();
  for (const edge of edges) {
    if (edge.type === 'imports') {
      fanIn.set(edge.target, (fanIn.get(edge.target) ?? 0) + 1);
    }
  }

  const sourceNodes = nodes.filter((n) => n.type === 'file' || n.type === 'test');

  // Sort descending by importance (fan-in first, then export count as tiebreaker)
  // so that when capping we keep the highest-value files.
  const sorted = [...sourceNodes].sort((a, b) => {
    const fanA = fanIn.get(a.id) ?? 0;
    const fanB = fanIn.get(b.id) ?? 0;
    if (fanB !== fanA) return fanB - fanA;
    return b.exports.length - a.exports.length;
  });

  const capped = sorted.slice(0, MAX_FILE_NEURONS_PER_PROJECT);

  if (sorted.length > MAX_FILE_NEURONS_PER_PROJECT) {
    const log = getLogger();
    log.warn(
      {
        total: sorted.length,
        cap: MAX_FILE_NEURONS_PER_PROJECT,
        projectRoot: nodes[0]?.projectRoot ?? 'unknown',
      },
      'codeNodesToNotes: file-neuron count exceeds cap — keeping highest-importance files',
    );
  }

  return capped.map((node) => {
    const inbound = fanIn.get(node.id) ?? 0;
    const seeAlso = buildFileNeuronSeeAlso(node, capped, edges);
    // Preserve enrichment already attached by the conv→file-neuron pipeline
    // when this file was previously scanned: a bare re-scan (e.g. a fresh
    // `lazybrain graph` call outside of /maintenance) must not silently wipe
    // out decisions/bugs/ideas/rules/qa a conversation already surfaced for
    // this file, just because the fresh CodeNode has no enrichment of its own.
    const enrichment = existingEnrichmentById?.get(node.id);
    return composeFileNeuron(node, inbound, enrichment, seeAlso);
  });
}

// ---------------------------------------------------------------------------
// Aggregate neuron builder — groups file nodes into module + project descriptors
// ---------------------------------------------------------------------------

/** Maximum number of see-also links per aggregate-neuron. */
const MAX_AGGREGATE_SEE_ALSO_LINKS = 5;

/**
 * Derive see-also links for an aggregate module node from real graph relationships.
 *
 * Priority:
 *   1. Cross-module import connections: modules that contain files which
 *      directly import (or are imported by) files in `dir`.
 *   2. Sibling modules: other modules under the same parent directory as `dir`.
 *
 * Cross-project links are excluded — only same-project modules are considered.
 * The result is capped at MAX_AGGREGATE_SEE_ALSO_LINKS, de-duplicated, and
 * sorted by directness first (cross-module import connections before siblings).
 *
 * @param dir          The normalized directory path for this module ('' = root).
 * @param allDirs      All known module directories in the project (including '').
 * @param dirToFiles   Map from directory path to its direct CodeNode files.
 * @param edges        All edges in the CodeScanResult.
 * @returns            At most MAX_AGGREGATE_SEE_ALSO_LINKS see-also entries.
 */
function buildAggregateNeuronSeeAlso(
  dir: string,
  allDirs: ReadonlySet<string>,
  dirToFiles: ReadonlyMap<string, readonly CodeNode[]>,
  edges: readonly CodeEdge[],
): Array<{ id: string; title: string }> {
  // Root aggregates (project nodes) do not need see-also — their sub-modules
  // are already listed in the children section.
  if (dir === '') return [];

  const seen = new Set<string>([dir]);
  const result: Array<{ id: string; title: string }> = [];

  // Build a map from file path → its parent directory for quick lookup
  const fileToDir = new Map<string, string>();
  for (const [d, files] of dirToFiles) {
    for (const f of files) {
      fileToDir.set(f.id, d);
    }
  }

  // Collect the file IDs that belong to this module directory
  const ownFiles = new Set<string>((dirToFiles.get(dir) ?? []).map((n) => n.id));

  // 1. Cross-module import connections
  for (const edge of edges) {
    if (result.length >= MAX_AGGREGATE_SEE_ALSO_LINKS) break;
    if (edge.type !== 'imports') continue;

    // A file in our dir imports into another dir, or another dir imports from us
    const srcDir = fileToDir.get(edge.source);
    const tgtDir = fileToDir.get(edge.target);

    let peerDir: string | undefined;
    if (ownFiles.has(edge.source) && tgtDir !== undefined && tgtDir !== dir) {
      peerDir = tgtDir;
    } else if (ownFiles.has(edge.target) && srcDir !== undefined && srcDir !== dir) {
      peerDir = srcDir;
    }

    if (peerDir !== undefined && !seen.has(peerDir) && allDirs.has(peerDir)) {
      seen.add(peerDir);
      result.push({
        id: `module:${peerDir}`,
        title: peerDir.split('/').pop() ?? peerDir,
      });
    }
  }

  // 2. Sibling modules: other directories that share the same parent as `dir`
  if (result.length < MAX_AGGREGATE_SEE_ALSO_LINKS) {
    const lastSlash = dir.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? dir.slice(0, lastSlash) : '';

    for (const candidate of allDirs) {
      if (result.length >= MAX_AGGREGATE_SEE_ALSO_LINKS) break;
      if (seen.has(candidate) || candidate === '' || candidate === dir) continue;

      const candidateLastSlash = candidate.lastIndexOf('/');
      const candidateParent = candidateLastSlash >= 0 ? candidate.slice(0, candidateLastSlash) : '';

      if (candidateParent === parentDir) {
        seen.add(candidate);
        result.push({
          id: `module:${candidate}`,
          title: candidate.split('/').pop() ?? candidate,
        });
      }
    }
  }

  return result;
}

/**
 * Build AggregateNeuronDescriptor objects from a CodeScanResult.
 *
 * Groups file nodes by directory:
 * - One MODULE aggregate per non-empty directory
 * - One PROJECT aggregate for the root
 *
 * Descriptors are ordered leaves-first (deepest directories first) so that
 * parent aggregates can reference already-computed children.
 *
 * See-also for each module is derived from:
 *   1. Cross-module import edges (files in this module importing or imported by
 *      files in a sibling module).
 *   2. Sibling modules (same parent directory).
 *
 * Returns AggregateNeuronDescriptor[] — callers render via composeAggregateNeuron().
 */
export function buildAggregateNeurons(result: CodeScanResult): AggregateNeuronDescriptor[] {
  const { nodes, edges, projectName } = result;
  const sourceNodes = nodes.filter((n) => n.type === 'file' || n.type === 'test');
  if (sourceNodes.length === 0) return [];

  // Group source files by their parent directory (normalized to forward slashes)
  const dirToFiles = new Map<string, CodeNode[]>();
  for (const node of sourceNodes) {
    const normalized = node.filePath.replace(/\\/g, '/');
    const slashIdx = normalized.lastIndexOf('/');
    const dir = slashIdx >= 0 ? normalized.slice(0, slashIdx) : '';
    const existing = dirToFiles.get(dir);
    if (existing) {
      existing.push(node);
    } else {
      dirToFiles.set(dir, [node]);
    }
  }

  // Collect all directory paths (including parent directories that only hold sub-dirs)
  const allDirs = new Set<string>(dirToFiles.keys());
  for (const dir of [...allDirs]) {
    let current = dir;
    while (current.includes('/')) {
      current = current.slice(0, current.lastIndexOf('/'));
      allDirs.add(current);
    }
    if (current !== '') allDirs.add('');
  }

  // Sort directories: deepest first, then shallower
  const sortedDirs = [...allDirs].sort((a, b) => {
    const depthA = a === '' ? 0 : a.split('/').length;
    const depthB = b === '' ? 0 : b.split('/').length;
    return depthB - depthA;
  });

  // Build a map from directory path → its aggregate descriptor (for child references)
  const dirToDescriptor = new Map<string, AggregateNeuronDescriptor>();

  const aggregates: AggregateNeuronDescriptor[] = [];

  for (const dir of sortedDirs) {
    const filesInDir = dirToFiles.get(dir) ?? [];
    const isRoot = dir === '';

    // Immediate sub-directories of this directory
    const subDirs = [...dirToDescriptor.keys()].filter((d) => {
      if (d === '' || d === dir) return false;
      const normalized = d.replace(/\\/g, '/');
      if (isRoot) {
        // Direct children of root: no slash in the path
        return !normalized.includes('/');
      }
      // Direct children of dir: d starts with dir + '/' and has no more '/' after that
      const prefix = `${dir}/`;
      if (!normalized.startsWith(prefix)) return false;
      const remainder = normalized.slice(prefix.length);
      return !remainder.includes('/');
    });

    // Compute stats: include only direct files (not sub-directory files)
    // For project-level stats, roll up everything
    const directFileCount = filesInDir.length;
    const directLines = filesInDir.reduce((sum, n) => sum + n.lineCount, 0);
    const directLangs = [...new Set(filesInDir.map((n) => n.language))];

    // Children: file-neurons in this dir + immediate sub-module descriptors
    const fileChildren = filesInDir.map((n) => ({
      id: n.id,
      title: n.filePath.replace(/\\/g, '/').split('/').pop() ?? n.filePath,
      kind: 'file' as const,
    }));

    const subModuleChildren = subDirs.map((d) => ({
      id: `module:${d}`,
      title: d.split('/').pop() ?? d,
      kind: 'module' as const,
    }));

    const children = [...subModuleChildren, ...fileChildren];

    // For project root: roll up all file stats across entire tree
    const totalFileCount = isRoot ? sourceNodes.length : directFileCount;
    const totalLines = isRoot ? sourceNodes.reduce((sum, n) => sum + n.lineCount, 0) : directLines;
    const allLangs = isRoot ? [...new Set(sourceNodes.map((n) => n.language))] : directLangs;

    const id = isRoot ? `project:${projectName}` : `module:${dir}`;
    const kind: 'project' | 'module' = isRoot ? 'project' : 'module';
    const title = isRoot ? projectName : dir;

    // Compute see-also from sibling modules and cross-module import edges.
    // Skipped for project root (its sub-modules are already in children).
    const seeAlso = buildAggregateNeuronSeeAlso(dir, allDirs, dirToFiles, edges);

    const descriptor: AggregateNeuronDescriptor = {
      id,
      kind,
      title,
      path: dir,
      projectName,
      children,
      stats: {
        fileCount: totalFileCount,
        totalLines,
        languages: allLangs,
      },
      ...(seeAlso.length > 0 ? { seeAlso } : {}),
      ...(isRoot && subDirs.length > 0
        ? {
            subModules: subDirs.map((d) => ({
              id: `module:${d}`,
              title: d.split('/').pop() ?? d,
            })),
          }
        : {}),
    };

    dirToDescriptor.set(dir, descriptor);
    aggregates.push(descriptor);
  }

  return aggregates;
}

// ---------------------------------------------------------------------------
// Cross-link helpers: conversation note → code node
// ---------------------------------------------------------------------------

/**
 * Given a set of file path fragments mentioned in note text (e.g. "src/auth.ts"),
 * find matching CodeNode IDs. Used to build cross-edges between conversation
 * notes and code nodes.
 */
export function findCodeNodesByPathFragment(fragment: string, nodes: CodeNode[]): CodeNode[] {
  const norm = fragment.replace(/\\/g, '/').toLowerCase();
  return nodes.filter((n) => n.filePath.toLowerCase().includes(norm));
}

/**
 * Collect all unique cwd values from a set of raw notes' HTML attributes.
 * Looks for data-cerveau-cwd on the root element.
 */
export function extractCwdsFromHtmlFiles(htmlContents: string[]): Set<string> {
  const cwds = new Set<string>();
  for (const html of htmlContents) {
    const match = html.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i);
    if (match?.[1]) cwds.add(match[1]);
  }
  return cwds;
}

// ---------------------------------------------------------------------------
// AST-enriched async scan
// ---------------------------------------------------------------------------

/**
 * Async version of scanProject that enriches CodeNode entries with real AST
 * data (functions, classes, precise imports/exports) via tree-sitter.
 *
 * Falls back to the regex result for each file where AST parsing fails.
 * The synchronous scanProject() result is used as the base; this function
 * only upgrades nodes that can be parsed.
 */
export async function scanProjectAsync(projectRoot: string): Promise<CodeScanResult | null> {
  const base = scanProject(projectRoot);
  if (!base) return null;

  // Enrich nodes with AST data in parallel (bounded concurrency).
  // Returns a new CodeNode (immutable); original base.nodes are never mutated.
  const CONCURRENCY = 8;
  const enrichNode = async (node: CodeNode): Promise<CodeNode> => {
    const fullPath = join(node.projectRoot, node.filePath);
    try {
      const parsed = await parseFile(fullPath);
      if (!parsed) return node;

      // Replace regex imports with AST imports (relative only, matching scanProject filter)
      const astImports = parsed.imports.filter((imp) => imp.isRelative).map((imp) => imp.source);

      return {
        ...node,
        imports: astImports.length > 0 || parsed.imports.length > 0 ? astImports : node.imports,
        exports: parsed.exports.length > 0 ? parsed.exports : node.exports,
        astFunctions: parsed.functions,
        astClasses: parsed.classes,
        astBindings: parsed.bindings.length > 0 ? parsed.bindings : undefined,
        astParsed: true,
      };
    } catch {
      // Leave regex-extracted data intact on parse failure
      return node;
    }
  };

  const updatedNodes: CodeNode[] = [];
  for (let i = 0; i < base.nodes.length; i += CONCURRENCY) {
    const batch = base.nodes.slice(i, i + CONCURRENCY);
    const enriched = await Promise.all(batch.map(enrichNode));
    updatedNodes.push(...enriched);
  }

  // Rebuild import edges using enriched imports
  const fileNodesByPath = new Map(updatedNodes.map((n) => [n.filePath, n]));
  const astEdges: CodeEdge[] = base.edges.filter((e) => e.type !== 'imports');

  for (const node of updatedNodes) {
    for (const imp of node.imports) {
      const resolved = resolveImport(node.filePath, imp, fileNodesByPath);
      if (resolved) {
        astEdges.push({
          source: node.id,
          target: `file:${resolved}`,
          type: 'imports',
          confidence: 'extracted',
          confidenceScore: 1.0,
        });
      }
    }
  }

  return {
    ...base,
    nodes: updatedNodes,
    edges: astEdges,
  };
}
