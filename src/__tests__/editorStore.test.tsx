import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { EditorStoreProvider, useEditorStore } from '../components/editor/editorStore';

function wrapper({ children }: { children: React.ReactNode }) {
  return <EditorStoreProvider>{children}</EditorStoreProvider>;
}

describe('editorStore', () => {
  it('initialises with empty tabs and no active tab', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });
    expect(result.current.tabs).toHaveLength(0);
    expect(result.current.activeTabPath).toBeNull();
  });

  it('openFile adds a tab and sets it as active', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/project/src/auth.ts', 'auth.ts', 'content');
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].path).toBe('/project/src/auth.ts');
    expect(result.current.tabs[0].filename).toBe('auth.ts');
    expect(result.current.tabs[0].content).toBe('content');
    expect(result.current.tabs[0].isDirty).toBe(false);
    expect(result.current.activeTabPath).toBe('/project/src/auth.ts');
  });

  it('openFile with existing path just switches to it (no duplicate)', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/a.ts', 'a.ts', 'A content');
      result.current.openFile('/b.ts', 'b.ts', 'B content');
    });
    act(() => {
      result.current.openFile('/a.ts', 'a.ts', 'A content'); // reopen existing
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabPath).toBe('/a.ts');
  });

  it('updateContent sets isDirty=true when content differs from savedContent', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/f.ts', 'f.ts', 'original');
    });
    act(() => {
      result.current.updateContent('/f.ts', 'modified');
    });

    const tab = result.current.tabs.find(t => t.path === '/f.ts')!;
    expect(tab.content).toBe('modified');
    expect(tab.isDirty).toBe(true);
  });

  it('updateContent sets isDirty=false when content equals savedContent', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/g.ts', 'g.ts', 'original');
    });
    act(() => {
      result.current.updateContent('/g.ts', 'modified');
    });
    act(() => {
      result.current.updateContent('/g.ts', 'original'); // back to original
    });

    const tab = result.current.tabs.find(t => t.path === '/g.ts')!;
    expect(tab.isDirty).toBe(false);
  });

  it('markSaved clears dirty flag and updates savedContent', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/h.ts', 'h.ts', 'v1');
    });
    act(() => {
      result.current.updateContent('/h.ts', 'v2');
    });
    act(() => {
      result.current.markSaved('/h.ts');
    });

    const tab = result.current.tabs.find(t => t.path === '/h.ts')!;
    expect(tab.isDirty).toBe(false);
    expect(tab.savedContent).toBe('v2');
  });

  it('setActiveTab changes active tab without affecting tab list', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/x.ts', 'x.ts', '');
      result.current.openFile('/y.ts', 'y.ts', '');
    });
    act(() => {
      result.current.setActiveTab('/x.ts');
    });

    expect(result.current.activeTabPath).toBe('/x.ts');
    expect(result.current.tabs).toHaveLength(2);
  });

  it('closeTab removes the tab from the list', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/p.ts', 'p.ts', '');
      result.current.openFile('/q.ts', 'q.ts', '');
    });
    act(() => {
      result.current.closeTab('/p.ts');
    });

    expect(result.current.tabs.map(t => t.path)).toEqual(['/q.ts']);
  });

  it('closeTab active tab activates nearest neighbour', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/a.ts', 'a.ts', '');
      result.current.openFile('/b.ts', 'b.ts', '');
      result.current.openFile('/c.ts', 'c.ts', '');
    });
    // active is now /c.ts — close it
    act(() => {
      result.current.closeTab('/c.ts');
    });

    expect(result.current.activeTabPath).toBe('/b.ts');
  });

  it('closeTab last tab results in no active tab', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/only.ts', 'only.ts', '');
    });
    act(() => {
      result.current.closeTab('/only.ts');
    });

    expect(result.current.tabs).toHaveLength(0);
    expect(result.current.activeTabPath).toBeNull();
  });

  it('updateContent does not mutate existing tab objects (immutable update)', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/imm.ts', 'imm.ts', 'v1');
    });
    const tabBefore = result.current.tabs[0];

    act(() => {
      result.current.updateContent('/imm.ts', 'v2');
    });
    const tabAfter = result.current.tabs[0];

    // Different object reference — immutable update
    expect(tabAfter).not.toBe(tabBefore);
    // Original reference not mutated
    expect(tabBefore.content).toBe('v1');
  });

  // ── Save / dirty lifecycle ─────────────────────────────────────

  it('open → edit → save clears dirty and updates savedContent', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => { result.current.openFile('/lifecycle.ts', 'lifecycle.ts', 'v1'); });
    act(() => { result.current.updateContent('/lifecycle.ts', 'v2'); });

    expect(result.current.tabs[0].isDirty).toBe(true);

    act(() => { result.current.markSaved('/lifecycle.ts'); });

    const tab = result.current.tabs.find(t => t.path === '/lifecycle.ts')!;
    expect(tab.isDirty).toBe(false);
    expect(tab.savedContent).toBe('v2');
    expect(tab.content).toBe('v2');
  });

  // ── Multi-tab open / switch / close ───────────────────────────

  it('opens multiple files in distinct tabs', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/m1.ts', 'm1.ts', 'M1');
      result.current.openFile('/m2.ts', 'm2.ts', 'M2');
      result.current.openFile('/m3.ts', 'm3.ts', 'M3');
    });

    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.activeTabPath).toBe('/m3.ts');
  });

  it('setActiveTab switches focus without altering tab list', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/t1.ts', 't1.ts', '');
      result.current.openFile('/t2.ts', 't2.ts', '');
    });
    act(() => { result.current.setActiveTab('/t1.ts'); });

    expect(result.current.activeTabPath).toBe('/t1.ts');
    expect(result.current.tabs).toHaveLength(2);
  });

  it('closeTab non-active tab does not change active path', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/n1.ts', 'n1.ts', '');
      result.current.openFile('/n2.ts', 'n2.ts', '');
    });
    act(() => { result.current.setActiveTab('/n2.ts'); });
    act(() => { result.current.closeTab('/n1.ts'); });

    expect(result.current.activeTabPath).toBe('/n2.ts');
    expect(result.current.tabs.map(t => t.path)).toEqual(['/n2.ts']);
  });

  it('closeTab dirty tab does NOT prevent close (guard is in UI layer)', () => {
    // The store itself has no confirm guard — that lives in CenterEditor.
    // Calling closeTab on a dirty tab should still close it unconditionally.
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => { result.current.openFile('/dirty.ts', 'dirty.ts', 'original'); });
    act(() => { result.current.updateContent('/dirty.ts', 'modified'); });

    expect(result.current.tabs[0].isDirty).toBe(true);

    act(() => { result.current.closeTab('/dirty.ts'); });

    expect(result.current.tabs).toHaveLength(0);
    expect(result.current.activeTabPath).toBeNull();
  });

  it('closeTab middle tab activates right neighbour', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/r1.ts', 'r1.ts', '');
      result.current.openFile('/r2.ts', 'r2.ts', '');
      result.current.openFile('/r3.ts', 'r3.ts', '');
    });
    act(() => { result.current.setActiveTab('/r2.ts'); });
    act(() => { result.current.closeTab('/r2.ts'); });

    // r2 was at index 1; right neighbour (now at index 1) is r3
    expect(result.current.activeTabPath).toBe('/r3.ts');
    expect(result.current.tabs.map(t => t.path)).toEqual(['/r1.ts', '/r3.ts']);
  });

  it('markSaved does not affect other tabs', () => {
    const { result } = renderHook(() => useEditorStore(), { wrapper });

    act(() => {
      result.current.openFile('/s1.ts', 's1.ts', 'v1');
      result.current.openFile('/s2.ts', 's2.ts', 'v1');
    });
    act(() => {
      result.current.updateContent('/s1.ts', 'v2');
      result.current.updateContent('/s2.ts', 'v2');
    });
    act(() => { result.current.markSaved('/s1.ts'); });

    const s1 = result.current.tabs.find(t => t.path === '/s1.ts')!;
    const s2 = result.current.tabs.find(t => t.path === '/s2.ts')!;
    expect(s1.isDirty).toBe(false);
    expect(s2.isDirty).toBe(true);
  });
});
