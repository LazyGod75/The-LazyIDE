/* agentTemplates.ts — Reusable agent templates (Pillar B4).
   Learned from successful missions and shared across projects via the Brain.
*/

import type { Mission } from './types.js';

export interface AgentTemplate {
  name: string;
  agentName?: string;
  taskPattern: string;
  systemPrompt?: string;
  modelTier?: string;
  tags?: string[];
}

const templates = new Map<string, AgentTemplate>();

export function recordTemplate(template: AgentTemplate): void {
  templates.set(template.name, template);
}

export function listAgentTemplates(): AgentTemplate[] {
  return Array.from(templates.values());
}

export function findTemplate(name: string): AgentTemplate | undefined {
  return templates.get(name);
}

export function templateFromMission(mission: Mission): AgentTemplate {
  return {
    name: `template-${mission.agentName ?? 'agent'}-${mission.id}`,
    agentName: mission.agentName,
    taskPattern: mission.agentTask ?? mission.title,
    modelTier: mission.model,
    tags: ['auto-generated'],
  };
}

export function clearTemplates(): void {
  templates.clear();
}
