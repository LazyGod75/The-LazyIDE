/**
 * Meaningful-content gate helpers.
 *
 * These helpers are used both by the chunk-level filter in claude-code.ts and by the
 * note-level detectNoise pass in dream.ts, so they live here (noise.ts) to avoid a
 * circular import.
 */

// ---------------------------------------------------------------------------
// B2 — Demo-fixture exclusion and user-configurable ignore patterns
// ---------------------------------------------------------------------------

/**
 * Detect chunks that reference the engine's bundled demo fixtures.
 *
 * The LazyBrain demo brain uses fixtures under demo/data/notes/ with IDs
 * prefixed "acme-conv-" and "acme-project-".  When a dev session reads those
 * fixture files the conversation chunks contain paths/IDs from the demo, and
 * dream would ingest them into the user's real brain.
 *
 * This filter applies even when LAZYBRAIN_DREAM_INCLUDE_SELF=1: the flag opts
 * in to ingesting LazyBrain's own dev sessions, but demo-fixture content is
 * never real knowledge, regardless of that flag.
 */
export function isDemoFixtureContent(text: string): boolean {
  return /acme-conv-/i.test(text) || /acme-project-/i.test(text) || /demo\/data\/notes/i.test(text);
}

/**
 * Build compiled user-configurable ignore patterns from LAZYBRAIN_IGNORE_PATTERNS.
 *
 * The env var is a comma-separated list of regex strings.  Each pattern is
 * compiled once; invalid regexes are silently skipped with a debug log so they
 * never crash the ingestion pipeline.
 *
 * Returns an empty array when the env var is absent or empty.
 */
export function buildIgnorePatterns(rawEnv?: string): RegExp[] {
  const raw = rawEnv ?? process.env.LAZYBRAIN_IGNORE_PATTERNS ?? '';
  if (!raw.trim()) return [];

  const patterns: RegExp[] = [];
  for (const part of raw.split(',')) {
    const pattern = part.trim();
    if (!pattern) continue;
    try {
      patterns.push(new RegExp(pattern, 'i'));
    } catch {
      // Invalid regex — log at debug level and continue; never crash.
      // Using console.debug rather than a logger import to keep noise.ts
      // free from circular deps (it is imported by claude-code.ts).
      process.stderr.write(
        `[lazybrain] LAZYBRAIN_IGNORE_PATTERNS: invalid regex skipped: ${pattern}\n`,
      );
    }
  }
  return patterns;
}

/** Cached compiled ignore patterns (reset when env var changes — lazy rebuild). */
let _cachedIgnorePatterns: RegExp[] | null = null;
let _cachedIgnorePatternsEnv: string | undefined = undefined;

/**
 * Return the current compiled ignore patterns, rebuilding the cache if the
 * LAZYBRAIN_IGNORE_PATTERNS env var has changed since last call.
 */
function getIgnorePatterns(): RegExp[] {
  const current = process.env.LAZYBRAIN_IGNORE_PATTERNS;
  if (_cachedIgnorePatterns === null || _cachedIgnorePatternsEnv !== current) {
    _cachedIgnorePatterns = buildIgnorePatterns(current);
    _cachedIgnorePatternsEnv = current;
  }
  return _cachedIgnorePatterns;
}

/**
 * Returns true when the text matches any user-configured ignore pattern from
 * LAZYBRAIN_IGNORE_PATTERNS.
 */
export function matchesIgnorePattern(text: string): boolean {
  for (const re of getIgnorePatterns()) {
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Returns true when the chunk should be dropped as noise due to:
 *   - Demo fixture content (acme-conv-*, acme-project-*, demo/data/notes paths)
 *   - User-configured LAZYBRAIN_IGNORE_PATTERNS matches
 *
 * This is called from hasMeaningfulContent's callers (claude-code.ts chunk gate
 * and dream.ts detectNoise) after the structural noise checks.
 */
export function isConfigurableNoise(text: string): boolean {
  if (isDemoFixtureContent(text)) return true;
  if (matchesIgnorePattern(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// D2 — CI/build-output fragment detection
// ---------------------------------------------------------------------------

// Pattern for exit-code key-value pairs like "build_exit=0", "lint_exit=1".
const EXIT_CODE_RE = /\b\w+_exit=\d+\b/g;

// Pattern for numbered build-step dump lines like "  1. some-step" or "  12. lint-step".
const BUILD_STEP_LINE_RE = /^\s*\d+\.\s+[\w-]+/;

// Prose sentence heuristic: a line has prose when it contains a "sentence-like" structure.
// Requires at least one word of 7+ characters (a substantive token, not a connector like
// "gates", "done", "build") AND 4+ alphabetic words total.
// This prevents short status-label strings like "gates done build complete" from
// being misclassified as prose.
const PROSE_LONG_WORD_RE = /\b[a-zA-Z]{7,}\b/;
const PROSE_LINE_RE = /\b[a-zA-Z]{3,}\b.*\b[a-zA-Z]{3,}\b.*\b[a-zA-Z]{3,}\b.*\b[a-zA-Z]{3,}\b/;

/**
 * Returns true when the chunk is dominated by CI/build exit-code output.
 *
 * Pattern D2.1: chunks where /\w+_exit=\d+/ occurs 3+ times with no
 * sentence-like prose around them are pure build gate output.
 * Example: "build_exit=0 typecheck_exit=0 lint_exit=1 tests_exit=0 gates done"
 */
export function isBuildExitDump(text: string): boolean {
  const matches = text.match(EXIT_CODE_RE);
  if (!matches || matches.length < 3) return false;

  // Allow the chunk if there is at least one substantive prose line alongside the exit codes.
  // A prose line must have 4+ alphabetic words AND at least one word of 7+ characters
  // (a substantive token like "decided", "migration", "authentication" — not short labels
  // like "gates", "done", "build", "complete" that appear in CI status strings).
  const lines = text.split('\n');
  for (const line of lines) {
    const stripped = line.replace(EXIT_CODE_RE, '');
    if (PROSE_LINE_RE.test(stripped) && PROSE_LONG_WORD_RE.test(stripped)) return false;
  }
  return true;
}

/**
 * Returns true when the chunk is a numbered build-step dump with no prose.
 *
 * Pattern D2.2: 5+ lines matching /^\s*\d+\.\s+[\w-]+/ with no prose lines
 * are pure step-list output from CI runners or task executors.
 *
 * A "prose line" is one whose non-step-label content contains 4+ alphabetic words.
 * We strip the leading "N. step-name" prefix before the prose check so that a
 * step line that ALSO contains a prose description is counted as prose, not as
 * a pure step-dump entry.
 */
export function isNumberedBuildStepDump(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 5) return false;

  let stepLineCount = 0;
  let proseLineCount = 0;
  for (const line of lines) {
    if (BUILD_STEP_LINE_RE.test(line)) {
      stepLineCount++;
      // Also check for prose content after the step label.
      // Strip "N. step-name" prefix and test what remains.
      const afterPrefix = line.replace(/^\s*\d+\.\s+[\w-]+/, '').trim();
      if (
        afterPrefix.length > 0 &&
        PROSE_LINE_RE.test(afterPrefix) &&
        PROSE_LONG_WORD_RE.test(afterPrefix)
      ) {
        proseLineCount++;
      }
    } else if (PROSE_LINE_RE.test(line) && PROSE_LONG_WORD_RE.test(line)) {
      proseLineCount++;
    }
  }

  // Classify as a dump only when step lines dominate and prose is absent.
  return stepLineCount >= 5 && proseLineCount === 0;
}

/**
 * Returns true when the text represents CI/build output that should not be
 * stored as knowledge.
 *
 * Combines D2.1 (exit-code dump) and D2.2 (numbered step dump) checks.
 */
export function isBuildOutputNoise(text: string): boolean {
  return isBuildExitDump(text) || isNumberedBuildStepDump(text);
}

// ---------------------------------------------------------------------------
// D3 — Shell-diagnostic / JSON-dump detection
// ---------------------------------------------------------------------------

// Script/diagnostic section banner: "=== some label ===".  These mark the
// boundaries of a shell-script diagnostic step (e.g. "=== brain path / stats ===").
const DIAGNOSTIC_BANNER_RE = /={3,}[^=\n]{1,120}={3,}/g;

// JSON key tokens: `"key":` — the dominant signal of a captured JSON dump.
const JSON_KEY_RE = /"[^"\n]{1,60}"\s*:/g;

// Environment / key-value assignment tokens: `WORD=value` (env-var style).
const ENV_ASSIGN_RE = /\b[A-Za-z_][A-Za-z0-9_]*=\S/g;

// Structural JSON punctuation density (braces + brackets).
const JSON_BRACE_RE = /[{}[\]]/g;

// Generic LazyBrain index-text scaffolding (NOT prose): the infobox metadata
// line, section markers and the synthetic [tokens] line emitted by the indexer
// for every note.  These are machine labels common to ALL notes — they must be
// removed before measuring "surviving prose" so they don't mask a pure dump.
// Order matters: strip the [tokens] line (to end-of-line) before other markers.
const INDEX_SCAFFOLDING_RES: readonly RegExp[] = [
  /\[tokens\][^\n]*/gi, // synthetic token line: "[tokens] foo bar baz"
  /\[(?:tldr|tool_trace|summary|reasoning|qa|facts|references|see-also)\]/gi,
  /\b(?:Type|Status|Tags|Source|Tool|Confidence|Importance|Categories|Kind|Files|Lines):/gi,
  /Bash run recorded\./gi,
];

/**
 * Returns true when the text is a captured shell-diagnostic / JSON-dump note:
 * a chunk dominated by script-banner markers and JSON/key-value output with
 * little or no substantive prose.
 *
 * This catches notes auto-captured from a Bash run whose output is a diagnostic
 * dump (banner-delimited steps + a JSON stats object + env-var lines) rather
 * than real knowledge.  The classic failure mode is a session-log note that
 * mirrors a diagnostic command's stdout and dominates recall by exact keyword
 * match even though it carries no durable fact.
 *
 * GATE (all required — conservative to avoid false positives):
 *   1. At least one "=== ... ===" diagnostic banner is present.
 *   2. High structural density: (JSON `"key":` pairs) + (env-var assignments)
 *      together reach STRUCTURAL_MIN, AND JSON braces/brackets reach BRACE_MIN.
 *   3. The dump tokens (banners + JSON keys/braces + env assignments) dominate
 *      the note: the share of words that survive once those tokens are stripped
 *      is below PROSE_SHARE_MAX.  A note with a real prose paragraph alongside
 *      the dump keeps too many surviving words and is preserved.
 *
 * Calibrated against real Bash-captured notes so that genuine notes are kept:
 *   - a code-diff note with a "=== file diff ===" banner but real prose → KEPT
 *     (surviving prose share too high → gate 3 fails)
 *   - a multi-banner shell diagnostic that ends in a real conclusion → KEPT
 *     (low JSON density → gate 2 fails)
 *   - a captured meta.json with marketing copy but no banner → KEPT
 *     (gate 1 fails)
 *
 * @param text Raw or stripped note text.
 */
export function isShellDiagnosticDump(text: string): boolean {
  const banners = text.match(DIAGNOSTIC_BANNER_RE);
  if (!banners || banners.length < 1) return false;

  // Density thresholds — calibrated against real captured dumps.
  const STRUCTURAL_MIN = 4; // combined JSON keys + env assignments
  const BRACE_MIN = 4; // JSON braces/brackets
  // Max share of words that may remain after stripping all dump tokens for the
  // note to still count as a pure dump.  Real notes carry a substantive prose
  // paragraph and exceed this; the diagnostic dump leaves only stray fragments.
  const PROSE_SHARE_MAX = 0.4;

  const jsonKeys = (text.match(JSON_KEY_RE) ?? []).length;
  const envAssigns = (text.match(ENV_ASSIGN_RE) ?? []).length;
  const braces = (text.match(JSON_BRACE_RE) ?? []).length;

  const structural = jsonKeys + envAssigns;
  if (structural < STRUCTURAL_MIN) return false;
  if (braces < BRACE_MIN) return false;

  // Gate 3 — dump tokens dominate.  First remove generic index scaffolding
  // (infobox/section/token labels that every note carries), then strip banners,
  // JSON key/value punctuation, env assignments, braces and bare numbers, and
  // measure how much real "prose" survives relative to the de-scaffolded base.
  let base = text;
  for (const re of INDEX_SCAFFOLDING_RES) base = base.replace(re, ' ');

  const totalWords = countAlphanumericWords(base);
  if (totalWords === 0) return false;

  const deDumped = base
    .replace(DIAGNOSTIC_BANNER_RE, ' ')
    .replace(JSON_KEY_RE, ' ')
    .replace(ENV_ASSIGN_RE, ' ')
    .replace(JSON_BRACE_RE, ' ')
    // Filesystem paths (Windows + POSIX) and long hex/session ids are machine
    // residue, not prose — strip them so a dump full of paths/ids isn't mistaken
    // for substantive text.  These are universal across any captured shell dump.
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, ' ') // Windows absolute paths
    .replace(/(?:[\\/][\w.-]+){2,}/g, ' ') // POSIX-ish path segments
    .replace(/\b[0-9a-f]{6,}\b/gi, ' ') // long hex tokens (hashes/session ids)
    .replace(/["',:;]/g, ' ')
    .replace(/\b\d[\d.]*\b/g, ' ');

  const survivingWords = countAlphanumericWords(deDumped);
  return survivingWords / totalWords < PROSE_SHARE_MAX;
}

/**
 * Count the number of alphanumeric words in a string.
 * A "word" is a token that starts with a letter or digit (min length 2).
 * Returns the count.
 */
export function countAlphanumericWords(text: string): number {
  const words = text.match(/\b[a-zA-Z0-9][a-zA-Z0-9'_-]*\b/g);
  return words ? words.length : 0;
}

/**
 * Returns true if the non-whitespace content is mostly punctuation/symbols.
 * Threshold: alphanumeric characters < 40% of non-whitespace characters.
 */
export function isMostlyPunctuation(text: string): boolean {
  const noSpace = text.replace(/\s/g, '');
  if (noSpace.length === 0) return true;
  const alphanumCount = (noSpace.match(/[a-zA-Z0-9]/g) ?? []).length;
  return alphanumCount / noSpace.length < 0.4;
}

/**
 * Returns true if a single repeated line dominates > 60% of the non-trivial lines.
 * Catches boilerplate that is copy-pasted multiple times in the same chunk.
 */
export function isDominatedByRepetition(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 10);
  if (lines.length < 4) return false;

  const freq = new Map<string, number>();
  for (const line of lines) {
    const key = line.slice(0, 80);
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  const maxCount = Math.max(...freq.values());
  return maxCount / lines.length > 0.6;
}

/**
 * Quick check: does the text contain enough meaningful content to be worth storing?
 *
 * Returns false (not meaningful) when:
 *   - Fewer than 8 alphanumeric words
 *   - Mostly punctuation/symbols (< 40% alphanumeric chars)
 *   - Dominated by a single repeated block (> 60% of lines are the same)
 *
 * @param text Raw or trimmed text.
 */
export function hasMeaningfulContent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 30) return false;
  if (countAlphanumericWords(trimmed) < 8) return false;
  if (isMostlyPunctuation(trimmed)) return false;
  if (isDominatedByRepetition(trimmed)) return false;
  return true;
}

/**
 * Conservative filter for obvious agent meta-commentary that should never enter
 * the knowledge store.
 *
 * Matches generic structural markers emitted by agent frameworks and orchestration
 * systems (progress summaries, XML-style observation blocks, memory-agent headers,
 * memory-observer instruction templates, bare XML schema-tag residue).
 * Only drops text that is unambiguously meta — not regular prose that happens to
 * contain these words in passing. When in doubt, keep the text (false negatives are
 * cheaper than false positives that destroy real knowledge).
 *
 * @param text Raw text chunk to evaluate (may be trimmed or untrimmed).
 * @returns true if the chunk is agent/framework scaffolding that should be discarded.
 */
export function isAgentMetaText(text: string): boolean {
  const trimmed = text.trim();

  // Fenced progress/mode-switch banners: "--- SOME HEADING ---"
  // These are emitted by agent orchestrators to mark phase transitions and
  // are never substantive prose.
  if (/^-{3,}\s*[A-Z][A-Z\s:]+[A-Z]\s*-{3,}/.test(trimmed)) return true;

  // XML-style agent observation/thinking blocks (opening tags).
  // These open structural sections inside claude-mem / memory-observer frameworks;
  // the tag itself — or a chunk starting with it — is scaffolding, not knowledge.
  if (
    /^<\/?(observation|thinking|reflection|memory[_-]?update|fact|status|title|summary|entry|note)\s*[\s>/]/i.test(
      trimmed,
    )
  )
    return true;

  // Chunks that are NOTHING but XML schema-tag residue (closing-tag fragments left
  // after HTML stripping), optionally followed by punctuation/whitespace.
  // Example: "</fact>." or "</status>." or "<observation>".
  // We only drop the chunk when the ENTIRE trimmed content is such a tag — not when
  // a real sentence merely contains an XML word somewhere.
  if (
    /^[<>/\s.]*<\/?\s*(fact|status|title|observation|thinking|note|summary|entry)\s*>[.\s]*$/i.test(
      trimmed,
    )
  )
    return true;

  // Memory-observer instruction templates (claude-mem-style system prompts).
  // "CRITICAL: Record what was LEARNED/BUILT/fixed/deployed/configured" is the
  // canonical phrasing of a memory-observer prompt injected by agent harnesses.
  // It is never real prose: no human or LLM response says "record what was built"
  // as a factual claim about the domain.
  if (/record\s+what\s+was\s+(?:learned|built|fixed|deployed|configured)/i.test(trimmed))
    return true;

  // Memory-agent self-introduction patterns: "hello memory agent", "observing the primary".
  if (/\bhello\s+(memory|brain|agent)\b/i.test(trimmed)) return true;
  if (/\bobserving\s+the\s+primary\b/i.test(trimmed)) return true;

  // Claude Code / agent-harness output: Stop hook feedback line.
  // This is the literal harness-generated phrase prepended to hook failure messages
  // and never appears in legitimate domain prose.
  if (/\bStop hook feedback\b/i.test(trimmed)) return true;

  // Claude Code / agent-harness mandatory-tool instruction.
  // The full harness phrase "call the StructuredOutput tool to complete" is unique
  // to the harness scaffolding; bare "StructuredOutput" alone is intentionally
  // NOT matched because it can legitimately appear in LLM-tooling prose.
  if (/call the StructuredOutput tool to complete/i.test(trimmed)) return true;

  // Placeholder / template residue from retrieval-augmented generation prompts.
  // These patterns originate from a prompt-injection attack where a recall prompt
  // ("You write a short fictional memory note…") leaked into conversation text and
  // was stored as a real brain note. They are self-referential meta-instructions,
  // never domain knowledge.
  if (isPlaceholderNoise(trimmed)) return true;

  // LazyBrain note infobox residue — machine-format metadata that leaked into text.
  // These patterns mirror isNoteMetadataResidue() in enrich.ts (kept inline here to
  // avoid a circular import: enrich.ts already imports from dream.ts).
  //
  // Pattern 1: "Source session:<word>-<6+hex>" — unique LazyBrain session id.
  if (/Source\s+session:[a-z]+-[0-9a-f]{6,}/i.test(trimmed)) return true;
  // Pattern 2: "Type <kind> Status <state>" infobox — strict adjacency, known kinds.
  if (
    /^(?:\d{4}-\d{2}-\d{2}\s+)?Type\s+(?:episodic|reference|semantic|decision|architecture|feature|feature-set)\s+Status\s+(?:active|deprecated|draft)\b/i.test(
      trimmed,
    )
  )
    return true;
  // Pattern 3: "Type <word> Status <word> Tags" triplet — general infobox form.
  if (/^\s*Type\s+\w[\w-]*\s+Status\s+\w[\w-]*\s+Tags\b/i.test(trimmed)) return true;
  // Pattern 4: "Kind <x> Files <n> Lines <n>" — file-neuron / aggregate-neuron infobox.
  if (/\bKind\s+\w[\w-]*\s+Files\s+\d+\s+Lines\s+\d+\b/i.test(trimmed)) return true;
  // Pattern 5: "Type: X | Status: Y" — the CURRENT retrieval/strip.ts infobox
  // flattening (colon + " | " joins), distinct from the space-separated triplet
  // in pattern 3. Kept in sync with isNoteMetadataResidue()'s own pattern 5.
  if (/^\s*Type:\s*\S[\w-]*\s*\|\s*Status:\s*\S[\w-]*\b/i.test(trimmed)) return true;

  // Scheduled-task / automation boilerplate — the literal harness preamble injected
  // before every automated (unattended) skill run. This text is never domain knowledge.
  if (/This\s+is\s+an\s+automated\s+run\s+of\s+a\s+scheduled\s+task/i.test(trimmed)) return true;
  if (/<scheduled-task\s+name=/i.test(trimmed)) return true;
  if (/execute\s+autonomously\s+without\s+asking\s+clarifying\s+questions/i.test(trimmed))
    return true;
  // "The user is not present" — unique phrase in the scheduled-task wrapper
  if (/The\s+user\s+is\s+not\s+present\s+to\s+answer\s+questions/i.test(trimmed)) return true;

  // Claude Code local-command injection block: the harness injects a
  // <local-command-caveat> XML wrapper around slash-command output before passing
  // it to the model. When this leaks into the conversation transcript it starts
  // with the literal caveat tag or the "DO NOT respond to these messages" directive.
  // This is pure scaffolding — never domain knowledge.
  if (/<local-command-caveat>/i.test(trimmed)) return true;
  if (
    /DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to/i.test(
      trimmed,
    )
  )
    return true;

  // Generic "AUTOMATED TASK:" prefix used by agent harnesses for pre-authorised
  // actions.  The English form is a framework artifact seen across all Claude Code
  // deployments.  The French "TÂCHE AUTOMATISÉE" was a single user's phrasing and
  // has been removed — it belongs in a per-brain user-configurable ignore list.
  if (/AUTOMATED\s+TASK\s*[:/]/i.test(trimmed)) return true;

  // JSON null / bare JSON fragment titles: `": null.` or `": null` appearing
  // as the ENTIRE note content is a JSON extraction artefact, not real prose.
  // Guard: only when the trimmed content is short (<= 20 chars) to avoid
  // false-positives on real technical notes that mention null values.
  if (/^["']?\s*:\s*null\.?\s*$/.test(trimmed)) return true;

  // Rate-limit / billing residue that appears in Claude.ai UI captures.
  // Generalised to catch all model-specific variants:
  //   "You've hit your limit"
  //   "You've hit your session limit"
  //   "You've hit your Sonnet limit"
  //   "You've hit your Opus limit"
  //   "You've hit your usage limit"
  //   … and any close variant up to 20 extra chars between "your" and "limit".
  // Deliberately NOT triggered by prose like "hit the rate limit" (no "You've" prefix).
  if (/You.{0,10}ve\s+hit\s+your\s+.{0,20}limit/i.test(trimmed)) return true;
  // "resets 12am (…)" / "resets at 3pm" tail — always billing UI, never domain prose.
  if (/resets\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(trimmed)) return true;

  // -------------------------------------------------------------------------
  // STRONG MACHINERY SIGNATURES — position-independent, no length cap.
  //
  // These phrases essentially never appear in genuine human/assistant insight.
  // A single occurrence ANYWHERE in the note is sufficient to drop it.
  // Do NOT add weak or common phrases here — only unambiguous machine signatures.
  // -------------------------------------------------------------------------

  // Pattern A — TLDR-extraction prompt (757 measured notes).
  // The canonical Haiku TLDR prompt emits one of:
  //   • `Output a JSON array with one object: {"tldr"`
  //   • `{tldr` / `{"tldr"` (JSON residue anywhere in note)
  //   • `"topic":` adjacent to JSON punctuation (schema residue)
  //   • `Respond with JSON`
  // These are STRONG signatures — safe to match anywhere in the text regardless
  // of total note length.  Real technical notes that "mention JSON arrays" in
  // prose are preserved because they lack these exact multi-word phrases.
  if (/Output\s+(?:a\s+)?JSON\s+array\s+with\s+one\s+object/i.test(trimmed)) return true;
  if (/\{["']?tldr["']?\s*:/i.test(trimmed)) return true;
  if (/Respond\s+with\s+(?:a\s+)?JSON\b/i.test(trimmed)) return true;

  // Pattern B — "No prose." instruction suffix (strong; part of the TLDR prompt).
  // Only matched when the phrase ends the note body; use a small context guard
  // (300 chars) to avoid false positives in long genuine notes that quote the phrase.
  if (/\bNo\s+prose\.\s*$/i.test(trimmed) && trimmed.length < 300) return true;

  // Pattern C — Eval / benchmark harness (80 measured notes).
  // "compare the gold answer" is a distinctive eval-harness phrase.
  if (/compare\s+the\s+gold\s+answer/i.test(trimmed)) return true;

  // Pattern D — Raw agent observation XML tags (65 measured notes).
  // `<observed_from_primary_session>`, `<observed_from_*>`, and similar
  // structured agent-observation tags that appear when memory-observer output
  // leaks verbatim into the conversation.  These are pure scaffolding.
  if (/<observed_from_[a-z_]+\s*>/i.test(trimmed)) return true;

  // -------------------------------------------------------------------------
  // GENERIC ONLY. These must be framework artifacts (Claude Code / superpowers /
  // claude-mem) or LazyBrain's own engine prompts that EVERY user would have.
  // NEVER hardcode a user's project names or their content prompts — the filter
  // must work for everyone. User-specific noise belongs in a per-brain
  // user-configurable ignore list, not here.
  // -------------------------------------------------------------------------

  // Pattern E — Superpowers skill preamble (26 + 17 measured notes).
  // "Base directory for this skill:", "SUBAGENT-STOP", "skip this skill", and
  // "If you were dispatched as a subagent" are canonical phrases injected at the
  // top of every skill file preamble.  They never appear in genuine insight notes.
  if (/Base\s+directory\s+for\s+this\s+skill\b/i.test(trimmed)) return true;
  if (/\bSUBAGENT-STOP\b/.test(trimmed)) return true;
  if (/skip\s+this\s+skill\b/i.test(trimmed)) return true;
  if (/If\s+you\s+were\s+dispatched\s+as\s+a\s+subagent\b/i.test(trimmed)) return true;

  // Pattern G — HyDE (Hypothetical Document Embedding) prompt residue.
  // Already caught by isPlaceholderNoise; duplicated here for defence-in-depth.
  if (
    /you\s+write\s+a\s+short\s+fictional\s+memory\s+note\s+that\s+hypothetically\s+answers/i.test(
      trimmed,
    )
  )
    return true;

  return false;
}

/**
 * Detect self-referential placeholder / template noise that should never be stored.
 *
 * This catches text fragments that come from prompt-injection residue where a
 * retrieval-augmented generation prompt (e.g. the "recall" skill's instruction to
 * write a fictional memory note) leaked into the conversation and was captured as
 * a real brain note.
 *
 * Patterns matched (all require a distinctive phrase, NOT individual common words):
 *  - "a real note on this topic would (mention|ment)" — canonical placeholder ending
 *  - "strings,? decisions that" — the distinctive prompt lead-in phrase
 *  - "you write a short fictional (memory )?note" — the system-prompt instruction line
 *  - "output only the note body" — canonical instruction suffix in the same prompt
 *  - "hypothetically answers the user's search query" — unique phrase in the prompt
 *  - "concrete vocabulary: include the named entities" — unique instruction phrase
 *
 * Deliberately NOT matched: "decision", "note", "strings", "topic" in isolation —
 * those are common domain words. Only the exact multi-word phrases are matched.
 *
 * @param text Already-trimmed text to test.
 * @returns true when the text is template/placeholder noise.
 */
export function isPlaceholderNoise(text: string): boolean {
  // "a real note on this topic would mention" (allow "ment" as truncated form)
  if (/a real note on this topic would\s+ment/i.test(text)) return true;

  // "strings, decisions that" — the distinctive prompt preamble
  if (/strings,?\s+decisions that/i.test(text)) return true;

  // The fictional-note instruction line from the RAG recall prompt
  if (/you write a short fictional\s+(?:memory\s+)?note/i.test(text)) return true;

  // "output only the note body" — canonical closing instruction
  if (/output\s+only\s+the\s+note\s+body/i.test(text)) return true;

  // "hypothetically answers the user's search query" — unique phrase
  if (/hypothetically\s+answers\s+the\s+user.{0,5}s\s+search\s+query/i.test(text)) return true;

  // "concrete vocabulary: include the named entities" — unique phrase
  if (/concrete\s+vocabulary:\s+include\s+the\s+named\s+entities/i.test(text)) return true;

  return false;
}
