import type { IndexedNote } from '../indexer/fts.js';

export interface DedupResult {
  duplicatePairs: Array<{ noteA: string; noteB: string; similarity: number }>;
  mergedCount: number;
}

function trigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const tg = new Set<string>();
  for (let i = 0; i < words.length - 2; i++) {
    tg.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return tg;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

export function findDuplicates(notes: IndexedNote[], threshold = 0.7): DedupResult {
  const result: DedupResult = { duplicatePairs: [], mergedCount: 0 };

  const noteGrams = notes.map((n) => ({
    id: n.id,
    grams: trigrams(`${n.title} ${n.tldr ?? ''} ${n.section_tldr ?? ''}`),
  }));

  // Cap at 1000 notes to avoid O(n^2) explosion
  const cap = Math.min(noteGrams.length, 1000);
  for (let i = 0; i < cap; i++) {
    for (let j = i + 1; j < cap; j++) {
      const sim = jaccardSimilarity(noteGrams[i].grams, noteGrams[j].grams);
      if (sim >= threshold) {
        result.duplicatePairs.push({
          noteA: noteGrams[i].id,
          noteB: noteGrams[j].id,
          similarity: sim,
        });
      }
    }
  }

  result.mergedCount = result.duplicatePairs.length;
  return result;
}
