/* CommandPalettePathDisplay.test.tsx — regression coverage for the palette
   QA report (2026-08-15, live in the running app):

   1. Every file row rendered its FULL absolute path (e.g.
      "C:\Users\user\Documents\cerveau\LazySite-internet\docs\CAPABILITIES.md"),
      noisy and exposing the user's home-directory layout. Fixed the same way
      BreadcrumbBar.tsx's breadcrumb was (commit 39dba51): buildFileItems
      (paletteItems.ts) now renders a project-relative hint — project name
      first (findOwningProject, projectForPath.ts; relativeToRoot,
      fileTree.ts) — falling back to the stripped absolute path only when the
      file isn't owned by any open project (covered by
      CommandPaletteI18n.test.tsx's "degrades gracefully" case). The full
      path stays discoverable via the row's `title` attribute either way.

   2. Command rows mixed real emoji (Brain: brain, Open folder: folder) with
      typographic glyphs. Fixed in paletteItems.ts's buildCommandItems by
      reusing icons.tsx's drawn icon components for the "Aller à :" nav rows
      and falling back to a typographic glyph (no emoji) for "Open folder",
      which has no icons.tsx equivalent.

   Same rendering setup (all surrounding app contexts stubbed) as
   CommandPaletteI18n.test.tsx / CommandPaletteBrainRace.test.tsx.
*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { CommandPalette } from '../components/palette/CommandPalette';

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, getPlatform: vi.fn() };
});

const PROJECT_ROOT = 'C:\\Users\\user\\Documents\\cerveau\\demo-project';
const FILE_PATH = `${PROJECT_ROOT}\\src\\index.ts`;

vi.mock('../app/AppContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/AppContext')>();
  return {
    ...actual,
    useAppContext: () => ({
      setActiveSpace: vi.fn(),
      openProject: vi.fn(),
      projectRoot: PROJECT_ROOT,
      // A file under this root now resolves to a project-relative hint —
      // see findOwningProject (projectForPath.ts).
      openProjects: [{ id: 'demo-project', root: PROJECT_ROOT }],
    }),
  };
});

vi.mock('../components/editor/editorStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/editor/editorStore')>();
  return { ...actual, useEditorStore: () => ({ openFile: vi.fn(), tabs: [] }) };
});

vi.mock('../components/agents/agentsUiContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents/agentsUiContext')>();
  return { ...actual, useAgentsUiContext: () => ({ requestNewMission: vi.fn() }) };
});

vi.mock('../lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/billing')>();
  return { ...actual, useSubscriptionContext: () => ({ isPro: false, isProPlus: false }) };
});

vi.mock('../components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ui')>();
  return { ...actual, useToast: () => ({ toast: vi.fn() }) };
});

import { getPlatform } from '../lib/platform';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

function mockTauriPlatform() {
  mockGetPlatform.mockReturnValue({
    name: 'tauri',
    fs: {
      readDir: vi.fn(async () => [
        { name: 'index.ts', path: FILE_PATH, isDir: false },
      ]),
      readFile: vi.fn(async () => ''),
    },
    brain: { search: vi.fn(async () => []) },
  });
}

// jsdom does not implement scrollIntoView; CommandPalette calls it to keep
// the highlighted row in view whenever the item list changes.
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem('lazy.locale');
});

describe('CommandPalette — project-relative file paths, no emoji', () => {
  it('renders a project-relative hint (project name first) for a file inside a known project', async () => {
    localStorage.setItem('lazy.locale', 'en');
    mockTauriPlatform();

    render(
      <I18nProvider>
        <CommandPalette isOpen={true} onClose={vi.fn()} />
      </I18nProvider>,
    );

    expect(await screen.findByText('index.ts')).toBeInTheDocument();
    // Project-relative, project name first (VS Code convention) — not the
    // raw absolute path.
    expect(screen.getByText('demo-project/src/index.ts')).toBeInTheDocument();
    // The full absolute path must never render as visible row text...
    expect(screen.queryByText(FILE_PATH)).not.toBeInTheDocument();
    // ...but stays discoverable as the row's title/tooltip.
    expect(screen.getByTitle(FILE_PATH)).toBeInTheDocument();
  });

  it('never renders an emoji anywhere in the palette', async () => {
    localStorage.setItem('lazy.locale', 'en');
    mockTauriPlatform();

    const { container } = render(
      <I18nProvider>
        <CommandPalette isOpen={true} onClose={vi.fn()} />
      </I18nProvider>,
    );

    // Let the real-file effect settle so file rows are in the DOM too.
    await screen.findByText('index.ts');

    // Broad emoji/pictograph sweep (previously matched the Brain "\u{1F9E0}"
    // and Open-folder "\u{1F4C2}" command icons) over the palette's own
    // chrome text — app-authored labels/icons/hints only, no file content
    // is ever rendered inside the palette itself.
    const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
    expect(EMOJI_PATTERN.test(container.textContent ?? '')).toBe(false);
  });
});
