/**
 * recompose-all.ts — batch recompose: patch authored items into every
 * file-neuron that has them, WITHOUT rescanning code.
 *
 * Gathers all authored items (capture notes carrying data-cerveau-author-id
 * and data-cerveau-about) from the brain, groups them by target file path,
 * and calls recomposeFileNeuronEnrichment on each matching file-neuron.
 *
 * No-op when the brain has no authored items (solo brain). Idempotent: the
 * authored-item set is read fresh from capture notes each run, and
 * recomposeFileNeuronEnrichment deterministically rebuilds sections from
 * that set, so two consecutive runs produce identical output.
 */

import {
  type AuthoredItem,
  recomposeFileNeuronEnrichment,
} from '../annotator/blocks/composers/recompose.js';
import { indexNote } from '../indexer/fts.js';
import { type NoteFile, readAllNotes, readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { getLogger } from '../util/logger.js';

export interface RecomposeAllReport {
  fileNeuronsRecomposed: number;
  authoredItemsFound: number;
  skipped: boolean;
  errors: string[];
}

/**
 * The article-level "authored item kind" vocabulary that recompose.ts's
 * SECTION_META groups file-neuron enrichment items by: decision, bug, idea,
 * rule, qa, warning, activity (see CaptureEvent.itemKind in
 * src/lib/platform/types.ts). "decision" is handled separately in
 * deriveAuthoredKind() via data-cerveau-type, so it is not repeated here.
 *
 * Ordered by how actionable/urgent the category is — bugs and warnings
 * outrank the softer categories — since deriveAuthoredKind() picks the FIRST
 * match when a note's tags happen to contain more than one vocabulary word.
 */
export const TAG_KIND_PRIORITY = ['bug', 'warning', 'idea', 'rule', 'qa', 'activity'] as const;

/**
 * Derive the authored `kind` (decision|bug|idea|rule|qa|warning|activity)
 * for a capture note, from whichever field actually carries the signal.
 *
 * `data-cerveau-kind` on the note's <article> — what this function used to
 * read exclusively — is written from CaptureEvent.itemKind
 * (src-tauri/src/commands/brain/capture.rs), and NO TypeScript caller in
 * this codebase ever sets `itemKind` (verified by exhaustive repo search,
 * 2026-08-16: only the type declaration and the Rust struct field reference
 * it). So that attribute never appears on a real capture note, and the old
 * code's `if (!kind) return null` fired for every single note — the whole
 * authored-items pipeline was silently a no-op.
 *
 * Two fields genuinely ARE populated by capture.rs's event_to_html for every
 * note, and are already what the LLM system prompt (systemPrompts.ts's
 * STRUCTURAL_BRAIN_GROUNDING) teaches agents to query instead of the dead
 * per-item selector:
 *   - `data-cerveau-type`, always one of decision|procedural|episodic|learning
 *     (the cerveau_type mapping in capture.rs). Only "decision" overlaps the
 *     itemKind vocabulary, so that is the only value mapped here.
 *   - `data-cerveau-tags`, a free-form whole-word tag list (e.g. "bug",
 *     "warning") that authors/agents attach at capture time.
 *
 * Priority: an explicit `data-cerveau-kind` wins when present (forward
 * compatible — if a future capture path starts writing itemKind, this needs
 * no change), then type==="decision", then the first TAG_KIND_PRIORITY word
 * found in the tags. Returns undefined — not a guess — when none of the
 * three sources yields anything, so a genuinely unauthored note still
 * extracts to null downstream.
 */
export function deriveAuthoredKind(html: string): string | undefined {
  const explicit = html.match(/data-cerveau-kind\s*=\s*["']([^"']+)["']/i)?.[1];
  if (explicit) return explicit;

  const type = html.match(/data-cerveau-type\s*=\s*["']([^"']+)["']/i)?.[1];
  if (type === 'decision') return 'decision';

  const tagsAttr = html.match(/data-cerveau-tags\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
  const tagWords = new Set(tagsAttr.toLowerCase().split(/\s+/).filter(Boolean));
  for (const candidate of TAG_KIND_PRIORITY) {
    if (tagWords.has(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Extract an AuthoredItem from a capture note's HTML.
 *
 * Capture notes (rendered by src-tauri capture.rs) carry author attribution
 * as article-level attributes:
 *   data-cerveau-author-id, data-cerveau-author, data-cerveau-kind,
 *   data-cerveau-about, data-cerveau-project, data-cerveau-org-id,
 *   data-cerveau-created
 * The fact text lives in <p data-cerveau-fact>.
 *
 * `kind` is resolved via deriveAuthoredKind() (see its doc comment) rather
 * than a direct data-cerveau-kind read — that attribute is never written by
 * any capture path today.
 *
 * NOTE: `about` (data-cerveau-about, from CaptureEvent.about) has the exact
 * same problem as itemKind did — no TypeScript caller ever sets it either
 * (verified the same way) — so this gate below still returns null for every
 * real note in this codebase today, independent of the kind fix above.
 * Populating `about` means wiring a "this capture is about file X" affordance
 * into an actual UI/agent capture flow, which is a separate, larger change
 * than this function's scope (see the mission report for detail). Left as-is
 * here rather than silently widened.
 */
export function extractAuthoredItem(html: string, noteId: string): AuthoredItem | null {
  const authorId = html.match(/data-cerveau-author-id\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!authorId) return null;

  const about = html.match(/data-cerveau-about\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!about) return null;

  const kind = deriveAuthoredKind(html);
  if (!kind) return null;

  const author = html.match(/data-cerveau-author\s*=\s*["']([^"']+)["']/i)?.[1];
  const project = html.match(/data-cerveau-project\s*=\s*["']([^"']+)["']/i)?.[1];
  const orgId = html.match(/data-cerveau-org-id\s*=\s*["']([^"']+)["']/i)?.[1];
  const created = html.match(/data-cerveau-created\s*=\s*["']([^"']+)["']/i)?.[1] ?? '';
  const date = created.slice(0, 10) || new Date().toISOString().slice(0, 10);

  const factMatch = html.match(/<p\s+data-cerveau-fact[^>]*>([\s\S]*?)<\/p>/i);
  const rawText = factMatch ? factMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  if (!rawText) return null;

  const confidenceMatch = html.match(/data-cerveau-confidence\s*=\s*["']([\d.]+)["']/i);
  const confidence = confidenceMatch ? Number.parseFloat(confidenceMatch[1]) : 1.0;

  return {
    text: rawText,
    confidence,
    date,
    sourceConvLink: `#${noteId}`,
    kind,
    about,
    project,
    authorId,
    author,
    itemId: noteId,
    orgId,
  };
}

/**
 * Extract the project-relative file path from a data-cerveau-about value.
 *
 * about is emitted as "file:<relPath>" (see capture.rs CaptureEvent.about).
 * Returns the relPath with backslashes normalised to forward slashes, or null
 * when the value does not start with "file:".
 */
function filePathFromAbout(about: string): string | null {
  const match = about.match(/^file:(.+)$/i);
  if (!match) return null;
  return match[1].replace(/\\/g, '/').replace(/^\.\//, '');
}

export async function runRecomposeAll(): Promise<RecomposeAllReport> {
  const log = getLogger();
  const report: RecomposeAllReport = {
    fileNeuronsRecomposed: 0,
    authoredItemsFound: 0,
    skipped: false,
    errors: [],
  };

  let allNotes: NoteFile[];
  try {
    allNotes = readAllNotes();
  } catch (err) {
    report.errors.push((err as Error).message);
    return report;
  }

  const authoredItemsByPath = new Map<string, AuthoredItem[]>();
  for (const note of allNotes) {
    if (!note.html.includes('data-cerveau-author-id')) continue;
    if (note.html.includes('data-cerveau-type="file-neuron"')) continue;
    if (note.html.includes('data-cerveau-type="concept"')) continue;

    const item = extractAuthoredItem(note.html, note.id);
    if (!item) continue;

    const filePath = filePathFromAbout(item.about ?? '');
    if (!filePath) continue;

    const list = authoredItemsByPath.get(filePath) ?? [];
    list.push(item);
    authoredItemsByPath.set(filePath, list);
    report.authoredItemsFound += 1;
  }

  if (report.authoredItemsFound === 0) {
    report.skipped = true;
    return report;
  }

  for (const note of allNotes) {
    if (!note.html.includes('data-cerveau-type="file-neuron"')) continue;

    const fileMatch = note.html.match(/data-code-file\s*=\s*["']([^"']+)["']/i);
    if (!fileMatch) continue;
    const neuronFilePath = fileMatch[1].replace(/\\/g, '/').replace(/^\.\//, '');

    const items = authoredItemsByPath.get(neuronFilePath);
    if (!items || items.length === 0) continue;

    try {
      const file = readNote(note.path);
      const patched = recomposeFileNeuronEnrichment(file.html, items);
      if (patched === file.html) continue;

      const written = writeNote(patched, { overwrite: true });
      try {
        indexNote(readNote(written.path));
      } catch (err) {
        log.warn(
          { path: written.path, err: (err as Error).message },
          'recompose-all: reindex failed',
        );
      }
      report.fileNeuronsRecomposed += 1;
    } catch (err) {
      const msg = (err as Error).message;
      report.errors.push(`${neuronFilePath}: ${msg}`);
      log.warn({ filePath: neuronFilePath, err: msg }, 'recompose-all: file-neuron patch failed');
    }
  }

  log.debug(
    {
      authoredItemsFound: report.authoredItemsFound,
      fileNeuronsRecomposed: report.fileNeuronsRecomposed,
      errors: report.errors.length,
    },
    'recompose-all: done',
  );

  return report;
}
