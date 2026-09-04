/**
 * router-types.ts — Public types for the retrieval router.
 *
 * Extracted from router.ts so nl-routes.ts, rankers.ts, and router.ts
 * can all import the same types without a circular dependency.
 */

import type { StrippedNote } from './strip.js';

export type RouterLevel = 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4' | 'auto';

export interface RouterResult {
  hits: ResolvedHit[];
  levelUsed: 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4';
  totalMs: number;
  /**
   * Present only when a semantic dispatch (L2_L3_HYBRID/L3/L4) exceeded its
   * internal soft budget (see SEMANTIC_SOFT_BUDGET_MS, router.ts) and this
   * result silently fell back to fast keyword-only (L2) hits instead of
   * making the caller wait out the full external timeout (~30s at the Rust
   * layer). `levelUsed` above is already truthful in this case (it reports
   * 'L2', the level that actually produced `hits`) — this field exists so a
   * caller that wants to explain the degradation to the user/model can, e.g.
   * inject-context.ts prepending an honest note to the injected text.
   * undefined on every non-degraded call — no existing caller that ignores
   * this field observes any behavior change.
   */
  degraded?: { fromLevel: 'L2_L3_HYBRID' | 'L3' | 'L4'; timeoutMs: number };
}

export interface ResolvedHit {
  id: string;
  path: string;
  score: number;
  level: 'L1' | 'L2' | 'L2_L3_HYBRID' | 'L3' | 'L4';
  note?: StrippedNote;
  /** Raw HTML of the note file, populated when hydrateNote is true. */
  rawHtml?: string;
  snippet?: string;
  neighbours?: Array<{ id: string; type: string; direction: 'in' | 'out' }>;
}

export interface SearchInput {
  query: string;
  topK?: number;
  level?: RouterLevel;
  includeExpired?: boolean;
  type?: string;
  tag?: string;
  diversityLambda?: number; // 0..1, undefined = no MMR
  hydrateNote?: boolean; // include full stripped note in hits
  /** When set, PageRank biases toward notes from this working directory. */
  cwd?: string;
  /** PageRank weight in the final score mix (0 = off, 1 = pure PR). Default 0.25 when graph present. */
  pageRankWeight?: number;
  /** When set, only notes whose data-cerveau-source starts with this prefix are returned. */
  sourcePrefix?: string;
  /**
   * When true, suppresses the 'query' telemetry event this call would
   * otherwise log (see router.ts's `route()`). Used ONLY for synthetic
   * internal calls that are not real user activity — e.g. the sidecar
   * warmup probe (src-tauri/src/commands/brain/sidecar/warmup.rs) — so
   * Settings > Memory's "Queries (24h)" diagnostic reflects genuine usage,
   * not the app's own cache-priming request. Defaults to false/undefined
   * (logged) for every real caller.
   */
  skipTelemetry?: boolean;
}
