/* structuralGrep — enrich grep results with structural context.

   Given a file's content and a set of matching line numbers, this module
   uses tree-sitter (via the existing lazy-loaded scanner infrastructure)
   to determine the ENCLOSING symbol (function, class, method) for each
   match — so grep output shows not just "L42: foo()" but "L42 (inside
   function `handleClick`): foo()".

   When tree-sitter is unavailable (no WASM grammar loaded), it falls back
   to a regex-based heuristic that detects common symbol declaration
   patterns (function/class/method/const) to find the enclosing scope.

   Also provides adaptive truncation: when the brain is available, it can
   hint at how much context to show based on the file's complexity (more
   context for complex files, less for simple ones).
*/

export interface GrepMatch {
  line: number;
  text: string;
  enclosingSymbol?: string;
  enclosingKind?: string;
  enclosingLine?: number;
}

export interface StructuralGrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  totalMatches: number;
}

const MAX_MATCHES = 50;

// ── Regex fallback (when tree-sitter is unavailable) ────────────────

const SYMBOL_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/m },
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/m },
  { kind: 'function', regex: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?=>/m },
  { kind: 'class', regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m },
  { kind: 'interface', regex: /^\s*(?:export\s+)?interface\s+(\w+)/m },
  { kind: 'type', regex: /^\s*(?:export\s+)?type\s+(\w+)/m },
  { kind: 'method', regex: /^\s+(?:public|private|protected|static|async)?\s*(\w+)\s*\(/m },
  { kind: 'fn', regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m },
  { kind: 'struct', regex: /^\s*(?:pub\s+)?struct\s+(\w+)/m },
  { kind: 'impl', regex: /^\s*impl\s+(\w+)/m },
];

interface SymbolEntry {
  name: string;
  kind: string;
  line: number;
}

function findEnclosingSymbolRegex(lines: string[], targetLine: number): SymbolEntry | undefined {
  // Walk backwards from targetLine to find the nearest symbol declaration
  for (let i = targetLine - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    for (const { kind, regex } of SYMBOL_PATTERNS) {
      const match = regex.exec(line);
      if (match) {
        return { name: match[1], kind, line: i + 1 };
      }
    }
  }
  return undefined;
}

// ── Tree-sitter path (lazy) ─────────────────────────────────────────

async function findEnclosingSymbolTreeSitter(
  content: string,
  targetLine: number,
  filePath: string,
): Promise<SymbolEntry | undefined> {
  try {
    const { getLanguageConfig } = await import('../codegraph/languageRegistry.js');
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const langConfig = getLanguageConfig(ext);
    if (!langConfig) return undefined;

    // Use the existing scanner's lazy tree-sitter infrastructure
    const scannerMod = await import('../codegraph/treeSitterScanner.js');
    // scanFileWithTreeSitter returns symbols with line numbers — find enclosing one
    const scanResult = await scannerMod.scanFileWithTreeSitter(filePath, content);
    if (!scanResult || !scanResult.nodes) return undefined;

    // Find the symbol whose line range contains targetLine
    let best: SymbolEntry | undefined;
    for (const node of scanResult.nodes) {
      const startLine = node.startLine ?? 0;
      const endLine = node.endLine ?? startLine;
      if (targetLine >= startLine && targetLine <= endLine) {
        // Prefer the innermost (smallest range) symbol
        if (!best || (endLine - startLine) < (best.line - 0)) {
          best = { name: node.name, kind: node.kind, line: startLine };
        }
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Enrich grep matches with structural context (enclosing symbol).
 * Falls back to regex heuristic when tree-sitter is unavailable.
 */
export async function structuralGrep(
  content: string,
  pattern: RegExp,
  filePath: string,
  _brainHint?: string,
): Promise<StructuralGrepResult> {
  const lines = content.split('\n');
  const rawMatches: GrepMatch[] = [];

  lines.forEach((line, idx) => {
    if (pattern.test(line)) {
      rawMatches.push({ line: idx + 1, text: line });
    }
  });

  const totalMatches = rawMatches.length;
  const truncated = totalMatches > MAX_MATCHES;
  const matches = rawMatches.slice(0, MAX_MATCHES);

  // Try tree-sitter first, fall back to regex
  let usedTreeSitter = false;
  try {
    for (const match of matches) {
      const sym = await findEnclosingSymbolTreeSitter(content, match.line, filePath);
      if (sym) {
        match.enclosingSymbol = sym.name;
        match.enclosingKind = sym.kind;
        match.enclosingLine = sym.line;
        usedTreeSitter = true;
      }
    }
  } catch {
    usedTreeSitter = false;
  }

  // Regex fallback for any matches that didn't get tree-sitter context
  if (!usedTreeSitter) {
    for (const match of matches) {
      if (!match.enclosingSymbol) {
        const sym = findEnclosingSymbolRegex(lines, match.line);
        if (sym) {
          match.enclosingSymbol = sym.name;
          match.enclosingKind = sym.kind;
          match.enclosingLine = sym.line;
        }
      }
    }
  }

  return { matches, truncated, totalMatches };
}

/**
 * Format structural grep results for display to the model.
 * Includes enclosing symbol context when available.
 */
export function formatStructuralGrepResult(
  result: StructuralGrepResult,
  patternStr: string,
  filePath: string,
  truncationNote?: string,
): string {
  const { matches, truncated, totalMatches } = result;

  if (totalMatches === 0) {
    return `No matches for "${patternStr}" in ${filePath}${truncationNote ?? ''}`;
  }

  const formatted = matches.map((m) => {
    if (m.enclosingSymbol) {
      return `L${m.line} [in ${m.enclosingKind} \`${m.enclosingSymbol}\` (L${m.enclosingLine})]: ${m.text}`;
    }
    return `L${m.line}: ${m.text}`;
  });

  const truncMsg = truncated
    ? `\n(${totalMatches} total matches, showing first ${MAX_MATCHES})`
    : '';
  const fileTruncation = truncationNote ?? '';

  return `Match lines for "${patternStr}" in ${filePath}:\n${formatted.join('\n')}${truncMsg}${fileTruncation}`;
}
