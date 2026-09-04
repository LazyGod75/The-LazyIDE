/* TeamBrainSearch — stub.
   Team brain search is now part of the Brain space. This file is kept as a
   no-op stub so existing imports don't break. Renders nothing.
*/

import type { OrgMember } from '../../lib/teams/types';
import { DEBOUNCE_MS } from '../../lib/teams/useTeamBrainSearch';

interface TeamBrainSearchProps {
  members: OrgMember[];
  debounceMs?: number;
}

export function TeamBrainSearch(_props: TeamBrainSearchProps): null {
  return null;
}

export { DEBOUNCE_MS };
