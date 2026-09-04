/**
 * lib/corpus.mjs — the fixed file corpus shared by every non-LazyBrain
 * baseline (flat RAG, grep/read) AND by the LazyBrain fixture brain (see
 * lib/lazyFixture.mjs, which was code-scanned from these same directories).
 *
 * Keeping one corpus definition that every config reads from is what makes
 * "vary only the retrieval configuration" true instead of aspirational.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__pycache__']);

/**
 * Recursively list every source file under a repo-relative directory.
 * Returns { absPath, relPath (posix, from REPO_ROOT) } for each file.
 */
function walk(absDir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(abs));
    } else if (CODE_EXT.has(extname(entry.name))) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * List every source file under the given repo-relative corpus directories.
 * @param {string[]} corpusDirs repo-relative dirs, e.g. "engine/src/retrieval"
 */
export function listCorpusFiles(corpusDirs) {
  const files = [];
  for (const dir of corpusDirs) {
    const absDir = join(REPO_ROOT, dir);
    for (const abs of walk(absDir)) {
      const relPath = relative(REPO_ROOT, abs).split('\\').join('/');
      files.push({ absPath: abs, relPath, corpusDir: dir });
    }
  }
  return files;
}

export function readFileSafe(absPath) {
  try {
    return readFileSync(absPath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Resolve which declared corpusDir a repo-relative file path belongs to —
 * the LONGEST matching prefix (so "engine/src/commands/inject-context/x.ts"
 * resolves to "engine/src/commands" when that is the only scanned ancestor,
 * but to a more specific scanned subdir if one was also declared).
 */
export function resolveCorpusDir(relPath, corpusDirs) {
  let best = null;
  for (const dir of corpusDirs) {
    if (relPath === dir || relPath.startsWith(`${dir}/`)) {
      if (!best || dir.length > best.length) best = dir;
    }
  }
  return best;
}

export function fileLineCount(absPath) {
  const text = readFileSafe(absPath);
  if (!text) return 0;
  return text.split('\n').length;
}
