/**
 * Fingerprint-based incremental processing.
 * Tracks SHA-256 of source files (Claude conversations) to skip unchanged ones.
 *
 * Fast path: mtime + size check (most files, O(1)).
 * Slow path: SHA-256 hash check (when mtime differs but content may be same).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from './config.js';

export interface FileFingerprint {
  filePath: string;
  contentHash: string; // SHA-256 of file content (hex)
  mtimeMs: number; // last modification time in ms
  size: number; // file size in bytes
  processedAt: string; // ISO timestamp
  notesCreated: string[]; // IDs of notes created from this file
}

export interface FingerprintStore {
  version: '1.0.0';
  generatedAt: string;
  files: Record<string, FileFingerprint>; // keyed by absolute file path
}

/**
 * Return the path to the fingerprint store file.
 * Stored next to the brain cache.
 */
function storePath(): string {
  try {
    const { cachePath } = getConfig();
    return join(cachePath, '.fingerprints.json');
  } catch {
    // Fallback when brain is not configured (tests)
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '.';
    return join(home, '.lazybrain', '.fingerprints.json');
  }
}

/**
 * Load the fingerprint store from disk.
 * Returns an empty store if the file does not exist or is corrupted.
 */
export function loadFingerprints(): FingerprintStore {
  const path = storePath();
  if (!existsSync(path)) {
    return emptyStore();
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<FingerprintStore>;
    if (parsed.version !== '1.0.0' || typeof parsed.files !== 'object') {
      return emptyStore();
    }
    return parsed as FingerprintStore;
  } catch {
    return emptyStore();
  }
}

/**
 * Persist the fingerprint store to disk (best-effort).
 */
export function saveFingerprints(store: FingerprintStore): void {
  const path = storePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const updated: FingerprintStore = { ...store, generatedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(updated, null, 2), 'utf-8');
}

/**
 * Compute SHA-256 hash of a file's content (hex-encoded).
 */
export function computeHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Check whether a file has changed since it was last processed.
 *
 * Fast path (O(1)): if mtime AND size both match the stored fingerprint → not changed.
 * Slow path: if mtime or size differ, compute SHA-256 and compare hashes.
 *            This handles filesystem clock skew and touch-without-edit cases.
 *
 * Returns true  → file is new or changed (needs processing).
 * Returns false → file is unchanged (safe to skip).
 */
export function hasChanged(filePath: string, store: FingerprintStore): boolean {
  const stored = store.files[filePath];

  // No fingerprint recorded → definitely new
  if (!stored) return true;

  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(filePath);
  } catch {
    // File disappeared — treat as changed so the caller can handle deletion
    return true;
  }

  // Fast path: mtime + size match → assume unchanged
  if (stat.mtimeMs === stored.mtimeMs && stat.size === stored.size) {
    return false;
  }

  // Slow path: mtime or size differ — hash to confirm
  try {
    const hash = computeHash(filePath);
    return hash !== stored.contentHash;
  } catch {
    // Unreadable file → treat as changed
    return true;
  }
}

/**
 * Record that a file was successfully processed.
 * Returns a new FingerprintStore (immutable update).
 */
export function recordProcessed(
  filePath: string,
  notesCreated: string[],
  store: FingerprintStore,
): FingerprintStore {
  let stat: { mtimeMs: number; size: number };
  let contentHash: string;

  try {
    stat = statSync(filePath);
    contentHash = computeHash(filePath);
  } catch {
    // File disappeared between processing and recording — skip recording
    return store;
  }

  const fingerprint: FileFingerprint = {
    filePath,
    contentHash,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    processedAt: new Date().toISOString(),
    notesCreated,
  };

  return {
    ...store,
    files: { ...store.files, [filePath]: fingerprint },
  };
}

/**
 * Filter a list of file paths down to those that have changed since last processing.
 */
export function getChangedFiles(filePaths: string[], store: FingerprintStore): string[] {
  return filePaths.filter((fp) => hasChanged(fp, store));
}

/**
 * Return paths that are tracked in the store but no longer exist on disk.
 * Used for cleanup: callers can remove orphaned fingerprints or notes.
 */
export function getOrphanedFingerprints(store: FingerprintStore): string[] {
  return Object.keys(store.files).filter((fp) => !existsSync(fp));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyStore(): FingerprintStore {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    files: {},
  };
}
