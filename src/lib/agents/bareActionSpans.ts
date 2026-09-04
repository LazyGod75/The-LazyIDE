/* bareActionSpans — scan prose for top-level `{"type": ...}` JSON objects.

   Measured 2026-08-28: extractBareActionObjectSpans cyclomatic complexity
   was 17 (ESLint ceiling 12) while nested inside managerEngine.ts. The
   string-aware brace walk lives here so salvageBareActionsJson stays a
   conservative validator, not a JSON scanner.
*/

export interface BareActionSpan {
  raw: string;
  obj: Record<string, unknown>;
}

/** Walk from `start` (a `{`) to the matching top-level `}`, ignoring braces
    inside strings. Unclosed → null. */
export function closeJsonObject(text: string, start: number): { raw: string; end: number } | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { raw: text.slice(start, j + 1), end: j + 1 };
    }
  }
  return null;
}

export function parseTypedJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (typeof (obj as Record<string, unknown>).type !== 'string') return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractBareActionObjectSpans(text: string): BareActionSpan[] {
  const spans: BareActionSpan[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      i += 1;
      continue;
    }
    const closed = closeJsonObject(text, i);
    if (!closed) break;
    const obj = parseTypedJsonObject(closed.raw);
    if (obj) spans.push({ raw: closed.raw, obj });
    i = closed.end;
  }
  return spans;
}
