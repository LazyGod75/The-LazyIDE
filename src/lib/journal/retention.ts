/* retention.ts — Journal retention job (spec §4.4).

   Compacts detail events older than the retention window (default 90 days)
   by replacing their payloads with a minimal summary, keeping the seq/timestamp/
   type/project/mission indexes intact for chronological queries while reducing
   the storage footprint of old high-frequency events (mission.step, tool.called,
   spend.tokens).

   Audit follow-up: this file previously duplicated the compaction loop
   client-side (per-event `journal_compact_event` calls against a command
   that never existed, and an incorrect nested-`filter` shape for
   `journal_query_events`) — it could never actually run. Rust now owns the
   real compaction + VACUUM (`journal_retention_run`, `journal_retention_run_inner`
   in commands/journal.rs) and schedules itself automatically (5 min after
   startup, then every 24h — see `spawn_journal_retention`, called from
   lib.rs's `.setup()`). `runJournalRetention` below is now a thin,
   correctly-shaped wrapper over that command for on-demand/manual triggers;
   it is not on the scheduled path.
*/

import { isTauri } from '../platform/index.js';

// ── Types ───────────────────────────────────────────────────────────

export interface RetentionConfig {
  /** Events older than this many days are eligible for compaction. */
  retentionDays: number;
  /** Event types to compact (high-frequency detail events). */
  compactableTypes: string[];
  /** Max events per compaction run (batch size). */
  batchSize: number;
}

// ── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  retentionDays: 90,
  compactableTypes: [
    'mission.step',
    'tool.called',
    'spend.tokens',
    'agent.message',
  ],
  batchSize: 500,
};

// ── Retention job ───────────────────────────────────────────────────

/** Shape of `journal_retention_run`'s return value (mirrors Rust's
 *  `RetentionSummary`, commands/journal.rs). */
interface RetentionRunSummary {
  compacted: number;
  vacuumed: boolean;
}

/**
 * Run the journal retention compaction (spec §4.4).
 *
 * Thin, correctly-shaped wrapper over the Rust `journal_retention_run`
 * command, which owns the actual compaction + VACUUM logic (see this
 * module's doc comment for why the client-side loop this function used to
 * run was replaced). Passes `config` through as flattened top-level args —
 * Tauri's JS-camelCase/Rust-snake_case argument mapping binds
 * `retentionDays`/`types`/`batchSize` to the command's matching parameters,
 * same convention as every other `journal_*` query in projections.ts.
 *
 * Never rejects: returns 0 outside Tauri (web/mock mode) or on any failure.
 */
export async function runJournalRetention(
  config: RetentionConfig = DEFAULT_RETENTION_CONFIG,
): Promise<number> {
  if (!isTauri()) return 0;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const summary = await invoke<RetentionRunSummary>('journal_retention_run', {
      retentionDays: config.retentionDays,
      types: config.compactableTypes,
      batchSize: config.batchSize,
    });
    return summary?.compacted ?? 0;
  } catch (err: unknown) {
    console.warn('[retention] journal_retention_run failed:', err);
    return 0;
  }
}

/**
 * Cheap probe for whether the journal has at least one event — NOT a true
 * total row count (queries with `limit: 1`, so the only possible resolved
 * values are 0 or 1). Returns -1 outside Tauri or on error.
 */
export async function getJournalSize(): Promise<number> {
  if (!isTauri()) return -1;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const events = await invoke<Array<unknown>>('journal_query_events', { limit: 1 });
    return Array.isArray(events) ? events.length : 0;
  } catch (err: unknown) {
    console.warn('[retention] getJournalSize failed:', err);
    return -1;
  }
}
