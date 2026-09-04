/* missionHistoryWindow.ts — bounds a mission's conversation history sent to
   the LLM on every ReAct step (managedAgent.ts's `messages` array).

   Problem (token-efficiency audit, 2026-08-14): managedAgent.ts's mission
   loop appends one assistant turn + one compressed observation onto
   `messages` every step, for up to MAX_STEPS (100) steps, and never windows
   it — unlike this codebase's two OTHER ReAct loops, which already do:
     - managerHistoryWindow.ts's boundManagerHistory (LazyManager chat turns,
       token-efficiency audit 2026-08-01) — this module mirrors its design.
     - src/cli/lib/agentLoop.ts and src/cli/ide/ideAgent.ts (the CLI's
       headless reproductions of THIS SAME loop) already cap `messages`
       at 22/24 entries and rebuild a bounded window every step — the
       production loop this file fixes was the one surface missing the
       safeguard its own headless twin already had.
   A mission that runs 80 steps before FINAL resends 79 previous turns'
   worth of THOUGHT/ACTION/ARGS + observations, verbatim, on step 80 — a
   cost that grows LINEARLY with mission length, stacked on top of the
   (already lazy-loaded, see toolRegistryLazy.ts) tool-definitions block and
   system prompt.

   Fix: boundMissionHistory — a char-budget sliding window over a
   CONTIGUOUS suffix of the most recent messages, plus the mission's first
   message (the task prompt built by planAndActManaged's caller) pinned
   unconditionally once anything is dropped. Deliberately NOT an
   LLM-generated rolling summary — same reasoning as
   managerHistoryWindow.ts's header: it would double round-trips on every
   step just to compact the NEXT one, it can silently misstate progress
   (exactly the "pretend a tool succeeded" failure class this product
   already treats as a HONESTY violation elsewhere in managedAgent.ts), and
   it is unnecessary here — a mission's durable state (files written, tests
   run) lives on disk and is re-discoverable via read_file/git_diff, not
   only in the conversation prose.
*/

/** Structural shape of one mission-loop message — matches managedAgent.ts's
 *  inline `{ role: string; content: string }` element type exactly, kept
 *  local (not imported) so this module has no dependency on managedAgent.ts
 *  and stays a pure, dependency-free leaf like managerHistoryWindow.ts. */
export interface MissionMessage {
  role: string;
  content: string;
}

/** Default char budget for the windowed portion of a mission's history
 *  (excludes the pinned first message and the marker, both accounted for
 *  separately — see boundMissionHistory's own doc comment). Larger than
 *  MANAGER_HISTORY_CHAR_BUDGET (40k) because a mission's observations carry
 *  real working state a coding agent needs (file windows, test output,
 *  diffs) that a chat turn does not — dropping it too aggressively costs
 *  correctness (the agent re-reads/re-discovers things it already knew),
 *  which this task treats as strictly worse than the token savings. Same
 *  ~4-chars/token estimate used elsewhere in this codebase (see
 *  managerTurnBudget.ts, toolRegistryLazy.ts). Exported so a caller/test can
 *  override it deliberately, never silently. */
export const MISSION_HISTORY_CHAR_BUDGET = 60_000;

/** Hard cap on how much of the pinned first message (the task prompt) is
 *  resent — it is pinned unconditionally once anything is dropped, so
 *  without a cap a very long task prompt (a big pasted spec, wide project
 *  context) could itself consume the whole budget for the rest of the
 *  mission. Truncated, never dropped: a partial task beats none at all. */
const PINNED_TASK_CHAR_CAP = 6_000;

export interface BoundedMissionHistory {
  /** The messages to actually send to the LLM this step. */
  messages: MissionMessage[];
  /** How many original messages were elided (0 when nothing was dropped —
   *  the common case for any mission short enough to fit the budget). */
  droppedCount: number;
}

/**
 * Bound `messages` (oldest-first, as managedAgent.ts's `messages` array
 * already is) to `charBudget` chars, keeping a contiguous suffix of the
 * most recent messages plus the pinned first message (the task prompt) when
 * anything was dropped. Never mutates the input array (immutability
 * convention — see coding-style.md).
 *
 * The current step's own message (the last one — the most recent
 * observation or user intervention) is ALWAYS kept even if it alone exceeds
 * the budget on its own — never drop what the agent must react to right now.
 */
export function boundMissionHistory(
  messages: readonly MissionMessage[],
  charBudget: number = MISSION_HISTORY_CHAR_BUDGET,
): BoundedMissionHistory {
  if (messages.length === 0) return { messages: [], droppedCount: 0 };

  // Walk backwards from the most recent message, accumulating a CONTIGUOUS
  // suffix (never picking messages out of order) until the budget would be
  // exceeded. Because this is always a contiguous suffix, whenever anything
  // is dropped it is always the OLDEST messages — including messages[0] —
  // which is what makes "pin messages[0] whenever droppedCount > 0" correct
  // without a separate membership check.
  const kept: MissionMessage[] = [];
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
    first.content.length > PINNED_TASK_CHAR_CAP
      ? `${first.content.slice(0, PINNED_TASK_CHAR_CAP)}…[truncated — this was the mission's task prompt, kept as the standing goal]`
      : first.content;
  const pinnedFirst: MissionMessage = { ...first, content: truncatedFirstContent };

  // role 'user' (not 'system') — matches managedAgent.ts's own convention:
  // every non-assistant message in a mission's `messages` array (the task
  // prompt, observations, reflections, interventions) is role 'user'; the
  // system prompt is sent separately as `system`, never as a message.
  const marker: MissionMessage = {
    role: 'user',
    content:
      `[HISTORY WINDOW — not a tool observation] ${droppedCount} earlier step(s) omitted here for length. ` +
      'The task above still applies. Durable state (files written, tests run) lives on disk, not only in this ' +
      'transcript — use read_file/git_diff/git_status/review_diff to re-check anything you need that is not shown below.',
  };

  return { messages: [pinnedFirst, marker, ...kept], droppedCount };
}
