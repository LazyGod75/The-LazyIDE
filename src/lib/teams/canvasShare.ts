/* canvasShare.ts — durable team canvas sharing through the team git repo
   (design §10 git-sync + the "share the canvas layout itself" requirement).

   Every autosave of the local canvas (`canvas_state_save` → app-data dir)
   is mirrored into the org trunk clone (`<trunkClone>/canvas/layout.json`
   and `chains.json`) with a `savedAtMs` stamp; the sync daemon's push
   cycle commits + pushes it. On pull, the daemon merges the remote canvas
   back into the local files.

   Merge policy (same model as teams_git.rs's merge_canvas_json): field-
   level union by id; for a field present in both sides, the file with the
   HIGHER `savedAtMs` wins; fields present in only one side survive. This
   is last-writer-wins-per-item, the right multi-master model for a shared
   canvas (positions are per-node, notes/chains per-id).

   Live co-editing (real-time position moves while both members are online)
   lives in lib/collab/ (canvas ops over the Realtime presence channel) —
   this module is the durable, offline-capable transport.
*/

import { invoke } from '@tauri-apps/api/core';
import { emit } from '../bus.js';
import { getPlatform } from '../platform/index.js';
import type { TeamRepoConfig } from './githubConnect.js';
import type { CanvasLayoutFileV1, ChainsFileV1 } from '../../components/agents/canvas/canvasTypes.js';
import { defaultCanvasLayout, defaultCanvasChains } from '../../components/agents/canvas/canvasPersistence.js';

// ── Event surfaced to the live store when a remote canvas lands ─────
export const CANVAS_REMOTE_SYNC_EVENT = 'canvas:remote-sync';

export interface CanvasRemoteSyncPayload {
  repoUrl: string;
  layout?: CanvasLayoutFileV1;
  chains?: ChainsFileV1;
}

// ── Global canvas file bridge (canvas_state_load/save) ───────────────

async function loadCanvasFile(key: 'layout' | 'chains'): Promise<unknown | null> {
  try {
    const raw = await invoke<string | null>('canvas_state_load', { key });
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCanvasFile(key: 'layout' | 'chains', data: unknown): Promise<void> {
  try {
    await invoke<void>('canvas_state_save', { key, json: JSON.stringify(data) });
  } catch {
    // persistence must never throw — the daemon is best-effort
  }
}

// ── Publish: local canvas → team repo clone ──────────────────────────

/**
 * Mirror the local canvas files into the given team repo clone (the org
 * trunk), stamped with `savedAtMs`. Safe to call on every autosave — the
 * daemon's push cycle commits whatever changed.
 */
export async function publishCanvasToTeam(
  repo: TeamRepoConfig,
): Promise<{ layout: boolean; chains: boolean }> {
  const out = { layout: false, chains: false };
  const layout = await loadCanvasFile('layout');
  const chains = await loadCanvasFile('chains');
  if (!layout && !chains) return out;

  const canvasDir = `${repo.localDir}/canvas`;
  try {
    await invoke('fs_create_dir', { path: canvasDir });
  } catch {
    // dir may already exist
  }

  const platform = getPlatform();
  const now = Date.now();
  if (layout && typeof layout === 'object') {
    const stamped = { ...(layout as object), savedAtMs: now };
    try {
      await platform.fs.writeFile(`${canvasDir}/layout.json`, JSON.stringify(stamped));
      out.layout = true;
    } catch {
      // best-effort
    }
  }
  if (chains && typeof chains === 'object') {
    const stamped = { ...(chains as object), savedAtMs: now };
    try {
      await platform.fs.writeFile(`${canvasDir}/chains.json`, JSON.stringify(stamped));
      out.chains = true;
    } catch {
      // best-effort
    }
  }
  return out;
}

// ── Apply: team repo clone → local canvas (merged) ───────────────────

/** True when the value looks like a full canvas file (has a `version`). */
function isCanvasFileShape(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && (value as Record<string, unknown>).version !== undefined;
}

function stampOf(value: unknown): number {
  if (value && typeof value === 'object' && typeof (value as { savedAtMs?: unknown }).savedAtMs === 'number') {
    return (value as { savedAtMs: number }).savedAtMs;
  }
  return 0;
}

function mergeKeyedMap(
  local: Record<string, unknown> | undefined,
  remote: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!local && !remote) return undefined;
  const out: Record<string, unknown> = { ...(local ?? {}) };
  for (const [key, remoteVal] of Object.entries(remote ?? {})) {
    const localVal = out[key];
    if (localVal === undefined) {
      out[key] = remoteVal;
      continue;
    }
    out[key] = stampOf(remoteVal) >= stampOf(localVal) ? remoteVal : localVal;
  }
  return out;
}

function mergeKeyedList(
  local: unknown,
  remote: unknown,
): unknown {
  if (!Array.isArray(local) && !Array.isArray(remote)) return remote ?? local;
  const localList = Array.isArray(local) ? local : [];
  const remoteList = Array.isArray(remote) ? remote : [];
  const byId = new Map<string, { value: unknown; ms: number }>();
  for (const item of localList) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    byId.set(id, { value: item, ms: stampOf(item) });
  }
  for (const item of remoteList) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const existing = byId.get(id);
    const ms = stampOf(item);
    if (!existing || ms >= existing.ms) byId.set(id, { value: item, ms });
  }
  if (byId.size === 0) return remoteList.length > 0 ? remoteList : localList;
  return Array.from(byId.values()).map((entry) => entry.value);
}

const LIST_KEYS = new Set(['notes', 'surfaces', 'frames', 'chains', 'drafts', 'routers', 'joins', 'macros', 'contests']);
const MAP_KEYS = new Set(['positions', 'collapsed', 'expandedPanels', 'prefs', 'draftVersions']);

/**
 * Merge a remote canvas file into the local one. Per-item last-writer-wins
 * (by id / NodeRef), not whole-file LWW — two teammates editing different
 * nodes must not clobber each other. `savedAtMs` on the file is still
 * used as a fallback for scalar fields (viewport).
 */
export function mergeCanvasSnapshots<T extends Record<string, unknown>>(
  local: T,
  remote: T,
): T {
  const localMs = typeof local.savedAtMs === 'number' ? local.savedAtMs : 0;
  const remoteMs = typeof remote.savedAtMs === 'number' ? remote.savedAtMs : 0;
  const result: Record<string, unknown> = { ...local };

  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    if (key === 'savedAtMs' || key === 'version') continue;
    const localVal = local[key];
    const remoteVal = remote[key];
    if (LIST_KEYS.has(key)) {
      result[key] = mergeKeyedList(localVal, remoteVal);
      continue;
    }
    if (MAP_KEYS.has(key) && (isRecord(localVal) || isRecord(remoteVal))) {
      const merged = mergeKeyedMap(
        isRecord(localVal) ? localVal : undefined,
        isRecord(remoteVal) ? remoteVal : undefined,
      );
      if (merged) result[key] = merged;
      continue;
    }
    if (remoteVal === undefined) continue;
    if (localVal === undefined || remoteMs >= localMs) result[key] = remoteVal;
  }
  result.savedAtMs = Math.max(localMs, remoteMs);
  if (typeof local.version === 'number' || typeof remote.version === 'number') {
    result.version = local.version ?? remote.version;
  }
  return result as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * After a pull, merge the remote canvas files from the clone into the
 * local app-data canvas and emit `canvas:remote-sync` so the live store
 * can apply the positions immediately (if the canvas is open).
 */
export async function applyTeamCanvasToLocal(repo: TeamRepoConfig): Promise<boolean> {
  let applied = false;
  const payload: CanvasRemoteSyncPayload = { repoUrl: repo.repoUrl };
  const platform = getPlatform();

  try {
    const remoteLayoutRaw = await platform.fs.readFile(`${repo.localDir}/canvas/layout.json`);
    const remoteLayout = JSON.parse(remoteLayoutRaw) as unknown;
    if (isCanvasFileShape(remoteLayout)) {
      const localLayout = await loadCanvasFile('layout');
      const local: CanvasLayoutFileV1 = localLayout && isCanvasFileShape(localLayout)
        ? (localLayout as unknown as CanvasLayoutFileV1)
        : defaultCanvasLayout();
      const merged = mergeCanvasSnapshots<Record<string, unknown>>(
        local as unknown as Record<string, unknown>,
        remoteLayout as Record<string, unknown>,
      );
      await saveCanvasFile('layout', merged);
      payload.layout = merged as unknown as CanvasLayoutFileV1;
      applied = true;
    }
  } catch {
    // no remote layout.json yet (or read failure) — nothing to apply
  }

  try {
    const remoteChainsRaw = await platform.fs.readFile(`${repo.localDir}/canvas/chains.json`);
    const remoteChains = JSON.parse(remoteChainsRaw) as unknown;
    if (isCanvasFileShape(remoteChains)) {
      const localChains = await loadCanvasFile('chains');
      const local: ChainsFileV1 = localChains && isCanvasFileShape(localChains)
        ? (localChains as unknown as ChainsFileV1)
        : defaultCanvasChains();
      const merged = mergeCanvasSnapshots<Record<string, unknown>>(
        local as unknown as Record<string, unknown>,
        remoteChains as Record<string, unknown>,
      );
      await saveCanvasFile('chains', merged);
      payload.chains = merged as unknown as ChainsFileV1;
      applied = true;
    }
  } catch {
    // no remote chains.json yet — nothing to apply
  }

  if (applied) {
    emit('canvas:remote-sync', payload);
  }
  return applied;
}
