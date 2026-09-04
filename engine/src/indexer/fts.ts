/**
 * fts.ts — Public facade for the FTS index subsystem.
 *
 * All implementation has been split into focused submodules:
 *   db.ts            — DB lifecycle (getDb / getReadonlyDb / closeDb)
 *   schema.ts        — Schema creation and versioned migrations
 *   fts-search.ts    — FTS5/BM25 search, OR-fallback, spread activation
 *   embedding-store.ts — Embedding blob CRUD
 *   embed-index.ts   — batched cache-aware index-time embedding pass
 *   note-types.ts    — IndexedNote, ListAllOptions, StructuralBoostHit interfaces
 *   note-index.ts    — indexNote, deleteNote, rebuildAll
 *   note-read.ts     — listAll, getNoteById, recordAccess, multi-axis retrieval
 *   note-helpers.ts  — Tag caches, structural boost, timeline queries
 *
 * This file re-exports every symbol that was previously exported directly,
 * so all external import sites continue to work without changes.
 */

// DB lifecycle
export { closeDb, getDb, getReadonlyDb } from './db.js';

// Search types and functions
export type { FtsHit, SearchOptions } from './fts-search.js';
export { searchFts, searchFtsSpread, tokenizeForFts } from './fts-search.js';

// Embedding store
export type { StoredNoteEmbedding } from './embedding-store.js';
export {
  deleteNoteEmbedding,
  loadAllStoredEmbeddings,
  upsertNoteEmbedding,
} from './embedding-store.js';

// Index-time embedding pass (batched, cache-aware — see l3.ts's
// resolveCorpusVectors for the query-time counterpart, same underlying path)
export type { EmbedIndexPassResult } from './embed-index.js';
export { embedNotesForIndex } from './embed-index.js';

// Shared types
export type { IndexedNote, ListAllOptions, StructuralBoostHit } from './note-types.js';

// Note indexing
export { deleteNote, indexNote, parseOptionalFloat, rebuildAll } from './note-index.js';

// Note reading
export {
  countAllNotes,
  getNoteById,
  getNoteText,
  listAll,
  listAllReadonly,
  listAllWithText,
  notesAnsweringQuestion,
  notesByTagOrType,
  notesForErrorPattern,
  notesMatchingPathPrefix,
  notesMentioningEntity,
  notesWithWarningsOrNegative,
  recordAccess,
  recordAccessMany,
} from './note-read.js';

// Tag caches, Wikipedia helpers, structural boost, timeline queries
export {
  activeDecisions,
  allDistinctTags,
  applyStructuralFieldBoost,
  getTagNoteCount,
  noteVocabularyCensus,
  notesForCwdCount,
  recentChanges,
  topConcepts,
} from './note-helpers.js';
export type { NoteVocabulary, VocabularyCount } from './note-helpers.js';
