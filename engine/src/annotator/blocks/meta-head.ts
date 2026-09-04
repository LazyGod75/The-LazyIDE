import { esc } from './helpers.js';
import type { InMetaHead } from './types.js';

/**
 * Render <meta> tags for head: answers, aliases, commit-ref, backlinks.
 * Returns empty string when no meta content is present.
 */
export function renderMetaHead(input: InMetaHead): string {
  const metas: string[] = [];
  if (input.answers) {
    metas.push(`<meta name="answers" content="${esc(input.answers)}">`);
  }
  if (input.aliases) {
    metas.push(`<meta name="aliases" content="${esc(input.aliases)}">`);
  }
  if (input.commitRef) {
    metas.push(`<meta name="commit-ref" content="${esc(input.commitRef)}">`);
  }
  if (input.backlinkCount != null && input.backlinkCount > 0) {
    metas.push(`<meta name="backlinks" content="${input.backlinkCount}">`);
  }
  return metas.length > 0 ? metas.join('\n') : '';
}
