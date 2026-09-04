/* useTeamBrainSearch — stub.
   Team brain search is now part of the Brain space. This hook is kept as a
   no-op so existing imports don't break. Always returns an empty result set.
*/

import type { TeamBrainSearchResult, TeamBrainScope } from './types.js';

export const DEBOUNCE_MS = 300;

export interface UseTeamBrainSearchResult {
  results: TeamBrainSearchResult[];
  loading: boolean;
  error: string | null;
}

export interface UseTeamBrainSearchOptions {
  top?: number;
  debounceMs?: number;
}

export function useTeamBrainSearch(
  _query: string,
  _scope: TeamBrainScope,
  _options: UseTeamBrainSearchOptions = {},
): UseTeamBrainSearchResult {
  return { results: [], loading: false, error: null };
}
