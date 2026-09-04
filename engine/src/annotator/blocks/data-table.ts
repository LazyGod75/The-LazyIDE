import { esc } from './helpers.js';
import type { InDataTable } from './types.js';

export function renderDataTable(input: InDataTable): string {
  if (input.rows.length === 0) return '';
  const cls = input.sortable ? 'wikitable sortable' : 'wikitable';
  const ths = input.headers.map((h) => `<th scope="col">${esc(h)}</th>`).join('');
  const trs = input.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
    .join('\n    ');
  return `<table class="${cls}">\n  <caption>${esc(input.caption)}</caption>\n  <thead><tr>${ths}</tr></thead>\n  <tbody>\n    ${trs}\n  </tbody>\n</table>`;
}
