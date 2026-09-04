/* missionWhoLine.ts — honest "who · what" cursor for cockpit / Code / Team.
   Never invents an agent name or a file path: agentName/model and the
   already-human liveAction/pendingQuestion only. */

import { humanizeLiveAction, humanizeLiveActionParts } from './liveActionSummary.js';
import type { TFunc } from './runtime.js';

export function missionWhoLabel(mission: { agentName?: string; model: string }): string {
  return mission.agentName?.trim() || mission.model;
}

export function missionWorkLine(
  liveAction: string | undefined,
  pendingQuestion?: string,
  t?: TFunc,
): string {
  const question = pendingQuestion?.trim();
  if (question) return question;
  const raw = liveAction?.trim() ?? '';
  if (!raw) return '';
  const parts = humanizeLiveActionParts(raw, t);
  if (parts) return parts.detail ? `${parts.verb} ${parts.detail}` : parts.verb;
  return humanizeLiveAction(raw, t) || raw;
}

export function missionWhoWhatLine(
  mission: {
    agentName?: string;
    model: string;
    liveAction?: string;
    pendingQuestion?: string;
  },
  t?: TFunc,
): string {
  const who = missionWhoLabel(mission);
  const what = missionWorkLine(mission.liveAction, mission.pendingQuestion, t);
  if (!who) return what;
  if (!what) return who;
  return `${who} · ${what}`;
}
