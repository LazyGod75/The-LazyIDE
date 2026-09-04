import { describe, it, expect } from 'vitest';
import {
  getLanguageConfig,
  getSupportedExtensions,
  isSupportedFile,
  parseLanguagesToml,
  registerCustomLanguages,
  BUILTIN_LANGUAGES,
} from '../lib/codegraph/languageRegistry';
import {
  estimateTokens,
  computeSavings,
  estimateCorpusSize,
  estimateCorpusSizeFromNodes,
  wrapResultWithSavings,
} from '../lib/codegraph/tokenSavings';
import { sha256, createFileHashStore, diffFileHashes } from '../lib/codegraph/fileHash';

// ── Language registry ────────────────────────────────────────────

describe('languageRegistry', () => {
  it('supports 30+ languages', () => {
    expect(BUILTIN_LANGUAGES.length).toBeGreaterThanOrEqual(30);
  });

  it('getLanguageConfig returns config for TypeScript', () => {
    const config = getLanguageConfig('src/main.ts');
    expect(config).not.toBeNull();
    expect(config!.grammar).toBe('typescript');
    expect(config!.functionNodeTypes).toContain('function_declaration');
  });

  it('getLanguageConfig returns config for Python', () => {
    const config = getLanguageConfig('app/main.py');
    expect(config).not.toBeNull();
    expect(config!.grammar).toBe('python');
  });

  it('getLanguageConfig returns config for Rust', () => {
    const config = getLanguageConfig('src/main.rs');
    expect(config).not.toBeNull();
    expect(config!.grammar).toBe('rust');
  });

  it('getLanguageConfig returns null for unsupported file', () => {
    const config = getLanguageConfig('README.txt');
    expect(config).toBeNull();
  });

  it('isSupportedFile correctly identifies supported files', () => {
    expect(isSupportedFile('main.ts')).toBe(true);
    expect(isSupportedFile('main.py')).toBe(true);
    expect(isSupportedFile('main.go')).toBe(true);
    expect(isSupportedFile('main.txt')).toBe(false);
  });

  it('getSupportedExtensions returns a non-empty array', () => {
    const exts = getSupportedExtensions();
    expect(exts.length).toBeGreaterThan(20);
    expect(exts).toContain('ts');
    expect(exts).toContain('py');
  });

  it('parseLanguagesToml parses a simple TOML config', () => {
    const toml = `
[languages.erlang]
extensions = [".erl"]
grammar = "erlang"
function_node_types = ["function_clause"]
class_node_types = ["record_decl"]
import_node_types = ["import_attribute"]
call_node_types = ["call"]
`;
    const entries = parseLanguagesToml(toml);
    expect(entries).toHaveLength(1);
    expect(entries[0].extensions).toEqual(['.erl']);
    expect(entries[0].grammar).toBe('erlang');
    expect(entries[0].function_node_types).toEqual(['function_clause']);
  });

  it('registerCustomLanguages adds new language support', () => {
    const entries = [{
      extensions: ['.xyz'],
      grammar: 'xyz',
      function_node_types: ['func_def'],
      class_node_types: ['type_def'],
      import_node_types: ['import'],
      call_node_types: ['call'],
    }];
    registerCustomLanguages(entries);
    const config = getLanguageConfig('test.xyz');
    expect(config).not.toBeNull();
    expect(config!.grammar).toBe('xyz');
  });

  it('registerCustomLanguages does not override built-in languages', () => {
    const entries = [{
      extensions: ['.ts'],
      grammar: 'custom',
      function_node_types: ['custom_func'],
      class_node_types: [],
      import_node_types: [],
      call_node_types: [],
    }];
    registerCustomLanguages(entries);
    const config = getLanguageConfig('test.ts');
    expect(config!.grammar).toBe('typescript'); // Not overridden
  });
});

// ── Token savings ────────────────────────────────────────────────

describe('tokenSavings', () => {
  it('estimateTokens returns reasonable estimates', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    // ~4 chars per token for code
    const code = 'function foo() { return 42; }';
    const tokens = estimateTokens(code);
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(15);
  });

  it('computeSavings calculates correct savings', () => {
    const savings = computeSavings(10000, 'small result text');
    expect(savings.baselineTokens).toBe(10000);
    expect(savings.graphTokens).toBeGreaterThan(0);
    expect(savings.savedTokens).toBeGreaterThan(0);
    expect(savings.reductionFactor).toBeGreaterThan(1);
    expect(savings.summary).toContain('Token Savings');
  });

  it('estimateCorpusSize sums file tokens', () => {
    const files = new Map([
      ['a.ts', 'const x = 1;'],
      ['b.ts', 'const y = 2;'],
    ]);
    const size = estimateCorpusSize(files);
    expect(size).toBeGreaterThan(0);
  });

  it('estimateCorpusSizeFromNodes estimates from node count', () => {
    const size = estimateCorpusSizeFromNodes(100);
    expect(size).toBe(20000); // 100 * 200
  });

  it('wrapResultWithSavings appends savings info', () => {
    const result = wrapResultWithSavings('query results here', 50000);
    expect(result).toContain('query results here');
    expect(result).toContain('Token Savings');
  });
});

// ── File hashing ─────────────────────────────────────────────────

describe('fileHash', () => {
  it('sha256 produces consistent hashes', async () => {
    const hash1 = await sha256('hello world');
    const hash2 = await sha256('hello world');
    const hash3 = await sha256('hello world!');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it('sha256 returns hex string', async () => {
    const hash = await sha256('test');
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('createFileHashStore returns empty store', () => {
    const store = createFileHashStore();
    expect(store.hashes.size).toBe(0);
    expect(store.updatedAt).toBe(0);
  });

  it('diffFileHashes detects changed files', async () => {
    const store = createFileHashStore();
    // Initial state: store has fileA with old hash
    store.hashes.set('a.ts', await sha256('old content'));

    const currentFiles = new Map([
      ['a.ts', 'new content'],
      ['b.ts', 'new file'],
    ]);

    const diff = await diffFileHashes(store, currentFiles);
    expect(diff.changed).toContain('a.ts');
    expect(diff.changed).toContain('b.ts');
    expect(diff.unchanged).toHaveLength(0);
  });

  it('diffFileHashes detects unchanged files', async () => {
    const store = createFileHashStore();
    const content = 'same content';
    store.hashes.set('a.ts', await sha256(content));

    const currentFiles = new Map([['a.ts', content]]);
    const diff = await diffFileHashes(store, currentFiles);
    expect(diff.unchanged).toContain('a.ts');
    expect(diff.changed).toHaveLength(0);
  });

  it('diffFileHashes detects deleted files', async () => {
    const store = createFileHashStore();
    store.hashes.set('deleted.ts', 'somehash');

    const currentFiles = new Map<string, string>();
    const diff = await diffFileHashes(store, currentFiles);
    expect(diff.deleted).toContain('deleted.ts');
  });
});
