/**
 * Identifier splitter + concept extractor.
 *
 * Code-style identifiers (CamelCase, snake_case, kebab-case, dot.notation,
 * PascalCase) carry sub-tokens that BM25 can't see by default. A single
 * `UserRepository` token never matches a query for `Repository` or `Order
 * Repository`. We splice the sub-tokens into the indexed text so FTS5 finds
 * them with zero schema change.
 *
 * Concepts: domain-level abstractions worth surfacing across notes. We detect
 * common engineering suffixes (Repository, Service, Pattern, …) so a query
 * about "OrderRepository" activates everything mentioning the Repository
 * concept — that's the Wikipedia / spread-activation pattern.
 */

const IDENT_RE = /\b[A-Za-z][A-Za-z0-9_.\-/]{2,80}\b/g;

const CONCEPT_SUFFIXES = [
  'Repository',
  'Service',
  'Controller',
  'Manager',
  'Adapter',
  'Provider',
  'Builder',
  'Factory',
  'Strategy',
  'Observer',
  'Subject',
  'Visitor',
  'Handler',
  'Wrapper',
  'Decorator',
  'Resolver',
  'Validator',
  'Serializer',
  'Pattern',
  'Convention',
  'Schema',
  'Model',
  'Entity',
  'View',
  'Middleware',
  'Plugin',
  'Hook',
  'Helper',
  'Util',
  'Utils',
];

const CONCEPT_PREFIXES = ['Abstract', 'Base', 'Default'];

/**
 * Split a single identifier into its sub-tokens.
 * Examples:
 *   "UserRepository"     → ["User", "Repository"]
 *   "user_repository"    → ["user", "repository"]
 *   "user-repository"    → ["user", "repository"]
 *   "user.repository"    → ["user", "repository"]
 *   "URLEncoder"         → ["URL", "Encoder"]
 *   "parseHTML"          → ["parse", "HTML"]
 *   "src/repo/user.ts"   → ["src", "repo", "user", "ts"]
 */
export function splitIdentifier(ident: string): string[] {
  // First split on any separator
  const segments = ident.split(/[_\-./\\]+/).filter(Boolean);
  const out: string[] = [];
  for (const seg of segments) {
    // CamelCase / PascalCase split: insert space before uppercase letter that
    // follows a lowercase letter, AND before the first letter of a tail-cap
    // sequence (URLEncoder → URL Encoder).
    const camel = seg
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    for (const tok of camel.split(/\s+/)) {
      if (tok.length >= 2) out.push(tok);
    }
  }
  return out;
}

/**
 * Build the search-augmented version of a note body: original text + sub-tokens
 * appended once. Idempotent (re-running on already-augmented text is a no-op
 * because we de-duplicate against existing tokens).
 *
 * Doubling token count on average for code-heavy notes; FTS5 storage cost is
 * modest because the porter stemmer collapses morphology.
 */
export function augmentTextForIndex(text: string): string {
  if (!text) return text;
  const existingLower = new Set(text.toLowerCase().split(/\s+/));
  const added = new Set<string>();
  IDENT_RE.lastIndex = 0;
  for (let m = IDENT_RE.exec(text); m !== null; m = IDENT_RE.exec(text)) {
    const ident = m[1] ?? m[0];
    const parts = splitIdentifier(ident);
    if (parts.length <= 1) continue;
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low.length < 3) continue;
      if (existingLower.has(low)) continue;
      added.add(p);
    }
  }
  if (added.size === 0) return text;
  return `${text}\n[tokens] ${[...added].join(' ')}`;
}

/**
 * Extract concept tokens (Repository, Service, Pattern, …) appearing as
 * suffix or prefix of identifiers in the text. Used for the structural
 * `data-cerveau-concepts` attribute and for query-time activation.
 */
export function extractConcepts(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  IDENT_RE.lastIndex = 0;
  for (let m = IDENT_RE.exec(text); m !== null; m = IDENT_RE.exec(text)) {
    const ident = m[1] ?? m[0];
    for (const suf of CONCEPT_SUFFIXES) {
      if (ident.endsWith(suf) && ident.length > suf.length) {
        found.add(suf);
        break;
      }
    }
    for (const pre of CONCEPT_PREFIXES) {
      if (ident.startsWith(pre) && ident.length > pre.length) {
        found.add(pre);
        break;
      }
    }
  }
  return [...found].slice(0, 12);
}

/**
 * Expand a free-text query into search variants by adding sub-tokens. The
 * router fuses results from all variants via RRF so a literal query like
 * "OrderRepository what is the convention" still hits "UserRepository"
 * notes via the shared "Repository" token.
 */
export function expandQuery(query: string): string[] {
  const variants = new Set<string>([query]);
  const augmented = augmentTextForIndex(query);
  if (augmented !== query) {
    variants.add(augmented.replace(/\n\[tokens\]\s*/, ' '));
  }
  // If concepts present, generate a "concept-only" variant — narrows BM25
  // toward notes that share at least one structural concept with the query.
  const concepts = extractConcepts(query);
  if (concepts.length > 0) variants.add(concepts.join(' '));
  return [...variants];
}

/**
 * Estimate token count for text using context-aware heuristics.
 *
 * Baseline: 0.25 tokens/char for English prose (works well for typical text).
 * Code-heavy content (>30% non-alphabetic chars) uses 0.33 tokens/char because
 * code tokens break finer (braces, dots, etc.) and don't compress well.
 *
 * This is still an estimation; true token counts require BPE. But it's
 * significantly more accurate for mixed code/prose content than naive 0.25.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;

  // Count non-alphabetic characters as a heuristic for code density
  const nonAlpha = text.replace(/[a-zA-Z0-9\s]/g, '').length;
  const ratio = text.length > 0 ? nonAlpha / text.length : 0;

  // If > 30% non-alpha, assume code-heavy (use 0.33); otherwise prose (0.25)
  const tokensPerChar = ratio > 0.3 ? 0.33 : 0.25;
  return Math.ceil(text.length * tokensPerChar);
}
