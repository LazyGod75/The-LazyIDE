/* WikiTab — the Brain space's Wikipedia-style reader.

   LEFT  = WikiTree, the project→module→topic hierarchy (platform.brain.tree()).
   RIGHT = WikiPage, the selected page: the synthesized brain-index /
           topic-overview HTML, or an individual note rendered by the reused
           BrainWiki panel.

   Navigation model (all in-view, never leaves the Wiki):
   - Default entry is the synthesized brain-index (platform.brain.synthesisIndex()).
   - A tree "project" node opens that topic's overview (synthesisTopic), falling
     back to its root-aggregate note; any other node opens its note.
   - Internal `#/{slug}` links inside a rendered page (brain-index sections,
     see-also, related topics) open that topic overview (or note fallback).
   - BrainWiki's own citation / contradiction buttons emit nav:focusBrainNode;
     while the Wiki is mounted we load that note into the right pane too.
   - A back-navigation stack (history) lets the user return the way they
     came after following links; the WikiTree sidebar exposes it as a "Back"
     row above Home, shown once there is somewhere to go back to.

   Refresh: reloads tree + index on the brain://updated event (Tauri), so a
   fresh `dream --synthesize` consolidation surfaces new pages live. Empty
   brain (no synthesis yet) shows an honest "run consolidation" message rather
   than crashing. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getPlatform } from '../../lib/platform';
import { useI18n } from '../../i18n';
import { on } from '../../lib/bus';
import { EmptyState } from '../ui/EmptyState';
import { WikiTree } from './WikiTree';
import { WikiPage, type WikiEntry } from './WikiPage';
import { type WikiBacklinkItem } from './WikiBacklinks';
import { buildWikiPayloadFromMeta } from '../../lib/brain/brainAdapter';
import { parseNoteIdentity } from '../../lib/brain/queryCssParse';
import type { AdaptedNode } from '../../lib/brain/brainAdapter';
import { extractPageTitle } from '../../lib/brain/wikiData';
import type {
  BrainTree,
  BrainTreeNode,
  BrainNoteMeta,
  BrainSynthesisIndex,
  Brain,
} from '../../lib/platform/types';

// ── Note → AdaptedNode (for the reused BrainWiki panel) ────────────

const NODE_TYPES = ['decision', 'bug', 'file', 'concept', 'module'] as const;

function safeNodeType(raw: string): AdaptedNode['type'] {
  return (NODE_TYPES as readonly string[]).includes(raw) ? (raw as AdaptedNode['type']) : 'concept';
}

function makeNode(meta: BrainNoteMeta): AdaptedNode {
  const cluster = meta.topic ? (meta.topic.split('/')[0] || 'unknown').toLowerCase() : 'unknown';
  const val = Math.max(1, Math.min(10, Math.round((meta.importance ?? 0.5) * 10)));
  return {
    id: meta.id,
    name: meta.title,
    type: safeNodeType(meta.type),
    cluster,
    val,
    dateIdx: 0,
    ...(meta.topic ? { topic: meta.topic } : {}),
  };
}

const EMPTY_TREE: BrainTree = { projects: [] };

// ── Backlinks ("what links here") ───────────────────────────────────
//
// platform.brain.backlinks(id) resolves to note ids only (incoming edges,
// no titles — see src/lib/platform/types.ts). Titles are resolved with one
// platform.brain.note() call per id, capped at BACKLINKS_CAP so a heavily
// referenced hub note doesn't trigger a burst of bridge calls; the
// remainder is surfaced as a plain count ("+N more") instead of fetched.
// Soft-fails to no backlinks (or, per item, to the raw id as its title) —
// a missing/partial "what links here" strip is never worth failing the
// note view over.
const BACKLINKS_CAP = 20;

async function resolveBacklinkTitle(brain: Brain, id: string): Promise<WikiBacklinkItem> {
  try {
    const meta = await brain.note(id);
    return { id, title: meta.title };
  } catch {
    return { id, title: id };
  }
}

interface LoadedBacklinks {
  items: WikiBacklinkItem[];
  more: number;
}

async function loadBacklinks(brain: Brain, noteId: string): Promise<LoadedBacklinks> {
  const ids = await brain.backlinks(noteId).catch(() => [] as string[]);
  if (ids.length === 0) return { items: [], more: 0 };
  const shown = ids.slice(0, BACKLINKS_CAP);
  const items = await Promise.all(shown.map((id) => resolveBacklinkTitle(brain, id)));
  return { items, more: ids.length - shown.length };
}

// ── Timeout guard (v0.1.5 W2.7, independence + retry added W2.10) ──
//
// A hung bridge (promise that never settles) used to leave the Wiki spinning
// on its loading state forever — same bug class as the mission freeze.
// Mirrors the identical local helper in BrainSpace.tsx / MemoryPanel.tsx
// (deliberately kept local to each file, per the established convention
// there, instead of introducing a shared module).
//
// W2.10: tree() and synthesisIndex() used to share ONE timeout wrapped
// around Promise.all — on a large brain (1800+ notes) the server-side tree
// build can outlast a short shared budget even when synthesisIndex()
// answers fine, and the single race blanked BOTH panes. Each call now gets
// its own timeout guard, combined with Promise.allSettled so neither's
// fallback discards the other's real result (see fetchBase below).

const SIDECAR_TIMEOUT_MS = 30_000;

/** Delay before the one bounded automatic retry when the FIRST load ends up
    with nothing to show and at least one call genuinely timed out (as
    opposed to a fast rejection — see fetchBase). withTimeout never cancels
    the underlying call, so the sidecar's own tree build keeps running after
    our client gives up; a few seconds later usually finds it already warm. */
const AUTO_RETRY_DELAY_MS = 4_000;

class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Races `promise` against a timer; rejects with a TimeoutError if `ms`
    elapses first. Never cancels the underlying promise — a late result is
    ignored by callers via their own `cancelled` guard. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

interface BaseLoadResult {
  tree: BrainTree;
  treeOk: boolean;
  treeTimedOut: boolean;
  index: BrainSynthesisIndex | null;
  indexOk: boolean;
  indexTimedOut: boolean;
}

/** Fetches tree() and synthesisIndex() independently, each under its own
    timeout guard, then combines them with allSettled instead of all() — a
    rejection (fast failure OR timeout) on one side never discards a result
    the other side already produced. `treeOk`/`indexOk` are true whenever the
    call settled at all, including a legitimate resolve-to-null/empty (a
    fresh brain with no `dream --synthesize` yet is not a failure); only an
    actual rejection sets the corresponding *Ok to false, and only a
    rejection specifically caused by our own timeout (not a fast error from
    the bridge) sets *TimedOut, which is what gates the bounded retry below. */
async function fetchBase(brain: Brain): Promise<BaseLoadResult> {
  const [treeResult, indexResult] = await Promise.allSettled([
    withTimeout(brain.tree(), SIDECAR_TIMEOUT_MS, 'brain.tree()'),
    withTimeout(brain.synthesisIndex(), SIDECAR_TIMEOUT_MS, 'brain.synthesisIndex()'),
  ]);
  return {
    tree: treeResult.status === 'fulfilled' ? treeResult.value : EMPTY_TREE,
    treeOk: treeResult.status === 'fulfilled',
    treeTimedOut: treeResult.status === 'rejected' && treeResult.reason instanceof TimeoutError,
    index: indexResult.status === 'fulfilled' ? indexResult.value : null,
    indexOk: indexResult.status === 'fulfilled',
    indexTimedOut: indexResult.status === 'rejected' && indexResult.reason instanceof TimeoutError,
  };
}

export function WikiTab() {
  const { t } = useI18n();
  const platform = getPlatform();

  const [tree, setTree] = useState<BrainTree>(EMPTY_TREE);
  const [index, setIndex] = useState<BrainSynthesisIndex | null>(null);
  const [entry, setEntry] = useState<WikiEntry | null>(null);
  const [booting, setBooting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);

  // Monotonic request id — guards every async navigation against a stale
  // result overwriting a newer one (rapid clicks / refresh mid-load).
  const reqRef = useRef(0);

  // ── Back-navigation stack (v0.1.5 W2.8) ────────────────────────────
  //
  // A navigable wiki needs a way back after following links. The stack lives
  // in a ref (not state) — only its emptiness (`canGoBack`) needs to trigger
  // a render. `activeIdRef`/`entryRef` mirror the latest activeId/entry so
  // the stable (useCallback) navigation functions can snapshot "where we
  // were" without depending on — and therefore re-creating on — every
  // navigation. Cleared on every full reload (loadBase): stale entries could
  // point at notes a fresh `dream --synthesize` / graph rebuild removed.
  //
  // The refs are written SYNCHRONOUSLY alongside every setActiveId/setEntry
  // call (via setActiveIdTracked/setEntryTracked below) rather than mirrored
  // through a useEffect keyed on [activeId, entry]: a passive effect only
  // flushes on the NEXT commit, so a synchronous sequence of navigations
  // (pushHistory reading the ref immediately after a same-tick setEntry) can
  // observe a stale ref value under scheduling pressure — reproduced as a
  // "Back restores a null entry" flake under full-suite parallel load.
  const historyRef = useRef<Array<{ activeId: string | null; entry: WikiEntry | null }>>([]);
  const activeIdRef = useRef<string | null>(null);
  const entryRef = useRef<WikiEntry | null>(null);

  const setActiveIdTracked = useCallback((next: string | null) => {
    activeIdRef.current = next;
    setActiveId(next);
  }, []);
  const setEntryTracked = useCallback((next: WikiEntry | null) => {
    entryRef.current = next;
    setEntry(next);
  }, []);

  const pushHistory = useCallback(() => {
    historyRef.current = [
      ...historyRef.current,
      { activeId: activeIdRef.current, entry: entryRef.current },
    ];
    setCanGoBack(true);
  }, []);

  const indexEntry = useCallback(
    (idx: BrainSynthesisIndex): WikiEntry => ({
      kind: 'synthesis',
      title: extractPageTitle(idx.html, t('brain.wikiOverview')),
      html: idx.html,
    }),
    [t],
  );

  // ── Base load (mount + brain://updated) ────────────────────────
  //
  // Per-call failures stay soft (empty tree / no index — see fetchBase);
  // committing happens as soon as EITHER side has something to show, so a
  // slow/failed synthesisIndex() never blanks an already-loaded tree, and
  // vice-versa. Only when NEITHER side has anything, AND at least one of
  // them is a genuine timeout (not just a fast rejection — retrying a real
  // error would not help), do we wait AUTO_RETRY_DELAY_MS and try once
  // more before finally showing the honest timedOut state.
  const loadBase = useCallback(
    // Named (not anonymous) so the retry's self-call below binds to this
    // function's own name — a stable binding independent of the outer
    // `const loadBase` — rather than closing over the outer variable before
    // it finishes being declared (react-hooks/immutability).
    async function loadBaseImpl(cancelled: { v: boolean }, isRetry = false) {
      setBooting(true);
      setTimedOut(false);
      const result = await fetchBase(platform.brain);
      if (cancelled.v) return;

      const totalFailure = !result.treeOk && !result.indexOk;
      const wasTimeout = result.treeTimedOut || result.indexTimedOut;
      // A total failure caused by a fast rejection (no timeout involved —
      // e.g. the sidecar is simply down) is not worth retrying, and falls
      // through to the soft commit below exactly like a single-side
      // failure would. Only a total failure where at least one side
      // genuinely timed out gets the bounded retry treatment.
      if (totalFailure && wasTimeout && !isRetry) {
        setTimeout(() => {
          if (!cancelled.v) loadBaseImpl(cancelled, true);
        }, AUTO_RETRY_DELAY_MS);
        return;
      }
      if (totalFailure && wasTimeout) {
        // Retried once already and still nothing to show — honest failure.
        setTimedOut(true);
        setBooting(false);
        return;
      }

      reqRef.current += 1;
      setTree(result.tree);
      setIndex(result.index);
      setActiveIdTracked(null);
      setNotFound(false);
      setEntryTracked(result.index ? indexEntry(result.index) : null);
      historyRef.current = [];
      setCanGoBack(false);
      setBooting(false);
    },
    [platform, indexEntry, setActiveIdTracked, setEntryTracked],
  );

  useEffect(() => {
    const cancelled = { v: false };
    loadBase(cancelled);
    return () => {
      cancelled.v = true;
    };
  }, [loadBase]);

  const retryBase = useCallback(() => {
    loadBase({ v: false });
  }, [loadBase]);

  useEffect(() => {
    if (platform.name !== 'tauri') return;
    const unlisteners: Array<() => void> = [];
    import('@tauri-apps/api/event')
      .then(({ listen }) => {
        listen('brain://updated', () => {
          const cancelled = { v: false };
          loadBase(cancelled);
        })
          .then((fn) => unlisteners.push(fn))
          .catch((err: unknown) => console.warn('[WikiTab] listen brain://updated failed:', err));
      })
      .catch((err: unknown) => console.warn('[WikiTab] @tauri-apps/api/event import failed:', err));
    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [platform.name, loadBase]);

  // ── Navigation ─────────────────────────────────────────────────
  const openHome = useCallback(() => {
    pushHistory();
    reqRef.current += 1;
    setLoading(false);
    setNotFound(false);
    setActiveIdTracked(null);
    setEntryTracked(index ? indexEntry(index) : null);
  }, [index, indexEntry, pushHistory, setActiveIdTracked, setEntryTracked]);

  const goBack = useCallback(() => {
    const stack = historyRef.current;
    if (stack.length === 0) return;
    const last = stack[stack.length - 1];
    historyRef.current = stack.slice(0, -1);
    setCanGoBack(historyRef.current.length > 0);
    reqRef.current += 1; // invalidate any in-flight navigation
    setLoading(false);
    setNotFound(false);
    setActiveIdTracked(last.activeId);
    setEntryTracked(last.entry);
  }, [setActiveIdTracked, setEntryTracked]);

  // Fetches note metadata + full HTML + backlinks in parallel and builds the
  // corresponding WikiEntry — 'note-html' when the sidecar has full article
  // HTML (matches brain-ui's full article rendering: links, TOC, body text),
  // else the minimal 'note' fallback (reused BrainWiki panel). Shared by
  // openNote and openTopic's note-fallback path so backlink resolution isn't
  // duplicated across both.
  const loadNoteEntry = useCallback(
    async (noteId: string): Promise<WikiEntry> => {
      const [meta, html, backlinks] = await Promise.all([
        platform.brain.note(noteId),
        platform.brain.noteHtml(noteId),
        loadBacklinks(platform.brain, noteId),
      ]);
      const identity = html ? parseNoteIdentity(html) : {};
      const when = identity.when ?? (meta.created ? meta.created.slice(0, 10) : undefined);
      return html
        ? {
            kind: 'note-html',
            noteId,
            title: meta.title,
            html,
            type: safeNodeType(meta.type),
            ...(identity.author ? { author: identity.author } : {}),
            ...(when ? { when } : {}),
            backlinks: backlinks.items,
            backlinksMore: backlinks.more,
          }
        : {
            kind: 'note',
            node: makeNode(meta),
            payload: {
              ...buildWikiPayloadFromMeta(meta, t),
              ...(identity.author ? { author: identity.author } : {}),
            },
            backlinks: backlinks.items,
            backlinksMore: backlinks.more,
          };
    },
    [platform, t],
  );

  const openNote = useCallback(
    async (noteId: string) => {
      pushHistory();
      const rid = ++reqRef.current;
      setLoading(true);
      setNotFound(false);
      try {
        const nextEntry = await loadNoteEntry(noteId);
        if (rid !== reqRef.current) return;
        setEntryTracked(nextEntry);
        setActiveIdTracked(noteId);
      } catch {
        if (rid !== reqRef.current) return;
        setNotFound(true);
        setEntryTracked(null);
      } finally {
        if (rid === reqRef.current) setLoading(false);
      }
    },
    [loadNoteEntry, pushHistory, setActiveIdTracked, setEntryTracked],
  );

  const openTopic = useCallback(
    async (slug: string, fallbackNoteId?: string | null) => {
      pushHistory();
      const rid = ++reqRef.current;
      setLoading(true);
      setNotFound(false);
      let html: string | null = null;
      try {
        html = await platform.brain.synthesisTopic(slug);
      } catch {
        /* not synthesized or sidecar unreachable — html stays null, fall through to the note attempt */
      }
      if (rid !== reqRef.current) return;
      if (html) {
        setEntryTracked({ kind: 'synthesis', title: extractPageTitle(html, slug), html });
        setActiveIdTracked(slug);
        setLoading(false);
        return;
      }
      // Not a synthesized topic — try the fallback note (a project's root
      // aggregate), else the slug itself as a note id, else honest not-found.
      const noteId = fallbackNoteId ?? slug;
      try {
        const nextEntry = await loadNoteEntry(noteId);
        if (rid !== reqRef.current) return;
        setEntryTracked(nextEntry);
        setActiveIdTracked(noteId);
      } catch {
        if (rid !== reqRef.current) return;
        setNotFound(true);
        setEntryTracked(null);
      } finally {
        if (rid === reqRef.current) setLoading(false);
      }
    },
    [platform, pushHistory, loadNoteEntry, setActiveIdTracked, setEntryTracked],
  );

  const handleTreeSelect = useCallback(
    (node: BrainTreeNode) => {
      if (node.type === 'project') {
        // Top-level project — /_api/synthesis/:topic has always matched
        // these by plain label (e.g. "cerveau"), so keep passing that slug.
        openTopic(node.label, node.noteId);
      } else if (node.type === 'topic') {
        // Synthetic module/topic branch (see engine's buildTree /
        // nestKnowledgeNotes) — no note of its own, so there is nothing for
        // openNote to load. Its id is the full dotted topic path (e.g.
        // "cerveau/auth"), which handleSynthesisTopic now matches exactly.
        openTopic(node.id, node.noteId);
      } else {
        openNote(node.noteId ?? node.id);
      }
    },
    [openTopic, openNote],
  );

  const handleWikiLink = useCallback((slug: string) => openTopic(slug), [openTopic]);

  // BrainWiki (note view) emits nav:focusBrainNode for its citation /
  // contradiction links — load that note into the right pane, staying in-view.
  useEffect(() => {
    const unsub = on('nav:focusBrainNode', (target: string) => {
      openNote(target);
    });
    return unsub;
  }, [openNote]);

  const showEmpty = !booting && index === null && entry === null && !loading && !notFound;

  // Honest timeout state — the bridge did not answer within SIDECAR_TIMEOUT_MS.
  if (timedOut) {
    return (
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <EmptyState
          icon="!"
          title={t('brain.wikiTimeoutTitle')}
          subtitle={t('brain.wikiTimeoutHint')}
          action={{ label: t('common.retry'), onClick: retryBase }}
        />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
      <WikiTree
        tree={tree}
        activeId={activeId}
        onSelect={handleTreeSelect}
        onHome={openHome}
        homeActive={activeId === null}
        canGoBack={canGoBack}
        onBack={goBack}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        <WikiPage
          entry={entry}
          loading={loading || booting}
          emptyMessage={showEmpty ? t('brain.wikiEmpty') : null}
          notFound={notFound}
          onOpenWikiLink={handleWikiLink}
        />
      </div>
    </div>
  );
}
