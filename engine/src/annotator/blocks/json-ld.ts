import { esc } from './helpers.js';
import type { InJsonLd } from './types.js';

/**
 * Render JSON-LD structured data script block for SEO/schema.
 * Always renders a TechArticle type with the provided metadata.
 */
export function renderJsonLd(input: InJsonLd): string {
  const jsonLdData: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    '@id': `memory://${esc(input.title)}`,
    name: input.title,
    dateCreated: input.dateCreated,
    keywords: input.tags.join(','),
  };
  if (input.description) {
    jsonLdData.description = input.description;
  }
  const jsonLd = `  <script type="application/ld+json">\n${JSON.stringify(jsonLdData, null, 2)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}\n  </script>`;
  return jsonLd;
}
