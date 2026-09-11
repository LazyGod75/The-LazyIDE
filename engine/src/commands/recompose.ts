/**
 * recompose.ts — CLI command: patch enrichment sections of a file-neuron
 * from a JSON list of authored items, WITHOUT rescanning the code.
 *
 * Used by the Tauri layer after a team pull: items authored by other team
 * members are merged into the local file-neuron's enrichment sections,
 * preserving the structural parts (breadcrumb, infobox, architecture, children)
 * verbatim.
 */

import { readFileSync } from 'node:fs';
import {
  type AuthoredItem,
  recomposeFileNeuronEnrichment,
} from '../annotator/blocks/composers/recompose.js';
import { getNoteById, indexNote } from '../indexer/fts.js';
import { readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { getLogger } from '../util/logger.js';

export interface RecomposeCliOptions {
  noteId: string;
  itemsFile?: string;
  itemsStdin?: boolean;
}

export async function runRecompose(opts: RecomposeCliOptions): Promise<string> {
  const log = getLogger();
  const indexed = getNoteById(opts.noteId);
  if (!indexed) {
    throw new Error(`Note not found: ${opts.noteId}`);
  }
  const file = readNote(indexed.path);
  const existingHtml = file.html;

  let itemsRaw: string;
  if (opts.itemsFile) {
    itemsRaw = readFileSync(opts.itemsFile, 'utf8');
  } else {
    itemsRaw = await readStdin();
  }
  const items = JSON.parse(itemsRaw) as AuthoredItem[];
  if (!Array.isArray(items)) {
    throw new Error('Items payload must be a JSON array');
  }

  const patched = recomposeFileNeuronEnrichment(existingHtml, items);
  const written = writeNote(patched, { overwrite: true });
  try {
    indexNote(readNote(written.path));
  } catch (err) {
    log.warn({ path: written.path, err: (err as Error).message }, 'recompose: reindex failed');
  }

  return JSON.stringify({ noteId: written.id, itemsApplied: items.length, path: written.path });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
