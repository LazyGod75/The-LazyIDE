/* planScopeDiffs — plan review from REAL git diffs.

   Never invents a patch. Empty / "No changes" / ERROR: are omitted so the
   panel stays honest when the plan has not executed yet.
*/

export const PLAN_DIFF_MAX_FILES = 3;
export const PLAN_DIFF_MAX_CHARS = 480;

export function usablePlanDiff(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^no changes$/i.test(text)) return null;
  if (text.startsWith('ERROR:')) return null;
  return text.length > PLAN_DIFF_MAX_CHARS
    ? `${text.slice(0, PLAN_DIFF_MAX_CHARS)}…`
    : text;
}

export async function loadPlanScopeDiffs(
  paths: readonly string[],
  loadFileDiff: (path: string) => Promise<string>,
): Promise<string | null> {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))].slice(
    0,
    PLAN_DIFF_MAX_FILES,
  );
  const blocks: string[] = [];
  for (const path of unique) {
    try {
      const usable = usablePlanDiff(await loadFileDiff(path));
      if (!usable) continue;
      blocks.push(`--- ${path}\n${usable}`);
    } catch {
      // Missing / failed diffs stay omitted — never invented.
    }
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}
