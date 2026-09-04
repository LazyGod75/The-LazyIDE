/* resolver.ts — Phase 3-4: cross-file resolution.
   Resolves imports to actual file paths, matches function calls to definitions
   across files, resolves class heritage (extends/implements), and builds
   the final edge set with confidence scoring.

   This is the bridge from "we have symbols" to "we know who calls whom".
*/

import type { CodeNode, CodeEdge, CodeGraph } from './types.js';
import type { ScanResult } from './scanner.js';

// ── Import resolution ─────────────────────────────────────────────

/** Resolve a relative import path to an actual file path in the project. */
function resolveImportPath(
  importPath: string,
  fromFile: string,
  allFiles: Set<string>,
): string | null {
  // Normalize: remove extension, try common extensions
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  let base = importPath;

  // Relative imports
  if (importPath.startsWith('./') || importPath.startsWith('../')) {
    const parts = (dir + '/' + importPath).split('/');
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '..') resolved.pop();
      else if (part !== '.' && part !== '') resolved.push(part);
    }
    base = resolved.join('/');
  }

  // Try with extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.kt'];
  for (const ext of extensions) {
    const candidate = base + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  // Try index file
  for (const ext of extensions) {
    const candidate = base + '/index' + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  // Bare match (already has extension)
  if (allFiles.has(base)) return base;

  return null;
}

// ── Call extraction ───────────────────────────────────────────────

/** Extract function call sites from file content. */
function extractCalls(content: string): Array<{ name: string; line: number }> {
  const calls: Array<{ name: string; line: number }> = [];
  // Match identifier( patterns — function calls
  const callPattern = /(?<![\w.])([a-zA-Z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(content)) !== null) {
    const name = match[1];
    // Skip keywords
    if (KEYWORDS.has(name)) continue;
    const line = content.slice(0, match.index).split('\n').length;
    calls.push({ name, line });
  }
  return calls;
}

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'return', 'function', 'class', 'def', 'fn', 'struct', 'impl', 'interface',
  'type', 'enum', 'import', 'export', 'const', 'let', 'var', 'async', 'await',
  'new', 'delete', 'typeof', 'instanceof', 'void', 'this', 'self', 'super',
  'try', 'catch', 'finally', 'throw', 'raise', 'match', 'func', 'pub',
  'print', 'console', 'require',
]);

// ── Heritage resolution ───────────────────────────────────────────

function resolveHeritage(
  nodes: CodeNode[],
  nameIndex: Map<string, string[]>,
): CodeEdge[] {
  const edges: CodeEdge[] = [];
  for (const node of nodes) {
    if (node.kind !== 'class' || !node.extends) continue;
    for (const parentName of node.extends) {
      const candidates = nameIndex.get(parentName) ?? [];
      for (const candidateId of candidates) {
        const target = nodes.find(n => n.id === candidateId);
        if (target && target.kind === 'class') {
          edges.push({
            source: node.id,
            target: target.id,
            type: 'extends',
            confidence: 'extracted',
            confidenceScore: 0.9,
          });
        } else if (target && target.kind === 'interface') {
          edges.push({
            source: node.id,
            target: target.id,
            type: 'implements',
            confidence: 'extracted',
            confidenceScore: 0.9,
          });
        }
      }
    }
  }
  return edges;
}

// ── Main resolution pass ──────────────────────────────────────────

export interface ResolveOptions {
  /** Map: filePath → file content (for call extraction). */
  fileContents: Map<string, string>;
}

export function resolveCrossFile(
  scanResults: ScanResult[],
  allFiles: Set<string>,
  opts: ResolveOptions,
): { nodes: CodeNode[]; edges: CodeEdge[] } {
  // Merge all nodes and edges from scan phase
  const allNodes: CodeNode[] = [];
  const allEdges: CodeEdge[] = [];
  for (const sr of scanResults) {
    allNodes.push(...sr.nodes);
    allEdges.push(...sr.edges);
  }

  // Build name index: symbolName → node IDs
  const nameIndex = new Map<string, string[]>();
  for (const node of allNodes) {
    if (node.kind === 'file' || node.kind === 'folder') continue;
    const existing = nameIndex.get(node.name) ?? [];
    existing.push(node.id);
    nameIndex.set(node.name, existing);
  }

  // Build file index: filePath → node IDs
  const fileIndex = new Map<string, string[]>();
  for (const node of allNodes) {
    const existing = fileIndex.get(node.filePath) ?? [];
    existing.push(node.id);
    fileIndex.set(node.filePath, existing);
  }

  // 1. Resolve imports → IMPORTS edges between files
  for (const [filePath, content] of opts.fileContents) {
    const config = getImportPattern(filePath);
    if (!config) continue;
    config.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = config.exec(content)) !== null) {
      const importPath = match[4] ?? match[5] ?? match[1];
      if (!importPath) continue;
      const resolvedPath = resolveImportPath(importPath, filePath, allFiles);
      if (!resolvedPath) continue;
      const fromId = `file:${filePath}:`;
      const toId = `file:${resolvedPath}:`;
      if (allNodes.some(n => n.id === fromId) && allNodes.some(n => n.id === toId)) {
        allEdges.push({
          source: fromId,
          target: toId,
          type: 'imports',
          confidence: 'extracted',
          confidenceScore: 1.0,
        });
      }
    }
  }

  // 2. Resolve calls → CALLS edges between functions
  for (const [filePath, content] of opts.fileContents) {
    const calls = extractCalls(content);
    // Get functions defined in this file
    const fileFns = allNodes.filter(n => n.filePath === filePath && n.kind === 'function');
    if (fileFns.length === 0) continue;

    for (const call of calls) {
      const candidates = nameIndex.get(call.name) ?? [];
      if (candidates.length === 0) continue;

      // Find which function contains this call
      const containingFn = fileFns.find(
        fn => call.line >= fn.startLine && call.line <= fn.endLine,
      );
      if (!containingFn) continue;

      for (const candidateId of candidates) {
        const target = allNodes.find(n => n.id === candidateId);
        if (!target || target.id === containingFn.id) continue;
        if (target.kind !== 'function' && target.kind !== 'method') continue;

        // Confidence: 1.0 if same file, 0.8 if imported, 0.6 if ambiguous
        let confidence = 0.6;
        let confType: 'extracted' | 'inferred' | 'ambiguous' = 'ambiguous';
        if (target.filePath === filePath) {
          confidence = 1.0;
          confType = 'extracted';
        } else if (
          allEdges.some(
            e => e.type === 'imports' &&
            e.source === `file:${filePath}:` &&
            e.target === `file:${target.filePath}:`,
          )
        ) {
          confidence = 0.85;
          confType = 'inferred';
        }

        allEdges.push({
          source: containingFn.id,
          target: target.id,
          type: 'calls',
          confidence: confType,
          confidenceScore: confidence,
        });
      }
    }
  }

  // 3. Resolve heritage (extends/implements)
  const heritageEdges = resolveHeritage(allNodes, nameIndex);
  allEdges.push(...heritageEdges);

  return { nodes: allNodes, edges: dedupEdges(allEdges) };
}

function getImportPattern(filePath: string): RegExp | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    return /import\s+(?:type\s+)?(?:\{([^}]+)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  }
  if (ext === 'py') {
    return /from\s+(\S+)\s+import\s+(.+)/g;
  }
  if (ext === 'rs') {
    return /use\s+([^;]+);/g;
  }
  if (ext === 'go') {
    return /import\s+"([^"]+)"/g;
  }
  if (ext === 'java' || ext === 'kt') {
    return /import\s+([^;]+);/g;
  }
  return null;
}

function dedupEdges(edges: CodeEdge[]): CodeEdge[] {
  const seen = new Set<string>();
  const result: CodeEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

// ── Build final graph ─────────────────────────────────────────────

export function buildGraph(
  nodes: CodeNode[],
  edges: CodeEdge[],
  projectRoot: string,
  lastCommit: string | null,
): CodeGraph {
  const fileIndex = new Map<string, string[]>();
  const nameIndex = new Map<string, string[]>();

  for (const node of nodes) {
    const fileEntries = fileIndex.get(node.filePath) ?? [];
    fileEntries.push(node.id);
    fileIndex.set(node.filePath, fileEntries);

    if (node.kind !== 'file' && node.kind !== 'folder') {
      const nameEntries = nameIndex.get(node.name) ?? [];
      nameEntries.push(node.id);
      nameIndex.set(node.name, nameEntries);
    }
  }

  return {
    nodes,
    edges,
    fileIndex,
    nameIndex,
    indexedAt: Date.now(),
    lastCommit,
    projectRoot,
  };
}
