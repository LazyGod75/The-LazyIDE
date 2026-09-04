/**
 * note-index.ts — Note indexing: upsert, delete, rebuild.
 *
 * Owns: indexNote, deleteNote, rebuildAll, parseOptionalFloat,
 *       and the multi-axis HTML extraction helpers.
 */

import { parseHTML } from 'linkedom';
import { stripTags } from '../retrieval/strip.js';
import { type NoteFile, readAllNotes } from '../store/reader.js';
import { noteQuality } from '../util/quality.js';
import { augmentTextForIndex, extractConcepts } from '../util/tokenize.js';
import { bumpLocalWriteVersion } from './corpus-cache.js';
import { getDb } from './db.js';
import { embedNotesForIndex } from './embed-index.js';
import type { IndexedNote } from './note-types.js';

export function indexNote(note: NoteFile): IndexedNote {
  const { document } = parseHTML(`<!doctype html><body>${note.html}</body>`);
  // memory-batch is a third valid root tag (compress's consolidated-batch
  // notes — see commands/compress.ts) alongside article/section. Already
  // handled by schema/scrubber.ts and the two invalidation regexes in
  // compress.ts/graph/contradictions.ts — this selector was simply missed
  // when memory-batch was introduced, which made indexNote() throw for
  // EVERY batch note (compress's own indexNote(readNote(path)) call right
  // after writing one, and any later index-rebuild/dream/interlink pass
  // that reads it back via readAllNotes(), which already includes
  // batchesDir()).
  const root = document.querySelector('article, section, memory-batch');
  if (!root) {
    throw new Error(`No root element in note ${note.path}`);
  }
  const title = root.querySelector('h1, h2, h3')?.textContent?.trim() ?? note.id;
  const rawText = stripTags(root.outerHTML);
  // Spreading activation: enrich indexed text with sub-tokens so identifiers
  // like UserRepository expose "User" and "Repository" to BM25. Wikipedia
  // pattern — a query about "OrderRepository" now activates the "Repository"
  // concept and surfaces other Repository instances even without a direct
  // surface match. The augmented column is for FTS only; the structured
  // attributes (concepts, entities) remain canonical.
  const text = augmentTextForIndex(rawText);
  const conceptList = extractConcepts(rawText);
  const concepts = conceptList.length > 0 ? conceptList.join(',') : null;

  // Compute quality from fact count, mean confidence, access stats, relations
  const allFacts = Array.from(root.querySelectorAll('[data-cerveau-fact]'));
  const factCount = allFacts.length;
  const meanConfidence =
    factCount > 0
      ? allFacts.reduce(
          (sum, el) =>
            sum + (Number.parseFloat(el.getAttribute('data-cerveau-confidence') ?? '1') || 1),
          0,
        ) / factCount
      : 0;
  const hasRelations = !!(
    root.getAttribute('data-cerveau-triples') ||
    root.getAttribute('data-cerveau-causes') ||
    root.getAttribute('data-cerveau-replaces')
  );
  const quality = noteQuality({
    factCount,
    meanConfidence,
    accessCount: 0, // access_count not yet set at index time
    inboundWikilinks: 0, // backlink graph not consulted here (too expensive)
    hasRelations,
  });

  const saliencyKind = root.getAttribute('data-cerveau-saliency-kind') ?? null;
  const conflictWith = root.getAttribute('data-cerveau-conflict-with') ?? null;

  // Haiku #8: Extract multi-axis indexing data from HTML balises
  const questions = extractQuestionsFromHtml(document);
  const errorPatterns = extractErrorPatternsFromHtml(document);
  const aliases = extractAliasesFromHtml(document);
  const sectionSummary = extractSectionTextContent(root, 'summary', 1500);
  const sectionReasoning = extractSectionTextContent(root, 'reasoning', 1500);
  const sectionQa = extractSectionTextContent(root, 'qa', 1500);
  const sectionToolTrace = extractSectionTextContent(root, 'tool_trace', 1500);
  const sectionTldr = extractSectionTextContent(root, 'tldr', 1500);
  const warnings = extractWarningsFromHtml(root);
  // Extract topic and tldr from data attributes
  const topic = root.getAttribute('data-cerveau-topic');
  const tldr = root.getAttribute('data-cerveau-tldr');

  const indexed: IndexedNote = {
    id: note.id,
    path: note.path,
    text,
    title,
    type: root.getAttribute('data-cerveau-type'),
    tags: root.getAttribute('data-cerveau-tags') ?? '',
    source: root.getAttribute('data-cerveau-source'),
    created: root.getAttribute('data-cerveau-created'),
    importance: parseOptionalFloat(root.getAttribute('data-cerveau-importance')),
    valid_from: root.getAttribute('data-cerveau-valid-from'),
    valid_until: root.getAttribute('data-cerveau-valid-until'),
    mtime_ms: note.mtimeMs,
    triples: root.getAttribute('data-cerveau-triples'),
    causes: root.getAttribute('data-cerveau-causes'),
    replaces: root.getAttribute('data-cerveau-replaces'),
    replaced_by: root.getAttribute('data-cerveau-replaced-by'),
    supersedes: root.getAttribute('data-cerveau-supersedes'),
    entities: root.getAttribute('data-cerveau-entities'),
    concepts,
    quality,
    saliency_kind: saliencyKind,
    conflict_with: conflictWith,
    related: root.getAttribute('data-cerveau-related') ?? null,
    questions,
    error_patterns: errorPatterns,
    aliases,
    section_summary: sectionSummary,
    section_reasoning: sectionReasoning,
    section_qa: sectionQa,
    section_tool_trace: sectionToolTrace,
    section_tldr: sectionTldr,
    warnings,
    topic,
    tldr,
  };

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO notes (id, path, title, type, tags, source, created, importance,
                       valid_from, valid_until, mtime_ms,
                       triples, causes, replaces, replaced_by, supersedes, entities,
                       concepts, quality, saliency_kind, conflict_with, related,
                       questions, error_patterns, aliases, section_summary, section_reasoning,
                       section_qa, section_tool_trace, section_tldr, warnings, topic, tldr)
    VALUES (@id, @path, @title, @type, @tags, @source, @created, @importance,
            @valid_from, @valid_until, @mtime_ms,
            @triples, @causes, @replaces, @replaced_by, @supersedes, @entities,
            @concepts, @quality, @saliency_kind, @conflict_with, @related,
            @questions, @error_patterns, @aliases, @section_summary, @section_reasoning,
            @section_qa, @section_tool_trace, @section_tldr, @warnings, @topic, @tldr)
    ON CONFLICT(id) DO UPDATE SET
      path=@path, title=@title, type=@type, tags=@tags, source=@source,
      created=@created, importance=@importance, valid_from=@valid_from,
      valid_until=@valid_until, mtime_ms=@mtime_ms,
      triples=@triples, causes=@causes, replaces=@replaces,
      replaced_by=@replaced_by, supersedes=@supersedes, entities=@entities,
      concepts=@concepts, quality=@quality, saliency_kind=@saliency_kind,
      conflict_with=@conflict_with, related=@related,
      questions=@questions, error_patterns=@error_patterns, aliases=@aliases,
      section_summary=@section_summary, section_reasoning=@section_reasoning,
      section_qa=@section_qa, section_tool_trace=@section_tool_trace, section_tldr=@section_tldr,
      warnings=@warnings, topic=@topic, tldr=@tldr
  `);
  upsert.run(indexed);

  // Refresh FTS row
  db.prepare('DELETE FROM notes_fts WHERE id = ?').run(note.id);
  db.prepare('INSERT INTO notes_fts (id, title, text, tags) VALUES (?, ?, ?, ?)').run(
    note.id,
    title,
    text,
    indexed.tags,
  );

  // Speed fix: invalidate corpus-cache.ts's listAllWithText() cache — this
  // connection just changed `notes` content, and PRAGMA data_version alone
  // does not reflect a connection's own writes (see corpus-cache.ts).
  bumpLocalWriteVersion();

  return indexed;
}

export function deleteNote(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  db.prepare('DELETE FROM notes_fts WHERE id = ?').run(id);
  try {
    db.prepare('DELETE FROM note_embeddings WHERE id = ?').run(id);
  } catch {
    /* best-effort */
  }
  // Touches both notes and note_embeddings — invalidate both caches.
  bumpLocalWriteVersion();
}

/**
 * Wipe and re-index every note, then batch-embed the whole freshly-indexed
 * set (cache-aware — see embed-index.ts). This is what makes a `--full`
 * index-rebuild the reliable way to backfill note_embeddings for a brain
 * that predates index-time embedding (or after an embedding-model swap):
 * every note is "just indexed" in this pass, so every note flows through
 * embedNotesForIndex().
 */
export async function rebuildAll(): Promise<{ indexed: number; failed: number; failures: string[] }> {
  const db = getDb();
  db.exec('DELETE FROM notes; DELETE FROM notes_fts;');
  bumpLocalWriteVersion(); // corpus is now empty even before any re-index below
  const notes = readAllNotes();
  let indexed = 0;
  let failed = 0;
  const failures: string[] = [];
  const indexedNotes: IndexedNote[] = [];
  for (const n of notes) {
    try {
      indexedNotes.push(indexNote(n));
      indexed += 1;
    } catch (err) {
      failed += 1;
      failures.push(`${n.path}: ${(err as Error).message}`);
    }
  }
  await embedNotesForIndex(indexedNotes);
  return { indexed, failed, failures };
}

export function parseOptionalFloat(v: string | null): number | null {
  if (!v) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ============================================================
// Haiku #8: Multi-axis extraction helpers
// ============================================================

/**
 * Extract Q patterns from <details data-q="..."> elements and <meta name="answers">.
 * Returns pipe-separated questions, or null if empty.
 */
function extractQuestionsFromHtml(document: Document): string | null {
  const questions: string[] = [];

  // Extract from <meta name="answers">
  const answersMeta = document.querySelector('meta[name="answers"]');
  if (answersMeta) {
    const content = answersMeta.getAttribute('content') ?? '';
    if (content) {
      for (const answer of content
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)) {
        questions.push(`Why/How ${answer}?`);
      }
    }
  }

  // Extract from <details data-q="...">
  for (const detail of Array.from(document.querySelectorAll('details[data-q]'))) {
    const attr = detail.getAttribute('data-q');
    if (attr) questions.push(attr.replace(/-/g, ' '));
  }

  return questions.length > 0 ? questions.join('|') : null;
}

/**
 * Extract error patterns from <details data-error="..."> elements.
 * Returns pipe-separated error hashes, or null if empty.
 */
function extractErrorPatternsFromHtml(document: Document): string | null {
  const patterns: string[] = [];
  for (const detail of Array.from(document.querySelectorAll('details[data-error]'))) {
    const attr = detail.getAttribute('data-error');
    if (attr) patterns.push(attr);
  }
  return patterns.length > 0 ? patterns.join('|') : null;
}

/**
 * Extract aliases from <meta name="aliases">.
 * Returns comma-separated aliases, or null if empty.
 */
function extractAliasesFromHtml(document: Document): string | null {
  const aliasMeta = document.querySelector('meta[name="aliases"]');
  if (aliasMeta) {
    const content = aliasMeta.getAttribute('content') ?? '';
    return content.trim() ? content : null;
  }
  return null;
}

/**
 * Extract textContent from <section data-section="X">, capped at maxChars.
 * Returns the content or null if section not found.
 */
function extractSectionTextContent(
  root: Element,
  sectionName: string,
  maxChars: number,
): string | null {
  const section = root.querySelector(`section[data-section="${sectionName}"]`);
  if (!section) return null;
  const text = section.textContent ?? '';
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, maxChars) : null;
}

/**
 * Extract warning text from <aside role="doc-warning"> elements.
 * Returns pipe-separated warning texts, or null if empty.
 */
function extractWarningsFromHtml(root: Element): string | null {
  const warnings: string[] = [];
  for (const aside of Array.from(root.querySelectorAll('aside[role="doc-warning"]'))) {
    const text = (aside.textContent ?? '').trim();
    if (text) warnings.push(text);
  }
  return warnings.length > 0 ? warnings.join('|') : null;
}
