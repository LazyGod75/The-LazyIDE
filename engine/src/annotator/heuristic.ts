import { createHash } from 'node:crypto';
import { listAll, topConcepts } from '../indexer/fts.js';
import { slug } from '../store/paths.js';
import { normalizeCwd } from '../util/cwd-normalizer.js';
import { discoverAndAnnotateEntities } from './entities.js';
import { extractRelations } from './relations.js';
import { detectSaliency } from './saliency.js';
import { emitWikipediaNote } from './template.js';

export interface SessionInput {
  sessionId: string;
  text: string;
  timestamp?: string; // ISO, defaults to now
  cwd?: string;
  /** Structured hints extracted from tool payloads. */
  tool?: string;
  filesRead?: string[];
  filesModified?: string[];
  /** Provenance: which coding agent produced the conversation. */
  agent?: string;
  /** Provenance: transcript | subagent | plan | history | compaction-summary. */
  sourceKind?: string;
  /** Compaction lineage: parent session id (Vibe). */
  sessionParent?: string;
  gitCommit?: string;
  gitBranch?: string;
}

export interface AnnotateOutput {
  id: string;
  html: string;
  factCount: number;
  tags: string[];
  type: string;
}

const KEYWORD_TAGS: Array<[RegExp, string]> = [
  [/\b(auth|oauth|jwt|session|login|signin|token)\b/i, 'auth'],
  [/\b(api|endpoint|rest|graphql)\b/i, 'api'],
  [/\b(db|database|postgres|sqlite|mysql|migration|schema)\b/i, 'database'],
  [/\b(test|vitest|jest|spec|coverage)\b/i, 'testing'],
  [/\b(deploy|ci|cd|github actions|workflow)\b/i, 'deploy'],
  [/\b(refactor|cleanup|simplif|rewrit)/i, 'refactor'],
  [/\b(bug|fix|error|exception|crash|broken)\b/i, 'bug'],
  [/\b(perf|performance|latency|optimi[sz])/i, 'performance'],
  [/\b(security|vuln|cve|xss|injection|csrf)\b/i, 'security'],
  [/\b(typescript|tsconfig|types|d\.ts)\b/i, 'typescript'],
  [/\b(react|next\.?js|vue|svelte)\b/i, 'frontend'],
  [/\b(claude|llm|gpt|anthropic|openai|prompt|context)\b/i, 'llm'],
  [/\b(memory|brain|rag|retrieval|embedding|vector)\b/i, 'memory'],
  [/\b(docker|kubernetes|k8s|container)\b/i, 'infra'],
  [/\b(git|commit|branch|merge|rebase|push)\b/i, 'git'],
];

const DECISION_PATTERNS = [
  /^(?:decision|décision)\s*[:.-]?\s*(.+)/i,
  /^(?:we (?:decided|chose|picked|will use|are going to use))\s+(.+)/i,
  /^(?:let'?s|i'?ll|i will)\s+(.+)/i,
  /^(?:going to|going with)\s+(.+)/i,
  /^(?:final|chosen|selected)\s*[:.-]?\s*(.+)/i,
  // French mirrors of the four English patterns above (same capture-group
  // shape: line-start anchor + verb phrase + rest-of-line capture). No \b
  // boundaries are used here — same convention as enrich.ts's CLASSIFIERS —
  // because JS's \b is ASCII-\w-only and would silently fail to match right
  // after an accented final letter (e.g. "décidé", "sélectionné").
  /^(?:on (?:a|va) (?:décidé|choisi|opté pour|opté|utiliser)|nous avons (?:décidé|choisi))\s+(.+)/i,
  /^(?:allons-y(?:\s+avec)?|je vais)\s+(.+)/i,
  /^(?:on part (?:sur|avec)|c'est parti pour)\s+(.+)/i,
  /^(?:choisi|sélectionné|retenu)\s*[:.-]?\s*(.+)/i,
];

const FACT_PATTERNS = [
  /(?:the |a |an |this )?(?:cause|reason|issue|bug|problem)\s+(?:was|is)\s+(.+)/i,
  /(?:turns out|it turns out|i found that|learned that|noticed that)\s+(.+)/i,
  /(?:must|should|need to|has to)\s+(.+)/i,
  // Negation patterns: use full match (m[0]) so "Do not retry" / "Never use X"
  // preserves the negation keyword — critical for anti-redo memory retrieval.
  /(?:never|always|don'?t|do not|avoid|skip|not recommended)\s+(.+)/i,
  /\btried\s+(?:using|to use|implementing)\s+(.+)/i,
  /(?:broke|broken|broke the|broke)\s+(?:(?:the\s+)?(?:build|streaming|api|deploy))\b(.+)?/i,
  /\b(?:rollback|reverted|backed out)\b(?:\s+(?:to|from))?\s*[:.-]?\s*(.+)?/i,
  /\bworkaround\s*[:.-]?\s*(.+)/i,
  /(?:was|is)\s+(?:wrong|a mistake|bad|incorrect)\b(.+)?/i,
  /shouldn'?t\s+have\s+(.+)/i,
  /\b(?:ne pas faire|eviter|attention|déprécié|deprecated)\b(?:\s+(.+))?/i,
  /pourquoi\s+(.+)/i,
];

const ERROR_PATTERNS = [
  /error\s*[:.-]?\s*(.+)/i,
  /failed\s*(?:to|with|:)?\s*(.+)/i,
  /\bcrashed?\b(?:\s+with)?\s*[:.-]?\s*(.+)?/i,
  /\bbug\b(?:\s+(?:is|was))?\s*[:.-]?\s*(.+)?/i,
  /\b(?:broken|timeout|timed out)\b(?:\s+(?:during|on))?\s*[:.-]?\s*(.+)?/i,
  /\b(?:rejected|denied)\b(?:\s+(?:due to))?\s*[:.-]?\s*(.+)?/i,
  /exception\s*[:.-]?\s*(.+)/i,
  /traceback\s*[:.-]?\s*(.+)/i,
  /\b(?:operationalerror|typeerror|referenceerror|syntaxerror|eresolve|deadlock|enoent|eacces|segfault)\b[:\s]+(.+)?/i,
  /npm err!\s+(.+)/i,
  /(?:^|[\s])(\d+:\d+)\s+(.+)/,
  /(?:^|[\s])([a-z0-9._-]+\.\w+:\d+)/i,
];

type CandidateFact = { text: string; kind: 'decision' | 'fact' | 'error'; confidence: number };

/** Pull file paths from prose and <data value="path"> markup (CSMB filetree fixtures). */
export function extractPathsFromText(text: string): string[] {
  const paths = new Set<string>();
  for (const m of text.matchAll(/<data\s+value="([^"]+)">/gi)) {
    paths.add(m[1].replace(/\\/g, '/'));
  }
  for (const m of text.matchAll(
    /(?:^|[\s'"])(?:(?:src|tests|apps|docs|migrations)\/[\w./-]+|[\w.-]+\.(?:ts|tsx|js|jsx|py|sql|md|json|html|toml|yaml|yml))(?:\s|$|[,.)])/gi,
  )) {
    paths.add(m[0].trim().replace(/^[\s'"]+/, ''));
  }
  return [...paths];
}

/**
 * Derive 8 stable hex chars from any sessionId, regardless of its format.
 *
 * Strategy:
 *   1. If the sessionId contains a dash, check whether the substring AFTER the
 *      first dash is a run of at least 8 hex chars. If so, use the first 8.
 *      This handles formats like "dream-ab12cd34", "capture-deadbeef01", etc.
 *   2. Otherwise, hash the entire sessionId with SHA-256 and take the first 8
 *      chars of the digest.
 *
 * This guarantees:
 *   - "dream-ab12cd34"   → "ab12cd34"  (8 real hex chars, not "dream-ab")
 *   - "dream-a1b2c3d4e5" → "a1b2c3d4" (first 8 of a longer suffix)
 *   - "abc12345-def67890" → SHA-256 fallback (suffix "def67890" is hex but
 *      contains non-hex "g"–"z" range... wait: d,e,f are hex, "def67890" IS
 *      valid hex, so this WILL match via the dash rule)
 *   - arbitrary UUID / plain string → SHA-256(string).slice(0, 8)
 *   - Same input → same output every time (idempotent).
 */
export function extractSessionHash(sessionId: string): string {
  // If there is at least one dash, try the substring after the first dash
  const dashIdx = sessionId.indexOf('-');
  if (dashIdx >= 0) {
    const afterDash = sessionId.slice(dashIdx + 1);
    // Accept if it starts with at least 8 hex chars
    const m = afterDash.match(/^([0-9a-f]{8})/i);
    if (m) return m[1].toLowerCase();
  }

  // Fallback: hash the full sessionId
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
}

export function annotateSession(input: SessionInput): AnnotateOutput {
  const ts = input.timestamp ?? new Date().toISOString();
  const fromText = extractPathsFromText(input.text);
  const filesModified = [...new Set([...(input.filesModified ?? []), ...fromText])];
  const filesRead = input.filesRead ?? [];

  // Tags: text + tool + file extensions
  const tags = detectTags(input.text, [...filesModified, ...filesRead], input.tool);
  const facts = extractFacts(input.text);
  const type = inferType(facts, input.tool);
  const title = buildTitle(input.text, facts, tags, input.tool, filesModified);
  // Build a collision-resistant note id.
  // Rules:
  //   - date prefix (10 chars) + title (≤60 chars) + stable 8-hex suffix
  //   - The hash suffix is always appended LAST so it is never truncated by
  //     the 80-char slug limit (10 + 1 + 60 + 1 + 8 = 80 exactly).
  //   - extractSessionHash() derives 8 true hex chars from ANY sessionId
  //     format without depending on the "dream-HHHH" prefix convention.
  //   - Same sessionId → same hash → idempotent across re-runs.
  //   - Different sessionIds (different source files) → different hashes.
  const sessionHash = extractSessionHash(input.sessionId);
  const titlePart = title.slice(0, 60);
  const noteId = slug(`${ts.slice(0, 10)}-${titlePart}-${sessionHash}`);

  const importance = computeImportance(facts, tags, input.tool);
  // Detect topic hierarchy and TLDR
  const topic = detectTopic(tags, input.cwd, filesModified);
  const tldr = buildTldr(facts, title);
  // P1: heuristic relation extraction (triples, causes, supersession)
  const relations = extractRelations(input.text);
  // P2: entity discovery — persistent registry, returns "db:postgres-prod,lib:react"
  const entityResult = discoverAndAnnotateEntities(input.text, ts);

  // Build facts array for template — include tool fallback facts when no prose facts
  const templateFacts: Array<{
    text: string;
    confidence: number;
    kind: string;
    extractor?: string;
  }> = facts.map((f) => ({
    text: f.text,
    confidence: f.confidence,
    kind: f.kind === 'decision' ? 'decision' : f.kind === 'error' ? 'error' : 'fact',
    extractor: 'heuristic',
  }));

  if (templateFacts.length === 0) {
    const fallbacks = buildToolFallbackFacts(input.text, input.tool, filesModified, filesRead);
    templateFacts.push(...fallbacks);
  }

  // Preserve full session prose when extractors only captured a fragment (Fix:/Bash:/etc.).
  const trimmedInput = input.text.trim();
  if (trimmedInput.length > 80) {
    const full = trimmedInput.slice(0, 900);
    const hasFull = templateFacts.some((f) => f.text.length >= full.length * 0.7);
    if (!hasFull) {
      templateFacts.unshift({
        text: full,
        confidence: 0.92,
        kind: /^(?:Fix|Bash:|Output:|FAILED|Error|We tried|Attempted)/i.test(trimmedInput)
          ? 'fact'
          : 'fact',
        extractor: 'heuristic-full',
      });
    }
  }

  // Build saliency context from existing index — best-effort (no crash if DB not ready)
  const saliencyKind = (() => {
    try {
      const existingConcepts = new Set<string>();
      const conceptRows = topConcepts(200);
      for (const c of conceptRows) existingConcepts.add(c.concept.toLowerCase());

      // Tag frequency in the last 30 days
      const cutoff = Date.now() - 30 * 86400_000;
      const recentTagsCount = new Map<string, number>();
      for (const n of listAll({ includeExpired: false })) {
        if (!n.created) continue;
        if (new Date(n.created).getTime() < cutoff) continue;
        for (const t of (n.tags ?? '').split(/\s+/).filter(Boolean)) {
          recentTagsCount.set(t, (recentTagsCount.get(t) ?? 0) + 1);
        }
      }

      return detectSaliency(input.text, { existingConcepts, recentTagsCount });
    } catch {
      return null;
    }
  })();

  // Compute mean confidence from all facts
  const meanConfidence =
    templateFacts.length > 0
      ? templateFacts.reduce((sum, f) => sum + f.confidence, 0) / templateFacts.length
      : 0;

  // Determine validity window for decision-type notes (90 days)
  const validForDays = type === 'decision' ? 90 : undefined;

  const html = emitWikipediaNote({
    id: noteId,
    title,
    type,
    created: ts,
    source: `session:${input.sessionId}`,
    tier: 'working',
    importance,
    tags,
    facts: templateFacts,
    relations: {
      replaces: relations.replaces.length ? relations.replaces : undefined,
      causes: relations.causes.length ? relations.causes : undefined,
      triples: relations.triples.length ? relations.triples : undefined,
      entities: entityResult.keys.length ? entityResult.keys : undefined,
    },
    toolMeta: {
      tool: input.tool,
      cwd: input.cwd,
      filesModified: filesModified.length ? filesModified : undefined,
      filesRead: filesRead.length ? filesRead : undefined,
    },
    saliencyKind,
    topic,
    tldr,
    meanConfidence,
    validForDays,
    agent: input.agent,
    sourceKind: input.sourceKind,
    sessionParent: input.sessionParent,
    commitRef: input.gitCommit ?? undefined,
    gitBranch: input.gitBranch,
  });

  return { id: noteId, html, factCount: facts.length, tags, type };
}

// Phase 5 — DPub-ARIA role detection patterns
const DPUB_TIP_PATTERN = /\b(tip|protip|hint)\b/i;
const DPUB_WARNING_PATTERN = /\b(warning|careful|don'?t|avoid|do not)\b/i;
const DPUB_EXAMPLE_PATTERN = /\b(example|e\.g\.|for instance)\b/i;
const DPUB_ERRATA_PATTERN = /\b(this was wrong|the correct version is|correction:|erratum:)\b/i;

type DpubRole = 'doc-tip' | 'doc-warning' | 'doc-example' | 'doc-errata';

function detectDpubRole(text: string): DpubRole | null {
  if (DPUB_ERRATA_PATTERN.test(text)) return 'doc-errata';
  if (DPUB_WARNING_PATTERN.test(text)) return 'doc-warning';
  if (DPUB_TIP_PATTERN.test(text)) return 'doc-tip';
  if (DPUB_EXAMPLE_PATTERN.test(text)) return 'doc-example';
  return null;
}

/**
 * Wrap candidate fact lines with DPub-ARIA <aside> roles when a semantic
 * pattern is detected. Returns the transformed line or the original.
 */
export function wrapWithDpubRole(line: string): string {
  const role = detectDpubRole(line);
  if (!role) return line;
  const escaped = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<aside role="${role}">${escaped}</aside>`;
}

function buildToolFallbackFacts(
  text: string,
  tool: string | undefined,
  modified: string[],
  read: string[],
): Array<{ text: string; confidence: number; kind: string; extractor?: string }> {
  const facts: Array<{ text: string; confidence: number; kind: string; extractor?: string }> = [];
  if (modified.length) {
    const names = modified.slice(0, 4).join(', ');
    facts.push({ text: `${tool ?? 'modified'}: ${names}`, confidence: 0.5, kind: 'action' });
  }
  if (read.length) {
    const names = read.slice(0, 4).join(', ');
    facts.push({ text: `read: ${names}`, confidence: 0.3, kind: 'action' });
  }
  if (facts.length === 0 && text.length > 0) {
    // Keep at least 200 chars so inline code snippets like `{ ok: false, error }` are
    // fully indexed in FTS5 even when no pattern-based fact is extracted.
    facts.push({ text: text.slice(0, 400), confidence: 0.4, kind: 'fact', extractor: 'heuristic' });
  }
  return facts;
}

function detectTags(text: string, files: string[] = [], tool?: string): string[] {
  const found = new Set<string>();
  for (const [pattern, tag] of KEYWORD_TAGS) {
    if (pattern.test(text)) found.add(tag);
  }
  // File extensions become tags
  for (const f of files) {
    const ext = /\.([a-z0-9]+)$/i.exec(f)?.[1]?.toLowerCase();
    if (!ext) continue;
    if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) found.add('typescript');
    else if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) found.add('javascript');
    else if (['py'].includes(ext)) found.add('python');
    else if (['rs'].includes(ext)) found.add('rust');
    else if (['go'].includes(ext)) found.add('go');
    else if (['md', 'mdx'].includes(ext)) found.add('docs');
    else if (['css', 'scss', 'less'].includes(ext)) found.add('frontend');
    else if (['sql'].includes(ext)) found.add('database');
    else if (['json', 'yaml', 'yml', 'toml'].includes(ext)) found.add('config');
    else if (['html', 'htm'].includes(ext)) found.add('frontend');
    else if (['sh', 'bash', 'zsh', 'ps1'].includes(ext)) found.add('shell');
  }
  if (tool === 'Bash') found.add('shell');
  return [...found].slice(0, 8);
}

function extractFacts(text: string): CandidateFact[] {
  const out: CandidateFact[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 8 && l.length < 400);

  for (const line of lines) {
    if (out.length >= 12) break;
    const cleaned = line.replace(/^[-*•>\d.)\]\s]+/, '').trim();
    if (cleaned.length < 8) continue;

    for (const pattern of DECISION_PATTERNS) {
      const m = cleaned.match(pattern);
      if (m) {
        out.push({ text: completeSentence(m[1] ?? cleaned), kind: 'decision', confidence: 0.8 });
        break;
      }
    }
    if (out.length >= 12) break;

    let hit = false;
    for (const pattern of ERROR_PATTERNS) {
      const m = cleaned.match(pattern);
      if (m) {
        out.push({ text: completeSentence(m[1] ?? cleaned), kind: 'error', confidence: 0.7 });
        hit = true;
        break;
      }
    }
    if (hit) continue;

    for (const pattern of FACT_PATTERNS) {
      const m = cleaned.match(pattern);
      if (m) {
        // Use the full matched segment (m[0]) to preserve negation prefixes like
        // "Do not", "Never", "Don't" — m[1] alone drops the prefix and breaks retrieval.
        out.push({ text: completeSentence(m[0] ?? cleaned), kind: 'fact', confidence: 0.6 });
        break;
      }
    }
  }
  return out;
}

function inferType(facts: CandidateFact[], tool?: string): string {
  if (facts.some((f) => f.kind === 'decision')) return 'decision';
  if (facts.some((f) => f.kind === 'error')) return 'episodic';
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') return 'procedural';
  if (tool === 'Bash') return 'episodic';
  return 'reference';
}

function buildTitle(
  text: string,
  facts: CandidateFact[],
  tags: string[],
  tool?: string,
  filesModified: string[] = [],
): string {
  // Try facts first, but filter out garbage titles
  if (facts.length > 0) {
    const candidate = facts[0].text.slice(0, 80).trim();
    // Reject titles that are system instruction fragments
    if (
      !/^(must|should|never|always|do not|platform|null|exit code|rate limit|permission|access denied)/i.test(
        candidate,
      )
    ) {
      return candidate;
    }
  }

  // Fallback 1: Use tool + files
  if (tool && filesModified.length > 0) {
    const names = filesModified.map(basename).slice(0, 2).join(', ');
    return `${tool}: ${names}`.slice(0, 80);
  }

  // Fallback 2: first non-empty, non-system line
  const firstLine = text.split(/\r?\n/).find((l) => {
    const trimmed = l.trim();
    return (
      trimmed.length > 8 &&
      !/^(must|should|never|always|do not|platform|null|exit code|rate limit|permission|access denied|you |do )/i.test(
        trimmed,
      )
    );
  });
  if (firstLine) return firstLine.trim().slice(0, 80);

  // Fallback 3: tags-based generic title
  if (tags.length) {
    return `${tags.slice(0, 2).join(' ')} session`.slice(0, 80);
  }

  // Absolute fallback
  return 'Session note';
}

function basename(p: string): string {
  return (
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? p
  );
}

function completeSentence(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function computeImportance(facts: CandidateFact[], tags: string[], tool?: string): number {
  let base = 0.4;
  if (facts.some((f) => f.kind === 'decision')) base += 0.3;
  if (facts.some((f) => f.kind === 'error')) base += 0.15;
  if (tags.length >= 3) base += 0.1;
  if (facts.length >= 4) base += 0.1;
  // Tool-only events are lower-importance by default
  if (facts.length === 0 && tool && (tool === 'Read' || tool === 'Bash')) base -= 0.1;
  return Math.min(1, Math.max(0.1, base));
}

/**
 * Detect topic hierarchy from context (project, feature area, module).
 * Returns hierarchical path like "myproject/auth/login" or undefined.
 * Generic: works for any user, no hardcoded project names.
 *
 * Uses normalizeCwd as the single source of truth for project-name
 * canonicalization so that code notes (from code-scanner) and conversation
 * notes always share the same lowercase first topic segment.
 */
function detectTopic(tags: string[], cwd?: string, filesModified?: string[]): string | undefined {
  // Level 1: canonical project name from cwd via normalizeCwd (always lowercase).
  let project = '';
  if (cwd) {
    const normalized = normalizeCwd(cwd);
    if (normalized) {
      project = normalized.project; // already lowercase from normalizeCwd
    }
  }

  // Level 2: feature area from primary tag
  const FEATURE_TAGS = [
    'auth',
    'database',
    'api',
    'deploy',
    'testing',
    'security',
    'frontend',
    'performance',
  ];
  const featureTag = tags.find((t) => FEATURE_TAGS.includes(t));

  // Level 3: specific module from file paths
  let module = '';
  if (filesModified && filesModified.length > 0) {
    const firstFile = filesModified[0].replace(/\\/g, '/');
    const parts = firstFile.split('/');
    // Find src/ or similar prefix and take next segment
    const srcIdx = parts.findIndex((p) => p === 'src' || p === 'lib' || p === 'app');
    if (srcIdx >= 0 && srcIdx + 1 < parts.length) {
      module = parts[srcIdx + 1].replace(/\.\w+$/, '');
    }
  }

  // Build hierarchical path
  const segments = [project, featureTag, module].filter(Boolean);
  return segments.length > 0 ? segments.join('/') : undefined;
}

/**
 * Build TLDR from facts: prefer decision facts, then highest confidence, else fallback to title.
 */
function buildTldr(facts: CandidateFact[], title: string): string {
  // Prefer decision facts for TLDR
  const decision = facts.find((f) => f.kind === 'decision');
  if (decision) return decision.text.slice(0, 200);

  // Next, highest confidence fact
  const best = [...facts].sort((a, b) => b.confidence - a.confidence)[0];
  if (best && best.text.length > 10) return best.text.slice(0, 200);

  // Fallback to title
  return title.slice(0, 200);
}
