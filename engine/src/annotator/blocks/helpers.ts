/**
 * Shared helper utilities for block renderers.
 * Extracted from src/annotator/template.ts — no mutations.
 */

/**
 * Escape HTML entities. No mutation — returns new string.
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeForKbd(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Detect if text contains comparison patterns (3+ items with ":" separator).
 */
export function isTablePattern(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim());
  let colonCount = 0;
  for (const line of lines) {
    if (line.includes(':') && line.length > 10) {
      colonCount++;
    }
  }
  return colonCount >= 3;
}

/**
 * Detect if text contains code patterns:
 * - Starts with { or SELECT
 * - Contains backtick-wrapped content
 * - Looks like JSON or SQL
 */
export function isCodePattern(text: string): boolean {
  const trimmed = text.trim();
  if (/^[{[]|^SELECT\s|^INSERT\s|^UPDATE\s|^DELETE\s|^CREATE\s/i.test(trimmed)) {
    return true;
  }
  if (/`[^`]{3,}`/g.test(text)) {
    return true;
  }
  return false;
}

/**
 * Detect if text contains quoted content (blockquote pattern).
 */
export function isQuotePattern(text: string): boolean {
  return /^["'""]|["'""]$|"[^"]{10,}"/.test(text.trim());
}

/**
 * Enrich escaped HTML text with inline semantic HTML tags:
 *   - <kbd>cmd</kbd> for Bash/CLI commands
 *   - <samp>output</samp> for tool outputs (stderr/stdout)
 *   - <abbr title="...">XYZ</abbr> for known acronyms
 *   - <var>NAME</var> for env vars and shell variables
 * Conservative: only wraps clear patterns.
 * Input: text has already been escaped by esc() (& < > " ' are HTML entities)
 * Output: raw HTML with unescaped tag markup mixed with escaped text content.
 */
export function enrichFactWithSemantics(escapedText: string): string {
  // Unescape for pattern matching
  const text = escapedText
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  // Guard: only enrich if no HTML already present
  if (/<[a-z]/i.test(text)) return escapedText;

  let out = text;

  // 1. Bash commands: lines starting with $ or one of the binaries (capture full line)
  out = out.replace(
    /(?:^|(?<=\n))((?:\$\s|(?:git|npm|lazybrain|pytest|docker|node|curl|python|pip|cargo|go|bash|sh)\s)[^\n]*)/g,
    (match) => `<kbd>${escapeForKbd(match)}</kbd>`,
  );

  // 2. Outputs: lines matching "Output:", "stderr:", "stdout:" or starting with "FAILED|PASSED|ERROR|Traceback" (capture full line)
  out = out.replace(
    /(?:^|(?<=\n))((?:Output|stderr|stdout):\s[^\n]*|(?:FAILED|PASSED|ERROR|Traceback)[^\n]*)/g,
    (match) => `<samp>${escapeForKbd(match)}</samp>`,
  );

  // 3. Known acronyms expansion (case-sensitive, first occurrence only)
  const ACRONYMS: Record<string, string> = {
    OAuth: 'Open Authorization',
    JWT: 'JSON Web Token',
    FTS5: 'SQLite Full-Text Search v5',
    RRF: 'Reciprocal Rank Fusion',
    HyDE: 'Hypothetical Document Embeddings',
    BM25: 'Best Matching 25 ranking function',
    PKCE: 'Proof Key for Code Exchange',
    SSO: 'Single Sign-On',
    CORS: 'Cross-Origin Resource Sharing',
    CSRF: 'Cross-Site Request Forgery',
    XSS: 'Cross-Site Scripting',
    'CI/CD': 'Continuous Integration / Continuous Deployment',
    ORM: 'Object-Relational Mapper',
    SQL: 'Structured Query Language',
    REST: 'Representational State Transfer',
    JSON: 'JavaScript Object Notation',
    API: 'Application Programming Interface',
    CLI: 'Command-Line Interface',
    IDE: 'Integrated Development Environment',
    LLM: 'Large Language Model',
    RAG: 'Retrieval-Augmented Generation',
    TLS: 'Transport Layer Security',
    TTL: 'Time To Live',
    UUID: 'Universally Unique Identifier',
    TDD: 'Test-Driven Development',
    DRY: "Don't Repeat Yourself",
    SOLID:
      'Single Responsibility, Open-Closed, Liskov, Interface Segregation, Dependency Inversion',
  };
  const wrapped = new Set<string>();
  for (const [acronym, expansion] of Object.entries(ACRONYMS)) {
    if (wrapped.has(acronym)) continue;
    const re = new RegExp(`\\b${acronym.replace(/[()]/g, '\\$&')}\\b`);
    if (re.test(out)) {
      out = out.replace(re, `<abbr title="${expansion}">${acronym}</abbr>`);
      wrapped.add(acronym);
    }
  }

  // 4. Env vars and shell variables: $VAR or ${VAR} (caps-only, 2+ chars)
  out = out.replace(/(\$\{?[A-Z][A-Z0-9_]{1,}\}?)/g, '<var>$1</var>');

  return out;
}

/**
 * Render fact text as HTML, detecting and rendering special patterns:
 * - Tables for comparison patterns (3+ items with ":")
 * - Code blocks for code patterns (starts with {, SELECT, backticks)
 * - Blockquotes for quoted text
 * - Otherwise enriched semantic HTML
 */
export function renderFactAsHtml(text: string): string {
  const escaped = esc(text);

  if (isCodePattern(text)) {
    return `<pre><code>${escapeForKbd(text)}</code></pre>`;
  }

  if (isTablePattern(text)) {
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const rows = lines.map((line) => {
      const parts = line.split(':').map((p) => p.trim());
      return `<tr>${parts.map((p) => `<td>${esc(p)}</td>`).join('')}</tr>`;
    });
    return `<table><tbody>${rows.join('')}</tbody></table>`;
  }

  if (isQuotePattern(text)) {
    return `<blockquote>${enrichFactWithSemantics(escaped)}</blockquote>`;
  }

  return `<p>${enrichFactWithSemantics(escaped)}</p>`;
}

/**
 * Detect DPub ARIA role for a fact text.
 * Returns the appropriate role or null if no pattern matches.
 */
export function detectDpubRoleForFact(
  text: string,
): 'doc-errata' | 'doc-warning' | 'doc-tip' | 'doc-example' | null {
  // Errata patterns
  if (/(?:this was wrong|the correct|should be|the fix is|the right way|correction)/i.test(text)) {
    return 'doc-errata';
  }
  // Warning patterns
  if (
    /\b(?:warning|careful|don'?t|avoid|do not|never|failed|crashed?|broken|error|bug)\b/i.test(text)
  ) {
    return 'doc-warning';
  }
  // Tip patterns
  if (/\b(?:tip|hint|note|best practice|trick)\b/i.test(text)) {
    return 'doc-tip';
  }
  // Example patterns
  if (/\b(?:example|e\.g\.|for instance|like this|demo)\b/i.test(text)) {
    return 'doc-example';
  }
  return null;
}

/**
 * Add days to an ISO date string.
 * Input: "2026-05-25T10:30:00Z" and days: 90
 * Output: "2026-08-23T10:30:00Z"
 */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(isoDate);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}
