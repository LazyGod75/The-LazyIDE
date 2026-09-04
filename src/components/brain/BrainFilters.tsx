/* BrainFilters — Kind / Project / Author filter bar for the Brain space.
   Uses brain_query_css to filter the displayed graph nodes by note id. */

import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../i18n';
import { getPlatform } from '../../lib/platform';
import { isTauri } from '../../lib/platform';
import { listBrainProjects, type BrainProject } from '../../lib/brain/listProjects';
import { parseNoteIds, parseAuthorsFromHtml, type AuthorInfo } from '../../lib/brain/queryCssParse';

const KIND_OPTIONS = ['decision', 'bug', 'rule', 'idea', 'qa', 'warning'] as const;
type KindFilter = (typeof KIND_OPTIONS)[number] | 'all';

/* data-cerveau-kind is declared in the note schema but no capture path ever
   writes it — any selector using it returns zero results, always (see
   src-tauri/src/commands/brain/capture.rs and src/lib/brain/brainTool.ts's
   documented vocabulary). "decision" and "bug" have proven-working
   equivalents (data-cerveau-type and data-cerveau-tags respectively);
   the remaining kinds have no single-attribute equivalent yet, so they
   still query the dead attribute until a capture path populates it or a
   dedicated selector is designed for them. */
function kindSelectorPart(kind: Exclude<KindFilter, 'all'>): string {
  if (kind === 'decision') return '[data-cerveau-type="decision"]';
  if (kind === 'bug') return '[data-cerveau-tags~="bug"]';
  return `[data-cerveau-kind="${kind}"]`;
}

interface BrainFiltersProps {
  onFilterIds: (ids: Set<string> | null) => void;
}

export function BrainFilters({ onFilterIds }: BrainFiltersProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<KindFilter>('all');
  const [project, setProject] = useState<string>('all');
  const [author, setAuthor] = useState<string>('all');
  const [projects, setProjects] = useState<BrainProject[]>([]);
  const [authors, setAuthors] = useState<AuthorInfo[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    listBrainProjects().then((ps) => {
      if (!cancelled) setProjects(ps);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await getPlatform().brain.queryCss('article[data-cerveau-author-id]');
        const ids = parseNoteIds(raw).slice(0, 12);
        const pages = await Promise.all(ids.map(async (id) => {
          try {
            return await getPlatform().brain.noteHtml(id);
          } catch {
            return '';
          }
        }));
        const all: AuthorInfo[] = [];
        for (const html of pages) {
          if (html) all.push(...parseAuthorsFromHtml(html));
        }
        const seen = new Map<string, string>();
        for (const a of all) if (!seen.has(a.authorId)) seen.set(a.authorId, a.author);
        if (!cancelled) setAuthors(Array.from(seen, ([authorId, authorName]) => ({ authorId, author: authorName })));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const runQuery = useCallback(() => {
    if (kind === 'all' && project === 'all' && author === 'all') {
      onFilterIds(null);
      return;
    }
    if (!isTauri()) {
      onFilterIds(null);
      return;
    }
    const baseParts: string[] = ['article'];
    if (kind !== 'all') baseParts.push(kindSelectorPart(kind));
    if (author !== 'all') baseParts.push(`[data-cerveau-author-id="${author}"]`);

    // A selected project may be a merge of several raw slugs (short name +
    // full-path-derived slug — see listProjects.ts's mergeAliases): query
    // every alias and union the results so notes tagged under either raw
    // form are still matched, instead of silently dropping the ones tagged
    // under whichever alias isn't the displayed value.
    const selected = projects.find((p) => p.project === project);
    const projectValues: Array<string | null> = project === 'all' ? [null] : (selected?.rawValues ?? [project]);

    Promise.all(
      projectValues.map((value) => {
        const parts = value === null ? baseParts : [...baseParts, `[data-cerveau-project="${value}"]`];
        return getPlatform().brain.queryCss(parts.join(''));
      }),
    )
      .then((results) => {
        const merged = new Set<string>();
        for (const raw of results) {
          for (const id of parseNoteIds(raw)) merged.add(id);
        }
        onFilterIds(merged);
      })
      .catch(() => { onFilterIds(null); });
  }, [kind, project, author, projects, onFilterIds]);

  useEffect(() => { runQuery(); }, [runQuery]);

  const selectStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    padding: '4px 8px',
    color: '#C4B5FD',
    fontSize: 11,
    fontFamily: 'inherit',
    outline: 'none',
    cursor: 'pointer',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    marginRight: 4,
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={labelStyle}>{t('brain.filter.kind')}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} style={selectStyle}>
          <option value="all">{t('brain.filter.all')}</option>
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={labelStyle}>{t('brain.filter.project')}</span>
        <select value={project} onChange={(e) => setProject(e.target.value)} style={selectStyle}>
          <option value="all">{t('brain.filter.all')}</option>
          {projects.map((p) => (
            <option key={p.project} value={p.project}>{p.project}</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span style={labelStyle}>{t('brain.filter.author')}</span>
        <select value={author} onChange={(e) => setAuthor(e.target.value)} style={selectStyle}>
          <option value="all">{t('brain.filter.all')}</option>
          {authors.map((a) => (
            <option key={a.authorId} value={a.authorId}>{a.author}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
