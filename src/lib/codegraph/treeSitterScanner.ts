/* treeSitterScanner.ts — AST-based symbol extraction using web-tree-sitter.
   Replaces the regex-based scanner with real AST parsing for 30+ languages.
   Falls back to the regex scanner when tree-sitter is unavailable (e.g. in
   tests or web mock without WASM files).
*/

import type { CodeNode, CodeEdge, SymbolKind } from './types.js';
import type { ScanResult } from './scanner.js';
import { getLanguageConfig, grammarWasmUrl } from './languageRegistry.js';

// ── Lazy-loaded tree-sitter runtime ───────────────────────────────

interface TreeSitterNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  childCount: number;
  parent: TreeSitterNode | null;
  child(index: number): TreeSitterNode | null;
  childForFieldName(field: string): TreeSitterNode | null;
}

interface TreeSitterLanguage {
  load(buffer: ArrayBuffer): Promise<TreeSitterLanguage>;
}

interface TreeSitterParserInstance {
  setLanguage(lang: TreeSitterLanguage): void;
  parse(content: string): { rootNode: TreeSitterNode; delete(): void } | null;
  delete(): void;
}

interface TreeSitterParserConstructor {
  new (): TreeSitterParserInstance;
  init(): Promise<void>;
  Language: { load(buffer: ArrayBuffer): Promise<TreeSitterLanguage> };
}

let _parser: TreeSitterParserConstructor | null = null;
let _initPromise: Promise<TreeSitterParserConstructor | null> | null = null;
const _languageCache = new Map<string, TreeSitterLanguage>();

/** Fix 5 (system-pressure shedding) — drops every cached parsed grammar
 *  module. Safe/reclaimable: `loadLanguage` below re-fetches and recompiles
 *  the grammar's WASM on the next scan that needs it (a real but bounded
 *  cost — a few hundred KB of WASM — never a correctness issue, since
 *  nothing else holds a reference to the CLEARED map, only to language
 *  objects already handed out for an in-flight parse). Called from
 *  systemPressureShedding.ts's dropReclaimableCaches on a transition to
 *  'high' system pressure. */
export function clearTreeSitterLanguageCache(): void {
  _languageCache.clear();
}

/** Check if we're in an environment with fetch (browser/Tauri). */
function hasFetch(): boolean {
  return typeof fetch !== 'undefined';
}

/** Initialize web-tree-sitter lazily. */
async function getTreeSitter(): Promise<TreeSitterParserConstructor | null> {
  if (_parser) return _parser;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const mod = await import('web-tree-sitter') as unknown as Record<string, unknown>;
      const Parser = mod.Parser ?? (mod.default as Record<string, unknown>)?.Parser ?? mod.default;
      if (!Parser || typeof Parser !== 'function') return null;
      const ctor = Parser as unknown as TreeSitterParserConstructor;
      await ctor.init();
      _parser = ctor;
      return ctor;
    } catch {
      return null;
    }
  })();

  return _initPromise;
}

/** Load a tree-sitter language grammar by name. */
async function loadLanguage(grammarName: string): Promise<TreeSitterLanguage | null> {
  if (_languageCache.has(grammarName)) {
    return _languageCache.get(grammarName) ?? null;
  }

  const Parser = await getTreeSitter();
  if (!Parser) return null;

  try {
    const url = grammarWasmUrl(grammarName);
    if (!hasFetch()) return null;

    const response = await fetch(url);
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    const lang = await Parser.Language.load(buffer);
    _languageCache.set(grammarName, lang);
    return lang;
  } catch {
    return null;
  }
}

// ── AST traversal helpers ─────────────────────────────────────────

function nodeId(kind: SymbolKind, filePath: string, name: string): string {
  return `${kind}:${filePath}:${name}`;
}

function getLineNumber(text: string, byteOffset: number): number {
  return text.slice(0, byteOffset).split('\n').length;
}

function getEndLineNumber(text: string, byteOffset: number): number {
  return text.slice(0, byteOffset).split('\n').length;
}

/** Extract a name from a tree-sitter node by looking at its children. */
function extractName(node: TreeSitterNode): string {
  // Try common child field names
  const nameFields = ['name', 'declarator', 'identifier', 'key'];
  for (const field of nameFields) {
    const child = node.childForFieldName(field);
    if (child) return child.text;
  }

  // Try first identifier child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'identifier') return child.text;
  }

  // Fallback: first child's text
  if (node.childCount > 0) {
    return node.child(0)?.text ?? '<anonymous>';
  }

  return '<anonymous>';
}

/** Extract parameters from a function node. */
function extractParams(node: TreeSitterNode): string[] {
  const paramsField = node.childForFieldName('parameters');
  if (!paramsField) return [];

  const params: string[] = [];
  for (let i = 0; i < paramsField.childCount; i++) {
    const child = paramsField.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'parameter') {
      params.push(child.text);
    }
  }
  return params;
}

/** Check if a node is inside an export statement. */
function isExported(node: TreeSitterNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'export_statement' || parent.type === 'export_declaration') {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

/** Extract heritage (extends/implements) from a class node. */
function extractHeritage(node: TreeSitterNode): { extends?: string[]; implements?: string[] } {
  const result: { extends?: string[]; implements?: string[] } = {};

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'extends_clause' || child.type === 'superclass') {
      const names: string[] = [];
      for (let j = 0; j < child.childCount; j++) {
        const sub = child.child(j);
        if (sub && (sub.type === 'identifier' || sub.type === 'type_identifier')) {
          names.push(sub.text);
        }
      }
      if (names.length) result.extends = names;
    }

    if (child.type === 'implements_clause' || child.type === 'protocol_list') {
      const names: string[] = [];
      for (let j = 0; j < child.childCount; j++) {
        const sub = child.child(j);
        if (sub && (sub.type === 'identifier' || sub.type === 'type_identifier')) {
          names.push(sub.text);
        }
      }
      if (names.length) result.implements = names;
    }
  }

  return result;
}

/** Extract import path from an import node. */
function extractImportPath(node: TreeSitterNode): string | null {
  // Look for string literal children
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'string' || child.type === 'string_literal') {
      return child.text.replace(/^["'`]|["'`]$/g, '');
    }
    // Recurse one level
    for (let j = 0; j < child.childCount; j++) {
      const sub = child.child(j);
      if (sub && (sub.type === 'string' || sub.type === 'string_literal')) {
        return sub.text.replace(/^["'`]|["'`]$/g, '');
      }
    }
  }
  return null;
}

// ── Main scan function ────────────────────────────────────────────

export interface TreeSitterScanOptions {
  /** Whether tree-sitter is required (no regex fallback). */
  requireTreeSitter?: boolean;
}

export async function scanFileWithTreeSitter(
  filePath: string,
  content: string,
): Promise<ScanResult | null> {
  const config = getLanguageConfig(filePath);
  if (!config) return null;
  const langConfig = config;

  // Skip non-code files (yaml, toml, json, html, css have no symbols)
  if (config.functionNodeTypes.length === 0 && config.classNodeTypes.length === 0) {
    return { nodes: [], edges: [], routes: [], ormQueries: [] };
  }

  const language = await loadLanguage(config.grammar);
  if (!language) return null;

  const Parser = await getTreeSitter();
  if (!Parser) return null;

  const parser = new Parser();
  parser.setLanguage(language);

  let tree: { rootNode: TreeSitterNode; delete(): void } | null;
  try {
    tree = parser.parse(content);
  } catch {
    return null;
  }
  if (!tree) return null;

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
    language: config.grammar,
    isExported: false,
  };
  nodes.push(fileNode);

  // Walk the AST
  const visited = new Set<TreeSitterNode>();

  function walkTree(node: TreeSitterNode | null) {
    if (!node || visited.has(node)) return;
    visited.add(node);

    const nodeType = node.type;
    const startLine = getLineNumber(content, node.startIndex);
    const endLine = getEndLineNumber(content, node.endIndex);

    // Functions
    if (langConfig.functionNodeTypes.includes(nodeType)) {
      const name = extractName(node);
      const params = extractParams(node);
      const exported = isExported(node);

      const fnNode: CodeNode = {
        id: nodeId('function', filePath, name),
        name,
        kind: 'function',
        filePath,
        startLine,
        endLine,
        language: langConfig.grammar,
        isExported: exported,
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

    // Classes/structs
    if (langConfig.classNodeTypes.includes(nodeType)) {
      const name = extractName(node);
      const heritage = extractHeritage(node);
      const exported = isExported(node);

      const clsNode: CodeNode = {
        id: nodeId('class', filePath, name),
        name,
        kind: 'class',
        filePath,
        startLine,
        endLine,
        language: langConfig.grammar,
        isExported: exported,
        extends: heritage.extends,
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

    // Interfaces/traits
    if (langConfig.interfaceNodeTypes?.includes(nodeType)) {
      const name = extractName(node);
      const ifaceNode: CodeNode = {
        id: nodeId('interface', filePath, name),
        name,
        kind: 'interface',
        filePath,
        startLine,
        endLine,
        language: langConfig.grammar,
        isExported: isExported(node),
      };
      nodes.push(ifaceNode);
      edges.push({
        source: fileNode.id,
        target: ifaceNode.id,
        type: 'defines',
        confidence: 'extracted',
        confidenceScore: 1.0,
      });
    }

    // Enums
    if (langConfig.enumNodeTypes?.includes(nodeType)) {
      const name = extractName(node);
      const enumNode: CodeNode = {
        id: nodeId('enum', filePath, name),
        name,
        kind: 'enum',
        filePath,
        startLine,
        endLine,
        language: langConfig.grammar,
        isExported: isExported(node),
      };
      nodes.push(enumNode);
      edges.push({
        source: fileNode.id,
        target: enumNode.id,
        type: 'defines',
        confidence: 'extracted',
        confidenceScore: 1.0,
      });
    }

    // Imports — store as edges between files
    if (langConfig.importNodeTypes.includes(nodeType)) {
      const importPath = extractImportPath(node);
      if (importPath) {
        // We'll resolve this in the cross-file phase
        edges.push({
          source: fileNode.id,
          target: `file:UNRESOLVED:${importPath}`,
          type: 'imports',
          confidence: 'extracted',
          confidenceScore: 1.0,
        });
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      walkTree(node.child(i));
    }
  }

  walkTree(tree.rootNode);

  // Route detection (regex-based, language-specific)
  if (langConfig.routePattern) {
    langConfig.routePattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = langConfig.routePattern.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const path = match[2];
      const line = content.slice(0, match.index).split('\n').length;
      routes.push({ method, path, handlerName: '', filePath, line });
    }
  }

  // ORM query detection
  if (langConfig.ormPattern) {
    langConfig.ormPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = langConfig.ormPattern.exec(content)) !== null) {
      const operation = match[1] ?? match[0];
      const line = content.slice(0, match.index).split('\n').length;
      ormQueries.push({ model: '', operation, filePath, line });
    }
  }

  // Clean up
  tree.delete();
  parser.delete();

  return { nodes, edges, routes, ormQueries };
}

// ── Fast syntax-only check (harness hardening, task #3) ────────────
//
// 2026-08-15 (see scratch/_harness-research.md): SWE-agent's own ablation
// on SWE-bench Lite measured skipping "lint after every edit, revert on
// syntax error" at -3.0 points (18.0% -> 15.0%) — the single most direct,
// numerically-justified guardrail in the whole research pass. This reuses
// the SAME tree-sitter WASM parsing infrastructure scanFileWithTreeSitter
// already depends on (loadLanguage/getTreeSitter/getLineNumber above) —
// "whatever fast check this repo already has", not a new toolchain: no
// shell-out, no Node child process, runs in-process in the same webview
// that already ships tree-sitter-wasms as a real (non-dev) dependency.
//
// Called from src/lib/tools/handlers/files.ts BEFORE writeFile/editFile/
// multiEdit persist their new content — see that file's
// rejectIfSyntaxBroken for how a `!ok` result becomes an ERROR observation
// and the edit is never written to disk (stronger than a write-then-revert
// cycle: the broken content never touches disk at all, so there is no
// window where a half-applied edit could be read by another tool call).

export interface SyntaxCheckResult {
  /** False when the file's language has no tree-sitter grammar available
   *  (unknown extension, WASM fetch failed, non-browser environment) — the
   *  caller must treat this as "not checked", NEVER as "broken". */
  supported: boolean;
  ok: boolean;
  errors: Array<{ line: number; snippet: string }>;
}

/** Cap on how many ERROR nodes to collect — a badly broken file can produce
 *  hundreds of cascading parser-recovery errors from one root cause; only
 *  the first few are useful in an observation fed back to the model. */
const MAX_SYNTAX_ERRORS = 5;

export async function checkSyntax(filePath: string, content: string): Promise<SyntaxCheckResult> {
  const config = getLanguageConfig(filePath);
  if (!config) return { supported: false, ok: true, errors: [] };

  const language = await loadLanguage(config.grammar);
  if (!language) return { supported: false, ok: true, errors: [] };

  const Parser = await getTreeSitter();
  if (!Parser) return { supported: false, ok: true, errors: [] };

  const parser = new Parser();
  parser.setLanguage(language);

  let tree: { rootNode: TreeSitterNode; delete(): void } | null;
  try {
    tree = parser.parse(content);
  } catch {
    parser.delete();
    return { supported: false, ok: true, errors: [] };
  }
  if (!tree) {
    parser.delete();
    return { supported: false, ok: true, errors: [] };
  }

  const errors: Array<{ line: number; snippet: string }> = [];
  const contentLines = content.split('\n');

  function walk(node: TreeSitterNode | null): void {
    if (!node || errors.length >= MAX_SYNTAX_ERRORS) return;
    // tree-sitter's own error-recovery marker for a genuinely unparseable
    // region — recursing INTO an ERROR node's children would only surface
    // the same broken span again at finer grain, so this node is a leaf
    // for our purposes.
    if (node.type === 'ERROR') {
      const line = getLineNumber(content, node.startIndex);
      const snippet = contentLines[line - 1]?.trim().slice(0, 120) ?? '';
      errors.push({ line, snippet });
      return;
    }
    for (let i = 0; i < node.childCount && errors.length < MAX_SYNTAX_ERRORS; i++) {
      walk(node.child(i));
    }
  }
  walk(tree.rootNode);

  tree.delete();
  parser.delete();

  return { supported: true, ok: errors.length === 0, errors };
}

/** Check if tree-sitter is available (initialized and can load WASM). */
export async function isTreeSitterAvailable(): Promise<boolean> {
  const parser = await getTreeSitter();
  return parser !== null && hasFetch();
}

/** Preload grammars for common languages. */
export async function preloadGrammars(grammarNames: string[]): Promise<void> {
  await getTreeSitter();
  await Promise.all(grammarNames.map(name => loadLanguage(name)));
}
