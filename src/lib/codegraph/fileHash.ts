/* fileHash.ts — SHA-256 content hashing for incremental indexing.
   Instead of rebuilding the entire graph when a git commit changes,
   we hash each file's content and only re-parse files whose hash changed.
*/

// ── SHA-256 implementation (Web Crypto API) ───────────────────────

/** Compute SHA-256 hash of a string, returning a hex string. */
export async function sha256(content: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback: simple FNV-1a hash (non-cryptographic, but sufficient for change detection)
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ── File hash store ───────────────────────────────────────────────

export interface FileHashStore {
  /** Map: filePath → SHA-256 hash of content at last index time. */
  hashes: Map<string, string>;
  /** When the store was last updated. */
  updatedAt: number;
}

export function createFileHashStore(): FileHashStore {
  return {
    hashes: new Map(),
    updatedAt: 0,
  };
}

/**
 * Compare current file hashes against stored hashes.
 * Returns the set of files that are new or changed (need re-parsing)
 * and the set of files that are unchanged (can be skipped).
 */
export interface HashDiffResult {
  /** Files that are new or have changed content — need re-parsing. */
  changed: string[];
  /** Files whose content is identical to last index — can be skipped. */
  unchanged: string[];
  /** Files that were in the index but are now deleted. */
  deleted: string[];
}

export async function diffFileHashes(
  store: FileHashStore,
  currentFiles: Map<string, string>,
): Promise<HashDiffResult> {
  const changed: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];

  // Check existing files
  for (const [filePath, content] of currentFiles) {
    const hash = await sha256(content);
    const stored = store.hashes.get(filePath);
    if (stored === hash) {
      unchanged.push(filePath);
    } else {
      changed.push(filePath);
      store.hashes.set(filePath, hash);
    }
  }

  // Check for deleted files
  for (const [filePath] of store.hashes) {
    if (!currentFiles.has(filePath)) {
      deleted.push(filePath);
      store.hashes.delete(filePath);
    }
  }

  store.updatedAt = Date.now();
  return { changed, unchanged, deleted };
}

/**
 * Update the hash store after re-parsing changed files.
 * Call this after reading file contents to keep hashes in sync.
 */
export async function updateHashes(
  store: FileHashStore,
  files: Map<string, string>,
): Promise<void> {
  for (const [filePath, content] of files) {
    const hash = await sha256(content);
    store.hashes.set(filePath, hash);
  }
  store.updatedAt = Date.now();
}
