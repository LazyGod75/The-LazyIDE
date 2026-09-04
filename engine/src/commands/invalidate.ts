import { readFileSync, writeFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { getNoteById, indexNote } from '../indexer/fts.js';
import { readNote } from '../store/reader.js';

export interface InvalidateCliOptions {
  id: string;
  replacedBy?: string;
  reason?: string;
  pretty?: boolean;
}

export function runInvalidate(opts: InvalidateCliOptions): string {
  const note = getNoteById(opts.id);
  if (!note) throw new Error(`Note not found: ${opts.id}`);

  const html = readFileSync(note.path, 'utf8');
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
  const root =
    document.querySelector(`#${cssEscape(opts.id)}`) ?? document.querySelector('article');
  if (!root) throw new Error(`Root element with id="${opts.id}" not found in ${note.path}`);

  const today = new Date().toISOString().slice(0, 10);
  root.setAttribute('data-cerveau-valid-until', today);
  root.setAttribute('data-cerveau-updated', new Date().toISOString());
  if (opts.replacedBy) {
    root.setAttribute('data-cerveau-invalidated-by', `#${opts.replacedBy}`);
    root.setAttribute('data-cerveau-superseded-by', `#${opts.replacedBy}`);
  }
  if (opts.reason) {
    root.setAttribute('data-cerveau-invalidate-reason', opts.reason);
  }

  const updated = root.outerHTML;
  writeFileSync(note.path, updated, 'utf8');
  indexNote(readNote(note.path));

  const payload = {
    id: opts.id,
    path: note.path,
    valid_until: today,
    invalidated_by: opts.replacedBy ? `#${opts.replacedBy}` : null,
  };

  return opts.pretty
    ? `Invalidated ${opts.id} on ${today}${opts.replacedBy ? ` (replaced by #${opts.replacedBy})` : ''}`
    : JSON.stringify(payload, null, 2);
}

function cssEscape(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
