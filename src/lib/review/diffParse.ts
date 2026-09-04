/* diffParse.ts — pure unified-diff parsing helpers shared by ReviewSpace and
   the Code space's diff drawer (D12). Lifted from ReviewSpace.tsx's private
   parseDiffLines/countDiffLines (ReviewSpace.tsx itself is left untouched —
   this is a fresh, shared home for the same logic so the new drawer isn't
   forced to duplicate it ad hoc). */

export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'context';

export interface DiffLine {
  type: DiffLineKind;
  content: string;
}

/** Convert a raw unified diff string into DiffLine[]. */
export function parseDiffLines(raw: string): DiffLine[] {
  return raw.split('\n').map((content): DiffLine => {
    if (content.startsWith('@@')) return { type: 'hunk', content };
    if (content.startsWith('+') && !content.startsWith('+++')) return { type: 'add', content: content.slice(1) };
    if (content.startsWith('-') && !content.startsWith('---')) return { type: 'remove', content: content.slice(1) };
    return { type: 'context', content };
  });
}

/** Count +/- lines in a diff string. */
export function countDiffLines(raw: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}
