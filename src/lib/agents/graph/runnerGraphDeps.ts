/* graph/runnerGraphDeps.ts — P6.d: SGR schedules via lazy-runnerd.

   Provides a factory that creates GraphExecutorDeps routing mission launches
   through the detached runner daemon (HTTP POST /missions) instead of the
   in-process Tauri invoke('agent_run') path.

   When the runner is unavailable, falls back to the provided in-process deps.
   This allows runGraph to operate identically whether missions are owned by
   the UI process or the runner daemon.
*/

import type { GraphExecutorDeps } from './runGraph.js';
import type { GraphNode, BrainRecallBundle } from './types.js';
import type { Mission } from '../types.js';
import { invoke } from '@tauri-apps/api/core';
import { findMissionById } from '../globalRuntime.js';

export interface RunnerGraphConfig {
  /** Fallback deps for in-process execution when runner is unavailable. */
  fallback: GraphExecutorDeps;
  /** Project ID for journal events. */
  projectId: string;
  /** Optional auth token for runner HTTP. */
  token?: string;
}

/**
 * Create GraphExecutorDeps that route through lazy-runnerd when available,
 * falling back to in-process execution otherwise.
 */
export function createRunnerGraphDeps(config: RunnerGraphConfig): GraphExecutorDeps {
  const { fallback, projectId } = config;

  let runnerPort = 0;
  let runnerToken = config.token ?? '';
  let runnerChecked = false;
  let runnerAvailable = false;

  async function checkRunner(): Promise<boolean> {
    if (runnerChecked) return runnerAvailable;
    runnerChecked = true;
    try {
      const status = await invoke<{
        enabled: boolean;
        running: boolean;
        port?: number;
        token?: string;
      }>('runner_status');
      if (status.enabled && status.running) {
        runnerPort = status.port ?? 0;
        if (status.token) runnerToken = status.token;
        runnerAvailable = runnerPort > 0;
      }
    } catch {
      runnerAvailable = false;
    }
    return runnerAvailable;
  }

  function modelFromNode(node: GraphNode): string {
    if (node.kind === 'task' || node.kind === 'contest') {
      return node.contract.model ?? 'sonnet';
    }
    return 'sonnet';
  }

  return {
    projectRoot: fallback.projectRoot,

    async launchMission(args: {
      node: GraphNode;
      task: string;
      brainContext: BrainRecallBundle;
      projectId: string;
    }): Promise<string> {
      const useRunner = await checkRunner();
      if (!useRunner) {
        return fallback.launchMission(args);
      }

      const missionId = `graph-${args.node.id}-${Date.now()}`;
      const baseUrl = `http://127.0.0.1:${runnerPort}`;
      const model = modelFromNode(args.node);

      try {
        const resp = await fetch(`${baseUrl}/missions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(runnerToken ? { Authorization: `Bearer ${runnerToken}` } : {}),
          },
          body: JSON.stringify({
            id: missionId,
            worktreePath: fallback.projectRoot,
            tool: 'claude',
            model,
            missionTitle: args.node.label ?? args.node.id,
            missionTask: args.task,
            projectId: args.projectId || projectId,
          }),
        });

        if (!resp.ok) {
          throw new Error(`Runner POST /missions failed: ${resp.status}`);
        }

        return missionId;
      } catch {
        // Fall back to in-process
        return fallback.launchMission(args);
      }
    },

    async waitForMissions(
      missionIds: string[],
      signal?: AbortSignal,
    ): Promise<Mission[]> {
      const useRunner = await checkRunner();
      if (!useRunner) {
        return fallback.waitForMissions(missionIds, signal);
      }

      const baseUrl = `http://127.0.0.1:${runnerPort}`;

      // Poll until all missions are no longer in the runner's active list
      while (!signal?.aborted) {
        try {
          const resp = await fetch(`${baseUrl}/missions`, {
            headers: runnerToken ? { Authorization: `Bearer ${runnerToken}` } : {},
          });
          if (resp.ok) {
            const active: Array<{ id: string; pid?: number }> = await resp.json();
            const activeIds = new Set(active.map((m) => m.id));
            const allDone = missionIds.every((id) => !activeIds.has(id));
            if (allDone) break;
          }
        } catch {
          // Runner unreachable — fall back
          return fallback.waitForMissions(missionIds, signal);
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // Prefer real registry missions (honest status). Never invent 'done'.
      const fromRegistry = missionIds
        .map((id) => findMissionById(id))
        .filter((m): m is Mission => m !== undefined);

      if (fromRegistry.length === missionIds.length) {
        return fromRegistry;
      }

      const known = new Set(fromRegistry.map((m) => m.id));
      const missing = missionIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        const waited = await fallback.waitForMissions(missing, signal);
        return [...fromRegistry, ...waited];
      }

      return fromRegistry;
    },

    persistRun: fallback.persistRun,
    emit: fallback.emit,
    diagnose: fallback.diagnose,
  };
}
