/* approvalMode.ts — persistence + CRUD for W-MODES's per-project (+ global
   default) merge-approval mode (ApprovalMode, types.ts).

   PERSISTENCE NOTE (mirrors objectivesStore.ts's own documented deviation,
   not re-derived): the ideal storage would be fleet-wide (app-data dir,
   independent of which project happens to be open right now), but the only
   generic write_file/read_file/fs_create_dir Tauri commands available are
   sandboxed to the currently OPEN project root
   (`ensure_write_path_in_any_open_project`, fs.rs) — there is no generic
   "write anywhere" command (agentsStorage.ts's dedicated `lazy_agent_save`
   bypasses the sandbox, but only for USER-scope agent JSON). So the whole
   config (global default + every project's override, keyed by project id)
   is persisted as ONE object under the ACTIVE project's `.lazy/
   approvalModes.json` — real fleet-wide-in-SHAPE, not yet in storage
   LOCATION. Flagged as a real follow-up (a dedicated app-data Rust command),
   not a silent stub — same honest compromise objectivesStore.ts already
   made for the exact same reason.

   Web (non-Tauri): falls back to localStorage, same as objectivesStore.ts.
*/

import { joinPath } from '../paths.js';
import { isTauri as isTauriRuntime } from '../platform/index.js';
import type { ApprovalMode } from './types.js';
import { projectIdFromRoot } from '../journal/projectId.js';

// Real-user design decision 2026-08-03 (three explicit modes, Cursor/Windsurf
// style): the global default is 'manual' — every change waits for the user,
// with the persistent Accept/Reject bar pinned ABOVE the chat (see
// LazyManager.tsx) so approving is one click, never a buried prompt. The
// other modes: 'auto_green' ("auto") merges intelligently (green verdict,
// or a REAL deliverable whose evaluation was technically unavailable — see
// evaluateAutoMerge's lazy floor), and 'full_auto' ("lazy") accepts
// everything automatically. Users switch modes per project (canvas toolbar
// badge); the Accept/Reject bar stays available in every mode.
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'manual';

export interface ApprovalModeConfig {
  defaultMode: ApprovalMode;
  /** Keyed by FleetProject.projectId (projectId.ts's projectIdFromRoot). */
  perProject: Record<string, ApprovalMode>;
}

const STORAGE_FILE_NAME = 'approvalModes.json';
const LOCAL_STORAGE_KEY = 'lazy.agents.approvalModes';

const VALID_MODES: readonly ApprovalMode[] = ['manual', 'auto_green', 'full_auto'];

function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value);
}

type Listener = (config: ApprovalModeConfig) => void;

let _config: ApprovalModeConfig = { defaultMode: DEFAULT_APPROVAL_MODE, perProject: {} };
let _loaded = false;
let _loadPromise: Promise<void> | null = null;
const _listeners = new Set<Listener>();

function cloneConfig(config: ApprovalModeConfig): ApprovalModeConfig {
  return { defaultMode: config.defaultMode, perProject: { ...config.perProject } };
}

function notify(): void {
  const snapshot = cloneConfig(_config);
  _listeners.forEach((fn) => fn(snapshot));
}

let _cachedProjectRoot: string | null = null;

async function resolveActiveProjectRoot(): Promise<string> {
  if (_cachedProjectRoot !== null) return _cachedProjectRoot;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    _cachedProjectRoot = await invoke<string>('get_project_root');
    return _cachedProjectRoot;
  } catch {
    _cachedProjectRoot = '.';
    return _cachedProjectRoot;
  }
}

function parseConfigJson(raw: unknown): ApprovalModeConfig {
  if (typeof raw !== 'object' || raw === null) {
    return { defaultMode: DEFAULT_APPROVAL_MODE, perProject: {} };
  }
  const rec = raw as Record<string, unknown>;
  const defaultMode = isApprovalMode(rec.defaultMode) ? rec.defaultMode : DEFAULT_APPROVAL_MODE;
  const perProject: Record<string, ApprovalMode> = {};
  const perProjectRaw = rec.perProject;
  if (typeof perProjectRaw === 'object' && perProjectRaw !== null) {
    for (const [key, value] of Object.entries(perProjectRaw as Record<string, unknown>)) {
      if (isApprovalMode(value)) perProject[key] = value;
    }
  }
  return { defaultMode, perProject };
}

async function saveToStorage(): Promise<void> {
  const json = JSON.stringify(_config);
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = await resolveActiveProjectRoot();
      const lazyDir = joinPath(root, '.lazy');
      await invoke<void>('fs_create_dir', { path: lazyDir });
      await invoke<void>('write_file', { path: joinPath(lazyDir, STORAGE_FILE_NAME), content: json });
    } catch {
      // best-effort — a storage failure must not break the UI
    }
  } else {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LOCAL_STORAGE_KEY, json);
      }
    } catch {
      // best-effort
    }
  }
}

async function loadFromStorage(): Promise<void> {
  try {
    let raw: unknown = null;
    if (isTauriRuntime()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const root = await resolveActiveProjectRoot();
        const text = await invoke<string>('read_file', { path: joinPath(root, '.lazy', STORAGE_FILE_NAME) });
        raw = JSON.parse(text) as unknown;
      } catch {
        // File does not exist yet — proceed with defaults
      }
    } else if (typeof localStorage !== 'undefined') {
      const text = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (text !== null) {
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          // invalid JSON — ignore, start with defaults
        }
      }
    }
    if (raw !== null) {
      _config = parseConfigJson(raw);
    }
  } catch {
    // best-effort: proceed with defaults
  } finally {
    _loaded = true;
    notify();
  }
}

/** Idempotent — safe to call from multiple mount points; only loads once. */
export function ensureApprovalModesLoaded(): Promise<void> {
  if (_loaded) return Promise.resolve();
  if (!_loadPromise) _loadPromise = loadFromStorage();
  return _loadPromise;
}

export function getApprovalModeConfig(): ApprovalModeConfig {
  return cloneConfig(_config);
}

/**
 * Fleet-safe key match for per-project overrides: canvas zones / openProjects
 * may mint a projectId with different drive-letter case or slash direction
 * than the key used when the mode was first saved. Normalize both sides so a
 * global-default flip still paints every open zone correctly, and a
 * per-project override still hits its zone.
 */
function normalizeApprovalProjectKey(projectId: string): string {
  return projectIdFromRoot(projectId).replace(/\\/g, '/').toLowerCase();
}

function findPerProjectOverride(projectId: string): ApprovalMode | undefined {
  const direct = _config.perProject[projectId];
  if (direct) return direct;
  const needle = normalizeApprovalProjectKey(projectId);
  for (const [key, mode] of Object.entries(_config.perProject)) {
    if (normalizeApprovalProjectKey(key) === needle) return mode;
  }
  return undefined;
}

/**
 * The EFFECTIVE mode for `projectId` — that project's own override when one
 * is set, else the global default. Omit `projectId` to read the global
 * default directly (mirrors objectivesStore.ts's Objective.projectId===null
 * "unlinked" convention: no project id in, no per-project lookup out).
 *
 * B26: lookup is fleet-normalized — not tied to whichever project happens
 * to be active when the canvas paints zone badges.
 */
export function getApprovalMode(projectId?: string): ApprovalMode {
  if (projectId) {
    const override = findPerProjectOverride(projectId);
    if (override) return override;
  }
  return _config.defaultMode;
}

/**
 * Effective modes for every open canvas project — pure read of the unified
 * config (global default + overrides). Used by fleet/canvas to assert the
 * toolbar global and each zone badge stay coherent after a flip.
 */
export function fleetApprovalModes(
  openProjectIds: readonly string[],
): Record<string, ApprovalMode> {
  const out: Record<string, ApprovalMode> = {};
  for (const id of openProjectIds) {
    out[id] = getApprovalMode(id);
  }
  return out;
}

export function subscribeApprovalModes(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Sets the approval mode — one project's override (`projectId` given) or
 * the global default (`projectId` omitted).
 *
 * Deliberately does NOT rescan or touch any in-flight mission: a mission
 * already sitting in 'review' at the moment this flips to an auto mode is
 * never retroactively merged by this call alone — only a LATER real patch to
 * that specific mission (a fresh verdict landing, a proof attached, a manual
 * retry) re-checks eligibility, since agentsStore.tsx's
 * `triggerAutoMergeIfEligible` only runs from updateMission/applyRunUpdate's
 * own patch-application choke points, never from a config-change listener.
 * A bulk silent merge of everything already waiting the instant a human
 * flips one toggle would be exactly the "merge 1 par 1" trust problem this
 * feature exists to fix, only pointed in the automated direction — so the
 * caller (agentsStore.tsx's `changeApprovalMode`) journals the flip via a
 * dedicated `approval.mode_changed` event instead of silently re-merging.
 */
export async function setApprovalMode(mode: ApprovalMode, projectId?: string): Promise<void> {
  _config = projectId
    ? {
        ..._config,
        perProject: { ..._config.perProject, [normalizeApprovalProjectKey(projectId)]: mode },
      }
    : { ..._config, defaultMode: mode };
  notify();
  await saveToStorage();
}

/** Test-only reset — mirrors objectivesStore.ts's _resetObjectivesForTests. */
export function _resetApprovalModesForTests(): void {
  _config = { defaultMode: DEFAULT_APPROVAL_MODE, perProject: {} };
  _loaded = false;
  _loadPromise = null;
  _cachedProjectRoot = null;
}
