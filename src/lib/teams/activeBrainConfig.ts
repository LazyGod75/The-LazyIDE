/* activeBrainConfig.ts — durable active brain config (Vague 1).
 *
 * Replaces localStorage team-repos-config as the source of truth for the
 * active team brain. The config file lives at
 *   {appLocalDataDir}/lazy/teams/active.json
 *
 * Sync wrappers (`readActiveBrainConfig`, `writeActiveBrainConfig`,
 * `clearActiveBrainConfig`) operate on an in-memory cache populated by the
 * first async read. Call `readActiveBrainConfigAsync()` once at startup to
 * hydrate the cache from disk.
 *
 * Uses dedicated Tauri commands (teams_active_config_read/write/clear) that
 * bypass the project-root jail — active.json lives in app_local_data_dir,
 * NOT under a registered project root, so the generic fs commands would
 * reject it.
 */

import { isTauri } from '../platform/index.js';

export interface ActiveBrainConfig {
  orgId: string;
  repoUrl: string;
  localDir: string;
  lastPulledAt: number;
  lastPushedAt: number;
  lastError: string | null;
  role?: string;
}

let cachedConfig: ActiveBrainConfig | null = null;

export async function readActiveBrainConfigAsync(): Promise<ActiveBrainConfig | null> {
  if (!isTauri()) return cachedConfig;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const content = await invoke<string | null>('teams_active_config_read');
    if (!content) return cachedConfig;
    cachedConfig = JSON.parse(content) as ActiveBrainConfig;
    return cachedConfig;
  } catch {
    return cachedConfig;
  }
}

export function readActiveBrainConfig(): ActiveBrainConfig | null {
  return cachedConfig;
}

export function writeActiveBrainConfig(config: ActiveBrainConfig): void {
  cachedConfig = config;
  if (!isTauri()) return;
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('teams_active_config_write', { content: JSON.stringify(config, null, 2) });
    } catch {
      // best-effort — cache is already updated
    }
  })();
}

export function clearActiveBrainConfig(): void {
  cachedConfig = null;
  if (!isTauri()) return;
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('teams_active_config_clear');
    } catch {
      // best-effort
    }
  })();
}
