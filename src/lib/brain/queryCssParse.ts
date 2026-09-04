/* queryCssParse — parse the pretty-text output of brain_query_css into
   structured note ids, and extract author attributes from note HTML. */

/** Extract note ids (without the leading #) from queryCss pretty output.
    Each hit line starts with `#<id>` followed by stripped text. */
export function parseNoteIds(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^#(\S+)/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

export interface AuthorInfo {
  authorId: string;
  author: string;
}

/** Extract distinct author-id + author name pairs from a note's HTML
    <article> by reading its data-cerveau-author-id / data-cerveau-author
    attributes. Returns at most one entry per distinct author-id. */
export function parseAuthorsFromHtml(html: string): AuthorInfo[] {
  const seen = new Map<string, string>();
  const idRe = /data-cerveau-author-id="([^"]+)"/g;
  const nameRe = /data-cerveau-author="([^"]+)"/g;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(html)) !== null) ids.push(m[1]);
  const names: string[] = [];
  while ((m = nameRe.exec(html)) !== null) names.push(m[1]);
  for (let i = 0; i < ids.length; i++) {
    if (!seen.has(ids[i])) seen.set(ids[i], names[i] ?? ids[i]);
  }
  if (ids.length === 0) {
    for (const name of names) {
      if (!seen.has(name)) seen.set(name, name);
    }
  }
  return Array.from(seen, ([authorId, author]) => ({ authorId, author }));
}

/** First data-cerveau-created timestamp on the note, or null. */
export function parseCreatedFromHtml(html: string): string | null {
  const m = html.match(/data-cerveau-created="([^"]+)"/);
  return m?.[1] ?? null;
}

/** Display identity for NoteMeta chips. Author is never on BrainNoteMeta. */
export function parseNoteIdentity(html: string): { author?: string; when?: string } {
  const authors = parseAuthorsFromHtml(html);
  const created = parseCreatedFromHtml(html);
  const author = authors[0]?.author;
  return {
    ...(author ? { author } : {}),
    ...(created ? { when: created.slice(0, 10) } : {}),
  };
}
