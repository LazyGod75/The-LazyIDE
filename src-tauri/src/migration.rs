//! One-shot profile migration: `com.lazy.dev` → `com.lazy.app`.
//!
//! v0.1.4 shipped with the dev bundle identifier `com.lazy.dev`, so every
//! per-app directory Windows derives from the identifier lives under it:
//!
//! - `%LOCALAPPDATA%\com.lazy.dev\EBWebView` — the WebView2 profile: ALL
//!   frontend state (localStorage incl. `lazy.accessSettings`,
//!   `lazy.apikey.anthropic`, onboarding flags, locale, project root, the
//!   Supabase session) lives in its LevelDB.
//! - `%LOCALAPPDATA%\com.lazy.dev\lazy` — brain-projects.json, teams context.
//! - `%LOCALAPPDATA%\com.lazy.dev\lazybrain` — the production brain SQLite.
//! - `%APPDATA%\com.lazy.dev\brain-config.json` — UI-persisted brain choice.
//!
//! v0.1.5 renames the identifier to `com.lazy.app`. Without migration every
//! upgraded user would boot into a blank profile (logged out, onboarding
//! again, empty brain). This module copies the four items above to the new
//! locations exactly once, marker-gated.
//!
//! Rules (from the v0.1.5 plan, wave W-MIG):
//! - Runs BEFORE any window/WebView2 initialization — WebView2 opens its
//!   LevelDB as soon as the first window is created, and copying an open
//!   LevelDB tears it. See the call site at the top of `lib.rs::run()`.
//! - `EBWebView`, `lazy`, `lazybrain` are each all-or-nothing: copied to a
//!   `<name>.migrating` staging dir, renamed into place on success; any error
//!   removes the staging dir so no torn LevelDB/SQLite can ever be picked up.
//! - Fail-open: a failed item is logged and skipped (fresh state for that
//!   item); the app always continues.
//! - The OLD directories are NEVER modified or deleted.
//! - `logs/` is deliberately not migrated: the log plugin recreates it and
//!   old logs stay readable under the old directory.
//!
//! Logging caveat: the log plugin only registers inside `.setup()`, after
//! this module runs, so `run_startup_migration` returns a report and the
//! caller logs it later via `log_report`.

use std::fs;
use std::path::{Path, PathBuf};

pub const OLD_IDENTIFIER: &str = "com.lazy.dev";
const MARKER_FILE: &str = ".migrated-from-com.lazy.dev";
const STAGING_SUFFIX: &str = ".migrating";
const DIR_ITEMS: [&str; 3] = ["EBWebView", "lazy", "lazybrain"];
const CONFIG_FILE: &str = "brain-config.json";

/// Outcome of one migrated item, kept for the deferred log report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemOutcome {
    /// Copied to the new location.
    Copied,
    /// Nothing to copy: the old location does not have this item.
    SourceAbsent,
    /// The new location already has this item — left untouched.
    TargetOccupied,
    /// Copy failed; the partial target was removed (fresh state for this item).
    Failed(String),
}

/// What `run_startup_migration` did, loggable once the log plugin is up.
#[derive(Debug, Clone, Default)]
pub struct MigrationReport {
    /// True when a migration pass actually ran (marker was absent).
    pub attempted: bool,
    pub items: Vec<(&'static str, ItemOutcome)>,
    pub note: Option<String>,
}

impl MigrationReport {
    fn skipped(note: &str) -> Self {
        MigrationReport {
            attempted: false,
            items: Vec::new(),
            note: Some(note.to_string()),
        }
    }
}

/// Entry point called from `lib.rs::run()` before the Tauri builder exists.
///
/// Resolves the identifier-derived directories from the Windows environment
/// (`LOCALAPPDATA` / `APPDATA` — the same folders Tauri's path API resolves
/// for `app_local_data_dir` / `app_config_dir` on Windows). On any other OS,
/// or if the variables are unset, this is a no-op: no old profile can exist.
pub fn run_startup_migration(new_identifier: &str) -> MigrationReport {
    let (Ok(local), Ok(roaming)) = (std::env::var("LOCALAPPDATA"), std::env::var("APPDATA"))
    else {
        return MigrationReport::skipped("LOCALAPPDATA/APPDATA not set — nothing to migrate");
    };
    let local = PathBuf::from(local);
    let roaming = PathBuf::from(roaming);
    migrate_profile(
        &local.join(OLD_IDENTIFIER),
        &local.join(new_identifier),
        &roaming.join(OLD_IDENTIFIER),
        &roaming.join(new_identifier),
    )
}

/// Pure-fs migration pass over explicit roots (unit-testable with temp dirs).
///
/// Marker-gated one-shot: if `<new_local>/.migrated-from-com.lazy.dev`
/// exists, nothing happens. Otherwise each item is copied only when its
/// source exists and its target does not, then the marker is written — even
/// after per-item failures (those items were cleaned up and start fresh;
/// retrying every boot against the same locked/broken source would not end
/// differently and would delay startup forever).
pub fn migrate_profile(
    old_local: &Path,
    new_local: &Path,
    old_roaming: &Path,
    new_roaming: &Path,
) -> MigrationReport {
    let marker = new_local.join(MARKER_FILE);
    if marker.exists() {
        return MigrationReport::skipped("marker present — already migrated");
    }
    if !old_local.exists() && !old_roaming.exists() {
        let mut report = MigrationReport::skipped("no old profile found — fresh install");
        if let Err(e) = write_marker(&marker, &[]) {
            report.note = Some(format!("no old profile; marker write failed: {e}"));
        }
        return report;
    }

    let mut items: Vec<(&'static str, ItemOutcome)> = Vec::new();
    for name in DIR_ITEMS {
        items.push((name, migrate_dir_item(old_local, new_local, name)));
    }
    items.push((
        CONFIG_FILE,
        migrate_file_item(&old_roaming.join(CONFIG_FILE), &new_roaming.join(CONFIG_FILE)),
    ));

    let mut note = None;
    if let Err(e) = write_marker(&marker, &items) {
        note = Some(format!("marker write failed (will re-check next boot): {e}"));
    }
    MigrationReport { attempted: true, items, note }
}

/// Copy `<old_root>/<name>` to `<new_root>/<name>`, all-or-nothing.
///
/// The copy goes to `<name>.migrating` first and is renamed into place only
/// when fully successful, so a hard kill mid-copy can never leave a torn
/// LevelDB/SQLite at the final path — at worst a stale staging dir, removed
/// on the next attempt.
fn migrate_dir_item(old_root: &Path, new_root: &Path, name: &str) -> ItemOutcome {
    let source = old_root.join(name);
    let target = new_root.join(name);
    let staging = new_root.join(format!("{name}{STAGING_SUFFIX}"));

    if target.exists() {
        return ItemOutcome::TargetOccupied;
    }
    if !source.is_dir() {
        return ItemOutcome::SourceAbsent;
    }
    if staging.exists() {
        if let Err(e) = fs::remove_dir_all(&staging) {
            return ItemOutcome::Failed(format!("stale staging dir not removable: {e}"));
        }
    }
    if let Err(e) = fs::create_dir_all(new_root) {
        return ItemOutcome::Failed(format!("cannot create target root: {e}"));
    }
    match copy_dir_recursive(&source, &staging) {
        Ok(()) => match fs::rename(&staging, &target) {
            Ok(()) => ItemOutcome::Copied,
            Err(e) => {
                let _ = fs::remove_dir_all(&staging);
                ItemOutcome::Failed(format!("rename into place failed: {e}"))
            }
        },
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            ItemOutcome::Failed(format!("copy failed: {e}"))
        }
    }
}

/// Copy a single file, all-or-nothing (partial target removed on failure).
fn migrate_file_item(source: &Path, target: &Path) -> ItemOutcome {
    if target.exists() {
        return ItemOutcome::TargetOccupied;
    }
    if !source.is_file() {
        return ItemOutcome::SourceAbsent;
    }
    if let Some(parent) = target.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return ItemOutcome::Failed(format!("cannot create target dir: {e}"));
        }
    }
    match fs::copy(source, target) {
        Ok(_) => ItemOutcome::Copied,
        Err(e) => {
            let _ = fs::remove_file(target);
            ItemOutcome::Failed(format!("copy failed: {e}"))
        }
    }
}

/// Recursive copy that fails on the FIRST error (all-or-nothing contract —
/// per-file skip would silently tear LevelDB/SQLite directories apart).
/// Symlinks are not followed (`fs::copy` on one fails → whole item fails);
/// WebView2/brain profiles contain none in practice.
fn copy_dir_recursive(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let dest = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

fn write_marker(marker: &Path, items: &[(&'static str, ItemOutcome)]) -> std::io::Result<()> {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent)?;
    }
    let summary = items
        .iter()
        .map(|(name, outcome)| format!("{name}: {outcome:?}"))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(marker, format!("migrated from {OLD_IDENTIFIER}\n{summary}\n"))
}

/// Log the report — call AFTER the log plugin registered (in `.setup()`).
pub fn log_report(report: &MigrationReport) {
    if !report.attempted {
        if let Some(note) = &report.note {
            log::info!("profile migration skipped: {note}");
        }
        return;
    }
    for (name, outcome) in &report.items {
        match outcome {
            ItemOutcome::Copied => log::info!("profile migration: {name} copied"),
            ItemOutcome::SourceAbsent => log::info!("profile migration: {name} absent in old profile"),
            ItemOutcome::TargetOccupied => log::info!("profile migration: {name} already present — kept"),
            ItemOutcome::Failed(e) => log::warn!(
                "profile migration: {name} FAILED ({e}) — partial copy removed, starting fresh for this item"
            ),
        }
    }
    if let Some(note) = &report.note {
        log::warn!("profile migration: {note}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    /// Full old profile → everything lands at the new roots, marker written,
    /// old dirs untouched, logs/ not migrated.
    #[test]
    fn migrates_full_profile_and_writes_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let (ol, nl) = (tmp.path().join("local/old"), tmp.path().join("local/new"));
        let (or_, nr) = (tmp.path().join("roam/old"), tmp.path().join("roam/new"));
        write(&ol.join("EBWebView/Default/000001.ldb"), "leveldb");
        write(&ol.join("EBWebView/Local State"), "state");
        write(&ol.join("lazy/brain-projects.json"), "projects");
        write(&ol.join("lazybrain/brain/notes.sqlite"), "brain");
        write(&ol.join("logs/app.log"), "old logs");
        write(&or_.join("brain-config.json"), "config");

        let report = migrate_profile(&ol, &nl, &or_, &nr);

        assert!(report.attempted);
        for (name, outcome) in &report.items {
            assert_eq!(outcome, &ItemOutcome::Copied, "{name} should be Copied");
        }
        assert_eq!(read(&nl.join("EBWebView/Default/000001.ldb")), "leveldb");
        assert_eq!(read(&nl.join("EBWebView/Local State")), "state");
        assert_eq!(read(&nl.join("lazy/brain-projects.json")), "projects");
        assert_eq!(read(&nl.join("lazybrain/brain/notes.sqlite")), "brain");
        assert_eq!(read(&nr.join("brain-config.json")), "config");
        assert!(!nl.join("logs").exists(), "logs must not be migrated");
        assert!(nl.join(MARKER_FILE).is_file(), "marker must be written");
        // Old profile untouched.
        assert_eq!(read(&ol.join("EBWebView/Default/000001.ldb")), "leveldb");
        assert_eq!(read(&or_.join("brain-config.json")), "config");
    }

    /// Marker present → strict no-op even when old data changed since.
    #[test]
    fn second_run_is_a_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let (ol, nl) = (tmp.path().join("lo"), tmp.path().join("ln"));
        let (or_, nr) = (tmp.path().join("ro"), tmp.path().join("rn"));
        write(&ol.join("lazy/a.json"), "v1");
        migrate_profile(&ol, &nl, &or_, &nr);
        write(&ol.join("lazy/a.json"), "v2");
        write(&ol.join("lazybrain/new.sqlite"), "late");

        let report = migrate_profile(&ol, &nl, &or_, &nr);

        assert!(!report.attempted);
        assert_eq!(read(&nl.join("lazy/a.json")), "v1", "no re-copy after marker");
        assert!(!nl.join("lazybrain").exists());
    }

    /// Items missing from the old profile are skipped, the rest migrates
    /// (matches this machine: only EBWebView + brain-config.json exist).
    #[test]
    fn missing_sources_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let (ol, nl) = (tmp.path().join("lo"), tmp.path().join("ln"));
        let (or_, nr) = (tmp.path().join("ro"), tmp.path().join("rn"));
        write(&ol.join("EBWebView/Local State"), "state");
        write(&or_.join("brain-config.json"), "cfg");

        let report = migrate_profile(&ol, &nl, &or_, &nr);

        let get = |n: &str| {
            report.items.iter().find(|(name, _)| *name == n).map(|(_, o)| o.clone()).unwrap()
        };
        assert_eq!(get("EBWebView"), ItemOutcome::Copied);
        assert_eq!(get("lazy"), ItemOutcome::SourceAbsent);
        assert_eq!(get("lazybrain"), ItemOutcome::SourceAbsent);
        assert_eq!(get("brain-config.json"), ItemOutcome::Copied);
        assert!(nl.join(MARKER_FILE).is_file());
    }

    /// Fresh machine (no old dirs at all) → marker written, nothing copied.
    #[test]
    fn no_old_profile_writes_marker_and_skips() {
        let tmp = tempfile::tempdir().unwrap();
        let (ol, nl) = (tmp.path().join("lo"), tmp.path().join("ln"));
        let (or_, nr) = (tmp.path().join("ro"), tmp.path().join("rn"));

        let report = migrate_profile(&ol, &nl, &or_, &nr);

        assert!(!report.attempted);
        assert!(report.items.is_empty());
        assert!(nl.join(MARKER_FILE).is_file(), "marker still written (one-shot)");
    }

    /// A target that already exists is never overwritten.
    #[test]
    fn occupied_target_is_left_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let (ol, nl) = (tmp.path().join("lo"), tmp.path().join("ln"));
        let (or_, nr) = (tmp.path().join("ro"), tmp.path().join("rn"));
        write(&ol.join("EBWebView/Local State"), "old");
        write(&nl.join("EBWebView/Local State"), "existing");

        let report = migrate_profile(&ol, &nl, &or_, &nr);

        let ebw = report.items.iter().find(|(n, _)| *n == "EBWebView").unwrap();
        assert_eq!(ebw.1, ItemOutcome::TargetOccupied);
        assert_eq!(read(&nl.join("EBWebView/Local State")), "existing");
    }

    /// A stale staging dir from an interrupted previous attempt is replaced.
    #[test]
    fn stale_staging_dir_is_cleaned() {
        let tmp = tempfile::tempdir().unwrap();
        let (ol, nl) = (tmp.path().join("lo"), tmp.path().join("ln"));
        let (or_, nr) = (tmp.path().join("ro"), tmp.path().join("rn"));
        write(&ol.join("lazy/a.json"), "good");
        write(&nl.join("lazy.migrating/torn.json"), "torn");

        let report = migrate_profile(&ol, &nl, &or_, &nr);

        let lazy = report.items.iter().find(|(n, _)| *n == "lazy").unwrap();
        assert_eq!(lazy.1, ItemOutcome::Copied);
        assert_eq!(read(&nl.join("lazy/a.json")), "good");
        assert!(!nl.join("lazy.migrating").exists(), "staging dir must be gone");
    }

    /// A locked file mid-EBWebView (Windows sharing violation) fails that item
    /// all-or-nothing — no partial target, no staging leftover — while the
    /// OTHER items still migrate (fail-open independence).
    #[cfg(windows)]
    #[test]
    fn locked_file_fails_item_all_or_nothing_and_others_continue() {
        use std::os::windows::fs::OpenOptionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let (ol, nl) = (tmp.path().join("lo"), tmp.path().join("ln"));
        let (or_, nr) = (tmp.path().join("ro"), tmp.path().join("rn"));
        write(&ol.join("EBWebView/Default/000001.ldb"), "leveldb");
        write(&ol.join("EBWebView/locked.bin"), "locked");
        write(&ol.join("lazybrain/brain.sqlite"), "brain");
        // share_mode(0): any other open (incl. fs::copy's read) hits
        // ERROR_SHARING_VIOLATION while this handle lives.
        let _lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(ol.join("EBWebView/locked.bin"))
            .unwrap();

        let report = migrate_profile(&ol, &nl, &or_, &nr);

        let get = |n: &str| {
            report.items.iter().find(|(name, _)| *name == n).map(|(_, o)| o.clone()).unwrap()
        };
        assert!(matches!(get("EBWebView"), ItemOutcome::Failed(_)));
        assert!(!nl.join("EBWebView").exists(), "no partial EBWebView target");
        assert!(
            !nl.join(format!("EBWebView{STAGING_SUFFIX}")).exists(),
            "no staging leftover"
        );
        assert_eq!(get("lazybrain"), ItemOutcome::Copied, "fail-open: others continue");
        assert!(nl.join(MARKER_FILE).is_file(), "marker written despite failure (one-shot)");
        // Old profile untouched, including the locked file's sibling.
        assert_eq!(read(&ol.join("EBWebView/Default/000001.ldb")), "leveldb");
    }
}
