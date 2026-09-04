/* planAndActScripted — mock/browser fallback extracted from runtime.ts.

   Measured 2026-08-28: cyclomatic complexity 17 (ESLint ceiling 12).
   Behavior copied: five theatrical steps, real write_file of
   LAZY_AGENT_NOTES.md when Tauri IPC exists, mock timeline otherwise.
   Pauses are skipped when import.meta.env.MODE === 'test'.
*/

import { invoke } from '@tauri-apps/api/core';
import type { ActionEvent, PlanStep } from './types.js';
import type { TFunc } from './runtime.js';

export interface PlanAndActScriptedOpts {
  missionId: string;
  missionTitle: string;
  worktreePath: string;
  steps: PlanStep[];
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void;
  onAction: (event: ActionEvent) => void;
  onProgress: (pct: number) => void;
  stopSignal: () => boolean;
  t?: TFunc;
}

function clockHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function scriptedDelay(ms: number): Promise<void> {
  if (import.meta.env.MODE === 'test') return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paused(opts: PlanAndActScriptedOpts, ms: number): Promise<boolean> {
  await scriptedDelay(ms);
  return opts.stopSignal();
}

function tx(opts: PlanAndActScriptedOpts, key: string, fallback: string, params?: Record<string, string | number>): string {
  return opts.t ? opts.t(key, params) : fallback;
}

function live(opts: PlanAndActScriptedOpts, text: string, isLive: boolean): void {
  opts.onAction({ time: clockHm(), text, isLive });
}

async function scriptedAnalyze(opts: PlanAndActScriptedOpts): Promise<boolean> {
  opts.onStep(0, 'in_progress');
  live(opts, tx(opts, 'agents.runtime.scriptedAnalyzing', `Analyse de la mission "${opts.missionTitle}"`, { title: opts.missionTitle }), true);
  if (await paused(opts, 600)) return true;
  opts.onStep(0, 'done', `fait · ${clockHm()}`);
  opts.onProgress(20);
  return false;
}

async function scriptedRead(opts: PlanAndActScriptedOpts): Promise<boolean> {
  opts.onStep(1, 'in_progress');
  live(opts, tx(opts, 'agents.runtime.scriptedReadReadme', 'Lu README.md'), true);
  if (await paused(opts, 500)) return true;
  live(opts, tx(opts, 'agents.runtime.scriptedScanning', 'Scanne les fichiers du worktree…'), true);
  if (await paused(opts, 400)) return true;
  opts.onStep(1, 'done', `fait · ${clockHm()}`);
  opts.onProgress(40);
  return false;
}

async function scriptedWriteNotes(opts: PlanAndActScriptedOpts): Promise<boolean> {
  opts.onStep(2, 'in_progress');
  live(opts, tx(opts, 'agents.runtime.scriptedCreatingNotes', 'Création de LAZY_AGENT_NOTES.md…'), true);
  const notesContent = [
    `# Agent Notes — ${opts.missionTitle}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    `Mission: ${opts.missionTitle}`,
    `Worktree: ${opts.worktreePath}`,
    '',
    '## Analyse',
    'Phase 1 scripted loop — placeholder for real model output.',
    '',
    '## Modifications',
    '- Created this notes file as proof of real worktree edit',
    '',
    '## Statut',
    'Prêt pour revue.',
  ].join('\n');
  try {
    await invoke<void>('write_file', { path: `${opts.worktreePath}/LAZY_AGENT_NOTES.md`, content: notesContent });
    live(opts, tx(opts, 'agents.runtime.scriptedWroteNotes', `Écrit LAZY_AGENT_NOTES.md (+${notesContent.split('\n').length} lignes)`, { lines: notesContent.split('\n').length }), false);
  } catch {
    live(opts, tx(opts, 'agents.runtime.scriptedMockWrite', '[mock] Écriture simulée LAZY_AGENT_NOTES.md'), false);
  }
  if (await paused(opts, 600)) return true;
  opts.onStep(2, 'done', `fait · ${clockHm()}`);
  opts.onProgress(65);
  return false;
}

async function scriptedLint(opts: PlanAndActScriptedOpts): Promise<boolean> {
  opts.onStep(3, 'in_progress');
  live(opts, tx(opts, 'agents.runtime.scriptedLinting', 'Exécution validation (lint)…'), true);
  if (await paused(opts, 700)) return true;
  live(opts, tx(opts, 'agents.runtime.scriptedLintOk', 'Validation : OK (0 erreurs)'), false);
  opts.onStep(3, 'done', `fait · ${clockHm()}`);
  opts.onProgress(82);
  return false;
}

async function scriptedDiff(opts: PlanAndActScriptedOpts): Promise<boolean> {
  opts.onStep(4, 'in_progress');
  live(opts, tx(opts, 'agents.runtime.scriptedComputingDiff', 'Calcul du diff final…'), true);
  if (await paused(opts, 300)) return true;
  opts.onStep(4, 'done', `fait · ${clockHm()}`);
  opts.onProgress(100);
  return false;
}

export async function runPlanAndActScripted(opts: PlanAndActScriptedOpts): Promise<void> {
  if (await scriptedAnalyze(opts)) return;
  if (await scriptedRead(opts)) return;
  if (await scriptedWriteNotes(opts)) return;
  if (await scriptedLint(opts)) return;
  await scriptedDiff(opts);
}
