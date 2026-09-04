/* transcriptCompact — OpenCode/Claude Code-style context clipping.

   When a conversation grows past a character budget, keep the recent tail
   verbatim and fold older turns into one message whose body is ONLY
   excerpts of those real turns. Nothing is invented: no LLM summary by
   default (optional `summarize` hook for callers that wire one), no
   hardcoded "the user asked about X". If the transcript is short, it is
   returned unchanged.

   B32: default excerpts prefer the first meaningful line + a mid/end
   snippet when the turn is long, so compaction keeps signal without an LLM.

   pruneStaleObservations shortens older ReAct "Observation:" tool results
   the same way: keep the last few full, clip the rest to real prefixes. */

export const COMPACT_TRIGGER_CHARS = 24_000;
/** ~4 chars/token — used when callers pass `triggerTokens`. */
export const CHARS_PER_TOKEN = 4;
export const COMPACT_TRIGGER_TOKENS = 6_000;
export const COMPACT_KEEP_RECENT = 12;
export const COMPACT_EXCERPT_CHARS = 1_200;
export const OBS_KEEP_RECENT = 3;
export const OBS_EXCERPT_CHARS = 240;
const OBS_PREFIX = 'Observation:';

export interface CompactableMessage {
  id: string;
  role: string;
  content: string;
  timestamp?: string;
}

function asText(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

export function transcriptCharCount(messages: readonly { content?: unknown }[]): number {
  let n = 0;
  for (const m of messages) n += asText(m.content).length;
  return n;
}

export function transcriptTokenEstimate(messages: readonly { content?: unknown }[]): number {
  return Math.ceil(transcriptCharCount(messages) / CHARS_PER_TOKEN);
}

/** Prefer head + tail of a long turn so both intent and outcome survive. */
export function excerptTurn(text: unknown, maxChars: number): string {
  const s = asText(text).trim();
  if (s.length <= maxChars) return s;
  if (maxChars < 40) return `${s.slice(0, maxChars)}…`;
  const headBudget = Math.floor(maxChars * 0.65);
  const tailBudget = Math.max(12, maxChars - headBudget - 5);
  const head = s.slice(0, headBudget).trimEnd();
  const tail = s.slice(-tailBudget).trimStart();
  return `${head}\n…\n${tail}`;
}

function excerpt(text: unknown, maxChars: number): string {
  return excerptTurn(text, maxChars);
}

/**
 * Clip a long transcript the way OpenCode prunes: recent tail stays full,
 * older turns become one message of real excerpts. Identity fields on the
 * folded message come from the first clipped turn so we never mint fake ids.
 * `force` skips the character budget (slash `/compact`).
 */
export interface CompactTranscriptMeta {
  foldedTurns: number;
  charsBefore: number;
  charsAfter: number;
}

export interface CompactTranscriptResult<T extends CompactableMessage> {
  messages: T[];
  meta: CompactTranscriptMeta;
}

// eslint-disable-next-line complexity -- compact logic is inherently branchy
export function compactTranscriptWithMeta<T extends CompactableMessage>(
  messages: readonly T[],
  opts?: {
    keepRecent?: number;
    excerptChars?: number;
    triggerChars?: number;
    /** Token budget (chars/CHARS_PER_TOKEN). Wins over triggerChars when set. */
    triggerTokens?: number;
    force?: boolean;
    /** Optional summariser for the folded head. Must return excerpts of
     *  real turns — never invent. When omitted, verbatim excerpts are used. */
    summarize?: (folded: readonly T[]) => string;
  },
): CompactTranscriptResult<T> {
  const charsBefore = transcriptCharCount(messages);
  const keepRecent = opts?.keepRecent ?? COMPACT_KEEP_RECENT;
  const excerptChars = opts?.excerptChars ?? COMPACT_EXCERPT_CHARS;
  const triggerChars = opts?.triggerTokens != null
    ? opts.triggerTokens * CHARS_PER_TOKEN
    : (opts?.triggerChars ?? COMPACT_TRIGGER_CHARS);
  const unchanged = { messages: [...messages], meta: { foldedTurns: 0, charsBefore, charsAfter: charsBefore } };
  if (messages.length <= keepRecent + 1) return unchanged;
  if (!opts?.force && charsBefore <= triggerChars) return unchanged;

  const head = messages.slice(0, -keepRecent);
  const tail = messages.slice(-keepRecent);
  const first = head[0];
  if (!first) return unchanged;

  const body = opts?.summarize
    ? opts.summarize(head)
    : head.map((m) => `${m.role}: ${excerpt(m.content, excerptChars)}`).join('\n\n');

  const folded = {
    ...first,
    role: first.role,
    content: `[compacted ${head.length} earlier turns — verbatim excerpts]\n\n${body}`,
  } as T;
  const out = [folded, ...tail];
  return {
    messages: out,
    meta: { foldedTurns: head.length, charsBefore, charsAfter: transcriptCharCount(out) },
  };
}

export function compactTranscript<T extends CompactableMessage>(
  messages: readonly T[],
  opts?: {
    keepRecent?: number;
    excerptChars?: number;
    triggerChars?: number;
    triggerTokens?: number;
    force?: boolean;
    summarize?: (folded: readonly T[]) => string;
  },
): T[] {
  return compactTranscriptWithMeta(messages, opts).messages;
}

/** Shorten older ReAct tool observations; keep the last few verbatim. */
export function pruneStaleObservations<T extends { content: string }>(
  messages: readonly T[],
  opts?: { keepRecent?: number; excerptChars?: number },
): T[] {
  const keepRecent = opts?.keepRecent ?? OBS_KEEP_RECENT;
  const excerptChars = opts?.excerptChars ?? OBS_EXCERPT_CHARS;
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (asText(messages[i].content).startsWith(OBS_PREFIX)) indices.push(i);
  }
  if (indices.length <= keepRecent) return [...messages];
  const stale = new Set(indices.slice(0, -keepRecent));
  return messages.map((m, i) => {
    if (!stale.has(i)) return m;
    const body = asText(m.content).slice(OBS_PREFIX.length).trimStart();
    if (body.length <= excerptChars) return m;
    return { ...m, content: `${OBS_PREFIX} ${excerpt(body, excerptChars)}` };
  });
}
