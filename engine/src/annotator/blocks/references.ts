import { esc } from './helpers.js';
import type { InReferences } from './types.js';

/**
 * Render references section with file and tool citations.
 * Uses <data value="..."> for file paths (MDN spec: not <cite>, which is for creative works).
 * Returns empty string when no files are referenced.
 */
export function renderReferences(input: InReferences): string {
  const allFiles = [...(input.filesModified ?? []), ...(input.filesRead ?? [])];
  if (allFiles.length === 0) return '';
  const fileLinks = allFiles
    .map((f) => {
      const basename = f.split(/[\\/]/).pop() ?? f;
      return `<data value="${esc(f)}">${esc(basename)}</data>`;
    })
    .join(', ');
  return [`  <section data-section="references">`, `    ${fileLinks}`, '  </section>'].join('\n');
}
