import { detectDpubRoleForFact, enrichFactWithSemantics, esc } from './helpers.js';
import type { InCounterfactuals } from './types.js';

/**
 * Render counterfactual section (considered but rejected).
 * Detects "tried", "attempted", "but it didn't" patterns.
 * Returns empty string when no counterfactuals are detected.
 */
export function renderCounterfactuals(input: InCounterfactuals): string {
  const lc = (text: string) => text.toLowerCase();
  const counterfactuals = input.facts.filter(
    (f) =>
      lc(f.text).includes('considered but') ||
      lc(f.text).includes('alternative') ||
      lc(f.text).includes('tried') ||
      lc(f.text).includes('attempted') ||
      lc(f.text).includes("but it didn't") ||
      lc(f.text).includes('but it did not') ||
      // French mirror (same .includes() style as qa-section.ts's bilingual patterns)
      lc(f.text).includes('envisagé') ||
      lc(f.text).includes('essayé') ||
      lc(f.text).includes('tenté') ||
      lc(f.text).includes("n'a pas fonctionné") ||
      lc(f.text).includes("n'a pas marché"),
  );
  if (counterfactuals.length === 0) return '';
  const items = counterfactuals.slice(0, 3).map((c) => {
    const role = detectDpubRoleForFact(c.text) ?? 'doc-note';
    return `    <p role="${role}">${enrichFactWithSemantics(esc(c.text))}</p>`;
  });
  return [
    `  <aside role="doc-note" data-section="counterfactuals">`,
    '    <strong>Considered but rejected:</strong>',
    ...items,
    '  </aside>',
  ].join('\n');
}
