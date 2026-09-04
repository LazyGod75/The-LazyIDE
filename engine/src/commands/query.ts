import { structuralQuery } from '../indexer/structural.js';
import { assertBrainExists } from '../util/brain-guard.js';

export interface QueryCliOptions {
  selector: string;
  attribute?: string;
  limit?: number;
  strip?: boolean;
  pretty?: boolean;
}

export function runQuery(opts: QueryCliOptions): string {
  // BRAIN-NOT-FOUND guard: fail early with a clear message rather than
  // returning silent empty results that hide misconfiguration.
  assertBrainExists();

  // structuralQuery throws "Invalid CSS selector: ..." for unparseable selectors.
  // Let the error propagate — bin/lazybrain.ts handle() will write it to stderr
  // and exit 1. A valid-but-zero-match selector returns an empty array (exit 0).
  const hits = structuralQuery(opts.selector, {
    attribute: opts.attribute,
    limit: opts.limit ?? 50,
  });

  if (opts.strip) {
    return hits.map((h) => h.text).join('\n\n');
  }
  if (opts.pretty) {
    if (hits.length === 0) return '0 matches';
    return hits
      .map((h) => `${h.noteId}${h.attribute ? ` [${h.attribute}]` : ''}\n  ${h.text}`)
      .join('\n\n');
  }
  return JSON.stringify({ count: hits.length, hits }, null, 2);
}
