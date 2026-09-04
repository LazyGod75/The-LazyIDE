/* runMissionFanout — Step E of runMission (orchestrator sub-agent fan-out).

   Extracted because runMission's measured cyclomatic complexity was 89
   (2026-08-28 ESLint, after launch-prelude + worktree splits). Behavior is
   copied: parallel per-sub-agent worktrees, depth cap 2, never fall back
   to the parent's shared worktree on child create failure.
*/

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Mission, SubAgent } from './types.js';
import type { MissionUpdate, PermissionMode } from './runtime.js';
import { createWorktree, discardWorktree, mergeWorktree } from './runMissionWorktree.js';
import { emitEvent } from '../journal/journal.js';
import { normalizeRepoPathForGit } from '../paths.js';

async function createChildWorktree(opts: {
  repoPath: string;
  childBranch: string;
  projectId: string;
  childId: string;
}): Promise<string> {
  try {
    return await createWorktree(opts.repoPath, opts.childBranch);
  } catch (err) {
    emitEvent({
      type: 'mission.failed',
      tsMs: Date.now(),
      projectId: opts.projectId,
      missionId: opts.childId,
      actor: 'system',
      payload: { reason: 'worktree_creation_failed' },
    });
    throw new Error(`worktree_creation_failed: ${String(err)}`, { cause: err });
  }
}

async function waitForChildAgent(opts: {
  childId: string;
  childWorktreePath: string;
  childTask: string;
  subAgentName: string;
  tool: string;
  model: string;
  permissionMode?: PermissionMode;
  projectId: string;
  parentMissionId: string;
  childDepth: number;
}): Promise<void> {
  const childDoneEvent = `agent://done/${opts.childId}`;
  const childErrorEvent = `agent://error/${opts.childId}`;
  let resolveChild!: () => void;
  const childFinished = new Promise<void>((resolve) => { resolveChild = resolve; });
  let childDoneUnsub: () => void = () => undefined;
  let childErrorUnsub: () => void = () => undefined;
  const childCleanupAndResolve = (): void => {
    try { childDoneUnsub(); } catch { /* ignore */ }
    try { childErrorUnsub(); } catch { /* ignore */ }
    resolveChild();
  };
  [childDoneUnsub, childErrorUnsub] = await Promise.all([
    listen(childDoneEvent, childCleanupAndResolve),
    listen(childErrorEvent, childCleanupAndResolve),
  ]);
  await invoke('agent_run', {
    req: {
      id: opts.childId,
      worktreePath: normalizeRepoPathForGit(opts.childWorktreePath),
      tool: opts.tool,
      model: opts.model,
      task: opts.childTask,
      system: `You are the "${opts.subAgentName}" agent in an orchestrated pipeline. Complete your role fully.`,
      permissionMode: opts.permissionMode ?? 'default',
      allowedTools: undefined,
      deniedTools: undefined,
    },
  });
  emitEvent({
    type: 'agent.spawned',
    tsMs: Date.now(),
    projectId: opts.projectId,
    missionId: opts.childId,
    agentId: opts.subAgentName,
    actor: 'agent',
    payload: { agentIdentity: opts.subAgentName, parentMissionId: opts.parentMissionId, depth: opts.childDepth },
  });
  await childFinished;
}

async function mergeAndCleanupChild(opts: {
  repoPath: string;
  parentWorktreePath: string;
  childWorktreePath: string;
  childBranch: string;
  childId: string;
  projectId: string;
}): Promise<void> {
  try {
    await mergeWorktree(opts.repoPath, opts.childBranch, opts.parentWorktreePath);
  } catch (err) {
    emitEvent({
      type: 'mission.blocked',
      tsMs: Date.now(),
      projectId: opts.projectId,
      missionId: opts.childId,
      actor: 'system',
      payload: { reason: `sub_agent_merge_failed: ${String(err)}` },
    });
  }
  try {
    await discardWorktree(opts.repoPath, opts.childWorktreePath, opts.childBranch);
  } catch {
    // Best-effort cleanup
  }
}

export async function runOneOrchestratorSubAgent(opts: {
  mission: Mission;
  subAgent: SubAgent;
  repoPath: string;
  parentWorktreePath: string;
  projectId: string;
  tool: string;
  model: string;
  permissionMode?: PermissionMode;
  childDepth: number;
}): Promise<{ childId: string; subAgent: string }> {
  const { mission, subAgent, repoPath, projectId, childDepth } = opts;
  const childId = `${mission.id}-${subAgent.name.toLowerCase().replace(/\s+/g, '-')}`;
  const childBranch = `${childId}-wt`;
  const childTask =
    `Sub-agent "${subAgent.name}" for orchestrator mission: ${mission.title}. ` +
    `Complete your designated role autonomously.`;
  emitEvent({
    type: 'agent.delegated',
    tsMs: Date.now(),
    projectId,
    missionId: mission.id,
    actor: 'agent',
    payload: { parentMissionId: mission.id, childMissionId: childId, depth: childDepth },
  });
  const childWorktreePath = await createChildWorktree({ repoPath, childBranch, projectId, childId });
  await waitForChildAgent({
    childId,
    childWorktreePath,
    childTask,
    subAgentName: subAgent.name,
    tool: opts.tool,
    model: opts.model,
    permissionMode: opts.permissionMode,
    projectId,
    parentMissionId: mission.id,
    childDepth,
  });
  await mergeAndCleanupChild({
    repoPath,
    parentWorktreePath: opts.parentWorktreePath,
    childWorktreePath,
    childBranch,
    childId,
    projectId,
  });
  return { childId, subAgent: subAgent.name };
}

/** Depth cap 2 — user → mission → sub-mission, no deeper. */
export async function fanOutOrchestratorSubAgents(opts: {
  mission: Mission;
  repoPath: string;
  parentWorktreePath: string;
  projectId: string;
  tool: string;
  model: string;
  permissionMode?: PermissionMode;
  onUpdate: (update: MissionUpdate) => void;
}): Promise<void> {
  const { mission, onUpdate } = opts;
  if (!mission.isOrchestrator || !mission.subAgents || mission.subAgents.length === 0) return;
  const parentDepth = mission.contract?.parentDepth ?? 0;
  if (parentDepth >= 2) {
    emitEvent({
      type: 'mission.blocked',
      tsMs: Date.now(),
      projectId: opts.projectId,
      missionId: mission.id,
      actor: 'system',
      payload: { reason: `Delegation depth cap (2) exceeded at depth ${parentDepth}` },
    });
    return;
  }
  onUpdate({
    id: mission.id,
    patch: { subAgents: mission.subAgents.map((sa) => ({ ...sa, status: 'running' as const })) },
  });
  const childDepth = parentDepth + 1;
  const subAgentResults = await Promise.allSettled(
    mission.subAgents.map((subAgent) =>
      runOneOrchestratorSubAgent({ ...opts, subAgent, childDepth }),
    ),
  );
  onUpdate({
    id: mission.id,
    patch: {
      subAgents: mission.subAgents.map((sa, i) => ({
        ...sa,
        status: subAgentResults[i]?.status === 'fulfilled' ? 'done' as const : 'failed' as const,
      })),
    },
  });
}
