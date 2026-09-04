/* capture.ts — IDE auto-capture helpers.
   Fire-and-forget: never blocks the UI. capture() callers never throw.
   On failure, the solo path (default) hands off to captureQueue.ts for a
   bounded retry with exponential backoff instead of dropping the note
   outright; only a give-up after every retry is exhausted reaches
   console.warn + the onCaptureGiveUp subscribers (see captureQueue.ts).
   Debounce for edit events: same file captured at most once per EDIT_DEBOUNCE_MS.
*/

import { getPlatform } from '../platform/index.js';
import type { CaptureEvent, InsightPayload } from '../platform/types.js';
import { isNoisyCapture } from './captureNoise.js';
import { enqueueCaptureRetry, isConflictError } from './captureQueue.js';
import { resolveCaptureIdentity, withCaptureAuthor } from './captureAuthor.js';
import { readActiveBrainConfig } from '../teams/activeBrainConfig.js';

// ── Constants ─────────────────────────────────────────────────────

const EDIT_DEBOUNCE_MS = 15_000; // 15 s between captures of the same file
const REBUILD_DEBOUNCE_MS = 8_000; // 8 s of inactivity before graph rebuild

// ── Topic inference ───────────────────────────────────────────────

const CODE_TOKENS =
  /bug|refactor|commit|pull.?request|\bpr\b|build|test|function|import|export|class|deploy|lint|compile|debug|stack.?trace|error|exception/i;
const FILE_PATH_RE = /[a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,6}(:\d+)?/;
const CODE_BLOCK_RE = /```/;

/**
 * Infer a topical space and optional slug from a conversation turn.
 * Pure function — no side effects.
 */
export function inferTopic(
  userMsg: string,
  assistantMsg: string,
): { topic?: string; space: 'topical' | 'code' } {
  const combined = `${userMsg}\n${assistantMsg}`;

  if (
    CODE_BLOCK_RE.test(combined) ||
    FILE_PATH_RE.test(combined) ||
    CODE_TOKENS.test(combined)
  ) {
    return { space: 'code' };
  }

  const slug = extractSlug(userMsg);
  return { topic: slug, space: 'topical' };
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'can', 'could', 'i', 'you', 'he', 'she', 'we',
  'they', 'it', 'this', 'that', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'by', 'from', 'and', 'or', 'but', 'not', 'my', 'your', 'how',
  'what', 'when', 'where', 'why', 'who', 'me', 'us', 'them',
]);

/** Extract a dominant keyword slug from a message. Returns undefined when nothing salient. */
function extractSlug(msg: string): string | undefined {
  const words = msg
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

  if (words.length === 0) return undefined;

  // Frequency map
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);

  // Pick highest-frequency word; ties resolved by first occurrence
  let best: string | undefined;
  let bestCount = 0;
  for (const [w, count] of freq) {
    if (count > bestCount) { best = w; bestCount = count; }
  }

  return best;
}

// ── Edit debounce state ───────────────────────────────────────────

/** Tracks the last capture timestamp per file path. */
const lastEditCapture = new Map<string, number>();

// ── Rebuild debounce state ────────────────────────────────────────

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRebuild(): void {
  if (rebuildTimer !== null) {
    clearTimeout(rebuildTimer);
  }
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    triggerRebuildGraph();
  }, REBUILD_DEBOUNCE_MS);
}

function triggerRebuildGraph(): void {
  const platform = getPlatform();
  if (!('rebuildGraph' in platform.brain)) return;
  (platform.brain as { rebuildGraph: () => Promise<void> })
    .rebuildGraph()
    .catch((err: unknown) => {
      console.warn('[brain/capture] rebuildGraph failed:', err);
    });
}

// ── Teams routing (deprecated) ────────────────────────────────────
//
// _routeCapture is kept exported for test compatibility but now always
// falls through to the solo path (platform.brain.capture + scheduleRebuild).
// The active brain config (custom mode pointing to the team clone) handles
// routing — capture goes through brain.capture in the active brain path.

export async function _routeCapture(
  event: CaptureEvent,
  _loadConfig?: unknown,
): Promise<void> {
  const platform = getPlatform();
  await platform.brain.capture(event);
  scheduleRebuild();
}

// ── Internal fire-and-forget dispatcher ──────────────────────────

function dispatch(event: CaptureEvent): void {
  void (async () => {
    const activeConfig = readActiveBrainConfig();
    if (activeConfig?.role === 'viewer') {
      console.debug('[brain/capture] capture skipped — viewer role');
      return;
    }

    const { author, authorId, dept } = await resolveCaptureIdentity();
    let stamped = withCaptureAuthor(event, author, authorId);

    if (activeConfig && !stamped.orgId) {
      stamped = { ...stamped, orgId: activeConfig.orgId };
    }
    if (dept && !stamped.dept) {
      stamped = { ...stamped, dept };
    }

    const platform = getPlatform();
    platform.brain
      .capture(stamped)
      .then(() => {
        scheduleRebuild();
        void import('../teams/syncDaemon.js').then((mod) => {
          mod.schedulePostCapturePush();
        }).catch(() => {});
      })
      .catch((err: unknown) => {
        if (isConflictError(err)) {
          scheduleRebuild();
          return;
        }

        console.warn('[brain/capture] capture failed, queuing retry:', event.kind, err);
        enqueueCaptureRetry(stamped, (e) => getPlatform().brain.capture(e), {
          onSuccess: scheduleRebuild,
        });
      });
  })();
}

/**
 * Dispatch an already-built CaptureEvent through the shared teams-aware,
 * retry-on-failure pipeline (same path captureEdit/captureAssistant/
 * captureAgentMission below all use) — never throws, never blocks the
 * caller. Exported for call sites that build their own CaptureEvent instead
 * of using one of this module's kind-specific helpers (learningLoop.ts's
 * mission-completion and skill-note captures) so a failure still gets
 * captureQueue.ts's bounded retry + brain.capture_failed give-up signal
 * instead of a bare console.warn with no retry and no durable trail.
 */
export function captureRawEvent(event: CaptureEvent): void {
  dispatch(event);
}

// ── Public helpers ────────────────────────────────────────────────

/**
 * Capture a file-edit event.
 * Debounced: same path captured at most once per EDIT_DEBOUNCE_MS.
 */
export function captureEdit(path: string, filename: string, firstLine?: string): void {
  const now = Date.now();
  const last = lastEditCapture.get(path) ?? 0;
  if (now - last < EDIT_DEBOUNCE_MS) return;
  lastEditCapture.set(path, now);

  const text = firstLine
    ? `Fichier sauvegardé : ${path}\nPremière ligne : ${firstLine.slice(0, 120)}`
    : `Fichier sauvegardé : ${path}`;

  if (isNoisyCapture(text)) return;

  const event: CaptureEvent = {
    kind: 'edit',
    title: `Edit: ${filename}`,
    text,
    files: [path],
    source: 'lazy-ide:editor',
    space: 'code',
  };

  dispatch(event);
}

// ── Reasoning-leak defense (capture boundary) ────────────────────────
//
// assistantStore.tsx accumulates only 'text' stream events into the string
// passed here as `assistantMsg` — 'thinking' events are routed to a
// separate `parts` array and never touch it (see streamEvents.ts's
// applyStreamEvent, which returns `parts` UNCHANGED for 'text' events).
// In practice a provider can still leak reasoning content INTO a 'text'
// event: streamEvents.ts's REASONING_MARKER ("\x1b?[reasoning]") is
// recognized per received chunk, so if it lands split across two stream
// chunks the classifier never sees it whole and the fragment — plus
// whatever reasoning text follows it on that line — is misclassified as
// visible answer text instead of being routed to the thinking channel.
// Real captured notes have shown this as a literal "[reasoning]" substring
// landing mid-word, with truncated/garbled text following it.
//
// This re-applies the SAME marker convention at the storage boundary as
// defense-in-depth: it does not (and cannot, from this file — the emitting
// code lives in src/lib/models/**, owned by a different work-stream) fix
// the upstream chunk-boundary race, but it guarantees the brain never
// persists a reasoning fragment even when one slips past the structured
// thinking/text split. Deliberately duplicates streamEvents.ts's marker
// regex rather than importing it — same reasoning that file's own header
// comment gives for keeping its own independent copy: capture.ts is a
// system boundary (see this project's "validate at system boundaries"
// rule) and must stay decoupled from src/lib/models/**.
//
// Tightened to the observed leak SIGNATURE rather than any literal
// "[reasoning]" substring: a real leak is either (a) preceded by the raw
// ANSI escape byte (\x1b[reasoning] — the actual wire marker, which never
// occurs in organic prose), or (b) glued directly to a word character on
// at least one side with no ESC prefix (e.g. "Nous[reasoning] devons" —
// observed in real captured notes as a mid-word split). A bare
// "[reasoning]" mention surrounded by whitespace/punctuation — quoted in
// backticks, or written as prose after a colon and a space — reads as a
// legitimate reference to the marker convention itself and must survive
// untouched; the old unconditional `/\x1b?\[reasoning\]/` treated ANY
// occurrence as a leak, corrupting that legitimate content.
// eslint-disable-next-line no-control-regex -- intentional: matching the ANSI escape byte itself, same convention as streamEvents.ts's REASONING_MARKER
const REASONING_LEAK_MARKER = /\x1b\[reasoning\]|(?<=\w)\[reasoning\]|\[reasoning\](?=\w)/;

/**
 * Strip any leaked reasoning-channel content from assistant text before it
 * is persisted to the brain.
 *
 * Per line: everything from the marker to the end of that line is dropped
 * (reasoning text has no closing marker to delimit it, so the remainder of
 * the line is treated as reasoning — mirrors the convention the upstream
 * stripInvisibleLines/extractThinkingText split already uses); text on the
 * SAME line BEFORE the marker is kept, since a mid-word leak means real
 * answer text usually precedes it. Lines left empty by stripping are
 * dropped so the result reads as complete, contiguous answer text. See
 * REASONING_LEAK_MARKER's doc comment above for exactly what counts as a
 * leak vs. a legitimate prose mention of "[reasoning]".
 */
export function stripLeakedReasoning(text: string): string {
  const cleaned = text
    .split('\n')
    .map((line) => {
      const idx = line.search(REASONING_LEAK_MARKER);
      return idx === -1 ? line : line.slice(0, idx).trimEnd();
    })
    .filter((line) => line.length > 0)
    .join('\n');
  return cleaned.trim();
}

/**
 * Capture an assistant conversation turn.
 * kind = 'decision' for plan mode, 'episodic' otherwise.
 */
export function captureAssistant(
  userMsg: string,
  assistantMsg: string,
  mode: string,
): void {
  const kind = mode === 'plan' ? 'decision' : 'episodic';
  // Defense-in-depth: strip any leaked reasoning fragments before this text
  // is titled, tagged, or written to the brain — see stripLeakedReasoning's
  // doc comment above for why this can leak past the structured
  // thinking/text split upstream.
  const cleanAssistantMsg = stripLeakedReasoning(assistantMsg);
  const title = userMsg.trim().slice(0, 80) || 'Assistant turn';
  const text = [
    `Q: ${userMsg.trim().slice(0, 400)}`,
    `A: ${cleanAssistantMsg.slice(0, 600)}`,
  ].join('\n\n');

  const { topic, space } = inferTopic(userMsg, cleanAssistantMsg);

  if (isNoisyCapture(text)) return;

  const event: CaptureEvent = {
    kind,
    title,
    text,
    tags: ['assistant', mode],
    source: 'lazy-ide:assistant',
    topic,
    space,
  };

  dispatch(event);
}

export interface CaptureAgentMissionOptions {
  /** Full task/prompt text, when available (Mission.agentTask). Included as
   *  its own line so a kickoff note with no `description` still clears
   *  detectNoise()'s 60-char/8-word bar on its own — previously a kickoff
   *  note carrying only Modele/Worktree (~10 words) qualified as noise and
   *  (before dream.ts's tag exemption) could be invalidated outright. */
  taskText?: string;
  /** Forwarded as CaptureEvent.upsertIfRicher — set this ONLY from the
   *  mission-COMPLETION call site (learningLoop.ts). The kickoff call site
   *  must never set this: it writes the note for the first time, so there
   *  is nothing to upsert against, and blindly requesting upsert semantics
   *  there would be a behavior change for a kind that doesn't need one. */
  upsertIfRicher?: boolean;
}

/**
 * Capture a new agent mission. Called at BOTH mission kickoff (sparse:
 * title/model/worktree, no verdict yet) and mission completion
 * (learningLoop.ts's captureToBrain, richer: verdict + insight summary) —
 * both calls build the same `Mission: ${title}` id (slug + day), so the
 * second call is a same-id rewrite of the first, not a new note. Pass
 * `opts.upsertIfRicher: true` from the completion call site so the engine
 * replaces the sparse kickoff body instead of the write silently
 * conflicting (see capture/writer.ts's ConflictError, and dispatch()'s
 * isConflictError handling above, which used to treat that conflict as a
 * success-equivalent no-op — losing the rich completion text every time).
 */
export function captureAgentMission(
  title: string,
  description: string | undefined,
  model: string,
  worktree: string,
  opts: CaptureAgentMissionOptions = {},
): void {
  const text = [
    description ? `Description : ${description}` : '',
    opts.taskText ? `Tâche : ${opts.taskText}` : '',
    `Modèle : ${model}`,
    `Worktree : ${worktree}`,
  ]
    .filter(Boolean)
    .join('\n');

  const event: CaptureEvent = {
    kind: 'agent',
    title: `Mission: ${title}`,
    text,
    tags: ['agent', 'mission'],
    source: 'lazy-ide:agents',
    space: 'code',
    ...(opts.upsertIfRicher ? { upsertIfRicher: true } : {}),
  };

  dispatch(event);
}

// ── Chat learning loop ─────────────────────────────────────────────

/**
 * Analyse a chat conversation turn and generate learning insights.
 * Unlike the agent learning loop, this works without a mission — it
 * extracts patterns from normal chat interactions.
 *
 * Insights are generated from:
 * - Code blocks present (success pattern — user got working code)
 * - Error/exception mentions (failure pattern)
 * - Refactoring/architecture discussions (brain adaptation)
 * - Test-related discussions (test insight)
 */
export function generateChatInsights(
  userMsg: string,
  assistantMsg: string,
): InsightPayload[] {
  const insights: InsightPayload[] = [];
  const combined = `${userMsg}\n${assistantMsg}`;

  // Code block present → success pattern
  if (CODE_BLOCK_RE.test(combined)) {
    insights.push({
      kind: 'success_pattern',
      title: 'Solution avec code',
      description: 'L\'assistant a fourni une solution avec du code fonctionnel. Pattern de réussite enregistré.',
      actionable: false,
    });
  }

  // Error/exception mentioned → failure pattern
  if (/\b(error|exception|crash|fail|bug|broken|not working|doesn't work|marche pas|erreur)\b/i.test(combined)) {
    insights.push({
      kind: 'failure_pattern',
      title: 'Problème rencontré',
      description: 'La conversation porte sur un problème ou une erreur. Le brain mémorise ce pattern pour aider à résoudre des problèmes similaires.',
      actionable: true,
      suggestion: 'Le brain utilisera ce contexte pour proposer des solutions plus ciblées lors de futures questions similaires.',
    });
  }

  // Refactoring/architecture discussion → brain adaptation
  if (/\b(refactor|architecture|design pattern|optimi[sz]|structure|clean|simplif)\b/i.test(combined)) {
    insights.push({
      kind: 'brain_adaptation',
      title: 'Discussion d\'architecture',
      description: 'La conversation porte sur l\'architecture ou le refactoring. Le brain enrichit sa compréhension des décisions de design.',
      actionable: false,
    });
  }

  // Test-related discussion → test insight
  if (/\b(test|unit test|integration test|coverage|jest|vitest|playwright|pytest)\b/i.test(combined)) {
    insights.push({
      kind: 'test_insight',
      title: 'Discussion sur les tests',
      description: 'La conversation aborde les tests. Le brain apprend les approches de test privilégiées par l\'utilisateur.',
      actionable: true,
      suggestion: 'Le brain suggérera des approches de test similaires dans les futures conversations de code.',
    });
  }

  return insights;
}

/**
 * Capture a learning event from the normal chat (non-agent).
 * Generates insights from the conversation and writes a structured
 * learning neuron to the brain.
 */
export function captureChatLearning(
  userMsg: string,
  assistantMsg: string,
): InsightPayload[] {
  const insights = generateChatInsights(userMsg, assistantMsg);
  if (insights.length === 0) return [];

  const { topic, space } = inferTopic(userMsg, assistantMsg);
  const title = userMsg.trim().slice(0, 80) || 'Chat learning';

  const text = [
    `Q: ${userMsg.trim().slice(0, 300)}`,
    `A: ${assistantMsg.trim().slice(0, 300)}`,
    '',
    `Insights: ${insights.length} généré(s) depuis cette conversation`,
  ].join('\n');

  const event: CaptureEvent = {
    kind: 'learning',
    title: `Chat learning: ${title}`,
    text,
    tags: ['chat', 'learning', ...insights.map((i) => i.kind)],
    source: 'lazy-ide:chat',
    topic,
    space,
    insights,
  };

  dispatch(event);
  return insights;
}

// ── Conversation-level capture ─────────────────────────────────────
//
// Every helper above captures a single TURN or MISSION event. There is
// still no capture that summarises a whole LazyManager conversation — the
// note type conv-file-enrichment.ts (engine) needs to ever attach a
// decision/bug to a file-neuron from a live LazyManager session, since the
// only other pathway that writes one note per whole conversation is the
// bulk external-history importer (import:claude-code/import:cursor), which
// LazyManager never runs. This section closes that gap.
//
// Trigger: wired from agentsStore.tsx's closeManagerConversation — an
// EXISTING UI action (closing a conversation tab), not a new affordance.
// Fires at most once per closed conversation, never per turn.
//
// Cost: zero LLM calls. The "summary" below is a deterministic extraction
// (cap + concatenate the transcript, regex-extract file-path mentions) —
// no model invocation of any kind. The only real cost is one extra
// `lazybrain store` subprocess spawn per conversation CLOSE (already
// bounded by capture.rs's CAPTURE_GATE), never a token/credit spend — and
// only when the conversation actually has content worth remembering (see
// MIN_QUALIFYING_TURNS / isNoisyCapture below).

/** Source tag identifying a conversation-summary note, read back by
 *  engine/src/commands/inject-context/sections.ts to prefer these over
 *  generic notes in the startup [RECENT NOTES]/[RECENT CONVERSATIONS]
 *  block. Kept in sync manually with that file's own copy of this string —
 *  the frontend and the engine are separate packages (the engine runs as a
 *  sidecar subprocess), so no shared import is possible across that
 *  boundary. */
export const CONVERSATION_SUMMARY_SOURCE = 'lazy-manager:conversation-summary';

/**
 * File-path-like tokens: at least one '/'-separated segment plus a short
 * extension. Deliberately duplicates (rather than imports) the engine's own
 * body-mention regex (graph/file-neuron-parse.ts's BODY_PATH_RE) — this
 * module cannot import engine/ code directly (separate package, the engine
 * runs as a sidecar subprocess) — same "system boundary" rationale this
 * file's header already gives for its independent REASONING_LEAK_MARKER
 * copy. Close enough in shape to reliably trip the engine's own body-mention
 * scan on the far side, which is all this needs to do.
 */
const CONV_FILE_PATH_RE =
  /(?:^|[\s(["'])([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z]{1,6})(?=$|[\s),"'.:;!?])/g;

/** Deduplicated, order-preserving file-path mentions found in `text`,
 *  capped at 20 — enough to ground a conversation summary without
 *  ballooning the note body. */
function extractMentionedFiles(text: string): string[] {
  const found = new Set<string>();
  CONV_FILE_PATH_RE.lastIndex = 0;
  for (let m = CONV_FILE_PATH_RE.exec(text); m !== null; m = CONV_FILE_PATH_RE.exec(text)) {
    found.add(m[1].replace(/\\/g, '/'));
    if (found.size >= 20) break;
  }
  return Array.from(found);
}

/** Minimum qualifying (user/assistant, non-empty) turns before a
 *  conversation is worth summarising — a conversation opened and closed
 *  with zero or one real exchange has nothing to remember (honesty
 *  requirement: write nothing rather than a hollow note). */
const MIN_QUALIFYING_TURNS = 2;

/** Most recent turns kept in the transcript excerpt — bounds note size on
 *  long conversations without needing a model call to compress it. */
const MAX_TRANSCRIPT_TURNS = 16;

/** One transcript line, capped so a single long turn cannot dominate the
 *  note body (mirrors captureAssistant's own 400/600-char per-turn caps
 *  above). */
function formatTurn(role: 'user' | 'assistant', content: string): string {
  const label = role === 'user' ? 'User' : 'Assistant';
  return `${label}: ${content.trim().slice(0, 400)}`;
}

/** The subset of ManagerMessage (src/lib/agents/types.ts) this module
 *  actually needs — kept minimal and structural so callers can pass a real
 *  ManagerMessage[] without any conversion. */
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Build the deterministic conversation-summary CaptureEvent for
 * `conversationId`, or `undefined` when the conversation has nothing worth
 * remembering. Pure — no side effects, no dispatch — so callers/tests can
 * inspect the built event before it fires.
 */
export function buildConversationSummaryEvent(
  conversationId: string,
  turns: ConversationTurn[],
  cwd?: string,
): CaptureEvent | undefined {
  const qualifying = turns.filter(
    (t): t is ConversationTurn & { role: 'user' | 'assistant' } =>
      (t.role === 'user' || t.role === 'assistant') && t.content.trim().length > 0,
  );
  if (qualifying.length < MIN_QUALIFYING_TURNS) return undefined;

  const transcript = qualifying
    .slice(-MAX_TRANSCRIPT_TURNS)
    .map((t) => formatTurn(t.role, t.content))
    .join('\n');

  if (isNoisyCapture(transcript)) return undefined;

  const files = extractMentionedFiles(transcript);
  const filesLine = files.length > 0 ? `\n\nFichiers mentionnés : ${files.join(', ')}` : '';

  return {
    kind: 'episodic',
    title: `Conversation ${conversationId}`,
    text: `${transcript}${filesLine}`,
    tags: ['conversation-summary'],
    source: CONVERSATION_SUMMARY_SOURCE,
    space: 'code',
    cwd,
    stableId: conversationId,
    upsertIfRicher: true,
  };
}

/**
 * Capture a deterministic summary of a closed LazyManager conversation.
 * Fire-and-forget (same convention as every other helper in this file) —
 * never throws, and silently does nothing when the conversation has too
 * little content to be worth remembering (see buildConversationSummaryEvent).
 * `stableId`/`upsertIfRicher` on the built event make a second call for the
 * SAME `conversationId` (e.g. the conversation was reopened, extended, and
 * closed again) update the existing note instead of creating a duplicate.
 */
export function captureConversationSummary(
  conversationId: string,
  turns: ConversationTurn[],
  cwd?: string,
): void {
  const event = buildConversationSummaryEvent(conversationId, turns, cwd);
  if (!event) return;
  dispatch(event);
}

/** Debounce between mid-conversation (turn-end) captures of the same thread.
 *  Close-conversation capture still uses captureConversationSummary (no debounce). */
export const MANAGER_TURN_CAPTURE_DEBOUNCE_MS = 45_000;

const lastManagerTurnCaptureAt = new Map<string, number>();

export function resetManagerTurnCaptureForTests(): void {
  lastManagerTurnCaptureAt.clear();
}

/**
 * D91 — periodic / turn-end capture. Same note identity as close-conversation
 * (`stableId` + upsertIfRicher), but skipped when the thread is still too
 * short or a capture landed inside the debounce window.
 * Returns whether a capture was dispatched.
 */
export function maybeCaptureManagerConversation(opts: {
  conversationId: string;
  turns: ConversationTurn[];
  cwd?: string;
  now?: number;
  debounceMs?: number;
}): boolean {
  if (!opts.conversationId) return false;
  const event = buildConversationSummaryEvent(opts.conversationId, opts.turns, opts.cwd);
  if (!event) return false;
  const now = opts.now ?? Date.now();
  const last = lastManagerTurnCaptureAt.get(opts.conversationId) ?? 0;
  const debounce = opts.debounceMs ?? MANAGER_TURN_CAPTURE_DEBOUNCE_MS;
  if (last > 0 && now - last < debounce) return false;
  if (typeof getPlatform().brain?.capture !== 'function') return false;
  lastManagerTurnCaptureAt.set(opts.conversationId, now);
  dispatch(event);
  return true;
}
