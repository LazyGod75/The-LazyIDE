/* missionStatusColors.ts — shared home for the mission-status color constants
   previously duplicated (with divergent values) across AgentRoster.tsx,
   MissionCalendar.tsx and metrics/MissionStatusBars.tsx.

   This module is a pure code-dedup extraction: each export below keeps the
   EXACT values its source card already used. The three cards visually
   disagree on what color a given status should be — see "Known
   divergences" — and reconciling that is a product decision for David to
   make on purpose, not a side effect of removing duplication. Until he
   decides, each card keeps rendering with its own historical palette via
   its own named export.

   ── Known divergences (as found, 2026-08) ───────────────────────────────
   - "running": purple in rosterStatusColors (#7C5CFF) and
     calendarStatusColors (#7C5CFF / text #C4B5FD), but ORANGE in
     barStatusColors (#FFC76B).
   - "review": orange/amber in rosterStatusColors (#FBB924) and
     calendarStatusColors (#FBB924), but PURPLE in barStatusColors
     (#7C5CFF) — the exact color "running" uses elsewhere. "running" and
     "review" are effectively swapped between the roster/calendar pair and
     the bars.
   - "done": green in all three, but two different shades — #4ADE80
     (rosterStatusColors, calendarStatusColors) vs #66E27A
     (barStatusColors).
*/

import type { MissionStatus } from '../../lib/agents/types';

/** The mission statuses AgentRoster.tsx rolls its per-agent counters into. */
export type RosterStatusKey = 'running' | 'queued' | 'done' | 'failed' | 'review';

/** AgentRoster.tsx's STATUS_COLORS — flat hex/rgba per status. */
export const rosterStatusColors: Record<RosterStatusKey, string> = {
  running: '#7C5CFF',
  queued: 'rgba(255,255,255,0.3)',
  done: '#4ADE80',
  failed: '#F87171',
  review: '#FBB924',
};

/** MissionCalendar.tsx's STATUS_COLORS — a background/text pair per status. */
export const calendarStatusColors: Record<MissionStatus, { bg: string; text: string }> = {
  queued: { bg: 'rgba(255,255,255,0.08)', text: 'rgba(255,255,255,0.55)' },
  running: { bg: 'rgba(124,92,255,0.20)', text: '#C4B5FD' },
  review: { bg: 'rgba(251,185,36,0.18)', text: '#FBB924' },
  done: { bg: 'rgba(34,197,94,0.15)', text: '#4ADE80' },
  failed: { bg: 'rgba(239,68,68,0.10)', text: '#F87171' },
  cancelled: { bg: 'rgba(255,255,255,0.04)', text: 'rgba(255,255,255,0.3)' },
};

/** metrics/MissionStatusBars.tsx's STATUS_COLORS — flat hex/rgba per status. */
export const barStatusColors: Record<string, string> = {
  running: '#FFC76B',
  review: '#7C5CFF',
  done: '#66E27A',
  queued: 'rgba(255,255,255,0.18)',
};
