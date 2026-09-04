/* recentFiles.ts — per-project "recently opened" file MRU, used to give the
   Code space's empty editor state (CenterEditor.tsx) something real to show
   instead of a bare placeholder. Persisted tabs (editorStore.tsx) only ever
   reflect the CURRENTLY open tab strip — closing the last tab wipes that
   list entirely — so this is a separate, append-on-open MRU, keyed the same
   way editorStore.tsx already keys its own per-project storage (root-scoped
   localStorage, Windows verbatim prefix stripped), that survives tabs
   closing.
*/

import { stripVerbatimPrefix } from '../paths';

const RECENT_FILES_STORAGE_PREFIX = 'lazy.editor.recentFiles.';
const MAX_RECENT_FILES = 8;

export interface RecentFileEntry {
  path: string;
  filename: string;
}

/** Mirrors editorStore.tsx's tabsStorageKey derivation exactly (same
 *  normalization) so a `\\?\`-prefixed root and its plain equivalent share
 *  one single recent-files list, same as they already share one tab list. */
function recentFilesStorageKey(root: string): string {
  const normalized = stripVerbatimPrefix(root).replace(/[\\/]+$/, '');
  return `${RECENT_FILES_STORAGE_PREFIX}${normalized}`;
}

function isRecentFileEntry(value: unknown): value is RecentFileEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RecentFileEntry).path === 'string' &&
    typeof (value as RecentFileEntry).filename === 'string'
  );
}

function readEntries(root: string): RecentFileEntry[] {
  if (!root) return [];
  try {
    const raw = localStorage.getItem(recentFilesStorageKey(root));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentFileEntry);
  } catch {
    return [];
  }
}

function writeEntries(root: string, entries: RecentFileEntry[]): void {
  try {
    localStorage.setItem(recentFilesStorageKey(root), JSON.stringify(entries));
  } catch {
    // best-effort — a quota/private-mode write failure must never break editing
  }
}

/** Up to MAX_RECENT_FILES most-recently-opened files for `root`, most
 *  recent first. Empty root (no active project yet) always returns []. */
export function getRecentFiles(root: string): RecentFileEntry[] {
  return readEntries(root);
}

/** Records `path` as just-opened for `root`: moves it to the front (deduped
 *  by path) and caps the list at MAX_RECENT_FILES. No-ops for an empty root
 *  — mirrors editorStore.tsx's own persisted-tabs guard, since there is no
 *  stable key to scope the entry to yet. */
export function recordRecentFile(root: string, path: string, filename: string): void {
  if (!root) return;
  const existing = readEntries(root).filter((entry) => entry.path !== path);
  const next = [{ path, filename }, ...existing].slice(0, MAX_RECENT_FILES);
  writeEntries(root, next);
}

/** Drops `path` from `root`'s recent list — used when a recent file turns
 *  out to be unreadable (deleted/moved since it was last opened) so it
 *  doesn't keep reappearing as a dead link in the empty state. */
export function removeRecentFile(root: string, path: string): void {
  if (!root) return;
  const next = readEntries(root).filter((entry) => entry.path !== path);
  writeEntries(root, next);
}
