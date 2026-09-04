/* languageRegistry.ts — Central registry mapping file extensions to
   tree-sitter grammar names and node-type patterns for symbol extraction.

   Supports 30+ languages out of the box using tree-sitter-wasms.
   Custom languages can be added via a TOML config file at
   .code-review-graph/languages.toml (same schema as CRG).
*/

// ── Language config ───────────────────────────────────────────────

export interface LanguageConfig {
  /** File extensions (without leading dot). */
  extensions: string[];
  /** Tree-sitter grammar name (matches the WASM filename). */
  grammar: string;
  /** Node types that represent function definitions. */
  functionNodeTypes: string[];
  /** Node types that represent class/struct/type definitions. */
  classNodeTypes: string[];
  /** Node types that represent import statements. */
  importNodeTypes: string[];
  /** Node types that represent function calls. */
  callNodeTypes: string[];
  /** Node types that represent method definitions (inside classes). */
  methodNodeTypes?: string[];
  /** Node types that represent interface/trait/protocol definitions. */
  interfaceNodeTypes?: string[];
  /** Node types that represent enum definitions. */
  enumNodeTypes?: string[];
  /** Node types that represent export statements. */
  exportNodeTypes?: string[];
  /** Route pattern regex (for API route detection, if applicable). */
  routePattern?: RegExp;
  /** ORM query pattern regex (if applicable). */
  ormPattern?: RegExp;
}

// ── Built-in languages (30+) ──────────────────────────────────────

export const BUILTIN_LANGUAGES: LanguageConfig[] = [
  {
    extensions: ['ts'],
    grammar: 'typescript',
    functionNodeTypes: ['function_declaration', 'method_definition', 'arrow_function', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
    importNodeTypes: ['import_statement'],
    callNodeTypes: ['call_expression'],
    methodNodeTypes: ['method_definition'],
    interfaceNodeTypes: ['interface_declaration'],
    enumNodeTypes: ['enum_declaration'],
    exportNodeTypes: ['export_statement'],
    routePattern: /(?:app|router|fastify)\.(get|post|put|delete|patch|use)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    ormPattern: /(?:prisma|supabase)\.(?:\w+)\.(findMany|findUnique|create|update|delete|upsert|aggregate)\s*\(/g,
  },
  {
    extensions: ['tsx'],
    grammar: 'tsx',
    functionNodeTypes: ['function_declaration', 'method_definition', 'arrow_function', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
    importNodeTypes: ['import_statement'],
    callNodeTypes: ['call_expression'],
    methodNodeTypes: ['method_definition'],
    interfaceNodeTypes: ['interface_declaration'],
    enumNodeTypes: ['enum_declaration'],
    exportNodeTypes: ['export_statement'],
    routePattern: /(?:app|router|fastify)\.(get|post|put|delete|patch|use)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    ormPattern: /(?:prisma|supabase)\.(?:\w+)\.(findMany|findUnique|create|update|delete|upsert|aggregate)\s*\(/g,
  },
  {
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    grammar: 'javascript',
    functionNodeTypes: ['function_declaration', 'method_definition', 'arrow_function', 'generator_function_declaration'],
    classNodeTypes: ['class_declaration'],
    importNodeTypes: ['import_statement'],
    callNodeTypes: ['call_expression'],
    methodNodeTypes: ['method_definition'],
    exportNodeTypes: ['export_statement'],
    routePattern: /(?:app|router|fastify)\.(get|post|put|delete|patch|use)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    ormPattern: /(?:prisma|supabase)\.(?:\w+)\.(findMany|findUnique|create|update|delete|upsert)\s*\(/g,
  },
  {
    extensions: ['py'],
    grammar: 'python',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['class_definition'],
    importNodeTypes: ['import_statement', 'import_from_statement'],
    callNodeTypes: ['call'],
    methodNodeTypes: ['function_definition'],
    routePattern: /@(app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g,
    ormPattern: /(?:objects)\.(?:filter|get|create|update|delete|all)\s*\(/g,
  },
  {
    extensions: ['rs'],
    grammar: 'rust',
    functionNodeTypes: ['function_item', 'function_signature_item'],
    classNodeTypes: ['struct_item', 'enum_item', 'union_item'],
    importNodeTypes: ['use_declaration'],
    callNodeTypes: ['call_expression', 'macro_invocation'],
    interfaceNodeTypes: ['trait_item'],
    enumNodeTypes: ['enum_item'],
  },
  {
    extensions: ['go'],
    grammar: 'go',
    functionNodeTypes: ['function_declaration', 'method_declaration'],
    classNodeTypes: ['type_declaration'],
    importNodeTypes: ['import_declaration'],
    callNodeTypes: ['call_expression'],
    routePattern: /(?:r|router|mux)\.(GET|POST|PUT|DELETE|PATCH|HandleFunc)\s*\(\s*['"`]([^'"`]+)['"`]/g,
  },
  {
    extensions: ['java'],
    grammar: 'java',
    functionNodeTypes: ['method_declaration', 'constructor_declaration'],
    classNodeTypes: ['class_declaration'],
    importNodeTypes: ['import_declaration'],
    callNodeTypes: ['method_invocation'],
    interfaceNodeTypes: ['interface_declaration'],
    enumNodeTypes: ['enum_declaration'],
    routePattern: /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?['"`]([^'"`]+)['"`]/g,
    ormPattern: /(?:repository|entityManager)\.(?:save|findById|findAll|delete|update)\s*\(/g,
  },
  {
    extensions: ['kt', 'kts'],
    grammar: 'kotlin',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration'],
    importNodeTypes: ['import_header'],
    callNodeTypes: ['call_expression'],
    interfaceNodeTypes: ['interface_declaration'],
    enumNodeTypes: ['enum_class_body'],
  },
  {
    extensions: ['rb'],
    grammar: 'ruby',
    functionNodeTypes: ['method', 'singleton_method'],
    classNodeTypes: ['class', 'module'],
    importNodeTypes: ['call'],
    callNodeTypes: ['call', 'command', 'command_call'],
    routePattern: /(?:get|post|put|delete|patch)\s+['"`]([^'"`]+)['"`]/g,
  },
  {
    extensions: ['c', 'h'],
    grammar: 'c',
    functionNodeTypes: ['function_definition', 'function_declaration'],
    classNodeTypes: ['struct_specifier', 'enum_specifier', 'union_specifier'],
    importNodeTypes: ['preproc_include'],
    callNodeTypes: ['call_expression'],
  },
  {
    extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hxx'],
    grammar: 'cpp',
    functionNodeTypes: ['function_definition', 'function_declaration'],
    classNodeTypes: ['class_specifier', 'struct_specifier', 'enum_specifier'],
    importNodeTypes: ['preproc_include', 'using_declaration'],
    callNodeTypes: ['call_expression'],
  },
  {
    extensions: ['cs'],
    grammar: 'c_sharp',
    functionNodeTypes: ['method_declaration', 'constructor_declaration'],
    classNodeTypes: ['class_declaration', 'struct_declaration', 'record_declaration'],
    importNodeTypes: ['using_directive'],
    callNodeTypes: ['invocation_expression'],
    interfaceNodeTypes: ['interface_declaration'],
    enumNodeTypes: ['enum_declaration'],
  },
  {
    extensions: ['swift'],
    grammar: 'swift',
    functionNodeTypes: ['function_declaration'],
    classNodeTypes: ['class_declaration', 'struct_declaration'],
    importNodeTypes: ['import_declaration'],
    callNodeTypes: ['call_expression'],
    interfaceNodeTypes: ['protocol_declaration'],
    enumNodeTypes: ['enum_declaration'],
  },
  {
    extensions: ['php'],
    grammar: 'php',
    functionNodeTypes: ['function_definition', 'method_declaration'],
    classNodeTypes: ['class_declaration'],
    importNodeTypes: ['namespace_use_declaration'],
    callNodeTypes: ['function_call_expression'],
    interfaceNodeTypes: ['interface_declaration'],
  },
  {
    extensions: ['scala', 'sc'],
    grammar: 'scala',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['class_definition', 'object_definition'],
    importNodeTypes: ['import_declaration'],
    callNodeTypes: ['call_expression'],
    interfaceNodeTypes: ['trait_definition'],
  },
  {
    extensions: ['sol'],
    grammar: 'solidity',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['contract_declaration', 'library_declaration', 'interface_declaration'],
    importNodeTypes: ['import_directive'],
    callNodeTypes: ['function_call'],
  },
  {
    extensions: ['dart'],
    grammar: 'dart',
    functionNodeTypes: ['function_signature', 'method_signature'],
    classNodeTypes: ['class_definition'],
    importNodeTypes: ['import_or_export'],
    callNodeTypes: ['call_expression'],
    interfaceNodeTypes: ['interface_declaration'],
    enumNodeTypes: ['enum_declaration'],
  },
  {
    extensions: ['lua'],
    grammar: 'lua',
    functionNodeTypes: ['function_declaration', 'function_definition'],
    classNodeTypes: ['function_definition'],
    importNodeTypes: ['function_call'],
    callNodeTypes: ['function_call'],
  },
  {
    extensions: ['el', 'erl'],
    grammar: 'erlang',
    functionNodeTypes: ['function_clause'],
    classNodeTypes: ['record_decl'],
    importNodeTypes: ['import_attribute'],
    callNodeTypes: ['call'],
  },
  {
    extensions: ['ex', 'exs'],
    grammar: 'elixir',
    functionNodeTypes: ['function_clause', 'call'],
    classNodeTypes: ['call'],
    importNodeTypes: ['alias'],
    callNodeTypes: ['call'],
  },
  {
    extensions: ['zig'],
    grammar: 'zig',
    functionNodeTypes: ['FunctionDecl'],
    classNodeTypes: ['VarDecl', 'ContainerDecl'],
    importNodeTypes: ['ImportStatement'],
    callNodeTypes: ['CallExpr'],
  },
  {
    extensions: ['sh', 'bash'],
    grammar: 'bash',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: [],
    importNodeTypes: ['command'],
    callNodeTypes: ['command'],
  },
  {
    extensions: ['vue'],
    grammar: 'vue',
    functionNodeTypes: ['function_declaration', 'method_definition'],
    classNodeTypes: ['class_declaration'],
    importNodeTypes: ['import_statement'],
    callNodeTypes: ['call_expression'],
  },
  {
    extensions: ['rescript', 'res'],
    grammar: 'rescript',
    functionNodeTypes: ['function_definition'],
    classNodeTypes: ['type_declaration'],
    importNodeTypes: ['import'],
    callNodeTypes: ['call_expression'],
  },
  {
    extensions: ['yaml', 'yml'],
    grammar: 'yaml',
    functionNodeTypes: [],
    classNodeTypes: [],
    importNodeTypes: [],
    callNodeTypes: [],
  },
  {
    extensions: ['toml'],
    grammar: 'toml',
    functionNodeTypes: [],
    classNodeTypes: [],
    importNodeTypes: [],
    callNodeTypes: [],
  },
  {
    extensions: ['json'],
    grammar: 'json',
    functionNodeTypes: [],
    classNodeTypes: [],
    importNodeTypes: [],
    callNodeTypes: [],
  },
  {
    extensions: ['html', 'htm'],
    grammar: 'html',
    functionNodeTypes: [],
    classNodeTypes: [],
    importNodeTypes: [],
    callNodeTypes: [],
  },
  {
    extensions: ['css'],
    grammar: 'css',
    functionNodeTypes: [],
    classNodeTypes: [],
    importNodeTypes: ['import_statement'],
    callNodeTypes: [],
  },
  {
    extensions: ['ocaml', 'ml'],
    grammar: 'ocaml',
    functionNodeTypes: ['value_definition'],
    classNodeTypes: ['type_definition'],
    importNodeTypes: ['include'],
    callNodeTypes: ['application_expression'],
  },
  {
    extensions: ['ql'],
    grammar: 'ql',
    functionNodeTypes: ['predicate_definition'],
    classNodeTypes: ['classlessPredicate'],
    importNodeTypes: ['import'],
    callNodeTypes: ['call'],
  },
  {
    extensions: ['elm'],
    grammar: 'elm',
    functionNodeTypes: ['value_declaration'],
    classNodeTypes: ['type_declaration'],
    importNodeTypes: ['import_clause'],
    callNodeTypes: ['call_expr'],
  },
];

// ── Lookup maps ───────────────────────────────────────────────────

const EXTENSION_MAP = new Map<string, LanguageConfig>();

for (const config of BUILTIN_LANGUAGES) {
  for (const ext of config.extensions) {
    EXTENSION_MAP.set(ext.toLowerCase(), config);
  }
}

/** Get the language config for a file by its extension. */
export function getLanguageConfig(filePath: string): LanguageConfig | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MAP.get(ext) ?? null;
}

/** Get all supported file extensions. */
export function getSupportedExtensions(): string[] {
  return Array.from(EXTENSION_MAP.keys());
}

/** Check if a file is supported by tree-sitter. */
export function isSupportedFile(filePath: string): boolean {
  return EXTENSION_MAP.has(filePath.split('.').pop()?.toLowerCase() ?? '');
}

// ── Custom language support (TOML) ────────────────────────────────

export interface CustomLanguageEntry {
  extensions: string[];
  grammar: string;
  function_node_types: string[];
  class_node_types: string[];
  import_node_types: string[];
  call_node_types: string[];
  method_node_types?: string[];
  interface_node_types?: string[];
  enum_node_types?: string[];
}

/**
 * Register custom languages from a parsed TOML config.
 * The TOML format matches CRG's languages.toml:
 *
 *   [languages.erlang]
 *   extensions = [".erl"]
 *   grammar = "erlang"
 *   function_node_types = ["function_clause"]
 *   class_node_types = ["record_decl"]
 *   import_node_types = ["import_attribute"]
 *   call_node_types = ["call"]
 */
export function registerCustomLanguages(entries: CustomLanguageEntry[]): void {
  for (const entry of entries) {
    const config: LanguageConfig = {
      extensions: entry.extensions.map(e => e.replace(/^\./, '')),
      grammar: entry.grammar,
      functionNodeTypes: entry.function_node_types,
      classNodeTypes: entry.class_node_types,
      importNodeTypes: entry.import_node_types,
      callNodeTypes: entry.call_node_types,
      methodNodeTypes: entry.method_node_types,
      interfaceNodeTypes: entry.interface_node_types,
      enumNodeTypes: entry.enum_node_types,
    };
    for (const ext of config.extensions) {
      // Built-in languages cannot be overridden
      if (!EXTENSION_MAP.has(ext.toLowerCase())) {
        EXTENSION_MAP.set(ext.toLowerCase(), config);
      }
    }
  }
}

/**
 * Parse a simple TOML config string into CustomLanguageEntry[].
 * This is a minimal TOML parser for the languages.toml format —
 * it handles [section] headers and key = value pairs with arrays.
 */
export function parseLanguagesToml(toml: string): CustomLanguageEntry[] {
  const entries: CustomLanguageEntry[] = [];
  let current: Partial<CustomLanguageEntry> | null = null;

  for (const line of toml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section header: [languages.xxx]
    const sectionMatch = trimmed.match(/^\[languages\.(\w+)\]/);
    if (sectionMatch) {
      if (current) entries.push(current as CustomLanguageEntry);
      current = {};
      continue;
    }

    if (!current) continue;

    // key = value
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    // Array value: ["a", "b"]
    const arrayMatch = value.match(/^\[(.*)\]$/);
    if (arrayMatch) {
      const items = arrayMatch[1]
        .split(',')
        .map(s => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      (current as Record<string, unknown>)[key] = items;
    } else {
      // String value
      (current as Record<string, unknown>)[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  if (current) entries.push(current as CustomLanguageEntry);
  return entries;
}

// ── WASM path resolution ──────────────────────────────────────────

/** Base path for tree-sitter WASM grammar files. */
export const TREE_SITTER_WASM_BASE = '/tree-sitter-wasms/';

/** Get the WASM URL for a grammar name. */
export function grammarWasmUrl(grammar: string): string {
  return `${TREE_SITTER_WASM_BASE}tree-sitter-${grammar}.wasm`;
}
