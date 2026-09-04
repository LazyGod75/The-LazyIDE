import { esc } from './helpers.js';
import type { InInfobox } from './types.js';

/**
 * Render the infobox aside with a dl of metadata rows.
 * Returns empty string when no rows are provided.
 */
export function renderInfobox(input: InInfobox): string {
  if (input.rows.length === 0) return '';
  const rows = input.rows.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`);
  return [
    `<aside class="infobox">`,
    '  <dl>',
    ...rows.map((r) => `    ${r}`),
    '  </dl>',
    '</aside>',
  ].join('\n');
}
