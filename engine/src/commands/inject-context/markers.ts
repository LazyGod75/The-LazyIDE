/**
 * markers.ts — Shared tiny helpers used by both inject-context.ts and sections.ts.
 *
 * Owns: shortId, warningPassesGate, NudgeStyle + the three recall-nudge
 * formatters (markerNudge, highlightsRecallNudge, turnRecallHeader).
 *
 * Keeping these in a leaf module breaks the circular dependency that would
 * arise if sections.ts imported from inject-context.ts.
 */

/**
 * Shorten a note ID to a human-readable form:
 *   1. Strip the leading date (YYYY-MM-DD-) when present.
 *   2. Slice to 32 chars and remove trailing hyphen-fragment.
 */
export function shortId(id: string): string {
  // Drop the leading date (YYYY-MM-DD-) when present; keep the slug.
  const slug = id.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  // Slug fits in 32 chars with no risk of mid-word cut — return as-is.
  if (slug.length < 32) return slug;
  // Slice to 32 chars and strip the trailing hyphen-segment.
  // Spec algorithm: id.slice(0,32).replace(/-[^-]*$/, '').
  const sliced = slug.slice(0, 32);
  const trimmed = sliced.replace(/-[^-]*$/, '');
  // Degenerate: first segment alone >= 32 chars — no hyphen, hard-cut.
  if (!trimmed) return sliced;
  return trimmed;
}

/**
 * Quality gate for warnings before they appear in the banner.
 *
 * A warning passes when ALL of the following hold:
 *   - Has >= 4 alphanumeric words (filters noise tokens)
 *   - Is not a bare timestamp (/^\d{1,2}:\d{2}\.?$/)
 *   - Does not start with === or ---
 *
 * Exported for unit testing.
 */
export function warningPassesGate(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Reject bare timestamps like "20:15." or "9:00"
  if (/^\d{1,2}:\d{2}\.?$/.test(trimmed)) return false;
  // Reject separator lines
  if (trimmed.startsWith('===') || trimmed.startsWith('---')) return false;
  // Must have >= 4 alphanumeric words
  const wordCount = (trimmed.match(/\b[a-zA-Z0-9]{2,}\b/g) ?? []).length;
  return wordCount >= 4;
}

// ---------------------------------------------------------------------------
// Recall nudge — how the injected context tells the model to pull MORE
// context than what was already injected.
// ---------------------------------------------------------------------------

/**
 * How the injected context should tell the model to search memory further:
 *
 *   - 'skill' (default) — the Claude Code plugin path: a real `lazybrain-recall`
 *     Skill and a `lazybrain` CLI both exist in that integration, so the
 *     nudge names them directly. This is the ORIGINAL/historical wording and
 *     stays the default so every existing caller that never passes `--nudge`
 *     (Claude Code hooks) sees byte-identical output to before this type existed.
 *   - 'tool' — the Lazy IDE's native/managed chat providers: there is no Skill
 *     tool and no CLI available to the model, only the `brain_search` tool
 *     (see src/lib/brain/brainTool.ts) and its `BRAIN_SEARCH: <query>` text
 *     directive fallback (parsed by src/lib/models/brainSearchLoop.ts). The
 *     Rust side (search.rs) passes `--nudge tool` for exactly this reason —
 *     telling the model to invoke a Skill that does not exist there produced
 *     an incoherent, unactionable instruction.
 *   - 'none' — no action nudge at all, just the raw context (e.g. a caller
 *     that only wants passive grounding with no agentic follow-up).
 */
export type NudgeStyle = 'skill' | 'tool' | 'none';

/** Default nudge style — preserves pre-existing (skill) behavior. */
export const DEFAULT_NUDGE_STYLE: NudgeStyle = 'skill';

/**
 * Parse a raw `--nudge` CLI value / `nudge` query-string value into a
 * `NudgeStyle`. Unrecognized or missing values fall back to
 * `DEFAULT_NUDGE_STYLE` rather than throwing — mirrors this CLI's existing
 * permissive-parsing convention (unknown flags degrade, they don't crash a
 * hook-invoked process).
 */
export function parseNudgeStyle(raw: string | undefined | null): NudgeStyle {
  return raw === 'tool' || raw === 'none' || raw === 'skill' ? raw : DEFAULT_NUDGE_STYLE;
}

/**
 * Trailing action-clause appended to the `[BRAIN] N notes available.` marker
 * line (sections.ts's runMarkerInject). Includes its own leading space (or
 * is `''` for 'none') so the caller can simply concatenate it.
 *
 * 'tool' style, corrected (2026-08-16): this line is emitted by BOTH
 * `--mode marker` and `--mode highlights`, and `--mode highlights --nudge
 * tool` is exclusively LazyManager's startup context (see
 * `highlightsRecallNudge`'s doc comment for the verified single-caller
 * claim). LazyManager has no `brain_search` ChatTool and does not parse
 * `BRAIN_SEARCH:` directives — that vocabulary belongs to a different
 * surface (the assistant chat's ReAct loop, src/lib/models/
 * brainSearchLoop.ts). The previous wording here named a tool this caller
 * does not have — the exact inaccuracy already fixed in
 * `highlightsRecallNudge` by commit b0fef98, but missed here. This now names
 * the same real actions: `brain_query_css` (deterministic CSS selector) and
 * `brain_query` (fuzzy fallback) — see managerCorePrompt.ts items 10-11.
 */
export function markerNudge(style: NudgeStyle): string {
  if (style === 'none') return '';
  if (style === 'tool') {
    return ' Use brain_query_css (or brain_query for a fuzzy search) before answering questions about prior work.';
  }
  return ' INVOKE the lazybrain-recall skill (Skill tool) before answering questions about prior work. CLI fallback: `lazybrain search <query>` / `lazybrain query #<id>`.';
}

/**
 * `[RECALL]` footer line appended after the highlights block (sections.ts's
 * appendHighlights). Includes its own leading newline (or is `''` for
 * 'none') so the caller can simply concatenate it.
 *
 * 'tool' style, verified accurate (2026-08-16): `--mode highlights` (which is
 * the only mode that ever reaches this function — see appendHighlights's
 * sole call site) is itself only ever invoked with `--nudge tool` from ONE
 * caller, `brain_fetch_startup_context` (search.rs), which feeds LazyManager's
 * startup context exclusively. LazyManager does NOT have a `brain_search`
 * ChatTool and does NOT parse `BRAIN_SEARCH:` directives — those belong to a
 * DIFFERENT surface (the assistant chat's ReAct loop, src/lib/models/
 * brainSearchLoop.ts). LazyManager's own action vocabulary (taught in
 * src/lib/agents/managerCorePrompt.ts, items 10-11) is `brain_query` (fuzzy
 * semantic) and `brain_query_css` (deterministic CSS selector over
 * data-cerveau-type / data-cerveau-tags~=) — the second of which is exactly
 * what makes the `[TAGS]` vocabulary block (sections.ts's
 * buildTagVocabularyBlock) actionable: the model can plug a real, populated
 * type/tag straight into a selector instead of guessing. The previous text
 * here named a tool this caller does not have; this wording names the ones
 * it actually does.
 */
export function highlightsRecallNudge(style: NudgeStyle): string {
  if (style === 'none') return '';
  if (style === 'tool') {
    return '\n[RECALL] For any question about prior work or "how is X built": prefer brain_query_css with a data-cerveau-type/data-cerveau-tags~= selector drawn from the [TAGS] vocabulary above — exact and cheap. Use brain_query for a fuzzy topic search only when nothing above fits. Do not re-query what is already injected in this context.';
  }
  return '\n[RECALL] For any question about prior work or "how is X built": INVOKE the lazybrain-recall skill (Skill tool) before answering. CLI fallback: `lazybrain search "<topic>" --top 5`';
}

/**
 * `[LAZYBRAIN]` header prepended to turn-mode recall hits (inject-context.ts's
 * runTurnInject). Returns `''` for 'none' — the caller skips prepending it
 * entirely rather than emitting a blank line.
 */
export function turnRecallHeader(style: NudgeStyle): string {
  if (style === 'none') return '';
  if (style === 'tool') {
    return '[LAZYBRAIN] Memory hits below — for deeper context, use the brain_search tool (or emit BRAIN_SEARCH: <query>).';
  }
  return '[LAZYBRAIN] Memory hits below — for deeper context invoke the lazybrain-recall skill.';
}
