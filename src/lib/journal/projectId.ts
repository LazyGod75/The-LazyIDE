/* projectId.ts — Derives the journal event envelope's `projectId` (spec
   §4.2) from a project's root path.

   This is a placeholder single-source-of-truth, NOT the sha1(normalized_root)
   hashed id T0.7's ProjectRegistry introduces later (see the fleet plan's
   T0.7 task) — every emit call site across the codebase uses this one
   function so that a later swap to the hashed id only touches this file.

   Deliberately tiny: strips the Windows verbatim (`\\?\`) prefix via
   paths.ts's shared helper, lowercases the drive letter only (the rest of
   the path is left byte-for-byte as-is — this is normalization for a stable
   key, not a display path), and strips a trailing separator so the same
   project root never mints two different ids depending on whether the
   caller's string happens to end with a slash.
*/

import { stripVerbatimPrefix } from '../paths.js';

/**
 * Normalizes a project root path into a stable projectId string.
 * Pure and synchronous — never throws, never touches disk.
 */
export function projectIdFromRoot(root: string): string {
  const stripped = stripVerbatimPrefix(root);
  const withoutTrailingSep = stripped.replace(/[\\/]+$/, '');
  return withoutTrailingSep.replace(/^([a-zA-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
}
