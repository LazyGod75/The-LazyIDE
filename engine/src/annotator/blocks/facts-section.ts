import { enrichFactWithSemantics, esc, renderFactAsHtml } from './helpers.js';
import type { InFactsSection } from './types.js';

/**
 * Render the TLDR + summary (first fact) + facts (remaining facts) sections.
 * Returns a combined HTML string for all three sections.
 * Each fact is wrapped in a <details> element.
 */
export function renderFactsSection(input: InFactsSection): string {
  const { facts, tldr } = input;
  const [firstFact, ...restFacts] = facts;

  const tldrText = tldr ?? firstFact?.text ?? '';
  const tldrSection = tldrText
    ? [
        `  <section data-section="tldr">`,
        `    <p>${enrichFactWithSemantics(esc(tldrText.slice(0, 200)))}</p>`,
        '  </section>',
      ].join('\n')
    : '';

  const summarySection = firstFact
    ? [
        `  <section data-section="summary">`,
        `    <details open data-primary aria-expanded="true">`,
        `      <summary>${esc(firstFact.text)}</summary>`,
        `      <div id="fact-0" data-cerveau-fact data-cerveau-confidence="${firstFact.confidence.toFixed(2)}" data-cerveau-kind="${esc(firstFact.kind)}"${firstFact.extractor ? ` data-cerveau-extracted-by="${esc(firstFact.extractor)}"` : ''}>${renderFactAsHtml(firstFact.text)}</div>`,
        '    </details>',
        '  </section>',
      ].join('\n')
    : '';

  const factsSection =
    restFacts.length > 0
      ? [
          `  <section data-section="facts">`,
          ...restFacts.map((f, idx) =>
            [
              `    <details aria-expanded="false">`,
              `      <summary>${esc(f.text)}</summary>`,
              `      <div id="fact-${idx + 1}" data-cerveau-fact data-cerveau-confidence="${f.confidence.toFixed(2)}" data-cerveau-kind="${esc(f.kind)}"${f.extractor ? ` data-cerveau-extracted-by="${esc(f.extractor)}"` : ''}>${renderFactAsHtml(f.text)}</div>`,
              '    </details>',
            ].join('\n'),
          ),
          '  </section>',
        ].join('\n')
      : '';

  return [tldrSection, summarySection, factsSection].filter(Boolean).join('\n');
}
