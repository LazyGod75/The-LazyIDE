import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { ProjectRow } from '../components/editor/codespace/CodeSidebarProjects';
import type { Platform, DirEntry } from '../lib/platform/types';
import type { ProjectEntry } from '../app/AppContext';

// B23: CodeSidebarProjects.tsx is the tree ACTUALLY rendered in the live
// Code space (CodeSidebar.tsx -> CodeSidebarProjects -> ProjectRow ->
// FileRow) — unlike FileExplorer.tsx, which has its own working context
// menu but is never imported anywhere (dead code since the multi-project
// redesign). This exercises the real context menu wired here: real
// createFile/createDir/rename/remove calls, honest failure toasts, and —
// the specific bug this suite regression-tests — a NESTED rename must use
// the nested parent path, not silently fall back to the project root.

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

const toastSpy = vi.fn();
vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const emitSpy = vi.fn();
vi.mock('../lib/bus', () => ({
  emit: (...args: unknown[]) => emitSpy(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const ROOT = 'C:/repo';

function makeProject(): ProjectEntry {
  return { id: 'proj-1', root: ROOT, brainId: null, active: true, gitInitNote: null };
}

function makePlatform(dirEntries: Record<string, DirEntry[]>, overrides: Partial<Platform> = {}): Platform {
  return {
    name: 'web', // skips the git-status polling effect entirely (not under test)
    fs: {
      readDir: vi.fn((p: string) => Promise.resolve(dirEntries[p] ?? [])),
      createFile: vi.fn().mockResolvedValue(undefined),
      createDir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    git: { status: vi.fn() },
    ...overrides,
  } as unknown as Platform;
}

function baseTree(): Record<string, DirEntry[]> {
  return {
    [ROOT]: [
      { name: 'src', path: `${ROOT}/src`, isDir: true },
      { name: 'a.ts', path: `${ROOT}/a.ts`, isDir: false },
    ],
    [`${ROOT}/src`]: [
      { name: 'nested.ts', path: `${ROOT}/src/nested.ts`, isDir: false },
    ],
  };
}

function renderRow(platform: Platform, onFileOpen = vi.fn()) {
  return render(
    <ProjectRow
      project={makeProject()}
      fleet={undefined}
      platform={platform}
      activeTabPath={null}
      isExpanded
      onToggleExpanded={vi.fn()}
      onFileOpen={onFileOpen}
    />
  );
}

describe('CodeSidebarProjects — B23 real context menu (live tree)', () => {
  it('right-click on a directory shows New file / New folder / Rename / Delete', async () => {
    const platform = makePlatform(baseTree());
    renderRow(platform);
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('src'));

    expect(screen.getByText('fileExplorer.newFile')).toBeInTheDocument();
    expect(screen.getByText('fileExplorer.newFolder')).toBeInTheDocument();
    expect(screen.getByText('fileExplorer.rename')).toBeInTheDocument();
    expect(screen.getByText('common.delete')).toBeInTheDocument();
  });

  it('right-click on a file shows only Rename / Delete (no New file/folder)', async () => {
    const platform = makePlatform(baseTree());
    renderRow(platform);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('a.ts'));

    expect(screen.queryByText('fileExplorer.newFile')).not.toBeInTheDocument();
    expect(screen.queryByText('fileExplorer.newFolder')).not.toBeInTheDocument();
    expect(screen.getByText('fileExplorer.rename')).toBeInTheDocument();
    expect(screen.getByText('common.delete')).toBeInTheDocument();
  });

  it('New file at the project root calls fs.createFile with the joined path and refreshes the tree', async () => {
    const platform = makePlatform(baseTree());
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('new.ts');
    renderRow(platform);
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('src'));
    fireEvent.click(screen.getByText('fileExplorer.newFile'));

    await waitFor(() => expect(platform.fs.createFile).toHaveBeenCalledWith(`${ROOT}/src/new.ts`));
    expect(emitSpy).toHaveBeenCalledWith('fs:changed', undefined);
    promptSpy.mockRestore();
  });

  it('renaming a ROOT-level file calls fs.rename with the root-joined path', async () => {
    const platform = makePlatform(baseTree());
    renderRow(platform);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('a.ts'));
    fireEvent.click(screen.getByText('fileExplorer.rename'));

    const input = screen.getByDisplayValue('a.ts');
    fireEvent.change(input, { target: { value: 'renamed.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(platform.fs.rename).toHaveBeenCalledWith(`${ROOT}/a.ts`, `${ROOT}/renamed.ts`));
  });

  it('renaming a NESTED file uses the nested parent path, not the project root (regression: contextMenu is cleared by the time rename commits)', async () => {
    const platform = makePlatform(baseTree());
    renderRow(platform);

    // Expand src/ to reveal nested.ts
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(screen.getByText('nested.ts')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('nested.ts'));
    fireEvent.click(screen.getByText('fileExplorer.rename'));

    const input = screen.getByDisplayValue('nested.ts');
    fireEvent.change(input, { target: { value: 'renamed-nested.ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(platform.fs.rename).toHaveBeenCalledWith(
      `${ROOT}/src/nested.ts`,
      `${ROOT}/src/renamed-nested.ts`,
    ));
    // The buggy version would have called rename(..., `${ROOT}/renamed-nested.ts`) instead.
    expect(platform.fs.rename).not.toHaveBeenCalledWith(`${ROOT}/src/nested.ts`, `${ROOT}/renamed-nested.ts`.replace('src/', ''));
  });

  it('pressing Escape while renaming cancels without calling fs.rename', async () => {
    const platform = makePlatform(baseTree());
    renderRow(platform);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('a.ts'));
    fireEvent.click(screen.getByText('fileExplorer.rename'));

    const input = screen.getByDisplayValue('a.ts');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(platform.fs.rename).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
  });

  it('Delete asks for confirmation and calls fs.remove only when confirmed', async () => {
    const platform = makePlatform(baseTree());
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderRow(platform);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('a.ts'));
    fireEvent.click(screen.getByText('common.delete'));

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(platform.fs.remove).toHaveBeenCalledWith(`${ROOT}/a.ts`));
    confirmSpy.mockRestore();
  });

  it('Delete does nothing when the confirmation is declined', async () => {
    const platform = makePlatform(baseTree());
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderRow(platform);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('a.ts'));
    fireEvent.click(screen.getByText('common.delete'));

    expect(confirmSpy).toHaveBeenCalled();
    expect(platform.fs.remove).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('toasts an honest failure message when createFile rejects (never a fake success)', async () => {
    const platform = makePlatform(baseTree(), {
      fs: {
        readDir: vi.fn((p: string) => Promise.resolve(baseTree()[p] ?? [])),
        createFile: vi.fn().mockRejectedValue(new Error('disk full')),
        createDir: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn(),
      },
    } as never);
    vi.spyOn(window, 'prompt').mockReturnValue('new.ts');
    renderRow(platform);
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByText('src'));
    fireEvent.click(screen.getByText('fileExplorer.newFile'));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(
      expect.stringMatching(/code\.palette\.newFileFailed:.*disk full/),
      'error',
    ));
  });
});
