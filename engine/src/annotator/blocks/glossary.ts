import { esc } from './helpers.js';
import type { InGlossary } from './types.js';

/**
 * Render glossary aside for notes with >= 2 entities.
 * Entity keys are "<type>:<key>" — split into label parts.
 * Returns empty string when fewer than 2 entities are present.
 */
export function renderGlossary(input: InGlossary): string {
  if (input.entities.length < 2) return '';
  const items = input.entities.slice(0, 8).map((e) => {
    const colonIdx = e.indexOf(':');
    const typeLabel = colonIdx > -1 ? e.slice(0, colonIdx) : 'entity';
    const key = colonIdx > -1 ? e.slice(colonIdx + 1) : e;
    const display = key.replace(/-/g, ' ');
    return [
      `    <dt><dfn id="${esc(key)}">${esc(display)}</dfn></dt>`,
      `    <dd>${esc(typeLabel)}</dd>`,
    ].join('');
  });
  return [`  <aside class="glossary">`, '    <dl>', ...items, '    </dl>', '  </aside>'].join('\n');
}
