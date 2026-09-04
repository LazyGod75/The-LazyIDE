/* planAndActLiveViaRunner — detached lazy-runnerd path.

   Measured 2026-08-28: cyclomatic complexity 23 (ESLint ceiling 12).
   Behavior copied: runner_status probe, POST /missions, poll /health +
   /missions, kill on stop, fall back to runPlanAndActLive on any miss.
*/

import { invoke } from '@tauri-apps/api/core';
import type { PlanAndActLiveOpts } from './planAndActLiveSupport.js';
import { runPlanAndActLive } from './planAndActLiveSupport.js';
import { isNativeStopRequested } from './nativeAbort.js';

function clockHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function resolveRunnerPort(opts: PlanAndActLiveOpts): Promise<number | null> {
  try {
    const status = await invoke<{ enabled: boolean; running: boolean; port?: number }>('runner_status');
    if (!status.enabled || !status.running) {
      throw new Error('Runner not running — falling back to in-process path');
    }
    return status.port ?? 0;
  } catch {
    opts.onAction({
      time: clockHm(),
      text: opts.t ? opts.t('agents.runtime.runnerUnavailable') : 'Runner indisponible, repli sur le chemin natif…',
      isLive: true,
    });
    return null;
  }
}

async function postRunnerMission(baseUrl: string, opts: PlanAndActLiveOpts): Promise<void> {
  const resp = await fetch(`${baseUrl}/missions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ',
    },
    body: JSON.stringify({
      id: opts.missionId,
      worktreePath: opts.worktreePath,
      tool: opts.tool,
      model: opts.model,
      agentName: opts.agentName,
      missionTitle: opts.missionTitle,
      missionTask: opts.missionTask,
      permissionMode: opts.permissionMode,
      allowedTools: opts.allowedTools,
      deniedTools: opts.deniedTools,
      extraReadableRoots: opts.extraReadableRoots,
      projectId: opts.projectId ?? '',
    }),
  });
  if (resp.ok) return;
  const body = await resp.text().catch(() => '');
  throw new Error(`Runner POST /missions failed: ${resp.status} ${body}`);
}

async function missionStillOnRunner(baseUrl: string, missionId: string): Promise<boolean | null> {
  const healthResp = await fetch(`${baseUrl}/health`, {
    headers: { Authorization: 'Bearer ' },
  }).catch(() => null);
  if (!healthResp?.ok) return null;
  const missionsResp = await fetch(`${baseUrl}/missions`, {
    headers: { Authorization: 'Bearer ' },
  }).catch(() => null);
  if (!missionsResp?.ok) return null;
  const missions = await missionsResp.json().catch(() => []);
  return (missions as { id: string }[]).some((m) => m.id === missionId);
}

async function pollRunnerUntilDone(baseUrl: string, opts: PlanAndActLiveOpts): Promise<'done' | 'stopped'> {
  while (!isNativeStopRequested(opts.stopSignal, opts.abortSignal)) {
    await new Promise((r) => setTimeout(r, 500));
    const listed = await missionStillOnRunner(baseUrl, opts.missionId);
    if (listed === false) return 'done';
  }
  return 'stopped';
}

async function killRunnerMission(baseUrl: string, missionId: string): Promise<void> {
  await fetch(`${baseUrl}/missions/${missionId}/kill`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' },
  }).catch(() => undefined);
}

export async function runPlanAndActLiveViaRunner(opts: PlanAndActLiveOpts): Promise<void> {
  const start = opts.t
    ? opts.t('agents.runtime.startingAgentRunner', { tool: opts.tool, model: opts.model })
    : `Démarrage agent ${opts.tool} (${opts.model}) via runner…`;
  opts.onStep(0, 'in_progress');
  opts.onAction({ time: clockHm(), text: start, isLive: true });
  opts.onProgress(5);
  opts.onStep(1, 'in_progress');

  const port = await resolveRunnerPort(opts);
  if (port === null) return runPlanAndActLive(opts);

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await postRunnerMission(baseUrl, opts);
    opts.onStep(2, 'in_progress');
    opts.onProgress(50);
    const outcome = await pollRunnerUntilDone(baseUrl, opts);
    if (outcome === 'stopped') {
      await killRunnerMission(baseUrl, opts.missionId);
      opts.onAction({
        time: clockHm(),
        text: opts.t ? opts.t('agents.runtime.missionCancelled') : 'Mission annulée.',
        isLive: true,
      });
      return;
    }
    opts.onStep(2, 'done', `fait · ${clockHm()}`);
    opts.onProgress(100);
    opts.onStep(3, 'done');
    opts.onAction({
      time: clockHm(),
      text: opts.t ? opts.t('agents.runtime.missionDoneRunner') : 'Mission terminée via runner.',
      isLive: true,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    opts.onAction({
      time: clockHm(),
      text: opts.t ? opts.t('agents.runtime.runnerError', { error: errMsg }) : `Erreur runner: ${errMsg}`,
      isLive: true,
    });
    opts.onAction({
      time: clockHm(),
      text: opts.t ? opts.t('agents.runtime.fallbackNative') : 'Repli sur le chemin natif…',
      isLive: true,
    });
    return runPlanAndActLive(opts);
  }
}
