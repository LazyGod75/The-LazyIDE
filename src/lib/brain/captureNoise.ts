/**
 * captureNoise.ts — Noise gate for the brain capture system.
 *
 * Pure functions, no platform/Tauri imports, no console.log.
 * Ported from LazyBrain/src/sources/noise.ts.
 */

// ── D2: CI/build-output fragment detection ────────────────────────

// Pattern for exit-code key-value pairs like "build_exit=0", "lint_exit=1".
const EXIT_CODE_RE = /\b\w+_exit=\d+\b/g;

// Pattern for numbered build-step dump lines like "  1. some-step" or "  12. lint-step".
const BUILD_STEP_LINE_RE = /^\s*\d+\.\s+[\w-]+/;

// Prose sentence heuristic: a line has prose when it contains a "sentence-like" structure.
// Requires at least one word of 7+ characters AND 4+ alphabetic words total.
const PROSE_LONG_WORD_RE = /\b[a-zA-Z]{7,}\b/;
const PROSE_LINE_RE = /\b[a-zA-Z]{3,}\b.*\b[a-zA-Z]{3,}\b.*\b[a-zA-Z]{3,}\b.*\b[a-zA-Z]{3,}\b/;

/**
 * Returns true when the chunk is dominated by CI/build exit-code output.
 * Pattern D2.1: chunks where /\w+_exit=\d+/ occurs 3+ times with no
 * sentence-like prose around them are pure build gate output.
 */
function isBuildExitDump(text: string): boolean {
  const matches = text.match(EXIT_CODE_RE);
  if (!matches || matches.length < 3) return false;

  const lines = text.split('\n');
  for (const line of lines) {
    const stripped = line.replace(EXIT_CODE_RE, '');
    if (PROSE_LINE_RE.test(stripped) && PROSE_LONG_WORD_RE.test(stripped)) return false;
  }
  return true;
}

/**
 * Returns true when the chunk is a numbered build-step dump with no prose.
 * Pattern D2.2: 5+ lines matching /^\s*\d+\.\s+[\w-]+/ with no prose lines
 * are pure step-list output from CI runners or task executors.
 */
function isNumberedBuildStepDump(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 5) return false;

  let stepLineCount = 0;
  let proseLineCount = 0;
  for (const line of lines) {
    if (BUILD_STEP_LINE_RE.test(line)) {
      stepLineCount++;
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

  return stepLineCount >= 5 && proseLineCount === 0;
}

// ── Placeholder noise detection ───────────────────────────────────

/**
 * Detect self-referential placeholder / template noise that should never be stored.
 * Catches RAG prompt residue and fictional-note instructions that leaked into captures.
 */
function isPlaceholderNoise(text: string): boolean {
  if (/a real note on this topic would\s+ment/i.test(text)) return true;
  if (/strings,?\s+decisions that/i.test(text)) return true;
  if (/you write a short fictional\s+(?:memory\s+)?note/i.test(text)) return true;
  if (/output\s+only\s+the\s+note\s+body/i.test(text)) return true;
  if (/hypothetically\s+answers\s+the\s+user.{0,5}s\s+search\s+query/i.test(text)) return true;
  if (/concrete\s+vocabulary:\s+include\s+the\s+named\s+entities/i.test(text)) return true;
  return false;
}

// ── Public exports ────────────────────────────────────────────────

/**
 * Count the number of alphanumeric words in a string.
 * A "word" is a token that starts with a letter or digit.
 */
export function countAlphanumericWords(text: string): number {
  const words = text.match(/\b[a-zA-Z0-9][a-zA-Z0-9'_-]*\b/g);
  return words ? words.length : 0;
}

/**
 * Returns true when the text represents CI/build output that should not be
 * stored as knowledge.
 * Combines D2.1 (exit-code dump) and D2.2 (numbered step dump) checks.
 */
export function isBuildOutputNoise(text: string): boolean {
  return isBuildExitDump(text) || isNumberedBuildStepDump(text);
}

/**
 * Returns true when the text is agent/framework scaffolding that should be discarded.
 * Matches generic structural markers from agent frameworks and orchestration systems.
 * When in doubt, returns false — false negatives are cheaper than destroying real knowledge.
 */
export function isAgentMetaText(text: string): boolean {
  const trimmed = text.trim();

  // Fenced progress/mode-switch banners: "--- SOME HEADING ---"
  if (/^-{3,}\s*[A-Z][A-Z\s:]+[A-Z]\s*-{3,}/.test(trimmed)) return true;

  // XML-style agent observation/thinking blocks (opening tags).
  // Note: inside a character class, `/` needs no escaping in a JS regex
  // literal — `\/` there was a no-useless-escape lint violation.
  if (
    /^<\/?(observation|thinking|reflection|memory[_-]?update|fact|status|title|summary|entry|note)\s*[\s>/]/i.test(
      trimmed,
    )
  )
    return true;

  // Chunks that are NOTHING but XML schema-tag residue.
  if (
    /^[<>/\s.]*<\/?\s*(fact|status|title|observation|thinking|note|summary|entry)\s*>[.\s]*$/i.test(
      trimmed,
    )
  )
    return true;

  // Memory-observer instruction templates.
  if (/record\s+what\s+was\s+(?:learned|built|fixed|deployed|configured)/i.test(trimmed))
    return true;

  // Memory-agent self-introduction patterns.
  if (/\bhello\s+(memory|brain|agent)\b/i.test(trimmed)) return true;
  if (/\bobserving\s+the\s+primary\b/i.test(trimmed)) return true;

  // Claude Code / agent-harness stop hook feedback line.
  if (/\bStop hook feedback\b/i.test(trimmed)) return true;

  // Claude Code / agent-harness mandatory-tool instruction.
  if (/call the StructuredOutput tool to complete/i.test(trimmed)) return true;

  // Placeholder / template residue from RAG prompts.
  if (isPlaceholderNoise(trimmed)) return true;

  // LazyBrain note infobox residue — machine-format metadata.
  if (/Source\s+session:[a-z]+-[0-9a-f]{6,}/i.test(trimmed)) return true;
  if (
    /^(?:\d{4}-\d{2}-\d{2}\s+)?Type\s+(?:episodic|reference|semantic|decision|architecture|feature|feature-set)\s+Status\s+(?:active|deprecated|draft)\b/i.test(
      trimmed,
    )
  )
    return true;
  if (/^\s*Type\s+\w[\w-]*\s+Status\s+\w[\w-]*\s+Tags\b/i.test(trimmed)) return true;
  if (/\bKind\s+\w[\w-]*\s+Files\s+\d+\s+Lines\s+\d+\b/i.test(trimmed)) return true;

  // Scheduled-task / automation boilerplate.
  if (/This\s+is\s+an\s+automated\s+run\s+of\s+a\s+scheduled\s+task/i.test(trimmed)) return true;
  if (/<scheduled-task\s+name=/i.test(trimmed)) return true;
  if (/execute\s+autonomously\s+without\s+asking\s+clarifying\s+questions/i.test(trimmed))
    return true;
  if (/The\s+user\s+is\s+not\s+present\s+to\s+answer\s+questions/i.test(trimmed)) return true;

  // Claude Code local-command injection block.
  if (/<local-command-caveat>/i.test(trimmed)) return true;
  if (
    /DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to/i.test(
      trimmed,
    )
  )
    return true;

  // Generic "AUTOMATED TASK:" prefix used by agent harnesses.
  if (/AUTOMATED\s+TASK\s*[:/]/i.test(trimmed)) return true;

  // JSON null / bare JSON fragment titles.
  if (/^["']?\s*:\s*null\.?\s*$/.test(trimmed)) return true;

  // Rate-limit / billing residue.
  if (/You.{0,10}ve\s+hit\s+your\s+.{0,20}limit/i.test(trimmed)) return true;
  if (/resets\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)/i.test(trimmed)) return true;

  // Pattern A — TLDR-extraction prompt residue.
  if (/Output\s+(?:a\s+)?JSON\s+array\s+with\s+one\s+object/i.test(trimmed)) return true;
  if (/\{["']?tldr["']?\s*:/i.test(trimmed)) return true;
  if (/Respond\s+with\s+(?:a\s+)?JSON\b/i.test(trimmed)) return true;

  // Pattern B — "No prose." instruction suffix.
  if (/\bNo\s+prose\.\s*$/i.test(trimmed) && trimmed.length < 300) return true;

  // Pattern C — Eval / benchmark harness.
  if (/compare\s+the\s+gold\s+answer/i.test(trimmed)) return true;

  // Pattern D — Raw agent observation XML tags.
  if (/<observed_from_[a-z_]+\s*>/i.test(trimmed)) return true;

  // Pattern E — Superpowers skill preamble.
  if (/Base\s+directory\s+for\s+this\s+skill\b/i.test(trimmed)) return true;
  if (/\bSUBAGENT-STOP\b/.test(trimmed)) return true;
  if (/skip\s+this\s+skill\b/i.test(trimmed)) return true;
  if (/If\s+you\s+were\s+dispatched\s+as\s+a\s+subagent\b/i.test(trimmed)) return true;

  // Pattern G — HyDE prompt residue (defence-in-depth).
  if (
    /you\s+write\s+a\s+short\s+fictional\s+memory\s+note\s+that\s+hypothetically\s+answers/i.test(
      trimmed,
    )
  )
    return true;

  return false;
}

/**
 * Returns true when the text is low-value and should NOT be captured to the brain.
 * Gate is skipped (returns false) when text is undefined or empty.
 */
export function isNoisyCapture(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (countAlphanumericWords(trimmed) < 8) return true;
  if (isBuildOutputNoise(trimmed)) return true;
  if (isAgentMetaText(trimmed)) return true;
  return false;
}
