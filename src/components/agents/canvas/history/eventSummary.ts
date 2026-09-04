/* eventSummary.ts — pure, presentation-only formatting for one raw journal
   row inside RunHistoryDrawer's compact event timeline. Deliberately generic
   (not a per-event-type template, unlike activityFeedFormat.ts's French
   ticker labels) — see summarizePayload's doc comment for why: a per-type
   map for all ~40 event types (eventTypes.ts) would need 6-locale i18n
   entries for content that is fundamentally a technical audit row, not
   product copy. The raw dotted `type` string (e.g. "gate.passed") is shown
   verbatim as the row's own identifier instead, exactly as the journal
   itself names it.
*/

import type { JournalEventRow, JournalEventType } from '../../../../lib/journal/eventTypes';

/** Coarse category (the part before the first dot) — drives the timeline
 *  row's accent color so a scan of the list reads as grouped even without
 *  per-type icons. Falls back to 'other' for any unrecognized prefix
 *  (forward-compatible with a future event type this module doesn't know
 *  about yet — never throws on an unfamiliar type). */
export type EventCategory =
  | 'mission'
  | 'agent'
  | 'tool'
  | 'spend'
  | 'budget'
  | 'gate'
  | 'brain'
  | 'loop'
  | 'scheduler'
  | 'teams'
  | 'chain'
  | 'project'
  | 'other';

const CATEGORY_COLOR: Record<EventCategory, string> = {
  mission: 'var(--color-accent)',
  agent: 'var(--color-cluster-auth)',
  tool: 'var(--color-text-muted)',
  spend: 'var(--color-success)',
  budget: 'var(--color-danger)',
  gate: 'var(--color-warning)',
  brain: 'var(--color-cluster-payment)',
  loop: 'var(--color-cluster-ui)',
  scheduler: 'var(--color-text-disabled)',
  teams: 'var(--color-assistant-cyan)',
  chain: 'var(--color-cluster-ui)',
  project: 'var(--color-text-disabled)',
  other: 'var(--color-text-disabled)',
};

export function eventCategory(type: JournalEventType): EventCategory {
  const prefix = type.split('.')[0];
  return (Object.keys(CATEGORY_COLOR) as EventCategory[]).includes(prefix as EventCategory)
    ? (prefix as EventCategory)
    : 'other';
}

export function eventCategoryColor(type: JournalEventType): string {
  return CATEGORY_COLOR[eventCategory(type)];
}

const MAX_SUMMARY_CHARS = 110;
const MAX_SUMMARY_FIELDS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Generic "key: value, key2: value2" one-liner from a row's raw payload —
 * the SAME honest-fallback shape MissionDetailTranscript.tsx's
 * summarizeArgs uses for unrecognized tool-call args, applied here to any
 * event type instead of just tool.called. Never fabricates: an unparsable
 * or empty payload returns '' (the caller shows just the bare event type in
 * that case, never a placeholder sentence).
 */
export function summarizePayload(rawPayload: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return '';
  }
  if (!isRecord(parsed)) return '';

  const entries = Object.entries(parsed).slice(0, MAX_SUMMARY_FIELDS);
  if (entries.length === 0) return '';

  const summary = entries
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}…` : summary;
}

/** `HH:MM` from a row's ts_ms — same format MissionDetailTranscript's own
 *  action-timeline entries use, so the two views of "what happened when"
 *  never disagree on time formatting. */
export function eventTimeLabel(row: Pick<JournalEventRow, 'ts_ms'>): string {
  const d = new Date(row.ts_ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
