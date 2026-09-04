/* managerContext.ts — Fleet-wide and Brain-driven manager context (Pillar B3/D6).
   Builds the orchestrator context blocks injected into the manager system prompt.
*/

import { getSnapshot, getAllOrchestrators, getGlobalBudget as getRuntimeGlobalBudget } from './globalRuntime.js';
import { listAgentTemplates } from './agentTemplates.js';
import { getEffectiveAutonomy } from './autonomyMode.js';
import type { AutonomyConfig } from './types.js';
import { getProvenLessons, getTrialLessons } from './lessons/lessonStore.js';

const OTHER_PROJECTS_DIGEST_MAX_LINES = 12;

/** Compact per-mission lines for projects that are NOT the active board.
 *  Reads the existing fleet registry (`getSnapshot`) — no bots/solari writes.
 *  Returns undefined when every known mission is already on the active board
 *  (or the registry is empty), so the prompt stays quiet on a single-project
 *  session. */
export function buildOtherProjectsDigest(activeMissionIds: readonly string[] = []): string | undefined {
  const active = new Set(activeMissionIds);
  const snapshot = getSnapshot();
  const lines: string[] = [];
  for (const p of snapshot.projects) {
    for (const m of p.missions) {
      if (active.has(m.id)) continue;
      const title = (m.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const label = title.length > 0 ? ` "${title}"` : '';
      lines.push(`- ${p.projectName}: ${m.id}${label} [${m.status}]`);
      if (lines.length >= OTHER_PROJECTS_DIGEST_MAX_LINES) break;
    }
    if (lines.length >= OTHER_PROJECTS_DIGEST_MAX_LINES) break;
  }
  if (lines.length === 0) return undefined;
  return lines.join('\n');
}

export function buildFleetContext(): string {
  const snapshot = getSnapshot();
  const lines: string[] = [];
  lines.push(
    `Fleet status: ${snapshot.projects.length} project(s), ${snapshot.allMissions.length} mission(s), ${snapshot.runningMissions.length} running, ${snapshot.blockedMissions.length} blocked/failed/review.`,
  );

  for (const p of snapshot.projects.slice(0, 20)) {
    const ratio = p.budget.limitCents ? Math.round((p.budget.spentCents / p.budget.limitCents) * 100) : 0;
    lines.push(
      `- ${p.projectName} (${p.projectId}): ${p.missions.length} missions, ${p.orchestrators.length} orchestrators, budget ${p.budget.spentCents}/${p.budget.limitCents ?? 'unlimited'} cents (${ratio}%).`,
    );
  }

  const gb = getRuntimeGlobalBudget();
  lines.push(`Global budget: ${gb.spentCents}/${gb.limitCents ?? 'unlimited'} cents.`);
  return lines.join('\n');
}

/** Honest name: this block is agent templates + orchestrators, not LazyBrain recall. */
export function buildTemplateOrchestratorContext(query?: string): string {
  const templates = listAgentTemplates();
  const orchestrators = getAllOrchestrators();
  const lines: string[] = [];

  if (query) lines.push(`Template/orchestrator context for query: ${query}`);
  if (templates.length) lines.push(`Reusable templates: ${templates.map((t) => t.name).join(', ')}`);
  if (orchestrators.length) {
    lines.push(`Active orchestrators: ${orchestrators.map((o) => `${o.name} [${o.status}]`).join(', ')}`);
  }

  return lines.join('\n');
}

/** @deprecated D88 — alias of buildTemplateOrchestratorContext (name used to imply LazyBrain). */
export function buildBrainDrivenContext(query?: string): string {
  return buildTemplateOrchestratorContext(query);
}

export function buildLessonsContext(projectId?: string, _query?: string): string {
  if (!projectId) return '';
  const proven = getProvenLessons(projectId).slice(0, 8);
  const trials = getTrialLessons(projectId).slice(0, 3);
  if (proven.length === 0 && trials.length === 0) return '';

  const lines: string[] = [];
  if (proven.length > 0) {
    lines.push('Proven lessons (apply when relevant):');
    for (const l of proven) {
      const tag = `[${l.where}]`;
      const body = l.body.slice(0, 200);
      lines.push(`- ${tag} ${l.title}: ${body}`);
    }
  }
  if (trials.length > 0) {
    lines.push('Trial lessons (consider, not yet proven):');
    for (const l of trials) {
      const tag = `[${l.where}]`;
      const body = l.body.slice(0, 150);
      lines.push(`- ${tag} ${l.title}: ${body}`);
    }
  }
  return lines.join('\n');
}

export function formatAutonomyContext(autonomy?: AutonomyConfig): string {
  const config = getEffectiveAutonomy(autonomy);
  return `Autonomy mode: ${config.mode}. Allowed actions: ${config.allowedActions?.join(', ') ?? 'all'}. Denied actions: ${config.deniedActions?.join(', ') ?? 'none'}.`;
}
