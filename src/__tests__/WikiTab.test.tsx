/* WikiTab.test.tsx — the Brain Wiki reader (tree + page).

   Covers the contract: renders the topic hierarchy, shows the default
   brain-index synthesis page, opens an individual note through the reused
   BrainWiki renderer, handles the empty (no-synthesis) state, and navigates
   in-view when a `#/{slug}` wiki link inside a page is clicked. Uses the real
   WikiTree / WikiPage / BrainWiki components with a controlled platform mock
   (same getPlatform-override pattern as BrainSpace.test.tsx). */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { WikiTab } from '../components/brain/WikiTab';
import { en } from '../i18n/locales/en';

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, getPlatform: vi.fn() };
});

import { getPlatform } from '../lib/platform';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

const TREE = {
  projects: [
    {
      id: 'demo',
      label: 'demo',
      noteId: 'demo',
      type: 'project',
      children: [
        {
          id: 'agg-auth',
          label: 'auth',
          noteId: 'agg-auth',
          type: 'aggregate-neuron',
          children: [
            { id: 'auth.ts', label: 'auth.ts', noteId: 'auth.ts', type: 'file-neuron', children: [] },
          ],
        },
      ],
    },
  ],
};

const INDEX = {
  html:
    '<article data-cerveau-type="brain-index"><header class="wiki-header"><h1>Demo brain</h1></header>' +
    '<section id="topics"><h2>Topics</h2>' +
    '<section class="wiki-section" id="project-overview"><h2><a href="#/overview" class="section-link">Overview</a></h2></section>' +
    '</section></article>',
  pages: [{ slug: 'overview', title: 'Overview' }],
};

function noteMeta(id: string) {
  return {
    id,
    title: `Note ${id}`,
    type: 'decision',
    topic: 'auth',
    tags: '',
    importance: 0.5,
    created: '2026-01-01T00:00:00Z',
    conflictWith: [],
    saliencyKind: null,
  };
}

function makePlatform(overrides: Record<string, unknown> = {}) {
  return {
    name: 'web',
    brain: {
      tree: vi.fn().mockResolvedValue(TREE),
      synthesisIndex: vi.fn().mockResolvedValue(INDEX),
      synthesisTopic: vi.fn().mockResolvedValue(null),
      note: vi.fn().mockImplementation((id: string) => Promise.resolve(noteMeta(id))),
      noteHtml: vi.fn().mockResolvedValue(null),
      // "What links here" — empty by default; individual tests override to
      // exercise the backlinks strip (see "WikiTab — backlinks" below).
      backlinks: vi.fn().mockResolvedValue([]),
      ...overrides,
    },
  };
}

function renderWiki(platform: ReturnType<typeof makePlatform>) {
  mockGetPlatform.mockReturnValue(platform);
  render(
    <I18nProvider>
      <WikiTab />
    </I18nProvider>,
  );
  return platform;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WikiTab — hierarchy + default page', () => {
  it('renders the topic hierarchy in the sidebar', async () => {
    renderWiki(makePlatform());
    expect(await screen.findByText('demo')).toBeInTheDocument();
    expect(screen.getByText('auth')).toBeInTheDocument();
  });

  it('shows the brain-index synthesis page by default', async () => {
    renderWiki(makePlatform());
    // The synthesized HTML (rendered sanitized) exposes its <h1> title.
    expect(await screen.findByText('Demo brain')).toBeInTheDocument();
  });
});

describe('WikiTab — note view via reused BrainWiki', () => {
  it('opens a note through BrainWiki when a tree node is clicked', async () => {
    const platform = renderWiki(makePlatform());
    // Wait for the default page, then click the "auth" module node.
    await screen.findByText('Demo brain');
    fireEvent.click(screen.getByText('auth'));

    // BrainWiki renders the note's title + its own "Liens" section header.
    expect(await screen.findByText('Note agg-auth')).toBeInTheDocument();
    expect(screen.getByText(en['brain.wiki.linksSection'])).toBeInTheDocument();
    expect(platform.brain.note).toHaveBeenCalledWith('agg-auth');
  });

  it('renders full note HTML when noteHtml returns content', async () => {
    const platform = renderWiki(
      makePlatform({
        noteHtml: vi.fn().mockResolvedValue(
          '<article data-cerveau-type="file-neuron"><h2>auth.ts</h2><p>Full note body from sidecar.</p></article>',
        ),
      }),
    );
    await screen.findByText('Demo brain');
    fireEvent.click(screen.getByText('auth'));

    // The full HTML body text renders, not the minimal BrainWiki panel.
    expect(await screen.findByText('Full note body from sidecar.')).toBeInTheDocument();
    expect(platform.brain.noteHtml).toHaveBeenCalledWith('agg-auth');
  });
});

describe('WikiTab — backlinks ("what links here")', () => {
  it('resolves backlink titles and navigates to the target note when one is clicked', async () => {
    const platform = renderWiki(
      makePlatform({
        backlinks: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'agg-auth' ? ['file-other-note'] : []),
        ),
      }),
    );
    await screen.findByText('Demo brain');
    fireEvent.click(screen.getByText('auth'));

    // BrainWiki panel for agg-auth (noteHtml() is null by default -> 'note'
    // fallback kind) plus the backlinks strip, title resolved via note().
    expect(await screen.findByText('Note agg-auth')).toBeInTheDocument();
    expect(await screen.findByText(en['brain.wikiBacklinks'])).toBeInTheDocument();

    fireEvent.click(screen.getByText('Note file-other-note'));
    await waitFor(() => expect(platform.brain.note).toHaveBeenCalledWith('file-other-note'));
  });

  it('renders no backlinks section for a note with no incoming links', async () => {
    renderWiki(makePlatform()); // default backlinks() -> []
    await screen.findByText('Demo brain');
    fireEvent.click(screen.getByText('auth'));

    expect(await screen.findByText('Note agg-auth')).toBeInTheDocument();
    expect(screen.queryByText(en['brain.wikiBacklinks'])).not.toBeInTheDocument();
  });

  it('caps resolved titles at 20 and surfaces the remainder as a "+N more" count', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `note-${i}`);
    renderWiki(
      makePlatform({
        backlinks: vi.fn().mockImplementation((id: string) =>
          Promise.resolve(id === 'agg-auth' ? ids : []),
        ),
      }),
    );
    await screen.findByText('Demo brain');
    fireEvent.click(screen.getByText('auth'));

    expect(await screen.findByText('Note note-0')).toBeInTheDocument();
    expect(screen.queryByText('Note note-20')).not.toBeInTheDocument();
    expect(screen.getByText(en['brain.wikiBacklinksMore'].replace('{count}', '5'))).toBeInTheDocument();
  });
});

describe('WikiTab — empty state', () => {
  it('shows the "no synthesis pages yet" message when there is no brain-index', async () => {
    renderWiki(
      makePlatform({
        synthesisIndex: vi.fn().mockResolvedValue(null),
        tree: vi.fn().mockResolvedValue({ projects: [] }),
      }),
    );
    expect(await screen.findByText(/No synthesis pages yet/)).toBeInTheDocument();
  });

  it('still renders the topic hierarchy in the sidebar when synthesisIndex is null but the tree is populated', async () => {
    // Fresh brain: notes have been indexed (tree() returns the
    // project→module→file hierarchy) but no `dream --synthesize` has run yet
    // (synthesisIndex() === null). The tree is decoupled from synthesis, so
    // the sidebar must still be navigable instead of blank.
    renderWiki(
      makePlatform({
        synthesisIndex: vi.fn().mockResolvedValue(null),
        // tree left at its populated default (TREE).
      }),
    );

    // Left sidebar: the hierarchy from tree() renders…
    expect(await screen.findByText('demo')).toBeInTheDocument();
    expect(screen.getByText('auth')).toBeInTheDocument();
    // …while the run-consolidation hint stays scoped to the page area only.
    expect(screen.getByText(/No synthesis pages yet/)).toBeInTheDocument();
  });

  it('does not crash when the tree and synthesis both fail', async () => {
    renderWiki(
      makePlatform({
        tree: vi.fn().mockRejectedValue(new Error('sidecar down')),
        synthesisIndex: vi.fn().mockRejectedValue(new Error('sidecar down')),
      }),
    );
    expect(await screen.findByText(/No synthesis pages yet/)).toBeInTheDocument();
  });
});

describe('WikiTab — independent tree/index loading (W2.10)', () => {
  it('populates the tree once a slow-but-eventually-resolving tree() settles', async () => {
    // tree() takes a little while (well within SIDECAR_TIMEOUT_MS) instead
    // of resolving immediately — the sidebar must still end up populated,
    // not stuck blank because synthesisIndex() already settled first.
    renderWiki(
      makePlatform({
        tree: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(TREE), 20)),
        ),
      }),
    );
    expect(await screen.findByText('demo')).toBeInTheDocument();
    expect(screen.getByText('auth')).toBeInTheDocument();
  });

  it('still renders the populated tree when synthesisIndex() fails outright', async () => {
    // A failing (not just null-resolving) synthesisIndex() must not blank
    // the tree — the two calls are independent (Promise.allSettled), so the
    // sidebar renders from tree() regardless of the page pane's fate.
    renderWiki(
      makePlatform({
        synthesisIndex: vi.fn().mockRejectedValue(new Error('sidecar error')),
        // tree left at its populated default (TREE).
      }),
    );
    expect(await screen.findByText('demo')).toBeInTheDocument();
    expect(screen.getByText('auth')).toBeInTheDocument();
    expect(screen.getByText(/No synthesis pages yet/)).toBeInTheDocument();
  });
});

describe('WikiTab — in-page wiki link navigation', () => {
  it('loads a note in-view when a #/{slug} link is clicked (topic → note fallback)', async () => {
    const platform = renderWiki(makePlatform());
    // Default brain-index page carries a `#/overview` section link.
    const link = await screen.findByText('Overview');
    fireEvent.click(link);

    // synthesisTopic('overview') resolves null → falls back to the note.
    await waitFor(() => expect(platform.brain.synthesisTopic).toHaveBeenCalledWith('overview'));
    expect(await screen.findByText('Note overview')).toBeInTheDocument();
  });

  it('renders a topic-overview page when a #/{slug} link has synthesis', async () => {
    const platform = renderWiki(
      makePlatform({
        synthesisTopic: vi.fn().mockResolvedValue(
          '<article data-cerveau-type="topic-overview"><header class="wiki-header"><h1>Overview page</h1></header></article>',
        ),
      }),
    );
    fireEvent.click(await screen.findByText('Overview'));

    await waitFor(() => expect(platform.brain.synthesisTopic).toHaveBeenCalledWith('overview'));
    expect(await screen.findByText('Overview page')).toBeInTheDocument();
  });
});

describe('WikiTab — back navigation', () => {
  it('hides the Back affordance until a navigation has happened', async () => {
    renderWiki(makePlatform());
    await screen.findByText('Demo brain');
    expect(screen.queryByText('Back')).toBeNull();
  });

  it('returns to the previous page when Back is clicked after following a link', async () => {
    renderWiki(makePlatform());
    await screen.findByText('Demo brain');

    // Navigate: click the "auth" tree node (module -> note).
    fireEvent.click(screen.getByText('auth'));
    expect(await screen.findByText('Note agg-auth')).toBeInTheDocument();

    // Back is now available and restores the previous page (brain-index).
    const backButton = await screen.findByText('Back');
    fireEvent.click(backButton);
    expect(await screen.findByText('Demo brain')).toBeInTheDocument();
  });

  it('supports multiple hops back through a chain of navigations', async () => {
    const platform = renderWiki(makePlatform());
    await screen.findByText('Demo brain');

    // Home -> auth note -> Overview link (topic -> note fallback).
    fireEvent.click(screen.getByText('auth'));
    expect(await screen.findByText('Note agg-auth')).toBeInTheDocument();

    // Note agg-auth doesn't carry an Overview link itself, so go straight to
    // Home and back again to build up two hops of real history.
    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Demo brain')).toBeInTheDocument();

    fireEvent.click(screen.getByText('auth'));
    expect(await screen.findByText('Note agg-auth')).toBeInTheDocument();
    await waitFor(() => expect(platform.brain.note).toHaveBeenCalledWith('agg-auth'));

    fireEvent.click(screen.getByText('Back'));
    expect(await screen.findByText('Demo brain')).toBeInTheDocument();
    // Fully unwound: Back is hidden again.
    expect(screen.queryByText('Back')).toBeNull();
  });
});
