/**
 * Automated agent-mission eval harness (mocks / local persist — no live secrets).
 * Covers stop mid-CLI, merge timeout, charter, goal persist, recall mid-mission.
 * F108 — also locks the canonical start→cli→review→merge flow.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  AGENT_MISSION_CANONICAL_FLOW,
  reduceAgentMissionEval,
  runAgentMissionEvalPipeline,
} from '../lib/brain/e2e/agentMissionEvalHarness';
import {
  persistConversationGoal,
  loadPersistedGoals,
  clearPersistedGoal,
} from '../lib/agents/managerGoalPersist';
import { recordCharterDecision, getCharterDecision } from '../lib/agents/managerCharterStore';
import { buildExplicitBrainQueryNudge } from '../lib/agents/managerAmbientRecall';
import type { ConversationGoal } from '../lib/agents/managerEngine';
import { detectLiveRailEnvPresence, probeClaudeCliVersion } from '../lib/brain/e2e/railsEvalHarness';

beforeEach(() => {
  localStorage.clear();
});

describe('agent mission eval harness', () => {
  it('stop mid-CLI does not merge', () => {
    const stage = runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.cli_chunk' },
      { type: 'agent.stop_mid_cli' },
      { type: 'agent.merge_requested' },
    ]);
    expect(stage).toBe('stopped');
    expect(reduceAgentMissionEval('stopped', { type: 'agent.merge_done' })).toBe('stopped');
  });

  it('merge timeout is an honest failure, not a silent success', () => {
    const stage = runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.merge_requested' },
      { type: 'agent.merge_timeout' },
    ]);
    expect(stage).toBe('merge_timeout');
    expect(reduceAgentMissionEval('merge_timeout', { type: 'agent.merge_done' })).toBe('merge_timeout');
  });

  it('canonical flow reaches merged via cli_streaming + review_gate', () => {
    expect(runAgentMissionEvalPipeline(AGENT_MISSION_CANONICAL_FLOW)).toBe('merged');
  });

  it('persists a charter decision across reload', () => {
    recordCharterDecision('eval-conv', 'ch_eval', 'accepted');
    expect(getCharterDecision('eval-conv', 'ch_eval')).toBe('accepted');
    expect(runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.charter_recorded' },
    ])).toBe('charter_recorded');
  });

  it('persists an active goal across reload', () => {
    const goal: ConversationGoal = {
      goalText: 'ship M9',
      createdAt: 1,
      extensionsUsed: 0,
      status: 'active',
      researchOnlyStreak: 0,
    };
    persistConversationGoal('eval-goal', goal);
    expect(loadPersistedGoals().get('eval-goal')?.goalText).toBe('ship M9');
    clearPersistedGoal('eval-goal');
    expect(loadPersistedGoals().has('eval-goal')).toBe(false);
    expect(runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.goal_persisted' },
    ])).toBe('goal_persisted');
  });

  it('recall mid-mission nudges brain_query instead of ambient search', () => {
    const stage = runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.cli_chunk' },
      { type: 'agent.recall_mid_mission' },
    ]);
    expect(stage).toBe('recall_nudged');
    const nudge = buildExplicitBrainQueryNudge({
      lastUserMessage: 'what did we decide about auth earlier this mission?',
    });
    expect(nudge).toMatch(/brain_query/);
  });
});

const LIVE = process.env.LIVE === '1';

describe.skipIf(!LIVE)('agent mission eval LIVE (F109–F111)', () => {
  it('reports env presence and keeps canonical flow green', () => {
    const presence = detectLiveRailEnvPresence();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ bench: 'agent-mission-live', presence }));
    expect(runAgentMissionEvalPipeline(AGENT_MISSION_CANONICAL_FLOW)).toBe('merged');
  });

  it('LIVE stop mid-CLI / merge / charter / goal / recall stages', () => {
    expect(runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.cli_chunk' },
      { type: 'agent.stop_mid_cli' },
    ])).toBe('stopped');
    expect(runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.merge_requested' },
      { type: 'agent.merge_timeout' },
    ])).toBe('merge_timeout');
    expect(runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.charter_recorded' },
    ])).toBe('charter_recorded');
    expect(runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.goal_persisted' },
    ])).toBe('goal_persisted');
    expect(runAgentMissionEvalPipeline([
      { type: 'agent.started' },
      { type: 'agent.cli_chunk' },
      { type: 'agent.recall_mid_mission' },
    ])).toBe('recall_nudged');
  });

  it.skipIf(!detectLiveRailEnvPresence().cliHint)(
    'LIVE Claude CLI version probe when CLI is installed',
    () => {
      const result = probeClaudeCliVersion();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ bench: 'f111-cli', result }));
      expect(result.status).toBe('ok');
    },
  );
});
