import { readFileSync, writeFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { getNoteById, indexNote } from '../indexer/fts.js';
import { readNote } from '../store/reader.js';

export interface LinkCliOptions {
  fromId: string;
  toId: string;
  type?: string;
  strength?: number;
  pretty?: boolean;
}

const VALID_TYPES = new Set([
  'refines',
  'contradicts',
  'generalizes',
  'cites',
  'replaces',
  'follows-from',
]);

export function runLink(opts: LinkCliOptions): string {
  if (opts.type && !VALID_TYPES.has(opts.type)) {
    throw new Error(
      `Invalid link type "${opts.type}". Expected one of: ${[...VALID_TYPES].join(', ')}`,
    );
  }

  const from = getNoteById(opts.fromId);
  const to = getNoteById(opts.toId);
  if (!from) throw new Error(`Source note not found: ${opts.fromId}`);
  if (!to) throw new Error(`Target note not found: ${opts.toId}`);

  // Compute relative href from "from" to "to"
  const href = `${relativeHref(from.path, to.path)}#${opts.toId}`;

  const html = readFileSync(from.path, 'utf8');
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
  const root =
    document.querySelector(`#${cssEscape(opts.fromId)}`) ?? document.querySelector('article');
  if (!root) throw new Error(`Cannot find root element in ${from.path}`);

  // Append a links section if missing
  let linksSection = root.querySelector('section[data-cerveau-links]');
  if (!linksSection) {
    linksSection = document.createElement('section');
    linksSection.setAttribute('data-cerveau-links', '');
    const heading = document.createElement('h3');
    heading.textContent = 'Liens';
    linksSection.appendChild(heading);
    const ul = document.createElement('ul');
    linksSection.appendChild(ul);
    root.appendChild(linksSection);
  }
  const ul = linksSection.querySelector('ul');
  if (!ul) throw new Error('links section malformed');

  const li = document.createElement('li');
  const a = document.createElement('a');
  a.setAttribute('href', href);
  if (opts.type) a.setAttribute('data-cerveau-link-type', opts.type);
  if (opts.strength !== undefined) {
    a.setAttribute('data-cerveau-link-strength', opts.strength.toFixed(2));
  }
  a.textContent = to.title || opts.toId;
  li.appendChild(a);
  ul.appendChild(li);

  writeFileSync(from.path, root.outerHTML, 'utf8');
  indexNote(readNote(from.path));

  const payload = {
    from: opts.fromId,
    to: opts.toId,
    type: opts.type ?? null,
    strength: opts.strength ?? null,
    href,
  };
  return opts.pretty
    ? `Linked ${opts.fromId} —[${opts.type ?? 'link'}]→ ${opts.toId}`
    : JSON.stringify(payload, null, 2);
}

function cssEscape(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function relativeHref(fromPath: string, toPath: string): string {
  const fromParts = fromPath.replace(/\\/g, '/').split('/');
  const toParts = toPath.replace(/\\/g, '/').split('/');
  fromParts.pop(); // drop filename
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.slice(i).map(() => '..');
  const down = toParts.slice(i);
  const rel = [...up, ...down].join('/');
  return rel || `./${toParts[toParts.length - 1]}`;
}
