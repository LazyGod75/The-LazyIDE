/**
 * Shared types for the import command adapters.
 *
 * An ImportAdapter discovers source artifacts and converts them into
 * ImportedConversation objects. The import command then deduplicates and
 * writes notes using the existing annotateSession / writeNote pipeline.
 */

export type ImportSource = 'claude-code' | 'cursor' | 'chatgpt-export' | 'claude-export' | 'auto';

/**
 * One discrete conversation from any source.
 * Adapters normalize diverse formats into this shape.
 */
export interface ImportedConversation {
  /** Unique content-addressed id (SHA-256 of text). Used for dedup. */
  contentHash: string;
  /** Best-effort title / first line of user message. */
  title: string;
  /** Concatenated text (human + assistant turns). Max ~4000 chars. */
  text: string;
  /** ISO timestamp of the conversation. */
  timestamp: string;
  /** Source label for data-cerveau-source attribute. */
  source: string;
  /** Topic hint, e.g. "project/feature" derived from file path or folder. */
  topic?: string;
  /** Working directory / project root when known. */
  cwd?: string;
  /** Files modified (tool traces). */
  filesModified?: string[];
  /** Files read (tool traces). */
  filesRead?: string[];
}

export interface ImportAdapter {
  readonly source: ImportSource;
  /** Detect whether this source is available on the current machine. */
  isAvailable(): boolean;
  /** Discover all conversations without reading full content. */
  list(since?: string): ImportedConversation[];
}

/** Result printed as JSON on stdout. */
export interface ImportResult {
  source: string;
  scanned: number;
  imported: number;
  skipped: number;
  estItems: number;
  estTokens: number;
  sampleTitles: string[];
  /** Which LLM backend annotated the notes — only set for a real (non-dry-run)
   *  run with --use-llm. Absent means heuristic-only (dry-run, or --use-llm
   *  not passed). See annotator/llm.ts's resolveExtractorBackend. */
  backend?: string;
}

/** Platform-level history source descriptor (for Tauri / onboarding). */
export interface HistorySource {
  source: string;
  label: string;
  available: boolean;
  itemCount: number;
  path?: string;
}
