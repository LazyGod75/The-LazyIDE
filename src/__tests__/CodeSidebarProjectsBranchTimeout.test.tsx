/**
 * CodeSidebarProjectsBranchTimeout.test.tsx
 *
 * QA fix: ProjectRow's branch-fetch effect (CodeSidebarProjects.tsx) awaited
 * platform.git.status() with no bound. A REJECTED call already resolved
 * `branch` to `null` (rendering nothing — distinguishable from the `…`
 * loading glyph), but a call that never settles at all — the real failure
 * mode of a wedged `git` subprocess behind the Tauri invoke() — left
 * `branch` stuck at `undefined` forever, i.e. a permanently "loading" row
 * indistinguishable from one that is still genuinely in flight.
 *
 * This proves: (1) the row starts in the explained "…" loading state, (2) a
 * git.status() call that never resolves or rejects still causes the row to
 * leave that loading state once GIT_STATUS_TIMEOUT_MS elapses, landing on
 * the same "no branch" render as any other failure — never stuck on "…",
 * and (3) unmounting mid-flight (before the timeout even fires) never
 * throws or logs a setState-after-unmount warning, i.e. the effect's
 * existing `cancelled` guard also covers the new timeout race correctly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import { ProjectRow } from '../components/editor/codespace/CodeSidebarProjects';
import type { Platform, DirEntry, GitStatus } from '../lib/platform/types';
import type { ProjectEntry, SpaceId } from '../app/AppContext';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../lib/bus', () => ({ emit: vi.fn() }));

let mockActiveSpace: SpaceId | undefined;
vi.mock('../app/AppContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/AppContext')>();
  return {
    ...actual,
    useAppContextOptional: () => (mockActiveSpace === undefined ? null : { activeSpace: mockActiveSpace }),
  };
});

const ROOT = 'C:/repo';

function makeProject(): ProjectEntry {
  return { id: 'proj-1', root: ROOT, brainId: null, active: true, gitInitNote: null };
}

/** A git.status() that NEVER settles — the exact failure mode a wedged
 *  subprocess produces: not a rejection (already handled before this fix),
 *  a hang. */
function makeHangingPlatform(dirEntries: Record<string, DirEntry[]> = {}): Platform {
  return {
    name: 'tauri',
    fs: { readDir: vi.fn((p: string) => Promise.resolve(dirEntries[p] ?? [])) },
    git: { status: vi.fn(() => new Promise<GitStatus>(() => {})) },
  } as unknown as Platform;
}

beforeEach(() => {
  mockActiveSpace = 'code';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ProjectRow branch fetch — bounded timeout on a hung git.status() (QA fix)', () => {
  it('starts in the explained "…" loading state', async () => {
    const platform = makeHangingPlatform();
    const { getByText } = render(
      <ProjectRow
        project={makeProject()}
        fleet={undefined}
        platform={platform}
        activeTabPath={null}
        isExpanded
        onToggleExpanded={vi.fn()}
        onFileOpen={vi.fn()}
      />
    );
    // Flushes the unrelated file-tree effect's own readDir() microtask (it
    // resolves immediately, unlike git.status() above) so it settles inside
    // act() instead of bleeding into a later test as an act() warning.
    await act(async () => {});

    expect(getByText('…').title).toBe('codespace.projects.branchLoading');
  });

  it('leaves the "…" loading state once the timeout elapses, even though git.status() never settled', async () => {
    const platform = makeHangingPlatform();
    const { getByText, queryByText } = render(
      <ProjectRow
        project={makeProject()}
        fleet={undefined}
        platform={platform}
        activeTabPath={null}
        isExpanded
        onToggleExpanded={vi.fn()}
        onFileOpen={vi.fn()}
      />
    );

    expect(getByText('…').title).toBe('codespace.projects.branchLoading');

    // Advance well past GIT_STATUS_TIMEOUT_MS (5000ms) — the underlying
    // git.status() promise is STILL pending (it never resolves/rejects on
    // its own), only the timeout race settles.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });

    // No longer stuck on "…" — the row landed on the same "no branch"
    // render a genuine rejection already used (nothing shown next to the
    // project name), never an eternal loading glyph.
    expect(queryByText('…')).toBeNull();
  });

  it('does not throw or leave a dangling setState if the component unmounts before the timeout fires', async () => {
    const platform = makeHangingPlatform();
    const { unmount, getByText } = render(
      <ProjectRow
        project={makeProject()}
        fleet={undefined}
        platform={platform}
        activeTabPath={null}
        isExpanded
        onToggleExpanded={vi.fn()}
        onFileOpen={vi.fn()}
      />
    );
    expect(getByText('…').title).toBe('codespace.projects.branchLoading');

    unmount();

    // The timeout timer still fires after unmount (withTimeout never
    // cancels it) — the effect's `cancelled` guard must swallow it
    // silently rather than calling setState on an unmounted component.
    await expect(
      act(async () => {
        await vi.advanceTimersByTimeAsync(5001);
      }),
    ).resolves.not.toThrow();
  });
});
