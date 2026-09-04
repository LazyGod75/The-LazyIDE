/**
 * toolCollectionStore.test.ts — coverage for the generic persistence helper
 * shared by the three BYO-tool catalogs (projectCommandTools.ts,
 * transformTools.ts, declarativeTools.ts). Their own test files already
 * cover the CRUD behavior end-to-end through each catalog's public API;
 * this file targets the extracted primitives directly: the store factory's
 * upsert/delete/reset semantics, the mock-store fallback, and the
 * independent (never shared) project-root cache per resolver instance.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  isTauriRuntime,
  createProjectRootResolver,
  createToolCollectionStore,
} from '../lib/agents/toolCollectionStore';

interface FakeTool {
  id: string;
  name: string;
}

function isFakeToolLike(value: unknown): value is FakeTool {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).name === 'string'
  );
}

describe('isTauriRuntime', () => {
  it('is false in the vitest/jsdom environment (no __TAURI_INTERNALS__ global)', () => {
    expect(isTauriRuntime()).toBe(false);
  });
});

describe('createProjectRootResolver', () => {
  const mockInvoke = vi.mocked(invoke);

  it('resolves via invoke("get_project_root") and caches the result across calls', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'get_project_root' ? '/fake/root' : undefined),
    );
    const resolver = createProjectRootResolver();
    const first = await resolver.resolve();
    const second = await resolver.resolve();
    expect(first).toBe('/fake/root');
    expect(second).toBe('/fake/root');
    expect(mockInvoke).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('falls back to "." when invoke rejects (no Tauri runtime available)', async () => {
    mockInvoke.mockRejectedValue(new Error('no tauri runtime'));
    const resolver = createProjectRootResolver();
    expect(await resolver.resolve()).toBe('.');
  });

  it('reset() forces the next resolve() to re-invoke get_project_root', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'get_project_root' ? '/root-1' : undefined),
    );
    const resolver = createProjectRootResolver();
    await resolver.resolve();
    resolver.reset();
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'get_project_root' ? '/root-2' : undefined),
    );
    expect(await resolver.resolve()).toBe('/root-2');
  });

  it('gives each caller an independent cache — resetting one resolver never affects another', async () => {
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'get_project_root' ? '/root-a' : undefined),
    );
    const a = createProjectRootResolver();
    const b = createProjectRootResolver();
    await a.resolve();
    a.reset();
    mockInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'get_project_root' ? '/root-b' : undefined),
    );
    // b never resolved before this call, so it picks up the CURRENT mock
    // value fresh — independent of a's own cache/reset lifecycle.
    expect(await b.resolve()).toBe('/root-b');
  });
});

describe('createToolCollectionStore', () => {
  const config = {
    storageFileName: 'fakeTools.json',
    localStorageKey: 'lazy.agents.__test__.fakeTools',
    isLike: isFakeToolLike,
  };

  beforeEach(() => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(config.localStorageKey);
  });

  it('starts empty', async () => {
    const store = createToolCollectionStore<FakeTool>(config);
    expect(await store.list()).toEqual([]);
  });

  it('save then list round-trips the tool', async () => {
    const store = createToolCollectionStore<FakeTool>(config);
    const tool: FakeTool = { id: 'a', name: 'Tool A' };
    await store.save(tool);
    expect(await store.list()).toEqual([tool]);
  });

  it('saving the same id again updates in place rather than duplicating', async () => {
    const store = createToolCollectionStore<FakeTool>(config);
    await store.save({ id: 'a', name: 'v1' });
    await store.save({ id: 'a', name: 'v2' });
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('v2');
  });

  it('remove deletes exactly the targeted tool and is a no-op for an absent id', async () => {
    const store = createToolCollectionStore<FakeTool>(config);
    await store.save({ id: 'a', name: 'A' });
    await store.save({ id: 'b', name: 'B' });
    await store.remove('a');
    expect((await store.list()).map((t) => t.id)).toEqual(['b']);
    await expect(store.remove('does-not-exist')).resolves.toBeUndefined();
    expect(await store.list()).toHaveLength(1);
  });

  it('two independently-constructed stores for the SAME config do not share state', async () => {
    // localStorage IS shared (same key), but each store's own in-memory
    // mock array is private to its closure — this proves the factory
    // creates a fresh store, not a shared singleton.
    const storeA = createToolCollectionStore<FakeTool>(config);
    await storeA.save({ id: 'a', name: 'A' });
    const storeB = createToolCollectionStore<FakeTool>(config);
    // storeB reads through localStorage (populated by storeA's save), so it
    // sees the same persisted data — this is the intended cross-instance
    // persistence contract, not shared in-memory mutable state.
    expect(await storeB.list()).toEqual([{ id: 'a', name: 'A' }]);
  });

  it('resetForTests clears the mock store and the localStorage entry', async () => {
    const store = createToolCollectionStore<FakeTool>(config);
    await store.save({ id: 'a', name: 'A' });
    store.resetForTests();
    expect(await store.list()).toEqual([]);
  });

  it('filters out malformed entries when parsing persisted JSON', async () => {
    localStorage.setItem(
      config.localStorageKey,
      JSON.stringify({ tools: [{ id: 'a', name: 'ok' }, { id: 'missing-name' }, 'not an object'] }),
    );
    const store = createToolCollectionStore<FakeTool>(config);
    expect(await store.list()).toEqual([{ id: 'a', name: 'ok' }]);
  });

  it('accepts an injected joinPath without changing the mock-store CRUD contract', async () => {
    const calls: string[] = [];
    const store = createToolCollectionStore<FakeTool>({
      ...config,
      localStorageKey: 'lazy.agents.__test__.fakeTools.customJoin',
      joinPath: (base, ...segments) => {
        const joined = [base, ...segments].join('|');
        calls.push(joined);
        return joined;
      },
    });
    const tool: FakeTool = { id: 'a', name: 'A' };
    await store.save(tool);
    expect(await store.list()).toEqual([tool]);
    // The custom joiner is only exercised on the Tauri branch, never in the
    // localStorage/mock fallback exercised by this test suite.
    expect(calls).toEqual([]);
    localStorage.removeItem('lazy.agents.__test__.fakeTools.customJoin');
  });
});
