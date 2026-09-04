//! Brain auto-initialization: legacy-vs-canonical config detection, the
//! one-time non-destructive config migration, and the failure-marker
//! cooldown cache backing `BrainSidecar::ensure_brain_init`.

use std::process::Stdio;

use crate::commands::brain::sidecar::process::BrainSidecar;
use crate::commands::brain::sidecar::resolve::LazyBrainBin;

/// Sentinel filename written inside `brain_path` when `ensure_brain_init`
/// fails, recording the Unix-epoch-seconds timestamp of that failed attempt
/// as its entire (plain-text) content. See `ensure_brain_init`'s "Failure
/// caching" doc comment for why this exists. Excluded from published brains
/// (see `brain_gitignore_patterns` in publish.rs) — it is internal
/// bookkeeping, not a user note.
const INIT_FAILURE_MARKER: &str = ".lazybrain-init-failed";

/// How long a cached init failure is trusted before retrying — long enough
/// that a deterministically-failing init (the reported symptom: exit code 1
/// on every boot) is not re-attempted on every single app launch/project
/// switch in a tight loop, short enough that a transient cause (e.g. a
/// one-time model download blocked by a flaky network, or losing a race
/// against a concurrent maintenance pass — see `run_full_maintenance_sequence`
/// in maintenance.rs — that briefly held the brain's SQLite DB) self-heals
/// within roughly a minute, not hours, with no user action.
///
/// FIELD NOTE: this was originally 6 hours. QA found a brain stuck showing
/// "Sidecar brain indisponible" for the rest of the app session after a
/// large history-import + post-import `interlink` maintenance pass raced the
/// very first `ensure_brain_init` — one lost race then cached a failure that
/// outlived the actual problem by hours, long after the brain was genuinely
/// fine again. Shortened alongside two other changes that attack the same
/// bug from different angles: `ensure_brain_init` now retries a non-zero
/// exit a few times before caching it at all (see
/// `INIT_TRANSIENT_RETRY_ATTEMPTS`), and any later proof the brain is fine —
/// a healthy `start_or_restart_brain_sidecar`, or an explicit user/UI retry
/// (`brain_retry_sidecar`, config.rs) — clears the marker immediately via
/// `clear_init_failure_marker` rather than waiting out the cooldown.
const INIT_FAILURE_RETRY_AFTER_SECS: u64 = 60; // 1 minute

/// How many times `ensure_brain_init` retries a non-zero-exit init attempt
/// (with `INIT_RETRY_BACKOFF` between attempts) before caching the failure —
/// see that function's "Retry a few times" comment. A spawn failure (the
/// binary itself missing) is never retried regardless of this constant.
const INIT_TRANSIENT_RETRY_ATTEMPTS: u32 = 3;

/// Backoff between `ensure_brain_init` retry attempts — long enough to give
/// a concurrent maintenance pass (dream/prune/compress/interlink/profile-update
/// — see `run_full_maintenance_sequence` in maintenance.rs) a real chance to
/// release its SQLite write lock, short enough that even
/// `INIT_TRANSIENT_RETRY_ATTEMPTS` attempts add at most a few seconds to a
/// call already on the blocking critical path of app startup / project switch.
const INIT_RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_millis(1500);

/// Record a failed init attempt at `marker_path` (the current Unix-epoch
/// seconds, as plain text). Best-effort: if `brain_path` itself could not be
/// created (e.g. a permissions issue — the same underlying problem that may
/// have made init fail in the first place), this silently no-ops, and
/// `ensure_brain_init` simply keeps retrying on every boot — no worse than
/// the pre-caching behavior, never a hard failure over a missing cache.
fn write_failure_marker(marker_path: &std::path::Path) {
    if let Some(parent) = marker_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = std::fs::write(marker_path, now_secs.to_string());
}

/// Age (in seconds) of a previously-recorded init failure at `marker_path`,
/// or `None` if no marker exists or its content can't be parsed — both
/// treated as "no known prior failure", so `ensure_brain_init` always falls
/// back to simply retrying rather than getting stuck on a corrupt cache.
fn read_failure_marker_age_secs(marker_path: &std::path::Path) -> Option<u64> {
    let raw = std::fs::read_to_string(marker_path).ok()?;
    let recorded_secs: u64 = raw.trim().parse().ok()?;
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(now_secs.saturating_sub(recorded_secs))
}

/// Best-effort removal of `brain_path`'s cached init-failure marker (see
/// `INIT_FAILURE_MARKER`). Safe to call even when no marker exists (a no-op).
///
/// Called wherever fresh evidence proves a brain is actually fine, so a
/// stale marker from an earlier, since-superseded failure can never resurface
/// to block some LATER re-init at the same path:
///   - `ensure_brain_init` itself, on its "already initialized" fast path
///     (a config file existing is proof enough, even if it wasn't THIS call
///     that created it — e.g. a losing racer's marker, written after the
///     winning racer's init already succeeded).
///   - `start_or_restart_brain_sidecar`, the moment the sidecar reports
///     healthy.
///   - `brain_retry_sidecar` (config.rs), unconditionally, before retrying —
///     an explicit user/UI-initiated retry must never be silently vetoed by
///     `INIT_FAILURE_RETRY_AFTER_SECS`'s cooldown.
pub(crate) fn clear_init_failure_marker(brain_path: &str) {
    let marker_path = std::path::Path::new(brain_path).join(INIT_FAILURE_MARKER);
    let _ = std::fs::remove_file(&marker_path);
}

/// Result of checking whether a brain at `brain_path` is already
/// initialized. Mirrors `detectExistingInit` in
/// `engine/src/commands/init.ts` EXACTLY (canonical in-brain config checked
/// first, then the legacy parent-dir config) so this Rust-side "should I run
/// init?" gate can never disagree with what the engine's own `init` command
/// would decide. Before this type existed, `ensure_brain_init` only ever
/// checked the canonical location — a brain using the pre-v1.1 legacy
/// layout (config in the PARENT of the brain dir; still fully valid and
/// served by `getConfig()`/`serve`, which never look at this config file at
/// all) was wrongly concluded "not found", triggering a doomed `init`
/// subprocess (the engine's `runInit` always throws "already initialized"
/// for ANY existing-config case, canonical or legacy — see that function's
/// doc comment) on every single boot: exactly the observed field symptom
/// ("brain not found ... running init" / "init exited with status 1" 3/3
/// attempts, every launch, against a brain that was perfectly healthy).
#[derive(Debug, PartialEq, Eq)]
enum BrainInitState {
    /// `<brain_path>/.lazybrain-config.json` exists.
    Canonical,
    /// Only `<parent-of-brain_path>/.lazybrain-config.json` exists
    /// (pre-v1.1 back-compat layout).
    Legacy,
    /// Neither config file exists — genuinely uninitialized.
    NotFound,
}

/// Pure filesystem check backing `BrainInitState` — no subprocess, no
/// mutation, unit-testable with a plain `TempDir`. `Path::parent()` (unlike
/// Node's `path.join(brainPath, '..', ...)` in the engine) correctly handles
/// a `\\?\`-prefixed verbatim Windows path with no extra normalization, so
/// this is safe to call with either a plain or canonicalized `brain_path`.
fn detect_existing_init(brain_path: &std::path::Path) -> BrainInitState {
    let canonical = brain_path.join(".lazybrain-config.json");
    if canonical.exists() {
        return BrainInitState::Canonical;
    }
    if let Some(parent) = brain_path.parent() {
        let legacy = parent.join(".lazybrain-config.json");
        if legacy.exists() {
            return BrainInitState::Legacy;
        }
    }
    BrainInitState::NotFound
}

/// Best-effort, NON-DESTRUCTIVE one-time copy of a legacy parent-dir
/// `.lazybrain-config.json` into the canonical in-brain location.
///
/// COPY, never move: the legacy file is left in place untouched — this
/// function's only filesystem write is creating the new canonical file, and
/// only when it does not already exist (never overwrites, never deletes).
/// Mirrors the exact copy-not-move / never-throw / target-absent-only
/// contract `migrateLegacyCache` (engine/src/util/config.ts) already uses
/// for the sibling `_cache` migration — the same safety reasoning applies:
/// another tool or an older engine version may still expect the legacy file
/// to exist right where it was.
///
/// Failure to copy (permissions, read-only volume, etc.) is logged and
/// otherwise ignored — the legacy layout is already accepted as initialized
/// by `detect_existing_init` regardless of whether this migration succeeds,
/// so a failed copy never blocks the brain from working.
fn migrate_legacy_config_if_absent(brain_path: &std::path::Path) {
    let canonical = brain_path.join(".lazybrain-config.json");
    if canonical.exists() {
        return;
    }
    let Some(parent) = brain_path.parent() else { return };
    let legacy = parent.join(".lazybrain-config.json");
    if !legacy.exists() {
        return;
    }
    match std::fs::copy(&legacy, &canonical) {
        Ok(_) => log::info!(
            "LazyBrain: migrated legacy config {} -> {} (copied; original left in place)",
            legacy.display(),
            canonical.display()
        ),
        Err(e) => log::warn!(
            "LazyBrain: legacy config migration copy failed ({}) — continuing with legacy layout accepted as-is",
            e
        ),
    }
}

impl BrainSidecar {
    /// Auto-initialize a brain at `brain_path` if it is absent or missing its
    /// config file. Runs `node <bin> init --brain <brain_path>` and blocks until
    /// it exits. Safe to call even when the brain already exists — `init` is a
    /// no-op in that case (it exits 0 without modifying anything).
    ///
    /// Returns `None` when the brain is fine (already initialized —
    /// canonical or legacy layout — or a fresh init just succeeded), or
    /// `Some(reason)` when init genuinely failed after exhausting every
    /// retry. Callers that have a `BrainState` in scope (lib.rs's boot
    /// thread, `restart_brain_sidecar` in config.rs) store this straight
    /// into `BrainSidecar::init_failed_reason` so `get_brain_connection` can
    /// surface an honest failure state to the frontend instead of silently
    /// starting `serve` against a brain this function just declared broken.
    /// Callers that don't care about the outcome (index_project.rs,
    /// history_import.rs, search.rs's cold-CLI-fallback path) simply ignore
    /// the return value — Rust does not require it to be used.
    ///
    /// LEGACY LAYOUT (back-compat, see `BrainInitState`/`detect_existing_init`):
    /// a brain whose config lives in the PARENT directory (pre-v1.1 layout)
    /// is recognised as already-initialized WITHOUT ever invoking `init` —
    /// mirrors the engine's own `detectExistingInit` exactly. This matters
    /// because the engine's `runInit` always throws "already initialized"
    /// for an existing config, canonical OR legacy (by design — it's a
    /// human-facing guard against accidental re-init) — so before this
    /// check existed, a legacy brain was silently mis-detected as "not
    /// found", `init` was invoked, and it deterministically exited non-zero
    /// on every single boot (the observed field symptom). Logged as INFO
    /// (not the "not found" warning) so the log accurately reflects that
    /// the brain is fine. A one-time, non-destructive COPY (never move) of
    /// the legacy config into the canonical location is also attempted —
    /// see `migrate_legacy_config_if_absent`'s doc comment for why this is
    /// safe (best-effort, target-absent-only, original left in place).
    ///
    /// Failure caching: if a previous attempt failed (config still missing
    /// afterwards), that failure is recorded in a small marker file inside
    /// `brain_path` (see `INIT_FAILURE_MARKER`) and NOT retried again for
    /// `INIT_FAILURE_RETRY_AFTER_SECS` — a deterministically-failing init
    /// (observed in the field: exit code 1 on every boot) would otherwise
    /// re-run this blocking subprocess on every single app launch for no
    /// benefit. The cooldown is short enough that a transient cause (e.g. a
    /// one-time model download blocked by a flaky network) self-heals
    /// without the user needing to manually intervene.
    pub fn ensure_brain_init(lb: &LazyBrainBin, brain_path: &str) -> Option<String> {
        let brain_path_buf = std::path::Path::new(brain_path);
        match detect_existing_init(brain_path_buf) {
            BrainInitState::Canonical => {
                // Already initialized — skip to avoid unnecessary process spawn.
                // A config file existing is proof the brain is fine even if THIS
                // call didn't create it (e.g. a losing racer's failure marker,
                // written after a concurrent winning racer's init already
                // succeeded) — clear any marker now so it can never resurface to
                // block some future re-init at this same path. See
                // `clear_init_failure_marker`'s doc comment.
                clear_init_failure_marker(brain_path);
                return None;
            }
            BrainInitState::Legacy => {
                // Back-compat: accept the legacy parent-dir config as proof
                // of initialization and NEVER invoke `init` — see this
                // function's "LEGACY LAYOUT" doc comment above for why
                // calling `init` here would be doomed to fail non-zero.
                log::info!(
                    "LazyBrain brain at {} uses the legacy parent-dir config layout — accepting as initialized (skipping init)",
                    brain_path
                );
                clear_init_failure_marker(brain_path);
                migrate_legacy_config_if_absent(brain_path_buf);
                return None;
            }
            BrainInitState::NotFound => {}
        }

        let marker_path = std::path::Path::new(brain_path).join(INIT_FAILURE_MARKER);
        if let Some(age_secs) = read_failure_marker_age_secs(&marker_path) {
            if age_secs < INIT_FAILURE_RETRY_AFTER_SECS {
                log::debug!(
                    "LazyBrain init: skipping retry at {} — last attempt failed {}s ago (retrying after {}s)",
                    brain_path, age_secs, INIT_FAILURE_RETRY_AFTER_SECS
                );
                return Some(format!(
                    "init failed {}s ago and is still within its {}s retry cooldown",
                    age_secs, INIT_FAILURE_RETRY_AFTER_SECS
                ));
            }
        }

        log::info!("LazyBrain brain not found at {} — running init", brain_path);

        // Retry a few times with a short backoff before caching the failure —
        // a non-zero exit can be a TRANSIENT conflict (e.g. SQLITE_BUSY from
        // a concurrent `interlink`/`dream` maintenance pass — see
        // maintenance.rs — or another `ensure_brain_init` caller racing this
        // same brand-new brain_path, e.g. the app-startup thread in lib.rs's
        // `.setup()` vs. an onboarding-triggered `set_project`), not a
        // deterministic one. A spawn failure (`Err`, e.g. the binary itself
        // is missing) is never retried — no amount of waiting fixes an
        // absent executable — and is cached immediately, same as before.
        for attempt in 1..=INIT_TRANSIENT_RETRY_ATTEMPTS {
            let status = lb.command(&["init", "--brain", brain_path])
                .env("LAZYBRAIN_BRAIN_PATH", brain_path)
                .env("LAZYBRAIN_LOG_LEVEL", "warn")
                .env("LAZYBRAIN_TELEMETRY", "0")
                .env("LAZYBRAIN_EMBEDDINGS", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();

            match status {
                Ok(s) if s.success() => {
                    log::info!("LazyBrain init complete at {} (attempt {}/{})", brain_path, attempt, INIT_TRANSIENT_RETRY_ATTEMPTS);
                    // Clear any stale failure marker from a previous attempt.
                    let _ = std::fs::remove_file(&marker_path);
                    return None;
                }
                Ok(s) if attempt < INIT_TRANSIENT_RETRY_ATTEMPTS => {
                    log::warn!(
                        "LazyBrain init exited with status {} (attempt {}/{}) — retrying after {:?}, \
                         possibly a transient conflict with concurrent brain maintenance",
                        s, attempt, INIT_TRANSIENT_RETRY_ATTEMPTS, INIT_RETRY_BACKOFF
                    );
                    std::thread::sleep(INIT_RETRY_BACKOFF);
                }
                Ok(s) => {
                    log::warn!("LazyBrain init exited with status {} (final attempt {}/{})", s, attempt, INIT_TRANSIENT_RETRY_ATTEMPTS);
                    write_failure_marker(&marker_path);
                    return Some(format!("init exited with status {} after {}/{} attempts", s, attempt, INIT_TRANSIENT_RETRY_ATTEMPTS));
                }
                Err(e) => {
                    log::warn!("LazyBrain init failed to spawn: {}", e);
                    write_failure_marker(&marker_path);
                    return Some(format!("init failed to spawn: {}", e));
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use crate::commands::brain::sidecar::process::BrainSidecar;
    use crate::commands::brain::sidecar::resolve::LazyBrainBin;

    // ── Legacy brain-layout detection (brain-legacy-detection fix) ─────
    //
    // Reproduces the field bug: a brain whose `.lazybrain-config.json` lives
    // in the PARENT of the brain dir (pre-v1.1 layout) was wrongly concluded
    // "not found" because the old check only ever looked inside brain_path.
    // These tests pin `detect_existing_init`'s three-way outcome and prove
    // `ensure_brain_init` never spawns `init` for a legacy-initialized brain.

    #[test]
    fn detect_existing_init_recognises_canonical_config() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(&brain_dir).expect("create brain dir");
        std::fs::write(brain_dir.join(".lazybrain-config.json"), "{}").expect("write canonical config");

        assert_eq!(super::detect_existing_init(&brain_dir), super::BrainInitState::Canonical);
        eprintln!("detect_existing_init_recognises_canonical_config PASSED");
    }

    #[test]
    fn detect_existing_init_recognises_legacy_parent_dir_config() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(brain_dir.join("notes")).expect("create brain/notes dir");
        // Legacy config lives in the PARENT of brain_dir, mirroring the
        // product owner's real Lazy-Brain-David layout: config sits next to
        // (not inside) the `brain/` leaf.
        std::fs::write(tmp.path().join(".lazybrain-config.json"), "{}").expect("write legacy config");

        assert_eq!(super::detect_existing_init(&brain_dir), super::BrainInitState::Legacy);
        eprintln!("detect_existing_init_recognises_legacy_parent_dir_config PASSED");
    }

    #[test]
    fn detect_existing_init_returns_not_found_when_neither_config_exists() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(&brain_dir).expect("create brain dir");

        assert_eq!(super::detect_existing_init(&brain_dir), super::BrainInitState::NotFound);
        eprintln!("detect_existing_init_returns_not_found_when_neither_config_exists PASSED");
    }

    /// Canonical config takes priority over a legacy one if — implausibly —
    /// both exist (e.g. a migration copy already ran on a previous boot).
    #[test]
    fn detect_existing_init_prefers_canonical_over_legacy_when_both_exist() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(&brain_dir).expect("create brain dir");
        std::fs::write(brain_dir.join(".lazybrain-config.json"), "{}").expect("write canonical config");
        std::fs::write(tmp.path().join(".lazybrain-config.json"), "{}").expect("write legacy config");

        assert_eq!(super::detect_existing_init(&brain_dir), super::BrainInitState::Canonical);
        eprintln!("detect_existing_init_prefers_canonical_over_legacy_when_both_exist PASSED");
    }

    /// THE regression test for the field bug: a legacy-initialized brain
    /// must be accepted WITHOUT ever spawning `init` — proven here by
    /// pointing `LazyBrainBin` at a binary/script that cannot possibly run
    /// (spawn must fail with an OS error if actually attempted). If
    /// `ensure_brain_init` regressed to invoking init, `Command::status()`
    /// would return `Err`, which the (unchanged) spawn-failure branch turns
    /// into `Some(reason)` AND a written `.lazybrain-init-failed` marker —
    /// so asserting `None` and "no marker file" together prove init was
    /// never invoked, not just that it happened to "succeed".
    #[test]
    fn ensure_brain_init_accepts_legacy_layout_without_invoking_init() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(brain_dir.join("notes")).expect("create brain/notes dir");
        std::fs::write(tmp.path().join(".lazybrain-config.json"), "{}").expect("write legacy config");

        let bogus_lb = LazyBrainBin {
            node_exe: "definitely-not-a-real-lazybrain-node-binary-xyz".to_string(),
            script: "definitely-not-a-real-lazybrain-script.js".to_string(),
        };
        let brain_path = brain_dir.to_string_lossy().into_owned();

        let result = BrainSidecar::ensure_brain_init(&bogus_lb, &brain_path);

        assert_eq!(result, None, "a legacy-initialized brain must be accepted, never reported as a failure");
        assert!(
            !brain_dir.join(super::INIT_FAILURE_MARKER).exists(),
            "init must never actually be spawned for a legacy-initialized brain — a written failure marker \
             would prove the (bogus, guaranteed-to-fail) init subprocess was attempted"
        );
        eprintln!("ensure_brain_init_accepts_legacy_layout_without_invoking_init PASSED");
    }

    /// Existing-canonical-config path must keep working unchanged (init
    /// still never invoked, no failure marker) — the pre-existing fast path
    /// this fix must not disturb.
    #[test]
    fn ensure_brain_init_accepts_canonical_layout_without_invoking_init() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(&brain_dir).expect("create brain dir");
        std::fs::write(brain_dir.join(".lazybrain-config.json"), "{}").expect("write canonical config");

        let bogus_lb = LazyBrainBin {
            node_exe: "definitely-not-a-real-lazybrain-node-binary-xyz".to_string(),
            script: "definitely-not-a-real-lazybrain-script.js".to_string(),
        };
        let brain_path = brain_dir.to_string_lossy().into_owned();

        let result = BrainSidecar::ensure_brain_init(&bogus_lb, &brain_path);

        assert_eq!(result, None);
        assert!(!brain_dir.join(super::INIT_FAILURE_MARKER).exists());
        eprintln!("ensure_brain_init_accepts_canonical_layout_without_invoking_init PASSED");
    }

    /// Genuinely uninitialized brain (neither config exists) must still
    /// attempt init and honestly report failure when the binary cannot be
    /// spawned at all — the pre-existing NotFound path, now reached via
    /// `detect_existing_init` instead of the old single canonical check.
    #[test]
    fn ensure_brain_init_reports_failure_when_not_found_and_spawn_fails() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        // Deliberately do NOT create brain_dir or any config — genuinely uninitialized.

        let bogus_lb = LazyBrainBin {
            node_exe: "definitely-not-a-real-lazybrain-node-binary-xyz".to_string(),
            script: "definitely-not-a-real-lazybrain-script.js".to_string(),
        };
        let brain_path = brain_dir.to_string_lossy().into_owned();

        let result = BrainSidecar::ensure_brain_init(&bogus_lb, &brain_path);

        assert!(result.is_some(), "a genuinely uninitialized brain with a broken binary must report failure honestly");
        eprintln!("ensure_brain_init_reports_failure_when_not_found_and_spawn_fails PASSED");
    }

    /// `migrate_legacy_config_if_absent` must COPY (not move) the legacy
    /// config into the canonical location, leaving the original untouched.
    #[test]
    fn migrate_legacy_config_copies_without_deleting_original() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(&brain_dir).expect("create brain dir");
        let legacy_path = tmp.path().join(".lazybrain-config.json");
        std::fs::write(&legacy_path, r#"{"version":"1.0.0"}"#).expect("write legacy config");

        super::migrate_legacy_config_if_absent(&brain_dir);

        let canonical_path = brain_dir.join(".lazybrain-config.json");
        assert!(canonical_path.exists(), "migration must create the canonical config");
        assert!(legacy_path.exists(), "migration must be a COPY — the legacy original must remain");
        assert_eq!(
            std::fs::read_to_string(&canonical_path).unwrap(),
            std::fs::read_to_string(&legacy_path).unwrap(),
            "copied content must match the legacy source"
        );
        eprintln!("migrate_legacy_config_copies_without_deleting_original PASSED");
    }

    /// Migration must never overwrite an existing canonical config.
    #[test]
    fn migrate_legacy_config_is_a_noop_when_canonical_already_exists() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(&brain_dir).expect("create brain dir");
        std::fs::write(brain_dir.join(".lazybrain-config.json"), "canonical-content").expect("write canonical");
        std::fs::write(tmp.path().join(".lazybrain-config.json"), "legacy-content").expect("write legacy");

        super::migrate_legacy_config_if_absent(&brain_dir);

        assert_eq!(
            std::fs::read_to_string(brain_dir.join(".lazybrain-config.json")).unwrap(),
            "canonical-content",
            "an existing canonical config must never be overwritten by migration"
        );
        eprintln!("migrate_legacy_config_is_a_noop_when_canonical_already_exists PASSED");
    }

    // ── ensure_brain_init failure-caching (fix #6) ──────────────────────

    #[test]
    fn read_failure_marker_age_secs_none_when_file_absent() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let marker = tmp.path().join("does-not-exist");
        assert_eq!(super::read_failure_marker_age_secs(&marker), None);
        eprintln!("read_failure_marker_age_secs_none_when_file_absent PASSED");
    }

    #[test]
    fn read_failure_marker_age_secs_none_when_content_unparseable() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let marker = tmp.path().join("marker");
        std::fs::write(&marker, "not-a-number").expect("write marker");
        assert_eq!(super::read_failure_marker_age_secs(&marker), None);
        eprintln!("read_failure_marker_age_secs_none_when_content_unparseable PASSED");
    }

    #[test]
    fn read_failure_marker_age_secs_computes_elapsed_time() {
        use tempfile::TempDir;
        let tmp = TempDir::new().expect("TempDir::new");
        let marker = tmp.path().join("marker");
        let hundred_secs_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .saturating_sub(100);
        std::fs::write(&marker, hundred_secs_ago.to_string()).expect("write marker");

        let age = super::read_failure_marker_age_secs(&marker).expect("must parse a valid marker");
        // Generous slack for test execution time.
        assert!(age >= 100 && age < 115, "expected age ~100s, got {}", age);
        eprintln!("read_failure_marker_age_secs_computes_elapsed_time PASSED ({}s)", age);
    }

    /// End-to-end: a fresh brain_path with no config file and a bogus binary
    /// must, on the first call, attempt init (spawn fails) and write the
    /// failure marker so the NEXT boot can skip retrying immediately.
    #[test]
    fn ensure_brain_init_writes_failure_marker_when_spawn_fails() {
        use super::INIT_FAILURE_MARKER;
        use tempfile::TempDir;

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();

        let lb = LazyBrainBin {
            node_exe: "definitely-not-a-real-lazybrain-binary-xyz".to_string(),
            script: "nonexistent.js".to_string(),
        };

        BrainSidecar::ensure_brain_init(&lb, &brain_path);

        let marker = tmp.path().join(INIT_FAILURE_MARKER);
        assert!(
            marker.exists(),
            "a failed init spawn must write the failure marker, found none at {}",
            marker.display()
        );

        eprintln!("ensure_brain_init_writes_failure_marker_when_spawn_fails PASSED");
    }

    /// A RECENT (5s-old, well inside the 60s cooldown) failure marker must
    /// make `ensure_brain_init` skip the retry entirely. Proven by seeding a
    /// deliberately-old-but-recent timestamp and asserting it is left
    /// EXACTLY unchanged — if ensure_brain_init had incorrectly retried (and
    /// failed again, since the binary is still bogus), write_failure_marker
    /// would have overwritten it with a fresh "now" timestamp, which is
    /// trivially distinguishable from the seeded five-second-old value.
    ///
    /// NOTE: was seeded 1h-old against the original 6h cooldown
    /// (INIT_FAILURE_RETRY_AFTER_SECS) before that constant was shortened to
    /// 60s (see its doc comment) — rescaled proportionally so this still
    /// exercises "well inside the cooldown", not "now stale against a
    /// shorter window".
    #[test]
    fn ensure_brain_init_skips_spawn_when_recent_failure_marker_present() {
        use super::INIT_FAILURE_MARKER;
        use tempfile::TempDir;

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();
        let marker_path = tmp.path().join(INIT_FAILURE_MARKER);

        let five_secs_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .saturating_sub(5);
        std::fs::write(&marker_path, five_secs_ago.to_string()).expect("seed marker");

        let lb = LazyBrainBin {
            node_exe: "definitely-not-a-real-lazybrain-binary-xyz".to_string(),
            script: "nonexistent.js".to_string(),
        };
        BrainSidecar::ensure_brain_init(&lb, &brain_path);

        let recorded_after: u64 = std::fs::read_to_string(&marker_path)
            .expect("marker must still exist")
            .trim()
            .parse()
            .expect("marker must still contain a valid timestamp");
        assert_eq!(
            recorded_after, five_secs_ago,
            "a recent failure marker (inside the cooldown) must make ensure_brain_init skip \
             the retry — the marker must be left untouched, got a rewritten value instead"
        );

        eprintln!("ensure_brain_init_skips_spawn_when_recent_failure_marker_present PASSED");
    }

    /// An EXPIRED (2min-old, outside the 60s cooldown) failure marker must
    /// make `ensure_brain_init` retry — proven by asserting the marker's
    /// recorded timestamp actually changes (a still-failing retry rewrites it
    /// to a fresh "now" value, clearly different from the seeded
    /// two-minutes-ago one).
    ///
    /// NOTE: was seeded 7h-old against the original 6h cooldown before
    /// INIT_FAILURE_RETRY_AFTER_SECS was shortened to 60s — rescaled the same
    /// way as the "recent" test above.
    #[test]
    fn ensure_brain_init_retries_after_marker_expires() {
        use super::INIT_FAILURE_MARKER;
        use tempfile::TempDir;

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();
        let marker_path = tmp.path().join(INIT_FAILURE_MARKER);

        let two_mins_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .saturating_sub(2 * 60);
        std::fs::write(&marker_path, two_mins_ago.to_string()).expect("seed marker");

        let lb = LazyBrainBin {
            node_exe: "definitely-not-a-real-lazybrain-binary-xyz".to_string(),
            script: "nonexistent.js".to_string(),
        };
        BrainSidecar::ensure_brain_init(&lb, &brain_path);

        let recorded_after: u64 = std::fs::read_to_string(&marker_path)
            .expect("marker must still exist after a retried, still-failing attempt")
            .trim()
            .parse()
            .expect("marker must contain a valid timestamp");
        assert_ne!(
            recorded_after, two_mins_ago,
            "an expired failure marker must make ensure_brain_init retry — the marker must be \
             rewritten with a fresh timestamp, got the same stale one instead"
        );

        eprintln!("ensure_brain_init_retries_after_marker_expires PASSED");
    }

    /// A successful init must clear any stale failure marker from a
    /// previous failed attempt, so a later real failure isn't mistakenly
    /// reported with a stale age.
    #[test]
    fn ensure_brain_init_clears_marker_on_success() {
        use super::INIT_FAILURE_MARKER;
        use crate::commands::brain::config::resolve_bin_path_static;
        use tempfile::TempDir;

        let bin_path = match resolve_bin_path_static() {
            Ok(p) => p,
            Err(_) => {
                eprintln!("SKIP ensure_brain_init_clears_marker_on_success — lazybrain.js not found");
                return;
            }
        };
        let lb = LazyBrainBin { node_exe: "node".to_string(), script: bin_path };

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_path = tmp.path().to_str().unwrap().to_string();
        let marker_path = tmp.path().join(INIT_FAILURE_MARKER);

        // Seed a stale (expired) failure marker so this attempt is not skipped.
        let eight_hours_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .saturating_sub(8 * 3600);
        std::fs::write(&marker_path, eight_hours_ago.to_string()).expect("seed marker");

        BrainSidecar::ensure_brain_init(&lb, &brain_path);

        assert!(
            tmp.path().join(".lazybrain-config.json").exists(),
            "a real lazybrain init must create the config file"
        );
        assert!(
            !marker_path.exists(),
            "a successful init must clear any previously-recorded failure marker"
        );

        eprintln!("ensure_brain_init_clears_marker_on_success PASSED");
    }
}
