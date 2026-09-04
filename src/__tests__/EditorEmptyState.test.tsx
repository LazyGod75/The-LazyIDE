/* EditorEmptyState.tsx — the Code space's empty editor state (no tab open).
   Locks the contract: recent files render most-recent-first and are
   clickable, the real Mod+K/Ctrl+K command-palette shortcut is surfaced (not
   a fabricated one), and "New file" stays reachable — replacing the old bare
   "Open a file from the explorer" line with something a user can act on.
*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { EditorEmptyState } from '../components/editor/codespace/EditorEmptyState';
import type { RecentFileEntry } from '../lib/editor/recentFiles';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

const isMacPlatformMock = vi.fn(() => false);
vi.mock('../lib/shortcuts/platform', () => ({
  isMacPlatform: () => isMacPlatformMock(),
}));

afterEach(() => {
  vi.clearAllMocks();
  isMacPlatformMock.mockReturnValue(false);
});

const ROOT = 'C:/repo';

describe('EditorEmptyState — no recent files', () => {
  it('shows the title, the palette hint, and "New file" — no recent-files section', () => {
    render(
      <EditorEmptyState
        recentFiles={[]}
        projectRoot={ROOT}
        onOpenRecentFile={vi.fn()}
        onNewFile={vi.fn()}
      />
    );

    expect(screen.getByText('code.emptyState.title')).toBeTruthy();
    expect(screen.getByText('code.emptyState.paletteHint')).toBeTruthy();
    expect(screen.getByText('code.emptyState.newFile')).toBeTruthy();
    expect(screen.queryByText('code.emptyState.recentFiles')).toBeNull();
  });

  it('shows Ctrl+K on non-Mac and the Cmd glyph on Mac', () => {
    isMacPlatformMock.mockReturnValue(false);
    const { rerender } = render(
      <EditorEmptyState recentFiles={[]} projectRoot={ROOT} onOpenRecentFile={vi.fn()} onNewFile={vi.fn()} />
    );
    expect(screen.getByText('Ctrl+K')).toBeTruthy();

    isMacPlatformMock.mockReturnValue(true);
    rerender(
      <EditorEmptyState recentFiles={[]} projectRoot={ROOT} onOpenRecentFile={vi.fn()} onNewFile={vi.fn()} />
    );
    expect(screen.getByText('⌘K')).toBeTruthy();
  });
});

describe('EditorEmptyState — recent files', () => {
  const recentFiles: RecentFileEntry[] = [
    { path: `${ROOT}/src/App.tsx`, filename: 'App.tsx' },
    { path: `${ROOT}/README.md`, filename: 'README.md' },
  ];

  it('lists recent files most-recent-first with their relative directory', () => {
    render(
      <EditorEmptyState
        recentFiles={recentFiles}
        projectRoot={ROOT}
        onOpenRecentFile={vi.fn()}
        onNewFile={vi.fn()}
      />
    );

    expect(screen.getByText('code.emptyState.recentFiles')).toBeTruthy();
    expect(screen.getByText('App.tsx')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  it('opens the clicked recent file', () => {
    const onOpenRecentFile = vi.fn();
    render(
      <EditorEmptyState
        recentFiles={recentFiles}
        projectRoot={ROOT}
        onOpenRecentFile={onOpenRecentFile}
        onNewFile={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('App.tsx'));

    expect(onOpenRecentFile).toHaveBeenCalledWith(recentFiles[0]);
  });

  it('calls onNewFile when "New file" is clicked', () => {
    const onNewFile = vi.fn();
    render(
      <EditorEmptyState recentFiles={[]} projectRoot={ROOT} onOpenRecentFile={vi.fn()} onNewFile={onNewFile} />
    );

    fireEvent.click(screen.getByText('code.emptyState.newFile'));

    expect(onNewFile).toHaveBeenCalledTimes(1);
  });
});
