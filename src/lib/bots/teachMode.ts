/* teachMode — teach-by-demonstration journaling for LazyBots.

   When teach mode is active on a bot, every user input (keyboard, mouse
   clicks on specific elements, form submissions) is journaled as a
   "demonstration step". The journal is then compiled by skillCompiler.ts
   into a reusable skill prompt that the bot can follow to reproduce the
   demonstrated workflow.

   IMPORTANT: teach mode journals INPUTS (what the user typed, what they
   clicked), NOT raw desktop.mouse events. This is because a skill must be
   reproducible across different screen layouts — "click the 'Buy' button"
   is portable, "click at (340, 220)" is not. The journal entries therefore
   carry semantic selectors and typed text, not coordinates.
*/

/** A single demonstration step journaled during teach mode. */
export interface TeachStep {
  id: string;
  /** The kind of action demonstrated. */
  kind: 'navigate' | 'click' | 'type' | 'select' | 'submit' | 'wait' | 'screenshot' | 'note';
  /** A semantic description of the target (e.g. "the 'Add to Cart' button", "the search input"). */
  target: string;
  /** The value typed/selected, if applicable. */
  value?: string;
  /** A CSS selector or page URL, if available — helps the bot reproduce. */
  selector?: string;
  /** Free-text note from the teacher (why this step matters). */
  note?: string;
  /** Timestamp (ISO). */
  timestamp: string;
}

/** A teach-by-demonstration journal — the raw recording of a teaching session. */
export interface TeachJournal {
  id: string;
  botId: string;
  /** The name of the skill being taught (e.g. "Order from Amazon"). */
  skillName: string;
  /** The steps recorded, in order. */
  steps: TeachStep[];
  /** When the teaching session started (ISO). */
  startedAt: string;
  /** When the teaching session ended (ISO), or null if still recording. */
  endedAt: string | null;
}

/** In-memory active teach sessions, keyed by botId. */
const activeSessions = new Map<string, TeachJournal>();

/** Start a teach session for a bot. Returns the journal id. */
export function startTeachSession(botId: string, skillName: string): string {
  const id = `teach_${Date.now().toString(36)}`;
  const journal: TeachJournal = {
    id,
    botId,
    skillName,
    steps: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  activeSessions.set(botId, journal);
  return id;
}

/** Record a step in the active teach session for a bot. */
export function recordTeachStep(
  botId: string,
  step: Omit<TeachStep, 'id' | 'timestamp'>,
): TeachStep | null {
  const journal = activeSessions.get(botId);
  if (!journal) return null;
  const fullStep: TeachStep = {
    ...step,
    id: `step_${journal.steps.length + 1}`,
    timestamp: new Date().toISOString(),
  };
  journal.steps = [...journal.steps, fullStep];
  return fullStep;
}

/** End the active teach session and return the completed journal. */
export function endTeachSession(botId: string): TeachJournal | null {
  const journal = activeSessions.get(botId);
  if (!journal) return null;
  journal.endedAt = new Date().toISOString();
  activeSessions.delete(botId);
  return journal;
}

/** Get the active teach session for a bot (or null). */
export function getActiveTeachSession(botId: string): TeachJournal | null {
  return activeSessions.get(botId) ?? null;
}

/** Check if a bot is currently in teach mode. */
export function isTeachModeActive(botId: string): boolean {
  return activeSessions.has(botId);
}

/** Clear all teach sessions — tests and hot-reload only. */
export function resetTeachMode(): void {
  activeSessions.clear();
}
