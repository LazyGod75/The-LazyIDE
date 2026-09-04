import { esc } from './helpers.js';
import type { InToc } from './types.js';

export function renderToc(input: InToc): string {
  if (input.entries.length === 0) return '';
  let counter = 0;
  const items = input.entries
    .map((e) => {
      counter++;
      return `<li class="toclevel-${e.level} tocsection-${counter}"><a href="#${e.id}"><span class="tocnumber">${counter}</span> <span class="toctext">${esc(e.text)}</span></a></li>`;
    })
    .join('\n    ');
  return `<nav class="toc" role="navigation" aria-label="Table of contents">\n  <h2>Contents</h2>\n  <ol>\n    ${items}\n  </ol>\n</nav>`;
}
