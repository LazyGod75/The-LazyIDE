/**
 * enrich: wire conversation knowledge onto the canonical code-first neurons.
 *
 * The previous "graph-node → knowledge-node" enrichment loop is RETIRED.
 * Canonical wiki pages are file-neurons, aggregate-neurons, and concept-neurons
 * stored under brain/notes/. Enrichment now targets those pages exclusively via
 * the conv-file-enrichment pipeline (tool-trace driven, Task 5).
 *
 * Remaining helper types/functions (classifyChunk, emptyBucket, …) are kept
 * because they are also used by enrich-hierarchy and tests.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTags } from '../retrieval/strip.js';
import { readAllNotes } from '../store/reader.js';
import { getConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import {
  type ConvKnowledgeItem,
  type ConvNote,
  type ItemKind,
  runFileNeuronEnrichment,
} from './conv-file-enrichment.js';
import { isAgentMetaText } from './dream.js';

// ---------------------------------------------------------------------------
// TLDR validation
// ---------------------------------------------------------------------------

/**
 * File / tool-echo extensions that make a TLDR candidate a filename echo.
 * Covers code, config, markup, and data file types commonly touched in
 * development sessions and captured verbatim by the dream.ts note writer.
 */
const FILE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|html|htm|css|scss|sass|less|json|yaml|yml|toml|xml|md|txt|sh|bash|zsh|fish|ps1|psm1|env|sql|graphql|proto|dockerfile|lock)$/i;

/**
 * Tool-echo prefixes: the note-writer captured a tool invocation line
 * verbatim (e.g. "Bash: topic-overview-acme.html", "Read: src/util/foo.ts").
 * These are never meaningful TLDRs.
 */
const TOOL_ECHO_PREFIXES =
  /^(?:Bash|Read|Write|Edit|Glob|Grep|Task(?:Create|Get|List|Update|Stop)|WebFetch|WebSearch|Monitor|Skill):/i;

/**
 * Validate a TLDR candidate.
 *
 * Returns the candidate unchanged when it looks like genuine prose,
 * or returns undefined when the candidate is junk:
 *   - empty / whitespace-only
 *   - starts with a date-stamp pattern (^\d{4}-\d{2})
 *   - ends with a known file extension (filename echo)
 *   - starts with a tool-echo prefix ("Bash:", "Read:", …)
 *
 * @param candidate Raw TLDR text to evaluate (may be undefined / empty).
 * @returns The original candidate, or undefined when it is junk.
 */
export function validateTldr(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return undefined;

  // Timestamp / date-only prefix: "2026-05-13 …" or "2026-05"
  if (/^\d{4}-\d{2}/.test(trimmed)) return undefined;

  // Filename echo: ends with a code/config extension
  if (FILE_EXTENSIONS.test(trimmed)) return undefined;

  // Tool-echo prefix: "Bash: …", "Read: …", etc.
  if (TOOL_ECHO_PREFIXES.test(trimmed)) return undefined;

  return trimmed;
}

/**
 * Detect LazyBrain's own rendered note-frontmatter/infobox leaking into text chunks.
 *
 * When the HTML stripper flattens a note's infobox to plain text, the result
 * contains machine-format lines like:
 *   "Type episodic Status active Tags llm Source session:dream-9063cff5 Confidence 0"
 *
 * These are unambiguously LazyBrain internal artifacts — no human or LLM prose
 * contains a session source-id ("session:word-hexhex") or the adjacent "Type
 * <kind> Status <state>" infobox signature. Patterns are kept conservative: they
 * require the LazyBrain-specific format or adjacency, not merely the presence of
 * common words like "status" or "type".
 *
 * @param text Raw text chunk to evaluate (may be trimmed or untrimmed).
 * @returns true if the chunk is LazyBrain note-metadata residue that should be discarded.
 */
export function isNoteMetadataResidue(text: string): boolean {
  const trimmed = text.trim();

  // LazyBrain internal session source-id line: "Source session:word-hexhex..."
  // The pattern "session:<word>-<6+hex>" is unique to LazyBrain's makeConversationSessionId
  // output and cannot appear in legitimate prose.
  if (/Source\s+session:[a-z]+-[0-9a-f]{6,}/i.test(trimmed)) return true;

  // Rendered note infobox header flattened to text — strict form with known kind/state.
  // LazyBrain stores note metadata as "Type <kind> Status <state>" in each note's
  // infobox; when stripped to plain text this produces the unique adjacent pair.
  // We require the actual adjacency (Type <known-kind> Status <known-state>) to
  // avoid matching normal sentences that happen to contain "type" or "status".
  if (
    /^(?:\d{4}-\d{2}-\d{2}\s+)?Type\s+(?:episodic|reference|semantic|decision|architecture|feature|feature-set)\s+Status\s+(?:active|deprecated|draft)\b/i.test(
      trimmed,
    )
  )
    return true;

  // Infobox-as-text: "Type <word> Status <word> Tags" run-on (general form).
  // Catches any Type/Status/Tags infobox triplet regardless of the specific kind
  // or state token, which covers both known and future note types.
  // The presence of the three adjacent infobox tokens (Type, Status, Tags) in
  // sequence is unambiguous machine-format output — it cannot appear in prose.
  if (/^\s*Type\s+\w[\w-]*\s+Status\s+\w[\w-]*\s+Tags\b/i.test(trimmed)) return true;

  // Pipe-separated infobox flattening — the CURRENT retrieval/strip.ts walk()
  // format for <aside class="infobox">: "Type: X | Status: Y | Tags: Z | ...".
  // This is a distinct rendering (colon + " | " joins) from the space-separated
  // triplet above; without this pattern a captured conversation's own rendered
  // infobox (e.g. "Type: decision | Status: active | Tags: bug | Source: ... |
  // Confidence: 0") slips through classifyChunk and gets misclassified as a
  // "decision" fact when enrich.ts re-processes the note. Requiring the
  // adjacent "Type: <token> | Status: <token>" pair is the same unambiguous
  // machine-format signal as the space-separated form above.
  if (/^\s*Type:\s*\S[\w-]*\s*\|\s*Status:\s*\S[\w-]*\b/i.test(trimmed)) return true;

  // Code-scanner / hierarchy infobox run-on: "Kind <x> Files <n> Lines <n> Languages"
  // This is produced when a file-neuron or aggregate-neuron's infobox is stripped
  // to plain text. The "Kind" + "Files" + "Lines" triplet is uniquely machine-format.
  if (/\bKind\s+\w[\w-]*\s+Files\s+\d+\s+Lines\s+\d+\b/i.test(trimmed)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface EnrichOptions {
  topic?: string;
  force?: boolean;
  pretty?: boolean;
}

export interface EnrichReport {
  errors: string[];
  /** File-neurons enriched from conversation tool-traces (canonical path). */
  fileNeuronsEnriched?: number;
  /** Concept neurons created from spread-evidence items. */
  conceptNeuronsCreated?: number;
}

// ---------------------------------------------------------------------------
// Content classifiers — regex patterns to detect content type
// ---------------------------------------------------------------------------

interface Classifier {
  kind: 'decision' | 'bug' | 'idea' | 'rule' | 'qa' | 'warning';
  pattern: RegExp;
}

const CLASSIFIERS: Classifier[] = [
  {
    kind: 'decision',
    // French accent-optional stems: real conversations are frequently typed
    // without accents (missing keyboard layout, fast typing, ASCII-only tool
    // output), and "décidé"/"décision" without their accents literally become
    // "decide"/"decision" — the un-accented "decide" family previously matched
    // NOTHING (the old pattern required the literal accented "décidé"), so a
    // note saying "on a decide d'utiliser X" was silently misclassified as a
    // keyword-less 'activity' instead of a 'decision'. `d[ée]cid[ée]e?s?`
    // matches decide/decidé/décide/décidé (+ plural/feminine e/s suffix) and
    // `d[ée]cisions?` matches decision/décision — both accent directions.
    pattern:
      /(?:decided|d[ée]cisions?|chose|chosen|went\s+with|opted|choisi|d[ée]cid[ée]e?s?|on\s+(?:a|va)\s+(?:pris|fait|choisi|utilis[ée]))/i,
  },
  {
    kind: 'bug',
    // Bug-indicative action verbs (fix/fixed/broke/broken/crash/throws/regression) and
    // unambiguous runtime-defect class nouns (TypeError, ReferenceError, ENOENT, cassé,
    // plantage). Pure state-nouns like "failed/failure/error" are intentionally excluded:
    // they appear in forward-looking idea phrases ("should handle failed payments") and are
    // caught by the idea classifier instead. The classifyChunk loop is first-match-wins,
    // so a text containing both a bug verb AND an intent marker (e.g. "should fix the bug")
    // is still classified here because bug comes before idea in the classifier list — that
    // is the intended behavior for explicit remediation requests.
    pattern:
      /(?:bug|crash(?:ed)?|broke|broken|throws\s+(?:a|an)\s+\w|regression|cassé|plantage|TypeError|ReferenceError|ENOENT|fix(?:ed)\b)/i,
  },
  {
    kind: 'warning',
    pattern:
      /(?:warning|anti-pattern|gotcha|pitfall|caution|danger)/i,
  },
  {
    kind: 'idea',
    // Accent-optional for the same reason as the decision classifier above:
    // "idée"/"améliorer" typed without accents ("idee"/"ameliorer") previously
    // matched nothing.
    pattern:
      /(?:idea|should|could\s+we|todo|improve|enhancement|id[ée]e|am[ée]liorer|pourrait|faudrait|on\s+devrait)/i,
  },
  {
    kind: 'rule',
    pattern:
      /(?:always|never|must(?:\s+not)?|rule|convention|obligat|interdit|jamais|toujours|ne\s+(?:pas|jamais))/i,
  },
  {
    kind: 'qa',
    pattern: /(?:^|\s)(?:why|how|what|when|pourquoi|comment|quoi|qu['']est)[^.]{5,}\?/i,
  },
];

// ---------------------------------------------------------------------------
// Enrichment bucket
// ---------------------------------------------------------------------------

interface EnrichmentBucket {
  decisions: Array<{ text: string; sourceId: string }>;
  bugs: Array<{ text: string; sourceId: string; status?: string }>;
  ideas: Array<{ text: string; sourceId: string }>;
  rules: Array<{ text: string; sourceId: string }>;
  facts: Array<{ text: string; sourceId: string; kind?: string }>;
  qa: Array<{ question: string; sourceId: string }>;
  warnings: Array<{ text: string; sourceId: string }>;
}

export function emptyBucket(): EnrichmentBucket {
  return { decisions: [], bugs: [], ideas: [], rules: [], facts: [], qa: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// Sentence classification
// ---------------------------------------------------------------------------

export function classifyChunk(chunk: string, sourceId: string, bucket: EnrichmentBucket): void {
  const trimmed = chunk.trim();
  if (trimmed.length < 20 || trimmed.length > 500) return;
  // Defense-in-depth: drop agent/framework meta-noise or LazyBrain note-metadata
  // residue that leaked into stored notes.
  if (isAgentMetaText(trimmed) || isNoteMetadataResidue(trimmed)) return;

  for (const { kind, pattern } of CLASSIFIERS) {
    if (!pattern.test(trimmed)) continue;
    const text = trimmed.slice(0, 300);
    switch (kind) {
      case 'decision':
        bucket.decisions.push({ text, sourceId });
        break;
      case 'bug':
        bucket.bugs.push({ text, sourceId });
        break;
      case 'idea':
        bucket.ideas.push({ text, sourceId });
        break;
      case 'rule':
        bucket.rules.push({ text, sourceId });
        break;
      case 'qa':
        bucket.qa.push({ question: text, sourceId });
        break;
      case 'warning':
        bucket.warnings.push({ text, sourceId });
        break;
    }
    return; // first match wins
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * runEnrich — enriches canonical code-first neurons from conversations.
 *
 * The previous "graph-node → knowledge-node" enrichment loop has been retired.
 * Enrichment now targets file-neurons and concept-neurons exclusively via the
 * conv-file-enrichment pipeline (tool-trace driven).
 *
 * Metrics are in `fileNeuronsEnriched` and `conceptNeuronsCreated`.
 */
export async function runEnrich(opts: EnrichOptions): Promise<EnrichReport> {
  const log = getLogger();
  const report: EnrichReport = { errors: [] };

  log.info({ topic: opts.topic ?? 'all' }, 'enrich: starting (file-neuron pipeline)');

  // Load conversation notes (file-neuron stubs derived from these)
  const allNotes = readAllNotes();

  // ---------------------------------------------------------------------------
  // Conv→file-neuron enrichment via tool-traces (canonical path)
  // ---------------------------------------------------------------------------
  try {
    const fileNeuronResult = await runConvFileNeuronEnrichment(allNotes, opts);
    report.fileNeuronsEnriched = fileNeuronResult.fileNeuronsEnriched;
    report.conceptNeuronsCreated = fileNeuronResult.conceptNeuronsCreated;
    if (fileNeuronResult.errors.length > 0) {
      report.errors.push(...fileNeuronResult.errors.map((e) => `[file-neuron] ${e}`));
    }
    log.debug(
      {
        fileNeuronsEnriched: fileNeuronResult.fileNeuronsEnriched,
        conceptNeuronsCreated: fileNeuronResult.conceptNeuronsCreated,
      },
      'enrich: conv→file-neuron enrichment done',
    );
  } catch (err) {
    const msg = (err as Error).message;
    log.warn({ err: msg }, 'enrich: conv→file-neuron enrichment failed');
    report.errors.push(`[file-neuron] ${msg}`);
  }

  log.info(
    {
      fileNeuronsEnriched: report.fileNeuronsEnriched ?? 0,
      conceptNeuronsCreated: report.conceptNeuronsCreated ?? 0,
      errors: report.errors.length,
    },
    'enrich: done',
  );

  return report;
}

// ---------------------------------------------------------------------------
// conv→file-neuron wiring helpers (Task 5)
// ---------------------------------------------------------------------------

import { extractFileNeuronStubsFromHtml } from '../graph/file-neuron-parse.js';
import type { NoteFile } from '../store/reader.js';

/**
 * Extract file-neuron CodeNode stubs from stored file-neuron HTML notes.
 *
 * Delegates to the shared file-neuron-parse module (Task 6.1 refactor).
 */
export function extractFileNeuronStubs(
  notes: NoteFile[],
): Array<import('../graph/code-scanner.js').CodeNode> {
  return extractFileNeuronStubsFromHtml(notes);
}

// ---------------------------------------------------------------------------
// File-index helpers for body-mention matching
// ---------------------------------------------------------------------------

/**
 * Build a basename → [relPaths] index from a set of file-neuron relPaths.
 * Used by buildBodyMentions to detect ambiguous basenames.
 *
 * @param relPaths - All project-relative forward-slash file paths known to the
 *   file-neuron set (e.g. ["src/auth.ts", "app/auth.ts"]).
 * @returns Map from lowercased basename to array of relPaths that share it.
 */
export function buildBasenameIndex(relPaths: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const rel of relPaths) {
    const base = rel.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    if (!base) continue;
    const existing = index.get(base) ?? [];
    existing.push(rel);
    index.set(base, existing);
  }
  return index;
}

/**
 * Regex for file-path-like tokens in plain text.
 * Matches tokens that contain at least one slash and a file extension.
 * Backslashes are normalised to forward-slashes before matching.
 * No capture group — the whole match[0] is the path.
 */
const BODY_PATH_RE = /(?:^|[\s(["'])([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,6})(?=$|[\s),"'])/g;

/**
 * Extract file-path mentions from a plain-text note body and resolve them
 * unambiguously against the known file-neuron relPath set.
 *
 * Rules (preventing false attributions):
 *   1. Token must contain a slash (bare "auth.ts" is NOT a path).
 *   2. Token (normalised to forward-slash, optional "./" prefix stripped) must
 *      either (a) match a known relPath exactly, OR (b) be an unambiguous suffix
 *      of exactly ONE known relPath (i.e. only one relPath ends with that suffix).
 *   3. Basename-only tokens (no slash even after normalisation) are skipped.
 *   4. If a suffix matches MORE than one relPath → ambiguous → skip (no false attach).
 *
 * @param bodyText - Stripped plain text of the conversation note.
 * @param relPathSet - Set of all known file-neuron relative paths (forward-slash).
 * @param basenameIndex - Precomputed basename→[relPaths] index for O(1) lookups.
 * @returns Deduplicated array of unambiguously resolved relPaths.
 */
export function buildBodyMentions(
  bodyText: string,
  relPathSet: Set<string>,
  basenameIndex: Map<string, string[]>,
): string[] {
  const resolved = new Set<string>();
  // Reset lastIndex before use (regex is module-level).
  BODY_PATH_RE.lastIndex = 0;

  for (
    let match = BODY_PATH_RE.exec(bodyText);
    match !== null;
    match = BODY_PATH_RE.exec(bodyText)
  ) {
    const raw = match[1];
    if (!raw) continue;

    const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
    // Must contain at least one slash
    if (!norm.includes('/')) continue;

    // Rule (a): exact match against known relPaths (case-insensitive)
    const lowerNorm = norm.toLowerCase();
    let found: string | null = null;
    for (const rel of relPathSet) {
      if (rel.toLowerCase() === lowerNorm) {
        found = rel;
        break;
      }
    }
    if (found) {
      resolved.add(found);
      continue;
    }

    // Rule (b): unambiguous suffix match — does exactly ONE known relPath end with norm?
    const suffixMatches: string[] = [];
    for (const rel of relPathSet) {
      const lowerRel = rel.toLowerCase();
      if (lowerRel === lowerNorm || lowerRel.endsWith(`/${lowerNorm}`)) {
        suffixMatches.push(rel);
      }
    }
    if (suffixMatches.length === 1) {
      resolved.add(suffixMatches[0]);
      continue;
    }

    // Rule (c): basename match — only when unambiguous
    const base = lowerNorm.split('/').pop() ?? '';
    if (base) {
      const baseCandidates = basenameIndex.get(base) ?? [];
      if (baseCandidates.length === 1) {
        // Basename matches exactly one file — safe only if no slash confusion.
        // We already handled suffix matches above; this is a pure basename fallback.
        // Since norm HAS a slash we skip the pure-basename path here to avoid
        // false resolution when norm is "foo/bar.ts" but only "baz/bar.ts" exists.
        // (The suffix match above already handles this correctly.)
      }
    }
    // Ambiguous or unresolvable — skip.
  }

  return Array.from(resolved);
}

/**
 * Marker wrapping a protected file-path placeholder inserted by
 * splitIntoSentenceChunks. Deliberately an unlikely-to-occur plain-ASCII
 * token (no regex metacharacters, no control characters) rather than a
 * "cleverer" delimiter — this keeps the source file plain UTF-8 text and the
 * regex trivial to reason about. Real conversation/code prose does not
 * contain this literal substring.
 */
const PATH_PLACEHOLDER_TAG = 'LBPATHPLACEHOLDER';

/**
 * Regex for dotted code-identifier tokens in plain text — the counterpart of
 * BODY_PATH_RE for identifiers that are NOT file paths (no slash, so
 * BODY_PATH_RE's own file-path semantics don't apply, and its trailing
 * lookahead rejects an immediately-following "(" anyway).
 *
 * Matches, as a single token (dots included):
 *   - method/property chains: `obj.method`, `a.b.c`, `Foo.bar`
 *   - calls on a chain: `tree.delete()`, `obj.method()`
 *   - private fields: `this.#priv`
 *   - indexed access: `arr[0].x`
 *   - decimals: `3.14`
 *   - dotted version strings: `v0.1.17`
 *
 * A "segment" is either a normal identifier (`#?[A-Za-z_$][\w$]*`, so
 * `#priv`, `method`, `Foo` all qualify) or a bare digit run (`\d+`, so
 * numeric segments in `3.14` / `v0.1.17` qualify). Segments may be followed
 * by a `[digit]` index. At least one `.segment` must follow the first
 * segment for the token to count as "dotted" — a single bare word is never
 * matched (nothing to protect there). An optional trailing `()` covers a
 * method call ending the token.
 *
 * Deliberately requires the dot to sit directly between two segments with NO
 * whitespace — real sentence-ending periods are followed by whitespace/EOL,
 * so this can never swallow a genuine sentence boundary (see the "genuine
 * sentence" test below). A bare ellipsis ("...") also never matches: after
 * consuming one dot the next character is another dot, which is not a valid
 * segment start, so the mandatory `(?:\.segment...)+` group fails and the
 * whole token match fails — ellipses fall through to the existing
 * `[.!\n]+`-collapsing split behaviour, unchanged.
 */
const IDENTIFIER_SEGMENT = '(?:#?[A-Za-z_$][\\w$]*|\\d+)';
const IDENTIFIER_INDEX = '(?:\\[\\d+\\])?';
const IDENTIFIER_DOT_RE = new RegExp(
  `${IDENTIFIER_SEGMENT}${IDENTIFIER_INDEX}(?:\\.${IDENTIFIER_SEGMENT}${IDENTIFIER_INDEX})+(?:\\(\\))?`,
  'g',
);

/**
 * Split note text into "sentence" chunks for classifyChunk, WITHOUT letting a
 * file path's extension dot (e.g. "LocaleSwitcher.tsx") or a code
 * identifier's dot (e.g. "tree.delete()") be mistaken for a sentence
 * terminator.
 *
 * A naive `text.split(/[.!\n]+/)` truncates any path or identifier mentioned
 * mid-sentence at its first embedded dot: "...dans src/components/layout/
 * LocaleSwitcher.tsx parce que..." becomes two chunks — "...LocaleSwitcher"
 * (extension silently dropped) and "tsx parce que..." (orphaned, usually
 * discarded by the length filter). Likewise "tree.delete() removes the node"
 * split into "tree" and "delete() removes the node", destroying the very
 * term a downstream search query would look for. The classified item then
 * loses the term from its displayed text, even though note-level
 * buildBodyMentions/filesModified/filesRead (computed on the UNSPLIT text,
 * before this function runs) still carry the correct full path for
 * attachment purposes.
 *
 * Fix: protect every BODY_PATH_RE match (file paths) AND every
 * IDENTIFIER_DOT_RE match (dotted code identifiers) — whole token, dots and
 * all — behind an opaque placeholder before splitting, then restore the
 * original text in each resulting chunk. Placeholders contain no '.', '!' or
 * '\n', so a protected token can never itself be split; each match gets its
 * own numbered placeholder (continuing across both passes), so restoration
 * is unambiguous even when the same token is mentioned more than once. The
 * two passes run in sequence, not in parallel: a token already replaced by a
 * placeholder in pass 1 is plain alphanumeric text with no dots, so pass 2
 * cannot re-match inside it — no double-protection or corruption.
 *
 * @param text Plain (already tag-stripped) note text.
 * @returns Chunks split on '.', '!', '\n' — with any file-path or dotted
 *   code-identifier token preserved intact within its chunk.
 */
export function splitIntoSentenceChunks(text: string): string[] {
  const protectedTokens: string[] = [];
  const protect = (input: string, re: RegExp): string => {
    re.lastIndex = 0;
    return input.replace(re, (match) => {
      const token = `${PATH_PLACEHOLDER_TAG}${protectedTokens.length}${PATH_PLACEHOLDER_TAG}`;
      protectedTokens.push(match);
      return token;
    });
  };

  const protectedText = protect(protect(text, BODY_PATH_RE), IDENTIFIER_DOT_RE);

  if (protectedTokens.length === 0) {
    return protectedText.split(/[.!\n]+/);
  }

  const placeholderRe = new RegExp(`${PATH_PLACEHOLDER_TAG}(\\d+)${PATH_PLACEHOLDER_TAG}`, 'g');
  return protectedText
    .split(/[.!\n]+/)
    .map((chunk) =>
      chunk.replace(placeholderRe, (_full, idx: string) => protectedTokens[Number(idx)] ?? ''),
    );
}

/**
 * True when a note's HTML could plausibly carry conversational knowledge
 * (decisions/bugs/ideas/rules/qa) worth classifying — i.e. it is NOT itself
 * a generated file-neuron, concept-neuron, or aggregate/composer output.
 *
 * Single source of truth for "is this a conversation note": shared by
 * buildConvNotes (the enrichment corpus filter, below) and store.ts's
 * incremental-enrich trigger guard, so the two can never drift out of sync.
 */
export function isConvEligibleNoteHtml(html: string): boolean {
  if (html.includes('data-cerveau-type="file-neuron"')) return false;
  if (html.includes('data-cerveau-type="concept"')) return false;
  if (html.includes('data-cerveau-source="synthesize-nodes"')) return false;
  if (html.includes('data-cerveau-source="concept-composer"')) return false;
  return true;
}

/**
 * Build ConvNote objects from conversation HTML notes.
 * Extracts data-cerveau-files-modified, data-cerveau-files-read (comma-separated
 * paths that may be absolute OR already relativised to data-cerveau-cwd),
 * data-cerveau-created, and classifies the note text into knowledge items.
 *
 * Path resolution strategy:
 *   1. If a stored path is absolute (starts with a drive letter or '/'), try to
 *      relativise it directly against every known file-neuron projectRoot.
 *   2. If a stored path is already relative (the common case — dream.ts
 *      relativises tool-trace paths against the claude-project folder, which may
 *      be the PARENT of the actual scanned sub-project), reconstruct the absolute
 *      path using data-cerveau-cwd as the base, then try step 1.
 *   Both attempts normalise backslash to forward-slash before comparison.
 *
 * Body-mention fallback (widens coverage beyond tool-trace notes):
 *   Notes with no data-cerveau-files-modified/read are NOT skipped if their body
 *   text mentions known file paths (resolved unambiguously via buildBodyMentions).
 *   These mentions feed into filesBodyMentions (weight 0.85) rather than
 *   filesModified/filesRead, so the canonical-merge threshold is still respected.
 *
 * Exported as buildConvNotesFromHtml for testing purposes.
 *
 * @param notes - All brain notes.
 * @param projectRoots - Known file-neuron project roots.
 * @param fileNodes - Optional: all known file-neuron CodeNode stubs. When
 *   provided, enables body-mention matching for notes without tool-trace attrs.
 */
export function buildConvNotesFromHtml(
  notes: NoteFile[],
  projectRoots: string[],
  fileNodes?: Array<import('../graph/code-scanner.js').CodeNode>,
): ConvNote[] {
  return buildConvNotes(notes, projectRoots, fileNodes);
}

function buildConvNotes(
  notes: NoteFile[],
  projectRoots: string[],
  fileNodes?: Array<import('../graph/code-scanner.js').CodeNode>,
): ConvNote[] {
  const convNotes: ConvNote[] = [];

  // Normalise a root for prefix comparison.
  const normRoot = (root: string): string =>
    root.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');

  // Sort roots longest-first (most-specific wins) so that a nested project
  // (e.g. "acme/web") is matched before its parent ("acme").
  const sortedRoots = [...projectRoots].sort((a, b) => b.length - a.length);

  // Try to relativise normPath against every known file-neuron projectRoot.
  // Returns the first match (most-specific root wins to avoid mis-relativising).
  const relativiseAgainstRoots = (normPath: string): string | null => {
    const lowerPath = normPath.toLowerCase();
    for (const root of sortedRoots) {
      const nr = normRoot(root);
      const lowerRoot = nr.toLowerCase();
      if (lowerPath.startsWith(`${lowerRoot}/`) || lowerPath === lowerRoot) {
        return normPath.slice(nr.length).replace(/^\//, '') || null;
      }
    }
    return null;
  };

  // Build body-mention lookup structures once (only when fileNodes provided).
  const relPathSet = new Set<string>();
  let basenameIndex = new Map<string, string[]>();
  if (fileNodes && fileNodes.length > 0) {
    const relPaths = fileNodes.map((n) => n.filePath.replace(/\\/g, '/'));
    for (const p of relPaths) relPathSet.add(p);
    basenameIndex = buildBasenameIndex(relPaths);
  }

  for (const note of notes) {
    // Skip non-conversation notes
    if (!isConvEligibleNoteHtml(note.html)) continue;

    const modifiedRaw =
      note.html.match(/data-cerveau-files-modified\s*=\s*["']([^"']+)["']/i)?.[1] ?? '';
    const readRaw = note.html.match(/data-cerveau-files-read\s*=\s*["']([^"']+)["']/i)?.[1] ?? '';

    const createdRaw = note.html.match(/data-cerveau-created\s*=\s*["']([^"']+)["']/i)?.[1] ?? '';
    const timestamp = createdRaw.slice(0, 10) || new Date().toISOString().slice(0, 10);

    // data-cerveau-cwd — the working directory stored by dream.ts (may be the
    // parent of the actual scanned project when the project folder was decoded
    // from the claude-projects directory name).
    const cwdRaw = note.html.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i)?.[1] ?? '';
    const normCwd = cwdRaw ? normRoot(cwdRaw) : '';

    // Resolve a single stored path token to a file-neuron-relative path.
    // Handles both absolute paths and paths already-relative to data-cerveau-cwd.
    const resolveStoredPath = (stored: string): string | null => {
      const normPath = stored.replace(/\\/g, '/').replace(/\/+/g, '/');

      // Strategy 1: treat as absolute — try direct prefix match against roots.
      const direct = relativiseAgainstRoots(normPath);
      if (direct !== null) return direct;

      // Strategy 2: path looks relative (no drive letter, not starting with '/').
      // Reconstruct absolute by joining cwd + path, then retry.
      const isAbsolute = /^[A-Za-z]:\//.test(normPath) || normPath.startsWith('/');
      if (!isAbsolute && normCwd) {
        const reconstructed = `${normCwd}/${normPath}`;
        return relativiseAgainstRoots(reconstructed);
      }

      return null;
    };

    const filesModified = modifiedRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map(resolveStoredPath)
      .filter((p): p is string => p !== null);

    const filesRead = readRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map(resolveStoredPath)
      .filter((p): p is string => p !== null);

    // Classify text from the note into knowledge items.
    // Use linkedom-based stripTags so HTML entities are decoded before tag
    // removal — prevents &lt;tag&gt; residue from reaching classifyChunk.
    const plainText = stripTags(note.html);

    // Body-mention matching: extract file paths mentioned anywhere in the note
    // body and resolve them unambiguously against known file-neuron paths.
    // Only attempted when fileNodes were provided (i.e. we have a file index).
    const filesBodyMentions: string[] =
      relPathSet.size > 0 ? buildBodyMentions(plainText, relPathSet, basenameIndex) : [];

    // Skip the note if it has no file evidence at all (tool-trace AND body).
    if (filesModified.length === 0 && filesRead.length === 0 && filesBodyMentions.length === 0)
      continue;

    const bucket: EnrichmentBucket = emptyBucket();
    const chunks = splitIntoSentenceChunks(plainText).filter(
      (s) => s.trim().length > 20 && s.trim().length < 500,
    );

    for (const chunk of chunks.slice(0, 30)) {
      classifyChunk(chunk, note.id, bucket);
    }

    const items: ConvKnowledgeItem[] = [
      ...bucket.decisions.map((d) => ({
        kind: 'decision' as ItemKind,
        text: d.text,
        sourceId: d.sourceId,
      })),
      ...bucket.bugs.map((b) => ({ kind: 'bug' as ItemKind, text: b.text, sourceId: b.sourceId })),
      ...bucket.ideas.map((i) => ({
        kind: 'idea' as ItemKind,
        text: i.text,
        sourceId: i.sourceId,
      })),
      ...bucket.rules.map((r) => ({
        kind: 'rule' as ItemKind,
        text: r.text,
        sourceId: r.sourceId,
      })),
      ...bucket.qa.map((q) => ({ kind: 'qa' as ItemKind, text: q.question, sourceId: q.sourceId })),
      ...bucket.warnings.map((w) => ({
        kind: 'warning' as ItemKind,
        text: w.text,
        sourceId: w.sourceId,
      })),
    ];

    // When no pattern-matched items exist but the conv DID modify known files
    // or mention them in its body, synthesise a minimal "activity" item from
    // the first meaningful prose chunk.  The act of editing a file is itself
    // evidence worth recording — without this fallback, any conversation that
    // only "updated", "refactored", or "added" code (without using a classifier
    // keyword) produces zero items and is silently dropped.
    const hasAnyFileEvidence = filesModified.length > 0 || filesBodyMentions.length > 0;

    if (items.length === 0 && hasAnyFileEvidence) {
      const firstChunk = chunks.find((c) => c.trim().length >= 20);
      // Guard: do not synthesise an activity item from agent meta-noise or
      // LazyBrain note-metadata residue.
      if (
        firstChunk &&
        !isAgentMetaText(firstChunk.trim()) &&
        !isNoteMetadataResidue(firstChunk.trim())
      ) {
        items.push({
          kind: 'activity' as ItemKind,
          text: firstChunk.trim().slice(0, 300),
          sourceId: note.id,
        });
      }
    }

    if (items.length === 0) continue;

    convNotes.push({
      id: note.id,
      filesModified,
      filesRead,
      filesBodyMentions,
      timestamp,
      classifiedItems: items,
    });
  }
  return convNotes;
}

/**
 * Orchestrate the conv→file-neuron enrichment pass within runEnrich.
 * Reads existing file-neuron notes and conversation notes from the store,
 * then delegates to runFileNeuronEnrichment.
 */
async function runConvFileNeuronEnrichment(
  allNotes: NoteFile[],
  _opts: EnrichOptions,
): Promise<{ fileNeuronsEnriched: number; conceptNeuronsCreated: number; errors: string[] }> {
  // Build CodeNode stubs from stored file-neuron notes
  const fileNodes = extractFileNeuronStubs(allNotes);
  if (fileNodes.length === 0) {
    return { fileNeuronsEnriched: 0, conceptNeuronsCreated: 0, errors: [] };
  }

  // Collect unique project roots from file-neuron stubs
  const projectRoots = [...new Set(fileNodes.map((n) => n.projectRoot))];

  // Build conv notes — pass fileNodes so body-mention matching is enabled.
  // This widens coverage to the ~1480 notes that have no tool-trace file attrs
  // but may mention file paths in their body text.
  const convNotes = buildConvNotes(allNotes, projectRoots, fileNodes);
  if (convNotes.length === 0) {
    return { fileNeuronsEnriched: 0, conceptNeuronsCreated: 0, errors: [] };
  }

  // Use the first project root as the representative (multi-project would need
  // separate calls; for now, the node lookup inside runFileNeuronEnrichment handles
  // routing correctly since each node carries its own projectRoot).
  const projectRoot = projectRoots[0];

  return runFileNeuronEnrichment({ projectRoot, fileNodes, convNotes });
}

// ---------------------------------------------------------------------------
// Incremental enrichment — runs after every capture/session, not only weekly
// ---------------------------------------------------------------------------

/** Persisted checkpoint: only conv notes newer than this are (re)classified. */
interface EnrichState {
  lastRunMs: number;
}

/**
 * Minimum gap between two incremental runs. A burst of captures (many tool
 * calls in a row) triggers `runIncrementalEnrich` once per capture, but each
 * call still pays for a `readAllNotes()` directory scan — this throttle
 * bounds that cost to at most once per window regardless of burst rate.
 * `force: true` (used by the capture-queue flush / PreCompact path) bypasses it.
 */
const MIN_INCREMENTAL_INTERVAL_MS = 10_000;

function enrichStatePath(): string {
  return join(getConfig().cachePath, 'enrich-state.json');
}

function loadEnrichState(): EnrichState {
  try {
    const raw = readFileSync(enrichStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<EnrichState>;
    return { lastRunMs: typeof parsed.lastRunMs === 'number' ? parsed.lastRunMs : 0 };
  } catch {
    return { lastRunMs: 0 };
  }
}

function saveEnrichState(state: EnrichState): void {
  try {
    writeFileSync(enrichStatePath(), JSON.stringify(state), 'utf8');
  } catch {
    // best-effort — worst case the next run's delta is a bit wider than necessary
  }
}

export interface IncrementalEnrichReport {
  status: 'ok' | 'skipped' | 'throttled';
  fileNeuronsEnriched: number;
  conceptNeuronsCreated: number;
  errors: string[];
}

const NOOP_REPORT = (status: IncrementalEnrichReport['status']): IncrementalEnrichReport => ({
  status,
  fileNeuronsEnriched: 0,
  conceptNeuronsCreated: 0,
  errors: [],
});

/**
 * Incremental conv→file-neuron enrichment: processes only conversation notes
 * written since the last run (checkpoint persisted in
 * `<cache>/enrich-state.json`), so it is cheap enough to call after every
 * capture flush instead of only from the weekly /maintenance job.
 *
 * Non-destructive: runFileNeuronEnrichment merges freshly classified items
 * with whatever is already attached to each touched file-neuron (parsed back
 * from its rendered HTML — graph/file-neuron-parse.ts), so file-neurons
 * untouched by this run's delta — and kinds within a touched file-neuron that
 * got no new items — keep their existing decisions/bugs/ideas/rules/qa/
 * activities exactly as they were.
 *
 * Resilient: NEVER throws. Every failure is caught, logged, and reported in
 * `errors` — callers (capture.ts, capture-vibe.ts) treat this as fire-and-
 * forget best-effort so a broken enrich pass can never break capture.
 *
 * The checkpoint is captured BEFORE reading notes (not after processing), so
 * a note written concurrently with this run is never skipped — worst case it
 * is reprocessed once more than strictly necessary, which mergeWithExisting's
 * exact-text dedup already makes harmless.
 */
export async function runIncrementalEnrich(
  opts: { force?: boolean } = {},
): Promise<IncrementalEnrichReport> {
  const log = getLogger();
  try {
    const state = loadEnrichState();
    const runStartedMs = Date.now();

    if (!opts.force && runStartedMs - state.lastRunMs < MIN_INCREMENTAL_INTERVAL_MS) {
      return NOOP_REPORT('throttled');
    }

    const allNotes = readAllNotes();
    const fileNodes = extractFileNeuronStubs(allNotes);
    if (fileNodes.length === 0) {
      // Nothing to enrich yet (no code scan has run) — still advance the
      // checkpoint so we don't rescan the same empty state every capture.
      saveEnrichState({ lastRunMs: runStartedMs });
      return NOOP_REPORT('skipped');
    }

    const projectRoots = [...new Set(fileNodes.map((n) => n.projectRoot))];
    // The actual incremental optimisation: only conversation notes touched
    // since the last checkpoint are classified/routed — NOT the whole corpus.
    const deltaNotes = allNotes.filter((n) => n.mtimeMs > state.lastRunMs);
    const convNotes = buildConvNotes(deltaNotes, projectRoots, fileNodes);

    if (convNotes.length === 0) {
      saveEnrichState({ lastRunMs: runStartedMs });
      return NOOP_REPORT('skipped');
    }

    const projectRoot = projectRoots[0];
    const result = await runFileNeuronEnrichment({ projectRoot, fileNodes, convNotes });
    saveEnrichState({ lastRunMs: runStartedMs });

    if (result.errors.length > 0) {
      log.warn({ errors: result.errors }, 'incremental enrich: completed with errors');
    }
    log.debug(
      {
        fileNeuronsEnriched: result.fileNeuronsEnriched,
        conceptNeuronsCreated: result.conceptNeuronsCreated,
        deltaNotes: deltaNotes.length,
      },
      'incremental enrich: done',
    );
    return { status: 'ok', ...result };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn({ err: msg }, 'incremental enrich: failed (non-fatal, capture unaffected)');
    return { ...NOOP_REPORT('skipped'), errors: [msg] };
  }
}

/** Test-only: reset the incremental-enrich checkpoint so a test run is never throttled. */
export function resetEnrichStateForTests(): void {
  try {
    if (existsSync(enrichStatePath())) {
      writeFileSync(enrichStatePath(), JSON.stringify({ lastRunMs: 0 }), 'utf8');
    }
  } catch {
    /* best-effort */
  }
}
