import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getNoteById } from '../indexer/note-read.js';
import { validateNote } from '../schema/validator.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';
import { notePath, slug } from './paths.js';
import { isRicherBody, mergeUpsertHtml, stampCreatedAndUpdated } from './upsert.js';

export interface WriteOptions {
  overwrite?: boolean;
  /**
   * When true and a note with the same id already exists, upsert instead of
   * conflicting or blindly overwriting: replace the stored body ONLY if the
   * new HTML is richer (strictly more alphanumeric words — see upsert.ts's
   * isRicherBody) than what's already on disk. data-cerveau-created is
   * preserved from the EXISTING note; data-cerveau-updated is refreshed to
   * now. When the new HTML is NOT richer, this is a no-op: the existing
   * note is left untouched and its info is returned with `unchanged: true`.
   *
   * This is the "smart" upsert path, distinct from `overwrite` (a blind
   * replace with no comparison). If both are set, upsertIfRicher takes
   * precedence. Introduced for mission-completion captures (learningLoop.ts)
   * which reuse the sparse kickoff note's id and must never silently lose
   * the richer completion text to a ConflictError.
   */
  upsertIfRicher?: boolean;
}

export interface WriteResult {
  id: string;
  path: string;
  sizeBytes: number;
  attrsCount: number;
  /** True only when upsertIfRicher requested a replace but the candidate
   *  was not richer than the existing note, so nothing was written. */
  unchanged?: boolean;
}

/**
 * Persist a note. The note HTML is validated against the cerveau schema.
 * Throws if validation fails (exit code 4 from CLI).
 *
 * Regeneration safety: several composers (file-neuron, aggregate-neuron,
 * topic-overview, brain-index, concept-*, synthesize.ts's periodic passes)
 * always stamp data-cerveau-created with "now" when they re-render an
 * EXISTING id. notePath() partitions storage by month, so trusting that
 * stamped value would target a fresh month folder on every regeneration
 * after a calendar-month boundary — overwrite:true then overwrites nothing,
 * because nothing exists yet at the new path, and the previous month's file
 * is silently orphaned forever. Measured on the owner's real brain: 2133 of
 * 2404 unindexed files (89%) were exactly this.
 *
 * The fix (resolveExistingNoteLocation, below): resolve the id's EXISTING
 * on-disk path from the SQLite index (a SQL PRIMARY KEY — always exactly
 * one row per id) instead of recomputing notePath(id, now), and preserve
 * the index's recorded created timestamp instead of the composer's stamped
 * one. Falls back to today's notePath(id, created) behavior whenever the
 * index has no row for this id (stale/missing index, or a genuinely new
 * note) — a write must never be blocked by an untrustworthy index.
 */
export function writeNote(html: string, opts: WriteOptions = {}): WriteResult {
  const validation = validateNote(html);
  if (!validation.ok) {
    const msgs = validation.issues
      .filter((i) => i.level === 'error')
      .map((i) => `[${i.code}] ${i.message}`)
      .join('\n');
    throw new SchemaError(`Schema validation failed:\n${msgs}`);
  }

  // Extract id + created from HTML
  const idMatch = html.match(/<(?:article|section)\b[^>]*\bid\s*=\s*["']([^"']+)["']/i);
  if (!idMatch) throw new SchemaError('Note has no id attribute on root element.');
  const id = slug(idMatch[1]);

  const createdMatch = html.match(/data-cerveau-created\s*=\s*["']([^"']+)["']/i);
  const candidateCreated = createdMatch?.[1];

  const existing = resolveExistingNoteLocation(id);
  const target = existing?.path ?? notePath(id, candidateCreated);

  if (existsSync(target) && opts.upsertIfRicher) {
    return upsertExisting(target, id, html, validation.attrsCount);
  }

  if (existsSync(target) && !opts.overwrite) {
    throw new ConflictError(`Note already exists: ${target}. Pass overwrite to replace.`);
  }

  // Preserve the id's ORIGINAL created timestamp and record this write as
  // data-cerveau-updated — same rule upsertExisting() applies below for the
  // upsertIfRicher path. Without this, RECENT NOTES / active-decision
  // windows (which sort/filter by created) would treat a barely-changed
  // regenerated note as brand new on every pass.
  const finalHtml = existing ? stampCreatedAndUpdated(html, existing.created, nowIso()) : html;

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, finalHtml, 'utf8');

  const sizeBytes = Buffer.byteLength(finalHtml, 'utf8');
  logTelemetry({
    event: 'store',
    ts: nowIso(),
    note_id: id,
    size_bytes: sizeBytes,
    attrs_count: validation.attrsCount,
  });

  return { id, path: target, sizeBytes, attrsCount: validation.attrsCount };
}

/**
 * Look up an already-indexed note's on-disk path and ORIGINAL created
 * timestamp by id. See writeNote()'s doc comment for the defect this exists
 * to fix and structural.ts's indexIsTrustworthy() for the measured blast
 * radius on a real brain.
 *
 * Never throws: getDb()/getNoteById() failures (missing/corrupt index,
 * brain cache not yet initialized) resolve to `undefined`, so the caller
 * falls back to today's notePath(id, created) behavior unchanged.
 */
function resolveExistingNoteLocation(id: string): { path: string; created: string } | undefined {
  try {
    const row = getNoteById(id);
    if (!row?.path || !row.created) return undefined;
    return { path: row.path, created: row.created };
  } catch {
    return undefined;
  }
}

/**
 * Handles the upsertIfRicher branch of writeNote() when a note already
 * exists at `target`: replace only if `candidateHtml` is richer, preserving
 * the existing created timestamp and refreshing updated. Kept as its own
 * function so writeNote() itself stays under the file's function-size norm.
 */
function upsertExisting(
  target: string,
  id: string,
  candidateHtml: string,
  candidateAttrsCount: number,
): WriteResult {
  const existingHtml = readFileSync(target, 'utf8');

  if (!isRicherBody(existingHtml, candidateHtml)) {
    const existingValidation = validateNote(existingHtml);
    return {
      id,
      path: target,
      sizeBytes: Buffer.byteLength(existingHtml, 'utf8'),
      attrsCount: existingValidation.ok ? existingValidation.attrsCount : 0,
      unchanged: true,
    };
  }

  const merged = mergeUpsertHtml(existingHtml, candidateHtml, nowIso());
  writeFileSync(target, merged, 'utf8');

  const sizeBytes = Buffer.byteLength(merged, 'utf8');
  logTelemetry({
    event: 'store',
    ts: nowIso(),
    note_id: id,
    size_bytes: sizeBytes,
    attrs_count: candidateAttrsCount,
  });

  return { id, path: target, sizeBytes, attrsCount: candidateAttrsCount };
}

export class SchemaError extends Error {
  override name = 'SchemaError';
}

export class ConflictError extends Error {
  override name = 'ConflictError';
}
