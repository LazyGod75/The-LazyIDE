/* conversationTabLabel.ts — deriving a conversation TAB label that's
   actually identifiable at a glance (real QA repro, 2026-08-14: at the
   panel's narrow docked width, 4 of 5 open tabs all began with the exact
   same first user message — "Repondez uniquement en..." — so truncating
   each one's first words independently, which is all the tab strip did
   before this file existed, produced 4 visually IDENTICAL tabs; a user
   could not tell them apart, let alone find the one they wanted).

   ManagerConversationState (agentsStore.tsx) carries no editable/derived
   "title" field — a full rename feature is out of this fix's scope (see
   LazyManagerHeader.tsx's own ManagerConversationTab doc comment: "never a
   separate, translated id"). But every open conversation's id already
   IS a real timestamp: mintManagerSessionId() (lib/agents/
   managerPersistence.ts) mints ids shaped `manager-<epoch-ms>-<rand>`, so
   this file recovers that creation time with no new persisted field and no
   new store plumbing — the smallest fix that actually disambiguates.

   Reuses truncateLabel.ts (word-boundary aware, always-ellipsis truncation
   — see that file's own module doc comment for why a second truncator
   must never be added) for every string cut here; this file adds nothing
   but the collision detection and the timestamp recovery/formatting on
   top of it. */

import { truncateLabel } from './truncateLabel';

/** Short, inline tab label budget — matches the tab strip's own
 *  `maxWidth` (LazyManagerConversationTabs.tsx) closely enough that most
 *  labels fit without their own ellipsis firing twice. */
const TAB_LABEL_MAX_CHARS = 20;

/** The tooltip can carry much more of the original message than the
 *  inline label — still bounded so a whole mission brief pasted as the
 *  first message can never balloon a native `title` attribute. */
const TAB_TOOLTIP_PREVIEW_MAX_CHARS = 140;

/** Matches `mintManagerSessionId()`'s own shape (managerPersistence.ts):
 *  `manager-<epoch-ms>-<random>`. Anchored at the start so it only matches
 *  a real conversation id, never a substring elsewhere. */
const CONVERSATION_ID_TIMESTAMP_RE = /^manager-(\d+)-/;

/**
 * Recovers the creation time encoded in a `mintManagerSessionId()` id.
 * `undefined` for any id that doesn't match that shape (a test fixture's
 * bare `conv-1`, or a future id format) — callers degrade to the plain
 * truncated label rather than showing a fabricated time.
 */
export function parseConversationCreatedAtMs(conversationId: string): number | undefined {
  const match = conversationId.match(CONVERSATION_ID_TIMESTAMP_RE);
  if (!match) return undefined;
  const ms = Number(match[1]);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Locale-agnostic HH:MM — same `toLocaleTimeString([], { hour12: false
 *  })` idiom already used for short timestamps elsewhere in this codebase
 *  (see lib/agents/forkFromReplay.ts's own doc comment on why `hour12:
 *  false` is required, not cosmetic: without it some locales render a
 *  leading "24" for midnight instead of "00"). */
export function formatConversationTimeLabel(createdAtMs: number): string {
  return new Date(createdAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export interface ConversationTabSource {
  id: string;
  /** Trimmed or not — this file trims it itself. `undefined`/empty for a
   *  still-empty conversation, which yields an `undefined` label (the tab
   *  strip's own ordinal fallback, unchanged). */
  firstUserMessage?: string;
  /** Rename feature — a user-chosen name (agentsStore.tsx's
   *  ManagerConversationState.customTitle), set via double-clicking the
   *  tab. Takes priority over `firstUserMessage` as the label's SOURCE
   *  text: an explicit rename is always more distinguishing than whatever
   *  the conversation happened to open with. Still runs through the exact
   *  same truncation + collision detection as a derived label below — two
   *  conversations renamed to the same thing (or a rename that happens to
   *  match another tab's derived label) must stay just as distinguishable
   *  as the original bug this file fixes, never a silent exception to it. */
  customTitle?: string;
}

export interface ConversationTabLabel {
  id: string;
  /** Short, inline label — `undefined` only when the source conversation
   *  has no first user message yet. */
  title?: string;
  /** Longer (but still bounded) tooltip preview. Same `undefined` contract
   *  as `title`. */
  fullTitle?: string;
}

/**
 * Derives {title, fullTitle} for every conversation in `sources`, in the
 * SAME order they were given. Two (or more) conversations whose plain
 * truncated titles are identical (case/whitespace-insensitive compare —
 * the real repro above) get their creation time appended to the SHORT
 * label only, so they read as e.g. "Repondez uniquement… · 09:14" and
 * "Repondez uniquement… · 09:41" instead of two copies of the exact same
 * string. Non-colliding titles are left exactly as truncateLabel produced
 * them — untouched, no suffix, matching the pre-existing behaviour for the
 * overwhelmingly common case (every open conversation about something
 * different).
 *
 * ABSOLUTE-UNIQUENESS FLOOR (real-user escalation, 2026-08-15: this label
 * sits on the critical path of a FORCED choice — the open-conversation cap
 * disables "New conversation" until the user closes one of their existing
 * tabs, so two tabs that still read identically here is a genuine
 * data-loss-adjacent risk, not merely cosmetic). The HH:MM time suffix
 * above is minute-granularity — two conversations opened in the same
 * minute (entirely plausible: the original repro was several tabs opened
 * in a quick burst of copy-pasted prompts) would still tie. A SECOND pass
 * below catches any label that's STILL a duplicate after the time suffix —
 * whether from same-minute creation, from missing timestamps entirely (a
 * test fixture id, or a future id format — parseConversationCreatedAtMs
 * returns `undefined`), or from two independent renames landing on the
 * exact same text — and appends a running ordinal (`" (2)"`, `" (3)"`,
 * ...), the same Explorer/VS-Code duplicate-name convention. This is an
 * unconditional guarantee: no two DEFINED titles this function returns are
 * ever equal (case/whitespace-insensitive) for a given call. `undefined`
 * titles (still-empty conversations) are exempt — the tab strip's own
 * 1-based ordinal fallback already keeps those visually distinct by tab
 * position, so there is nothing to guarantee here.
 */
export function buildConversationTabLabels(sources: ConversationTabSource[]): ConversationTabLabel[] {
  const candidates = sources.map((source) => {
    // A rename wins over the derived first-message text (see
    // ConversationTabSource.customTitle's own doc comment) — same
    // truncation, same downstream collision handling, just a different
    // SOURCE string.
    const trimmed = source.customTitle?.trim() || source.firstUserMessage?.trim();
    if (!trimmed) return { id: source.id, base: undefined as string | undefined, fullBase: undefined as string | undefined };
    return {
      id: source.id,
      base: truncateLabel(trimmed, TAB_LABEL_MAX_CHARS),
      fullBase: truncateLabel(trimmed, TAB_TOOLTIP_PREVIEW_MAX_CHARS),
    };
  });

  const occurrences = new Map<string, number>();
  for (const c of candidates) {
    if (!c.base) continue;
    const key = c.base.trim().toLowerCase();
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }

  const withTimeSuffix = candidates.map((c) => {
    if (!c.base || !c.fullBase) return { id: c.id, title: undefined as string | undefined, fullTitle: undefined as string | undefined };
    const collides = (occurrences.get(c.base.trim().toLowerCase()) ?? 0) > 1;
    const createdAtMs = parseConversationCreatedAtMs(c.id);
    const timeLabel = createdAtMs !== undefined ? formatConversationTimeLabel(createdAtMs) : undefined;
    return {
      id: c.id,
      title: collides && timeLabel ? `${c.base} · ${timeLabel}` : c.base,
      fullTitle: timeLabel ? `${c.fullBase} (${timeLabel})` : c.fullBase,
    };
  });

  // Absolute-uniqueness pass — see this function's own doc comment above.
  const seenTitleCount = new Map<string, number>();
  return withTimeSuffix.map((c) => {
    if (c.title === undefined) return c;
    const key = c.title.trim().toLowerCase();
    const seenBefore = seenTitleCount.get(key) ?? 0;
    seenTitleCount.set(key, seenBefore + 1);
    if (seenBefore === 0) return c;
    return { ...c, title: `${c.title} (${seenBefore + 1})` };
  });
}
