import { esc } from './helpers.js';
import type { InSeeAlso } from './types.js';

export function renderSeeAlso(input: InSeeAlso): string {
  if (input.links.length === 0) return '';
  const items = input.links
    .map((l) => `<li><a href="#/${l.id}" class="section-link">${esc(l.title)}</a></li>`)
    .join('\n    ');
  return `<section data-section="see-also">\n  <h2>See also</h2>\n  <ul>\n    ${items}\n  </ul>\n</section>`;
}
