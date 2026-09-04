/* WikiPage — right pane for the Brain Wiki view.

   Renders the currently selected wiki entry:
   - kind 'synthesis' → the engine's synthesized brain-index / topic-overview
     HTML, sanitized (see wikiHtml.ts) and rendered as a Wikipedia-style
     article. Clicks on internal `#/{slug}` wiki links (brain-index sections,
     see-also, related topics) are intercepted and handed to onOpenWikiLink so
     navigation stays inside the Wiki view instead of leaving it.
   - kind 'note' → reuses the existing BrainWiki renderer (note metadata,
     contradiction badge, citations) — the same panel the 3D graph view uses.

   Plus the loading / empty (no synthesis yet) / not-found states. */

import type React from 'react';
import { useI18n } from '../../i18n';
import { Spinner } from '../ui';
import { BrainWiki } from './BrainWiki';
import { sanitizeWikiHtml } from './wikiHtml';
import { rewriteNoteLinks, generateNoteToc } from './noteHtmlRender';
import { openExternal } from '../../lib/platform/openExternal';
import { emit } from '../../lib/bus';
import { WikiBacklinks, type WikiBacklinkItem } from './WikiBacklinks';
import { NoteMeta } from './NoteMeta';
import type { AdaptedNode } from '../../lib/brain/brainAdapter';
import type { WikiPayload } from '../../lib/mock/brain';

// `backlinks`/`backlinksMore` are optional (rather than required) so callers
// that don't care about "what links here" — e.g. WikiEntry values built in
// tests — can omit them; WikiTab always populates both when it builds a real
// note entry (see loadNoteEntry in WikiTab.tsx).
export type WikiEntry =
  | { kind: 'synthesis'; title: string; html: string }
  | {
      kind: 'note';
      node: AdaptedNode;
      payload: WikiPayload | null;
      backlinks?: WikiBacklinkItem[];
      backlinksMore?: number;
    }
  | {
      kind: 'note-html';
      noteId: string;
      title: string;
      html: string;
      type?: string;
      author?: string;
      when?: string;
      backlinks?: WikiBacklinkItem[];
      backlinksMore?: number;
    };

interface WikiPageProps {
  entry: WikiEntry | null;
  loading: boolean;
  /** Non-null → show the "no synthesis pages yet" empty state. */
  emptyMessage: string | null;
  notFound: boolean;
  onOpenWikiLink: (slug: string) => void;
}

const ARTICLE_CSS = `
.wiki-article { color: #D5D8E0; font-size: 14px; line-height: 1.7; font-family: 'Inter', -apple-system, sans-serif; max-width: 820px; }
.wiki-article h1 { font-size: 22px; font-weight: 700; color: #E8E3FF; margin: 0 0 6px; letter-spacing: -0.01em; }
.wiki-article h2 { font-size: 16px; font-weight: 700; color: #C4B5FD; margin: 22px 0 8px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 4px; }
.wiki-article h3 { font-size: 13px; font-weight: 700; color: #E8E3FF; margin: 16px 0 6px; }
.wiki-article p { margin: 0 0 10px; }
.wiki-article a { color: #A78BFF; text-decoration: none; cursor: pointer; }
.wiki-article a:hover { text-decoration: underline; }
.wiki-article ul, .wiki-article ol { padding-left: 20px; margin: 0 0 10px; }
.wiki-article li { margin: 2px 0; }
.wiki-article .infobox { float: right; width: 220px; margin: 0 0 12px 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 12px; font-size: 11px; }
.wiki-article .infobox dt { color: rgba(255,255,255,0.4); font-weight: 700; text-transform: uppercase; font-size: 9px; letter-spacing: 0.06em; margin-top: 6px; }
.wiki-article .infobox dd { margin: 2px 0 0; color: rgba(255,255,255,0.7); }
.wiki-article .toc { display: inline-block; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; padding: 8px 16px 8px 8px; margin: 0 0 16px; }
.wiki-article .toc h2 { border: none; font-size: 11px; margin: 0 0 4px; color: rgba(255,255,255,0.5); }
.wiki-article .toc .tocnumber { color: rgba(255,255,255,0.35); margin-right: 6px; }
.wiki-article .type-badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; background: rgba(124,92,255,0.14); color: #A78BFF; margin-right: 4px; }
.wiki-article .note-count { font-size: 11px; color: rgba(255,255,255,0.4); margin-right: 6px; }
.wiki-article .project-meta { margin: 2px 0 6px; }
.wiki-article .wiki-section { margin-bottom: 14px; }
.wiki-article [data-section="categories"] { margin-top: 22px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.07); font-size: 11px; color: rgba(255,255,255,0.4); }
.wiki-article li[data-cerveau-author]::after { content: attr(data-cerveau-author); display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 600; background: rgba(124,92,255,0.18); color: #A78BFF; vertical-align: middle; }
`;

function CenteredNotice({ children, tone }: { children: React.ReactNode; tone: 'muted' | 'warn' }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '0 40px',
        textAlign: 'center',
        color: tone === 'warn' ? '#FFC76B' : 'rgba(255,255,255,0.4)',
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

export function WikiPage({ entry, loading, emptyMessage, notFound, onOpenWikiLink }: WikiPageProps) {
  const { t } = useI18n();

  function handleArticleClick(e: React.MouseEvent<HTMLDivElement>) {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    // #/wiki/<id> — navigate to that note inside the Wiki view
    if (href.startsWith('#/wiki/')) {
      e.preventDefault();
      const id = decodeURIComponent(href.slice('#/wiki/'.length));
      if (id) emit('nav:focusBrainNode', id);
      return;
    }
    // #/file:<path> — open the file in the editor (IDE advantage over brain-ui)
    if (href.startsWith('#/file:')) {
      e.preventDefault();
      const path = href.slice('#/file:'.length);
      if (path) emit('editor:openFile', { path });
      return;
    }
    if (href.startsWith('#/')) {
      e.preventDefault();
      const slug = href.slice(2).trim();
      if (slug) onOpenWikiLink(slug);
      return;
    }
    if (href.startsWith('#')) {
      // Bare `#<id>` fragment — two real sources collide on this exact syntax:
      //  - genuine in-page anchors: TOC entries (generateNoteToc), and the
      //    engine's own section anchors (#see-also, #children, #architecture,
      //    #decisions, #bugs, #fn-*/#cls-* symbol ids — see file-neuron.ts).
      //  - cross-note references the engine emits as bare `#<id>` (no `/`):
      //    the auto-linker's "mentions" links (engine/src/graph/entities.ts
      //    applyAutoLinks writes `href="#${id}"`) and the "[source]"
      //    provenance links on fused conversation items inside
      //    data-section="decisions|bugs|ideas|rules|qa|activity". Confirmed
      //    live in real brains: ~97% of notes carry this exact format.
      // Disambiguate by DOM lookup, resolved against the currently rendered
      // article: if an element with that id exists on THIS page, it is a
      // same-page anchor; otherwise it names another note — navigate to it
      // exactly like a `#/wiki/<id>` link.
      e.preventDefault();
      const targetId = href.slice(1);
      if (!targetId) return;
      const target = e.currentTarget.querySelector(`#${CSS.escape(targetId)}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      emit('nav:focusBrainNode', targetId);
      return;
    }
    if (/^https?:/i.test(href)) {
      e.preventDefault();
      openExternal(href).catch(() => {});
    }
  }

  if (loading) {
    return (
      <CenteredNotice tone="muted">
        <Spinner size={24} color="#7C5CFF" />
        <span>{t('brain.wikiLoading')}</span>
      </CenteredNotice>
    );
  }

  if (emptyMessage) {
    return <CenteredNotice tone="muted">{emptyMessage}</CenteredNotice>;
  }

  if (notFound) {
    return <CenteredNotice tone="warn">{t('brain.wikiNotFound')}</CenteredNotice>;
  }

  if (!entry) {
    return <CenteredNotice tone="muted">{t('brain.wikiEmpty')}</CenteredNotice>;
  }

  if (entry.kind === 'note') {
    const backlinks = entry.backlinks ?? [];
    return (
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <BrainWiki node={entry.node} wikiPayload={entry.payload} />
        {/* BrainWiki is a fixed-width (340px) panel — the backlinks strip
            takes the remaining pane width rather than living inside it,
            since BrainWiki itself is out of scope for this feature. */}
        {backlinks.length > 0 && (
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, background: '#0E0E12', padding: '24px 32px' }}>
            <WikiBacklinks items={backlinks} more={entry.backlinksMore ?? 0} />
          </div>
        )}
      </div>
    );
  }

  if (entry.kind === 'note-html') {
    const rewritten = rewriteNoteLinks(sanitizeWikiHtml(entry.html));
    const withToc = generateNoteToc(rewritten) ?? rewritten;
    return (
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, background: '#0E0E12', padding: '24px 32px' }}>
        <style>{ARTICLE_CSS}</style>
        <div style={{ marginBottom: 14 }}>
          <NoteMeta
            kind={entry.type ?? 'note'}
            author={entry.author}
            when={entry.when}
          />
        </div>
        <div
          className="wiki-article"
          onClick={handleArticleClick}
          dangerouslySetInnerHTML={{ __html: withToc }}
        />
        <WikiBacklinks items={entry.backlinks ?? []} more={entry.backlinksMore ?? 0} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, background: '#0E0E12', padding: '24px 32px' }}>
      <style>{ARTICLE_CSS}</style>
      <div
        className="wiki-article"
        onClick={handleArticleClick}
        dangerouslySetInnerHTML={{ __html: sanitizeWikiHtml(entry.html) }}
      />
    </div>
  );
}
