/* agentsStorage.ts — Platform-neutral storage for LazyAgent definitions.
   Tauri mode: reads/writes ~/.lazy/agents/*.json (user) and <project>/.lazy/agents/*.json (project).
   Web mock mode: in-memory store.
*/

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../platform/index.js';
import type { LazyAgent, AgentScope } from './agentDef.js';

// ── Returned item from Rust ────────────────────────────────────────

export interface StoredAgent {
  agent: LazyAgent;
  scope: AgentScope;
}

// ── Web mock store ────────────────────────────────────────────────

const _mockStore: StoredAgent[] = [];

let _agentsCache: { at: number; value: StoredAgent[] } | null = null;
const AGENTS_LIST_TTL_MS = 15_000;

export function invalidateAgentsListCache(): void {
  _agentsCache = null;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * List all agents (user + project scopes).
 * Tauri: calls lazy_agents_list Rust command.
 * Web: returns in-memory mock store.
 */
export async function listAgents(): Promise<StoredAgent[]> {
  if (!isTauri()) {
    return [..._mockStore];
  }
  if (_agentsCache && Date.now() - _agentsCache.at < AGENTS_LIST_TTL_MS) {
    return _agentsCache.value;
  }
  try {
    const result = await invoke<StoredAgent[]>('lazy_agents_list');
    _agentsCache = { at: Date.now(), value: result };
    return result;
  } catch {
    return [];
  }
}

/**
 * Save (create or update) an agent.
 * Tauri: calls lazy_agent_save Rust command, then reloads schedules.
 * Web: upserts in the in-memory mock store.
 */
export async function saveAgent(scope: AgentScope, agent: LazyAgent): Promise<void> {
  if (!isTauri()) {
    const idx = _mockStore.findIndex((s) => s.agent.id === agent.id);
    if (idx >= 0) {
      _mockStore[idx] = { agent, scope };
    } else {
      _mockStore.push({ agent, scope });
    }
    invalidateAgentsListCache();
    return;
  }
  await invoke<void>('lazy_agent_save', {
    scope,
    agentJson: JSON.stringify(agent),
  });
  invalidateAgentsListCache();
  // Reload scheduler so new/updated cron schedules take effect immediately
  try {
    await invoke<number>('reload_agent_schedules');
  } catch {
    // Non-fatal — scheduler may not be running (web mode / no Tauri)
  }
}

/**
 * Delete an agent by id and scope.
 * Tauri: calls lazy_agent_delete Rust command.
 * Web: removes from in-memory mock store.
 */
export async function deleteAgent(scope: AgentScope, id: string): Promise<void> {
  if (!isTauri()) {
    const idx = _mockStore.findIndex((s) => s.agent.id === id && s.scope === scope);
    if (idx >= 0) _mockStore.splice(idx, 1);
    invalidateAgentsListCache();
    return;
  }
  await invoke<void>('lazy_agent_delete', { scope, id });
  invalidateAgentsListCache();
}
