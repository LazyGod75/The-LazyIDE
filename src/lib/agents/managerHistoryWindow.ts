/* managerHistoryWindow.ts — bounds the LazyManager conversation history sent
   to the LLM on every turn.

   Problem (token-efficiency audit, 2026-08-01): agentsStore.tsx's
   sendManagerMessage sent the ENTIRE state.managerMessages array,
   untruncated and unsummarized, on every single turn — see the call site
   that used to read `const turnMessages = [...state.managerMessages,
   userMsg]`. That is a cost that grows LINEARLY with how long the session
   has been running: turn 50 of a long working session resent every one of
   the previous 49 exchanges verbatim, on top of the ~73k-char static core
   (managerEngine.ts's buildManagerCorePrompt) and the per-turn dynamic
   context. Nothing windowed it, nothing summarized it.

   Fix: boundManagerHistory keeps a char-budget-driven sliding window of the
   MOST RECENT messages (never mid-message truncation — a half-finished
   <lazy_actions> JSON block or a half-quoted charter is worse than dropping
   the whole turn), plus the conversation's very first message pinned
   unconditionally when it falls outside the window — the "standing goal"
   that actually kicked off this session, which nothing else in the prompt
   reconstructs.

   Deliberately NOT an LLM-generated rolling summary of the dropped turns:
     1. it would double the network round-trips (and their cost/latency) on
        EVERY turn just to produce compaction context for the NEXT one —
        defeating the point of a token-efficiency fix.
     2. a generated summary can silently misstate or drop something, with
        nothing to catch it, which is exactly the "silently lose
        information" failure mode this task must avoid.
     3. it is unnecessary here: the two categories of state this task calls
        out as must-survive are ALREADY reconstructed from real, live state
        every single turn, independent of raw conversation text —
          - pending approvals: deriveCharterStatusContext (agentsStore.tsx)
            scans the FULL, un-windowed state.managerMessages directly (it
            is called with that array BEFORE this module ever windows a
            copy for the LLM call) and turns it into
            ManagerContext.charterStatusContext, a compact structured
            signal, every turn.
          - in-flight missions: buildManagerDynamicContext's missionLines
            and canvasDigest (managerEngine.ts) are built from the live
            Mission[]/canvas store, never parsed out of conversation prose.
     What raw history uniquely carries — free-form things the user said
     that never became structured state (a style preference, a constraint
     mentioned in passing) — is exactly what pinning the first message plus
     a generous recent window is meant to preserve; anything older than
     that, in the middle of a long session, is an honest, bounded, and
     disclosed loss (the marker message says so), never a silent one.
*/

import type { ManagerMessage } from './types.js';

/**
 * Default char budget for the windowed portion of history (excludes the
 * pinned first message and the marker, both accounted for separately by
 * the caller — see boundManagerHistory's own doc comment). ~10k tokens at
 * the same ~4-chars/token estimate used elsewhere in this codebase (see
 * managerTurnBudget.ts) — generous enough to keep many real exchanges (a
 * typical user/assistant turn pair in this product runs a few hundred to a
 * few thousand chars; see managerTurnBudget.test.ts for measured examples)
 * while still bounding the worst case of a session that has been running
 * for hours. Exported so a caller/test can override it deliberately, never
 * silently.
 */
export const MANAGER_HISTORY_CHAR_BUDGET = 40_000;

/** Hard cap on how much of the pinned first message's content is resent —
 *  it is pinned UNCONDITIONALLY (see module header), so without a cap a
 *  single very long opening message (a pasted spec, a long brief) could
 *  itself consume the whole budget every turn for the rest of the session.
 *  Truncated, never dropped: a partial standing goal beats none at all. */
const PINNED_FIRST_MESSAGE_CHAR_CAP = 4_000;

export interface BoundedManagerHistory {
  /** The messages to actually send to the LLM this turn. */
  messages: ManagerMessage[];
  /** How many original messages were elided (0 when nothing was dropped —
   *  the common case for any session short enough to fit the budget). */
  droppedCount: number;
}

/**
 * Bound `messages` (oldest-first, as state.managerMessages/turnMessages
 * already are) to `charBudget` chars, keeping a contiguous suffix of the
 * most recent messages plus the pinned first message when anything was
 * dropped. Never mutates the input array (returns a new array — see this
 * codebase's immutability convention, coding-style.md).
 *
 * The current turn's own message (the last one) is ALWAYS kept even if it
 * alone exceeds the budget on its own — never drop the very question being
 * asked this turn.
 */
export function boundManagerHistory(
  messages: readonly ManagerMessage[],
  charBudget: number = MANAGER_HISTORY_CHAR_BUDGET,
): BoundedManagerHistory {
  if (messages.length === 0) return { messages: [], droppedCount: 0 };

  // Walk backwards from the most recent message, accumulating a CONTIGUOUS
  // suffix (never picking messages out of order) until the budget would be
  // exceeded. Because this is always a contiguous suffix, whenever anything
  // is dropped it is always the OLDEST messages — including messages[0] —
  // which is what makes the "pin messages[0] whenever droppedCount > 0"
  // rule below correct without a separate membership check.
  const kept: ManagerMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const len = messages[i].content.length;
    if (kept.length > 0 && used + len > charBudget) break;
    kept.unshift(messages[i]);
    used += len;
  }

  const droppedCount = messages.length - kept.length;
  if (droppedCount === 0) return { messages: kept, droppedCount: 0 };

  const first = messages[0];
  const truncatedFirstContent =
    first.content.length > PINNED_FIRST_MESSAGE_CHAR_CAP
      ? `${first.content.slice(0, PINNED_FIRST_MESSAGE_CHAR_CAP)}…[truncated — this was the opening message, kept as the session's standing goal]`
      : first.content;
  const pinnedFirst: ManagerMessage = { ...first, content: truncatedFirstContent };

  // role 'user' (not 'system' — ManagerMessage's type technically allows
  // 'system', but nothing downstream actually forwards that role: the
  // ai-proxy edge function's ChatMessage type is `"user" | "assistant"`
  // only, see supabase/functions/ai-proxy/index.ts. Mirrors the SAME
  // established convention agentsStore.tsx's runGroundedFollowUp already
  // uses for injecting a synthetic non-human turn — a bracketed
  // "[... — not the human]" prefix on a role:'user' message — rather than
  // introducing an unprecedented role value into the wire format.
  const marker: ManagerMessage = {
    id: `history-window-marker-${kept[0]?.id ?? first.id}`,
    role: 'user',
    content: `[HISTORY WINDOW — not the human] ${droppedCount} earlier message(s) omitted here for length. The standing goal above still applies. This is NOT a loss of operational state: pending approvals, in-flight missions, and canvas state are all reported fresh in "Current State" below, every turn, independent of this history.`,
    timestamp: first.timestamp,
  };

  return { messages: [pinnedFirst, marker, ...kept], droppedCount };
}
