/**
 * Multi-language AST extraction via tree-sitter (WASM).
 * Replaces regex-based code scanning with deterministic AST parsing.
 *
 * Supported languages: TypeScript, TSX, JavaScript, Python,
 *   Go, Rust, Java, Ruby, C, C++, PHP, C#, Swift, Kotlin.
 * Falls back gracefully: returns null for unsupported files or on parse errors.
 *
 * Design:
 * - Lazy-initialize one Parser per language, cached for reuse.
 * - Use web-tree-sitter@0.22.6 + tree-sitter-wasms for maximum portability.
 * - All tree walks are non-recursive (BFS) to avoid stack overflows on huge files.
 * - Language-specific node type names are declared in LANGUAGE_CONFIGS so the
 *   generic walker can handle each grammar without bespoke code paths.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachExcerpt } from './symbol-excerpt.js';

// web-tree-sitter 0.22.6 exports its types via tree-sitter-web.d.ts, but that
// path cannot be statically resolved across moduleResolution modes (Bundler
// vs NodeNext). We declare the minimal shape this file actually uses instead
// of importing (or aliasing to) the library's own types.
interface TreeSitterSyntaxNode {
  type: string;
  text: string;
  childCount: number;
  isNamed: boolean;
  parent: TreeSitterSyntaxNode | null;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  child(index: number): TreeSitterSyntaxNode | null;
  childForFieldName(name: string): TreeSitterSyntaxNode | null;
}

interface TreeSitterTree {
  rootNode: TreeSitterSyntaxNode;
  delete(): void;
}

interface TreeSitterParserInstance {
  setLanguage(language: unknown): void;
  parse(content: string): TreeSitterTree;
}

interface TreeSitterParserStatic {
  new (): TreeSitterParserInstance;
  init(options: { wasmBinary: Uint8Array }): Promise<void>;
  Language: {
    load(wasmBinary: Uint8Array): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParsedFunction {
  name: string;
  startLine: number;
  endLine: number;
  params: string[];
  isExported: boolean;
  /** Preceding block comment (JSDoc), capped. Empty when none. */
  jsdoc?: string;
  /** Head+tail-capped source of this function. Empty when not attached. */
  excerpt?: string;
}

export interface ParsedClass {
  name: string;
  startLine: number;
  endLine: number;
  methods: string[];
  isExported: boolean;
  extends?: string;
  jsdoc?: string;
  excerpt?: string;
}

/** Type alias, interface, or const/let that is not an arrow function. */
export interface ParsedBinding {
  name: string;
  kind: 'type' | 'interface' | 'const';
  startLine: number;
  endLine: number;
  isExported: boolean;
  jsdoc?: string;
  excerpt?: string;
}

export interface ParsedImport {
  source: string;
  specifiers: string[];
  line: number;
  isRelative: boolean;
}

export interface ParsedFile {
  path: string;
  language: string;
  lineCount: number;
  functions: ParsedFunction[];
  classes: ParsedClass[];
  bindings: ParsedBinding[];
  imports: ParsedImport[];
  exports: string[];
}

// ---------------------------------------------------------------------------
// Internal: language config
// ---------------------------------------------------------------------------

type SupportedLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'ruby'
  | 'c'
  | 'cpp'
  | 'php'
  | 'csharp'
  | 'swift'
  | 'kotlin';

/** Node-type names used by each grammar for functions, classes, and imports. */
interface LanguageNodeTypes {
  /** Node types representing a function or method definition. */
  function: string[];
  /** Node types representing a class, struct, interface, or equivalent. */
  class: string[];
  /** Node types representing an import / use / require statement. */
  import: string[];
}

interface LanguageConfig {
  wasmFile: string;
  nodeTypes: LanguageNodeTypes;
}

const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.php': 'php',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
};

const LANGUAGE_TO_WASM: Record<SupportedLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  php: 'tree-sitter-php.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
};

/**
 * Per-language AST node type names for generic extraction.
 * These cover the most important constructs; some grammars nest types
 * (e.g. Rust uses `function_item` inside `impl_item`) — the generic walker
 * handles depth automatically via BFS.
 */
const LANGUAGE_CONFIGS: Record<SupportedLanguage, LanguageConfig> = {
  typescript: {
    wasmFile: 'tree-sitter-typescript.wasm',
    nodeTypes: {
      function: ['function_declaration'],
      class: ['class_declaration'],
      import: ['import_statement'],
    },
  },
  tsx: {
    wasmFile: 'tree-sitter-tsx.wasm',
    nodeTypes: {
      function: ['function_declaration'],
      class: ['class_declaration'],
      import: ['import_statement'],
    },
  },
  javascript: {
    wasmFile: 'tree-sitter-javascript.wasm',
    nodeTypes: {
      function: ['function_declaration'],
      class: ['class_declaration'],
      import: ['import_statement'],
    },
  },
  python: {
    wasmFile: 'tree-sitter-python.wasm',
    nodeTypes: {
      function: ['function_definition'],
      class: ['class_definition'],
      import: ['import_statement', 'import_from_statement'],
    },
  },
  go: {
    wasmFile: 'tree-sitter-go.wasm',
    nodeTypes: {
      function: ['function_declaration', 'method_declaration'],
      class: ['type_declaration'],
      // import_spec is the leaf node that actually holds the path string;
      // import_declaration / import_spec_list are containers
      import: ['import_spec'],
    },
  },
  rust: {
    wasmFile: 'tree-sitter-rust.wasm',
    nodeTypes: {
      function: ['function_item'],
      class: ['struct_item', 'enum_item', 'trait_item', 'impl_item'],
      import: ['use_declaration'],
    },
  },
  java: {
    wasmFile: 'tree-sitter-java.wasm',
    nodeTypes: {
      function: ['method_declaration', 'constructor_declaration'],
      class: ['class_declaration', 'interface_declaration', 'enum_declaration'],
      import: ['import_declaration'],
    },
  },
  ruby: {
    wasmFile: 'tree-sitter-ruby.wasm',
    nodeTypes: {
      function: ['method', 'singleton_method'],
      class: ['class', 'module'],
      import: ['call'], // require / require_relative are method calls in Ruby grammar
    },
  },
  c: {
    wasmFile: 'tree-sitter-c.wasm',
    nodeTypes: {
      function: ['function_definition'],
      class: ['struct_specifier', 'union_specifier', 'enum_specifier'],
      import: ['preproc_include'],
    },
  },
  cpp: {
    wasmFile: 'tree-sitter-cpp.wasm',
    nodeTypes: {
      function: ['function_definition'],
      class: ['class_specifier', 'struct_specifier'],
      import: ['preproc_include'],
    },
  },
  php: {
    wasmFile: 'tree-sitter-php.wasm',
    nodeTypes: {
      function: ['function_definition', 'method_declaration'],
      class: ['class_declaration', 'interface_declaration', 'trait_declaration'],
      import: ['namespace_use_declaration'],
    },
  },
  csharp: {
    wasmFile: 'tree-sitter-c_sharp.wasm',
    nodeTypes: {
      function: ['method_declaration', 'constructor_declaration', 'local_function_statement'],
      class: [
        'class_declaration',
        'interface_declaration',
        'struct_declaration',
        'record_declaration',
      ],
      import: ['using_directive'],
    },
  },
  swift: {
    wasmFile: 'tree-sitter-swift.wasm',
    nodeTypes: {
      function: ['function_declaration'],
      class: [
        'class_declaration',
        'struct_declaration',
        'protocol_declaration',
        'enum_declaration',
      ],
      import: ['import_declaration'],
    },
  },
  kotlin: {
    wasmFile: 'tree-sitter-kotlin.wasm',
    nodeTypes: {
      function: ['function_declaration', 'anonymous_function'],
      class: ['class_declaration', 'object_declaration', 'interface_declaration'],
      import: ['import_header'],
    },
  },
};

// ---------------------------------------------------------------------------
// Parser cache — one Parser instance per language
// ---------------------------------------------------------------------------

type SyntaxNode = TreeSitterSyntaxNode;

interface ParserEntry {
  parser: TreeSitterParserInstance;
  language: SupportedLanguage;
}

let ParserClass: TreeSitterParserStatic | null = null;
let initPromise: Promise<void> | null = null;
const parserCache = new Map<string, ParserEntry>();

function getWasmDir(): string {
  // Works both from src (tsx) and dist (compiled ESM)
  const require = createRequire(import.meta.url);
  try {
    const pkg = require.resolve('tree-sitter-wasms/package.json');
    return join(pkg, '..', 'out');
  } catch {
    // Fallback: relative from this file's location
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    return join(thisDir, '..', '..', 'node_modules', 'tree-sitter-wasms', 'out');
  }
}

function getTreeSitterWasm(): string {
  const require = createRequire(import.meta.url);
  try {
    const pkg = require.resolve('web-tree-sitter/package.json');
    return join(pkg, '..', 'tree-sitter.wasm');
  } catch {
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    return join(thisDir, '..', '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
  }
}

async function ensureInit(): Promise<void> {
  if (ParserClass !== null) return;
  if (initPromise !== null) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    const mod = await import('web-tree-sitter');
    // web-tree-sitter 0.22.6 uses default export
    const P = (mod.default ?? mod) as unknown as TreeSitterParserStatic;
    const wasmBinary = readFileSync(getTreeSitterWasm());
    await P.init({ wasmBinary });
    ParserClass = P;
  })();

  await initPromise;
}

async function getParser(language: SupportedLanguage): Promise<ParserEntry | null> {
  if (parserCache.has(language)) {
    return parserCache.get(language)!;
  }

  try {
    await ensureInit();
    if (ParserClass === null) return null;

    const wasmFile = join(getWasmDir(), LANGUAGE_TO_WASM[language]);
    const wasmBinary = readFileSync(wasmFile);
    const lang = await ParserClass.Language.load(wasmBinary);
    const parser = new ParserClass();
    parser.setLanguage(lang);

    const entry: ParserEntry = { parser, language };
    parserCache.set(language, entry);
    return entry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal: BFS node search helpers
// ---------------------------------------------------------------------------

function findAll(root: SyntaxNode, nodeType: string): SyntaxNode[] {
  const results: SyntaxNode[] = [];
  const queue: SyntaxNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.type === nodeType) results.push(node);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) queue.push(child);
    }
  }

  return results;
}

function findFirst(root: SyntaxNode, nodeType: string): SyntaxNode | null {
  const queue: SyntaxNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.type === nodeType) return node;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) queue.push(child);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript extraction
// ---------------------------------------------------------------------------

function extractTSParams(paramsNode: SyntaxNode | null): string[] {
  if (!paramsNode) return [];

  const params: string[] = [];
  const paramTypes = ['required_parameter', 'optional_parameter', 'rest_parameter', 'identifier'];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child || !child.isNamed) continue;

    if (paramTypes.includes(child.type)) {
      const pattern = child.childForFieldName('pattern') ?? child;
      const name =
        pattern.type === 'identifier' ? pattern.text : pattern.childForFieldName('name')?.text;
      if (name && name !== ',' && name !== ')' && name !== '(') {
        params.push(name);
      }
    }
  }

  return params;
}

function isNodeExported(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'export_statement') return true;
  // Check for `export default`
  for (let i = 0; i < parent.childCount; i++) {
    const sib = parent.child(i);
    if (sib?.text === 'export') return true;
  }
  return false;
}

function extractTSFunctions(root: SyntaxNode): ParsedFunction[] {
  const results: ParsedFunction[] = [];
  const visited = new Set<number>();

  // function_declaration at top level and arrow functions assigned to exports
  const funcNodes = findAll(root, 'function_declaration');

  for (const fn of funcNodes) {
    if (visited.has(fn.startPosition.row)) continue;
    visited.add(fn.startPosition.row);

    const nameNode = fn.childForFieldName('name');
    if (!nameNode) continue;

    const paramsNode = fn.childForFieldName('parameters');
    const isExported = isNodeExported(fn);

    results.push({
      name: nameNode.text,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      params: extractTSParams(paramsNode),
      isExported,
    });
  }

  // Arrow functions assigned to exported const
  const lexDecls = findAll(root, 'lexical_declaration');
  for (const decl of lexDecls) {
    const exported = isNodeExported(decl);
    const declarators = findAll(decl, 'variable_declarator');

    for (const declarator of declarators) {
      const nameNode = declarator.childForFieldName('name');
      const valueNode = declarator.childForFieldName('value');

      if (
        nameNode &&
        valueNode &&
        (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')
      ) {
        if (visited.has(declarator.startPosition.row)) continue;
        visited.add(declarator.startPosition.row);

        const paramsNode = valueNode.childForFieldName('parameters');
        results.push({
          name: nameNode.text,
          startLine: declarator.startPosition.row + 1,
          endLine: declarator.endPosition.row + 1,
          params: extractTSParams(paramsNode),
          isExported: exported,
        });
      }
    }
  }

  return results;
}

/**
 * Type aliases, interfaces, and non-function const/let bindings. These are
 * the facts signature-only file-neurons miss (measured: NudgeStyle, TYPE_ICON,
 * MAX_FILE_NEURONS, LAZYBRAIN_* constants). Arrow functions stay in
 * extractTSFunctions — they are not re-emitted here.
 */
function extractTSBindings(root: SyntaxNode): ParsedBinding[] {
  const results: ParsedBinding[] = [];
  const seen = new Set<string>();

  const push = (name: string, kind: ParsedBinding['kind'], node: SyntaxNode) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    results.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      isExported: isNodeExported(node),
    });
  };

  for (const node of findAll(root, 'type_alias_declaration')) {
    const nameNode = node.childForFieldName('name');
    if (nameNode) push(nameNode.text, 'type', node);
  }
  for (const node of findAll(root, 'interface_declaration')) {
    const nameNode = node.childForFieldName('name');
    if (nameNode) push(nameNode.text, 'interface', node);
  }

  const arrowRows = new Set<number>();
  for (const decl of findAll(root, 'lexical_declaration')) {
    for (const declarator of findAll(decl, 'variable_declarator')) {
      const value = declarator.childForFieldName('value');
      if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
        arrowRows.add(declarator.startPosition.row);
      }
    }
  }
  for (const decl of findAll(root, 'lexical_declaration')) {
    for (const declarator of findAll(decl, 'variable_declarator')) {
      if (arrowRows.has(declarator.startPosition.row)) continue;
      const nameNode = declarator.childForFieldName('name');
      if (!nameNode) continue;
      push(nameNode.text, 'const', decl);
    }
  }
  return results;
}

function extractTSClasses(root: SyntaxNode): ParsedClass[] {
  const results: ParsedClass[] = [];

  const classNodes = findAll(root, 'class_declaration');
  for (const cls of classNodes) {
    const nameNode = cls.childForFieldName('name');
    if (!nameNode) continue;

    // class_heritage: childForFieldName doesn't work in web-tree-sitter 0.22.6
    // for this field — use findFirst by node type instead.
    let extendsClause: string | undefined;
    const heritage = findFirst(cls, 'class_heritage');
    if (heritage) {
      const extendsNode = findFirst(heritage, 'extends_clause');
      if (extendsNode) {
        // extends_clause: first named child after the 'extends' keyword
        for (let i = 0; i < extendsNode.childCount; i++) {
          const child = extendsNode.child(i);
          if (child?.isNamed) {
            extendsClause = child.text;
            break;
          }
        }
      }
    }

    // body: childForFieldName('body') works reliably
    const body = cls.childForFieldName('body');
    const methods: string[] = [];
    if (body) {
      const methodNodes = findAll(body, 'method_definition');
      for (const m of methodNodes) {
        const mName = m.childForFieldName('name');
        if (mName) methods.push(mName.text);
      }
    }

    results.push({
      name: nameNode.text,
      startLine: cls.startPosition.row + 1,
      endLine: cls.endPosition.row + 1,
      methods,
      isExported: isNodeExported(cls),
      extends: extendsClause,
    });
  }

  return results;
}

function extractTSImports(root: SyntaxNode): ParsedImport[] {
  const results: ParsedImport[] = [];

  const importNodes = findAll(root, 'import_statement');
  for (const imp of importNodes) {
    // source field works reliably via childForFieldName in web-tree-sitter 0.22.6
    const sourceNode = imp.childForFieldName('source');
    if (!sourceNode) continue;

    // Strip surrounding quotes from string literal
    const rawSource = sourceNode.text;
    const source = rawSource.slice(1, -1);
    const isRelative = source.startsWith('.') || source.startsWith('/');
    const specifiers: string[] = [];

    // Use findFirst instead of childForFieldName — more reliable in 0.22.6
    const clause = findFirst(imp, 'import_clause');
    if (clause) {
      // Default import: import_clause contains a bare identifier
      const firstChild = clause.child(0);
      if (firstChild?.type === 'identifier') {
        specifiers.push('default');
      } else {
        // Named imports: import_clause → named_imports → import_specifier*
        const namedImports = findFirst(clause, 'named_imports');
        if (namedImports) {
          const specs = findAll(namedImports, 'import_specifier');
          for (const s of specs) {
            const name = s.childForFieldName('name');
            if (name) specifiers.push(name.text);
          }
        }
        // Namespace import: import * as foo
        const nsImport = findFirst(clause, 'namespace_import');
        if (nsImport) specifiers.push('*');
      }
    }

    results.push({
      source,
      specifiers,
      line: imp.startPosition.row + 1,
      isRelative,
    });
  }

  return results;
}

function extractTSExports(root: SyntaxNode): string[] {
  const exports: string[] = [];
  const exportStmts = findAll(root, 'export_statement');

  for (const stmt of exportStmts) {
    let hasDefault = false;
    for (let i = 0; i < stmt.childCount; i++) {
      if (stmt.child(i)?.text === 'default') {
        hasDefault = true;
        break;
      }
    }

    if (hasDefault) {
      exports.push('default');
      continue;
    }

    // Named export: export { foo, bar } or export function/class/const
    const namedExports = findFirst(stmt, 'export_clause');
    if (namedExports) {
      const specs = findAll(namedExports, 'export_specifier');
      for (const s of specs) {
        const name = s.childForFieldName('name');
        if (name) exports.push(name.text);
      }
      continue;
    }

    // export function/class/const/interface
    for (let i = 0; i < stmt.childCount; i++) {
      const child = stmt.child(i);
      if (!child?.isNamed) continue;

      if (
        child.type === 'function_declaration' ||
        child.type === 'class_declaration' ||
        child.type === 'interface_declaration' ||
        child.type === 'type_alias_declaration' ||
        child.type === 'enum_declaration'
      ) {
        const name = child.childForFieldName('name');
        if (name) exports.push(name.text);
      } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
        const declarators = findAll(child, 'variable_declarator');
        for (const d of declarators) {
          const name = d.childForFieldName('name');
          if (name) exports.push(name.text);
        }
      }
    }
  }

  return [...new Set(exports)];
}

// ---------------------------------------------------------------------------
// Python extraction
// ---------------------------------------------------------------------------

function extractPyParams(paramsNode: SyntaxNode | null): string[] {
  if (!paramsNode) return [];

  const params: string[] = [];
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child?.isNamed) continue;

    if (child.type === 'identifier') {
      if (child.text !== 'self' && child.text !== 'cls') {
        params.push(child.text);
      }
    } else if (
      child.type === 'typed_parameter' ||
      child.type === 'default_parameter' ||
      child.type === 'typed_default_parameter' ||
      child.type === 'list_splat_pattern' ||
      child.type === 'dictionary_splat_pattern'
    ) {
      // First named child is usually the identifier
      for (let j = 0; j < child.childCount; j++) {
        const sub = child.child(j);
        if (sub?.isNamed && sub.type === 'identifier') {
          if (sub.text !== 'self' && sub.text !== 'cls') {
            params.push(sub.text);
          }
          break;
        }
      }
    }
  }

  return params;
}

function extractPyFunctions(root: SyntaxNode): ParsedFunction[] {
  const results: ParsedFunction[] = [];

  const funcNodes = findAll(root, 'function_definition');
  for (const fn of funcNodes) {
    // Only top-level functions (parent is module)
    if (fn.parent?.type !== 'module') continue;

    const nameNode = fn.childForFieldName('name');
    if (!nameNode) continue;

    const paramsNode = fn.childForFieldName('parameters');

    results.push({
      name: nameNode.text,
      startLine: fn.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      params: extractPyParams(paramsNode),
      isExported: !nameNode.text.startsWith('_'),
    });
  }

  return results;
}

function extractPyClasses(root: SyntaxNode): ParsedClass[] {
  const results: ParsedClass[] = [];

  const classNodes = findAll(root, 'class_definition');
  for (const cls of classNodes) {
    const nameNode = cls.childForFieldName('name');
    if (!nameNode) continue;

    const superclasses = cls.childForFieldName('superclasses');
    let extendsClause: string | undefined;
    if (superclasses) {
      // Strip surrounding parens
      extendsClause = superclasses.text.replace(/^\(|\)$/g, '').trim() || undefined;
    }

    const body = cls.childForFieldName('body');
    const methods: string[] = [];
    if (body) {
      const methodNodes = findAll(body, 'function_definition');
      for (const m of methodNodes) {
        const mName = m.childForFieldName('name');
        if (mName) methods.push(mName.text);
      }
    }

    results.push({
      name: nameNode.text,
      startLine: cls.startPosition.row + 1,
      endLine: cls.endPosition.row + 1,
      methods,
      isExported: !nameNode.text.startsWith('_'),
      extends: extendsClause,
    });
  }

  return results;
}

function extractPyImports(root: SyntaxNode): ParsedImport[] {
  const results: ParsedImport[] = [];

  // import os / import os.path
  const importNodes = findAll(root, 'import_statement');
  for (const imp of importNodes) {
    const names = findAll(imp, 'dotted_name');
    for (const name of names) {
      const source = name.text.replace(/\./g, '/');
      results.push({
        source,
        specifiers: [],
        line: imp.startPosition.row + 1,
        isRelative: false,
      });
    }
  }

  // from pathlib import Path / from . import foo
  const fromNodes = findAll(root, 'import_from_statement');
  for (const imp of fromNodes) {
    const modNode = imp.childForFieldName('module_name');
    if (!modNode) continue;

    const source = modNode.text.replace(/\./g, '/');
    const isRelative = modNode.text.startsWith('.');

    // All dotted_name nodes except the first (which is the module)
    const names = findAll(imp, 'dotted_name').slice(1);
    const specifiers = names.map((n) => n.text);

    // Also check wildcard
    const wildcard = findFirst(imp, 'wildcard_import');
    if (wildcard) specifiers.push('*');

    results.push({
      source,
      specifiers,
      line: imp.startPosition.row + 1,
      isRelative,
    });
  }

  return results;
}

function extractPyExports(root: SyntaxNode): string[] {
  // Python has no explicit export syntax; we surface public names
  const exports: string[] = [];

  const funcs = findAll(root, 'function_definition').filter((f) => f.parent?.type === 'module');
  for (const fn of funcs) {
    const name = fn.childForFieldName('name');
    if (name && !name.text.startsWith('_')) exports.push(name.text);
  }

  const classes = findAll(root, 'class_definition').filter((c) => c.parent?.type === 'module');
  for (const cls of classes) {
    const name = cls.childForFieldName('name');
    if (name && !name.text.startsWith('_')) exports.push(name.text);
  }

  // __all__ list
  const assignments = findAll(root, 'assignment');
  for (const assign of assignments) {
    const left = assign.childForFieldName('left');
    if (left?.text === '__all__') {
      const right = assign.childForFieldName('right');
      if (right) {
        const strings = findAll(right, 'string');
        for (const s of strings) {
          const content = s.text.slice(1, -1);
          if (content) exports.push(content);
        }
      }
    }
  }

  return [...new Set(exports)];
}

// ---------------------------------------------------------------------------
// Generic extractor — used for Go, Rust, Java, Ruby, C, C++, PHP, C#, Swift, Kotlin
// ---------------------------------------------------------------------------

/**
 * Attempt to find a name identifier inside a node using common field names
 * and fallback strategies across different grammars.
 */
function resolveNodeName(node: SyntaxNode): string | null {
  // Try standard field names first
  const fieldNames = ['name', 'identifier'];
  for (const field of fieldNames) {
    const candidate = node.childForFieldName(field);
    if (
      candidate?.type === 'identifier' ||
      candidate?.type === 'type_identifier' ||
      candidate?.type === 'simple_identifier' ||
      candidate?.type === 'constant'
    ) {
      return candidate.text;
    }
  }

  // Go: type_declaration contains type_spec which has the actual type_identifier
  // Walk one level into named children looking for type_spec
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed && child.type === 'type_spec') {
      const name = resolveNodeName(child);
      if (name) return name;
    }
  }

  // Walk direct children looking for an identifier (type_identifier, constant, etc.)
  // Also includes field_identifier which Go uses for method receiver names.
  const identTypes = new Set([
    'identifier',
    'type_identifier',
    'simple_identifier',
    'constant',
    'field_identifier',
  ]);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed && identTypes.has(child.type)) {
      return child.text;
    }
  }

  return null;
}

function extractGenericFunctions(root: SyntaxNode, config: LanguageConfig): ParsedFunction[] {
  const results: ParsedFunction[] = [];

  for (const nodeType of config.nodeTypes.function) {
    const nodes = findAll(root, nodeType);
    for (const fn of nodes) {
      const name = resolveNodeName(fn);
      if (!name) continue;

      results.push({
        name,
        startLine: fn.startPosition.row + 1,
        endLine: fn.endPosition.row + 1,
        params: [], // param extraction is grammar-specific; omitted for generics
        isExported: true, // conservative default — caller can filter
      });
    }
  }

  return results;
}

function extractGenericClasses(root: SyntaxNode, config: LanguageConfig): ParsedClass[] {
  const results: ParsedClass[] = [];

  for (const nodeType of config.nodeTypes.class) {
    const nodes = findAll(root, nodeType);
    for (const cls of nodes) {
      const name = resolveNodeName(cls);
      if (!name) continue;

      // Collect method names using each language's function node types
      const methods: string[] = [];
      for (const fnType of config.nodeTypes.function) {
        const methodNodes = findAll(cls, fnType);
        for (const m of methodNodes) {
          const mName = resolveNodeName(m);
          if (mName) methods.push(mName);
        }
      }

      results.push({
        name,
        startLine: cls.startPosition.row + 1,
        endLine: cls.endPosition.row + 1,
        methods,
        isExported: true, // conservative default
      });
    }
  }

  return results;
}

/**
 * Extract the import source text from nodes that represent imports.
 * Each grammar stores the source in a different child — we try common patterns.
 */
function resolveImportSource(node: SyntaxNode): string | null {
  // Try field name 'path' (Go)
  const pathField = node.childForFieldName('path');
  if (pathField) return pathField.text.replace(/^["']|["']$/g, '');

  // Try field name 'source' (some grammars)
  const sourceField = node.childForFieldName('source');
  if (sourceField) return sourceField.text.replace(/^["']|["']$/g, '');

  // Walk children looking for a string literal or path
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'string_literal' ||
      child.type === 'raw_string_literal' ||
      child.type === 'string' ||
      child.type === 'scoped_identifier' ||
      child.type === 'qualified_identifier'
    ) {
      return child.text.replace(/^["']|["']$/g, '');
    }
    // Go: interpreted_string_literal wraps the path — strip surrounding quotes
    if (child.type === 'interpreted_string_literal') {
      return child.text.replace(/^"|"$/g, '');
    }
    // preproc_include uses system_lib_string or string_content
    if (child.type === 'system_lib_string') {
      // e.g. <stdio.h> — return content between angle brackets
      return child.text.replace(/^<|>$/g, '');
    }
    if (child.type === 'string_content') {
      return child.text;
    }
  }

  return null;
}

function extractGenericImports(root: SyntaxNode, config: LanguageConfig): ParsedImport[] {
  const results: ParsedImport[] = [];

  for (const nodeType of config.nodeTypes.import) {
    const nodes = findAll(root, nodeType);
    for (const imp of nodes) {
      const source = resolveImportSource(imp);
      if (!source) continue;

      // Strip surrounding angle brackets from C/C++ system includes
      const cleanSource = source.replace(/^<|>$/g, '');
      const isRelative = cleanSource.startsWith('.') || cleanSource.startsWith('/');

      results.push({
        source: cleanSource,
        specifiers: [],
        line: imp.startPosition.row + 1,
        isRelative,
      });
    }
  }

  return results;
}

/**
 * Export detection per language. For languages with explicit visibility modifiers
 * (Java, C#, Kotlin, Swift) we scan for `public` keywords. For others (Go, Rust,
 * Ruby) we use naming conventions or presence rules.
 */
function extractGenericExports(
  root: SyntaxNode,
  config: LanguageConfig,
  language: SupportedLanguage,
): string[] {
  const exports: string[] = [];

  const allNodeTypes = [...config.nodeTypes.function, ...config.nodeTypes.class];

  for (const nodeType of allNodeTypes) {
    const nodes = findAll(root, nodeType);
    for (const node of nodes) {
      const name = resolveNodeName(node);
      if (!name) continue;

      const exported = isGenericNodeExported(node, name, language);
      if (exported) exports.push(name);
    }
  }

  return [...new Set(exports)];
}

/**
 * Determine whether a node is exported according to its language's conventions.
 */
function isGenericNodeExported(
  node: SyntaxNode,
  name: string,
  language: SupportedLanguage,
): boolean {
  switch (language) {
    case 'go':
      // Go: exported if first character is uppercase
      return (
        name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()
      );

    case 'rust': {
      // Rust: the `pub` keyword appears as a `visibility_modifier` direct child
      // of function_item / struct_item / enum_item. Check direct children.
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === 'visibility_modifier') return true;
        // Also accept bare 'pub' text node (anonymous)
        if (child.text === 'pub') return true;
      }
      return false;
    }

    case 'ruby':
      // Ruby: public by default (no private/protected keyword on this node)
      return !name.startsWith('_');

    case 'java':
    case 'csharp':
    case 'kotlin':
    case 'swift':
    case 'php': {
      // Look for `public` modifier in direct children
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.text === 'public') return true;
      }
      // Also check modifiers field
      const modifiers = node.childForFieldName('modifiers');
      if (modifiers) {
        for (let i = 0; i < modifiers.childCount; i++) {
          if (modifiers.child(i)?.text === 'public') return true;
        }
      }
      return false;
    }

    case 'c':
    case 'cpp':
      // C/C++: no export mechanism at grammar level — treat all definitions as exported
      return true;

    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getSupportedLanguages(): Promise<string[]> {
  return Object.keys(LANGUAGE_CONFIGS);
}

export async function parseFile(filePath: string): Promise<ParsedFile | null> {
  const ext = extname(filePath).toLowerCase();
  const language = EXTENSION_TO_LANGUAGE[ext];

  if (!language) return null;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const entry = await getParser(language);
  if (!entry) return null;

  let tree: TreeSitterTree;
  try {
    tree = entry.parser.parse(content);
  } catch {
    return null;
  }

  // web-tree-sitter Trees are backed by WASM linear memory that V8's GC does
  // not reclaim deterministically: parse() must be paired with delete(), or
  // memory grows roughly linearly with every file parsed (confirmed root
  // cause of the `graph` command's multi-GB RAM spike when a scanned project
  // hits the MAX_FILES cap in code-scanner.ts). Extraction below only reads
  // primitive data (strings/numbers) out of the tree, so it is always safe
  // to free the tree once extraction — success or failure — is done.
  try {
    const root = tree.rootNode;
    const lineCount = content.split('\n').length;

    const isTS = language === 'typescript' || language === 'tsx' || language === 'javascript';
    const isPython = language === 'python';

    let functions: ParsedFunction[];
    let classes: ParsedClass[];
    let bindings: ParsedBinding[] = [];
    let imports: ParsedImport[];
    let exports: string[];

    if (isTS) {
      functions = extractTSFunctions(root);
      classes = extractTSClasses(root);
      bindings = extractTSBindings(root);
      imports = extractTSImports(root);
      exports = extractTSExports(root);
    } else if (isPython) {
      functions = extractPyFunctions(root);
      classes = extractPyClasses(root);
      imports = extractPyImports(root);
      exports = extractPyExports(root);
    } else {
      // Generic extractor for all other languages (Go, Rust, Java, Ruby, C, C++, PHP, C#, Swift, Kotlin)
      const config = LANGUAGE_CONFIGS[language];
      functions = extractGenericFunctions(root, config);
      classes = extractGenericClasses(root, config);
      imports = extractGenericImports(root, config);
      exports = extractGenericExports(root, config, language);
    }

    // Attach JSDoc + head/tail body from the source we already read. Cheap
    // (string slice, no second parse). Bindings are TS-only today because
    // that is where the 24-q coverage hole actually lived.
    const withExcerpts = <T extends { startLine: number; endLine: number }>(items: T[]) =>
      items.map((item) => attachExcerpt(content, item));

    return {
      path: filePath,
      language,
      lineCount,
      functions: withExcerpts(functions),
      classes: withExcerpts(classes),
      bindings: withExcerpts(bindings),
      imports,
      exports,
    };
  } finally {
    if (tree && typeof tree.delete === 'function') {
      tree.delete();
    }
  }
}
