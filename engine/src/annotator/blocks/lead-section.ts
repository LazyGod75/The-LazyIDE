import { esc } from './helpers.js';
import type { InLeadSection } from './types.js';

export function renderLeadSection(input: InLeadSection): string {
  if (!input.subject && !input.description) return '';
  return `<section data-section="lead">\n  <p><b>${esc(input.subject)}</b> ${esc(input.description)}</p>\n</section>`;
}
