/* brainSearchLoop — shared ReAct brain_search shim for all providers.

   When brain_search is not in req.tools, withBrainSearchLoop is a transparent
   pass-through: single turn, no extra calls, identical to the pre-shim path.

   When brain_search is present:
   - Loops up to MAX_BRAIN_SEARCH_ROUNDS (3).
   - Detects BRAIN_SEARCH: <query> directives in each turn's text.
   - Deduplicates queries (normalized: trim + lowercase) to prevent loops.
   - Forces a final prose answer when max rounds are reached or a duplicate
     is detected.
   - Strips reasoning-channel lines, the managed proxy's final \x1b[usage]
     real-usage marker, and BRAIN_SEARCH directives from UI output, even
     when a marker appears mid-line (not just at line start) — reasoning-
     capable models often emit them inline with no leading newline.
   - Yields a clean status line per search instead of the raw directive.
   - Bounds every brain-recall call to BRAIN_RECALL_TIMEOUT_MS (withTimeout)
     so a slow or hung platform command degrades the turn gracefully instead
     of blocking it — the backend's own ~30s command timeout is a last-resort
     safety net, not the UX budget.

   SUPERSEDED for chat providers (2026-07): claudeCodeProvider, cliBackendProvider,
   and anthropicProvider no longer call the withBrainSearchLoop /
   withBrainSearchLoopEvents functions defined below directly — they now get
   their ReAct loop from assistantToolLoop.ts's withAssistantToolLoop /
   withAssistantToolLoopEvents (which extends this module's brain-directive
   handling with general tool directives: WEB_SEARCH, READ_FILE, ...),
   imported under a `withBrainSearchLoop`/`withBrainSearchLoopEvents` LOCAL
   ALIAS purely for call-site continuity (see anthropicProvider.ts:12,
   claudeCodeProvider.ts:13, cliBackendProvider.ts:14). Verified by grep: the
   two loop functions actually defined in THIS file have no other production
   caller left — only brainSearchLoop.test.ts still exercises them directly.
   Do not wrap a provider in both loops (this file's AND assistantToolLoop's)
   — that would run the ReAct round-trip twice.

   What IS still genuinely shared: the primitives below (executeBrainDirective,
   describeBrainDirective, isBrainDirectiveError, stripInvisibleLines,
   recallForDirective, withTimeout, BRAIN_RECALL_TIMEOUT_MS). Real consumers:
   assistantToolLoop.ts (brain-directive execution), managedProvider.ts +
   managedProviderEvents.ts (their OWN separate ReAct loop implementation
   reuses stripInvisibleLines/normalizeQuery/MAX_BRAIN_SEARCH_ROUNDS from here
   rather than sharing a loop — see managedProviderEvents.ts's header for why),
   assistantStore.tsx + agents/runtime.ts (withTimeout/BRAIN_RECALL_TIMEOUT_MS),
   and agentsStore.tsx (recallForDirective, for LazyManager's brain_query
   grounding).
*/

import { normalizeRecall } from '../brain/context.js';
import { recordRecallSaving } from './costStore.js';
import { getPlatform } from '../platform/index.js';
import {
  BRAIN_SEARCH_DEFAULT_TOP,
  hasBrainSearchTool,
  parseBrainDirective,
  runBrainQueryCss,
  runBrainNeighbours,
} from '../brain/brainTool.js';
import type { BrainDirective } from '../brain/brainTool.js';
import type { StreamChatRequest, StreamEvent, Translate } from './types.js';
import { extractThinkingText } from './streamEvents.js';

/** Maximum number of brain_search tool rounds before forcing a final answer. */
export const MAX_BRAIN_SEARCH_ROUNDS = 3;

/** Normalize a brain_search query for deduplication (trim + lowercase). */
function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

// ── Marker stripping ────────────────────────────────────────────────
//
// Matches either out-of-band marker — reasoning-channel or the managed
// proxy's final real-usage marker (see managedProvider.ts's
// parseUsageMarker / ai-proxy's settleAndRecord) — with or without the
// leading ANSI escape byte. Some CLI backends drop control characters in
// transit, which previously let a bare "[reasoning]" tag leak into the
// visible chat verbatim; the same tolerance applies to "[usage]".
// eslint-disable-next-line no-control-regex -- intentional: matching the ANSI escape byte itself
const OUT_OF_BAND_MARKER = /\x1b?\[(?:reasoning|usage)\]/;

// Matches ANY brain directive (semantic BRAIN_SEARCH or the two structural
// directives BRAIN_QUERY_CSS / BRAIN_NEIGHBOURS) and its argument, to the end
// of the line. Global so a line with multiple directives has all of them
// removed — the structural directives must be hidden from the visible UI
// exactly like BRAIN_SEARCH already is.
const BRAIN_SEARCH_DIRECTIVE_RE = /BRAIN_(?:SEARCH|QUERY_CSS|NEIGHBOURS):[^\n\r]*/g;

/**
 * Remove out-of-band channel content (reasoning, real-usage marker) and
 * BRAIN_SEARCH directives from a single line, wherever they appear in it
 * (not just at the start). Out-of-band content runs from its marker to the
 * end of the line; any prose before the marker on the same line is
 * preserved.
 */
function cleanLine(line: string): string {
  const markerIdx = line.search(OUT_OF_BAND_MARKER);
  const upToMarker = markerIdx === -1 ? line : line.slice(0, markerIdx);
  return upToMarker.replace(BRAIN_SEARCH_DIRECTIVE_RE, '');
}

/**
 * Strip reasoning-channel lines and BRAIN_SEARCH directive lines from a text
 * chunk for display purposes. The raw text is preserved internally for
 * conversation history.
 *
 * Markers are matched ANYWHERE in a line, not just at its start: reasoning-
 * capable models often emit BRAIN_SEARCH inline right after reasoning text
 * with no leading newline (see parseBrainSearchDirective), and a strict
 * line-start check let those directives — and the reasoning marker itself —
 * leak into the visible transcript verbatim.
 *
 * A line that contains ONLY a marker (nothing visible once stripped)
 * disappears entirely, matching the original whole-line-drop behavior. Lines
 * that were already blank in the source text (paragraph breaks) are always
 * preserved.
 */
export function stripInvisibleLines(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const wasBlank = line.trim() === '';
      const cleaned = cleanLine(line).trimEnd();
      return { cleaned, keep: wasBlank || cleaned.trim() !== '' };
    })
    .filter(entry => entry.keep)
    .map(entry => entry.cleaned)
    .join('\n');
}

/**
 * Client-side ceiling for a single brain-recall round trip.
 *
 * FLAGSHIP BUG FIX (recall returns 0 neurons): this used to be 8_000ms —
 * well UNDER the backend's own engineered patience window, not over it as
 * the previous doc comment claimed. The Rust side (search.rs) gives the
 * warm sidecar up to `RECALL_WARM_TIMEOUT_SECS` = 30s to answer (sized to
 * clear the engine's documented ~24s worst-case cold embedder load — see
 * that constant's doc comment in commands/brain/search.rs), and the
 * cold-CLI-subprocess fallback it can drop into has its own independent 30s
 * ceiling (`output_with_timeout` in the same file). At 8_000ms, THIS client
 * timeout fired and abandoned the call (surfacing as `brainError`, or —
 * once the fallback's own promise race lost — as an empty recall) well
 * before either backend path could possibly finish a genuinely cold
 * (first-ever, or slow-machine) semantic query: the 30s of backend patience
 * added specifically to survive embedder warm-up was completely
 * neutralized by a 3.75x-shorter client-side giveup.
 *
 * Set comfortably above the WARM-sidecar path's real ceiling (30s + margin
 * for Tauri IPC/serialization overhead) so a normal question actually gets
 * to benefit from that 30s of backend patience instead of being abandoned
 * mid-flight. Does not attempt to cover the rare compound worst case (warm
 * path times out at 30s AND THEN the cold-CLI fallback ALSO takes its own
 * full 30s, ~60s total) — that fallback only triggers when the warm sidecar
 * is unreachable at all (crashed/wrong port), not merely slow, so it is not
 * the common "cold embedder" case this timeout targets; a turn can still
 * time out and degrade gracefully in that rarer case, per this module's
 * "recall must never block the turn" contract.
 *
 * Honest tradeoff: raising this does mean a genuinely first-ever, slow-disk
 * cold load can now make the user wait up to ~150s for brain context before
 * the model starts answering, instead of silently getting no context after
 * 8s. That is the intended fix — a normal question should get real neurons
 * within a reasonable wait, not a fast, wrong "nothing found". Callers that
 * pass an AbortSignal (assistant Stop, mission cancel) still converge early.
 * Progress: recallForDirective / withTimeout never go silent — timeouts surface
 * as describeBrainRecallFailure text, and UI callers may emit interim status.
 */
export const BRAIN_RECALL_TIMEOUT_MS = 150_000;

/**
 * Client-side ceiling for the assistant chat's WS1/WS2 SCOPE-FALLBACK recall
 * only (assistantStore.tsx's send()) — the bonus second lookup fired when the
 * user's SELECTED scope came back empty, not the primary recall.
 *
 * QA3/B17 follow-up: the naive fix suggested shortening the recall budget
 * itself back down (e.g. to 8s) so a stuck chat turn degrades faster. Doing
 * that to BRAIN_RECALL_TIMEOUT_MS would resurrect the exact flagship bug its
 * own doc comment above describes (a legitimate first-ever cold-embedder
 * recall silently abandoned before the backend's engineered ~30s warm-up
 * budget). The PRIMARY recall keeps the full BRAIN_RECALL_TIMEOUT_MS for
 * that reason. The FALLBACK recall is different: it only runs after the
 * primary already completed (successfully, just empty) within its own
 * budget, so the sidecar is already warm — the cold-embedder scenario this
 * module's flagship-bug comment worries about is far less likely to recur
 * seconds later on the same session. Worst case for a chat turn drops from
 * BRAIN_RECALL_TIMEOUT_MS*2 (~300s) to BRAIN_RECALL_TIMEOUT_MS +
 * BRAIN_RECALL_FALLBACK_TIMEOUT_MS (~160s) without touching the primary
 * recall's correctness-critical budget.
 */
export const BRAIN_RECALL_FALLBACK_TIMEOUT_MS = 10_000;

/**
 * Race a promise against a timeout. Used to bound brain-recall calls so a
 * slow or hung platform command can never block a chat turn indefinitely —
 * callers still see a rejection (handled like any other recall error), just
 * within a predictable ceiling instead of the backend's full timeout.
 *
 * Optional `signal` (W-STOPLLM, stop button): additive, backward-compatible
 * parameter — an existing caller that omits it behaves exactly as before.
 * When provided, an abort rejects this promise immediately instead of
 * waiting out the full `ms` ceiling, so a user-initiated Stop converges as
 * fast during brain recall as it does during token streaming. Deliberately
 * does NOT cancel the underlying `promise` itself (recall has no cancel
 * primitive of its own — same non-goal as streamTimeout.ts's own abort
 * race) — only how fast the CALLER stops waiting on it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException(`${label} aborted`, 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      value => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Matches the exact rejection message `withTimeout` (above) constructs —
 *  used to tell "the brain timed out" apart from every other recall failure
 *  (missing brain path, CLI crash, malformed response, ...). Capture group is
 *  the elapsed budget in ms. */
const RECALL_TIMEOUT_MESSAGE_RE = /timed out after (\d+)ms/;

/**
 * Turn a recallForDirective failure into model-facing text.
 *
 * QA finding (2026-07): on a REAL, large brain (thousands of notes, hundreds
 * of MB) the recall can genuinely exceed BRAIN_RECALL_TIMEOUT_MS — measured
 * up to several minutes on a 5881-note/~300MB brain, while the embedder
 * itself warms in ~2s and keyword/structural queries stay under 4s (the slow
 * part is elsewhere in the retrieval/hydration pipeline, corpus-size-
 * correlated, not a "brain is broken" condition). Before this fix, EVERY
 * failure — timeout included — was worded "(brain search unavailable: ...)",
 * which reads to the model (and, once paraphrased, to the user) as "the
 * brain doesn't exist / is broken", not "it exists and is just slow for its
 * size". That is the NEVER-DEGRADE-IN-SILENCE rule respected in form but
 * violated in substance: the user saw an accurate-sounding but wrong
 * "indisponible" verdict on a brain that genuinely has thousands of notes.
 *
 * A timeout now gets its own honest, actionable wording — distinct from a
 * genuine backend/missing-brain error — and explicitly suggests the
 * scan_project fallback so the caller (LazyManager) has real material to
 * offer the user instead of just reporting defeat.
 */
/** Distinguish timeout failures from other recall errors (B35 — never silent). */
export function describeBrainRecallFailure(message: string): string {
  const timeoutMatch = message.match(RECALL_TIMEOUT_MESSAGE_RE);
  if (timeoutMatch) {
    const budgetSecs = Math.round(Number(timeoutMatch[1]) / 1000);
    return (
      `(brain search timed out after ${budgetSecs}s — this usually means the project brain is large ` +
      `and this particular query is slow, NOT that the brain is missing or broken. Do not tell the user ` +
      `the brain is "unavailable"; instead say recall was too slow for this turn and offer to fall back ` +
      `to scan_project for now.)`
    );
  }
  return `(brain search unavailable: ${message})`;
}

/**
 * Recall persistent memory for a brain_search directive.
 *
 * Uses the 'current' scope (warm sidecar, ~milliseconds) rather than 'all'
 * (cold ML spawn, ~30 s). Bounded by BRAIN_RECALL_TIMEOUT_MS so a hung
 * platform call cannot stall the ReAct loop. Returns an explicit "no
 * results"/"unavailable"/"timed out" string rather than throwing, so the loop
 * always makes progress — see describeBrainRecallFailure for why a timeout is
 * worded differently from every other failure.
 *
 * @param sessionId Stable per-conversation id forwarded to
 *                  brain.recallScoped() for the engine's session-dedup (see
 *                  that method's doc comment in platform/types.ts).
 *                  Optional — undefined/omitted preserves the original
 *                  no-dedup behavior, so every existing caller of this
 *                  exported function (managedProvider.ts,
 *                  managedProviderEvents.ts) keeps working unchanged.
 */
export async function recallForDirective(query: string, sessionId?: string): Promise<string> {
  try {
    const recall = normalizeRecall(
      await withTimeout(
        getPlatform().brain.recallScoped(query, 'current', sessionId),
        BRAIN_RECALL_TIMEOUT_MS,
        'brain recall',
      ),
    );
    // Mid-loop BRAIN_SEARCH directive — called from both the Codeur/managed
    // tool loop and LazyManager's grounding (see this file's header comment);
    // tagged 'tool' generically since both are the same directive mechanic.
    recordRecallSaving(recall, 'tool');
    const text = recall.injectedContext.trim();
    if (text) return text;
    return '(no memory hits found)';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return describeBrainRecallFailure(message);
  }
}

// ── Structural directive dispatch (brain_query_css / brain_neighbours) ───────
//
// The text-convention ReAct loop recognizes three directives — BRAIN_SEARCH:
// (semantic recall, recallForDirective above), BRAIN_QUERY_CSS: (deterministic
// CSS-selector query), and BRAIN_NEIGHBOURS: (1-hop graph follow). All three
// share the SAME round cap + dedup + never-throw resilience. These helpers keep
// the four loop copies (withBrainSearchLoop / withBrainSearchLoopEvents here,
// streamChatImpl / streamChatEventsImpl in the managed provider) consistent.

/** UI/observation metadata for a parsed directive — keeps the string-path
 *  status line, the structured tool-event fields, and the conversation
 *  observation header consistent across every loop copy. */
export interface BrainDirectivePresentation {
  /** Tool name for a structured StreamEvent (brain_search | brain_query_css | brain_neighbours). */
  toolName: string;
  /** Structured tool-event input payload (query | selector | id). */
  toolInput: Record<string, string>;
  /** Clean status chunk for the string path (surrounding blank lines included). */
  statusLine: string;
  /** Header prefixed to the recalled result when appended to conversation history. */
  observationHeader: string;
}

/** Derive the display/observation metadata for a parsed directive. `t` is
 *  optional and threaded from StreamChatRequest.t (see its doc comment) —
 *  omitting it falls back to the ORIGINAL hardcoded French, never a
 *  behavior change. */
export function describeBrainDirective(directive: BrainDirective, t?: Translate): BrainDirectivePresentation {
  switch (directive.kind) {
    case 'query_css':
      return {
        toolName: 'brain_query_css',
        toolInput: { selector: directive.arg },
        statusLine: `\n\n🔎 ${t ? t('assistant.tool.brainQueryCss', { value: directive.arg }) : `Requête mémoire (CSS) : ${directive.arg}`}\n\n`,
        observationHeader: `[brain_query_css results for "${directive.arg}"]`,
      };
    case 'neighbours':
      return {
        toolName: 'brain_neighbours',
        toolInput: { id: directive.arg },
        statusLine: `\n\n🔎 ${t ? t('assistant.tool.brainNeighbours', { value: directive.arg }) : `Voisins mémoire : ${directive.arg}`}\n\n`,
        observationHeader: `[brain_neighbours results for "${directive.arg}"]`,
      };
    case 'search':
    default:
      return {
        toolName: 'brain_search',
        toolInput: { query: directive.arg },
        statusLine: `\n\n🔎 ${t ? t('assistant.tool.brainSearch', { query: directive.arg }) : `Recherche mémoire : ${directive.arg}`}\n\n`,
        observationHeader: `[brain_search results for "${directive.arg}"]`,
      };
  }
}

/**
 * Execute a parsed brain directive against the platform brain, NEVER throwing —
 * a backend failure comes back as an explanatory string so the ReAct loop
 * always makes progress. Semantic search goes through recallForDirective
 * (bounded 'current'-scope recall); the two structural directives go through
 * runBrainQueryCss / runBrainNeighbours (brainTool.ts), which have the same
 * never-throw contract and are already bounded on the Rust side. Selectors and
 * ids are passed verbatim — the Rust side handles them safely (no shell).
 */
export async function executeBrainDirective(
  directive: BrainDirective,
  sessionId?: string,
): Promise<string> {
  switch (directive.kind) {
    case 'query_css':
      return runBrainQueryCss(directive.arg);
    case 'neighbours':
      return runBrainNeighbours(directive.arg);
    case 'search':
    default:
      return recallForDirective(directive.arg.slice(0, BRAIN_SEARCH_DEFAULT_TOP * 256), sessionId);
  }
}

/** True when an executeBrainDirective result is a backend-unavailable OR
 *  timed-out error (vs. a legitimate "no hits" result) — lets the event path
 *  report tool status 'error' instead of 'done'. Covers all three directives'
 *  unavailable strings ("(brain search unavailable…", "(brain_query_css
 *  unavailable…", "(brain_neighbours unavailable…") plus recallForDirective's
 *  distinct timed-out wording (describeBrainRecallFailure) — a timeout is a
 *  DIFFERENT message from "unavailable" (see that function's doc comment) but
 *  is still a failure the UI must not render as a graceful 'done'. */
export function isBrainDirectiveError(result: string): boolean {
  if (!result.startsWith('(brain')) return false;
  return result.includes('unavailable') || result.includes('timed out');
}

/**
 * Generic ReAct loop that wraps a single-turn streaming function with
 * brain_search support. Works with ANY provider; when the brain_search tool
 * is absent the loop is a transparent pass-through (single turn, no extra
 * calls, identical to the pre-shim behavior).
 *
 * @param req     Full chat request — used for tools list, abort signal, and
 *                sessionId (forwarded to recallForDirective for the
 *                engine's session-dedup on every in-turn BRAIN_SEARCH round).
 * @param runTurn Provider-specific function streaming one LLM turn for the
 *                given message list. System prompt and model selection are
 *                captured in the caller's closure; a fresh turn ID should be
 *                generated on each call.
 */
export async function* withBrainSearchLoop(
  req: StreamChatRequest,
  runTurn: (messages: Array<{ role: string; content: string }>) => AsyncIterable<string>,
): AsyncGenerator<string> {
  // Immutable seed — copy from req so rounds can extend without mutating the
  // caller's original array.
  let messages: Array<{ role: string; content: string }> = req.messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  const toolsEnabled = hasBrainSearchTool(req.tools);

  // Track queries searched this session (normalized) to prevent loops.
  const searchedQueries = new Set<string>();

  // ── ReAct loop: stream a turn, detect BRAIN_SEARCH, recall, continue ──
  for (let round = 0; round <= MAX_BRAIN_SEARCH_ROUNDS; round++) {
    const isForcedFinal = round >= MAX_BRAIN_SEARCH_ROUNDS;

    // turnText accumulates the raw full text (reasoning + directives) for
    // conversation history. Only the stripped version reaches the UI.
    let turnText = '';
    // Line buffer handles chunks that split mid-line. Hold the last incomplete
    // line and flush when the next newline arrives.
    let lineBuffer = '';

    for await (const chunk of runTurn(messages)) {
      turnText += chunk;
      lineBuffer += chunk;
      const newlineIdx = lineBuffer.lastIndexOf('\n');
      if (newlineIdx === -1) continue;
      const completeText = lineBuffer.slice(0, newlineIdx + 1);
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      const visible = stripInvisibleLines(completeText);
      if (visible) yield visible;
    }

    // Flush whatever remains in the buffer (no trailing newline — last line).
    // No trailing reset needed: `lineBuffer` is re-declared with `let` at the
    // top of the next round (or the function returns), so writing back to it
    // here was a no-useless-assignment lint violation — the value was never
    // read again.
    if (lineBuffer) {
      const visible = stripInvisibleLines(lineBuffer);
      if (visible) yield visible;
    }

    if (req.signal?.aborted) return;

    // Non-agentic path or last round → this turn IS the answer. Done.
    if (!toolsEnabled || isForcedFinal) return;

    const directive = parseBrainDirective(turnText);

    // Model produced a normal prose answer (no directive) → done.
    if (!directive) return;

    // Dedup across ALL directive kinds — a BRAIN_SEARCH and a BRAIN_QUERY_CSS
    // for the same text are distinct requests, so the kind is part of the key.
    const dedupKey = `${directive.kind}:${normalizeQuery(directive.arg)}`;
    const isDuplicate = searchedQueries.has(dedupKey);

    if (isDuplicate) {
      // The model is stuck in a loop. Nudge it then force the final answer.
      const nudge =
        'You already have the brain results above. Do NOT search again. ' +
        'Write your final answer for the user now.';
      const nudgeMessages: Array<{ role: string; content: string }> = [
        ...messages,
        { role: 'assistant', content: turnText },
        { role: 'user', content: nudge },
      ];

      let nudgeLineBuffer = '';
      for await (const chunk of runTurn(nudgeMessages)) {
        nudgeLineBuffer += chunk;
        const newlineIdx = nudgeLineBuffer.lastIndexOf('\n');
        if (newlineIdx === -1) continue;
        const completeText = nudgeLineBuffer.slice(0, newlineIdx + 1);
        nudgeLineBuffer = nudgeLineBuffer.slice(newlineIdx + 1);
        const visible = stripInvisibleLines(completeText);
        if (visible) yield visible;
      }
      if (nudgeLineBuffer) {
        const visible = stripInvisibleLines(nudgeLineBuffer);
        if (visible) yield visible;
      }
      return;
    }

    // New directive — record it and proceed with the recall.
    searchedQueries.add(dedupKey);
    const presentation = describeBrainDirective(directive, req.t);

    // Surface the recall to the UI as a clean status chunk.
    yield presentation.statusLine;

    const recalled = await executeBrainDirective(directive, req.sessionId);
    if (req.signal?.aborted) return;

    // Append the prior assistant turn + the tool result, then loop.
    messages = [
      ...messages,
      { role: 'assistant', content: turnText },
      {
        role: 'user',
        content: `${presentation.observationHeader}\n${recalled}`,
      },
    ];
  }

  // Safety net: the for-loop should always return internally, but guard
  // against a pathological case where it exits without returning.
  const finalMessages: Array<{ role: string; content: string }> = [
    ...messages,
    {
      role: 'user',
      content:
        'Provide your final answer now using the brain results above; do NOT emit BRAIN_SEARCH.',
    },
  ];

  let safetyLineBuffer = '';
  for await (const chunk of runTurn(finalMessages)) {
    if (req.signal?.aborted) return;
    safetyLineBuffer += chunk;
    const newlineIdx = safetyLineBuffer.lastIndexOf('\n');
    if (newlineIdx === -1) continue;
    const completeText = safetyLineBuffer.slice(0, newlineIdx + 1);
    safetyLineBuffer = safetyLineBuffer.slice(newlineIdx + 1);
    const visible = stripInvisibleLines(completeText);
    if (visible) yield visible;
  }
  if (safetyLineBuffer) {
    const visible = stripInvisibleLines(safetyLineBuffer);
    if (visible) yield visible;
  }
}

// ── Structured-event counterpart (assistant chat only) ─────────────
//
// withBrainSearchLoopEvents is a PARALLEL implementation of the exact same
// ReAct loop as withBrainSearchLoop above (same rounds/dedup/forced-final/
// nudge contract — see that function's doc comment), yielding typed
// StreamEvents (thinking / tool-call / text) instead of a flattened
// string. Kept as a sibling function rather than having withBrainSearchLoop
// delegate to this one, deliberately: withBrainSearchLoop is exercised by
// every non-assistant AI feature (inline-edit, autoFix, terminalAi,
// AiReview, AiCommitMessage, agents) via claudeCodeProvider/anthropicProvider
// /cliBackendProvider, and those callers never enable brain_search (see
// hasBrainSearchTool) — so keeping its code path 100% untouched by this
// change is the lowest-risk way to guarantee they see zero behavior change.
// Only assistantStore.tsx calls into this function (via each provider's
// streamChatEvents). The small duplication is an explicit, documented
// tradeoff — see the STEP 2 notes in the final report for the reasoning.

const THINKING_PART_ID = 'thinking';
const ANSWER_PART_ID = 'answer';

/** Splits one buffered (newline-complete) chunk of raw provider text into
 *  at most a 'thinking' event and a 'text' event. Reuses the exact same
 *  stripInvisibleLines this module already relies on for the string path,
 *  so the two loops' visible-text output can never drift apart. */
function* classifyChunk(text: string): Generator<StreamEvent> {
  const thinking = extractThinkingText(text);
  if (thinking) yield { type: 'thinking', id: THINKING_PART_ID, text: thinking };
  const visible = stripInvisibleLines(text);
  if (visible) yield { type: 'text', id: ANSWER_PART_ID, text: visible };
}

/**
 * Structured-event counterpart to withBrainSearchLoop (see module header
 * and that function's doc comment for the full ReAct-loop contract).
 * Yields typed StreamEvents so the assistant chat can render the model's
 * reasoning, brain_search tool-call steps, and the final answer as
 * distinct UI instead of one undifferentiated blob.
 *
 * @param req     Same as withBrainSearchLoop.
 * @param runTurn Same as withBrainSearchLoop — a provider-specific
 *                single-turn text streamer. Still only ever yields plain
 *                strings (the Rust/proxy bridges are unchanged by this
 *                frontend-only feature); this loop is what classifies that
 *                raw text into thinking vs. visible-answer text and detects
 *                the BRAIN_SEARCH directive, exactly like the string
 *                version above.
 */
export async function* withBrainSearchLoopEvents(
  req: StreamChatRequest,
  runTurn: (messages: Array<{ role: string; content: string }>) => AsyncIterable<string>,
): AsyncGenerator<StreamEvent> {
  // Immutable seed — copy from req so rounds can extend without mutating the
  // caller's original array.
  let messages: Array<{ role: string; content: string }> = req.messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  const toolsEnabled = hasBrainSearchTool(req.tools);

  // Track queries searched this session (normalized) to prevent loops.
  const searchedQueries = new Set<string>();

  // ── ReAct loop: stream a turn, detect BRAIN_SEARCH, recall, continue ──
  for (let round = 0; round <= MAX_BRAIN_SEARCH_ROUNDS; round++) {
    const isForcedFinal = round >= MAX_BRAIN_SEARCH_ROUNDS;

    // turnText accumulates the raw full text (reasoning + directives) for
    // directive detection. classifyChunk emits the split thinking/visible
    // events for display as each line completes.
    let turnText = '';
    let lineBuffer = '';

    for await (const chunk of runTurn(messages)) {
      turnText += chunk;
      lineBuffer += chunk;
      const newlineIdx = lineBuffer.lastIndexOf('\n');
      if (newlineIdx === -1) continue;
      const completeText = lineBuffer.slice(0, newlineIdx + 1);
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      yield* classifyChunk(completeText);
    }
    if (lineBuffer) {
      yield* classifyChunk(lineBuffer);
    }

    if (req.signal?.aborted) return;

    // Non-agentic path or last round → this turn IS the answer. Done.
    if (!toolsEnabled || isForcedFinal) return;

    const directive = parseBrainDirective(turnText);

    // Model produced a normal prose answer (no directive) → done.
    if (!directive) return;

    // Dedup across ALL directive kinds — see the string-path loop above.
    const dedupKey = `${directive.kind}:${normalizeQuery(directive.arg)}`;
    const isDuplicate = searchedQueries.has(dedupKey);

    if (isDuplicate) {
      // The model is stuck in a loop. Nudge it then force the final answer.
      const nudge =
        'You already have the brain results above. Do NOT search again. ' +
        'Write your final answer for the user now.';
      const nudgeMessages: Array<{ role: string; content: string }> = [
        ...messages,
        { role: 'assistant', content: turnText },
        { role: 'user', content: nudge },
      ];

      let nudgeLineBuffer = '';
      for await (const chunk of runTurn(nudgeMessages)) {
        nudgeLineBuffer += chunk;
        const newlineIdx = nudgeLineBuffer.lastIndexOf('\n');
        if (newlineIdx === -1) continue;
        const completeText = nudgeLineBuffer.slice(0, newlineIdx + 1);
        nudgeLineBuffer = nudgeLineBuffer.slice(newlineIdx + 1);
        yield* classifyChunk(completeText);
      }
      if (nudgeLineBuffer) {
        yield* classifyChunk(nudgeLineBuffer);
      }
      return;
    }

    // New directive — record it and proceed with the recall.
    searchedQueries.add(dedupKey);
    const presentation = describeBrainDirective(directive, req.t);

    const toolId = `${presentation.toolName}-${round}`;
    yield { type: 'tool', id: toolId, name: presentation.toolName, input: presentation.toolInput, status: 'running' };

    const recalled = await executeBrainDirective(directive, req.sessionId);
    if (req.signal?.aborted) return;

    // executeBrainDirective never throws (see its own doc comment) — it
    // returns an explicit "(brain … unavailable: ...)" string on failure
    // instead, the only signal available here to report an 'error' status
    // rather than a graceful 'done' (e.g. "no hits" / "0 matches").
    const isError = isBrainDirectiveError(recalled);
    yield {
      type: 'tool',
      id: toolId,
      name: presentation.toolName,
      input: presentation.toolInput,
      status: isError ? 'error' : 'done',
      resultSummary: recalled.slice(0, 160),
    };

    // Append the prior assistant turn + the tool result, then loop.
    messages = [
      ...messages,
      { role: 'assistant', content: turnText },
      {
        role: 'user',
        content: `${presentation.observationHeader}\n${recalled}`,
      },
    ];
  }

  // Safety net: the for-loop should always return internally, but guard
  // against a pathological case where it exits without returning.
  const finalMessages: Array<{ role: string; content: string }> = [
    ...messages,
    {
      role: 'user',
      content:
        'Provide your final answer now using the brain results above; do NOT emit BRAIN_SEARCH.',
    },
  ];

  let safetyLineBuffer = '';
  for await (const chunk of runTurn(finalMessages)) {
    if (req.signal?.aborted) return;
    safetyLineBuffer += chunk;
    const newlineIdx = safetyLineBuffer.lastIndexOf('\n');
    if (newlineIdx === -1) continue;
    const completeText = safetyLineBuffer.slice(0, newlineIdx + 1);
    safetyLineBuffer = safetyLineBuffer.slice(newlineIdx + 1);
    yield* classifyChunk(completeText);
  }
  if (safetyLineBuffer) {
    yield* classifyChunk(safetyLineBuffer);
  }
}
