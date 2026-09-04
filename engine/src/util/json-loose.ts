/** Tolerant JSON-array extraction from LLM text (fences + stray prose). */
export function parseJsonArrayLoose<T = unknown>(raw: string): T[] | null {
  let cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```\s*$/, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  cleaned = cleaned.slice(start, end + 1);
  try {
    const arr = JSON.parse(cleaned);
    return Array.isArray(arr) ? (arr as T[]) : null;
  } catch {
    return null;
  }
}
