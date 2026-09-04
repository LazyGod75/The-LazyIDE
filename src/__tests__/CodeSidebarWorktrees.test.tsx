import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { CodeSidebarWorktrees } from '../components/editor/codespace/CodeSidebarWorktrees';
import type { Platform } from '../lib/platform/types';

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

function makeWebPlatform(): Platform {
  return { name: 'web' } as unknown as Platform;
}

// B19: the "WORKTREES —" sidebar header used to render the raw project
// registry id/hash (e.g. a long journal projectId string). It must show the
// project's friendly display name (basename of its root) instead.
describe('CodeSidebarWorktrees — B19 friendly project name', () => {
  it('renders the basename of projectRoot in the header, never the raw path or a hash', () => {
    render(
      <CodeSidebarWorktrees
        projectRoot="C:\\Users\\user\\Documents\\demo-shop"
        platform={makeWebPlatform()}
        missions={[]}
        onOpenDiff={vi.fn()}
      />
    );

    expect(screen.getByText(/codespace\.worktrees\.title — demo-shop/)).toBeInTheDocument();
    expect(screen.queryByText(/C:\\Users\\user/)).not.toBeInTheDocument();
  });

  it('falls back to the raw root when it has no separator (already a bare name)', () => {
    render(
      <CodeSidebarWorktrees
        projectRoot="demo-shop"
        platform={makeWebPlatform()}
        missions={[]}
        onOpenDiff={vi.fn()}
      />
    );

    expect(screen.getByText(/codespace\.worktrees\.title — demo-shop/)).toBeInTheDocument();
  });
});
