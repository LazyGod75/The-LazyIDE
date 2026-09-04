/* CommandPaletteI18n.test.tsx — regression test for raw i18n keys leaking
   into the command palette's rendered UI.

   ROOT CAUSE (2026-08-14, seen live in the packaged app): CommandPalette.tsx,
   PaletteRow.tsx and paletteItems.ts all call t('palette.section.*'),
   t('palette.kind.*'), t('palette.command.goTo*' / 'openFolder' / 'newMission'
   / 'newTerminal' / 'newFile' / 'renameFile' / 'formatDocument') and
   t('palette.hint.*') — but none of those keys existed in ANY of the 6
   locale dictionaries (src/i18n/locales/*.ts). i18n/index.tsx's t() falls
   back to returning the raw key string when a key is missing from both the
   active locale and the fr fallback (see its `resolved ?? key` line), so
   every row rendered its dotted key path instead of real text — and the
   section header's CSS `textTransform: uppercase` (CommandPalette.tsx's
   STYLES.sectionLabel) turned "palette.section.files" into
   "PALETTE.SECTION.FILES", exactly as reported.

   This test renders the real palette (all surrounding app contexts stubbed,
   same convention as CommandPaletteBrainRace.test.tsx) and asserts:
     1. Known-good English strings appear for the previously-broken keys.
     2. No visible palette text matches a bare dotted-key pattern, in both
        English and the French default locale — the mechanical guard this
        whole bug class is checked with (same convention as
        RulesPanelI18nEnglish.test.tsx / HealthPanelI18nEnglish.test.tsx).
     3. A Windows extended-length `\\?\` path prefix returned by the (mocked)
        Tauri `read_dir` command never reaches the rendered file hint —
        paletteItems.ts's buildFileItems() now runs it through
        stripVerbatimPrefix() (src/lib/paths.ts) before using it as display
        text.
*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { CommandPalette } from '../components/palette/CommandPalette';

// A bare dotted i18n key rendered as visible text, e.g. "palette.kind.file".
// Section headers additionally apply CSS text-transform: uppercase (visual
// only — it never changes the underlying textContent), so the DOM text for
// the reported "PALETTE.SECTION.FILES" bug is still this lowercase shape.
const KEY_LIKE_PATTERN = /^[a-z]+(\.[a-zA-Z]+){2,}$/;

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, getPlatform: vi.fn() };
});

vi.mock('../app/AppContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/AppContext')>();
  return {
    ...actual,
    useAppContext: () => ({
      setActiveSpace: vi.fn(),
      openProject: vi.fn(),
      projectRoot: 'C:\\Users\\user\\Documents\\cerveau\\scratchpad\\uc-smoke-b',
      // Deliberately empty: this file's path-hint test exercises the "no
      // owning project registered" branch of buildFileItems (paletteItems.ts)
      // — see CommandPalettePathDisplay.test.tsx for the project-relative
      // branch (a matching entry here).
      openProjects: [],
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

// Windows extended-length ("verbatim") path, exactly the shape
// `std::fs::canonicalize()` produces on the Rust side — literal runtime
// value `\\?\C:\Users\user\...\app.js`.
const RAW_VERBATIM_PATH = '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\scratchpad\\uc-smoke-b\\app.js';
const EXPECTED_STRIPPED_PATH = 'C:\\Users\\user\\Documents\\cerveau\\scratchpad\\uc-smoke-b\\app.js';

function mockTauriPlatform() {
  mockGetPlatform.mockReturnValue({
    name: 'tauri',
    fs: {
      readDir: vi.fn(async () => [
        { name: 'app.js', path: RAW_VERBATIM_PATH, isDir: false },
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

describe('CommandPalette i18n — no raw keys, no leaked \\\\?\\ paths', () => {
  it('renders real English copy for section headers, kind badges, nav commands and hints', async () => {
    localStorage.setItem('lazy.locale', 'en');
    mockTauriPlatform();

    render(
      <I18nProvider>
        <CommandPalette isOpen={true} onClose={vi.fn()} />
      </I18nProvider>,
    );

    // Section headers (previously rendered as "PALETTE.SECTION.FILES" etc.
    // via CommandPalette.tsx's uppercase-transformed sectionLabel style).
    expect(await screen.findByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Commands')).toBeInTheDocument();
    // "Brain" and "Agents" also appear as a kind badge / hint chip elsewhere
    // in the list (e.g. the always-present "ask brain" and "launch agent"
    // rows), so more than one match is expected here.
    expect(screen.getAllByText('Brain').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Agents').length).toBeGreaterThan(0);

    // Nav commands (previously "palette.command.goToHome" etc.) — this is
    // exactly the set of 8 command rows that fit the palette's slice(0, 8)
    // cap with an empty query, matching the live bug report.
    expect(screen.getByText('Go to: Home')).toBeInTheDocument();
    expect(screen.getByText('Go to: Code')).toBeInTheDocument();
    expect(screen.getByText('Go to: Agents')).toBeInTheDocument();
    expect(screen.getByText('Go to: Brain')).toBeInTheDocument();
    expect(screen.getByText('Go to: Terminals')).toBeInTheDocument();
    expect(screen.getByText('Go to: Models')).toBeInTheDocument();
    expect(screen.getByText('Go to: Settings')).toBeInTheDocument();
    expect(screen.getByText('Open folder')).toBeInTheDocument();

    // Kind badges (previously "palette.kind.command" / "palette.kind.file").
    expect(screen.getAllByText('Command').length).toBeGreaterThan(0);
    expect(screen.getAllByText('File').length).toBeGreaterThan(0);
  });

  it.each(['en', 'fr'] as const)(
    'never renders a bare dotted i18n key as visible text (locale=%s)',
    async (locale) => {
      localStorage.setItem('lazy.locale', locale);
      mockTauriPlatform();

      render(
        <I18nProvider>
          <CommandPalette isOpen={true} onClose={vi.fn()} />
        </I18nProvider>,
      );

      // Let the real-file effect settle so file rows (with their hint path)
      // are in the DOM too before scanning for leaks.
      await screen.findByText('app.js');

      const leaked = screen.queryAllByText(KEY_LIKE_PATTERN);
      const leakedText = leaked.map((el) => el.textContent);
      expect(leakedText).toEqual([]);
    },
  );

  it('degrades gracefully (stripped absolute path, no leaked \\\\?\\) when the file is outside every open project', async () => {
    localStorage.setItem('lazy.locale', 'en');
    mockTauriPlatform();

    const { container } = render(
      <I18nProvider>
        <CommandPalette isOpen={true} onClose={vi.fn()} />
      </I18nProvider>,
    );

    // openProjects is [] in this file's mock (see the AppContext mock above),
    // so buildFileItems (paletteItems.ts) finds no owning project and falls
    // back to the stripped absolute path rather than a project-relative one.
    expect(await screen.findByText('app.js')).toBeInTheDocument();
    expect(screen.getByText(EXPECTED_STRIPPED_PATH)).toBeInTheDocument();
    // Full path stays discoverable as the row's title/tooltip either way.
    expect(screen.getByTitle(EXPECTED_STRIPPED_PATH)).toBeInTheDocument();

    // The raw verbatim prefix must not appear anywhere in the rendered DOM.
    expect(container.innerHTML).not.toContain('\\\\?\\');
    expect(container.innerHTML).not.toContain(RAW_VERBATIM_PATH);
  });
});
