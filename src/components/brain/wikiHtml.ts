/* wikiHtml.ts — sanitize engine-generated brain HTML (synthesized wiki pages)
   for safe rendering via dangerouslySetInnerHTML in WikiPage.

   The source is the user's own local brain sidecar (all user-supplied text is
   already run through the engine's esc() helper), but we still strip anything
   executable defensively: <script>/<style>/<iframe>/<object>/<embed>/<link>/
   <meta>/<base>/<form>, every on* event-handler attribute, and
   javascript:/data: URLs on href/src. Internal `#/...` wiki links are left
   intact — WikiPage intercepts their clicks for in-view navigation.

   Also fixes up one known cosmetic defect in the engine's brain-index HTML
   (see dedupeLeadSentence below) rather than leaving it for every viewer to
   read literally. */

const DANGEROUS_TAGS = [
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form',
];

export function sanitizeWikiHtml(html: string): string {
  if (typeof DOMParser === 'undefined') {
    // Non-DOM environment (should never happen in the renderer or jsdom) —
    // textual last resort so we never emit a raw <script>.
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const tag of DANGEROUS_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  }

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src') && /^\s*(javascript|data):/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  dedupeLeadSentence(doc);

  return doc.body.innerHTML;
}

/** The engine's brain-index composer always wraps its lead paragraph as
    `<p><b>This brain</b> ${leadText}</p>` (see
    engine/src/annotator/blocks/composers/brain-index.ts), but `leadText`
    itself already starts with "This brain covers ..." (see engine's
    synthesize.ts), so the rendered sentence literally reads "This brain
    This brain covers ...". Purely cosmetic and narrowly targeted: only
    strips the redundant duplicate leading "This brain" when the exact known
    pattern is present (bold lead-in reading precisely "This brain",
    immediately followed by text that itself starts with "This brain") —
    any other lead sentence is left untouched. */
function dedupeLeadSentence(doc: Document): void {
  const lead = doc.querySelector('section[data-section="lead"] > p');
  if (!lead) return;
  const bold = lead.querySelector('b');
  if (!bold || bold.textContent?.trim() !== 'This brain') return;
  const next = bold.nextSibling;
  if (!next || next.nodeType !== Node.TEXT_NODE) return;
  const text = next.textContent ?? '';
  const match = text.match(/^\s*This brain\b/i);
  if (match) {
    next.textContent = text.slice(match[0].length);
  }
}
