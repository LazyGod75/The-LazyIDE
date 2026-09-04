/**
 * note-types.ts — Shared type definitions for the indexer subsystem.
 *
 * Extracted from fts.ts so that note-index.ts and note-read.ts can both
 * import IndexedNote and StructuralBoostHit without a circular dependency.
 */

export interface ListAllOptions {
  includeExpired?: boolean;
  excludeInvalidated?: boolean;
}

export interface IndexedNote {
  id: string;
  path: string;
  text: string;
  title: string;
  type: string | null;
  tags: string; // space-separated
  source: string | null;
  created: string | null;
  importance: number | null;
  valid_from: string | null;
  valid_until: string | null;
  mtime_ms: number;
  // P1 — heuristic relations (nullable; populated on indexNote)
  triples: string | null; // "subj|pred|obj;subj|pred|obj"
  causes: string | null; // "<reason>|<reason>"
  replaces: string | null; // "X,Y"
  replaced_by: string | null; // "X,Y"
  supersedes: string | null; // "X,Y"
  // P2 — entity discovery
  entities: string | null; // "db:postgres-prod,lib:react"
  // B4 — retrieval-time access stats (nullable until first access)
  access_count?: number | null;
  last_accessed?: string | null;
  // Wikipedia: extracted concepts (Repository, Service, Pattern…)
  concepts?: string | null;
  // Quality flag (stub/start/good/featured)
  quality?: string | null;
  // Saliency kind
  saliency_kind?: string | null;
  // Contradiction detection: comma-separated ids of notes this note contradicts
  // (mirrors data-cerveau-conflict-with). Null when the note conflicts with none.
  conflict_with?: string | null;
  // Phase 3: pre-computed cosine neighbours
  related?: string | null;
  // Multi-axis indexing (Haiku #8)
  questions?: string | null; // "why question 1|how question 2|..."
  error_patterns?: string | null; // "hash1|hash2|..."
  aliases?: string | null; // "postgres,postgresql,pg"
  section_summary?: string | null; // textContent of <section data-section="summary">
  section_reasoning?: string | null; // textContent of <section data-section="reasoning">
  section_qa?: string | null; // textContent of <section data-section="qa">
  section_tool_trace?: string | null; // textContent of <section data-section="tool_trace">
  section_tldr?: string | null; // textContent of <section data-section="tldr">
  // Anti-pattern warnings: extracted text from <aside role="doc-warning">
  warnings?: string | null; // "text of warning 1|text of warning 2"
  // Topic hierarchy for navigation
  topic?: string | null; // "myproject/auth/oauth"
  // TLDR: 1-sentence summary
  tldr?: string | null; // "One sentence summary"
}

/**
 * Input element for applyStructuralFieldBoost.
 * Carries the scored note id and the structural fields used for boosting.
 */
export interface StructuralBoostHit {
  id: string;
  score: number;
  /** Value of the data-cerveau-topic attribute (e.g. "myproject/auth/oauth"). */
  topic: string | null | undefined;
  /** Space-separated tags from the notes.tags column. */
  tags: string | null | undefined;
  /** Value of the data-code-file attribute (e.g. "src/retrieval/router.ts"). */
  codeFile: string | null | undefined;
}
