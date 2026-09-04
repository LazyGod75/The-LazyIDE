/* runMissionWorktree — Step A of runMission (create isolated git worktree).

   Extracted because runMission's measured cyclomatic complexity was 104
   (2026-08-28 ESLint), then 96 after the launch-prelude split. This module
   owns worktree create + the missing-base-branch fallback. Failure still
   fails the mission (never falls back to the main repo).
*/

import { invoke } from '@tauri-apps/api/core';
import type { Mission, ActionEvent } from './types.js';
import type { TFunc, MissionUpdate } from './runtime.js';
import { launchPhaseEnter, launchPhaseExit, launchPhaseError } from './launchLog.js';
import { emitEvent } from '../journal/journal.js';
import { normalizeRepoPathForGit } from '../paths.js';

function clockHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * `baseBranch` (see Mission.baseBranch's doc comment, ./types.ts): when
 * set, the Rust side creates `branch` starting FROM `baseBranch` instead of
 * the repo's current HEAD, and verifies `baseBranch` actually exists BEFORE
 * touching anything — a missing base branch rejects with an explicit reason
 * naming it (agent_create_worktree_inner, src-tauri/src/commands/git.rs).
 * This function itself never falls back on that rejection — it just
 * forwards it. Absent/undefined `baseBranch` = today's unchanged default
 * (branch off current HEAD). Callers that want the 2026-08-05
 * "baseBranch may already be merged+deleted" graceful retry must go
 * through {@link createWorktreeWithBaseBranchFallback} instead.
 *
 * `mergeBranches` (see Mission.mergeBranches's doc comment, ./types.ts):
 * fan-in dependency merge — every branch here is real-`git merge`d into the
 * new worktree, in order, right after it is created from `baseBranch`.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch?: string,
  mergeBranches?: string[],
): Promise<string> {
  return invoke<string>('agent_create_worktree', {
    repoPath: normalizeRepoPathForGit(repoPath),
    branch,
    baseBranch,
    mergeBranches,
  });
}

function isMissingBaseBranchError(err: unknown, baseBranch: string): boolean {
  return String(err).includes(`base branch '${baseBranch}' does not exist`);
}

export interface WorktreeCreationOutcome {
  worktreePath: string;
  fallbackFromMissingBase?: string;
}

/** Wraps createWorktree with ONE retry when `baseBranch` was already merged+deleted. */
export async function createWorktreeWithBaseBranchFallback(
  repoPath: string,
  branch: string,
  baseBranch?: string,
  mergeBranches?: string[],
): Promise<WorktreeCreationOutcome> {
  if (!baseBranch) {
    return { worktreePath: await createWorktree(repoPath, branch, baseBranch, mergeBranches) };
  }
  try {
    return { worktreePath: await createWorktree(repoPath, branch, baseBranch, mergeBranches) };
  } catch (err) {
    if (!isMissingBaseBranchError(err, baseBranch)) throw err;
    console.warn(
      `[runtime] base branch '${baseBranch}' missing (likely merged+deleted) — falling back to repo default branch`,
    );
    const worktreePath = await createWorktree(repoPath, branch, undefined, mergeBranches);
    return { worktreePath, fallbackFromMissingBase: baseBranch };
  }
}

function readyTimeline(
  initialTimeline: ActionEvent[],
  created: WorktreeCreationOutcome,
  t?: TFunc,
): ActionEvent[] {
  const fallback: ActionEvent[] = created.fallbackFromMissingBase
    ? [{
        time: clockHm(),
        text: t
          ? t('agents.runtime.baseBranchFallback', { branch: created.fallbackFromMissingBase })
          : `Branche de base '${created.fallbackFromMissingBase}' absente (déjà fusionnée) — repli sur la branche principale`,
        isLive: false,
      }]
    : [];
  return [
    ...initialTimeline.map((e) => ({ ...e, isLive: false })),
    ...fallback,
    {
      time: clockHm(),
      text: t ? t('agents.runtime.worktreeCreated', { path: created.worktreePath }) : `Worktree créé : ${created.worktreePath}`,
      isLive: false,
    },
    { time: clockHm(), text: t ? t('agents.runtime.startingLoop') : 'Démarrage du loop agent…', isLive: true },
  ];
}

function failTimeline(initialTimeline: ActionEvent[], err: unknown, t?: TFunc): ActionEvent[] {
  return [
    ...initialTimeline.map((e) => ({ ...e, isLive: false })),
    {
      time: clockHm(),
      text: t
        ? t('agents.runtime.worktreeFailed', { error: String(err).slice(0, 80) })
        : `Worktree échec: ${String(err).slice(0, 80)}`,
      isLive: false,
    },
  ];
}

/** Returns the worktree path, or null when creation failed (mission already marked failed). */
export async function createMissionWorktree(opts: {
  mission: Mission;
  repoPath: string;
  branch: string;
  projectId: string;
  initialTimeline: ActionEvent[];
  onUpdate: (update: MissionUpdate) => void;
  t?: TFunc;
}): Promise<string | null> {
  const { mission, repoPath, branch, projectId, initialTimeline, onUpdate, t } = opts;
  launchPhaseEnter(mission.id, 'createWorktree');
  try {
    const created = await createWorktreeWithBaseBranchFallback(
      repoPath,
      branch,
      mission.baseBranch,
      mission.mergeBranches,
    );
    launchPhaseExit(mission.id, 'createWorktree', `path="${created.worktreePath}"`);
    onUpdate({
      id: mission.id,
      patch: {
        worktree: branch,
        liveAction: t ? t('agents.runtime.worktreeReady') : 'Worktree prêt — démarrage du loop…',
        actionTimeline: readyTimeline(initialTimeline, created, t),
      },
    });
    return created.worktreePath;
  } catch (err) {
    launchPhaseError(mission.id, 'createWorktree', err);
    onUpdate({
      id: mission.id,
      patch: {
        status: 'failed',
        statusReason: `worktree_creation_failed: ${String(err).slice(0, 120)}`,
        liveAction: t ? t('agents.runtime.worktreeCreationFailed') : 'Échec création worktree',
        actionTimeline: failTimeline(initialTimeline, err, t),
      },
    });
    emitEvent({
      type: 'mission.failed',
      tsMs: Date.now(),
      projectId,
      missionId: mission.id,
      actor: 'system',
      payload: { reason: 'worktree_creation_failed' },
    });
    return null;
  }
}

export async function mergeWorktree(repoPath: string, branch: string, mergeIntoDir?: string): Promise<string> {
  return invoke<string>('agent_merge_worktree', {
    repoPath: normalizeRepoPathForGit(repoPath),
    branch,
    mergeIntoDir: mergeIntoDir === undefined ? undefined : normalizeRepoPathForGit(mergeIntoDir),
  });
}

export async function discardWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  return invoke<void>('agent_discard_worktree', {
    repoPath: normalizeRepoPathForGit(repoPath),
    worktreePath: normalizeRepoPathForGit(worktreePath),
    branch,
  });
}
