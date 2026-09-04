/* yoloLaunchRootDrafts — YOLO + create_draft must actually run.

   create_draft is classified SAFE (canvas authoring). launch_draft is
   SENSITIVE. In YOLO the manager often emits create_draft + chain_agents
   and forgets launch_draft, so the board shows "Waiting" drafts forever
   (measured 2026-08-31: session join/leave drafts never became missions).

   Chain semantics: only launch ROOTS (no incoming chain). Downstream
   drafts fire via chainEngine when the upstream mission succeeds.
*/

import { parseRef } from './canvasTypes';

export function rootDraftIdsToLaunch(
  liveDraftIds: readonly string[],
  chains: readonly { sourceRef: string; targetRef: string }[],
): string[] {
  const live = new Set(liveDraftIds);
  const hasIncoming = new Set<string>();
  for (const chain of chains) {
    const target = parseRef(chain.targetRef);
    if (target?.kind === 'draft' && live.has(target.id)) {
      hasIncoming.add(target.id);
    }
  }
  return liveDraftIds.filter((id) => !hasIncoming.has(id));
}

export function draftIdsFromAliasMap(aliasMap: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  for (const ref of aliasMap.values()) {
    const parsed = parseRef(ref);
    if (parsed?.kind === 'draft') ids.push(parsed.id);
  }
  return ids;
}
