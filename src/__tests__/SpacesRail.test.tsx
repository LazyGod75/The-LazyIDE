/**
 * Tests for SpacesRail.tsx's ProjectItemButton tooltip (FIX): the tooltip
 * previously showed the raw project.root directly via
 * data-tooltip={project.root} — including its Windows \\?\ verbatim prefix
 * when present (the common case; see paths.ts's header for why worktree/
 * project roots arrive verbatim-prefixed on Windows). Fixed to strip the
 * prefix for DISPLAY ONLY via stripVerbatimPrefix (paths.ts) — the
 * underlying project.root value (used for routing/onClick elsewhere) is
 * never touched.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectItemButton } from '../components/SpacesRail';
import type { ProjectEntry } from '../app/AppContext';

function makeProject(root: string): ProjectEntry {
  return { id: 'proj-1', root, brainId: null, active: true, gitInitNote: null };
}

describe('SpacesRail — ProjectItemButton tooltip', () => {
  it('strips the Windows \\\\?\\ verbatim prefix from the tooltip, display-only', () => {
    const project = makeProject(String.raw`\\?\C:\Users\dev\repo`);
    render(
      <ProjectItemButton project={project} isActive={false} hasRunning={false} onClick={vi.fn()} />,
    );

    const button = screen.getByRole('button');
    expect(button.getAttribute('data-tooltip')).toBe(String.raw`C:\Users\dev\repo`);
    // The underlying project entry itself must stay verbatim-prefixed —
    // only the tooltip's display value is stripped.
    expect(project.root).toBe(String.raw`\\?\C:\Users\dev\repo`);
  });

  it('is a no-op for a project root with no verbatim prefix', () => {
    const project = makeProject('/tmp/repo');
    render(
      <ProjectItemButton project={project} isActive={false} hasRunning={false} onClick={vi.fn()} />,
    );

    const button = screen.getByRole('button');
    expect(button.getAttribute('data-tooltip')).toBe('/tmp/repo');
  });
});
