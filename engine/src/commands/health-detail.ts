/**
 * health-detail.ts — Read-only, on-demand breakdown for one Settings >
 * Memory health metric (orphans / brokenLinks / duplicates).
 *
 * TASK 2 (remediation UI — Settings > Memory has no way to act on 3047
 * broken links / 2990 duplicates today): a full destructive repair
 * ("merge duplicates", "prune broken links", "remove orphans") is a large,
 * risky change against an irreplaceable ~7500-note personal knowledge base.
 * This command implements the safe half instead — an honest "here is
 * EXACTLY what is wrong, here is the list" dry-run report, matching the
 * per-category counts `computeHealthScore` (health-score.ts) already
 * reports. It NEVER writes to the brain. The apply/repair step is left as
 * a follow-up (see MemoryPanel.tsx's DetailPanel doc comment).
 *
 * Detection logic mirrors health-score.ts exactly (same orphan / broken-link
 * / duplicate-title definitions) so `total` here always matches the
 * corresponding count already shown in Settings > Memory's health card —
 * deliberately NOT shared as an import from health-score.ts to avoid
 * touching that already-tested, independently-owned scoring path; both
 * files are small and the duplication is between two READ-ONLY, pure
 * computations over the same two data sources (listAll / loadBacklinks).
 */

import { loadBacklinks } from '../graph/backlinks.js';
import { type IndexedNote, listAll } from '../indexer/fts.js';

/** Hard cap on how many individual items a detail response returns — keeps
 *  the payload small (Settings > Memory renders a scrollable sample, not
 *  every one of e.g. 3047 broken links) while `total` still reports the
 *  real, uncapped count. */
export const HEALTH_DETAIL_LIMIT = 200;

export type HealthDetailCategory = 'orphans' | 'brokenLinks' | 'duplicates';

export interface HealthDetailOrphanItem {
  id: string;
  title: string;
}

export interface HealthDetailBrokenLinkItem {
  fromId: string;
  fromTitle: string;
  /** The dangling target id the link points to — not a real note in the corpus. */
  toId: string;
}

export interface HealthDetailDuplicateGroup {
  title: string;
  noteIds: string[];
}

export interface HealthDetailResult {
  category: HealthDetailCategory;
  /** Real, uncapped count — matches the corresponding HealthScoreResult field. */
  total: number;
  /** Number of items actually present in the array below (<= HEALTH_DETAIL_LIMIT). */
  shown: number;
  truncated: boolean;
  orphans?: HealthDetailOrphanItem[];
  brokenLinks?: HealthDetailBrokenLinkItem[];
  duplicates?: HealthDetailDuplicateGroup[];
}

function noteTitle(n: IndexedNote): string {
  return (n.title ?? '').trim() || n.id;
}

function computeOrphans(notes: IndexedNote[]): HealthDetailOrphanItem[] {
  const backlinks = loadBacklinks();
  const hasInbound = new Set<string>(Object.keys(backlinks?.incoming ?? {}));
  const hasOutbound = new Set<string>(Object.keys(backlinks?.outgoing ?? {}));
  return notes
    .filter((n) => !hasInbound.has(n.id) && !hasOutbound.has(n.id))
    .map((n) => ({ id: n.id, title: noteTitle(n) }));
}

function computeBrokenLinks(notes: IndexedNote[]): HealthDetailBrokenLinkItem[] {
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const backlinks = loadBacklinks();
  const out: HealthDetailBrokenLinkItem[] = [];
  for (const [fromId, edges] of Object.entries(backlinks?.outgoing ?? {})) {
    for (const edge of edges) {
      if (!noteById.has(edge.to)) {
        out.push({
          fromId,
          fromTitle: noteTitle(noteById.get(fromId) ?? ({ id: fromId } as IndexedNote)),
          toId: edge.to,
        });
      }
    }
  }
  return out;
}

function computeDuplicateGroups(notes: IndexedNote[]): HealthDetailDuplicateGroup[] {
  const byTitle = new Map<string, IndexedNote[]>();
  for (const n of notes) {
    const title = (n.title ?? '').trim();
    if (title.length < 5) continue; // matches health-score.ts's skip-short-titles rule
    const key = title.toLowerCase();
    const group = byTitle.get(key) ?? [];
    group.push(n);
    byTitle.set(key, group);
  }
  const groups: HealthDetailDuplicateGroup[] = [];
  for (const group of byTitle.values()) {
    if (group.length > 1) {
      groups.push({ title: noteTitle(group[0]), noteIds: group.map((n) => n.id) });
    }
  }
  return groups;
}

/**
 * Compute the detail breakdown for one health category. Pure/read-only —
 * touches only listAll()/loadBacklinks(), the same two read paths
 * computeHealthScore uses, never writes anything.
 */
export function computeHealthDetail(category: HealthDetailCategory): HealthDetailResult {
  const notes = listAll({ includeExpired: false });

  if (category === 'orphans') {
    const items = computeOrphans(notes);
    return {
      category,
      total: items.length,
      shown: Math.min(items.length, HEALTH_DETAIL_LIMIT),
      truncated: items.length > HEALTH_DETAIL_LIMIT,
      orphans: items.slice(0, HEALTH_DETAIL_LIMIT),
    };
  }

  if (category === 'brokenLinks') {
    const items = computeBrokenLinks(notes);
    return {
      category,
      total: items.length,
      shown: Math.min(items.length, HEALTH_DETAIL_LIMIT),
      truncated: items.length > HEALTH_DETAIL_LIMIT,
      brokenLinks: items.slice(0, HEALTH_DETAIL_LIMIT),
    };
  }

  // duplicates — `total` matches health-score.ts's dupe COUNT (extra copies
  // beyond the first in each group), not the number of groups, so it lines
  // up with the "2990 duplicates" figure already shown in the health card.
  const groups = computeDuplicateGroups(notes);
  const total = groups.reduce((sum, g) => sum + (g.noteIds.length - 1), 0);
  const shownGroups = groups.slice(0, HEALTH_DETAIL_LIMIT);
  return {
    category,
    total,
    shown: shownGroups.reduce((sum, g) => sum + (g.noteIds.length - 1), 0),
    truncated: groups.length > HEALTH_DETAIL_LIMIT,
    duplicates: shownGroups,
  };
}
