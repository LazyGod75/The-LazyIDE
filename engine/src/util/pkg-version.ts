/**
 * pkg-version.ts — Single source of truth for the package version at runtime.
 *
 * Reads package.json relative to this file's location, walking up until it
 * is found.  Works in:
 *   - `tsx` dev mode  (src/util/ → ../../package.json)
 *   - esbuild bundle  (dist/src/util/ → ../../../package.json)
 *
 * Callers that need the version string should import `PKG_VERSION` from here
 * rather than hardcoding it or duplicating the fs-walk logic.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  const base = dirname(fileURLToPath(import.meta.url));
  for (const rel of [
    '../../package.json', // src/util/
    '../../../package.json', // dist/src/util/ (esbuild)
    '../../../../package.json',
  ]) {
    try {
      const raw = readFileSync(join(base, rel), 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      // try next candidate
    }
  }
  return 'unknown';
}

export const PKG_VERSION: string = readVersion();
