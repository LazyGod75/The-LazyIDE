/* formatMissionDetail — compact, faithful mission digest for manager grounding.

   Measured 2026-08-28: formatMissionDetail cyclomatic complexity was 18
   (ESLint ratchet ceiling 12). Lives here so managerEngine.ts stays the
   LLM turn loop, not a digest formatter.
*/

import type { Mission } from './types.js';
import { formatVerdictScoreLine } from './evaluator.js';

const MAX_TIMELINE_ENTRIES_HARD_CAP = 20;
const DEFAULT_TIMELINE_ENTRIES = 15;
const MAX_RESULT_CHARS = 400;
const MAX_TIMELINE_ENTRY_CHARS = 200;
const MAX_REVIEWER_SUMMARY_CHARS = 160;
const TRUNCATION_MARKER = '…(truncated)…';

export interface MissionDetailOptions {
  /** Requested number of recent timeline entries (e.g. get_agent_output.lines). Clamped to the hard cap. */
  maxTimelineEntries?: number;
}

function truncateChars(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trim()} ${TRUNCATION_MARKER}`;
}

/** Find the most representative "final answer" text from a mission's real
 *  timeline — prefers an explicit Résultat:/Result: marker, else the latest
 *  entry that is NOT an `[eval]` evaluation-pipeline status line (BUGFIX,
 *  M12 dogfood MAJEUR #6c: an `[eval]` line used to shadow the agent's real
 *  summary), else the in-flight liveAction, else an honest "no output" notice. */
function extractResultText(mission: Mission): string {
  const timeline = mission.actionTimeline ?? [];
  const resultEntry = [...timeline].reverse().find((e) => /^(Résultat:|Result:)/.test(e.text));
  if (resultEntry) return resultEntry.text;
  const lastNonEval = [...timeline].reverse().find((e) => !e.text.startsWith('[eval]'));
  if (lastNonEval) return lastNonEval.text;
  if (mission.liveAction) return mission.liveAction;
  return '(no output recorded yet)';
}

function appendTimeline(lines: string[], mission: Mission, maxTimelineEntries: number): void {
  const timeline = mission.actionTimeline ?? [];
  if (timeline.length === 0) return;
  const recent = timeline.slice(-maxTimelineEntries);
  const omitted = timeline.length - recent.length;
  lines.push('');
  lines.push(`Action timeline (last ${recent.length} of ${timeline.length} real entries):`);
  if (omitted > 0) lines.push(`…(truncated — ${omitted} earlier entries omitted)…`);
  for (const e of recent) lines.push(`  [${e.time}] ${truncateChars(e.text, MAX_TIMELINE_ENTRY_CHARS)}`);
}

function appendDiff(lines: string[], mission: Mission): void {
  if (!mission.diffFiles || mission.diffFiles.length === 0) return;
  const names = mission.diffFiles.map((f) => f.filename).join(', ');
  lines.push('');
  lines.push(`Diff: +${mission.diffAdded ?? 0}/-${mission.diffRemoved ?? 0} across ${mission.diffFiles.length} file(s): ${truncateChars(names, 200)}`);
}

function appendVerdict(lines: string[], mission: Mission): void {
  if (!mission.judgeVerdict) return;
  const v = mission.judgeVerdict;
  lines.push('');
  // R13 — same shared scoreUnavailable rule as nodeChrome.tsx (R11): this
  // digest feeds the manager's grounded context — a placeholder `0` here
  // would let the manager itself repeat a fabricated score to the user.
  lines.push(`Judge verdict: score ${formatVerdictScoreLine(v, 'unavailable')}, ${v.passed ? 'PASSED' : 'FAILED'}, risk ${v.risk}`);
  for (const r of v.reviewers.slice(0, 5)) {
    lines.push(`  - ${r.role}: ${r.verdict} — ${truncateChars(r.summary, MAX_REVIEWER_SUMMARY_CHARS)}`);
  }
}

function appendMetrics(lines: string[], mission: Mission): void {
  if (!mission.agentMetrics) return;
  const m = mission.agentMetrics;
  lines.push('');
  lines.push(
    `Metrics: ${(m.durationMs / 1000).toFixed(1)}s · ${m.inputTokens} in / ${m.outputTokens} out tokens · $${m.costUsd.toFixed(3)} · ${m.toolCount} tool calls`,
  );
}

/**
 * Build a compact, faithful, truncated summary of a mission's REAL data —
 * status, real result text, last N real timeline entries, diff summary,
 * judge verdict, metrics. Used to ground a manager follow-up answer instead
 * of letting it guess. Never fabricates: only reports fields that are
 * actually present on the mission object.
 */
export function formatMissionDetail(mission: Mission, opts: MissionDetailOptions = {}): string {
  const maxTimelineEntries = Math.max(
    1,
    Math.min(opts.maxTimelineEntries ?? DEFAULT_TIMELINE_ENTRIES, MAX_TIMELINE_ENTRIES_HARD_CAP),
  );

  const lines: string[] = [
    `Mission ${mission.id}: "${mission.title}"`,
    `Status: ${mission.status}${mission.progress !== undefined ? ` (${mission.progress}%)` : ''}`,
  ];
  if (mission.agentName) lines.push(`Agent: @${mission.agentName}`);
  if (mission.model) lines.push(`Model: ${mission.model}`);
  lines.push(`Result/output: ${truncateChars(extractResultText(mission), MAX_RESULT_CHARS)}`);
  appendTimeline(lines, mission, maxTimelineEntries);
  appendDiff(lines, mission);
  appendVerdict(lines, mission);
  appendMetrics(lines, mission);
  return lines.join('\n');
}

/**
 * Honest "not found" grounding block — used when a query_mission /
 * get_agent_output reference cannot be resolved to a real mission. Keeps
 * the manager from guessing or fabricating an answer about work that
 * cannot be verified.
 */
export function formatMissionNotFound(identifier: string): string {
  return `No mission or agent matches "${identifier}". Tell the user honestly that nothing was found for that reference — do not invent a mission, status, or output.`;
}
