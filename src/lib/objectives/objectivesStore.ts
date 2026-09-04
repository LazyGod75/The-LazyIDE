/* objectivesStore.ts — CAP objectives (D6): persistence + CRUD + subscribe.

   PERSISTENCE NOTE (deviation from the D6 spec, discovered while building
   this): the spec calls for "app-data dir" (project-independent) storage,
   the same pattern agentsStorage.ts documents for USER-scope agents
   (~/.lazy/agents). That user-scope path is only reachable through a
   dedicated Rust command (`lazy_agent_save`, agent.rs) that bypasses the
   ProjectRegistry sandbox specifically for agent JSON files — there is no
   generic "write anywhere" fs command. The actual generic `write_file` /
   `read_file` / `fs_create_dir` commands this module (and usageHistory.ts)
   use are sandboxed to the currently OPEN project root(s)
   (`ensure_write_path_in_any_open_project`, fs.rs) — an `appDataDir()`
   path is outside every open project and those calls would simply be
   rejected. Adding a new Rust command was out of scope for this
   (frontend-only) wave, so objectives are persisted per ACTIVE project's
   `.lazy/objectives.json`, mirroring usageHistory.ts's exact storage
   pattern, rather than truly fleet-wide. See the Cockpit wave report for
   the full rationale — flagged as a real follow-up, not a silent stub.
*/

import { joinPath } from '../paths.js';
import { isTauri as isTauriRuntime } from '../platform/index.js';

export interface Objective {
  id: string;
  title: string;
  /** Epoch ms this objective was created — the pacing baseline. */
  createdAtMs: number;
  /** Epoch ms deadline, or null for a permanent/no-deadline rule. */
  deadlineMs: number | null;
  /** Fixed target count (e.g. "9" in "7/9"), or null when not counted in
   *  fixed units (a permanent rule, gauge shows "∞"). */
  targetCount: number | null;
  /** Current progress count. Manual for an unlinked objective (projectId
   *  null). For a project-linked objective, auto-derived live from that
   *  project's real MERGED missions since createdAtMs (B9,
   *  useObjectivesAutoProgress.ts) unless manualOverride is set. */
  currentCount: number;
  /** Fleet project id this objective is scoped to, or null for a
   *  project-agnostic objective. Drives B9's auto-progress derivation in
   *  addition to display context (e.g. a recovery-plan message). */
  projectId: string | null;
  /** B9: true once the user has manually corrected currentCount for a
   *  project-linked objective — freezes auto-derivation until cleared.
   *  Always false/absent for unlinked objectives (already fully manual). */
  manualOverride?: boolean;
}

const STORAGE_FILE_NAME = 'objectives.json';
const LOCAL_STORAGE_KEY = 'lazy.cockpit.objectives';

type Listener = (objectives: Objective[]) => void;

let _objectives: Objective[] = [];
let _loaded = false;
let _loadPromise: Promise<void> | null = null;
const _listeners = new Set<Listener>();

function notify(): void {
  const snapshot = [..._objectives];
  _listeners.forEach((fn) => fn(snapshot));
}

let _cachedProjectRoot: string | null = null;

async function resolveProjectRoot(): Promise<string> {
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

function isValidObjective(value: unknown): value is Objective {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    typeof rec.title === 'string' &&
    typeof rec.createdAtMs === 'number' &&
    (rec.deadlineMs === null || typeof rec.deadlineMs === 'number') &&
    (rec.targetCount === null || typeof rec.targetCount === 'number') &&
    typeof rec.currentCount === 'number' &&
    (rec.projectId === null || typeof rec.projectId === 'string') &&
    (rec.manualOverride === undefined || typeof rec.manualOverride === 'boolean')
  );
}

function parseObjectivesJson(raw: unknown): Objective[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidObjective);
}

async function saveToStorage(): Promise<void> {
  const json = JSON.stringify(_objectives);
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = await resolveProjectRoot();
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
        const root = await resolveProjectRoot();
        const text = await invoke<string>('read_file', { path: joinPath(root, '.lazy', STORAGE_FILE_NAME) });
        raw = JSON.parse(text) as unknown;
      } catch {
        // File does not exist yet — proceed with empty state
      }
    } else if (typeof localStorage !== 'undefined') {
      const text = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (text !== null) {
        try {
          raw = JSON.parse(text) as unknown;
        } catch {
          // invalid JSON — ignore, start empty
        }
      }
    }
    if (raw !== null) {
      _objectives = parseObjectivesJson(raw);
    }
  } catch {
    // best-effort: proceed with empty state
  } finally {
    _loaded = true;
    notify();
  }
}

/** Idempotent — safe to call from multiple mount points; only loads once. */
export function ensureObjectivesLoaded(): Promise<void> {
  if (_loaded) return Promise.resolve();
  if (!_loadPromise) _loadPromise = loadFromStorage();
  return _loadPromise;
}

export function getObjectives(): Objective[] {
  return [..._objectives];
}

export function subscribeObjectives(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function newObjectiveId(): string {
  return `obj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreateObjectiveInput {
  title: string;
  deadlineMs: number | null;
  targetCount: number | null;
  projectId: string | null;
}

export async function addObjective(input: CreateObjectiveInput): Promise<Objective> {
  const objective: Objective = {
    id: newObjectiveId(),
    title: input.title,
    createdAtMs: Date.now(),
    deadlineMs: input.deadlineMs,
    targetCount: input.targetCount,
    currentCount: 0,
    projectId: input.projectId,
  };
  _objectives = [..._objectives, objective];
  notify();
  await saveToStorage();
  return objective;
}

export async function updateObjective(id: string, patch: Partial<Omit<Objective, 'id'>>): Promise<void> {
  _objectives = _objectives.map((o) => (o.id === id ? { ...o, ...patch } : o));
  notify();
  await saveToStorage();
}

export async function deleteObjective(id: string): Promise<void> {
  _objectives = _objectives.filter((o) => o.id !== id);
  notify();
  await saveToStorage();
}

/** Test-only reset — mirrors costStore.ts's resetCost(). */
export function _resetObjectivesForTests(): void {
  _objectives = [];
  _loaded = false;
  _loadPromise = null;
  _cachedProjectRoot = null;
}
