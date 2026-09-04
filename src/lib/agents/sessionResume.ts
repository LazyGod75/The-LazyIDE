/* sessionResume — cross-harness session resume via the brain.

   When an agent mission completes (or is interrupted), its conversation
   state is captured as a brain note with `data-cerveau-type='session'`.
   This allows resuming the session later — even from a different harness
   (Claude Code → Codex, or vice-versa) — by loading the session state
   from the brain and injecting it into the new harness's initial prompt.

   Session notes contain:
   - The original task
   - The conversation history (compressed)
   - Key decisions and file changes
   - The harness that originally ran the session

   On resume, the session note is loaded and formatted as a "session
   resume" block that gives the new harness enough context to continue
   the work without restarting from scratch.
*/

import { getPlatform } from '../platform/index.js';

const SESSION_NOTE_TYPE = 'session';
const SESSION_TITLE_PREFIX = '[session]';
const MAX_HISTORY_CHARS = 4000;
const MAX_FILES_CHARS = 1000;

export interface SessionState {
  missionId: string;
  task: string;
  harness: 'claude-code' | 'codex' | 'managed' | 'unknown';
  conversationHistory: Array<{ role: string; content: string }>;
  filesChanged: string[];
  keyDecisions: string[];
  timestamp: number;
}

/**
 * Capture a session state and store it as a brain note.
 * Non-blocking — failures are caught and logged, never thrown.
 */
export async function captureSession(state: SessionState): Promise<void> {
  try {
    const platform = getPlatform();
    const title = `${SESSION_TITLE_PREFIX} ${state.missionId.slice(0, 8)} — ${state.task.slice(0, 60)}`;

    // Compress conversation history to fit within brain note limits
    const compressedHistory = state.conversationHistory
      .slice(-6) // Last 3 turns (user + assistant)
      .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
      .join('\n')
      .slice(0, MAX_HISTORY_CHARS);

    const filesList = state.filesChanged.slice(0, 20).join('\n').slice(0, MAX_FILES_CHARS);
    const decisions = state.keyDecisions.slice(0, 5).join('\n');

    const body = [
      `Mission: ${state.missionId}`,
      `Harness: ${state.harness}`,
      `Task: ${state.task}`,
      `Timestamp: ${new Date(state.timestamp).toISOString()}`,
      '',
      '## Key Decisions',
      decisions || '(none recorded)',
      '',
      '## Files Changed',
      filesList || '(none)',
      '',
      '## Recent Conversation',
      compressedHistory || '(empty)',
    ].join('\n');

    await platform.brain.capture({
      kind: 'agent',
      title,
      text: body,
      tags: [SESSION_NOTE_TYPE, `mission:${state.missionId}`, `harness:${state.harness}`],
      files: state.filesChanged,
    });
  } catch (err) {
    console.warn('[sessionResume] captureSession failed:', err);
  }
}

/**
 * Load the most recent session state for a given mission ID from the brain.
 * Returns null if no session is found.
 */
export async function loadSessionResume(missionId: string): Promise<SessionState | null> {
  try {
    const platform = getPlatform();
    const recall = await platform.brain.recallScoped(
      `${SESSION_TITLE_PREFIX} ${missionId}`,
      'all',
    );
    const nodes = (recall.nodes ?? []).filter(n => n.title.includes(SESSION_TITLE_PREFIX));
    if (nodes.length === 0) return null;

    // Get the most recent result (highest score)
    const latest = nodes[0];
    return parseSessionNote(latest.title, latest.snippet);
  } catch (err) {
    console.warn('[sessionResume] loadSessionResume failed:', err);
    return null;
  }
}

/**
 * Find all resumable sessions (most recent first).
 */
export async function listResumableSessions(): Promise<SessionState[]> {
  try {
    const platform = getPlatform();
    const recall = await platform.brain.recallScoped(SESSION_TITLE_PREFIX, 'all');
    const nodes = (recall.nodes ?? []).filter(n => n.title.includes(SESSION_TITLE_PREFIX));
    return nodes
      .map(r => parseSessionNote(r.title, r.snippet))
      .filter((s): s is SessionState => s !== null);
  } catch (err) {
    console.warn('[sessionResume] listResumableSessions failed:', err);
    return [];
  }
}

/**
 * Format a session state as a "resume" block for injection into a new
 * harness's initial prompt. Gives the agent enough context to continue
   the work without restarting.
 */
export function formatSessionResume(state: SessionState): string {
  const history = state.conversationHistory
    .slice(-4)
    .map(m => `${m.role}: ${m.content.slice(0, 150)}`)
    .join('\n');

  return [
    `<session_resume>`,
    `You are continuing a previous mission that was interrupted or completed.`,
    `Original harness: ${state.harness}`,
    `Original task: ${state.task}`,
    ``,
    `## Files previously modified`,
    state.filesChanged.length > 0 ? state.filesChanged.slice(0, 10).join('\n') : '(none)',
    ``,
    `## Key decisions made`,
    state.keyDecisions.length > 0 ? state.keyDecisions.slice(0, 5).join('\n') : '(none)',
    ``,
    `## Recent conversation context`,
    history || '(empty)',
    ``,
    `Continue the mission from where it left off. Do not redo work already completed.`,
    `</session_resume>`,
  ].join('\n');
}

// ── Parsing ────────────────────────────────────────────────────────

function parseSessionNote(_title: string, body: string): SessionState | null {
  try {
    const missionMatch = body.match(/Mission:\s*(.+)/);
    const harnessMatch = body.match(/Harness:\s*(.+)/);
    const taskMatch = body.match(/Task:\s*(.+)/);
    const timestampMatch = body.match(/Timestamp:\s*(.+)/);

    if (!missionMatch || !taskMatch) return null;

    const filesSection = body.split('## Files Changed')[1]?.split('##')[0]?.trim() ?? '';
    const filesChanged = filesSection ? filesSection.split('\n').filter(Boolean) : [];

    const decisionsSection = body.split('## Key Decisions')[1]?.split('##')[0]?.trim() ?? '';
    const keyDecisions = decisionsSection && decisionsSection !== '(none recorded)'
      ? decisionsSection.split('\n').filter(Boolean)
      : [];

    const historySection = body.split('## Recent Conversation')[1]?.trim() ?? '';
    const conversationHistory = historySection && historySection !== '(empty)'
      ? historySection.split('\n').map(line => {
          const match = line.match(/^(user|assistant|system):\s*(.+)/);
          return match ? { role: match[1], content: match[2] } : null;
        }).filter((m): m is { role: string; content: string } => m !== null)
      : [];

    return {
      missionId: missionMatch[1].trim(),
      harness: (harnessMatch?.[1]?.trim() as SessionState['harness']) ?? 'unknown',
      task: taskMatch[1].trim(),
      conversationHistory,
      filesChanged,
      keyDecisions,
      timestamp: timestampMatch ? new Date(timestampMatch[1].trim()).getTime() : Date.now(),
    };
  } catch {
    return null;
  }
}
