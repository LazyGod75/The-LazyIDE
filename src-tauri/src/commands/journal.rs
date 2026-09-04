//! Event journal (the cockpit v2 "spine"): a single global, append-only
//! SQLite (WAL) database at `<app_local_data_dir>/journal.db` recording every
//! `events` row plus a materialized `missions_current` projection (current
//! status + latest full snapshot per mission) kept up to date in the SAME
//! transaction as the triggering event's insert.
//!
//! Global, not per-project: the fleet cockpit is cross-project by
//! definition (spec `docs/superpowers/specs/2026-07-09-cockpit-v2-fleet-design.md`
//! section 4.1). Rust owns the writer; the frontend only ever reads/writes
//! through these four commands, never the file directly.
//!
//! Every `_inner` function here takes a `&Connection`/`&mut Connection`
//! directly (no `tauri::State`), following the `git.rs` convention, so it is
//! unit-testable against a plain in-memory or temp-file connection without a
//! running Tauri app.

use std::fs;
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use rusqlite::{params, Connection, ToSql, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::Manager;

use crate::state::JournalState;

// ── Schema (spec section 4.1 — normative) ──────────────────────────

const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  mission_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_mission ON events(mission_id);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts_ms);
-- Defect-2 fix (2026-08-12): `journal_query_events_inner`'s `since_ms`
-- filter (`AND ts_ms >= ?`) had no index to use unless `types` was ALSO
-- given — idx_events_type_ts only serves ts_ms as its non-leading column,
-- unusable without a `type` filter (SQLite's leftmost-prefix rule). A
-- `since_ms`-only query (the resume-briefing / \"what's new\" tail shape —
-- see `journal_since_inner`, and `journalQuery`'s own `sinceMs` filter,
-- journal.ts) therefore fell back to a full table scan checking every row's
-- ts_ms — measured at 549ms for a near-miss scan of a real 22.6k-row
-- production journal.db, i.e. cost proportional to TOTAL table size, not to
-- the (typically tiny) matching/result size, and only getting worse as the
-- journal grows. `IF NOT EXISTS` makes this a no-op migration: existing
-- installs get the index created on their next `init_journal_schema` call
-- (every app boot) with no separate migration step needed.
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms);
CREATE TABLE IF NOT EXISTS missions_current (
  mission_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_ms INTEGER NOT NULL
);
";

// ── Wire types ──────────────────────────────────────────────────────
//
// `JournalEventIn`/`JournalFilter` field names are snake_case exactly as
// sent by the TS client (`src/lib/journal/journal.ts`, a parallel task) —
// Tauri's IPC deserializer matches JS object keys to these Rust field names
// literally, so no `rename_all` is used. `type` collides with the Rust
// keyword, hence the single `#[serde(rename = "type")]` on `type_`.

#[derive(Debug, Clone, Deserialize)]
pub struct JournalEventIn {
    pub ts_ms: i64,
    pub project_id: String,
    pub mission_id: Option<String>,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub actor: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub payload: String,
    pub tokens_in: Option<i64>,
    pub tokens_out: Option<i64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct JournalFilter {
    pub project_id: Option<String>,
    pub mission_id: Option<String>,
    pub types: Option<Vec<String>>,
    pub since_seq: Option<i64>,
    pub since_ms: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JournalEventOut {
    pub seq: i64,
    pub ts_ms: i64,
    pub project_id: String,
    pub mission_id: Option<String>,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub actor: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub payload: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MissionCurrentOut {
    pub mission_id: String,
    pub project_id: String,
    pub status: String,
    pub data: String,
    pub updated_ms: i64,
}

// ── Redaction (emit-side hygiene, spec section 4.4 / 11) ────────────

struct RedactionPatterns {
    bearer: Regex,
    sk_key: Regex,
    json_secret_field: Regex,
    jwt: Regex,
}

static REDACTION_PATTERNS: OnceLock<RedactionPatterns> = OnceLock::new();

fn redaction_patterns() -> &'static RedactionPatterns {
    REDACTION_PATTERNS.get_or_init(|| RedactionPatterns {
        bearer: Regex::new(r"(?i)(bearer\s+)[a-z0-9._\-]{8,}").expect("valid bearer regex"),
        sk_key: Regex::new(r"sk-[A-Za-z0-9]{16,}").expect("valid sk- regex"),
        json_secret_field: Regex::new(
            r#"(?i)("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*")[^"]+(")"#,
        )
        .expect("valid json secret-field regex"),
        jwt: Regex::new(r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}")
            .expect("valid jwt regex"),
    })
}

/// Scrub obvious secrets from a raw event payload BEFORE it is ever
/// persisted. Ports the key patterns from `engine/src/importers/scrub.ts`
/// (bearer tokens, `sk-` API keys, JSON secret-shaped fields, JWTs) to the
/// Rust side, since the journal is the one write path every engine funnels
/// through. Best-effort / non-reversible, same as the TS scrubber.
pub(crate) fn redact_payload(payload: &str) -> String {
    let patterns = redaction_patterns();
    let step1 = patterns.bearer.replace_all(payload, "$1[REDACTED]");
    let step2 = patterns.sk_key.replace_all(&step1, "[REDACTED]");
    let step3 = patterns
        .json_secret_field
        .replace_all(&step2, "$1[REDACTED]$2");
    let step4 = patterns.jwt.replace_all(&step3, "[REDACTED]");
    step4.into_owned()
}

// ── Validation ────────────────────────────────────────────────────

/// Minimal application-level validation for a row about to be inserted.
/// `journal_emit_batch_inner` relies on this returning `Err` for a bad row
/// to keep the whole batch's transaction atomic (nothing commits).
fn validate_event(event: &JournalEventIn) -> Result<(), String> {
    if event.project_id.trim().is_empty() {
        return Err("journal event: project_id must not be empty".to_string());
    }
    if event.actor.trim().is_empty() {
        return Err("journal event: actor must not be empty".to_string());
    }
    if event.type_.trim().is_empty() {
        return Err("journal event: type must not be empty".to_string());
    }
    Ok(())
}

// ── Missions projection (spec section 4.1 / task T0.1) ───────────────

/// Maps a `mission.<suffix>` event type to the status it should set in
/// `missions_current`, when that mapping is unambiguous. Returns `None` for
/// subtypes that must NOT move status on their own (`blocked`, `question`)
/// or anything unrecognized — the safe default is "leave status alone".
fn mission_status_for_event_type(type_suffix: &str) -> Option<&'static str> {
    match type_suffix {
        "created" | "queued" => Some("queued"),
        "started" | "resumed" | "step" | "intervened" => Some("running"),
        "paused" => Some("paused"),
        "review_requested" | "proof_attached" => Some("review"),
        "approved" | "completed" => Some("done"),
        "failed" => Some("failed"),
        "cancelled" => Some("cancelled"),
        "reverted" => Some("reverted"),
        _ => None,
    }
}

/// Transactionally upserts `missions_current` for a `mission.*` event.
/// See the module doc + `mission_status_for_event_type` for the status
/// mapping; this handles the row-existence guarantee and the
/// snapshot-vs-status-only update split.
fn apply_mission_projection(
    tx: &Transaction,
    event: &JournalEventIn,
    redacted_payload: &str,
) -> Result<(), String> {
    let mission_id = match &event.mission_id {
        Some(id) if !id.trim().is_empty() => id.clone(),
        _ => return Ok(()), // no mission_id on this mission.* event: nothing to project
    };

    let type_suffix = event.type_.strip_prefix("mission.").unwrap_or("");
    let mapped_status = mission_status_for_event_type(type_suffix);

    let snapshot: Option<JsonValue> = serde_json::from_str::<JsonValue>(redacted_payload)
        .ok()
        .and_then(|v| v.get("mission").cloned());

    // Guarantee a row exists so every UPDATE below is safe even on this
    // mission_id's very first event (e.g. a replay ordering hiccup).
    let placeholder_data = serde_json::json!({ "missionId": mission_id }).to_string();
    tx.execute(
        "INSERT OR IGNORE INTO missions_current (mission_id, project_id, status, data, updated_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            mission_id,
            event.project_id,
            mapped_status.unwrap_or("queued"),
            placeholder_data,
            event.ts_ms
        ],
    )
    .map_err(|e| format!("journal: missions_current insert-or-ignore failed: {}", e))?;

    if let Some(snapshot_value) = snapshot {
        // Full snapshot present: its own `status` field (if any) wins over
        // the type-based mapping ("unless payload says otherwise").
        let snapshot_status = snapshot_value
            .get("status")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());
        let data_json = serde_json::to_string(&snapshot_value)
            .map_err(|e| format!("journal: serialize mission snapshot failed: {}", e))?;

        match snapshot_status.or_else(|| mapped_status.map(|s| s.to_string())) {
            Some(status) => tx.execute(
                "UPDATE missions_current SET status = ?1, data = ?2, updated_ms = ?3, project_id = ?4 WHERE mission_id = ?5",
                params![status, data_json, event.ts_ms, event.project_id, mission_id],
            ),
            None => tx.execute(
                "UPDATE missions_current SET data = ?1, updated_ms = ?2, project_id = ?3 WHERE mission_id = ?4",
                params![data_json, event.ts_ms, event.project_id, mission_id],
            ),
        }
        .map_err(|e| format!("journal: missions_current snapshot update failed: {}", e))?;
    } else if let Some(status) = mapped_status {
        // No snapshot, but the event type maps to a concrete status: a
        // status-only update (`data` is left untouched).
        tx.execute(
            "UPDATE missions_current SET status = ?1, updated_ms = ?2 WHERE mission_id = ?3",
            params![status, event.ts_ms, mission_id],
        )
        .map_err(|e| format!("journal: missions_current status update failed: {}", e))?;
    }
    // else: blocked/question/unrecognized subtype with no snapshot — keep
    // current status untouched (the INSERT OR IGNORE above already
    // guaranteed a row exists for future updates).

    Ok(())
}

// ── Insert + emit ─────────────────────────────────────────────────

fn insert_event_row(
    tx: &Transaction,
    event: &JournalEventIn,
    redacted_payload: &str,
) -> Result<i64, String> {
    tx.execute(
        "INSERT INTO events (ts_ms, project_id, mission_id, agent_id, run_id, actor, type, payload, tokens_in, tokens_out, cost_usd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            event.ts_ms,
            event.project_id,
            event.mission_id,
            event.agent_id,
            event.run_id,
            event.actor,
            event.type_,
            redacted_payload,
            event.tokens_in.unwrap_or(0),
            event.tokens_out.unwrap_or(0),
            event.cost_usd.unwrap_or(0.0),
        ],
    )
    .map_err(|e| format!("journal: insert into events failed: {}", e))?;

    Ok(tx.last_insert_rowid())
}

/// Emit a single event: validate, redact, insert, and (if `type` starts
/// with `mission.`) project into `missions_current` — all in one
/// transaction. Returns the assigned `seq`.
pub(crate) fn journal_emit_inner(conn: &mut Connection, event: &JournalEventIn) -> Result<i64, String> {
    validate_event(event)?;
    let redacted_payload = redact_payload(&event.payload);

    let tx = conn
        .transaction()
        .map_err(|e| format!("journal_emit: begin transaction failed: {}", e))?;
    let seq = insert_event_row(&tx, event, &redacted_payload)?;
    if event.type_.starts_with("mission.") {
        apply_mission_projection(&tx, event, &redacted_payload)?;
    }
    tx.commit()
        .map_err(|e| format!("journal_emit: commit failed: {}", e))?;
    Ok(seq)
}

/// Emit a batch of events in ONE transaction: either every row (and its
/// mission projection) lands, or none do. Returns the last assigned `seq`.
pub(crate) fn journal_emit_batch_inner(
    conn: &mut Connection,
    events: &[JournalEventIn],
) -> Result<i64, String> {
    if events.is_empty() {
        return Err("journal_emit_batch: events must not be empty".to_string());
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("journal_emit_batch: begin transaction failed: {}", e))?;
    let mut last_seq: i64 = 0;
    for event in events {
        validate_event(event)?;
        let redacted_payload = redact_payload(&event.payload);
        last_seq = insert_event_row(&tx, event, &redacted_payload)?;
        if event.type_.starts_with("mission.") {
            apply_mission_projection(&tx, event, &redacted_payload)?;
        }
    }
    tx.commit()
        .map_err(|e| format!("journal_emit_batch: commit failed: {}", e))?;
    Ok(last_seq)
}

// ── Queries ─────────────────────────────────────────────────────────

/// Builds the SQL + bound params for `journal_query_events_inner`'s SELECT.
/// Split out from `journal_query_events_inner` so the exact query it will
/// run (in particular, whether `force_ts_index` fired) can be asserted on
/// directly in tests via `EXPLAIN QUERY PLAN`, instead of a test maintaining
/// its own hand-written copy of this SQL that could silently drift from the
/// real thing.
///
/// Returns `(sql, bound_params, force_ts_index)` — `sql` NEVER contains the
/// `INDEXED BY` hint itself; `with_ts_index_hint` (below) adds it. Kept
/// separate so `journal_query_events_inner` can always fall back to the
/// unhinted `sql` if the hinted variant fails to prepare (see that
/// function's doc comment for why this fallback exists and is required, not
/// optional).
fn build_query_events_sql(filter: &JournalFilter) -> (String, Vec<Box<dyn ToSql>>, bool) {
    let limit = filter.limit.unwrap_or(500).clamp(1, 5000);
    let ascending = filter.since_seq.is_some() || filter.since_ms.is_some();

    // Defect-2 fix, part 2: adding `idx_events_ts` (schema, above) is not
    // enough by itself — measured via `EXPLAIN QUERY PLAN` on this exact
    // shape, SQLite's planner still picked a full `SCAN events` over the new
    // index, because `ORDER BY seq` can be satisfied for free by walking the
    // primary key (rowid) in order, and without `ANALYZE` statistics the
    // planner has no way to know `ts_ms >= ?` is normally highly selective
    // (a handful of recent rows out of the whole table) — so it judged
    // "avoid the extra sort a ts_ms-ordered index would need" as cheaper
    // than "seek the index, then sort the few matches by seq". `INDEXED BY`
    // forces the seek; SQLite still computes the exact same result set (this
    // does not change semantics, only the access path) — it just also then
    // pays for a sort over the (normally small) matched rows instead of
    // scanning the entire table. Deliberately scoped to ONLY the shape that
    // was actually measured broken: `since_ms` given, and none of
    // `since_seq`/`project_id`/`mission_id`/`types` given — every other
    // combination already has a seq-ordered index that serves it for free
    // (`idx_events_project(project_id, seq)`, the primary key for
    // `since_seq`'s `seq > ?`, etc.), so forcing this index there could only
    // make an already-good plan worse.
    let force_ts_index = filter.since_ms.is_some()
        && filter.since_seq.is_none()
        && filter.project_id.is_none()
        && filter.mission_id.is_none()
        // `map_or` (stable since 1.0), not `Option::is_none_or` (stabilized
        // 1.82) — this crate's Cargo.toml declares `rust-version = "1.77.2"`,
        // so is_none_or would compile fine against CI's `stable` toolchain
        // but silently violate the crate's own declared MSRV.
        && filter.types.as_ref().map_or(true, |t| t.is_empty());

    let mut sql = String::from(
        "SELECT seq, ts_ms, project_id, mission_id, agent_id, run_id, actor, type, payload, tokens_in, tokens_out, cost_usd FROM events WHERE 1=1",
    );
    let mut bound: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(project_id) = &filter.project_id {
        sql.push_str(" AND project_id = ?");
        bound.push(Box::new(project_id.clone()));
    }
    if let Some(mission_id) = &filter.mission_id {
        sql.push_str(" AND mission_id = ?");
        bound.push(Box::new(mission_id.clone()));
    }
    if let Some(types) = &filter.types {
        if !types.is_empty() {
            let placeholders = vec!["?"; types.len()].join(", ");
            sql.push_str(&format!(" AND type IN ({})", placeholders));
            for t in types {
                bound.push(Box::new(t.clone()));
            }
        }
    }
    if let Some(since_seq) = filter.since_seq {
        sql.push_str(" AND seq > ?");
        bound.push(Box::new(since_seq));
    }
    if let Some(since_ms) = filter.since_ms {
        sql.push_str(" AND ts_ms >= ?");
        bound.push(Box::new(since_ms));
    }

    sql.push_str(if ascending { " ORDER BY seq ASC" } else { " ORDER BY seq DESC" });
    sql.push_str(" LIMIT ?");
    bound.push(Box::new(limit));

    (sql, bound, force_ts_index)
}

/// Inserts the `INDEXED BY idx_events_ts` hint right after `FROM events` —
/// `sql` is always `build_query_events_sql`'s output, which is guaranteed to
/// contain that exact substring exactly once (it is the fixed `FROM` clause
/// of every query this module builds; nothing before it in the SELECT list
/// can produce that text), so this is a precise, unambiguous insertion, not
/// a fragile string search.
fn with_ts_index_hint(sql: &str) -> String {
    sql.replacen("FROM events", "FROM events INDEXED BY idx_events_ts", 1)
}

/// Query events with optional project/mission/type/since filters. Results
/// are ordered ascending by `seq` when either `since_seq` or `since_ms` is
/// given (tailing forward from a cursor), else descending (latest first).
///
/// `INDEXED BY` is a HARD constraint in SQLite (`prepare()` errors outright,
/// "no such index", if the named index is missing — it never silently falls
/// back to a scan on its own). Every path that can reach this function opens
/// its `Connection` and eagerly runs `init_journal_schema` first (`?`-
/// propagated in `try_open_journal_for_app`, `.expect()`-panicked in every
/// test's `fresh_db()`/equivalent), so under normal operation `idx_events_ts`
/// always exists here — EXCEPT `open_journal_for_app`'s in-memory fallback
/// (this file, below), which deliberately logs-and-continues on a schema-init
/// failure rather than propagating it (matching this crate's established
/// "degrade, never panic" posture for that one path), and `SCHEMA_SQL`'s
/// `execute_batch` is not wrapped in an explicit transaction, so a failure
/// partway through it could in principle leave `events` created but
/// `idx_events_ts` not yet reached. Rather than trust that enumeration to
/// stay complete forever (a future call site could reintroduce the same
/// gap), `journal_query_events_inner` itself never lets a missing
/// `idx_events_ts` become a hard user-facing error: if the hinted `prepare()`
/// fails, it falls back to the exact same query without the hint (the old,
/// pre-fix behavior — correct, just potentially a full scan) instead of
/// propagating the prepare error.
pub(crate) fn journal_query_events_inner(
    conn: &Connection,
    filter: &JournalFilter,
) -> Result<Vec<JournalEventOut>, String> {
    let (sql, bound, force_ts_index) = build_query_events_sql(filter);

    let mut stmt = if force_ts_index {
        match conn.prepare(&with_ts_index_hint(&sql)) {
            Ok(stmt) => stmt,
            Err(hinted_err) => {
                log::warn!(
                    "journal_query_events: INDEXED BY idx_events_ts unusable ({}), falling back to a plain scan",
                    hinted_err
                );
                conn.prepare(&sql)
                    .map_err(|e| format!("journal_query_events: prepare failed (fallback): {}", e))?
            }
        }
    } else {
        conn.prepare(&sql)
            .map_err(|e| format!("journal_query_events: prepare failed: {}", e))?
    };
    let param_refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();

    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(JournalEventOut {
                seq: row.get(0)?,
                ts_ms: row.get(1)?,
                project_id: row.get(2)?,
                mission_id: row.get(3)?,
                agent_id: row.get(4)?,
                run_id: row.get(5)?,
                actor: row.get(6)?,
                type_: row.get(7)?,
                payload: row.get(8)?,
                tokens_in: row.get(9)?,
                tokens_out: row.get(10)?,
                cost_usd: row.get(11)?,
            })
        })
        .map_err(|e| format!("journal_query_events: query_map failed: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| format!("journal_query_events: row decode failed: {}", e))?);
    }
    Ok(results)
}

/// Query all events at/after `since_ms`, optionally scoped to one project,
/// always ordered ascending by seq (oldest-first) — the resume briefing's
/// core primitive (T2.5, spec §9): "everything that happened since I last
/// looked". A thin wrapper over `journal_query_events_inner` (reuses its row
/// mapping and ASC-when-since_ms ordering exactly), with its own default
/// limit (1000, vs. journal_query_events's 500) since a resume briefing
/// window can legitimately span a full workday of fleet activity.
pub(crate) fn journal_since_inner(
    conn: &Connection,
    project_id: Option<&str>,
    since_ms: i64,
    limit: Option<i64>,
) -> Result<Vec<JournalEventOut>, String> {
    let filter = JournalFilter {
        project_id: project_id.map(|s| s.to_string()),
        since_ms: Some(since_ms),
        limit: Some(limit.unwrap_or(1000)),
        ..Default::default()
    };
    journal_query_events_inner(conn, &filter)
}

/// Return the current materialized mission rows, optionally scoped to one
/// project, most-recently-updated first.
pub(crate) fn journal_missions_current_inner(
    conn: &Connection,
    project_id: Option<&str>,
) -> Result<Vec<MissionCurrentOut>, String> {
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<MissionCurrentOut> {
        Ok(MissionCurrentOut {
            mission_id: row.get(0)?,
            project_id: row.get(1)?,
            status: row.get(2)?,
            data: row.get(3)?,
            updated_ms: row.get(4)?,
        })
    };

    let mut results = Vec::new();
    match project_id {
        Some(pid) => {
            let mut stmt = conn
                .prepare(
                    "SELECT mission_id, project_id, status, data, updated_ms FROM missions_current WHERE project_id = ?1 ORDER BY updated_ms DESC",
                )
                .map_err(|e| format!("journal_missions_current: prepare failed: {}", e))?;
            let rows = stmt
                .query_map(params![pid], map_row)
                .map_err(|e| format!("journal_missions_current: query_map failed: {}", e))?;
            for row in rows {
                results.push(row.map_err(|e| format!("journal_missions_current: row decode failed: {}", e))?);
            }
        }
        None => {
            let mut stmt = conn
                .prepare(
                    "SELECT mission_id, project_id, status, data, updated_ms FROM missions_current ORDER BY updated_ms DESC",
                )
                .map_err(|e| format!("journal_missions_current: prepare failed: {}", e))?;
            let rows = stmt
                .query_map([], map_row)
                .map_err(|e| format!("journal_missions_current: query_map failed: {}", e))?;
            for row in rows {
                results.push(row.map_err(|e| format!("journal_missions_current: row decode failed: {}", e))?);
            }
        }
    }
    Ok(results)
}

// ── Projection queries (T2.0: cockpit v2 surfaces) ────────────────

/// Fleet overview KPI: per-project counts by status + aggregate cost/tokens.
#[derive(Debug, Clone, Serialize)]
pub struct FleetProjectKpi {
    pub project_id: String,
    pub running: i64,
    pub queued: i64,
    pub review: i64,
    pub done: i64,
    pub failed: i64,
    pub cancelled: i64,
    pub total_cost_usd: f64,
    pub total_tokens: i64,
}

/// Attention inbox item: a mission that needs human action.
#[derive(Debug, Clone, Serialize)]
pub struct AttentionItem {
    pub mission_id: String,
    pub project_id: String,
    pub status: String,
    pub reason: String,
    pub updated_ms: i64,
}

/// Activity feed row: a recent event flattened for the cockpit feed.
#[derive(Debug, Clone, Serialize)]
pub struct ActivityFeedItem {
    pub seq: i64,
    pub ts_ms: i64,
    pub project_id: String,
    pub mission_id: Option<String>,
    pub event_type: String,
    pub actor: String,
    pub payload_preview: String,
}

/// Fleet overview: per-project KPI aggregates from `missions_current` +
/// token/cost sums from the `events` table.
pub(crate) fn journal_fleet_overview_inner(
    conn: &Connection,
) -> Result<Vec<FleetProjectKpi>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT project_id,
                    SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
                    SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) as queued,
                    SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) as review,
                    SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
                    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
                    SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled
             FROM missions_current GROUP BY project_id ORDER BY project_id",
        )
        .map_err(|e| format!("journal_fleet_overview: prepare failed: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|e| format!("journal_fleet_overview: query_map failed: {}", e))?;

    let mut results = Vec::new();
    for row in rows {
        let (project_id, running, queued, review, done, failed, cancelled) =
            row.map_err(|e| format!("journal_fleet_overview: row decode failed: {}", e))?;

        // Aggregate cost/tokens from events for this project
        let (total_cost, total_tokens) = {
            let mut cost_stmt = conn
                .prepare(
                    "SELECT COALESCE(SUM(cost_usd), 0.0), COALESCE(SUM(tokens_in + tokens_out), 0)
                     FROM events WHERE project_id = ?1",
                )
                .map_err(|e| format!("journal_fleet_overview: cost prepare failed: {}", e))?;
            cost_stmt
                .query_row(params![project_id], |r| {
                    Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?))
                })
                .map_err(|e| format!("journal_fleet_overview: cost query failed: {}", e))?
        };

        results.push(FleetProjectKpi {
            project_id,
            running,
            queued,
            review,
            done,
            failed,
            cancelled,
            total_cost_usd: total_cost,
            total_tokens,
        });
    }
    Ok(results)
}

/// Attention inbox: missions in `review`, `failed`, or `blocked` status,
/// most-recently-updated first, optionally scoped to one project.
pub(crate) fn journal_attention_inbox_inner(
    conn: &Connection,
    project_id: Option<&str>,
) -> Result<Vec<AttentionItem>, String> {
    let reason_for_status = |status: &str| -> &str {
        match status {
            "review" => "Awaiting approval",
            "failed" => "Mission failed",
            "blocked" => "Blocked by gate",
            _ => "Needs attention",
        }
    };

    let sql = match project_id {
        Some(_) => {
            "SELECT mission_id, project_id, status, updated_ms
             FROM missions_current
             WHERE project_id = ?1 AND status IN ('review', 'failed', 'blocked')
             ORDER BY updated_ms DESC LIMIT 200"
        }
        None => {
            "SELECT mission_id, project_id, status, updated_ms
             FROM missions_current
             WHERE status IN ('review', 'failed', 'blocked')
             ORDER BY updated_ms DESC LIMIT 200"
        }
    };

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("journal_attention_inbox: prepare failed: {}", e))?;

    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<AttentionItem> {
        let status: String = row.get(2)?;
        Ok(AttentionItem {
            mission_id: row.get(0)?,
            project_id: row.get(1)?,
            reason: reason_for_status(&status).to_string(),
            status,
            updated_ms: row.get(3)?,
        })
    };

    let mut results = Vec::new();
    if let Some(pid) = project_id {
        let rows = stmt
            .query_map(params![pid], map_row)
            .map_err(|e| format!("journal_attention_inbox: query_map failed: {}", e))?;
        for row in rows {
            results.push(row.map_err(|e| format!("journal_attention_inbox: row decode failed: {}", e))?);
        }
    } else {
        let rows = stmt
            .query_map([], map_row)
            .map_err(|e| format!("journal_attention_inbox: query_map failed: {}", e))?;
        for row in rows {
            results.push(row.map_err(|e| format!("journal_attention_inbox: row decode failed: {}", e))?);
        }
    }
    Ok(results)
}

/// Activity feed: recent events (optionally scoped to a project), with a
/// truncated payload preview for the cockpit feed surface.
pub(crate) fn journal_activity_feed_inner(
    conn: &Connection,
    project_id: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<ActivityFeedItem>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);

    let sql = match project_id {
        Some(_) => {
            "SELECT seq, ts_ms, project_id, mission_id, type, actor, payload
             FROM events WHERE project_id = ?1 ORDER BY seq DESC LIMIT ?2"
        }
        None => {
            "SELECT seq, ts_ms, project_id, mission_id, type, actor, payload
             FROM events ORDER BY seq DESC LIMIT ?1"
        }
    };

    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("journal_activity_feed: prepare failed: {}", e))?;

    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<ActivityFeedItem> {
        let payload: String = row.get(6)?;
        let preview: String = payload.chars().take(200).collect();
        Ok(ActivityFeedItem {
            seq: row.get(0)?,
            ts_ms: row.get(1)?,
            project_id: row.get(2)?,
            mission_id: row.get(3)?,
            event_type: row.get(4)?,
            actor: row.get(5)?,
            payload_preview: preview,
        })
    };

    let mut results = Vec::new();
    if let Some(pid) = project_id {
        let rows = stmt
            .query_map(params![pid, limit], map_row)
            .map_err(|e| format!("journal_activity_feed: query_map failed: {}", e))?;
        for row in rows {
            results.push(row.map_err(|e| format!("journal_activity_feed: row decode failed: {}", e))?);
        }
    } else {
        let rows = stmt
            .query_map(params![limit], map_row)
            .map_err(|e| format!("journal_activity_feed: query_map failed: {}", e))?;
        for row in rows {
            results.push(row.map_err(|e| format!("journal_activity_feed: row decode failed: {}", e))?);
        }
    }
    Ok(results)
}

// ── Agent stats (audit follow-up: T2.0's journal_agent_stats gap) ──
//
// Per-agent-identity aggregate stats, per plan T2.0/T2.7 and spec section 4.3
// ("agent profiles (aggregates by agent_id)"). AgentRoster.tsx (T2.7) merges
// this into its rows instead of deriving stats from the in-memory mission
// store — the audit finding this closes.

/// One row per distinct `agent_id` seen in `events` (never null/empty).
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatsOut {
    pub agent_id: String,
    /// Distinct runs attributed to this agent: `COUNT(DISTINCT run_id)`,
    /// falling back to `mission_id` for rows where `run_id` was never set
    /// (not every call site populates it — see eventTypes.ts's
    /// `JournalEventBase`). Events with BOTH `run_id` and `mission_id` null
    /// contribute to no run (SQL `COUNT(DISTINCT ...)` ignores NULLs) rather
    /// than being fabricated into one.
    pub runs: i64,
    /// Count of `mission.completed` events carrying this `agent_id`.
    pub completed: i64,
    /// Count of `mission.failed` events carrying this `agent_id`.
    pub failed: i64,
    pub total_tokens: i64,
    pub total_cost_usd: f64,
    pub last_active_ms: i64,
}

const AGENT_STATS_SELECT: &str = "
    SELECT agent_id,
           COUNT(DISTINCT COALESCE(run_id, mission_id)) AS runs,
           SUM(CASE WHEN type = 'mission.completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN type = 'mission.failed' THEN 1 ELSE 0 END) AS failed,
           COALESCE(SUM(tokens_in + tokens_out), 0) AS total_tokens,
           COALESCE(SUM(cost_usd), 0.0) AS total_cost_usd,
           MAX(ts_ms) AS last_active_ms
    FROM events
    WHERE agent_id IS NOT NULL AND agent_id != ''";

/// Aggregate stats grouped by `agent_id`, optionally filtered to one id.
/// `None` returns every agent, most-recently-active first.
pub(crate) fn journal_agent_stats_inner(
    conn: &Connection,
    agent_id: Option<&str>,
) -> Result<Vec<AgentStatsOut>, String> {
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<AgentStatsOut> {
        Ok(AgentStatsOut {
            agent_id: row.get(0)?,
            runs: row.get(1)?,
            completed: row.get(2)?,
            failed: row.get(3)?,
            total_tokens: row.get(4)?,
            total_cost_usd: row.get(5)?,
            last_active_ms: row.get(6)?,
        })
    };

    let mut results = Vec::new();
    match agent_id {
        Some(id) => {
            let sql = format!("{} AND agent_id = ?1 GROUP BY agent_id", AGENT_STATS_SELECT);
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("journal_agent_stats: prepare failed: {}", e))?;
            let rows = stmt
                .query_map(params![id], map_row)
                .map_err(|e| format!("journal_agent_stats: query_map failed: {}", e))?;
            for row in rows {
                results.push(row.map_err(|e| format!("journal_agent_stats: row decode failed: {}", e))?);
            }
        }
        None => {
            let sql = format!("{} GROUP BY agent_id ORDER BY last_active_ms DESC", AGENT_STATS_SELECT);
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("journal_agent_stats: prepare failed: {}", e))?;
            let rows = stmt
                .query_map([], map_row)
                .map_err(|e| format!("journal_agent_stats: query_map failed: {}", e))?;
            for row in rows {
                results.push(row.map_err(|e| format!("journal_agent_stats: row decode failed: {}", e))?);
            }
        }
    }
    Ok(results)
}

// ── Retention (audit follow-up: spec section 4.4, wired nowhere before) ──
//
// "full detail 90 days, then tool.called/mission.step compacted into
// per-mission summaries; aggregates kept forever. VACUUM scheduled."
//
// Compaction here means: blank the verbose `payload` text of eligible old
// rows in place. The row itself (seq/ts_ms/project_id/mission_id/agent_id/
// run_id/actor/type, and critically the tokens_in/tokens_out/cost_usd
// aggregate columns) is NEVER touched or deleted — only `payload` shrinks —
// so every aggregate query in this file (fleet overview, agent stats above,
// attention inbox) stays byte-for-byte accurate forever, and mission-terminal
// events (mission.completed/failed/..., never in the compactable set below)
// keep their full detail permanently. Mirrors `DEFAULT_RETENTION_CONFIG`
// (src/lib/journal/retention.ts) exactly so the TS config and these Rust
// defaults can never silently drift apart.

pub(crate) const DEFAULT_RETENTION_DAYS: i64 = 90;

pub(crate) const DEFAULT_COMPACTABLE_TYPES: [&str; 4] =
    ["mission.step", "tool.called", "spend.tokens", "agent.message"];

const COMPACTED_PAYLOAD: &str = r#"{"compacted":true}"#;

/// Outcome of one `journal_retention_run` pass.
#[derive(Debug, Clone, Serialize)]
pub struct RetentionSummary {
    pub compacted: i64,
    pub vacuumed: bool,
}

/// Compact up to `batch_size` eligible rows (`type` in `compactable_types`,
/// `ts_ms` older than `retention_days`, not already compacted), then VACUUM.
///
/// `batch_size` bounds a single pass's write size (mirrors
/// `RetentionConfig.batchSize`, retention.ts) — a journal compacting for the
/// first time after months of use could otherwise touch a huge number of
/// rows in one transaction. Idempotent: a row whose payload already equals
/// `COMPACTED_PAYLOAD` is never re-selected, so repeated runs (the 24h
/// scheduler, `spawn_journal_retention` below) converge to zero new
/// compactions instead of re-scanning the same rows forever.
///
/// VACUUM runs OUTSIDE the compaction transaction (SQLite forbids VACUUM
/// inside an explicit transaction) using plain `VACUUM`, not `PRAGMA
/// incremental_vacuum` — this journal's schema (`init_journal_schema`) never
/// sets `auto_vacuum = INCREMENTAL` (that mode can only be adopted on an
/// empty database, or via a full VACUUM immediately after setting it), so a
/// full VACUUM is the only pragma that actually reclaims space from this
/// compaction's UPDATEs today. A VACUUM failure is logged and reflected in
/// `vacuumed: false`, never propagated as an `Err` — the compaction itself
/// already committed and must not be reported as failed just because the
/// disk-reclaim step couldn't run.
pub(crate) fn journal_retention_run_inner(
    conn: &mut Connection,
    retention_days: i64,
    compactable_types: &[String],
    batch_size: i64,
) -> Result<RetentionSummary, String> {
    if compactable_types.is_empty() {
        return Ok(RetentionSummary { compacted: 0, vacuumed: false });
    }
    let cutoff_ms =
        chrono::Utc::now().timestamp_millis() - retention_days.saturating_mul(86_400_000);
    let batch_size = batch_size.clamp(1, 10_000);

    let compacted = {
        let tx = conn
            .transaction()
            .map_err(|e| format!("journal_retention_run: begin transaction failed: {}", e))?;

        let type_placeholders = vec!["?"; compactable_types.len()].join(", ");
        let select_sql = format!(
            "SELECT seq FROM events WHERE type IN ({}) AND ts_ms < ? AND payload != ? ORDER BY seq ASC LIMIT ?",
            type_placeholders
        );

        let seqs: Vec<i64> = {
            let mut stmt = tx
                .prepare(&select_sql)
                .map_err(|e| format!("journal_retention_run: select prepare failed: {}", e))?;
            let mut bound: Vec<Box<dyn ToSql>> = compactable_types
                .iter()
                .map(|t| Box::new(t.clone()) as Box<dyn ToSql>)
                .collect();
            bound.push(Box::new(cutoff_ms));
            bound.push(Box::new(COMPACTED_PAYLOAD.to_string()));
            bound.push(Box::new(batch_size));
            let param_refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();

            let rows = stmt
                .query_map(param_refs.as_slice(), |row| row.get::<_, i64>(0))
                .map_err(|e| format!("journal_retention_run: select query_map failed: {}", e))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|e| format!("journal_retention_run: select row decode failed: {}", e))?);
            }
            out
        };

        let mut compacted_count: i64 = 0;
        if !seqs.is_empty() {
            let seq_placeholders = vec!["?"; seqs.len()].join(", ");
            let update_sql = format!("UPDATE events SET payload = ? WHERE seq IN ({})", seq_placeholders);
            let mut bound: Vec<Box<dyn ToSql>> = Vec::with_capacity(seqs.len() + 1);
            bound.push(Box::new(COMPACTED_PAYLOAD.to_string()));
            for seq in &seqs {
                bound.push(Box::new(*seq));
            }
            let param_refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();
            compacted_count = tx
                .execute(&update_sql, param_refs.as_slice())
                .map_err(|e| format!("journal_retention_run: update failed: {}", e))? as i64;
        }

        tx.commit()
            .map_err(|e| format!("journal_retention_run: commit failed: {}", e))?;
        compacted_count
    };

    let vacuumed = match conn.execute_batch("VACUUM") {
        Ok(()) => true,
        Err(e) => {
            log::warn!("journal_retention_run: VACUUM failed (non-fatal): {}", e);
            false
        }
    };

    Ok(RetentionSummary { compacted, vacuumed })
}

/// Spawn the periodic journal retention background task (spec section 4.4):
/// one pass `INITIAL_DELAY_SECS` after startup (so a cold boot is never
/// additionally burdened by a VACUUM), then every `INTERVAL_SECS`
/// thereafter. Fire-and-forget, same philosophy as `spawn_brain_consolidator`
/// (commands/brain/maintenance.rs) — errors are logged, never fatal — and
/// the blocking rusqlite work runs via `spawn_blocking` so this never
/// occupies a tokio worker thread for the duration of a compaction + VACUUM
/// pass. Called once from `lib.rs`'s `.setup()`, mirroring exactly how that
/// module spawns the brain consolidator off the same JournalState-shaped
/// `Arc<Mutex<..>>` handle.
pub(crate) fn spawn_journal_retention(journal_conn: Arc<Mutex<Connection>>) {
    const INITIAL_DELAY_SECS: u64 = 5 * 60;
    const INTERVAL_SECS: u64 = 24 * 60 * 60;

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_secs(INITIAL_DELAY_SECS)).await;

        loop {
            let conn_for_task = Arc::clone(&journal_conn);
            let outcome = tokio::task::spawn_blocking(move || {
                let mut guard = conn_for_task
                    .lock()
                    .map_err(|e| format!("journal_retention: state lock failed: {}", e))?;
                let types: Vec<String> =
                    DEFAULT_COMPACTABLE_TYPES.iter().map(|s| s.to_string()).collect();
                journal_retention_run_inner(&mut guard, DEFAULT_RETENTION_DAYS, &types, 500)
            })
            .await;

            match outcome {
                Ok(Ok(summary)) => log::info!(
                    "journal_retention: compacted {} event(s), vacuum {}",
                    summary.compacted,
                    if summary.vacuumed { "ok" } else { "skipped/failed" }
                ),
                Ok(Err(e)) => log::warn!("journal_retention: run failed: {}", e),
                Err(e) => log::warn!("journal_retention: background task join error: {}", e),
            }

            tokio::time::sleep(tokio::time::Duration::from_secs(INTERVAL_SECS)).await;
        }
    });
}

// ── DB open / schema init ─────────────────────────────────────────

/// Create the journal schema if absent, enable WAL mode, and set a 5s busy
/// timeout. Idempotent — safe to call on every app start against an
/// existing db file, and against a fresh in-memory connection in tests.
pub(crate) fn init_journal_schema(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("busy_timeout failed: {}", e))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("PRAGMA journal_mode=WAL failed: {}", e))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("schema init failed: {}", e))?;
    Ok(())
}

fn try_open_journal_for_app(app: &tauri::App) -> Result<Connection, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir failed: {}", e))?;
    fs::create_dir_all(&data_dir)
        .map_err(|e| format!("create_dir_all failed for '{}': {}", data_dir.display(), e))?;

    let db_path = data_dir.join("journal.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("failed to open journal db at '{}': {}", db_path.display(), e))?;
    init_journal_schema(&conn)?;
    Ok(conn)
}

/// Open the event journal for the running app, always returning a usable
/// connection: on any failure to resolve/create the real on-disk path
/// (permissions, disk full, ...) this logs the error and falls back to an
/// in-memory database rather than ever leaving `JournalState` unmanaged —
/// same "degrade, never panic" philosophy as `BrainSidecar` (lib.rs). The
/// fallback loses persistence across restarts but keeps every `journal_*`
/// command callable.
pub(crate) fn open_journal_for_app(app: &tauri::App) -> Connection {
    match try_open_journal_for_app(app) {
        Ok(conn) => conn,
        Err(e) => {
            log::error!(
                "journal: failed to open persistent db, falling back to in-memory (data will NOT persist across restarts): {}",
                e
            );
            let conn = Connection::open_in_memory()
                .expect("journal: Connection::open_in_memory must never fail");
            if let Err(schema_err) = init_journal_schema(&conn) {
                log::error!("journal: failed to init schema on in-memory fallback: {}", schema_err);
            }
            conn
        }
    }
}

// ── System-event convenience helper (T0.7: project.registered|opened|closed) ──

/// Emit a system-authored event (actor `"system"`) without requiring the
/// caller to build a full `JournalEventIn` by hand — fills in `ts_ms` (now),
/// `actor`, and serializes `payload` to the JSON string `JournalEventIn`
/// expects. Used by `commands::brain::config`'s `project_register` /
/// `project_set_active` / `project_close` for the `project.registered
/// |opened|closed` events (spec section 4.2).
///
/// Swallows a lock/emit failure into a logged warning rather than
/// propagating a `Result` — a project register/open/close must succeed even
/// if the journal write itself fails, matching this crate's existing
/// "journal/telemetry hygiene must never block a product action" posture
/// (e.g. `set_project`'s own fire-and-forget auto-index trigger).
pub(crate) fn emit_system_event(
    state: &JournalState,
    project_id: &str,
    event_type: &str,
    payload: serde_json::Value,
) {
    let event = JournalEventIn {
        ts_ms: chrono::Utc::now().timestamp_millis(),
        project_id: project_id.to_string(),
        mission_id: None,
        agent_id: None,
        run_id: None,
        actor: "system".to_string(),
        type_: event_type.to_string(),
        payload: payload.to_string(),
        tokens_in: None,
        tokens_out: None,
        cost_usd: None,
    };

    let mut conn = match state.0.lock() {
        Ok(guard) => guard,
        Err(e) => {
            log::warn!("emit_system_event: journal state lock failed: {}", e);
            return;
        }
    };
    if let Err(e) = journal_emit_inner(&mut conn, &event) {
        log::warn!(
            "emit_system_event: failed to emit '{}' for project '{}': {}",
            event_type, project_id, e
        );
    }
}

// ── Tauri commands ────────────────────────────────────────────────

/// Ingest a frontend-originated error report as a `"frontend.error"` system
/// event (actor `"system"`, `project_id: "unknown"` — same convention
/// `emit_system_event`'s other machine-level callers use for an event with
/// no project to scope it to, e.g. `webview_recovery::emit_recovery_journal_event`).
///
/// Lengths are capped (`message` at 2000 bytes, `stack` at 8000 — the spec
/// wording of "chars" is honored generously: capping by BYTES is always at
/// least as strict, since any string of N bytes has at most N chars) so a
/// runaway or pathological frontend payload (an unbounded stack trace, a
/// pasted-in giant blob) cannot bloat the journal db — truncated, never
/// rejected outright: a truncated error report is still far more useful
/// than none at all. Truncation never splits a multi-byte UTF-8 character
/// (an accented letter, CJK, an emoji in a localized stack trace) via the
/// existing `util::truncate_on_char_boundary` — see that function's own doc
/// comment for the panic it guards against.
///
/// Always returns `Ok(())`: `emit_system_event` already swallows its own
/// failures (logs a warning, never propagates) — matching that philosophy
/// here means a frontend error REPORT can itself never fail the frontend's
/// `invoke()` call, which would be a confusing place to surface a NEW error
/// while already handling one.
#[tauri::command]
pub(crate) fn journal_frontend_error(
    state: tauri::State<JournalState>,
    level: String,
    message: String,
    stack: Option<String>,
    source: String,
) -> Result<(), String> {
    const MESSAGE_CAP_BYTES: usize = 2000;
    const STACK_CAP_BYTES: usize = 8000;

    let message = crate::commands::util::truncate_on_char_boundary(&message, MESSAGE_CAP_BYTES).to_string();
    let stack = stack.map(|s| crate::commands::util::truncate_on_char_boundary(&s, STACK_CAP_BYTES).to_string());

    let payload = serde_json::json!({
        "level": level,
        "message": message,
        "stack": stack,
        "source": source,
    });

    emit_system_event(&state, "unknown", "frontend.error", payload);
    Ok(())
}

/// Emit a single event into the journal. Returns the assigned `seq`.
#[tauri::command]
pub(crate) fn journal_emit(
    state: tauri::State<JournalState>,
    event: JournalEventIn,
) -> Result<i64, String> {
    let mut conn = state
        .0
        .lock()
        .map_err(|e| format!("journal_emit: state lock failed: {}", e))?;
    journal_emit_inner(&mut conn, &event)
}

/// Emit a batch of events in one transaction. Returns the last assigned `seq`.
#[tauri::command]
pub(crate) fn journal_emit_batch(
    state: tauri::State<JournalState>,
    events: Vec<JournalEventIn>,
) -> Result<i64, String> {
    let mut conn = state
        .0
        .lock()
        .map_err(|e| format!("journal_emit_batch: state lock failed: {}", e))?;
    journal_emit_batch_inner(&mut conn, &events)
}

/// Query events with optional project/mission/type/since filters.
///
/// Flattened top-level args (not a nested `filter` object): matches the TS
/// client's actual call shape — `invoke('journal_query_events', {
/// projectId, missionId, types, sinceSeq, sinceMs, limit })` in
/// `src/lib/journal/journal.ts`'s `journalQuery` (T0.2, commit c8cf659).
/// Tauri's default camelCase-JS/snake_case-Rust argument mapping binds each
/// JS key to the matching param below. `JournalFilter` stays the internal
/// shape `_inner` uses, so the query logic + its tests are unaffected.
///
/// `async fn` + `spawn_blocking` (defect-2 fix, 2026-08-12): this was a
/// plain sync `fn` command, which Tauri v2 runs ON THE MAIN THREAD — the
/// exact hazard `brain_capture`'s FIX-4 doc comment (commands/brain/
/// capture.rs) already documents at length, and the same shape this file's
/// OWN `journal_retention_run` was already fixed with below. `journal.ts`'s
/// own file header independently documents "REAL INCIDENT (2026-08-05):
/// while the SQLite backend was held by long builds, journal_query_events
/// started failing/timing out" — every `journal_*` command shares ONE
/// `Arc<Mutex<Connection>>` (`JournalState`), so a slow query (a journal
/// that has grown large — see `journal_retention_run_inner`'s VACUUM and
/// the new WAL-checkpoint pass in `spawn_journal_retention` below, both of
/// which briefly hold this SAME lock) previously stalled the main IPC
/// thread for its full duration, freezing EVERY other `invoke()` in the
/// app, not just this one. `journalQuery`'s 15s client-side `withTimeout`
/// (journal.ts) only makes the frontend give up waiting; it does not free
/// the blocked Rust call, which keeps holding the main thread regardless.
/// Moving the lock-and-query work onto `spawn_blocking` — with the
/// `Arc<Mutex<Connection>>` cloned BEFORE the blocking task and locked
/// INSIDE it, so no guard crosses an `.await` — means a slow query now only
/// occupies one blocking-pool thread instead of freezing the whole app,
/// mirroring `journal_retention_run`'s already-proven shape exactly.
#[tauri::command]
pub(crate) async fn journal_query_events(
    state: tauri::State<'_, JournalState>,
    project_id: Option<String>,
    mission_id: Option<String>,
    types: Option<Vec<String>>,
    since_seq: Option<i64>,
    since_ms: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<JournalEventOut>, String> {
    let filter = JournalFilter {
        project_id,
        mission_id,
        types,
        since_seq,
        since_ms,
        limit,
    };
    let conn = state.0.clone();

    match tauri::async_runtime::spawn_blocking(move || {
        let guard = conn
            .lock()
            .map_err(|e| format!("journal_query_events: state lock failed: {}", e))?;
        journal_query_events_inner(&guard, &filter)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("journal_query_events: blocking task join failed: {}", e)),
    }
}

/// Resume briefing primitive (T2.5): events at/after `since_ms`, ascending,
/// optionally scoped to one project. Not yet wired into `generate_handler!`
/// (lib.rs) — see `journal_since_inner`'s doc comment; the TS wrapper
/// (`queryJournalSince`, projections.ts) degrades to `[]` until it is.
#[tauri::command]
pub(crate) fn journal_since(
    state: tauri::State<JournalState>,
    project_id: Option<String>,
    since_ms: i64,
    limit: Option<i64>,
) -> Result<Vec<JournalEventOut>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("journal_since: state lock failed: {}", e))?;
    journal_since_inner(&conn, project_id.as_deref(), since_ms, limit)
}

/// Return the current materialized mission rows, optionally scoped to one project.
#[tauri::command]
pub(crate) fn journal_missions_current(
    state: tauri::State<JournalState>,
    project_id: Option<String>,
) -> Result<Vec<MissionCurrentOut>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("journal_missions_current: state lock failed: {}", e))?;
    journal_missions_current_inner(&conn, project_id.as_deref())
}

/// Fleet overview: per-project KPI aggregates (T2.0).
#[tauri::command]
pub(crate) fn journal_fleet_overview(
    state: tauri::State<JournalState>,
) -> Result<Vec<FleetProjectKpi>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("journal_fleet_overview: state lock failed: {}", e))?;
    journal_fleet_overview_inner(&conn)
}

/// Attention inbox: missions needing human action (T2.0).
#[tauri::command]
pub(crate) fn journal_attention_inbox(
    state: tauri::State<JournalState>,
    project_id: Option<String>,
) -> Result<Vec<AttentionItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("journal_attention_inbox: state lock failed: {}", e))?;
    journal_attention_inbox_inner(&conn, project_id.as_deref())
}

/// Activity feed: recent events with payload preview (T2.0).
#[tauri::command]
pub(crate) fn journal_activity_feed(
    state: tauri::State<JournalState>,
    project_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<ActivityFeedItem>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("journal_activity_feed: state lock failed: {}", e))?;
    journal_activity_feed_inner(&conn, project_id.as_deref(), limit)
}

/// Per-agent-identity aggregate stats (audit follow-up — see this module's
/// "Agent stats" section doc comment above).
#[tauri::command]
pub(crate) fn journal_agent_stats(
    state: tauri::State<JournalState>,
    agent_id: Option<String>,
) -> Result<Vec<AgentStatsOut>, String> {
    let conn = state
        .0
        .lock()
        .map_err(|e| format!("journal_agent_stats: state lock failed: {}", e))?;
    journal_agent_stats_inner(&conn, agent_id.as_deref())
}

/// Manually run the retention/compaction policy once (spec section 4.4).
/// Also runs automatically on a schedule — see `spawn_journal_retention`.
/// Every argument is optional and defaults to this module's
/// `DEFAULT_RETENTION_DAYS` / `DEFAULT_COMPACTABLE_TYPES` / a batch size of
/// 500, matching `DEFAULT_RETENTION_CONFIG` (src/lib/journal/retention.ts).
///
/// `async fn` + `spawn_blocking`: unlike the scheduled pass
/// (`spawn_journal_retention` above, which already runs its
/// `journal_retention_run_inner` call inside `spawn_blocking`), this
/// manual/UI-triggered entry point was a plain `fn` — and
/// `journal_retention_run_inner`'s trailing `VACUUM` rewrites the entire
/// journal.db file, which can take a real amount of time on a journal that
/// has accumulated many events. A plain `fn` command runs on Tauri's main
/// thread (see `project_register`'s doc comment, commands/brain/config.rs,
/// for the full main-thread-stall mechanism), so a manual retention run
/// would have frozen every other sync IPC command for the length of the
/// VACUUM. The `Arc<Mutex<Connection>>` is cloned BEFORE the blocking task
/// and locked INSIDE it — no guard ever crosses an await point — mirroring
/// `spawn_journal_retention`'s own proven shape exactly.
#[tauri::command]
pub(crate) async fn journal_retention_run(
    state: tauri::State<'_, JournalState>,
    retention_days: Option<i64>,
    types: Option<Vec<String>>,
    batch_size: Option<i64>,
) -> Result<RetentionSummary, String> {
    let conn = state.0.clone();
    let days = retention_days.unwrap_or(DEFAULT_RETENTION_DAYS);
    let types = types.unwrap_or_else(|| {
        DEFAULT_COMPACTABLE_TYPES.iter().map(|s| s.to_string()).collect()
    });
    let batch = batch_size.unwrap_or(500);

    match tauri::async_runtime::spawn_blocking(move || {
        let mut guard = conn
            .lock()
            .map_err(|e| format!("journal_retention_run: state lock failed: {}", e))?;
        journal_retention_run_inner(&mut guard, days, &types, batch)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("journal_retention_run: blocking task join failed: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn make_event(type_: &str, mission_id: &str, payload: &str) -> JournalEventIn {
        JournalEventIn {
            ts_ms: 1_720_000_000_000,
            project_id: "proj-1".to_string(),
            mission_id: Some(mission_id.to_string()),
            agent_id: None,
            run_id: None,
            actor: "agent".to_string(),
            type_: type_.to_string(),
            payload: payload.to_string(),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
        }
    }

    fn fresh_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open_in_memory");
        init_journal_schema(&conn).expect("init_journal_schema");
        conn
    }

    #[test]
    fn journal_emit_and_query_roundtrip() {
        let mut conn = fresh_db();

        let event = JournalEventIn {
            ts_ms: 1_720_000_000_000,
            project_id: "proj-1".to_string(),
            mission_id: Some("mission-1".to_string()),
            agent_id: None,
            run_id: None,
            actor: "user".to_string(),
            type_: "project.opened".to_string(),
            payload: r#"{"note":"hello"}"#.to_string(),
            tokens_in: None,
            tokens_out: None,
            cost_usd: None,
        };

        let seq = journal_emit_inner(&mut conn, &event).expect("journal_emit_inner failed");
        assert_eq!(seq, 1);

        let filter = JournalFilter {
            project_id: Some("proj-1".to_string()),
            ..Default::default()
        };
        let results = journal_query_events_inner(&conn, &filter).expect("query failed");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].seq, seq);
        assert_eq!(results[0].project_id, "proj-1");
        assert_eq!(results[0].mission_id.as_deref(), Some("mission-1"));
        assert_eq!(results[0].type_, "project.opened");
        assert_eq!(results[0].payload, r#"{"note":"hello"}"#);
        assert_eq!(results[0].tokens_in, 0);
        assert_eq!(results[0].cost_usd, 0.0);
        eprintln!("journal_emit_and_query_roundtrip PASSED");
    }

    #[test]
    fn journal_redacts_secrets_in_payload() {
        // (a) Bearer token
        let bearer_redacted = redact_payload("Authorization: Bearer abcdefgh12345678");
        assert!(bearer_redacted.contains("[REDACTED]"), "got: {}", bearer_redacted);
        assert!(!bearer_redacted.contains("abcdefgh12345678"));
        assert!(bearer_redacted.contains("Bearer "), "must preserve the 'Bearer ' prefix, got: {}", bearer_redacted);

        // (b) sk- API key
        let sk_redacted = redact_payload("key=sk-ABCDEFGHIJ1234567890abcdef");
        assert_eq!(sk_redacted, "key=[REDACTED]");

        // (c) JSON secret-shaped field
        let json_redacted = redact_payload(r#"{"api_key":"abcdef1234567890"}"#);
        assert_eq!(json_redacted, r#"{"api_key":"[REDACTED]"}"#);
        let json_redacted2 = redact_payload(r#"{"password": "hunter2hunter2"}"#);
        assert_eq!(json_redacted2, r#"{"password": "[REDACTED]"}"#);

        // (d) JWT
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_abc123DEF";
        let jwt_redacted = redact_payload(&format!("session={}", jwt));
        assert_eq!(jwt_redacted, "session=[REDACTED]");

        eprintln!("journal_redacts_secrets_in_payload PASSED");
    }

    #[test]
    fn mission_events_upsert_missions_current() {
        let mut conn = fresh_db();

        // 1. mission.created WITH a full snapshot (no explicit status inside
        //    it) -> mapped status "queued".
        let created = make_event(
            "mission.created",
            "m1",
            r#"{"mission":{"id":"m1","title":"Test mission"}}"#,
        );
        journal_emit_inner(&mut conn, &created).expect("emit created");

        let missions = journal_missions_current_inner(&conn, None).expect("query missions");
        assert_eq!(missions.len(), 1);
        assert_eq!(missions[0].status, "queued");
        assert!(missions[0].data.contains("Test mission"));

        // 2. mission.started, NO snapshot -> status-only update to "running";
        //    `data` (the last known snapshot) must be preserved untouched.
        let started = make_event("mission.started", "m1", r#"{"note":"launching"}"#);
        journal_emit_inner(&mut conn, &started).expect("emit started");
        let missions = journal_missions_current_inner(&conn, None).expect("query missions");
        assert_eq!(missions.len(), 1);
        assert_eq!(missions[0].status, "running");
        assert!(
            missions[0].data.contains("Test mission"),
            "data must be preserved across a status-only update, got: {}",
            missions[0].data
        );

        // 3. mission.approved, no snapshot -> "done".
        let approved = make_event("mission.approved", "m1", "{}");
        journal_emit_inner(&mut conn, &approved).expect("emit approved");
        let missions = journal_missions_current_inner(&conn, None).expect("query missions");
        assert_eq!(missions[0].status, "done");

        eprintln!("mission_events_upsert_missions_current PASSED");
    }

    #[test]
    fn batch_is_transactional() {
        let mut conn = fresh_db();

        let good = make_event("tool.called", "m1", "{}");
        let mut bad = make_event("tool.called", "m1", "{}");
        bad.project_id = String::new(); // invalid: empty project_id

        let events = vec![good, bad];
        let result = journal_emit_batch_inner(&mut conn, &events);
        assert!(result.is_err(), "batch containing an invalid row must fail");

        let all = journal_query_events_inner(&conn, &JournalFilter::default()).expect("query");
        assert!(
            all.is_empty(),
            "no rows must be committed when the batch fails partway through, got: {:?}",
            all
        );

        eprintln!("batch_is_transactional PASSED");
    }

    #[test]
    fn query_filter_types_and_since_seq() {
        let mut conn = fresh_db();

        let e1 = make_event("mission.created", "m1", "{}");
        let e2 = make_event("tool.called", "m1", "{}");
        let e3 = make_event("mission.completed", "m1", "{}");

        let seq1 = journal_emit_inner(&mut conn, &e1).expect("emit e1");
        let _seq2 = journal_emit_inner(&mut conn, &e2).expect("emit e2");
        let seq3 = journal_emit_inner(&mut conn, &e3).expect("emit e3");

        // Filter by types: only the two mission.* events.
        let filter = JournalFilter {
            types: Some(vec!["mission.created".to_string(), "mission.completed".to_string()]),
            ..Default::default()
        };
        let results = journal_query_events_inner(&conn, &filter).expect("query by types");
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|e| e.type_.starts_with("mission.")));

        // since_seq: only events after seq1, ascending order.
        let since_filter = JournalFilter { since_seq: Some(seq1), ..Default::default() };
        let since_results = journal_query_events_inner(&conn, &since_filter).expect("query since_seq");
        assert_eq!(since_results.len(), 2);
        assert_eq!(since_results[0].seq, seq1 + 1);
        assert_eq!(since_results[1].seq, seq3);
        assert!(
            since_results[0].seq < since_results[1].seq,
            "since_seq results must be ordered ascending"
        );

        // No since_* given: DESC (latest first).
        let default_results = journal_query_events_inner(&conn, &JournalFilter::default()).expect("query default order");
        assert_eq!(default_results[0].seq, seq3, "default order must be latest-first (DESC)");

        eprintln!("query_filter_types_and_since_seq PASSED");
    }

    // ── emit_system_event (T0.7: project.registered|opened|closed) ─────

    #[test]
    fn emit_system_event_writes_a_system_actor_event_with_the_given_payload() {
        let conn = fresh_db();
        let state = JournalState::new(conn);

        emit_system_event(
            &state,
            "proj-xyz",
            "project.registered",
            serde_json::json!({ "root": "/tmp/proj" }),
        );

        let results = {
            let guard = state.0.lock().expect("lock");
            journal_query_events_inner(
                &guard,
                &JournalFilter { project_id: Some("proj-xyz".to_string()), ..Default::default() },
            )
            .expect("query")
        };

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].actor, "system");
        assert_eq!(results[0].type_, "project.registered");
        assert_eq!(results[0].project_id, "proj-xyz");
        assert!(results[0].payload.contains("/tmp/proj"), "got: {}", results[0].payload);
        eprintln!("emit_system_event_writes_a_system_actor_event_with_the_given_payload PASSED");
    }

    #[test]
    fn emit_system_event_never_panics_on_a_poisoned_journal_lock() {
        use std::panic;

        let conn = fresh_db();
        let state = JournalState::new(conn);
        let inner = std::sync::Arc::clone(&state.0);
        let _ = panic::catch_unwind(panic::AssertUnwindSafe(|| {
            let _guard = inner.lock().expect("lock");
            panic!("intentional poison for test");
        }));

        // Must not panic — logs a warning and returns, matching this
        // crate's existing poisoned-lock degrade philosophy.
        emit_system_event(&state, "proj-1", "project.opened", serde_json::json!({}));
        eprintln!("emit_system_event_never_panics_on_a_poisoned_journal_lock PASSED");
    }

    // ── mission.updated (T0.5: journal is the source of truth) ─────────
    //
    // `mission.updated` is not one of `mission_status_for_event_type`'s
    // mapped suffixes (it falls through its `_ => None` arm — same as any
    // other unrecognized mission.* subtype), so this proves the EXISTING
    // apply_mission_projection snapshot branch already does exactly what
    // T0.5 needs with zero code changes: whenever a `mission.*` event's
    // payload carries a `mission` snapshot object, that snapshot's OWN
    // `status` field (already one of MissionStatus's canonical values —
    // 'queued'/'running'/'review'/'done'/'failed'/'cancelled', the same
    // vocabulary missions_current.status itself uses) wins over the
    // type-based mapping, and `data` is fully replaced with the snapshot.
    #[test]
    fn mission_updated_refreshes_data_and_status() {
        let mut conn = fresh_db();

        // Seed via mission.created (mapped status "queued", no snapshot),
        // matching how a real created-then-updated pair lands from the TS
        // client (mission.created's payload today carries title/model, the
        // full snapshot rides on the very next mission.updated event).
        let created = make_event("mission.created", "m1", r#"{"title":"Ship it"}"#);
        journal_emit_inner(&mut conn, &created).expect("emit created");
        let missions = journal_missions_current_inner(&conn, None).expect("query missions");
        assert_eq!(missions[0].status, "queued");

        // mission.updated carrying a full snapshot whose OWN status is
        // "running" -> missions_current must flip to "running" and store
        // the snapshot verbatim as `data`, even though "updated" itself has
        // no entry in mission_status_for_event_type.
        let updated_running = make_event(
            "mission.updated",
            "m1",
            r#"{"mission":{"id":"m1","title":"Ship it","status":"running","progress":40}}"#,
        );
        journal_emit_inner(&mut conn, &updated_running).expect("emit updated (running)");
        let missions = journal_missions_current_inner(&conn, None).expect("query missions");
        assert_eq!(missions.len(), 1);
        assert_eq!(missions[0].status, "running");
        assert!(missions[0].data.contains("\"progress\":40"), "got: {}", missions[0].data);

        // A second mission.updated whose snapshot status is "review" must
        // refresh both fields again — proving this isn't a one-shot fluke.
        let updated_review = make_event(
            "mission.updated",
            "m1",
            r#"{"mission":{"id":"m1","title":"Ship it","status":"review","progress":100}}"#,
        );
        journal_emit_inner(&mut conn, &updated_review).expect("emit updated (review)");
        let missions = journal_missions_current_inner(&conn, None).expect("query missions");
        assert_eq!(missions[0].status, "review");
        assert!(missions[0].data.contains("\"progress\":100"), "got: {}", missions[0].data);

        eprintln!("mission_updated_refreshes_data_and_status PASSED");
    }

    // ── T2.0: Projection queries ──────────────────────────────────────

    fn make_event_with_project(type_: &str, mission_id: &str, project_id: &str, payload: &str) -> JournalEventIn {
        JournalEventIn {
            ts_ms: 1_720_000_000_000,
            project_id: project_id.to_string(),
            mission_id: Some(mission_id.to_string()),
            agent_id: None,
            run_id: None,
            actor: "agent".to_string(),
            type_: type_.to_string(),
            payload: payload.to_string(),
            tokens_in: Some(100),
            tokens_out: Some(200),
            cost_usd: Some(0.05),
        }
    }

    #[test]
    fn fleet_overview_aggregates_per_project() {
        let mut conn = fresh_db();

        // Project A: 1 running, 1 done
        journal_emit_inner(&mut conn, &make_event_with_project("mission.started", "m1", "proj-a", r#"{"mission":{"id":"m1","status":"running"}}"#)).unwrap();
        journal_emit_inner(&mut conn, &make_event_with_project("mission.approved", "m2", "proj-a", r#"{"mission":{"id":"m2","status":"done"}}"#)).unwrap();

        // Project B: 1 queued, 1 failed
        journal_emit_inner(&mut conn, &make_event_with_project("mission.created", "m3", "proj-b", r#"{"mission":{"id":"m3","status":"queued"}}"#)).unwrap();
        journal_emit_inner(&mut conn, &make_event_with_project("mission.failed", "m4", "proj-b", r#"{"mission":{"id":"m4","status":"failed"}}"#)).unwrap();

        let kpis = journal_fleet_overview_inner(&conn).expect("fleet overview");
        assert_eq!(kpis.len(), 2);

        let proj_a = kpis.iter().find(|k| k.project_id == "proj-a").expect("proj-a");
        assert_eq!(proj_a.running, 1);
        assert_eq!(proj_a.done, 1);
        assert_eq!(proj_a.queued, 0);
        assert_eq!(proj_a.failed, 0);
        assert!((proj_a.total_cost_usd - 0.10).abs() < 0.001, "cost: {}", proj_a.total_cost_usd);
        assert_eq!(proj_a.total_tokens, 600);

        let proj_b = kpis.iter().find(|k| k.project_id == "proj-b").expect("proj-b");
        assert_eq!(proj_b.queued, 1);
        assert_eq!(proj_b.failed, 1);
        assert_eq!(proj_b.running, 0);

        eprintln!("fleet_overview_aggregates_per_project PASSED");
    }

    #[test]
    fn attention_inbox_returns_review_and_failed() {
        let mut conn = fresh_db();

        journal_emit_inner(&mut conn, &make_event_with_project("mission.started", "m1", "proj-a", r#"{"mission":{"id":"m1","status":"running"}}"#)).unwrap();
        journal_emit_inner(&mut conn, &make_event_with_project("mission.review_requested", "m2", "proj-a", r#"{"mission":{"id":"m2","status":"review"}}"#)).unwrap();
        journal_emit_inner(&mut conn, &make_event_with_project("mission.failed", "m3", "proj-b", r#"{"mission":{"id":"m3","status":"failed"}}"#)).unwrap();

        // All projects
        let items = journal_attention_inbox_inner(&conn, None).expect("attention inbox");
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|i| i.mission_id == "m2" && i.status == "review"));
        assert!(items.iter().any(|i| i.mission_id == "m3" && i.status == "failed"));

        // Scoped to proj-a
        let scoped = journal_attention_inbox_inner(&conn, Some("proj-a")).expect("attention inbox scoped");
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].mission_id, "m2");

        eprintln!("attention_inbox_returns_review_and_failed PASSED");
    }

    // ── T2.5: journal_since (resume briefing primitive) ────────────────

    #[test]
    fn journal_since_returns_events_after_ts() {
        let mut conn = fresh_db();

        // Three events at increasing ts_ms, spanning two projects.
        let mut before = make_event_with_project("mission.created", "m1", "proj-a", "{}");
        before.ts_ms = 100;
        let mut at_cutoff = make_event_with_project("mission.started", "m1", "proj-a", "{}");
        at_cutoff.ts_ms = 200;
        let mut after = make_event_with_project("mission.completed", "m2", "proj-b", "{}");
        after.ts_ms = 300;

        journal_emit_inner(&mut conn, &before).expect("emit before");
        journal_emit_inner(&mut conn, &at_cutoff).expect("emit at_cutoff");
        journal_emit_inner(&mut conn, &after).expect("emit after");

        // since_ms = 200 is inclusive and must exclude the ts_ms=100 event,
        // ordered ascending (oldest of the remaining two first).
        let results = journal_since_inner(&conn, None, 200, None).expect("journal_since");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].ts_ms, 200);
        assert_eq!(results[1].ts_ms, 300);
        assert!(results[0].seq < results[1].seq, "must be ordered ascending by seq");

        // Project scoping still applies.
        let scoped = journal_since_inner(&conn, Some("proj-a"), 0, None).expect("journal_since scoped");
        assert_eq!(scoped.len(), 2);
        assert!(scoped.iter().all(|e| e.project_id == "proj-a"));

        // An explicit limit is honored (and, being a since_ms query, ASC —
        // the OLDEST event is returned first, not the newest).
        let limited = journal_since_inner(&conn, None, 0, Some(1)).expect("journal_since limited");
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].ts_ms, 100, "limited ASC query returns the OLDEST event first");

        eprintln!("journal_since_returns_events_after_ts PASSED");
    }

    /// Defect-2 regression: a `since_ms`-only filter (no `project_id`, no
    /// `types` — the resume-briefing / "what's new since I last looked"
    /// tail shape `journal_since_inner` and `journalQuery`'s own `sinceMs`
    /// option both produce) must use `idx_events_ts`, not degrade into a
    /// full table scan. Asserted two ways, deliberately NOT via a wall-clock
    /// bound alone (see the `wait_child_with_timeout` test's own fix in
    /// capture.rs for why a bare timing assertion is fragile under CI load):
    ///
    /// 1. `EXPLAIN QUERY PLAN` must show a `SEARCH` on `idx_events_ts`, not
    ///    a `SCAN` of `events` — a deterministic, load-independent proof
    ///    that the index is actually used, not just "was fast this run".
    /// 2. A generous wall-clock ceiling against a real 20k-row synthetic
    ///    journal (roughly the owner's actual production row count,
    ///    measured directly against a copy of their real journal.db) as a
    ///    sanity backstop against a query-plan regression that somehow
    ///    stays fast to `EXPLAIN` but slow in practice.
    #[test]
    fn since_ms_only_query_uses_index_not_full_scan() {
        let mut conn = fresh_db();

        const N: i64 = 20_000;
        {
            let tx = conn.transaction().expect("begin seed transaction");
            for i in 0..N {
                let event = JournalEventIn {
                    ts_ms: i, // strictly increasing, mirrors real insert order
                    project_id: "proj-a".to_string(),
                    mission_id: None,
                    agent_id: None,
                    run_id: None,
                    actor: "agent".to_string(),
                    type_: "tool.called".to_string(),
                    payload: "{}".to_string(),
                    tokens_in: None,
                    tokens_out: None,
                    cost_usd: None,
                };
                insert_event_row(&tx, &event, &event.payload).expect("seed insert");
            }
            tx.commit().expect("commit seed transaction");
        }

        // A `since_ms` cutoff past every seeded row: the worst case for a
        // full scan (every row is examined and rejected, nothing short-
        // circuits it), and the exact shape that measured 549ms against the
        // real production journal.db before this fix.
        //
        // Reuses the EXACT SQL + hint-insertion `journal_query_events_inner`
        // uses for this filter shape (`build_query_events_sql` +
        // `with_ts_index_hint`) rather than a hand-written duplicate — a
        // duplicate string could pass this assertion while the real
        // function's own query-building logic silently drifted from it
        // (e.g. the `force_ts_index` condition changing), which would make
        // this test worthless as a regression guard.
        let filter = JournalFilter { since_ms: Some(N + 1), ..Default::default() };
        let (sql, bound, force_ts_index) = build_query_events_sql(&filter);
        assert!(force_ts_index, "this filter shape must set force_ts_index");
        let plan: String = {
            let mut stmt = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {}", with_ts_index_hint(&sql)))
                .expect("prepare explain");
            let param_refs: Vec<&dyn ToSql> = bound.iter().map(|b| b.as_ref()).collect();
            let rows = stmt
                .query_map(param_refs.as_slice(), |row| row.get::<_, String>(3))
                .expect("query_map explain");
            rows.filter_map(|r| r.ok()).collect::<Vec<_>>().join(" | ")
        };
        assert!(
            plan.contains("idx_events_ts") && !plan.to_uppercase().contains("SCAN EVENTS"),
            "since_ms-only query must SEARCH idx_events_ts, not SCAN the events table — plan: {}",
            plan
        );

        let start = Instant::now();
        let results = journal_query_events_inner(&conn, &filter).expect("since_ms-only query");
        let elapsed = start.elapsed();

        assert!(results.is_empty(), "cutoff past every seeded row must match nothing");
        assert!(
            elapsed < Duration::from_millis(300),
            "since_ms-only query against {} rows took {:?} — should be a near-instant index seek, not proportional to table size",
            N, elapsed
        );

        eprintln!(
            "since_ms_only_query_uses_index_not_full_scan PASSED (plan={}, elapsed={:?})",
            plan, elapsed
        );
    }

    /// Defect-2 hardening: `INDEXED BY` is a HARD constraint in SQLite —
    /// `prepare()` errors outright ("no such index") if the named index is
    /// missing, it does not silently degrade to a scan on its own. Every
    /// path that reaches `journal_query_events_inner` in this codebase runs
    /// `init_journal_schema` first and either propagates or panics on its
    /// failure (see `journal_query_events_inner`'s own doc comment for the
    /// full enumeration) — EXCEPT `open_journal_for_app`'s in-memory
    /// fallback, which deliberately logs-and-continues on a schema-init
    /// failure. `SCHEMA_SQL`'s `execute_batch` is not wrapped in an explicit
    /// transaction, so a failure partway through it could in principle leave
    /// `events` created but `idx_events_ts` never reached. This test proves
    /// a `since_ms`-only query still SUCCEEDS (degrading to a plain scan,
    /// not erroring) against exactly that broken state, by building a
    /// connection with the `events` table but deliberately WITHOUT
    /// `idx_events_ts` — never depend on this fallback becoming dead code
    /// just because today's schema init happens to be reliable in practice.
    #[test]
    fn since_ms_only_query_falls_back_when_ts_index_is_missing() {
        let conn = Connection::open_in_memory().expect("open_in_memory");
        conn.execute_batch(
            "CREATE TABLE events (
               seq INTEGER PRIMARY KEY AUTOINCREMENT,
               ts_ms INTEGER NOT NULL,
               project_id TEXT NOT NULL,
               mission_id TEXT,
               agent_id TEXT,
               run_id TEXT,
               actor TEXT NOT NULL,
               type TEXT NOT NULL,
               payload TEXT NOT NULL,
               tokens_in INTEGER DEFAULT 0,
               tokens_out INTEGER DEFAULT 0,
               cost_usd REAL DEFAULT 0
             );
             CREATE TABLE missions_current (
               mission_id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               status TEXT NOT NULL,
               data TEXT NOT NULL,
               updated_ms INTEGER NOT NULL
             );",
            // Deliberately NO indexes at all, including idx_events_ts —
            // simulates SCHEMA_SQL's execute_batch stopping before it, or
            // any other future connection that reaches this function
            // without the full, current schema.
        )
        .expect("create tables without idx_events_ts");

        // Insert directly via plain SQL (journal_emit_inner takes
        // &mut Connection and also calls init_journal_schema-adjacent
        // helpers we're deliberately bypassing here) — a single row is
        // enough to prove the query path executes successfully end to end.
        conn.execute(
            "INSERT INTO events (ts_ms, project_id, mission_id, agent_id, run_id, actor, type, payload, tokens_in, tokens_out, cost_usd)
             VALUES (1000, 'proj-a', 'm1', NULL, NULL, 'agent', 'tool.called', '{}', 0, 0, 0.0)",
            [],
        )
        .expect("insert probe row");

        let filter = JournalFilter { since_ms: Some(500), ..Default::default() };
        let result = journal_query_events_inner(&conn, &filter);

        assert!(
            result.is_ok(),
            "a missing idx_events_ts must degrade to a plain scan, not hard-fail: {:?}",
            result.err()
        );
        let rows = result.unwrap();
        assert_eq!(rows.len(), 1, "the probe row (ts_ms=1000 >= since_ms=500) must still be found");
        assert_eq!(rows[0].mission_id.as_deref(), Some("m1"));

        eprintln!("since_ms_only_query_falls_back_when_ts_index_is_missing PASSED");
    }

    #[test]
    fn activity_feed_returns_recent_events_with_preview() {
        let mut conn = fresh_db();

        journal_emit_inner(&mut conn, &make_event_with_project("mission.created", "m1", "proj-a", r#"{"note":"first"}"#)).unwrap();
        journal_emit_inner(&mut conn, &make_event_with_project("tool.called", "m1", "proj-a", r#"{"note":"second"}"#)).unwrap();

        let feed = journal_activity_feed_inner(&conn, None, Some(10)).expect("activity feed");
        assert_eq!(feed.len(), 2);
        // DESC order: most recent first
        assert_eq!(feed[0].event_type, "tool.called");
        assert_eq!(feed[1].event_type, "mission.created");
        assert!(feed[0].payload_preview.contains("second"));
        assert!(feed[1].payload_preview.contains("first"));

        // Scoped
        let scoped = journal_activity_feed_inner(&conn, Some("proj-b"), None).expect("activity feed scoped");
        assert_eq!(scoped.len(), 0);

        eprintln!("activity_feed_returns_recent_events_with_preview PASSED");
    }

    // ── Agent stats (audit follow-up: T2.0's journal_agent_stats gap) ──

    #[allow(clippy::too_many_arguments)]
    fn make_agent_event(
        type_: &str,
        agent_id: &str,
        run_id: Option<&str>,
        mission_id: &str,
        ts_ms: i64,
        tokens_in: i64,
        tokens_out: i64,
        cost_usd: f64,
    ) -> JournalEventIn {
        JournalEventIn {
            ts_ms,
            project_id: "proj-1".to_string(),
            mission_id: Some(mission_id.to_string()),
            agent_id: Some(agent_id.to_string()),
            run_id: run_id.map(|s| s.to_string()),
            actor: "agent".to_string(),
            type_: type_.to_string(),
            payload: "{}".to_string(),
            tokens_in: Some(tokens_in),
            tokens_out: Some(tokens_out),
            cost_usd: Some(cost_usd),
        }
    }

    #[test]
    fn agent_stats_aggregates_runs_completed_failed_tokens_cost_per_agent() {
        let mut conn = fresh_db();

        // agent-a: two distinct runs (r1 completed, r2 failed).
        journal_emit_inner(&mut conn, &make_agent_event("mission.started", "agent-a", Some("r1"), "m1", 1_000, 100, 50, 0.01)).unwrap();
        journal_emit_inner(&mut conn, &make_agent_event("mission.completed", "agent-a", Some("r1"), "m1", 2_000, 10, 5, 0.001)).unwrap();
        journal_emit_inner(&mut conn, &make_agent_event("mission.started", "agent-a", Some("r2"), "m2", 3_000, 200, 100, 0.02)).unwrap();
        journal_emit_inner(&mut conn, &make_agent_event("mission.failed", "agent-a", Some("r2"), "m2", 4_000, 0, 0, 0.0)).unwrap();

        // agent-b: run_id always null -> "runs" falls back to mission_id.
        journal_emit_inner(&mut conn, &make_agent_event("mission.completed", "agent-b", None, "m3", 5_000, 50, 25, 0.005)).unwrap();

        // No agent_id at all: must never appear in results nor pollute any group.
        let mut no_agent = make_agent_event("tool.called", "unused", None, "m4", 6_000, 999, 999, 9.9);
        no_agent.agent_id = None;
        journal_emit_inner(&mut conn, &no_agent).unwrap();

        let stats = journal_agent_stats_inner(&conn, None).expect("agent stats");
        assert_eq!(stats.len(), 2, "only agent-a and agent-b, got: {:?}", stats);

        let a = stats.iter().find(|s| s.agent_id == "agent-a").expect("agent-a");
        assert_eq!(a.runs, 2, "r1 and r2 are 2 distinct runs");
        assert_eq!(a.completed, 1);
        assert_eq!(a.failed, 1);
        assert_eq!(a.total_tokens, 100 + 50 + 10 + 5 + 200 + 100);
        assert!((a.total_cost_usd - (0.01 + 0.001 + 0.02)).abs() < 1e-9, "cost: {}", a.total_cost_usd);
        assert_eq!(a.last_active_ms, 4_000);

        let b = stats.iter().find(|s| s.agent_id == "agent-b").expect("agent-b");
        assert_eq!(b.runs, 1, "falls back to mission_id when run_id is null");
        assert_eq!(b.completed, 1);
        assert_eq!(b.failed, 0);

        eprintln!("agent_stats_aggregates_runs_completed_failed_tokens_cost_per_agent PASSED");
    }

    #[test]
    fn agent_stats_filters_to_a_single_agent_id_when_given() {
        let mut conn = fresh_db();
        journal_emit_inner(&mut conn, &make_agent_event("mission.completed", "agent-a", Some("r1"), "m1", 1_000, 10, 10, 0.01)).unwrap();
        journal_emit_inner(&mut conn, &make_agent_event("mission.completed", "agent-b", Some("r2"), "m2", 2_000, 20, 20, 0.02)).unwrap();

        let scoped = journal_agent_stats_inner(&conn, Some("agent-b")).expect("scoped agent stats");
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].agent_id, "agent-b");
        assert_eq!(scoped[0].total_tokens, 40);

        eprintln!("agent_stats_filters_to_a_single_agent_id_when_given PASSED");
    }

    // ── Retention (audit follow-up: spec section 4.4, wired nowhere before) ──

    #[test]
    fn retention_compacts_old_detail_events_but_keeps_new_ones_and_terminal_events() {
        let mut conn = fresh_db();
        let now_ms = chrono::Utc::now().timestamp_millis();
        let old_ms = now_ms - 100 * 86_400_000; // 100 days old: past the 90-day window
        let recent_ms = now_ms - 1 * 86_400_000; // 1 day old: well inside the window

        let mut old_tool = make_event_with_project(
            "tool.called", "m1", "proj-a", r#"{"name":"Edit","files":["secret_old.rs"]}"#,
        );
        old_tool.ts_ms = old_ms;
        journal_emit_inner(&mut conn, &old_tool).unwrap();

        let mut recent_tool = make_event_with_project(
            "tool.called", "m1", "proj-a", r#"{"name":"Edit","files":["fresh.rs"]}"#,
        );
        recent_tool.ts_ms = recent_ms;
        journal_emit_inner(&mut conn, &recent_tool).unwrap();

        // Old but a TERMINAL type (mission.completed is not in the
        // compactable set) — must survive retention with payload intact.
        let mut old_terminal = make_event_with_project(
            "mission.completed", "m1", "proj-a", r#"{"durationMs":123456}"#,
        );
        old_terminal.ts_ms = old_ms;
        journal_emit_inner(&mut conn, &old_terminal).unwrap();

        let types: Vec<String> = DEFAULT_COMPACTABLE_TYPES.iter().map(|s| s.to_string()).collect();
        let summary = journal_retention_run_inner(&mut conn, DEFAULT_RETENTION_DAYS, &types, 500)
            .expect("retention run");
        assert_eq!(summary.compacted, 1, "only the old tool.called row is eligible");

        let all = journal_query_events_inner(&conn, &JournalFilter::default()).expect("query all");
        assert_eq!(all.len(), 3, "retention must never delete rows");

        let old_row = all.iter().find(|e| e.ts_ms == old_ms && e.type_ == "tool.called").expect("old tool.called row");
        assert_eq!(old_row.payload, COMPACTED_PAYLOAD, "old detail payload must be compacted");

        let recent_row = all.iter().find(|e| e.ts_ms == recent_ms).expect("recent tool.called row");
        assert!(recent_row.payload.contains("fresh.rs"), "recent detail must survive untouched, got: {}", recent_row.payload);

        let terminal_row = all.iter().find(|e| e.type_ == "mission.completed").expect("terminal row");
        assert!(terminal_row.payload.contains("123456"), "terminal event payload must never be compacted, got: {}", terminal_row.payload);

        eprintln!("retention_compacts_old_detail_events_but_keeps_new_ones_and_terminal_events PASSED");
    }

    #[test]
    fn retention_batch_size_bounds_a_single_pass_and_is_idempotent() {
        let mut conn = fresh_db();
        let old_ms = chrono::Utc::now().timestamp_millis() - 200 * 86_400_000;

        for i in 0..5 {
            let mut e = make_event_with_project(
                "mission.step", &format!("m{}", i), "proj-a", &format!(r#"{{"text":"step {}"}}"#, i),
            );
            e.ts_ms = old_ms;
            journal_emit_inner(&mut conn, &e).unwrap();
        }

        let types = vec!["mission.step".to_string()];

        // First pass: batch_size=2 bounds the write to 2 of the 5 eligible rows.
        let first = journal_retention_run_inner(&mut conn, 90, &types, 2).expect("first pass");
        assert_eq!(first.compacted, 2);
        let all = journal_query_events_inner(&conn, &JournalFilter::default()).expect("query all");
        assert_eq!(all.iter().filter(|e| e.payload == COMPACTED_PAYLOAD).count(), 2);

        // Second pass at the same batch size compacts 2 more (never
        // re-touching the already-compacted 2 — the idempotency guard).
        let second = journal_retention_run_inner(&mut conn, 90, &types, 2).expect("second pass");
        assert_eq!(second.compacted, 2);

        // Third pass with a large batch size drains the last one.
        let third = journal_retention_run_inner(&mut conn, 90, &types, 500).expect("third pass");
        assert_eq!(third.compacted, 1);

        let all = journal_query_events_inner(&conn, &JournalFilter::default()).expect("query all again");
        assert!(all.iter().all(|e| e.payload == COMPACTED_PAYLOAD), "all 5 rows must end up compacted");

        // A further pass finds nothing left to do.
        let fourth = journal_retention_run_inner(&mut conn, 90, &types, 500).expect("fourth pass");
        assert_eq!(fourth.compacted, 0, "idempotent: nothing left to compact");

        eprintln!("retention_batch_size_bounds_a_single_pass_and_is_idempotent PASSED");
    }

    #[test]
    fn retention_never_touches_missions_current_and_runs_vacuum() {
        let mut conn = fresh_db();
        let old_ms = chrono::Utc::now().timestamp_millis() - 120 * 86_400_000;

        let created = make_event_with_project(
            "mission.created", "m1", "proj-a", r#"{"mission":{"id":"m1","title":"Ship it","status":"running"}}"#,
        );
        journal_emit_inner(&mut conn, &created).unwrap();
        let mut old_tool = make_event_with_project("tool.called", "m1", "proj-a", r#"{"name":"Read"}"#);
        old_tool.ts_ms = old_ms;
        journal_emit_inner(&mut conn, &old_tool).unwrap();

        let before = journal_missions_current_inner(&conn, None).expect("missions before");
        assert_eq!(before.len(), 1);

        let types: Vec<String> = DEFAULT_COMPACTABLE_TYPES.iter().map(|s| s.to_string()).collect();
        let summary = journal_retention_run_inner(&mut conn, DEFAULT_RETENTION_DAYS, &types, 500)
            .expect("retention run");
        assert_eq!(summary.compacted, 1);
        assert!(summary.vacuumed, "VACUUM must succeed against a normal connection");

        let after = journal_missions_current_inner(&conn, None).expect("missions after");
        assert_eq!(after.len(), before.len());
        assert_eq!(after[0].mission_id, before[0].mission_id);
        assert_eq!(after[0].status, before[0].status);
        assert_eq!(after[0].data, before[0].data);
        assert_eq!(after[0].updated_ms, before[0].updated_ms);

        eprintln!("retention_never_touches_missions_current_and_runs_vacuum PASSED");
    }

    #[test]
    fn retention_with_no_compactable_types_is_a_cheap_noop() {
        let mut conn = fresh_db();
        let summary = journal_retention_run_inner(&mut conn, 90, &[], 500).expect("retention run");
        assert_eq!(summary.compacted, 0);
        assert!(!summary.vacuumed, "must short-circuit before VACUUM when there is nothing to do");
        eprintln!("retention_with_no_compactable_types_is_a_cheap_noop PASSED");
    }

}
