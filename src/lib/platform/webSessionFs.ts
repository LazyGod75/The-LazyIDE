import type { DirEntry } from './types.js';

/** Session-only directory listing: children of `dirPath` among written paths. */
export function dirEntriesFromSession(files: Iterable<string>, dirPath: string): DirEntry[] {
  // path-lint-ignore: in-memory POSIX session keys, never OS paths
  const normalized = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = `${normalized}/`;
  const seen = new Map<string, DirEntry>();
  for (const filePath of files) {
    // path-lint-ignore: in-memory POSIX session keys, never OS paths
    const path = filePath.replace(/\\/g, '/');
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (!name || seen.has(name)) continue;
    seen.set(name, {
      name,
      path: `${prefix}${name}`,
      isDir: slash !== -1,
    });
  }
  return [...seen.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
