/**
 * Tests for canvasPersistence.ts — GLOBAL load/save roundtrip via the
 * canvas_state_load/save Tauri commands (W3 migration off per-project
 * `.lazy/canvas/*.json`), the one-time legacy-file migration, corrupt-file
 * self-heal, non-Tauri no-op, and the debounced autosave subscribe helper.
 *
 * `@tauri-apps/api/core` is globally mocked by src/__tests__/setup.ts (see
 * journal.test.ts for the same `vi.mocked(invoke)` pattern this file
 * follows) — `getPlatform().fs` is still mocked locally, but now only
 * exercised via the legacy-migration code path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';

const readFile = vi.fn();
const writeFile = vi.fn().mockResolvedValue(undefined);
const createDir = vi.fn().mockResolvedValue(undefined);
const rename = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    name: 'tauri',
    fs: { readFile, writeFile, createDir, rename },
  })),
}));

import { getPlatform } from '../lib/platform';
import {
  loadCanvasLayout,
  saveCanvasLayout,
  loadCanvasChains,
  saveCanvasChains,
  saveCanvasChainsGlobal,
  defaultCanvasLayout,
  defaultCanvasChains,
  subscribeCanvasAutosave,
} from '../components/agents/canvas/canvasPersistence';
import { DEFAULT_CANVAS_PREFS, makeRef, type CanvasLayoutFileV1, type ChainsFileV1, type RouterSpec } from '../components/agents/canvas/canvasTypes';
import type { CanvasState } from '../components/agents/canvas/canvasStore';

const mockInvoke = vi.mocked(invoke);

/** In-memory fake for the two global commands — keyed exactly like the
 *  real Rust store (`layout` | `chains` -> JSON string | null). */
function installGlobalStateFake(initial: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const store: Record<string, string | undefined> = { ...initial };
  mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = args as { key?: string; json?: string } | undefined;
    if (cmd === 'canvas_state_load') {
      return store[a?.key ?? ''] ?? null;
    }
    if (cmd === 'canvas_state_save') {
      store[a?.key ?? ''] = a?.json;
      return undefined;
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  return store;
}

beforeEach(() => {
  readFile.mockReset();
  writeFile.mockClear().mockResolvedValue(undefined);
  createDir.mockClear().mockResolvedValue(undefined);
  rename.mockClear().mockResolvedValue(undefined);
  vi.mocked(getPlatform).mockReturnValue({
    name: 'tauri',
    fs: { readFile, writeFile, createDir, rename },
  } as unknown as ReturnType<typeof getPlatform>);
  mockInvoke.mockReset();
});

describe('loadCanvasLayout — global storage', () => {
  it('returns defaults and seeds the global file when nothing exists yet (no legacy file either)', async () => {
    installGlobalStateFake();
    readFile.mockRejectedValue(new Error('ENOENT')); // no legacy .lazy/canvas/layout.json

    const result = await loadCanvasLayout('/repo');

    expect(result).toEqual(defaultCanvasLayout());
    // Seeds the global file so this migration check never re-runs.
    expect(mockInvoke).toHaveBeenCalledWith('canvas_state_save', expect.objectContaining({ key: 'layout' }));
  });

  it('reads straight from the global command when a global file already exists', async () => {
    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: { [makeRef('mission', 'm1')]: { x: 1, y: 2 } },
      collapsed: {},
      prefs: DEFAULT_CANVAS_PREFS,
      notes: [],
    };
    installGlobalStateFake({ layout: JSON.stringify(layout) });

    const result = await loadCanvasLayout('/repo');

    expect(result).toEqual(layout);
    expect(readFile).not.toHaveBeenCalled(); // legacy fs never consulted once global exists
  });

  it('resets to defaults and self-heals when the global file is invalid JSON', async () => {
    installGlobalStateFake({ layout: '{ not json' });

    const result = await loadCanvasLayout('/repo');

    expect(result).toEqual(defaultCanvasLayout());
    // Self-heal: the corrupt content is overwritten with fresh defaults.
    const saveCall = mockInvoke.mock.calls.find(([cmd]) => cmd === 'canvas_state_save');
    expect(saveCall).toBeDefined();
    expect(JSON.parse((saveCall![1] as { json: string }).json)).toEqual(defaultCanvasLayout());
  });

  it('resets to defaults when the global file is schema-invalid', async () => {
    installGlobalStateFake({ layout: JSON.stringify({ version: 2, positions: {}, collapsed: {}, prefs: DEFAULT_CANVAS_PREFS, notes: [] }) });

    const result = await loadCanvasLayout('/repo');

    expect(result).toEqual(defaultCanvasLayout());
  });
});

describe('saveCanvasLayout / loadCanvasLayout roundtrip (global)', () => {
  it('round-trips a valid layout file through the global command', async () => {
    const store = installGlobalStateFake();
    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: { [makeRef('mission', 'm1')]: { x: 12, y: 34 } },
      viewport: { x: 0, y: 0, zoom: 1.2 },
      collapsed: { proj1: true },
      prefs: DEFAULT_CANVAS_PREFS,
      notes: [{ id: 'n1', text: 'hello', projectId: 'proj1' }],
    };

    await saveCanvasLayout('/repo', layout);
    expect(store.layout).toBeDefined();

    const loaded = await loadCanvasLayout('/repo');
    expect(loaded).toEqual(layout);
  });
});

describe('One-time legacy migration', () => {
  it('adopts a valid legacy .lazy/canvas/chains.json when the global file is absent', async () => {
    installGlobalStateFake(); // global absent
    const legacyChains: ChainsFileV1 = {
      version: 1,
      chains: [{ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'success', createdBy: 'user' }],
      drafts: [{ id: 'd1', title: 'T', task: 'do it', createdBy: 'user' }],
    };
    readFile.mockImplementation(async (path: string) => {
      if (path.includes('chains.json')) return JSON.stringify(legacyChains);
      throw new Error('ENOENT');
    });

    const result = await loadCanvasChains('/repo/proj');

    expect(result).toEqual(legacyChains);
    // The legacy file is never touched/deleted — only read.
    expect(rename).not.toHaveBeenCalled();

    // The new global file carries a migratedFrom marker (disk-only, not
    // part of the returned/validated ChainsFileV1 shape).
    const saveCall = mockInvoke.mock.calls.find(([cmd, args]) => cmd === 'canvas_state_save' && (args as { key?: string })?.key === 'chains');
    expect(saveCall).toBeDefined();
    const written = JSON.parse((saveCall![1] as { json: string }).json);
    expect(written.migratedFrom).toBe('/repo/proj');
    expect(written.chains).toEqual(legacyChains.chains);
  });

  it('falls back to defaults (and never touches legacy fs) when repoPath is empty', async () => {
    installGlobalStateFake();

    const result = await loadCanvasChains('');

    expect(result).toEqual(defaultCanvasChains());
    expect(readFile).not.toHaveBeenCalled();
  });

  it('quarantines a corrupt legacy file to .bak during migration, same as before', async () => {
    installGlobalStateFake();
    readFile.mockResolvedValue('{ not json at all');

    const result = await loadCanvasLayout('/repo/proj');

    expect(result).toEqual(defaultCanvasLayout());
    expect(rename).toHaveBeenCalledTimes(1);
    const [oldPath, newPath] = rename.mock.calls[0];
    expect(oldPath).toContain('layout.json');
    expect(newPath).toBe(`${oldPath}.bak`);
  });

  it('never re-migrates once the global file has been written', async () => {
    const store = installGlobalStateFake();
    readFile.mockRejectedValue(new Error('ENOENT'));

    await loadCanvasLayout('/repo/proj'); // seeds the global file with defaults
    readFile.mockClear();
    mockInvoke.mockClear();
    // Re-arm the fake so the SECOND load reads back what the first call wrote.
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { key?: string; json?: string } | undefined;
      if (cmd === 'canvas_state_load') return store[a?.key ?? ''] ?? null;
      if (cmd === 'canvas_state_save') {
        store[a?.key ?? ''] = a?.json;
        return undefined;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await loadCanvasLayout('/repo/proj');

    expect(readFile).not.toHaveBeenCalled(); // legacy fs never consulted the second time
  });
});

describe('saveCanvasChainsGlobal', () => {
  it('writes the chains key directly, bypassing any debounce', async () => {
    installGlobalStateFake();
    const chainsFile: ChainsFileV1 = { version: 1, chains: [], drafts: [] };

    await saveCanvasChainsGlobal(chainsFile);

    expect(mockInvoke).toHaveBeenCalledWith('canvas_state_save', { key: 'chains', json: JSON.stringify(chainsFile) });
  });

  it('is a no-op outside Tauri', async () => {
    vi.mocked(getPlatform).mockReturnValue({ name: 'web' } as unknown as ReturnType<typeof getPlatform>);
    await saveCanvasChainsGlobal(defaultCanvasChains());
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('non-Tauri platform — pure no-op', () => {
  it('load* returns defaults without touching invoke or fs', async () => {
    vi.mocked(getPlatform).mockReturnValue({ name: 'web' } as unknown as ReturnType<typeof getPlatform>);

    const layout = await loadCanvasLayout('/repo');
    const chains = await loadCanvasChains('/repo');

    expect(layout).toEqual(defaultCanvasLayout());
    expect(chains).toEqual(defaultCanvasChains());
    expect(readFile).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('save* is a no-op without touching invoke', async () => {
    vi.mocked(getPlatform).mockReturnValue({ name: 'web' } as unknown as ReturnType<typeof getPlatform>);

    await saveCanvasLayout('/repo', defaultCanvasLayout());
    await saveCanvasChains('/repo', defaultCanvasChains());

    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('subscribeCanvasAutosave', () => {
  function fakeStore() {
    const listeners: Array<(state: CanvasState) => void> = [];
    return {
      subscribe: (fn: (state: CanvasState) => void) => {
        listeners.push(fn);
        return () => {
          const idx = listeners.indexOf(fn);
          if (idx !== -1) listeners.splice(idx, 1);
        };
      },
      emit: (state: CanvasState) => listeners.forEach((fn) => fn(state)),
    };
  }

  const sampleState = {
    positions: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    collapsed: {},
    prefs: DEFAULT_CANVAS_PREFS,
    notes: [],
    chains: [],
    drafts: [],
  } as unknown as CanvasState;

  it('debounces rapid changes into a single save after the wait window', async () => {
    installGlobalStateFake();
    const store = fakeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal StoreApi-shaped test double
    const dispose = subscribeCanvasAutosave(store as any, () => '/repo', 20);

    store.emit(sampleState);
    store.emit(sampleState);
    store.emit(sampleState);
    expect(mockInvoke).not.toHaveBeenCalled();

    // Poll for the debounced save instead of racing a fixed 60ms sleep
    // against the 20ms debounce — a fixed margin like that can lose under
    // heavy parallel test-suite CPU contention (real timers really do slip
    // under load; see team-brain-search.test.tsx's own doc comment for the
    // general shape of this class of flake).
    await waitFor(() => {
      const saveCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'canvas_state_save');
      expect(saveCalls.length).toBe(2); // layout.json + chains.json, once each
    });
    dispose();
  });

  it('never saves when getRepoPath() returns null (no active project)', async () => {
    installGlobalStateFake();
    const store = fakeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal StoreApi-shaped test double
    const dispose = subscribeCanvasAutosave(store as any, () => null, 10);

    store.emit(sampleState);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(mockInvoke).not.toHaveBeenCalled();
    dispose();
  });

  it('serializes routers into the debounce-saved ChainsFileV1, exactly like chains/drafts (W9 fix — was previously dropped)', async () => {
    const store = installGlobalStateFake();
    const fake = fakeStore();
    const router: RouterSpec = {
      id: 'router-1',
      projectId: 'proj-1',
      branches: [
        { id: 'b1', label: 'ok', condition: { kind: 'outcome', value: 'success' } },
        { id: 'b2', label: 'default', condition: { kind: 'default' } },
      ],
    };
    const stateWithRouter = { ...sampleState, routers: [router] } as unknown as CanvasState;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal StoreApi-shaped test double
    const dispose = subscribeCanvasAutosave(fake as any, () => '/repo', 10);
    fake.emit(stateWithRouter);

    // Poll instead of a fixed sleep — see the debounce test above.
    await waitFor(() => {
      expect(store.chains).toBeDefined();
    });
    const written = JSON.parse(store.chains!) as ChainsFileV1;
    expect(written.routers).toEqual([router]);

    // Roundtrip through loadCanvasChains too — hydrate already reads
    // `chainsFile?.routers ?? []` (canvasStore.ts's `hydrate`), so this
    // proves the FULL save->load cycle preserves a palette/context-menu-
    // created router, not just the raw JSON shape.
    const loaded = await loadCanvasChains('/repo');
    expect(loaded.routers).toEqual([router]);

    dispose();
  });

  it('flushes a pending save immediately when the document becomes hidden', async () => {
    installGlobalStateFake();
    const store = fakeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal StoreApi-shaped test double
    const dispose = subscribeCanvasAutosave(store as any, () => '/repo', 60_000); // long debounce

    store.emit(sampleState);
    expect(mockInvoke).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    // flush() runs the save synchronously, but saveCanvasLayout/saveCanvasChains
    // are async — poll instead of guessing how many microtask/macrotask
    // hops the drain needs.
    await waitFor(() => {
      const saveCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'canvas_state_save');
      expect(saveCalls.length).toBe(2);
    });
    dispose();
  });

  it('dispose() unsubscribes and flushes any pending save', async () => {
    installGlobalStateFake();
    const store = fakeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal StoreApi-shaped test double
    const dispose = subscribeCanvasAutosave(store as any, () => '/repo', 20);

    store.emit(sampleState);
    dispose();
    // P1 fix: dispose() now flushes (not cancels) the pending debounced
    // save, so the save IS invoked immediately rather than dropped. Poll
    // instead of a fixed sleep — see the debounce test above.
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalled();
    });
  });
});

describe('empty-overwrite guard (BUG 1 defense-in-depth, W6f)', () => {
  const existingLayout: CanvasLayoutFileV1 = {
    version: 1,
    positions: { [makeRef('draft', 'd1')]: { x: 3, y: 4 } },
    collapsed: {},
    prefs: DEFAULT_CANVAS_PREFS,
    notes: [],
  };
  const existingChains: ChainsFileV1 = {
    version: 1,
    chains: [{ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'success', createdBy: 'user' }],
    drafts: [{ id: 'd1', title: 'T', task: 'do it', createdBy: 'user' }],
  };

  function fakeStore() {
    const listeners: Array<(state: CanvasState) => void> = [];
    return {
      subscribe: (fn: (state: CanvasState) => void) => {
        listeners.push(fn);
        return () => {
          const idx = listeners.indexOf(fn);
          if (idx !== -1) listeners.splice(idx, 1);
        };
      },
      emit: (state: CanvasState) => listeners.forEach((fn) => fn(state)),
    };
  }

  const emptyState = {
    positions: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    collapsed: {},
    prefs: DEFAULT_CANVAS_PREFS,
    notes: [],
    chains: [],
    drafts: [],
  } as unknown as CanvasState;

  it('BLOCKS an autosave that would overwrite non-empty layout.json/chains.json with an empty, not-yet-hydrated state', async () => {
    const store = installGlobalStateFake({ layout: JSON.stringify(existingLayout), chains: JSON.stringify(existingChains) });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = fakeStore();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal StoreApi-shaped test double
    const dispose = subscribeCanvasAutosave(fake as any, () => '/repo', 10, () => false);
    fake.emit(emptyState);

    // Poll for the warn (the guard's own tripwire) instead of racing a
    // fixed 50ms sleep against the 10ms debounce. Once the warn has fired,
    // the guard has already decided NOT to write, so the unchanged-store
    // assertions right after are safe to check synchronously.
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('BLOCKED an autosave'));
    });
    expect(store.layout).toBe(JSON.stringify(existingLayout)); // unchanged — guard tripped
    expect(store.chains).toBe(JSON.stringify(existingChains)); // unchanged — guard tripped
    dispose();
    warnSpy.mockRestore();
  });

  it('allows the same empty save through once isHydrated() proves it is a genuine user clear-all', async () => {
    const store = installGlobalStateFake({ layout: JSON.stringify(existingLayout), chains: JSON.stringify(existingChains) });
    const fake = fakeStore();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal StoreApi-shaped test double
    const dispose = subscribeCanvasAutosave(fake as any, () => '/repo', 10, () => true);
    fake.emit(emptyState);

    // Poll instead of a fixed sleep — see the debounce test above.
    await waitFor(() => {
      expect(JSON.parse(store.layout!)).toEqual({ version: 1, positions: {}, viewport: emptyState.viewport, collapsed: {}, prefs: DEFAULT_CANVAS_PREFS, notes: [] });
    });
    expect(JSON.parse(store.chains!)).toEqual({ version: 1, chains: [], drafts: [] });
    dispose();
  });

  it('never trips when nothing was stored yet (first-ever save, empty or not)', async () => {
    const store = installGlobalStateFake(); // nothing stored
    const fake = fakeStore();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal StoreApi-shaped test double
    const dispose = subscribeCanvasAutosave(fake as any, () => '/repo', 10, () => false);
    fake.emit(emptyState);

    // Poll instead of a fixed sleep — see the debounce test above.
    await waitFor(() => {
      expect(store.layout).toBeDefined(); // wrote through — nothing to protect
    });
    dispose();
  });

  it('saveCanvasLayout/saveCanvasChains called directly (no opts) are unaffected by the guard', async () => {
    installGlobalStateFake({ layout: JSON.stringify(existingLayout) });

    // A direct, explicit call is always trusted (opts.hydrated defaults to
    // true) — existing call sites never gain a new failure mode.
    await saveCanvasLayout('/repo', defaultCanvasLayout());
    expect(mockInvoke).toHaveBeenCalledWith('canvas_state_save', { key: 'layout', json: JSON.stringify(defaultCanvasLayout()) });
  });
});
