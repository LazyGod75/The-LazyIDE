/**
 * T2.0 — Projection query hooks for cockpit v2 surfaces.
 *
 * Thin TypeScript wrappers over the Rust journal projection commands
 * (`journal_fleet_overview`, `journal_attention_inbox`, `journal_activity_feed`).
 * Each hook returns a typed result and degrades gracefully to an empty array
 * when the Tauri backend is unavailable (web/mock mode).
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '../platform/index.js';
import type { JournalEventRow } from './eventTypes.js';

// ── Wire types (match Rust structs exactly — Tauri does NOT camelCase
//    return values, only argument names) ─────────────────────────────

export interface FleetProjectKpi {
  project_id: string;
  running: number;
  queued: number;
  review: number;
  done: number;
  failed: number;
  cancelled: number;
  total_cost_usd: number;
  total_tokens: number;
}

export interface AttentionItem {
  mission_id: string;
  project_id: string;
  status: string;
  reason: string;
  updated_ms: number;
}

export interface ActivityFeedItem {
  seq: number;
  ts_ms: number;
  project_id: string;
  mission_id: string | null;
  event_type: string;
  actor: string;
  payload_preview: string;
}

/**
 * Per-agent-identity aggregate stats (audit follow-up — T2.0/T2.7's
 * `journal_agent_stats` gap; see `commands/journal.rs`'s "Agent stats"
 * section for the exact aggregation rules). One row per distinct `agent_id`
 * seen in the journal.
 */
export interface AgentStatsOut {
  agent_id: string;
  runs: number;
  completed: number;
  failed: number;
  total_tokens: number;
  total_cost_usd: number;
  last_active_ms: number;
}

// ── Query functions ────────────────────────────────────────────────

/**
 * Fleet overview: per-project KPI aggregates (status counts + cost/tokens).
 * Returns [] outside Tauri (web/mock mode) or on error.
 */
export async function queryFleetOverview(): Promise<FleetProjectKpi[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<FleetProjectKpi[]>('journal_fleet_overview');
  } catch (err: unknown) {
    console.warn('[projections] journal_fleet_overview failed:', err);
    return [];
  }
}

/**
 * Attention inbox: missions needing human action (review, failed, blocked).
 * Optionally scoped to a single project. Returns [] on error.
 */
export async function queryAttentionInbox(projectId?: string): Promise<AttentionItem[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<AttentionItem[]>('journal_attention_inbox', { projectId: projectId ?? null });
  } catch (err: unknown) {
    console.warn('[projections] journal_attention_inbox failed:', err);
    return [];
  }
}

/**
 * Activity feed: recent events with a truncated payload preview.
 * Optionally scoped to a single project. Returns [] on error.
 */
export async function queryActivityFeed(projectId?: string, limit?: number): Promise<ActivityFeedItem[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<ActivityFeedItem[]>('journal_activity_feed', {
      projectId: projectId ?? null,
      limit: limit ?? null,
    });
  } catch (err: unknown) {
    console.warn('[projections] journal_activity_feed failed:', err);
    return [];
  }
}

/**
 * Journal-since: all events at/after `sinceMs`, ascending (oldest-first),
 * optionally scoped to a project — the resume briefing's (T2.5) core query,
 * "everything that happened since I last looked" (see
 * ../agents/briefing.ts's buildBriefingDigest, the pure consumer of these
 * rows). Returns [] outside Tauri (web/mock mode) or on error.
 */
export async function queryJournalSince(
  projectId: string | undefined,
  sinceMs: number,
  limit?: number,
): Promise<JournalEventRow[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<JournalEventRow[]>('journal_since', {
      projectId: projectId ?? null,
      sinceMs,
      limit: limit ?? null,
    });
  } catch (err: unknown) {
    console.warn('[projections] journal_since failed:', err);
    return [];
  }
}

/**
 * Per-agent-identity aggregate stats (runs, completed/failed, tokens, cost,
 * last activity). Optionally scoped to a single agent id. Returns [] outside
 * Tauri (web/mock mode) or on error — never rejects, matching every other
 * query in this module (AgentRoster.tsx relies on this to degrade to an
 * honest "no data yet" state instead of throwing).
 */
export async function queryAgentStats(agentId?: string): Promise<AgentStatsOut[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<AgentStatsOut[]>('journal_agent_stats', { agentId: agentId ?? null });
  } catch (err: unknown) {
    console.warn('[projections] journal_agent_stats failed:', err);
    return [];
  }
}
