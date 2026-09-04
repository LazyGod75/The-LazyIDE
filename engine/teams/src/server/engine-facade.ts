/**
 * Engine facade contract — types only.
 *
 * E3 implements this interface in src/engine/.
 * E2 (server/pages) codes against this facade and uses engine-stub.ts
 * for tests and as a fallback when the real engine is absent.
 *
 * TRUST BOUNDARY: bodyHtml returned by renderWikiIndex / renderWikiNote is
 * produced by the engine and is treated as TRUSTED HTML. It must NOT be
 * re-escaped when embedded in the layout. All other user-supplied strings
 * must go through esc() in render.ts before interpolation.
 */

export interface FederatedHit {
  readonly teamSlug: string;
  readonly noteId: string;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  readonly type?: string;
  readonly date?: string;
}

export interface TeamBrainStats {
  readonly notes: number;
  readonly activeDecisions: number;
  readonly lastCaptureAt?: string;
}

export interface EngineFacade {
  /**
   * Ensure a team brain directory exists and is initialised.
   * Idempotent — safe to call on every team page load.
   */
  ensureTeamBrain(teamSlug: string): Promise<{ brainPath: string }>;

  /**
   * Federated semantic search across one or more team brains.
   * Callers MUST pre-filter teamSlugs to only the slugs the authenticated
   * user is permitted to access — the engine does not enforce ACLs.
   */
  search(opts: {
    query: string;
    teamSlugs: string[];
    top?: number;
  }): Promise<FederatedHit[]>;

  /**
   * Persist a note in a team brain.
   */
  storeNote(opts: {
    teamSlug: string;
    authorUsername: string;
    agent?: string;
    type?: string;
    tags?: string[];
    text: string;
  }): Promise<{ noteId: string }>;

  /**
   * Render the wiki index page for a team brain.
   * Returns trusted HTML — see TRUST BOUNDARY note above.
   */
  renderWikiIndex(teamSlug: string): Promise<{ title: string; bodyHtml: string }>;

  /**
   * Render a single wiki note.
   * Returns null if the note does not exist.
   * Returns trusted HTML — see TRUST BOUNDARY note above.
   */
  renderWikiNote(
    teamSlug: string,
    noteId: string,
  ): Promise<{ title: string; bodyHtml: string } | null>;

  /**
   * Return aggregate stats for a team brain.
   */
  stats(teamSlug: string): Promise<TeamBrainStats>;

  /**
   * Graceful shutdown — flush any pending writes, close handles.
   */
  shutdown(): Promise<void>;
}
