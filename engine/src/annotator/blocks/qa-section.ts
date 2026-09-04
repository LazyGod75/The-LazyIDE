import { enrichFactWithSemantics, esc } from './helpers.js';
import type { InQaSection } from './types.js';

/**
 * Render Q/A section from pre-extracted QA pairs.
 * Returns empty string when no pairs are provided.
 */
export function renderQaSection(input: InQaSection): string {
  if (input.pairs.length === 0) return '';
  const items = input.pairs
    .slice(0, 5)
    .map(({ question, answer }) =>
      [
        `    <details data-q="${esc(question.toLowerCase().replace(/\s+/g, '-'))}" aria-expanded="false">`,
        `      <summary>${esc(question)}</summary>`,
        `      <p>${enrichFactWithSemantics(esc(answer))}</p>`,
        '    </details>',
      ].join('\n'),
    );
  return [`  <section data-section="qa">`, ...items, '  </section>'].join('\n');
}

/**
 * Extract implicit Q/A from facts containing "why", "how", "what", "when".
 * Returns tuples [question, answer] for facts that match.
 */
export function extractQaPatterns(
  facts: Array<{ text: string; confidence: number; kind: string }>,
): Array<[string, string]> {
  const qa: Array<[string, string]> = [];
  for (const f of facts) {
    const text = f.text.toLowerCase();
    if (text.includes('why ')) {
      const prefix = text.split('why ')[0].trim();
      qa.push([`Why ${prefix}?`, f.text]);
    } else if (text.includes('how ')) {
      const prefix = text.split('how ')[0].trim();
      qa.push([`How to ${prefix}?`, f.text]);
    } else if (text.includes('what ')) {
      const prefix = text.split('what ')[0].trim();
      qa.push([`What ${prefix}?`, f.text]);
    } else if (text.includes('when ')) {
      const prefix = text.split('when ')[0].trim();
      qa.push([`When should ${prefix}?`, f.text]);
    } else if (text.includes('pourquoi ')) {
      const prefix = text.split('pourquoi ')[0].trim();
      qa.push([`Pourquoi ${prefix}?`, f.text]);
    } else if (text.includes('comment ')) {
      const prefix = text.split('comment ')[0].trim();
      qa.push([`Comment ${prefix}?`, f.text]);
    } else if (text.includes('quand ')) {
      const prefix = text.split('quand ')[0].trim();
      qa.push([`Quand ${prefix}?`, f.text]);
    }
  }
  return qa.slice(0, 5);
}
