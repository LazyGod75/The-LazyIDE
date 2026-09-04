import { esc } from './helpers.js';
import type { InCategories } from './types.js';

/**
 * Render footer with category navigation links.
 * Returns empty string when no tags are provided.
 */
export function renderCategories(input: InCategories): string {
  if (input.tags.length === 0) return '';
  const catLinks = input.tags
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .map((t) => `<a href="#/search/${esc(t)}" class="section-link">${esc(t)}</a>`)
    .join(' · ');
  return [
    '  <footer>',
    `    <nav class="categories">Categories: ${catLinks}</nav>`,
    '  </footer>',
  ].join('\n');
}
