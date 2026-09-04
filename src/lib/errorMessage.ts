/* errorMessage.ts — shared error-message normalization (F7 fix: dedup of
   updateStore.ts and browserRecipe.ts's two identical local copies of this
   exact function).

   Pure extraction, no logic change: `err instanceof Error ? err.message :
   String(err)`. The case that originally motivated this exact shape is a
   DOMException — see errorMessage.test.ts for a constructed DOMException
   proving the extraction preserves the original behavior unchanged.
*/

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
