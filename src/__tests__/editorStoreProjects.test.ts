/* editorStore — per-project tab scoping (T0.9).
   Locks the contract: open tabs (paths + active tab, never content) persist
   to localStorage under a key derived from the NORMALIZED project root, a
   `\\?\`-prefixed root and its plain equivalent must resolve to the exact
   same key (paths.ts's stripVerbatimPrefix, never hand-rolled — see
   paths.ts's module doc for the bug history), and a `project://changed`
   event force-saves the outgoing project's tabs before clearing and
   restoring the incoming project's persisted tabs (files re-read from disk,
   never from a stale in-memory cache).

   No JSX in this file (`.test.ts`, not `.test.tsx`) — the wrapper below uses
   React.createElement instead of a JSX tag.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import {
  EditorStoreProvider,
  useEditorStore,
  tabsStorageKey,
} from '../components/editor/editorStore';

// ── Mocks ────────────────────────────────────────────────────────────

// getPlatform() is called directly inside EditorStoreProvider (NOT via
// useAppContext/AppProvider — this store must keep working in the existing
// bare `<EditorStoreProvider>`-only test, see editorStore.test.tsx). A
// minimal `{ name, fs }` stand-in is enough: this module only ever reads
// `.name` and `.fs.readFile` (same minimal-mock convention as
// IndexingBanner.test.tsx's `makeTauriPlatform`).
const mockReadFile = vi.fn();

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(),
}));

// getProjectRoot() resolves the CURRENT active root once at provider-mount
// time (before any project://changed event has fired) — mocked here so each
// test controls what "already active on boot" means. Every other tauri.ts
// export is kept real via importOriginal (same pattern as
// BrainSpace.test.tsx's openFolder override).
const mockGetProjectRoot = vi.fn();

vi.mock('../lib/platform/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform/tauri')>();
  return { ...actual, getProjectRoot: mockGetProjectRoot };
});

type ProjectChangedHandler = (event: { payload: string }) => void;
let capturedHandler: ProjectChangedHandler | null = null;

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, handler: ProjectChangedHandler) => {
    if (eventName === 'project://changed') {
      capturedHandler = handler;
    }
    return Promise.resolve(vi.fn());
  }),
}));

import { getPlatform } from '../lib/platform';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(EditorStoreProvider, null, children);
}

/** Fires the captured `project://changed` handler — mirrors
 *  IndexingBanner.test.tsx's fireIndexingEvent helper (sync act(), the
 *  handler's own async continuation is awaited separately via waitFor). */
async function fireProjectChanged(root: string) {
  await waitFor(() => expect(capturedHandler).not.toBeNull());
  act(() => {
    capturedHandler?.({ payload: root });
  });
}

describe('editorStore — per-project tab scoping', () => {
  beforeEach(() => {
    localStorage.clear();
    mockReadFile.mockReset();
    mockGetProjectRoot.mockReset();
    mockGetProjectRoot.mockResolvedValue('');
    mockGetPlatform.mockReturnValue({ name: 'tauri', fs: { readFile: mockReadFile } });
    capturedHandler = null;
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ── key normalization ────────────────────────────────────────────

  it('maps a \\\\?\\-prefixed root and its plain equivalent to the same storage key', () => {
    const verbatim = tabsStorageKey('\\\\?\\C:\\Users\\dev\\proj');
    const plain = tabsStorageKey('C:\\Users\\dev\\proj');
    expect(verbatim).toBe(plain);
  });

  it('gives genuinely different roots different keys', () => {
    expect(tabsStorageKey('C:\\proj-a')).not.toBe(tabsStorageKey('C:\\proj-b'));
  });

  // ── web platform: fully inert ────────────────────────────────────

  it('never touches localStorage on the web platform', async () => {
    mockGetPlatform.mockReturnValue({ name: 'web', fs: { readFile: mockReadFile } });
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/proj/a.ts', 'a.ts', 'content');
    });

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(localStorage.getItem(tabsStorageKey('/proj'))).toBeNull();
  });

  // ── persistence (debounced) ──────────────────────────────────────

  it('persists open tabs to localStorage under the active project key, debounced', async () => {
    mockGetProjectRoot.mockResolvedValue('C:\\proj-a');
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    // Synchronization point: the init effect resolves getProjectRoot() and
    // assigns the ref BEFORE registering the listener (see editorStore.tsx) —
    // waiting for the listener guarantees the ref is already set.
    await waitFor(() => expect(capturedHandler).not.toBeNull());

    act(() => {
      result.current.openFile('C:\\proj-a\\src\\a.ts', 'a.ts', 'content-a');
    });

    // Immediately after the change, the debounce window has not elapsed yet.
    expect(localStorage.getItem(tabsStorageKey('C:\\proj-a'))).toBeNull();

    await waitFor(
      () => expect(localStorage.getItem(tabsStorageKey('C:\\proj-a'))).toBeTruthy(),
      { timeout: 1000 },
    );

    const parsed = JSON.parse(localStorage.getItem(tabsStorageKey('C:\\proj-a'))!);
    expect(parsed.paths).toEqual([{ path: 'C:\\proj-a\\src\\a.ts', pinned: undefined }]);
    expect(parsed.activeTabPath).toBe('C:\\proj-a\\src\\a.ts');
  });

  // ── switch: save outgoing + restore incoming ───────────────────────

  it('switching projects force-saves the outgoing tabs and restores the incoming ones', async () => {
    mockGetProjectRoot.mockResolvedValue('C:\\proj-a');
    // Pre-seed project B's persisted tabs, as if a previous session left them.
    localStorage.setItem(
      tabsStorageKey('C:\\proj-b'),
      JSON.stringify({ paths: [{ path: 'C:\\proj-b\\src\\b.ts' }], activeTabPath: 'C:\\proj-b\\src\\b.ts' }),
    );
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === 'C:\\proj-b\\src\\b.ts') return 'content-b';
      throw new Error(`unexpected read: ${path}`);
    });

    const { result } = renderHook(() => useEditorStore(), { wrapper });
    await waitFor(() => expect(capturedHandler).not.toBeNull());

    act(() => {
      result.current.openFile('C:\\proj-a\\src\\a.ts', 'a.ts', 'content-a');
    });
    expect(result.current.tabs).toHaveLength(1);

    await fireProjectChanged('C:\\proj-b');

    await waitFor(() =>
      expect(result.current.tabs.map((t) => t.path)).toEqual(['C:\\proj-b\\src\\b.ts']),
    );
    expect(result.current.activeTabPath).toBe('C:\\proj-b\\src\\b.ts');
    expect(result.current.tabs[0].content).toBe('content-b');
    expect(result.current.tabs[0].isDirty).toBe(false);

    // Project A's tabs were force-saved on the way out — NOT dependent on
    // the 300ms debounce, since the switch itself flushed synchronously.
    const savedA = JSON.parse(localStorage.getItem(tabsStorageKey('C:\\proj-a'))!);
    expect(savedA.paths).toEqual([{ path: 'C:\\proj-a\\src\\a.ts', pinned: undefined }]);
    expect(savedA.activeTabPath).toBe('C:\\proj-a\\src\\a.ts');
  });

  it('restoring skips files that no longer exist on disk without failing the others', async () => {
    localStorage.setItem(
      tabsStorageKey('C:\\proj-c'),
      JSON.stringify({
        paths: [{ path: 'C:\\proj-c\\gone.ts' }, { path: 'C:\\proj-c\\ok.ts' }],
        activeTabPath: 'C:\\proj-c\\gone.ts',
      }),
    );
    mockReadFile.mockImplementation(async (path: string) => {
      if (path === 'C:\\proj-c\\ok.ts') return 'ok-content';
      throw new Error('ENOENT');
    });

    const { result } = renderHook(() => useEditorStore(), { wrapper });
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    await fireProjectChanged('C:\\proj-c');

    await waitFor(() =>
      expect(result.current.tabs.map((t) => t.path)).toEqual(['C:\\proj-c\\ok.ts']),
    );
    // gone.ts was the persisted active tab but failed to load — falls back
    // to the first successfully restored tab rather than a dangling path.
    expect(result.current.activeTabPath).toBe('C:\\proj-c\\ok.ts');
  });
});
