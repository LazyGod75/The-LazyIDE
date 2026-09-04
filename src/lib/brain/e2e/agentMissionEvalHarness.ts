/* Isolated agent-mission eval protocol (no live CLI / no managerEngine import).

   F108 — stages mirror the real agentsStore / approveGate / managerGoalPersist
   flow more closely: start → (optional mid-CLI stop) → merge request →
   timeout|done, plus charter / goal / recall mid-mission branches that the
   production manager actually takes.
*/

export type AgentMissionEvalStage =
  | 'idle'
  | 'running'
  | 'stopped'
  | 'merging'
  | 'merge_timeout'
  | 'merged'
  | 'charter_recorded'
  | 'goal_persisted'
  | 'recall_nudged'
  | 'cli_streaming'
  | 'review_gate';

export type AgentMissionEvalEvent =
  | { type: 'agent.started' }
  | { type: 'agent.cli_chunk' }
  | { type: 'agent.stop_mid_cli' }
  | { type: 'agent.merge_requested' }
  | { type: 'agent.merge_timeout' }
  | { type: 'agent.merge_done' }
  | { type: 'agent.charter_recorded' }
  | { type: 'agent.goal_persisted' }
  | { type: 'agent.recall_mid_mission' }
  | { type: 'agent.review_gate' };

export function reduceAgentMissionEval(
  stage: AgentMissionEvalStage,
  event: AgentMissionEvalEvent,
): AgentMissionEvalStage {
  switch (event.type) {
    case 'agent.started':
      return stage === 'idle' ? 'running' : stage;
    case 'agent.cli_chunk':
      return stage === 'running' || stage === 'cli_streaming' ? 'cli_streaming' : stage;
    case 'agent.stop_mid_cli':
      return stage === 'running' || stage === 'merging' || stage === 'cli_streaming'
        ? 'stopped'
        : stage;
    case 'agent.merge_requested':
      return stage === 'running' || stage === 'cli_streaming' || stage === 'review_gate'
        ? 'merging'
        : stage;
    case 'agent.review_gate':
      return stage === 'running' || stage === 'cli_streaming' ? 'review_gate' : stage;
    case 'agent.merge_timeout':
      return stage === 'merging' ? 'merge_timeout' : stage;
    case 'agent.merge_done':
      return stage === 'merging' ? 'merged' : stage;
    case 'agent.charter_recorded':
      return stage === 'running' || stage === 'idle' || stage === 'cli_streaming'
        ? 'charter_recorded'
        : stage;
    case 'agent.goal_persisted':
      return stage === 'running' || stage === 'idle' || stage === 'charter_recorded'
        || stage === 'cli_streaming'
        ? 'goal_persisted'
        : stage;
    case 'agent.recall_mid_mission':
      return stage === 'running' || stage === 'cli_streaming' ? 'recall_nudged' : stage;
    default:
      return stage;
  }
}

export function runAgentMissionEvalPipeline(
  events: AgentMissionEvalEvent[],
): AgentMissionEvalStage {
  return events.reduce<AgentMissionEvalStage>(
    (stage, event) => reduceAgentMissionEval(stage, event),
    'idle',
  );
}

/** Canonical happy-path sequence used by both stub and LIVE=1 probes. */
export const AGENT_MISSION_CANONICAL_FLOW: AgentMissionEvalEvent[] = [
  { type: 'agent.started' },
  { type: 'agent.cli_chunk' },
  { type: 'agent.review_gate' },
  { type: 'agent.merge_requested' },
  { type: 'agent.merge_done' },
];
