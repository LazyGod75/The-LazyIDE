/* toolCollectionStore.ts — shared persistence plumbing for the BYO-tool
   catalogs (projectCommandTools.ts, transformTools.ts, declarativeTools.ts).

   Each catalog persists a JSON `{ tools: T[] }` blob under
   `.lazy/<file>.json` (Tauri), falling back to localStorage, then an
   in-memory array (web/tests) — before this extraction the exact same
   list/save/delete/reset logic was copy-pasted three times, ~60 lines each,
   verified line-for-line identical except for the storage file name / key
   and the per-kind type guard passed to `createToolCollectionStore`.

   ONE DELIBERATE NON-UNIFICATION: `resolveActiveProjectRoot`'s cache is
   built via `createProjectRootResolver()` — a FACTORY, not a shared
   singleton. Each catalog still gets its OWN independent cache instance,
   exactly like the three pre-extraction module-level `_cachedProjectRoot`
   variables. A single shared cache would have been a real behavior change:
   if catalog A resolves and caches project X, then the user switches the
   active project to Y, a shared cache would serve A's stale X to catalog B
   on its FIRST call — previously each catalog resolved fresh on its own
   first call. Keeping the caches independent (via the factory closure)
   preserves that exactly.

   ANOTHER DELIBERATE NON-UNIFICATION: `joinPath`. projectCommandTools.ts
   and transformTools.ts had an IDENTICAL local naive '/'-only joiner
   (`defaultJoinToolStoragePath` below). declarativeTools.ts instead
   imports paths.ts's separator-preserving `joinPath` (it needs that
   elsewhere, in `executeFileReadTool`, for a Windows `\\?\`-verbatim-safe
   join) and was ALREADY using that same import for its storage path too —
   a real, pre-existing divergence from the other two files, not a copy-
   paste accident. Unifying it onto the naive joiner would change
   declarativeTools.ts's Tauri-branch storage path on a verbatim-prefixed
   Windows root. `joinPath` is therefore an injectable config option,
   defaulting to the naive joiner; declarativeTools.ts passes its own
   paths.ts import to keep its exact prior behavior. */

import { isTauri as isTauriRuntime } from '../platform/index.js';

export { isTauriRuntime };

function defaultJoinToolStoragePath(base: string, ...segments: string[]): string {
  return [base, ...segments].join('/').replace(/\/+/g, '/');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ProjectRootResolver {
  resolve: () => Promise<string>;
  /** Test-only: forces the next `resolve()` call to re-invoke `get_project_root`. */
  reset: () => void;
}

/**
 * Builds an independent, lazily-resolved cache of the active project root.
 * Each catalog module calls this once at module load time and keeps the
 * returned resolver for its own exclusive use — see this file's header for
 * why the cache is per-instance rather than a shared singleton.
 */
export function createProjectRootResolver(): ProjectRootResolver {
  let cached: string | null = null;
  return {
    resolve: async () => {
      if (cached !== null) return cached;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        cached = await invoke<string>('get_project_root');
        return cached;
      } catch {
        cached = '.';
        return cached;
      }
    },
    reset: () => {
      cached = null;
    },
  };
}

export interface ToolCollectionConfig<T extends { id: string }> {
  /** File under the active project's `.lazy/` dir, e.g. `transformTools.json`. */
  storageFileName: string;
  /** localStorage key used for the non-Tauri fallback. */
  localStorageKey: string;
  /** Runtime shape guard for one stored tool — invalid entries are dropped
   *  silently when parsing (mirrors each catalog's pre-existing behavior). */
  isLike: (value: unknown) => value is T;
  /** Path joiner used to build the Tauri storage path. Defaults to a naive
   *  forward-slash joiner; pass a different one to preserve a catalog's
   *  pre-existing path-joining behavior (see this file's header). */
  joinPath?: (base: string, ...segments: string[]) => string;
}

export interface ToolCollectionStore<T extends { id: string }> {
  list(): Promise<T[]>;
  /** Upserts by id. Performs NO domain validation — the caller validates
   *  before calling this, exactly like every pre-extraction `saveXTool`. */
  save(tool: T): Promise<void>;
  remove(id: string): Promise<void>;
  /** Test-only: clears the mock store, the localStorage entry, and the
   *  cached project root. */
  resetForTests(): void;
}

/**
 * Generic three-tier persistence (Tauri JSON file -> localStorage ->
 * in-memory array) shared by every BYO-tool catalog. Extracted verbatim
 * from the identical list/persist/save/delete/reset logic that used to be
 * copy-pasted across projectCommandTools.ts, transformTools.ts and
 * declarativeTools.ts — see this file's header for the two deliberate
 * exceptions (project-root cache stays per-instance, joinPath is
 * injectable).
 */
export function createToolCollectionStore<T extends { id: string }>(
  config: ToolCollectionConfig<T>,
): ToolCollectionStore<T> {
  const { storageFileName, localStorageKey, isLike } = config;
  const joinPath = config.joinPath ?? defaultJoinToolStoragePath;
  const projectRoot = createProjectRootResolver();
  const mockStore: T[] = [];

  function parseToolsJson(raw: unknown): T[] {
    if (!isPlainObject(raw) || !Array.isArray(raw.tools)) return [];
    return raw.tools.filter(isLike);
  }

  async function list(): Promise<T[]> {
    if (!isTauriRuntime()) {
      if (typeof localStorage !== 'undefined') {
        try {
          const raw = localStorage.getItem(localStorageKey);
          if (raw) return parseToolsJson(JSON.parse(raw));
        } catch {
          // fall through to the in-memory mock
        }
      }
      return [...mockStore];
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = await projectRoot.resolve();
      const text = await invoke<string>('read_file', {
        path: joinPath(root, '.lazy', storageFileName),
      });
      return parseToolsJson(JSON.parse(text));
    } catch {
      return []; // file does not exist yet — no tools defined, not an error
    }
  }

  async function persist(tools: T[]): Promise<void> {
    const json = JSON.stringify({ tools });
    if (!isTauriRuntime()) {
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(localStorageKey, json);
          return;
        } catch {
          // fall through to the in-memory mock
        }
      }
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = await projectRoot.resolve();
      const lazyDir = joinPath(root, '.lazy');
      await invoke<void>('fs_create_dir', { path: lazyDir });
      await invoke<void>('write_file', { path: joinPath(lazyDir, storageFileName), content: json });
    } catch {
      // best-effort — a storage failure must not break the UI
    }
  }

  async function save(tool: T): Promise<void> {
    const existing = await list();
    const idx = existing.findIndex((t) => t.id === tool.id);
    const next = idx >= 0 ? existing.map((t, i) => (i === idx ? tool : t)) : [...existing, tool];
    if (!isTauriRuntime() && typeof localStorage === 'undefined') {
      if (idx >= 0) {
        mockStore[idx] = tool;
      } else {
        mockStore.push(tool);
      }
      return;
    }
    await persist(next);
  }

  async function remove(id: string): Promise<void> {
    const existing = await list();
    const next = existing.filter((t) => t.id !== id);
    if (!isTauriRuntime() && typeof localStorage === 'undefined') {
      const idx = mockStore.findIndex((t) => t.id === id);
      if (idx >= 0) mockStore.splice(idx, 1);
      return;
    }
    await persist(next);
  }

  function resetForTests(): void {
    mockStore.length = 0;
    projectRoot.reset();
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(localStorageKey);
      } catch {
        // ignore
      }
    }
  }

  return { list, save, remove, resetForTests };
}
