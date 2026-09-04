//! Neuron capture (HTML rendering of a CaptureEvent) and graph
//! rebuild/consolidation maintenance.

use std::io::Write as IoWrite;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{Emitter, Manager};

use crate::state::ProjectState;
use crate::commands::brain::sidecar::{BrainState, brain_path_from_project};
use crate::commands::brain::config::resolve_lazybrain_bin_static;
use crate::commands::brain::ops::{record_ops_idle_unless_timed_out, record_ops_running, record_ops_timed_out};
use crate::commands::util::{
    apply_below_normal_priority, force_kill_pid, truncate_on_char_boundary, BoundedGate,
};

/// Generic IDE event that gets stored as a neuron in the brain.
///
/// `kind` maps to `data-cerveau-type`:
///   edit      → episodic (file touched)
///   decision  → decision
///   episodic  → episodic
///   agent     → episodic (AI-generated note)
///   commit    → procedural (git commit record)
///   learning  → learning (post-mission or post-chat learning insights)
///
/// Optional fields `topic` and `space` are additive — existing callers that
/// omit them are unaffected; when present they appear as HTML attributes.
///
/// Optional `insights` field: when present with `kind: "learning"`, each
/// insight is rendered as a structured `<div data-cerveau-insight>` element
/// inside a `<section data-cerveau-learning>` wrapper.
#[derive(Deserialize, Debug)]
pub struct CaptureEvent {
    pub kind: String,
    pub title: String,
    pub text: String,
    pub tags: Option<Vec<String>>,
    pub files: Option<Vec<String>>,
    pub source: Option<String>,
    /// Optional topic slug, e.g. "rust-async". Emitted as data-cerveau-topic.
    /// When absent, auto-derived from the project root (basename, lowercased).
    pub topic: Option<String>,
    /// Optional knowledge space: "topical" or "code". Emitted as data-cerveau-space.
    /// When absent, defaults to "code" for edit/agent kinds, omitted for others.
    pub space: Option<String>,
    /// Optional author (display name or email of the writing user). Emitted
    /// as data-cerveau-author on the article AND on the fact paragraph so
    /// shared (team) neurons know "qui a écrit quoi". When absent, no
    /// data-cerveau-author attribute is emitted (solo captures unchanged).
    pub author: Option<String>,
    #[serde(rename = "authorId")]
    pub author_id: Option<String>,
    #[serde(rename = "orgId")]
    pub org_id: Option<String>,
    /// Optional department scope. Emitted as data-cerveau-dept on the article
    /// (same pattern as org_id above), so a team brain can be CSS-filtered by
    /// department. Stamped by capture.ts dispatch() / enrichCaptureAuthor()
    /// from the signed-in org member's dept slug.
    pub dept: Option<String>,
    /// Optional typed kind (decision|bug|rule|idea|qa|warning|activity).
    /// Emitted as data-cerveau-kind. When absent, no data-cerveau-kind attribute.
    #[serde(rename = "itemKind")]
    pub item_kind: Option<String>,
    /// Optional file path this item is about (e.g. "file:src/payments/stripe.ts").
    /// Emitted as data-cerveau-about.
    pub about: Option<String>,
    pub project: Option<String>,
    /// Optional working directory. Emitted as data-cerveau-cwd.
    /// When absent, filled from ProjectState (the open project root).
    pub cwd: Option<String>,
    /// Optional structured learning insights — rendered as specialized HTML
    /// elements when kind is "learning". Ignored for other kinds.
    pub insights: Option<Vec<InsightPayload>>,
    /// When true, and a note with the same id already exists, the engine
    /// upserts instead of conflicting: it replaces the existing note's body
    /// ONLY if this event's text is richer than what's already stored,
    /// preserving the original data-cerveau-created and refreshing
    /// data-cerveau-updated (see engine/src/store/upsert.ts). Mirrors the
    /// TS-side `CaptureEvent.upsertIfRicher` (src/lib/platform/types.ts),
    /// used by the mission-completion capture so the rich completion text
    /// is never silently dropped behind the sparse kickoff note sharing the
    /// same title+day id. Absent/false preserves today's behavior — no
    /// extra flag is forwarded to the `store` CLI (see `store_command_args`).
    #[serde(rename = "upsertIfRicher")]
    pub upsert_if_richer: Option<bool>,
    /// Optional deterministic identity for this capture, independent of
    /// title/content. When present (and non-empty), `event_to_html` builds
    /// the note's `id` directly from this string — sanitized, no date or
    /// random suffix — instead of the title+day+random-suffix scheme every
    /// other capture uses. Mirrors the TS-side `CaptureEvent.stableId`
    /// (src/lib/platform/types.ts) — see that field's own doc comment for
    /// why the random suffix below defeats `upsertIfRicher` for any caller
    /// that needs the SAME note updated across two separate capture calls.
    #[serde(rename = "stableId")]
    pub stable_id: Option<String>,
}

/// A single learning insight rendered as a structured HTML element.
#[derive(Deserialize, Debug)]
pub struct InsightPayload {
    pub kind: String,
    pub title: String,
    pub description: String,
    pub actionable: bool,
    pub suggestion: Option<String>,
}

/// Escape a string for safe interpolation into HTML attributes and text content.
///
/// Replaces the five XML special characters so that user-supplied strings
/// (file paths, source identifiers, tags) cannot inject markup into the
/// stored neuron HTML (stored XSS prevention).
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
     .replace('\'', "&#39;")
}

/// Scrub common secret patterns from a string before it is stored in the brain.
/// Replaces each match with [REDACTED]. Mirrors engine/src/util/scrub.ts.
fn scrub_secrets(s: &str) -> String {
    use regex::Regex;
    let patterns: &[&str] = &[
        r"sk-ant-[A-Za-z0-9_-]{20,}",
        r"sk_(?:live|test)_[A-Za-z0-9]{20,}",
        r"ghp_[A-Za-z0-9]{36,}",
        r"github_pat_[A-Za-z0-9_]{50,}",
        r"AKIA[A-Z0-9]{16}",
        r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
        r"(?i)password\s*[:=]\s*\S+",
        r"(?i)secret\s*[:=]\s*\S+",
        r"(?i)api[_-]?key\s*[:=]\s*\S+",
    ];
    let mut result = s.to_string();
    for pat in patterns {
        if let Ok(re) = Regex::new(pat) {
            result = re.replace_all(&result, "[REDACTED]").to_string();
        }
    }
    result
}

/// Derive a topic slug from a project root path.
/// Mirrors the engine's `normalizeCwd()` → `slugifyCwd()` pipeline:
/// takes the basename, lowercases it, replaces non-alphanum with hyphens.
/// Returns empty string when the path is empty or only generic segments.
pub(crate) fn derive_topic_from_cwd(cwd: &str) -> String {
    if cwd.is_empty() {
        return String::new();
    }
    let normalized = cwd.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return String::new();
    }
    // Take the last segment as the project name
    let mut base = parts.last().copied().unwrap_or("");
    // Skip generic segments, try the one before
    if ["src", "app", "project", "code", ""].contains(&base.to_lowercase().as_str()) {
        if parts.len() >= 2 {
            base = parts[parts.len() - 2];
        }
    }
    let slug: String = base
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    slug.split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(64)
        .collect()
}

/// Build a valid `data-cerveau-*` neuron HTML from a `CaptureEvent`.
/// `project_root`: the open project's root path (from ProjectState), used to
/// fill data-cerveau-cwd and auto-derive topic when the event doesn't provide them.
fn event_to_html(ev: &CaptureEvent, project_root: &str) -> String {
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let cerveau_type = match ev.kind.as_str() {
        "decision" => "decision",
        "commit"   => "procedural",
        "learning" => "learning",
        _          => "episodic",
    };

    // Build a URL-safe id from title + timestamp suffix.
    let id_raw = format!("{}-{}", ev.title.to_lowercase(), &now[..10]);
    let id: String = id_raw.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    // char-boundary-safe: `id` is built from `.is_alphanumeric()` chars, which
    // includes non-ASCII letters (accented Latin, CJK, ...) — a plain
    // `id[..80]` can panic if a multi-byte character straddles byte 80.
    let id = truncate_on_char_boundary(&id, 80).to_string();
    // Append a short random suffix to avoid collisions across authors on the same day.
    let suffix: String = uuid::Uuid::new_v4().simple().to_string();
    let id = format!("{}-{}", id, &suffix[..4]);
    let id = truncate_on_char_boundary(&id, 80).to_string();

    // Deterministic-identity override (see CaptureEvent.stable_id's own doc
    // comment): when the caller supplies a non-empty stable_id, it REPLACES
    // the title+date+random-suffix id computed above — sanitized the same
    // way, but with no date and no random suffix. This is what lets a
    // capture with a real stable identity (e.g. one LazyManager conversation,
    // closed and later reopened/extended) resolve to the SAME notePath on
    // every call, so upsert_if_richer (engine/src/store/upsert.ts) can find
    // and update it instead of always creating a fresh note. Every existing
    // caller leaves stable_id unset and is completely unaffected — the id
    // computed above is used as-is.
    let id = match ev.stable_id.as_deref().filter(|s| !s.is_empty()) {
        Some(stable) => {
            let sanitized: String = stable.chars()
                .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
                .collect::<String>()
                .split('-')
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("-");
            truncate_on_char_boundary(&sanitized, 80).to_string()
        }
        None => id,
    };

    // Escape all user-supplied strings before interpolation into HTML.
    let tags_str = html_escape(&ev.tags.as_deref().unwrap_or(&[]).join(" "));
    let source_str = html_escape(ev.source.as_deref().unwrap_or("lazy-ide:capture"));

    // Resolve cwd: explicit event field > project root from ProjectState.
    let cwd_val = ev.cwd.as_deref()
        .filter(|c| !c.is_empty())
        .unwrap_or(project_root);
    let cwd_attr = if !cwd_val.is_empty() {
        format!("\n         data-cerveau-cwd=\"{}\"", html_escape(cwd_val))
    } else {
        String::new()
    };

    // Resolve topic: explicit event field > auto-derived from cwd basename.
    let topic_val = ev.topic.as_deref()
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .unwrap_or_else(|| derive_topic_from_cwd(cwd_val));
    let topic_attr = if !topic_val.is_empty() {
        format!("\n         data-cerveau-topic=\"{}\"", html_escape(&topic_val))
    } else {
        String::new()
    };

    // Resolve space: explicit event field > default "code" for edit/agent kinds.
    let space_val = ev.space.as_deref()
        .filter(|s| *s == "topical" || *s == "code")
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            if ev.kind == "edit" || ev.kind == "agent" {
                "code".to_string()
            } else {
                String::new()
            }
        });
    let space_attr = if !space_val.is_empty() {
        format!("\n         data-cerveau-space=\"{}\"", html_escape(&space_val))
    } else {
        String::new()
    };

    // Optional author attribution (team brains: "qui a écrit quoi et quand").
    let author_attr = ev.author
        .as_deref()
        .filter(|a| !a.is_empty())
        .map(|a| format!("\n         data-cerveau-author=\"{}\"", html_escape(a)))
        .unwrap_or_default();
    let fact_author_attr = ev.author
        .as_deref()
        .filter(|a| !a.is_empty())
        .map(|a| format!(" data-cerveau-author=\"{}\" data-cerveau-created=\"{}\"", html_escape(a), now))
        .unwrap_or_default();

    let author_id_attr = ev.author_id.as_deref()
        .filter(|a| !a.is_empty())
        .map(|a| format!("\n         data-cerveau-author-id=\"{}\"", html_escape(a)))
        .unwrap_or_default();
    let org_id_attr = ev.org_id.as_deref()
        .filter(|a| !a.is_empty())
        .map(|a| format!("\n         data-cerveau-org-id=\"{}\"", html_escape(a)))
        .unwrap_or_default();
    // Optional department scope (team brains: filter notes by dept, same
    // pattern as org_id_attr above — dept is declared on CaptureEvent but,
    // as of this fix, still has no TS caller that populates it; see this
    // module's header note / the audit report for what would populate it).
    let dept_attr = ev.dept.as_deref()
        .filter(|a| !a.is_empty())
        .map(|a| format!("\n         data-cerveau-dept=\"{}\"", html_escape(a)))
        .unwrap_or_default();
    let kind_attr = ev.item_kind.as_deref()
        .filter(|a| !a.is_empty())
        .map(|a| format!("\n         data-cerveau-kind=\"{}\"", html_escape(a)))
        .unwrap_or_default();
    let about_attr = ev.about.as_deref()
        .filter(|a| !a.is_empty())
        .map(|a| format!("\n         data-cerveau-about=\"{}\"", html_escape(a)))
        .unwrap_or_default();
    let project_attr = ev.project.as_deref()
        .filter(|a| !a.is_empty())
        .map(|a| format!("\n         data-cerveau-project=\"{}\"", html_escape(a)))
        .unwrap_or_default();

    // Build file references section (optional).
    // File paths are HTML-escaped to prevent stored XSS via crafted file names.
    let files_html = if let Some(files) = &ev.files {
        if files.is_empty() {
            String::new()
        } else {
            let items: String = files.iter()
                .map(|f| format!(
                    "    <li data-cerveau-fact data-cerveau-extracted-by=\"human\"><code>{}</code></li>\n",
                    html_escape(f)
                ))
                .collect();
            format!("  <ul>\n{}</ul>\n", items)
        }
    } else {
        String::new()
    };

    // Build structured learning insights section (optional).
    // Each insight becomes a <div data-cerveau-insight> with its own
    // data-cerveau-fact paragraph and optional suggestion.
    let insights_html = if let Some(insights) = &ev.insights {
        if insights.is_empty() {
            String::new()
        } else {
            let blocks: String = insights.iter()
                .map(|ins| {
                    let confidence = match ins.kind.as_str() {
                        "success_pattern" => "0.9",
                        "failure_pattern" => "0.7",
                        "brain_adaptation" => "0.95",
                        "test_insight" => "0.8",
                        "security_insight" => "0.85",
                        "performance_insight" => "0.75",
                        _ => "0.6",
                    };
                    let actionable_attr = if ins.actionable { " data-cerveau-actionable=\"true\"" } else { "" };
                    let suggestion_html = ins.suggestion.as_deref()
                        .filter(|s| !s.is_empty())
                        .map(|s| format!(
                            "    <p data-cerveau-suggestion data-cerveau-extracted-by=\"agent\">{}</p>\n",
                            html_escape(s)
                        ))
                        .unwrap_or_default();
                    format!(
                        "  <div data-cerveau-insight data-cerveau-insight-kind=\"{}\" data-cerveau-confidence=\"{}\"{actionable_attr}>\n    <p data-cerveau-fact data-cerveau-extracted-by=\"agent\">{}</p>\n{suggestion_html}  </div>\n",
                        html_escape(&ins.kind),
                        confidence,
                        html_escape(&ins.description),
                        suggestion_html = suggestion_html,
                        actionable_attr = actionable_attr,
                    )
                })
                .collect();
            format!("  <section data-cerveau-learning>\n{}</section>\n", blocks)
        }
    } else {
        String::new()
    };

    let scrubbed_text = scrub_secrets(&ev.text);
    let scrubbed_title = scrub_secrets(&ev.title);
    let escaped_text = html_escape(&scrubbed_text);
    let escaped_title = html_escape(&scrubbed_title);

    format!(
        r#"<article id="{id}"
         data-cerveau-version="0.1.0"
         data-cerveau-created="{now}"
         data-cerveau-updated="{now}"
         data-cerveau-type="{cerveau_type}"
         data-cerveau-source="{source_str}"
         data-cerveau-tier="working"
         data-cerveau-importance="0.6"
         data-cerveau-tags="{tags_str}"{cwd_attr}{topic_attr}{space_attr}{author_attr}{author_id_attr}{org_id_attr}{dept_attr}{kind_attr}{about_attr}{project_attr}>

  <h2>{escaped_title}</h2>

  <p data-cerveau-fact data-cerveau-confidence="1.0" data-cerveau-extracted-by="human"{fact_author_attr}>
    {escaped_text}
  </p>
{files_html}{insights_html}</article>
"#,
        id = id,
        now = now,
        cerveau_type = cerveau_type,
        source_str = source_str,
        tags_str = tags_str,
        cwd_attr = cwd_attr,
        topic_attr = topic_attr,
        space_attr = space_attr,
        author_attr = author_attr,
        author_id_attr = author_id_attr,
        org_id_attr = org_id_attr,
        dept_attr = dept_attr,
        kind_attr = kind_attr,
        about_attr = about_attr,
        project_attr = project_attr,
        fact_author_attr = fact_author_attr,
        escaped_title = escaped_title,
        escaped_text = escaped_text,
        files_html = files_html,
        insights_html = insights_html,
    )
}

/// Ceiling for `brain_capture`'s `lazybrain.js store` child process (FIX-4).
///
/// Mirrors search.rs's `RECALL_WARM_TIMEOUT_SECS` (30s, sized to clear the
/// engine's documented ~24s worst-case cold-embedder load): `store` runs
/// with `LAZYBRAIN_EMBEDDINGS=1`, so a first-ever (or slow-machine) capture
/// pays the exact same cold-load cost a recall would. Each file in this
/// module keeps its own copy of this kind of constant rather than importing
/// across files — same pattern as `wait_ready_at`'s 5s bound in sidecar.rs.
const BRAIN_CAPTURE_TIMEOUT_SECS: u64 = 30;

/// Poll an already-spawned child with `try_wait()` until it exits or `secs`
/// seconds have elapsed, then collect its buffered output exactly as
/// `wait_with_output()` would. Kills the child and returns `Err` on timeout.
///
/// Mirrors search.rs's `output_with_timeout` (identical fix for the identical
/// failure class: an unbounded `lazybrain.js` child process hang) but takes
/// an already-SPAWNED `Child` instead of spawning one itself, because
/// `brain_capture` must write the neuron HTML to the child's stdin before it
/// can wait on it — `output_with_timeout` spawns and waits in one call, which
/// does not fit a caller that needs to feed stdin in between.
///
/// FIX-4 root cause: this command used to call the bare, unbounded
/// `child.wait_with_output()`. Real-app QA proved that when this specific
/// `store` child hung (`lazybrain.js store`, PID confirmed still alive
/// minutes later via `Get-CimInstance Win32_Process`), the fire-and-forget
/// `captureAgentMission()` call `addMission` makes right after creating a
/// mission left THIS Tauri command permanently unresolved — and because it
/// never resolves, every *other* `invoke()` the app was concurrently relying
/// on (including `get_project_root`, which `resolveProjectRoot()` awaits
/// immediately afterwards in the very same `addMission`) stopped completing
/// too. The mission never got past `resolveProjectRoot()`, so it never
/// reached `runMission` at all: frozen in 'queued' forever, zero console
/// errors, no worktree — the exact reported symptom. Bounding this call is
/// the fix: a hung `store` now fails this command after
/// `BRAIN_CAPTURE_TIMEOUT_SECS`, which `captureAgentMission`'s existing
/// fire-and-forget error handling (see capture.ts's capture-queue retry)
/// already tolerates, and — critically — releases whatever was blocking
/// every other in-flight `invoke()` call.
fn wait_child_with_timeout(mut child: std::process::Child, secs: u64) -> Result<std::process::Output, String> {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let exited = child
            .try_wait()
            .map_err(|e| format!("try_wait: {}", e))?
            .is_some();

        if exited {
            // try_wait() already cached the exit status, so wait_with_output()
            // here just reads the buffered pipes and returns rather than
            // calling waitpid() again.
            return child
                .wait_with_output()
                .map_err(|e| format!("wait_with_output: {}", e));
        }

        if Instant::now() >= deadline {
            let pid = child.id();
            force_kill_pid(pid);
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("store timed out after {}s", secs));
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Ceiling for each `brain_rebuild_graph` step (index-rebuild / graph --cwd /
/// build-index / health-score). 2026-09-02 live incident: the `graph --cwd
/// <project>` step below ran as a plain unbounded `.status()` and a single
/// spawn stayed alive for >1 h at 100% of a core / 1.4 GB (confirmed via
/// `Get-CimInstance Win32_Process`, parent = the app), pinning
/// `REBUILD_IN_PROGRESS` and feeding the scheduler's "high" local-pressure
/// signal the whole time. Same step in the auto-index pipeline
/// (index_project.rs) is bounded at 180 s; this one is more generous because
/// it is the user-triggered full rebuild, but it is a ceiling, not a budget.
///
/// Windows packaged builds need `rc.exe` (Windows SDK) for `tauri_build`.
/// If that environment is missing, an older binary without these ceilings
/// can keep running — see src-tauri/build.rs. The source of truth is here.
const REBUILD_STEP_TIMEOUT_SECS: u64 = 600;

/// Ceiling for `brain_recompose_all` (was an unbounded `.status()`).
const RECOMPOSE_TIMEOUT_SECS: u64 = 180;

/// `Command::status()` with a deadline: spawn at below-normal priority, poll
/// `try_wait()`, tree-kill on timeout. Same poll/kill shape as
/// `wait_child_with_timeout` above and index_project.rs's
/// `run_step_with_timeout`, returning the exit status so the existing
/// `Ok(s) if s.success()` match arms below stay unchanged.
///
/// `graph --cwd` used to run at the default (high-enough-to-starve-the-IDE)
/// class for the full 600s ceiling. Maintenance children already drop to
/// below-normal; rebuild steps share that policy so a long scan is background
/// work, not a competing foreground job.
fn status_with_timeout(
    cmd: &mut std::process::Command,
    secs: u64,
    label: &str,
    brain_path: &str,
) -> std::io::Result<std::process::ExitStatus> {
    apply_below_normal_priority(cmd);
    let mut child = cmd.spawn()?;
    let pid = child.id();
    record_ops_running(brain_path, label, pid, secs);
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            log::warn!("brain_rebuild_graph: '{}' timed out after {}s — killing", label, secs);
            force_kill_pid(pid);
            let _ = child.kill();
            let _ = child.wait();
            record_ops_timed_out(brain_path, label, pid, secs);
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("{} timed out after {}s", label, secs),
            ));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Max number of `node lazybrain.js store` subprocesses `brain_capture` will
/// run at once. Edits/chat/agent activity can each fire a capture event in
/// quick succession; each one used to spawn its OWN `store` process with no
/// concurrency guard at all, so a burst could pile up N full Node + ONNX
/// embedder processes (~283MB each) simultaneously — a major contributor to
/// memory pressure on lower-RAM machines. 2 keeps writes flowing (no
/// backlog on typical bursts) while bounding worst-case fan-out.
const MAX_CONCURRENT_CAPTURES: u32 = 2;

/// Bounds concurrent `store` spawns (see `MAX_CONCURRENT_CAPTURES`) via the
/// shared `BoundedGate` (commands/util.rs) — previously a hand-rolled
/// CaptureSemaphore/CapturePermit pair duplicating web.rs's own
/// WEB_OPS_COUNT/WEB_OPS_CVAR/WebOpsGuard, now unified into one poison-safe
/// implementation both modules share. `brain_capture_inner` always runs
/// inside `tauri::async_runtime::spawn_blocking` (see `brain_capture`'s doc
/// comment — an earlier revision of this comment claimed a plain sync
/// command already ran on "a blocking worker thread", which is FALSE in
/// Tauri v2: plain sync commands run on the MAIN thread, and this gate's
/// unbounded condvar wait held that thread hostage), so a blocking wait
/// here needs no async runtime handle and cannot stall the UI event loop.
/// Callers beyond the limit block briefly on this cheap OS-thread wait
/// instead of paying for another heavy subprocess spawn — this preserves
/// `brain_capture`'s existing fire-and-forget semantics from the caller's
/// side (still just one `invoke()` that eventually resolves).
static CAPTURE_GATE: BoundedGate = BoundedGate::new(MAX_CONCURRENT_CAPTURES);

/// Write a neuron into the brain via the LazyBrain `store` CLI (stdin path).
///
/// This is the most robust write mechanism: it spawns `node lazybrain.js store`,
/// pipes the neuron HTML over stdin, and waits for the process to exit.
/// No daemon or HTTP server needs to be running — the CLI writes directly to
/// the brain filesystem and updates the FTS index.
///
/// Bounded to `MAX_CONCURRENT_CAPTURES` concurrent `store` subprocesses via
/// `CAPTURE_GATE` — see that type's doc comment.
///
/// Returns JSON from the `store` command, e.g.
/// `{"id":"my-note-2026-06-19","path":"...","sizeBytes":512,"attrsCount":7}`
///
/// `async fn` + `spawn_blocking` (real-app QA run 6b root cause — the
/// residual main-thread wedge after the project_register fix): as a plain
/// sync command this body ran ON TAURI'S MAIN THREAD, and it can block for
/// a LONG time — `CAPTURE_GATE.acquire()` waits unboundedly when 2 captures
/// are already in flight, and each `store` child runs with
/// `LAZYBRAIN_EMBEDDINGS=1` (documented ~24s cold-embedder load, 30s bound).
/// Captures fire on editor saves, chat, and mission creation with a
/// frontend retry queue, so bursts produced a ROLLING wedge: every other
/// sync invoke AND every custom-protocol asset request (lazy space chunks —
/// served on the same thread) queued behind capture after capture. Observed
/// as: Terminals/Brain/Agents/Settings spaces stuck forever on their
/// Suspense spinner fallbacks, terminal never mounting, mission modal
/// unreachable, zero console errors — while a probe boot that never saved a
/// file rendered everything instantly. FIX-4's own doc comment
/// (`wait_child_with_timeout` above) had already documented the identical
/// every-invoke-freezes symptom from a hung `store` child but only bounded
/// the wait — this moves the whole body (gate wait + spawn + stdin write +
/// bounded wait) onto tokio's blocking pool where it belongs. See
/// `project_register` (commands/brain/config.rs) for the full sync-command/
/// main-thread mechanism and why `spawn_blocking` rather than the
/// `(async)` attribute.
#[tauri::command]
pub(crate) async fn brain_capture(
    payload: CaptureEvent,
    app: tauri::AppHandle,
) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || brain_capture_inner(payload, &app)).await {
        Ok(result) => result,
        Err(e) => Err(format!("brain_capture: blocking task join failed: {}", e)),
    }
}

/// Build the `lazybrain.js store` CLI argument list for a capture event.
///
/// Always starts with `"store"`. Appends `--upsert-if-richer` when the event
/// requests it via `CaptureEvent.upsert_if_richer` (serde: `upsertIfRicher`)
/// — this is what makes the engine's `store` CLI run its richer-body upsert
/// path (engine/src/store/upsert.ts) instead of silently ignoring the field
/// (serde previously dropped this unknown JSON key entirely, making
/// completion upserts a no-op). Absent/false forwards no extra arg, so
/// existing callers that never set the field see a byte-identical argv.
fn store_command_args(payload: &CaptureEvent) -> Vec<&'static str> {
    let mut args: Vec<&'static str> = vec!["store"];
    if payload.upsert_if_richer == Some(true) {
        args.push("--upsert-if-richer");
    }
    args
}

/// Synchronous body of `brain_capture` — always runs on the blocking pool
/// (see the command's doc comment above). Derives `ProjectState` from the
/// `AppHandle` because `tauri::State<'_, T>` borrows cannot move into a
/// `'static` `spawn_blocking` closure.
fn brain_capture_inner(payload: CaptureEvent, app: &tauri::AppHandle) -> Result<String, String> {
    let project_state = app.state::<ProjectState>();

    let lb = resolve_lazybrain_bin_static()?;
    let brain_path = brain_path_from_project(&project_state);
    let project_root = project_state.0.lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    let html = event_to_html(&payload, &project_root);

    // Bound concurrent subprocess fan-out — held for the rest of this
    // function (RAII, released on every exit path including early `?`
    // returns below).
    let _permit = CAPTURE_GATE.acquire();

    let store_args = store_command_args(&payload);
    let mut child = lb.command(&store_args)
        .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
        .env("LAZYBRAIN_LOG_LEVEL", "warn")
        .env("LAZYBRAIN_TELEMETRY", "0")
        .env("LAZYBRAIN_EMBEDDINGS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("brain_capture: spawn failed: {}", e))?;

    // Write HTML to stdin then close it so the process knows input is done.
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(html.as_bytes())
            .map_err(|e| format!("brain_capture: stdin write failed: {}", e))?;
        // stdin is dropped here, closing the pipe
    }

    // FIX-4: bounded wait (was unbounded child.wait_with_output()) — see
    // wait_child_with_timeout's doc comment for the full root-cause story.
    let output = wait_child_with_timeout(child, BRAIN_CAPTURE_TIMEOUT_SECS)
        .map_err(|e| format!("brain_capture: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("brain_capture: store exited {}: {}", output.status, stderr))
    }
}

static REBUILD_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Run `lazybrain index-rebuild` + `lazybrain graph` in the background,
/// then emit `brain://updated` so the frontend live-refreshes the graph.
///
/// Serialized via an atomic flag: concurrent calls skip the rebuild if one
/// is already running (fire-and-forget from the Tauri TS side).
#[tauri::command]
pub(crate) async fn brain_rebuild_graph(
    app: tauri::AppHandle,
    #[allow(unused_variables)] state: tauri::State<'_, BrainState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    // Skip if already rebuilding
    if REBUILD_IN_PROGRESS.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Ok(()); // another rebuild is running — skip
    }

    // Resolve paths
    let lb_result = resolve_lazybrain_bin_static();
    let brain_path = brain_path_from_project(&project_state);
    let project_root = project_state.0.lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    // Spawn blocking work on a thread pool thread
    let app_clone = app.clone();
    let lb_clone = lb_result.ok();
    let brain_clone = brain_path.clone();
    let cwd_clone = project_root.clone();

    tokio::task::spawn_blocking(move || {
        // Always clear the in-progress flag on exit, success or not
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let lb = match lb_clone {
                Some(ref b) => b,
                None => {
                    log::warn!("brain_rebuild_graph: lazybrain.js not found, skipping");
                    return;
                }
            };

            // Step 1: index-rebuild (reindex all notes into the FTS index)
            let mut rebuild_cmd = lb.command(&["index-rebuild"]);
            rebuild_cmd
                .env("LAZYBRAIN_BRAIN_PATH", &brain_clone)
                .env("LAZYBRAIN_LOG_LEVEL", "warn")
                .env("LAZYBRAIN_TELEMETRY", "0")
                .env("LAZYBRAIN_EMBEDDINGS", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let rebuild_status = status_with_timeout(&mut rebuild_cmd, REBUILD_STEP_TIMEOUT_SECS, "index-rebuild", &brain_clone);

            let rebuild_ok = match rebuild_status {
                Ok(s) if s.success() => { log::info!("brain_rebuild_graph: index-rebuild done"); true }
                Ok(s) => { log::warn!("brain_rebuild_graph: index-rebuild exited {}", s); false }
                Err(e) => { log::warn!("brain_rebuild_graph: index-rebuild failed: {}", e); false }
            };

            if !rebuild_ok {
                // Do not proceed to graph step or emit success event on rebuild failure.
                if let Err(e) = app_clone.emit("brain://rebuild-failed", "index-rebuild failed") {
                    log::warn!("brain_rebuild_graph: emit brain://rebuild-failed failed: {}", e);
                }
                return;
            }

            // Step 2: graph (regenerate brain-graph.json + code-scan the open project)
            //
            // P0.2: pass --cwd <project_root> so the engine's tree-sitter code
            // scanner creates file-neuron and aggregate-neuron notes for every
            // source file in the open project. Without --cwd, graph only
            // discovers project dirs from existing notes' data-cerveau-cwd
            // attributes — which means a fresh brain (or one with only IDE-captured
            // episodic notes) gets an empty tree, since those notes carry no
            // cwd. With --cwd, the scanner walks the project directory tree,
            // classifies files, extracts imports/exports, and writes structured
            // file-neuron + aggregate-neuron HTML notes that populate the Wiki
            // sidebar's project→module→file hierarchy.
            let mut graph_args: Vec<&str> = vec!["graph"];
            let cwd_arg;
            if !cwd_clone.is_empty() {
                graph_args.push("--cwd");
                cwd_arg = cwd_clone.clone();
                graph_args.push(&cwd_arg);
            }
            let mut graph_cmd = lb.command(&graph_args);
            graph_cmd
                .env("LAZYBRAIN_BRAIN_PATH", &brain_clone)
                .env("LAZYBRAIN_LOG_LEVEL", "warn")
                .env("LAZYBRAIN_TELEMETRY", "0")
                .env("LAZYBRAIN_EMBEDDINGS", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let graph_status = status_with_timeout(&mut graph_cmd, REBUILD_STEP_TIMEOUT_SECS, "graph --cwd", &brain_clone);

            let graph_ok = match graph_status {
                Ok(s) if s.success() => { log::info!("brain_rebuild_graph: graph done"); true }
                Ok(s) => { log::warn!("brain_rebuild_graph: graph exited {}", s); false }
                Err(e) => { log::warn!("brain_rebuild_graph: graph failed: {}", e); false }
            };

            // Step 3: build-index, then Step 4: health-score.
            //
            // health-score's `writeHealthMeta` (lazybrain.js) only PATCHES an
            // EXISTING `_index.html` — `if (!existsSync(indexPath)) return;` —
            // it never creates one. Neither index-rebuild nor graph ever write
            // `_index.html` (only build-index does, via runBuildIndex).
            // Empirically verified (a fresh init -> index-rebuild -> graph ->
            // health-score sequence leaves NO _index.html on disk at all, so
            // health-score's meta-tag write silently no-ops every time): the
            // "frozen health score" bug needs BOTH steps, not health-score
            // alone, or health-score has nothing to write into.
            //
            // Both non-fatal by design: a failure in either must not fail the
            // rebuild or block brain://updated below — only the health badge
            // stays stale until the next successful rebuild retries it. Only
            // run when the prior steps succeeded (no point scoring/indexing a
            // brain whose index/graph didn't actually rebuild).
            if graph_ok {
                let mut build_index_cmd = lb.command(&["build-index"]);
                build_index_cmd
                    .env("LAZYBRAIN_BRAIN_PATH", &brain_clone)
                    .env("LAZYBRAIN_LOG_LEVEL", "warn")
                    .env("LAZYBRAIN_TELEMETRY", "0")
                    .env("LAZYBRAIN_EMBEDDINGS", "1")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                let build_index_status = status_with_timeout(&mut build_index_cmd, REBUILD_STEP_TIMEOUT_SECS, "build-index", &brain_clone);

                match build_index_status {
                    Ok(s) if s.success() => log::info!("brain_rebuild_graph: build-index done"),
                    Ok(s) => log::warn!("brain_rebuild_graph: build-index exited {} (non-fatal)", s),
                    Err(e) => log::warn!("brain_rebuild_graph: build-index failed: {} (non-fatal)", e),
                }

                let mut health_cmd = lb.command(&["health-score"]);
                health_cmd
                    .env("LAZYBRAIN_BRAIN_PATH", &brain_clone)
                    .env("LAZYBRAIN_LOG_LEVEL", "warn")
                    .env("LAZYBRAIN_TELEMETRY", "0")
                    .env("LAZYBRAIN_EMBEDDINGS", "1")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                let health_status = status_with_timeout(&mut health_cmd, REBUILD_STEP_TIMEOUT_SECS, "health-score", &brain_clone);

                match health_status {
                    Ok(s) if s.success() => log::info!("brain_rebuild_graph: health-score done"),
                    Ok(s) => log::warn!("brain_rebuild_graph: health-score exited {} (non-fatal)", s),
                    Err(e) => log::warn!("brain_rebuild_graph: health-score failed: {} (non-fatal)", e),
                }
            }

            // Only emit brain://updated when both subcommands succeeded (#42).
            // Emit brain://rebuild-failed on any subprocess failure so the frontend
            // can display an error badge instead of showing stale/empty data.
            if graph_ok {
                if let Err(e) = app_clone.emit("brain://updated", ()) {
                    log::warn!("brain_rebuild_graph: emit brain://updated failed: {}", e);
                }
            } else {
                if let Err(e) = app_clone.emit("brain://rebuild-failed", "graph step failed") {
                    log::warn!("brain_rebuild_graph: emit brain://rebuild-failed failed: {}", e);
                }
            }
        }));

        REBUILD_IN_PROGRESS.store(false, Ordering::SeqCst);
        record_ops_idle_unless_timed_out(&brain_clone);

        if let Err(e) = result {
            log::warn!("brain_rebuild_graph: panicked: {:?}", e);
        }
    });

    Ok(())
}

/// Run `lazybrain recompose-all` to patch authored items (signed by team
/// members) into file-neuron enrichment sections after a team pull.
///
/// Fire-and-forget from the Tauri TS side (syncDaemon.ts calls this right
/// after `brain_rebuild_graph`). Non-fatal: any failure is logged and
/// swallowed so a broken recompose pass never undoes a real pull.
#[tauri::command]
pub(crate) async fn brain_recompose_all(
    #[allow(unused_variables)] state: tauri::State<'_, BrainState>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<(), String> {
    let lb_result = resolve_lazybrain_bin_static();
    let brain_path = brain_path_from_project(&project_state);
    let lb_clone = lb_result.ok();

    tokio::task::spawn_blocking(move || {
        let lb = match lb_clone {
            Some(ref b) => b,
            None => {
                log::warn!("brain_recompose_all: lazybrain.js not found, skipping");
                return;
            }
        };

        let status = {
            let mut recompose_cmd = lb.command(&["recompose-all"]);
            recompose_cmd
                .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
                .env("LAZYBRAIN_LOG_LEVEL", "warn")
                .env("LAZYBRAIN_TELEMETRY", "0")
                .env("LAZYBRAIN_EMBEDDINGS", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            status_with_timeout(&mut recompose_cmd, RECOMPOSE_TIMEOUT_SECS, "recompose-all", &brain_path)
        };
        record_ops_idle_unless_timed_out(&brain_path);

        match status {
            Ok(s) if s.success() => log::info!("brain_recompose_all: recompose-all done"),
            Ok(s) => log::warn!("brain_recompose_all: recompose-all exited {} (non-fatal)", s),
            Err(e) => log::warn!("brain_recompose_all: recompose-all failed: {} (non-fatal)", e),
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Verify the capture write path end-to-end:
    ///
    /// 1. Create a temp directory as the brain.
    /// 2. Run `node lazybrain.js init --brain <tmp>` to initialize it.
    /// 3. Build a neuron HTML from a `CaptureEvent` with a unique sentinel title.
    /// 4. Pipe it into `node lazybrain.js store` with `LAZYBRAIN_BRAIN_PATH=<tmp>`.
    /// 5. Assert the store command exited 0 and produced a JSON `id`.
    /// 6. Assert a `.html` file exists in `<tmp>/notes/`.
    #[test]
    fn brain_capture_writes_neuron() {
        use std::io::Write as IoWrite;
        use super::{event_to_html, CaptureEvent};
        use crate::commands::brain::config::resolve_bin_path_static;
        use crate::commands::util::quiet_command;

        // Skip if the lazybrain binary is not present (CI without LazyBrain build).
        let bin_path = match resolve_bin_path_static() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("SKIP brain_capture_writes_neuron — lazybrain.js not found");
                return;
            }
        };

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();

        // Step 1: init the brain in the temp directory.
        let init_status = quiet_command("node")
            .args([&bin_path, "init", "--brain", &brain_path])
            .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("node lazybrain.js init failed to spawn");
        assert!(init_status.success(), "lazybrain init failed: {}", init_status);

        // Step 2: build neuron HTML.
        let sentinel = format!("capture-test-sentinel-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs());
        let ev = CaptureEvent {
            kind: "episodic".to_string(),
            title: sentinel.clone(),
            text: "Automated capture test from Lazy IDE Rust test suite.".to_string(),
            tags: Some(vec!["test".to_string(), "lazy-ide".to_string()]),
            files: Some(vec!["src-tauri/src/lib.rs".to_string()]),
            source: Some("lazy-ide:test".to_string()),
            topic: None,
            space: None,
            author: None,
            author_id: None,
            org_id: None,
            dept: None,
            item_kind: None,
            about: None,
            project: None,
            cwd: None,
            insights: None,
            upsert_if_richer: None,
            stable_id: None,
        };
        let html = event_to_html(&ev, "");

        // Step 3: pipe HTML into `node lazybrain.js store`.
        let mut child = quiet_command("node")
            .args([&bin_path, "store"])
            .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("node lazybrain.js store failed to spawn");

        child.stdin.take().unwrap().write_all(html.as_bytes()).expect("stdin write");

        let output = child.wait_with_output().expect("wait_with_output");
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

        assert!(
            output.status.success(),
            "lazybrain store failed (exit {})\nstdout: {}\nstderr: {}",
            output.status, stdout, stderr
        );

        // Step 4: parse returned JSON and assert id is present.
        let json: serde_json::Value = serde_json::from_str(stdout.trim())
            .expect("store stdout is not valid JSON");
        let returned_id = json["id"].as_str().expect("missing id field in store output");
        assert!(!returned_id.is_empty(), "returned id must be non-empty");

        // Step 5: assert at least one .html note exists in the brain.
        let notes_dir = std::path::Path::new(&brain_path).join("notes");
        let html_count: usize = std::fs::read_dir(&notes_dir)
            .expect("notes dir missing")
            .filter_map(|e| e.ok())
            .flat_map(|month| std::fs::read_dir(month.path()).ok().into_iter().flatten())
            .filter(|e| e.as_ref().ok().map(|e| e.path().extension().map(|x| x == "html").unwrap_or(false)).unwrap_or(false))
            .count();

        assert!(
            html_count >= 1,
            "Expected at least 1 .html note in {}, found {}",
            notes_dir.display(),
            html_count
        );

        eprintln!(
            "brain_capture_writes_neuron PASSED: id={}, notes_in_brain={}",
            returned_id, html_count
        );
    }

    /// Verify the brain_rebuild_graph CLI path end-to-end:
    ///
    /// 1. Init a fresh brain in a temp dir.
    /// 2. Store one neuron (so there is something to index).
    /// 3. Run `lazybrain index-rebuild` and assert exit 0.
    /// 4. Run `lazybrain graph` and assert exit 0.
    /// 5. Assert that `brain-graph.json` (or equivalent graph output) exists.
    #[test]
    fn brain_rebuild_graph_runs_cli() {
        use std::io::Write as IoWrite;
        use super::{event_to_html, CaptureEvent};
        use crate::commands::brain::config::resolve_bin_path_static;
        use crate::commands::util::quiet_command;

        // Skip if lazybrain.js is not present
        let bin_path = match resolve_bin_path_static() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("SKIP brain_rebuild_graph_runs_cli — lazybrain.js not found");
                return;
            }
        };

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();

        // Step 1: init
        let init_status = quiet_command("node")
            .args([&bin_path, "init", "--brain", &brain_path])
            .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("lazybrain init spawn failed");
        assert!(init_status.success(), "lazybrain init failed: {}", init_status);

        // Step 2: store a neuron so index-rebuild has something to work with
        let ev = CaptureEvent {
            kind: "episodic".to_string(),
            title: "rebuild-test-sentinel".to_string(),
            text: "Test neuron for index-rebuild.".to_string(),
            tags: Some(vec!["test".to_string()]),
            files: None,
            source: Some("lazy-ide:test".to_string()),
            topic: None,
            space: None,
            author: None,
            author_id: None,
            org_id: None,
            dept: None,
            item_kind: None,
            about: None,
            project: None,
            cwd: None,
            insights: None,
            upsert_if_richer: None,
            stable_id: None,
        };
        let html = event_to_html(&ev, "");
        let mut store_child = quiet_command("node")
            .args([&bin_path, "store"])
            .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("lazybrain store spawn failed");
        store_child.stdin.take().unwrap().write_all(html.as_bytes()).expect("store stdin write");
        let store_out = store_child.wait_with_output().expect("store wait_with_output");
        assert!(store_out.status.success(), "lazybrain store failed: {}", store_out.status);

        // Step 3: index-rebuild
        let rebuild_status = quiet_command("node")
            .args([&bin_path, "index-rebuild"])
            .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .expect("lazybrain index-rebuild spawn failed");
        assert!(
            rebuild_status.success(),
            "lazybrain index-rebuild failed: {}",
            rebuild_status
        );

        // Step 4: graph
        let graph_output = quiet_command("node")
            .args([&bin_path, "graph"])
            .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("lazybrain graph spawn failed");
        assert!(
            graph_output.status.success(),
            "lazybrain graph failed (exit {})\nstderr: {}",
            graph_output.status,
            String::from_utf8_lossy(&graph_output.stderr)
        );

        // Step 5: assert brain-graph.json was produced inside _cache/
        // LazyBrain writes graph output to <brain>/_cache/brain-graph.json
        let graph_json = tmp.path().join("_cache").join("brain-graph.json");
        assert!(
            graph_json.exists(),
            "Expected _cache/brain-graph.json in {}, not found",
            tmp.path().display()
        );

        // Step 6: build-index, then Step 7: health-score — the two steps
        // brain_rebuild_graph now runs after index-rebuild + graph (see
        // lib.rs's brain_rebuild_graph). build-index must run FIRST: it is
        // the only command that creates `_index.html` from scratch;
        // health-score's writeHealthMeta only PATCHES an existing
        // `_index.html` and silently no-ops if the file is missing
        // (empirically verified — without build-index, _index.html never
        // exists and the cerveau-health meta tag never gets written, no
        // matter how many times health-score runs).
        let build_index_status = quiet_command("node")
            .args([&bin_path, "build-index"])
            .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .status()
            .expect("lazybrain build-index spawn failed");
        assert!(
            build_index_status.success(),
            "lazybrain build-index failed: {}",
            build_index_status
        );
        let index_html = tmp.path().join("_index.html");
        assert!(
            index_html.exists(),
            "build-index must create _index.html at the brain root, not found in {}",
            tmp.path().display()
        );

        let health_output = quiet_command("node")
            .args([&bin_path, "health-score"])
            .env("LAZYBRAIN_BRAIN_PATH", &brain_path)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .expect("lazybrain health-score spawn failed");
        if !health_output.status.success() {
            let stderr = String::from_utf8_lossy(&health_output.stderr);
            // health-score is documented as non-fatal in production too —
            // see brain_rebuild_graph's own doc comment ("Both non-fatal by
            // design" / "the health badge stays stale until the next
            // successful rebuild retries it"). The specific case tolerated
            // here is the resolved engine build not implementing the
            // command at all yet ("unknown command") — an environment/
            // engine-completeness fact, not a regression in the CLI-
            // invocation plumbing this test exists to cover. Any OTHER
            // failure (the command exists but errors) still fails the test.
            assert!(
                stderr.contains("unknown command"),
                "lazybrain health-score failed unexpectedly: {}\nstderr: {}",
                health_output.status,
                stderr
            );
            eprintln!(
                "brain_rebuild_graph_runs_cli PARTIAL: index-rebuild + graph + build-index all \
                 exited 0; health-score skipped — resolved engine does not implement it yet \
                 ({})",
                stderr.trim()
            );
            return;
        }
        let html = std::fs::read_to_string(&index_html).unwrap_or_default();
        assert!(
            html.contains("cerveau-health"),
            "health-score must write a cerveau-health meta tag into _index.html (the file brain_fetch_health reads)"
        );

        eprintln!(
            "brain_rebuild_graph_runs_cli PASSED: index-rebuild + graph + build-index + health-score all exited 0, cerveau-health meta written to _index.html"
        );
    }

    // ── wait_child_with_timeout (FIX-4) ──────────────────────────────
    //
    // Mirrors index_project.rs's run_step_with_timeout_kills_process_that_
    // exceeds_deadline — same "prove the kill actually happens near the
    // deadline" idiom, adapted to a function that takes an already-spawned
    // Child rather than an unspawned Command.

    #[test]
    fn wait_child_with_timeout_returns_output_for_fast_process() {
        use std::process::Command as StdCommand;

        let mut cmd = if cfg!(windows) {
            let mut c = StdCommand::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        } else {
            let mut c = StdCommand::new("sh");
            c.args(["-c", "exit 0"]);
            c
        };
        let child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn fast process");

        let result = super::wait_child_with_timeout(child, 5);
        assert!(result.is_ok(), "fast process must resolve well before the deadline: {:?}", result.err());
        assert!(result.unwrap().status.success());
        eprintln!("wait_child_with_timeout_returns_output_for_fast_process PASSED");
    }

    /// Proves the FIX-4 root cause is closed: a child that outlives the
    /// deadline is killed and reported as an `Err` instead of blocking this
    /// call forever. Real-app QA traced a permanently-'queued' mission
    /// straight back to this function's PREDECESSOR — a bare, unbounded
    /// `child.wait_with_output()` in `brain_capture` — hanging on a stuck
    /// `lazybrain.js store` child (confirmed alive minutes later via
    /// `Get-CimInstance Win32_Process`), which in turn stalled the app's
    /// entire `invoke()` bridge (including the very next `resolveProjectRoot()`
    /// call `addMission` makes) — see `wait_child_with_timeout`'s doc comment.
    ///
    /// This test used to assert `elapsed < 10s` alone, which is timing-
    /// fragile: measured on this machine, 5 idle back-to-back runs land at
    /// 1.011-1.016s (essentially the 1s deadline plus the 100ms poll
    /// granularity), and even 4x CPU-oversubscription (48 CPU-spin
    /// processes on a 12-logical-core box) only pushes it to ~1.07s — the
    /// kill path itself is not slow. But a real CI failure recorded
    /// elapsed=12.1619775s under a dozen concurrent `rustc` processes plus a
    /// `vitest` run — a very different, memory/IO-heavy contention profile
    /// (linking + incremental caches + worker-thread I/O) that a pure
    /// `sleep(100ms)` poll loop has no defense against: on a starved
    /// scheduler ANY thread's sleep can overrun by seconds, including this
    /// one, with the kill logic doing nothing wrong. GitHub's `windows-
    /// latest` runners are only 2-4 cores, so this is a realistic CI
    /// condition, not just a freak local occurrence.
    ///
    /// So this now proves the invariant two ways: (1) directly, by checking
    /// the child process is actually gone via `sysinfo` rather than
    /// inferring it from wall-clock timing, and (2) with a wall-clock bound
    /// wide enough to absorb heavy scheduler contention while still catching
    /// the real regression this guards against (`kill()` silently failing to
    /// terminate and `wait()` blocking for the process's full natural
    /// lifetime) — 18s remains meaningfully below the child's 20s sleep.
    #[test]
    fn wait_child_with_timeout_kills_process_that_exceeds_deadline() {
        use std::process::Command as StdCommand;

        let mut cmd = if cfg!(windows) {
            let mut c = StdCommand::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 20"]);
            c
        } else {
            let mut c = StdCommand::new("sleep");
            c.arg("20");
            c
        };
        let child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn slow process");
        let pid = child.id();

        let start = Instant::now();
        let result = super::wait_child_with_timeout(child, 1);
        let elapsed = start.elapsed();

        assert!(result.is_err(), "a process that outlives the deadline must report an error, not hang");
        assert!(
            !is_pid_alive(pid),
            "child process (pid {}) must actually be terminated by the deadline path, not just have this call return",
            pid
        );
        assert!(
            elapsed < Duration::from_secs(18),
            "must not wait out the full 20s sleep — took {:?}",
            elapsed
        );
        eprintln!("wait_child_with_timeout_kills_process_that_exceeds_deadline PASSED (elapsed={:?})", elapsed);
    }

    /// Whether a process with `pid` is still alive, checked independently of
    /// this crate's own `Child` handle (which `wait_child_with_timeout`
    /// already consumed) via `sysinfo` — already a real (non-dev) dependency
    /// of this crate, see `runner/singleinstance.rs`'s `is_pid_alive` for the
    /// same pattern.
    fn is_pid_alive(pid: u32) -> bool {
        use sysinfo::{Pid, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        sys.process(Pid::from(pid as usize)).is_some()
    }

    // ── store_command_args (upsertIfRicher forwarding) ──────────────────
    //
    // fix/capture-upsert-bridge: the TS side (CaptureEvent.upsertIfRicher,
    // src/lib/platform/types.ts) already sends this field for
    // mission-completion captures, and the engine's `store` CLI already
    // understands `--upsert-if-richer` (register-core.ts / commands/store.ts).
    // Before this fix, serde silently dropped the unknown JSON field and the
    // Rust bridge never forwarded the flag, so completion upserts were a
    // no-op. These two tests pin the argv this bridge builds, independent of
    // any subprocess (fast, no lazybrain.js / node dependency).

    fn sample_capture_event(upsert_if_richer: Option<bool>) -> CaptureEvent {
        CaptureEvent {
            kind: "episodic".to_string(),
            title: "t".to_string(),
            text: "x".to_string(),
            tags: None,
            files: None,
            source: None,
            topic: None,
            space: None,
            author: None,
            author_id: None,
            org_id: None,
            dept: None,
            item_kind: None,
            about: None,
            project: None,
            cwd: None,
            insights: None,
            upsert_if_richer,
            stable_id: None,
        }
    }

    /// Backward compat: when the payload omits `upsertIfRicher` (deserializes
    /// to `None`), the store invocation must carry no extra flag — every
    /// existing capture kind (edit/decision/episodic/agent/commit) never
    /// sets this field and must see the exact same argv as before this fix.
    #[test]
    fn store_command_args_omits_flag_when_absent() {
        let ev = sample_capture_event(None);
        assert_eq!(super::store_command_args(&ev), vec!["store"]);
        eprintln!("store_command_args_omits_flag_when_absent PASSED");
    }

    /// Mission-completion captures set `upsertIfRicher: true` (TS side) so
    /// the engine's `store` CLI runs its richer-body upsert path
    /// (engine/src/store/upsert.ts) instead of conflicting/overwriting the
    /// sparse kickoff note. This asserts the flag is actually forwarded —
    /// the exact gap that made completion upserts a silent no-op.
    #[test]
    fn store_command_args_appends_flag_when_true() {
        let ev = sample_capture_event(Some(true));
        assert_eq!(super::store_command_args(&ev), vec!["store", "--upsert-if-richer"]);
        eprintln!("store_command_args_appends_flag_when_true PASSED");
    }

    // ── stable_id id-override (conversation-capture idempotency) ────────
    //
    // buildConversationSummaryEvent (src/lib/brain/capture.ts) is the first
    // real caller of stable_id: it sets it to the LazyManager conversation's
    // own id so re-capturing the same conversation resolves to the same
    // note. These tests pin event_to_html's id-selection behavior directly,
    // independent of any subprocess (fast, no lazybrain.js / node
    // dependency) — same pattern as store_command_args's own tests above.

    /// Without stable_id, the id keeps the existing title+date+random-suffix
    /// shape: it must NOT equal the raw title (the random suffix makes every
    /// call produce a different id) but must still start with the slugified
    /// title, so ordinary captures are provably unaffected by this fix.
    #[test]
    fn event_to_html_without_stable_id_keeps_random_suffix_id() {
        let mut ev = sample_capture_event(None);
        ev.title = "Some Capture Title".to_string();
        ev.text = "body".to_string();
        let html_a = event_to_html(&ev, "");
        let html_b = event_to_html(&ev, "");
        let id_a = html_a.split("id=\"").nth(1).unwrap().split('"').next().unwrap();
        let id_b = html_b.split("id=\"").nth(1).unwrap().split('"').next().unwrap();
        assert!(id_a.starts_with("some-capture-title"), "id must start with the slugified title: {id_a}");
        assert_ne!(id_a, id_b, "two calls with no stable_id must never produce the same id (random suffix)");
        eprintln!("event_to_html_without_stable_id_keeps_random_suffix_id PASSED");
    }

    /// With stable_id set, the id is derived ONLY from stable_id (sanitized),
    /// with no date and no random suffix — so two calls with the SAME
    /// stable_id (e.g. the same LazyManager conversation captured twice)
    /// produce the EXACT SAME id, which is what lets upsert_if_richer find
    /// and update the existing note instead of creating a duplicate.
    #[test]
    fn event_to_html_with_stable_id_is_deterministic() {
        let mut ev = sample_capture_event(Some(true));
        ev.title = "Conversation abc123".to_string();
        ev.text = "turn one".to_string();
        ev.stable_id = Some("conv-abc123".to_string());
        let html_a = event_to_html(&ev, "");
        ev.text = "turn one, then turn two".to_string();
        let html_b = event_to_html(&ev, "");
        let id_a = html_a.split("id=\"").nth(1).unwrap().split('"').next().unwrap();
        let id_b = html_b.split("id=\"").nth(1).unwrap().split('"').next().unwrap();
        assert_eq!(id_a, "conv-abc123");
        assert_eq!(id_a, id_b, "same stable_id must always produce the same id");
        eprintln!("event_to_html_with_stable_id_is_deterministic PASSED");
    }
}
