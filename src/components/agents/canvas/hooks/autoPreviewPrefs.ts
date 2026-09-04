/* autoPreviewPrefs.ts — W-UX3 core deliverable 3a: "dismissable + remembered
   prefs" for the dev-server auto-detect preview (useCanvasAutoComposition.ts).

   A tiny localStorage-backed map, keyed by projectId — once a user closes an
   AUTO-ADDED preview node for a project (PreviewNode.tsx's close button,
   only when `data.autoAdded` is true), that project is remembered as
   "don't auto-add again" for `DISMISS_TTL_MS`. A manually-added preview's
   close button never touches this (see the `autoAdded` gate at the one call
   site) — only the automatic suggestion itself is dismissable, never a real
   user action.

   Preview lifecycle fix: this used to be a PERMANENT, one-way blacklist (a
   flat array of dismissed projectIds, no expiry) — closing one dead/
   misplaced auto-added card (a stale port, a probe that raced a restart)
   silently stopped ALL future auto-suggestions for that project forever,
   with no way back short of manually clearing localStorage. A TTL keeps the
   real intent ("don't immediately re-suggest what I just closed") honest
   without that permanence — the value is now a dismissal timestamp, not a
   boolean, and `isAutoPreviewDismissed` treats an expired one as "not
   dismissed" again. A pre-fix (array-shaped) blacklist is migrated in
   `readDismissedMap` as "just dismissed now" rather than dropped outright —
   still honored for one fresh TTL window, never silently discarded.

   Best-effort like every other localStorage read/write in this app (see
   i18n/index.tsx's own try/catch convention) — a private-browsing/quota
   failure degrades to "never remembered, would re-suggest next session",
   never a thrown error.
*/

const STORAGE_KEY = 'lazy.canvas.autoPreviewDismissed';

/** How long a dismissal lasts before the auto-preview suggestion is allowed
 *  to reappear for that project — see this module's own header for why this
 *  replaced a permanent blacklist. 24h: long enough that closing a card
 *  mid-session never immediately re-suggests it, short enough that a
 *  project the user is still actively working never stays silenced
 *  forever. */
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;

function readDismissedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Legacy migration — see this module's own header. Persisted back
    // immediately (not just returned) so the "dismissed now" timestamp is
    // stable across calls — without this, every fresh read would re-derive
    // its OWN "now" from the still-unmigrated raw array, and a legacy
    // dismissal would never actually expire.
    if (Array.isArray(parsed)) {
      const now = Date.now();
      const migrated: Record<string, number> = {};
      for (const id of parsed) if (typeof id === 'string') migrated[id] = now;
      writeDismissedMap(migrated);
      return migrated;
    }
    if (parsed === null || typeof parsed !== 'object') return {};
    const result: Record<string, number> = {};
    for (const [projectId, dismissedAtMs] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof dismissedAtMs === 'number' && Number.isFinite(dismissedAtMs)) result[projectId] = dismissedAtMs;
    }
    return result;
  } catch {
    return {};
  }
}

function writeDismissedMap(map: Record<string, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // best-effort only — see this module's own header
  }
}

export function isAutoPreviewDismissed(projectId: string): boolean {
  const dismissedAtMs = readDismissedMap()[projectId];
  if (dismissedAtMs === undefined) return false;
  return Date.now() - dismissedAtMs < DISMISS_TTL_MS;
}

export function dismissAutoPreview(projectId: string): void {
  const map = readDismissedMap();
  writeDismissedMap({ ...map, [projectId]: Date.now() });
}
