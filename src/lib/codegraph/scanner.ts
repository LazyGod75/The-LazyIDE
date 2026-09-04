/* scanner.ts — Phase 1-2: file scanning + symbol extraction.
   Walks the project tree, reads files, extracts functions/classes/imports/exports
   via regex patterns (AST-ready interface for future tree-sitter integration).
   Also detects API routes and ORM queries (A9, A10).
*/

import type { CodeNode, CodeEdge, SymbolKind } from './types.js';

// ── Language config ───────────────────────────────────────────────

interface LangConfig {
  ext: string[];
  language: string;
  fnPattern: RegExp;
  classPattern: RegExp;
  importPattern: RegExp;
  exportPattern: RegExp;
  routePattern?: RegExp;
  ormPattern?: RegExp;
}

const LANG_CONFIGS: LangConfig[] = [
  {
    ext: ['ts', 'tsx'],
    language: 'typescript',
    fnPattern: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g,
    classPattern: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/g,
    importPattern: /import\s+(?:type\s+)?(?:\{([^}]+)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]/g,
    exportPattern: /export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g,
    routePattern: /(?:app|router|fastify)\.(get|post|put|delete|patch|use)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    ormPattern: /(?:prisma|supabase)\.(?:\w+)\.(findMany|findUnique|create|update|delete|upsert|aggregate)\s*\(/g,
  },
  {
    ext: ['js', 'jsx'],
    language: 'javascript',
    fnPattern: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g,
    classPattern: /(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/g,
    importPattern: /(?:import\s+(?:\{([^}]+)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g,
    exportPattern: /(?:export\s+(?:default\s+)?(?:const|let|var|function|class)\s+(\w+)|module\.exports\s*=\s*(\w+))/g,
    routePattern: /(?:app|router|fastify)\.(get|post|put|delete|patch|use)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    ormPattern: /(?:prisma|supabase)\.(?:\w+)\.(findMany|findUnique|create|update|delete|upsert)\s*\(/g,
  },
  {
    ext: ['py'],
    language: 'python',
    fnPattern: /def\s+(\w+)\s*\(([^)]*)\)/g,
    classPattern: /class\s+(\w+)\s*(?:\(([^)]+)\))?:/g,
    importPattern: /(?:from\s+(\S+)\s+import\s+(.+)|import\s+(\S+))/g,
    exportPattern: /(?:^|\n)(\w+)\s*=/g,
    routePattern: /@(app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    ormPattern: /(?:objects)\.(?:filter|get|create|update|delete|all)\s*\(/g,
  },
  {
    ext: ['rs'],
    language: 'rust',
    fnPattern: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/g,
    classPattern: /(?:pub\s+)?struct\s+(\w+)/g,
    importPattern: /use\s+([^;]+);/g,
    exportPattern: /(?:pub\s+)?(?:fn|struct|enum|trait|const|type)\s+(\w+)/g,
  },
  {
    ext: ['go'],
    language: 'go',
    fnPattern: /func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(([^)]*)\)/g,
    classPattern: /type\s+(\w+)\s+struct\s*\{/g,
    importPattern: /import\s+"([^"]+)"/g,
    exportPattern: /func\s+(?:\([^)]+\)\s+)?([A-Z]\w+)\s*\(/g,
    routePattern: /(?:r|router|mux)\.(GET|POST|PUT|DELETE|PATCH|HandleFunc)\s*\(\s*['"`]([^'"`]+)['"`]/g,
  },
  {
    ext: ['java', 'kt'],
    language: 'java',
    fnPattern: /(?:public|private|protected)?\s+(?:static\s+)?(?:\w+\s+)+(\w+)\s*\(([^)]*)\)\s*\{/g,
    classPattern: /class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?/g,
    importPattern: /import\s+([^;]+);/g,
    exportPattern: /(?:public)\s+(?:class|interface|enum)\s+(\w+)/g,
    routePattern: /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?['"`]([^'"`]+)['"`]/g,
    ormPattern: /(?:repository|entityManager)\.(?:save|findById|findAll|delete|update)\s*\(/g,
  },
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '__pycache__',
  '.next', '.nuxt', '.cache', '.lazy', '.windsurf', '.claude',
  'vendor', '.venv', 'venv', 'env', '.gitnexus', 'coverage',
]);

export const MAX_FILE_SIZE = 256 * 1024;

function langForFile(filename: string): LangConfig | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return LANG_CONFIGS.find(c => c.ext.includes(ext)) ?? null;
}

function nodeId(kind: SymbolKind, filePath: string, name: string): string {
  return `${kind}:${filePath}:${name}`;
}

// ── Symbol extraction ─────────────────────────────────────────────

export interface ScanResult {
  nodes: CodeNode[];
  edges: CodeEdge[];
  routes: Array<{ method: string; path: string; handlerName: string; filePath: string; line: number }>;
  ormQueries: Array<{ model: string; operation: string; filePath: string; line: number }>;
}

export function scanFile(filePath: string, content: string): ScanResult {
  const config = langForFile(filePath);
  if (!config) return { nodes: [], edges: [], routes: [], ormQueries: [] };

  const nodes: CodeNode[] = [];
  const edges: CodeEdge[] = [];
  const routes: ScanResult['routes'] = [];
  const ormQueries: ScanResult['ormQueries'] = [];

  // File node
  const fileNode: CodeNode = {
    id: nodeId('file', filePath, ''),
    name: filePath.split('/').pop() ?? filePath,
    kind: 'file',
    filePath,
    startLine: 0,
    endLine: content.split('\n').length,
    language: config.language,
    isExported: false,
  };
  nodes.push(fileNode);

  // Functions
  let match: RegExpExecArray | null;
  config.fnPattern.lastIndex = 0;
  while ((match = config.fnPattern.exec(content)) !== null) {
    const name = match[1];
    const params = match[2]?.split(',').map(p => p.trim()).filter(Boolean) ?? [];
    const line = content.slice(0, match.index).split('\n').length;
    const isExported = /export/.test(match[0]);
    const fnNode: CodeNode = {
      id: nodeId('function', filePath, name),
      name,
      kind: 'function',
      filePath,
      startLine: line,
      endLine: line + (content.slice(match.index).match(/\n/g)?.length ?? 1),
      language: config.language,
      isExported,
      params,
    };
    nodes.push(fnNode);
    edges.push({
      source: fileNode.id,
      target: fnNode.id,
      type: 'defines',
      confidence: 'extracted',
      confidenceScore: 1.0,
    });
  }

  // Classes
  config.classPattern.lastIndex = 0;
  while ((match = config.classPattern.exec(content)) !== null) {
    const name = match[1];
    const extendsList = match[2] ? [match[2].trim()] : [];
    const line = content.slice(0, match.index).split('\n').length;
    const isExported = /export/.test(match[0]);
    const clsNode: CodeNode = {
      id: nodeId('class', filePath, name),
      name,
      kind: 'class',
      filePath,
      startLine: line,
      endLine: line + 10,
      language: config.language,
      isExported,
      extends: extendsList,
    };
    nodes.push(clsNode);
    edges.push({
      source: fileNode.id,
      target: clsNode.id,
      type: 'defines',
      confidence: 'extracted',
      confidenceScore: 1.0,
    });
  }

  // Routes
  if (config.routePattern) {
    config.routePattern.lastIndex = 0;
    while ((match = config.routePattern.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const path = match[2];
      const line = content.slice(0, match.index).split('\n').length;
      routes.push({ method, path, handlerName: '', filePath, line });
    }
  }

  // ORM queries
  if (config.ormPattern) {
    config.ormPattern.lastIndex = 0;
    while ((match = config.ormPattern.exec(content)) !== null) {
      const operation = match[1] ?? match[0];
      const line = content.slice(0, match.index).split('\n').length;
      ormQueries.push({ model: '', operation, filePath, line });
    }
  }

  return { nodes, edges, routes, ormQueries };
}

// ── Directory walking (via Platform.fs) ───────────────────────────

export interface WalkOptions {
  maxDepth?: number;
  maxFiles?: number;
  skipDirs?: Set<string>;
}

export async function collectSourceFiles(
  readDir: (path: string) => Promise<Array<{ name: string; path: string; isDir: boolean }>>,
  rootPath: string,
  opts?: WalkOptions,
): Promise<string[]> {
  const maxDepth = opts?.maxDepth ?? 8;
  const maxFiles = opts?.maxFiles ?? 2000;
  const skip = opts?.skipDirs ?? SKIP_DIRS;
  const collected: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || collected.length >= maxFiles) return;
    let entries: Array<{ name: string; path: string; isDir: boolean }>;
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= maxFiles) break;
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      if (entry.isDir) {
        await walk(entry.path, depth + 1);
      } else if (langForFile(entry.name)) {
        collected.push(entry.path);
      }
    }
  }

  await walk(rootPath, 0);
  return collected;
}
