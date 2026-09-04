/* Block preservation.
   Extracts and protects code blocks, URLs, paths, identifiers, etc. before
   prose compression, then restores them byte-perfect afterwards. */

export interface PreservedBlock {
  placeholder: string;
  content: string;
  kind: string;
}

export interface PreservationOptions {
  preservePatterns?: Array<string | RegExp>;
}

interface CompiledPattern {
  pattern: RegExp;
  kind: string;
}

const SENTINEL_PREFIX = '\u0000LAZY_CAVEMAN';

function randomSentinelSeed(): string {
  const bytes = new Uint8Array(8);
  const cryptoLike = globalThis.crypto;
  if (cryptoLike?.getRandomValues) {
    cryptoLike.getRandomValues(bytes);
    return `r${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  return `r${Math.random().toString(36).slice(2)}`;
}

function ensureGlobal(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function compileUserPatterns(patterns: Array<string | RegExp> | undefined): CompiledPattern[] {
  if (!patterns?.length) return [];
  const compiled: CompiledPattern[] = [];
  for (const pattern of patterns) {
    try {
      compiled.push({
        pattern: typeof pattern === 'string' ? new RegExp(pattern, 'g') : ensureGlobal(pattern),
        kind: 'custom',
      });
    } catch {
      // Invalid user regexes are ignored
    }
  }
  return compiled;
}

function replacePattern(
  text: string,
  pattern: RegExp,
  kind: string,
  addBlock: (content: string, kind: string) => string,
): string {
  pattern.lastIndex = 0;
  return text.replace(pattern, (match) => {
    if (!match) return match;
    if (match.includes(SENTINEL_PREFIX)) return match;
    return addBlock(match, kind);
  });
}

/** Extract fenced code blocks (``` and ~~~) and replace with placeholders. */
function extractFencedCodeBlocks(
  text: string,
  addBlock: (content: string, kind: string) => string,
): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (match) => addBlock(match, 'fenced_code'));
}

/** Extract YAML/TOML frontmatter. */
function extractFrontmatter(
  text: string,
  addBlock: (content: string, kind: string) => string,
): string {
  return text.replace(/^---\n[\s\S]*?\n---/m, (match) => addBlock(match, 'frontmatter'));
}

export function extractPreservedBlocks(
  text: string,
  options: PreservationOptions = {},
): { text: string; blocks: PreservedBlock[] } {
  const blocks: PreservedBlock[] = [];
  const seed = randomSentinelSeed();
  let counter = 0;

  const addBlock = (content: string, kind: string): string => {
    const placeholder = `${SENTINEL_PREFIX}_${seed}_${counter}\u0000`;
    blocks.push({ placeholder, content, kind });
    counter++;
    return placeholder;
  };

  let result = text;

  result = extractFrontmatter(result, addBlock);
  result = extractFencedCodeBlocks(result, (content) => addBlock(content, 'fenced_code'));

  const builtIns: CompiledPattern[] = [
    { pattern: /\$\$[\s\S]*?\$\$/g, kind: 'math_block' },
    { pattern: /\\\[[\s\S]*?\\\]/g, kind: 'math_block' },
    {
      pattern: /(?<!\$)\$(?![\s$\d])(?:\\.|[^$\n\\]){1,160}?(?<!\s)\$(?!\$)/g,
      kind: 'math_inline',
    },
    { pattern: /\\begin\{[A-Za-z*]+\}[\s\S]*?\\end\{[A-Za-z*]+\}/g, kind: 'latex_block' },
    { pattern: /^#{1,6}\s+.+$/gm, kind: 'markdown_heading' },
    { pattern: /^\s*\|.*\|\s*$/gm, kind: 'markdown_table' },
    { pattern: /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, kind: 'markdown_table' },
    { pattern: /`[^`\n]+`/g, kind: 'inline_code' },
    { pattern: /\[[^\]\n]+\]\([^) \n]+(?:\s+"[^"]*")?\)/g, kind: 'markdown_link' },
    { pattern: /\bhttps?:\/\/[^\s)"'>]+/gi, kind: 'url' },
    { pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, kind: 'const_case' },
    { pattern: /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b/g, kind: 'env_var' },
    { pattern: /\$[A-Z_][A-Z0-9_]*\b/g, kind: 'env_var' },
    { pattern: /\b\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?\b/g, kind: 'version' },
    { pattern: /\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\(\)?/g, kind: 'dotted_identifier' },
    { pattern: /\b[A-Za-z_$][\w$]*\s*\([^()\n]*\)/g, kind: 'function_call' },
    {
      pattern: /(?:^|\s)(?:\.{0,2}\/[A-Za-z0-9_@./-]+|[A-Za-z]:\\[A-Za-z0-9_.\\/-]+)/g,
      kind: 'file_path',
    },
    {
      pattern: /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|Error|Exception):[^\n]+/g,
      kind: 'error_message',
    },
  ];

  for (const { pattern, kind } of builtIns) {
    result = replacePattern(result, pattern, kind, addBlock);
  }

  for (const { pattern, kind } of compileUserPatterns(options.preservePatterns)) {
    result = replacePattern(result, pattern, kind, addBlock);
  }

  return { text: result, blocks };
}

/** Restore preserved blocks back into the text, replacing placeholders. */
export function restorePreservedBlocks(text: string, blocks: PreservedBlock[]): string {
  let result = text;
  for (const block of blocks) {
    // Use split/join to avoid $-interpretation in replacement string
    result = result.split(block.placeholder).join(block.content);
  }
  return result;
}

/** Quick check whether text contains protected structures (fast pre-filter). */
const PROTECTED_STRUCTURE_PREFILTER_RE = /[`~[\]|$#\\/:_()0-9]/;

const PROTECTED_STRUCTURE_RE =
  /```|~~~|`|https?:\/\/|\[[^\]\n]{1,1000}\]\([^)[ \t\n]{1,2000}(?:[ \t]+"[^"]{0,1000}")?\)|^#{1,6}\s+|^[ \t]*\|(?:[^|\n]{0,1000}\|){1,100}[ \t]*$|\$\$|\\\[|\\begin\{|^\s*#(?:set|show|let|import|include)\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\b|\$[A-Z_][A-Z0-9_]*\b|\b\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?\b|\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+\(\)?|\b[A-Za-z_$][\w$]*[ \t]*\([^()\n]{0,1000}\)|(?:^|\s)(?:\.{0,2}\/[A-Za-z0-9_@./-]+|[A-Za-z]:\\[A-Za-z0-9_.\\/-]+)|\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|Error|Exception):[^\n]{0,1000}/im;

export function hasProtectedStructure(text: string): boolean {
  if (!PROTECTED_STRUCTURE_PREFILTER_RE.test(text)) return false;
  PROTECTED_STRUCTURE_RE.lastIndex = 0;
  return PROTECTED_STRUCTURE_RE.test(text);
}
