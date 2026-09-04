/* WikiPage.test.tsx — click-routing contract for the Wiki article view.

   Focuses on the bare `#<id>` disambiguation: real LazyBrain-engine note
   HTML uses the identical `#<id>` (no leading slash) syntax for two
   different things — genuine same-page anchors (TOC entries, `#see-also`)
   and cross-note references (the auto-linker's "mentions" links from
   engine/src/graph/entities.ts, and "[source]" conversation-provenance
   links). WikiPage must disambiguate by DOM lookup at click time: found on
   the current page -> scroll; not found -> it names another note ->
   navigate. Also covers `#/wiki/<id>`, `#/file:<path>`, and `#/<slug>`
   routing, which were already correct but previously untested. */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { WikiPage, type WikiEntry } from '../components/brain/WikiPage';
import { en } from '../i18n/locales/en';

// Mock the event bus so emit() calls are observable without touching Tauri
// (same convention as BrainWiki.test.tsx).
vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

import { emit } from '../lib/bus';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// jsdom does not implement scrollIntoView (same stub as
// MissionDetailTranscript.test.tsx / MessageList.test.tsx).
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(entry: WikiEntry) {
  const onOpenWikiLink = vi.fn();
  render(
    <I18nProvider>
      <WikiPage
        entry={entry}
        loading={false}
        emptyMessage={null}
        notFound={false}
        onOpenWikiLink={onOpenWikiLink}
      />
    </I18nProvider>,
  );
  return { onOpenWikiLink };
}

function noteHtmlEntry(html: string): WikiEntry {
  return { kind: 'note-html', noteId: 'note-a', title: 'Note A', html };
}

describe('WikiPage — bare `#<id>` link disambiguation', () => {
  it('navigates to the referenced note when the bare-hash id has no matching in-page element (auto-linker "mentions" format)', () => {
    // Real format emitted by engine/src/graph/entities.ts applyAutoLinks,
    // confirmed by running `lazybrain graph` on a disposable test brain.
    renderPage(
      noteHtmlEntry(
        '<p>See <a href="#learning-retirer-les-mentions-github-du-copy-closed-source-2026-07-07" ' +
          'data-cerveau-link-type="mentions" data-cerveau-link-auto="1">Agent</a> stalled.</p>',
      ),
    );

    fireEvent.click(screen.getByText('Agent'));

    expect(mockEmit).toHaveBeenCalledWith(
      'nav:focusBrainNode',
      'learning-retirer-les-mentions-github-du-copy-closed-source-2026-07-07',
    );
  });

  it('navigates to the referenced note for a "[source]" conversation-provenance link', () => {
    renderPage(
      noteHtmlEntry(
        '<li>Decision text <a href="#2026-06-08-claude-cli-besoin-d-un-coupe-circuit-e63a1f47" ' +
          'class="conv-source">[source]</a></li>',
      ),
    );

    fireEvent.click(screen.getByText('[source]'));

    expect(mockEmit).toHaveBeenCalledWith(
      'nav:focusBrainNode',
      '2026-06-08-claude-cli-besoin-d-un-coupe-circuit-e63a1f47',
    );
  });

  it('scrolls in-page instead of navigating when the bare-hash id matches an element on the same rendered page', () => {
    renderPage(
      noteHtmlEntry(
        '<nav><a href="#see-also">See also</a></nav><section id="see-also"><h2>See also</h2></section>',
      ),
    );

    fireEvent.click(screen.getByText('See also', { selector: 'a' }));

    expect(mockEmit).not.toHaveBeenCalled();
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('does nothing for an empty bare hash ("#")', () => {
    renderPage(noteHtmlEntry('<a href="#">empty</a>'));
    fireEvent.click(screen.getByText('empty'));
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('WikiPage — other real engine link formats', () => {
  it('routes #/wiki/<id> to nav:focusBrainNode with the decoded id', () => {
    renderPage(noteHtmlEntry('<a href="#/wiki/file%3Asrc%2Ffoo.ts">foo.ts</a>'));
    fireEvent.click(screen.getByText('foo.ts'));
    expect(mockEmit).toHaveBeenCalledWith('nav:focusBrainNode', 'file:src/foo.ts');
  });

  it('emits editor:openFile (not a note navigation) for #/file:<path> links — intentional IDE trade-off', () => {
    // file-neuron note ids ARE literally `file:<path>` (engine/src/graph/
    // code-scanner.ts), so this format is overloaded on purpose: WikiPage
    // treats it as "open the real source file" rather than "open the note
    // about that file". Documented behavior, not a bug — pinned here so a
    // future change to it is deliberate.
    renderPage(noteHtmlEntry('<a href="#/file:src/payments/stripe.ts">stripe.ts</a>'));
    fireEvent.click(screen.getByText('stripe.ts'));
    expect(mockEmit).toHaveBeenCalledWith('editor:openFile', { path: 'src/payments/stripe.ts' });
  });

  it('delegates #/<slug> see-also/topic-style links to onOpenWikiLink', () => {
    // engine/src/annotator/blocks/see-also.ts: `href="#/${l.id}"`.
    const { onOpenWikiLink } = renderPage(
      noteHtmlEntry('<a href="#/abc-123" class="section-link">Related</a>'),
    );
    fireEvent.click(screen.getByText('Related'));
    expect(onOpenWikiLink).toHaveBeenCalledWith('abc-123');
  });
});

describe('WikiPage — backlinks strip ("what links here")', () => {
  it('renders clickable backlink entries and emits nav:focusBrainNode on click', () => {
    renderPage({
      kind: 'note-html',
      noteId: 'note-a',
      title: 'Note A',
      html: '<p>Body</p>',
      backlinks: [
        { id: 'note-b', title: 'Note B' },
        { id: 'note-c', title: 'Note C' },
      ],
      backlinksMore: 0,
    });

    expect(screen.getByText(en['brain.wikiBacklinks'])).toBeInTheDocument();
    fireEvent.click(screen.getByText('Note B'));
    expect(mockEmit).toHaveBeenCalledWith('nav:focusBrainNode', 'note-b');
  });

  it('shows a "+N more" hint when the backlink list was truncated', () => {
    renderPage({
      kind: 'note-html',
      noteId: 'note-a',
      title: 'Note A',
      html: '<p>Body</p>',
      backlinks: [{ id: 'note-b', title: 'Note B' }],
      backlinksMore: 7,
    });

    expect(screen.getByText(en['brain.wikiBacklinksMore'].replace('{count}', '7'))).toBeInTheDocument();
  });

  it('renders no backlinks section when there are none', () => {
    renderPage(noteHtmlEntry('<p>Body</p>')); // no `backlinks` field at all
    expect(screen.queryByText(en['brain.wikiBacklinks'])).not.toBeInTheDocument();
  });
});

describe('WikiPage — NoteMeta on note-html', () => {
  it('renders type, author and date above the article', () => {
    renderPage({
      kind: 'note-html',
      noteId: 'note-a',
      title: 'Note A',
      html: '<p>Body</p>',
      type: 'decision',
      author: 'Priya Shah',
      when: '2026-03-14',
    });
    expect(screen.getByTestId('note-kind-pill').textContent).toBe('decision');
    expect(screen.getByTestId('note-meta-author').textContent).toContain('Priya Shah');
    expect(screen.getByTestId('note-meta-when').textContent).toBe('2026-03-14');
  });
});
