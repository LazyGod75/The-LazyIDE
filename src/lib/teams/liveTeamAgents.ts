/* liveTeamAgents — honest "who is working right now" slice of the fleet.
   No fabricated per-member CRDT cursors: this app has no cross-user
   presence stream (see MemberView's "PENDANT QUE TU AVAIS LE DOS TOURNÉ"
   honesty note). We surface the real running/queued/review missions
   already in useFleetMissions — agent name, live action, project — so
   Team looks like a floor of agents, not a budget spreadsheet. */

import type { FleetMission, FleetProject } from '../agents/fleetMissions';
import { missionWorkLine } from '../agents/missionWhoLine';
import type { TFunc } from '../agents/runtime';
import { basename } from '../paths';

export interface LiveTeamAgent {
  missionId: string;
  title: string;
  status: FleetMission['status'];
  agentName: string;
  liveAction: string;
  /** Basename of the first real diffFiles entry — never invented. */
  cursorFile: string;
  projectName: string;
  projectId: string;
  updatedMs: number;
}

const LIVE_STATUSES = new Set<FleetMission['status']>(['running', 'queued', 'review']);

export function collectLiveTeamAgents(projects: readonly FleetProject[]): LiveTeamAgent[] {
  const live: LiveTeamAgent[] = [];
  for (const project of projects) {
    for (const mission of project.missions) {
      if (!LIVE_STATUSES.has(mission.status)) continue;
      live.push({
        missionId: mission.id,
        title: mission.title,
        status: mission.status,
        agentName: mission.agentName?.trim() || mission.model,
        liveAction: mission.liveAction?.trim() || '',
        cursorFile: firstCursorFile(mission),
        projectName: project.name,
        projectId: project.projectId,
        updatedMs: mission.updatedMs,
      });
    }
  }
  live.sort((a, b) => b.updatedMs - a.updatedMs);
  return live;
}

function firstCursorFile(mission: FleetMission): string {
  const name = mission.diffFiles?.[0]?.filename?.trim();
  return name ? basename(name) : '';
}

/** Honest "what the agent is doing" line — tool verb + file when the
 *  liveAction is a recognized `<Tool>: {json}` step; otherwise the raw
 *  string. Never invents a path that was not in the action. */
export function liveAgentWorkLine(liveAction: string, t?: TFunc): string {
  return missionWorkLine(liveAction, undefined, t);
}

function reviewCursorAction(agent: LiveTeamAgent, t: TFunc): string {
  if (!agent.cursorFile) return t('agents.status.review');
  return `${t('agents.status.review')} · ${agent.cursorFile}`;
}

export function liveAgentCursorLine(agent: LiveTeamAgent, t: TFunc): string {
  let action: string;
  if (agent.status === 'review') {
    action = reviewCursorAction(agent, t);
  } else if (agent.liveAction) {
    action = liveAgentWorkLine(agent.liveAction, t);
  } else {
    action = agent.cursorFile;
  }
  if (action) {
    return t('team.redesign.lead.fleet.liveCursor', {
      action,
      project: agent.projectName,
    });
  }
  return agent.projectName;
}
