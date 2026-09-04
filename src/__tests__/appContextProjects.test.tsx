/* AppContext — multi-project registry (T0.9).
   Locks the boot + switch contract: on boot, the registry (`project_list`)
   is the source of truth when non-empty; when empty but a legacy
   `lazy.lastProject` key exists, that path is registered exactly once
   (seamless upgrade — never re-registered on subsequent renders);
   `switchProject(id)` calls `project_set_active` (NOT the old path-based
   `set_project`) and updates `activeProjectId` optimistically. Recents
   (`lazy.projects.recent`) are touched as a side effect of both boot paths.

   Tauri is simulated via `window.__TAURI_INTERNALS__` (same convention as
   agentsStore.test.tsx's simulateTauri helper) — every AppContext code path
   under test is gated on `platform.name === 'tauri'`, matching production.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { AppProvider, useAppContext } from '../app/AppContext';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// invoke is globally mocked in setup.ts (vi.mock('@tauri-apps/api/core', ...))
// to resolve undefined by default; each test below overrides its per-command
// behavior (same pattern as BrainSpace.test.tsx / MemoryPanel.test.tsx).
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

// listen is globally mocked in setup.ts too (resolves a no-op unlisten by
// default, ignoring the handler). The project://changed suite below needs
// to capture the handler AppContext registers, so it overrides the
// implementation per-test; reset to the shared default in beforeEach so
// that override never leaks into other describe blocks in this file.
const mockListen = listen as ReturnType<typeof vi.fn>;

interface ProjectEntryOutFixture {
  id: string;
  root: string;
  brainId: string | null;
  active: boolean;
}

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <AppProvider>{children}</AppProvider>;
}

describe('AppContext — multi-project registry', () => {
  beforeEach(() => {
    simulateTauri();
    localStorage.clear();
    mockInvoke.mockReset();
    mockListen.mockReset();
    mockListen.mockResolvedValue(() => undefined);
  });

  afterEach(() => {
    clearTauriSimulation();
    localStorage.clear();
  });

  it('boot hydrates openProjects/activeProjectId from project_list when the registry is non-empty', async () => {
    const entries: ProjectEntryOutFixture[] = [
      { id: 'p1', root: 'C:\\proj1', brainId: null, active: true },
      { id: 'p2', root: 'C:\\proj2', brainId: null, active: false },
    ];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'project_list') return entries;
      return undefined;
    });

    const { result } = renderHook(() => useAppContext(), { wrapper });

    await waitFor(() => expect(result.current.openProjects).toHaveLength(2));
    expect(result.current.activeProjectId).toBe('p1');
    expect(result.current.projectRoot).toBe('C:\\proj1');

    // The legacy-upgrade path must NOT trigger when the registry already has entries.
    expect(mockInvoke).not.toHaveBeenCalledWith('project_register', expect.anything());
  });

  it('registers the legacy lazy.lastProject path exactly once when the registry is empty (seamless upgrade)', async () => {
    localStorage.setItem('lazy.lastProject', 'C:\\legacy-project');

    // Stateful fake registry — mirrors the real Rust backend closely enough
    // that a SECOND project_list() call (registerProject's own post-register
    // refresh) reflects the just-registered entry, the same way it would
    // against the actual ProjectRegistry.
    let registered: ProjectEntryOutFixture | null = null;
    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'project_list') return registered ? [registered] : [];
      if (cmd === 'project_register') {
        expect(args).toEqual({ path: 'C:\\legacy-project' });
        registered = { id: 'legacy-id', root: 'C:\\legacy-project', brainId: null, active: false };
        return registered;
      }
      if (cmd === 'project_set_active') {
        expect(args).toEqual({ id: 'legacy-id' });
        if (registered) registered = { ...registered, active: true };
        return undefined;
      }
      return undefined;
    });

    const { result } = renderHook(() => useAppContext(), { wrapper });

    await waitFor(() => expect(result.current.activeProjectId).toBe('legacy-id'));
    expect(result.current.projectRoot).toBe('C:\\legacy-project');
    expect(result.current.openProjects).toHaveLength(1);

    const registerCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === 'project_register');
    expect(registerCalls).toHaveLength(1);

    // Recents were touched by the upgrade path too.
    const recents = JSON.parse(localStorage.getItem('lazy.projects.recent') ?? '[]');
    expect(recents[0]).toMatchObject({ root: 'C:\\legacy-project' });
  });

  // Regression coverage for the real-app bug: 'lazy.lastProject' held a raw
  // Windows extended-length ('\\?\'-prefixed) path after boot, and the
  // 'lazy.projectRoot' backstop stayed null even after registerProject/
  // switchProject were patched to write it — proving the restore path
  // (registry non-empty branch below) bypassed both normalization and the
  // backstop write. project_list's own root is the verbatim source here
  // (project_register_inner/project_set_active_inner canonicalize() on the
  // Rust side), not the legacy-upgrade path (covered above).
  it('normalizes a verbatim (\\\\?\\-prefixed) root on restore and writes the normalized backstop key', async () => {
    const verbatimRoot = '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    const normalizedRoot = 'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet';
    const entries: ProjectEntryOutFixture[] = [
      { id: 'p1', root: verbatimRoot, brainId: null, active: true },
    ];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'project_list') return entries;
      return undefined;
    });

    const { result } = renderHook(() => useAppContext(), { wrapper });

    await waitFor(() => expect(result.current.projectRoot).toBe(normalizedRoot));
    expect(localStorage.getItem('lazy.lastProject')).toBe(normalizedRoot);
    expect(localStorage.getItem('lazy.projectRoot')).toBe(normalizedRoot);
  });

  it('leaves the registry empty when there is no legacy key either (fresh install)', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'project_list') return [];
      return undefined;
    });

    const { result } = renderHook(() => useAppContext(), { wrapper });

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('project_list'));
    expect(result.current.openProjects).toEqual([]);
    expect(result.current.activeProjectId).toBeNull();
    expect(result.current.projectRoot).toBe('');
  });

  it('switchProject invokes project_set_active with the id (not the old path-based set_project) and updates activeProjectId', async () => {
    const entries: ProjectEntryOutFixture[] = [
      { id: 'a', root: 'C:\\A', brainId: null, active: true },
      { id: 'b', root: 'C:\\B', brainId: null, active: false },
    ];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'project_list') return entries;
      return undefined;
    });

    const { result } = renderHook(() => useAppContext(), { wrapper });
    await waitFor(() => expect(result.current.openProjects).toHaveLength(2));

    await act(async () => {
      await result.current.switchProject('b');
    });

    expect(mockInvoke).toHaveBeenCalledWith('project_set_active', { id: 'b' });
    expect(mockInvoke).not.toHaveBeenCalledWith('set_project', expect.anything());
    expect(result.current.activeProjectId).toBe('b');
    expect(result.current.openProjects.find((p) => p.id === 'b')?.active).toBe(true);
    expect(result.current.openProjects.find((p) => p.id === 'a')?.active).toBe(false);
  });

  it('registerProject registers then activates, and is a no-op outside Tauri', async () => {
    clearTauriSimulation();
    mockInvoke.mockImplementation(async () => undefined);

    const { result } = renderHook(() => useAppContext(), { wrapper });

    await act(async () => {
      await result.current.registerProject('C:\\web-mode-path');
    });

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.current.openProjects).toEqual([]);
  });

  describe('project://changed re-lists openProjects (P2: rail desync fix)', () => {
    /** Captures the handler AppContext passes to listen('project://changed', ...)
     *  so the test can fire it directly — simulating a project registered/
     *  activated by something OTHER than this context's own registerProject/
     *  switchProject (a raw invoke, a deep link, a future LazyManager tool). */
    function captureChangedHandler(): { fire: (payload: string) => void } {
      let handler: ((event: { payload: string }) => void) | null = null;
      mockListen.mockImplementation(async (eventName: string, cb: (event: { payload: string }) => void) => {
        if (eventName === 'project://changed') handler = cb;
        return () => undefined;
      });
      return {
        fire: (payload: string) => {
          if (!handler) throw new Error('project://changed handler was never registered');
          handler({ payload });
        },
      };
    }

    it('re-lists openProjects and re-syncs activeProjectId from the registry', async () => {
      let entries: ProjectEntryOutFixture[] = [
        { id: 'p1', root: 'C:\\proj1', brainId: null, active: true },
      ];
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'project_list') return entries;
        return undefined;
      });
      const { fire } = captureChangedHandler();

      const { result } = renderHook(() => useAppContext(), { wrapper });
      await waitFor(() => expect(result.current.openProjects).toHaveLength(1));

      // Backend registers + activates a SECOND project behind AppContext's
      // back, then emits project://changed — before this fix, openProjects
      // stayed stuck at length 1 even though projectRoot moved on.
      entries = [
        { id: 'p1', root: 'C:\\proj1', brainId: null, active: false },
        { id: 'p2', root: 'C:\\proj2', brainId: null, active: true },
      ];
      act(() => fire('C:\\proj2'));

      await waitFor(() => expect(result.current.openProjects).toHaveLength(2));
      expect(result.current.openProjects.map((p) => p.id)).toEqual(['p1', 'p2']);
      expect(result.current.activeProjectId).toBe('p2');
      expect(result.current.projectRoot).toBe('C:\\proj2');
    });

    it('no-ops (does not replace the openProjects array) when the registry is unchanged', async () => {
      const entries: ProjectEntryOutFixture[] = [
        { id: 'p1', root: 'C:\\proj1', brainId: null, active: true },
      ];
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'project_list') return entries;
        return undefined;
      });
      const { fire } = captureChangedHandler();

      const { result } = renderHook(() => useAppContext(), { wrapper });
      await waitFor(() => expect(result.current.openProjects).toHaveLength(1));
      const firstArrayRef = result.current.openProjects;

      act(() => fire('C:\\proj1'));
      // Give the refresh's listProjects()-then-compare chain a tick to run.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.openProjects).toBe(firstArrayRef);
    });

    it('is resilient to a listProjects failure — logs, never throws, projectRoot still updates', async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'project_list') throw new Error('IPC hiccup');
        return undefined;
      });
      const { fire } = captureChangedHandler();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useAppContext(), { wrapper });
      await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('project_list'));

      expect(() => act(() => fire('C:\\proj-x'))).not.toThrow();
      await waitFor(() => expect(result.current.projectRoot).toBe('C:\\proj-x'));
      await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());

      consoleErrorSpy.mockRestore();
    });

    // Regression coverage for the 2026-08-12 live repro ("opportunistic
    // canvas refresh" defect): an EARLIER-issued listProjects() (this
    // listener's own refresh, triggered by a project://changed event that
    // fired before the user's own open_project action) must never be
    // allowed to overwrite a LATER-issued one (registerProject's own
    // refresh, for that same open_project action) just because it happens
    // to resolve second — that ordering flip is exactly what made a
    // just-opened project's zone silently disappear again a moment after it
    // correctly appeared.
    it('a slower, earlier-issued project_list response is dropped once a later one already applied (out-of-order IPC race)', async () => {
      const p1: ProjectEntryOutFixture = { id: 'p1', root: 'C:\\proj1', brainId: null, active: true };
      const p2: ProjectEntryOutFixture = { id: 'p2', root: 'C:\\proj2', brainId: null, active: true };

      let projectListCalls = 0;
      let resolveStaleEventListenerCall: ((entries: ProjectEntryOutFixture[]) => void) | null = null;

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'project_list') {
          projectListCalls += 1;
          // Call #1 — boot hydration.
          if (projectListCalls === 1) return [p1];
          // Call #2 — the project://changed listener's OWN refresh, fired
          // BELOW before registerProject runs, so it is ISSUED first — but
          // deliberately held open here (never resolves on its own) so the
          // test controls exactly when its (stale) response lands, after
          // call #3 has already won.
          if (projectListCalls === 2) {
            return new Promise<ProjectEntryOutFixture[]>((resolve) => {
              resolveStaleEventListenerCall = resolve;
            });
          }
          // Call #3 — registerProject's own refresh for the open_project
          // action started AFTER call #2 was already issued, but resolves
          // immediately: the correct, up-to-date registry contents.
          return [p1, p2];
        }
        if (cmd === 'project_register') return p2;
        if (cmd === 'project_set_active') return undefined;
        return undefined;
      });
      const { fire } = captureChangedHandler();

      const { result } = renderHook(() => useAppContext(), { wrapper });
      await waitFor(() => expect(result.current.openProjects).toHaveLength(1));

      // Issues call #2 (held open) — some unrelated project activation the
      // registry already knows about, behind AppContext's back.
      act(() => fire('C:\\proj1'));

      // Issues call #3 and awaits it to completion — the real open_project
      // action's own registerProject, which DOES resolve.
      await act(async () => {
        await result.current.registerProject('C:\\proj2');
      });

      // The correct, complete picture is live immediately — never blocked
      // on the still-pending call #2.
      expect(result.current.openProjects).toHaveLength(2);
      expect(result.current.openProjects.map((p) => p.id).sort()).toEqual(['p1', 'p2']);

      // NOW let the slow, earlier-issued call #2 land — with STALE data
      // (missing p2, the project that was just opened).
      await act(async () => {
        resolveStaleEventListenerCall?.([p1]);
        await Promise.resolve();
        await Promise.resolve();
      });

      // Must still show both — the stale response is dropped, not applied,
      // regardless of it resolving last.
      expect(result.current.openProjects).toHaveLength(2);
      expect(result.current.openProjects.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    });
  });
});
