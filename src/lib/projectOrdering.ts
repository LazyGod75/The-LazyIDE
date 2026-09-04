/* projectOrdering.ts — pure ordering helper for multi-project lists (F6 fix,
   post-e2e wave): the Code sidebar's PROJETS section must render the active
   project FIRST (design-code.md §4.2), all other open projects keeping
   their existing relative order.

   Pure, no I/O, generic over any entry shape carrying an `id` — reused by
   CodeSidebarProjects.tsx (ProjectEntry) and unit-tested in isolation
   without mounting React or mocking the platform/fs layer.
*/

interface HasId {
  id: string;
}

/**
 * Moves the entry whose `id` matches `activeId` to the front of `entries`,
 * preserving the relative order of everything else. No-op (same array
 * reference semantics — a new array, same order) when `activeId` is null,
 * not found, or already first.
 */
export function orderActiveFirst<T extends HasId>(entries: readonly T[], activeId: string | null): T[] {
  if (!activeId) return [...entries];
  const activeIdx = entries.findIndex((e) => e.id === activeId);
  if (activeIdx <= 0) return [...entries];
  const active = entries[activeIdx];
  return [active, ...entries.slice(0, activeIdx), ...entries.slice(activeIdx + 1)];
}
