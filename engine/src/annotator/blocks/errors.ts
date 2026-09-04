import { detectDpubRoleForFact, enrichFactWithSemantics, esc } from './helpers.js';
import type { InErrors } from './types.js';

/**
 * Render error pattern section for facts with kind="error" OR error keywords.
 * Enhanced: detect errors by kind AND patterns; add DPub roles.
 * Returns empty string when no errors are detected.
 */
export function renderErrors(input: InErrors): string {
  const errors = input.facts.filter(
    (f) =>
      f.kind === 'error' ||
      /\b(?:error|failed|crash|exception|enoent|eacces|typeerror|syntaxerror|timeout|broken)/i.test(
        f.text,
      ) ||
      // French mirror — no \b around the accented alternatives (JS's \b is
      // ASCII-\w-only and would fail right after/before an accented letter).
      /(?:erreur|échec|échoué|planté|plantage|cassé|bogue)/i.test(f.text),
  );
  if (errors.length === 0) return '';
  const items = errors.slice(0, 5).map((e) => {
    const sig = e.text.replace(/:\d+/g, '').slice(0, 80).toLowerCase();
    const role = detectDpubRoleForFact(e.text) ?? 'doc-warning';
    return [
      `    <details data-error="${esc(sig)}" aria-expanded="false">`,
      `      <summary>Error: ${e.text.split('\n')[0].slice(0, 50)}...</summary>`,
      `      <p role="${role}">${enrichFactWithSemantics(esc(e.text))}</p>`,
      '    </details>',
    ].join('\n');
  });
  return [`  <section data-section="errors">`, ...items, '  </section>'].join('\n');
}
