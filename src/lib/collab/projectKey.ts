/* projectKey.ts — shared project identity for live collab.

   `projectIdFromRoot` is a LOCAL disk path. Alice's `C:/work/acme` and
   Bob's `/Users/bob/acme` never match, so a path-keyed Realtime topic
   is empty by construction. Collab uses the repo *basename* (last path
   segment) so two clones of the same repo land on the same key.

   Not a hash of origin-url (would require git I/O on every presence
   tick). Basename is the honest v1: two unrelated folders named `acme`
   collide — rare, and occupancy still scopes to the matching local zone.
*/

import { basename } from '../paths.js';

/** Shared project key from a local root. Pure, never throws. */
export function projectKeyFromRoot(root: string): string {
  const name = basename(root).trim();
  return name.length > 0 ? name.toLowerCase() : root;
}
