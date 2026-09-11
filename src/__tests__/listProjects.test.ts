/* listProjects.test.ts — Rules tab "Project" filter list (BrainFilters.tsx).

   Regression coverage for a real duplicate-entry bug: a project scanned via
   "Add project to brain" can be tagged in the tree both under its short
   name ("lazy-backoffice") and under a slug derived from its full path
   ("c-users-david-documents-cerveau-lazy-backoffice") — previously these
   showed up as two separate, confusing dropdown entries for the same
   project. listBrainProjects() must merge them into one entry while still
   remembering both raw slugs (rawValues) so BrainFilters can query notes
   tagged under either alias. */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, getPlatform: vi.fn(), isTauri: vi.fn(() => true) };
});

import { getPlatform, isTauri } from '../lib/platform';
import { listBrainProjects } from '../lib/brain/listProjects';

const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;
const mockIsTauri = isTauri as ReturnType<typeof vi.fn>;

function platformWithTree(projects: Array<{ id: string; label: string }>) {
  return {
    brain: {
      tree: vi.fn().mockResolvedValue({
        projects: projects.map((p) => ({ id: p.id, label: p.label, noteId: null, type: 'project', children: [] })),
      }),
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('listBrainProjects — alias dedup', () => {
  it('merges a short-name project and its full-path alias into one entry', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetPlatform.mockReturnValue(
      platformWithTree([
        { id: 'p1', label: 'lazy-backoffice' },
        { id: 'p2', label: 'C:\\Users\\user\\Documents\\cerveau\\lazy-backoffice' },
      ]),
    );

    const projects = await listBrainProjects();

    expect(projects).toHaveLength(1);
    expect(projects[0].project).toBe('lazy-backoffice');
    expect(projects[0].noteCount).toBe(2);
    expect(projects[0].rawValues.sort()).toEqual(
      ['lazy-backoffice', 'c-users-user-documents-cerveau-lazy-backoffice'].sort(),
    );
  });

  it('keeps genuinely distinct projects as separate entries', async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetPlatform.mockReturnValue(
      platformWithTree([
        { id: 'p1', label: 'lazy-real-test' },
        { id: 'p2', label: 'lazy-backoffice' },
      ]),
    );

    const projects = await listBrainProjects();

    expect(projects.map((p) => p.project).sort()).toEqual(['lazy-backoffice', 'lazy-real-test']);
  });

  it('returns an empty list outside Tauri', async () => {
    mockIsTauri.mockReturnValue(false);
    expect(await listBrainProjects()).toEqual([]);
  });
});
