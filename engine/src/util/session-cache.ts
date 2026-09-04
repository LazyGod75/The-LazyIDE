/**
 * Q3 — Differential injection.
 *
 * Tracks, per Claude Code session, the note ids already injected via
 * UserPromptSubmit. The next turn's inject excludes them so we don't pay for
 * the same fact twice in the same conversation. Memory-only (daemon process),
 * LRU-bounded by session count, and each session entry expires after an idle
 * window so abandoned sessions don't leak.
 *
 * The trade-off: skipping previously-injected notes risks Claude forgetting
 * mid-session. Mitigations:
 *   - Re-injection happens automatically at SessionStart (different code path)
 *   - User can clear with `lazybrain session-cache clear`
 *   - Idle eviction caps the lifetime
 *
 * Feature C — Active working set.
 * Also tracks file paths that Claude touched (read/modified) during the session
 * so the inject step can boost notes that belong to those files.
 */

/** Maximum number of file paths retained in the active working set. */
export const ACTIVE_FILES_MAX = 20;

interface SessionEntry {
  injected: Set<string>;
  /** Active working set: most-recent-first, de-duplicated, capped at ACTIVE_FILES_MAX. */
  touchedFiles: string[];
  lastSeenMs: number;
}

const MAX_SESSIONS = 32;
const IDLE_TTL_MS = 6 * 3_600_000; // 6 hours

const sessions: Map<string, SessionEntry> = new Map();

function evictIdle(nowMs: number): void {
  if (sessions.size === 0) return;
  for (const [id, entry] of sessions) {
    if (nowMs - entry.lastSeenMs > IDLE_TTL_MS) sessions.delete(id);
  }
  // LRU cap — drop oldest first.
  if (sessions.size > MAX_SESSIONS) {
    const sorted = [...sessions.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
    const overflow = sessions.size - MAX_SESSIONS;
    for (let i = 0; i < overflow; i++) sessions.delete(sorted[i][0]);
  }
}

export function alreadyInjected(sessionId: string | undefined): Set<string> {
  if (!sessionId) return new Set();
  return sessions.get(sessionId)?.injected ?? new Set();
}

export function recordInjected(sessionId: string | undefined, ids: readonly string[]): void {
  if (!sessionId || ids.length === 0) return;
  const now = Date.now();
  evictIdle(now);
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { injected: new Set(), touchedFiles: [], lastSeenMs: now };
    sessions.set(sessionId, entry);
  }
  for (const id of ids) entry.injected.add(id);
  entry.lastSeenMs = now;
}

/**
 * Feature C — Record file paths that Claude touched (read or modified) in this
 * session. Paths are prepended to the working set in the order given, so
 * modified paths should be passed before read paths to preserve priority.
 *
 * - Prepends new paths to the list (batch-first, then older entries).
 * - De-duplicates: a path already present is moved to the front.
 * - Caps the list at ACTIVE_FILES_MAX; oldest entries are dropped.
 * - No-op when sessionId is undefined or paths is empty.
 */
export function recordTouchedFiles(sessionId: string | undefined, paths: readonly string[]): void {
  if (!sessionId || paths.length === 0) return;
  const now = Date.now();
  evictIdle(now);
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { injected: new Set(), touchedFiles: [], lastSeenMs: now };
    sessions.set(sessionId, entry);
  }
  // Prepend new paths in input order, removing duplicates.
  // Input order is: modified files first, then read files.
  const existing = new Set(entry.touchedFiles);
  const prepend: string[] = [];
  for (const p of paths) {
    if (!existing.has(p)) {
      prepend.push(p);
      existing.add(p);
    }
  }
  // Build new list: new paths first (in input order), then old surviving paths,
  // capped at ACTIVE_FILES_MAX.
  const prependSet = new Set(prepend);
  const merged = [...prepend, ...entry.touchedFiles.filter((p) => !prependSet.has(p))];
  entry.touchedFiles = merged.slice(0, ACTIVE_FILES_MAX);
  entry.lastSeenMs = now;
}

/**
 * Feature C — Returns the current active working-set paths for this session,
 * most-recent-first. Returns an empty array if sessionId is undefined or
 * the session is unknown.
 */
export function activeFiles(sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  return sessions.get(sessionId)?.touchedFiles ?? [];
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function clearAllSessions(): void {
  sessions.clear();
}

export function sessionCacheStats(): {
  sessions: number;
  totalInjected: number;
  totalTouchedFiles: number;
} {
  let totalInjected = 0;
  let totalTouchedFiles = 0;
  for (const entry of sessions.values()) {
    totalInjected += entry.injected.size;
    totalTouchedFiles += entry.touchedFiles.length;
  }
  return { sessions: sessions.size, totalInjected, totalTouchedFiles };
}
