//! Tauri-managed application state shared across every command module.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Holds the currently-open project root path.
/// Defaults to the process working directory on first access.
///
/// LEGACY / COMPAT: this is the pre-multi-project single-root state. Its
/// shape (`pub Mutex<String>`) is kept EXACTLY as before because several
/// command modules (fs.rs's `get_project_root`, agent.rs's scheduler-dir
/// helpers, chat.rs, brain/search.rs, brain/publish.rs, brain/capture.rs,
/// brain/history_import.rs, brain/maintenance.rs, brain/config.rs, and
/// brain/sidecar.rs's `brain_path_from_project`) still read
/// `project_state.0.lock()` directly as "the current project's root" for
/// defaults/display — none of these gate a caller-supplied path against it,
/// so they are intentionally left on this legacy mutex rather than the
/// registry (see `docs/superpowers/plans/2026-07-09-cockpit-v2-fleet.md`
/// task T0.7's file allowlist). `ProjectRegistry` below is the new
/// multi-root source of truth and is now the ONLY thing every path-gating
/// call site validates a caller-supplied path against — git.rs, fs.rs,
/// shell.rs, agent.rs's `agent_run`, and lsp.rs, via
/// `commands::util::ensure_repo_in_any_open_project` /
/// `commands::fs::ensure_path_in_any_open_project` /
/// `commands::fs::ensure_write_path_in_any_open_project` (see
/// `RegistryInner::all_roots`'s doc comment below). `project_set_active`
/// (commands/brain/config.rs) keeps this mutex in sync with the registry's
/// active entry on every register/switch, so every remaining direct reader
/// above keeps reading the correct (currently active) root with zero
/// changes on their part.
pub struct ProjectState(pub Mutex<String>);

impl Default for ProjectState {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectState {
    pub fn new() -> Self {
        // Start with no project — the user must explicitly open a folder.
        // This ensures the IDE shows an empty state on first launch instead of
        // auto-loading the process working directory.
        ProjectState(Mutex::new(String::new()))
    }
}

/// One registered project root — the multi-tenant unit the fleet cockpit
/// operates on (spec `docs/superpowers/specs/2026-07-09-cockpit-v2-fleet-design.md`
/// section 5.1). `id` is a stable hash of the canonicalized root (see
/// `commands::util::project_id_for_root`) so it survives across app
/// restarts and does not depend on registration order. `brain_id` is the
/// multi-tenant brain-sidecar's own id for this project's brain (section
/// 5.2) — `None` until the first successful `POST /brains/open` (see
/// `commands::brain::sidecar::brain_open_on_sidecar`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectEntry {
    pub id: String,
    pub root: String,
    pub brain_id: Option<String>,
}

/// The multi-project registry's lock-guarded data: every open project plus
/// which one is active. A plain struct (not hidden behind its own newtype)
/// so its mutation logic is directly unit-testable without a `tauri::State`
/// — mirrors the `_inner`-function convention used elsewhere in this crate
/// (e.g. `commands/journal.rs`), just expressed as inherent methods here
/// since the "connection" being wrapped is this struct itself, not an
/// external resource.
#[derive(Debug, Clone, Default)]
pub struct RegistryInner {
    pub open: Vec<ProjectEntry>,
    /// The active entry's `id`, or `None` when nothing is open yet.
    pub active: Option<String>,
}

impl RegistryInner {
    /// Find an open entry by id.
    pub fn find(&self, id: &str) -> Option<&ProjectEntry> {
        self.open.iter().find(|e| e.id == id)
    }

    fn find_mut(&mut self, id: &str) -> Option<&mut ProjectEntry> {
        self.open.iter_mut().find(|e| e.id == id)
    }

    /// The currently active entry, if any.
    pub fn active_entry(&self) -> Option<&ProjectEntry> {
        self.active.as_deref().and_then(|id| self.find(id))
    }

    /// Compat accessor: the active project's root, or `None` if nothing is
    /// active — the value every legacy `ProjectState.0.lock()` reader
    /// effectively wants. See `ProjectState`'s doc comment for why the
    /// legacy mutex still exists side by side with this.
    pub fn active_root(&self) -> Option<String> {
        self.active_entry().map(|e| e.root.clone())
    }

    /// The active project's known brain id, if any (`None` until the first
    /// successful `/brains/open` — see `active_brain_query_suffix`,
    /// commands/brain/sidecar.rs). Symmetric compat accessor alongside
    /// `active_root` — not yet called from production code (every current
    /// call site needs the whole active `ProjectEntry`, not just this one
    /// field), kept for the same reason and tested directly (see this
    /// module's tests).
    #[allow(dead_code)]
    pub fn active_brain_id(&self) -> Option<String> {
        self.active_entry().and_then(|e| e.brain_id.clone())
    }

    /// All open roots, in registration order — the allowlist
    /// `ensure_repo_in_any_open_project` (commands/util.rs) and fs.rs's own
    /// `ensure_path_in_any_open_project` / `ensure_write_path_in_any_open_project`
    /// check against. Called by every command module that gates a
    /// caller-supplied path against the currently open project(s) — git.rs,
    /// shell.rs, agent.rs, lsp.rs, fs.rs — so a mission running in a
    /// registered-but-not-active ("background") project is not rejected.
    pub fn all_roots(&self) -> Vec<String> {
        self.open.iter().map(|e| e.root.clone()).collect()
    }

    /// Idempotent register: if an entry with `entry.id` is already open,
    /// returns the EXISTING entry unchanged (never duplicates the `open`
    /// list, never clobbers an already-resolved `brain_id` with a fresh
    /// `None`); otherwise inserts `entry` and returns it.
    pub fn register(&mut self, entry: ProjectEntry) -> ProjectEntry {
        if let Some(existing) = self.find(&entry.id) {
            return existing.clone();
        }
        self.open.push(entry.clone());
        entry
    }

    /// Flip the active project to `id`. Errs if `id` is not an open entry —
    /// callers must register before activating.
    pub fn set_active(&mut self, id: &str) -> Result<(), String> {
        if self.find(id).is_none() {
            return Err(format!("project_set_active: '{}' is not a registered open project", id));
        }
        self.active = Some(id.to_string());
        Ok(())
    }

    /// Close `id`. Semantics ("never the active one unless it's the last"):
    /// closing the ONLY open project (necessarily the active one) clears
    /// `active` back to `None`; closing the active project while OTHER
    /// projects remain open is rejected (the caller must switch away
    /// first — an active project can never be left dangling on a
    /// since-removed id); closing any non-active project is unconditional.
    /// Closing an id that is not currently open is an idempotent no-op
    /// (`Ok(false)` — nothing to do), matching `register`'s
    /// idempotent-insert philosophy elsewhere in this registry.
    pub fn close(&mut self, id: &str) -> Result<bool, String> {
        if self.find(id).is_none() {
            return Ok(false);
        }
        let is_active = self.active.as_deref() == Some(id);
        if is_active && self.open.len() > 1 {
            return Err(
                "cannot close the active project while other projects are open — switch to another project first"
                    .to_string(),
            );
        }
        self.open.retain(|e| e.id != id);
        if is_active {
            self.active = None;
        }
        Ok(true)
    }

    /// Record `brain_id` against the entry `id`, if it is still open — a
    /// best-effort no-op if the project was closed in the meantime, never a
    /// hard error (mirrors this crate's "brain routing degrades gracefully"
    /// philosophy elsewhere, e.g. `active_brain_query_suffix`).
    pub fn set_brain_id(&mut self, id: &str, brain_id: String) {
        if let Some(entry) = self.find_mut(id) {
            entry.brain_id = Some(brain_id);
        }
    }

    /// Forget every cached `brain_id` (keep every entry itself). Called
    /// whenever the brain sidecar PROCESS is restarted (`restart_brain_sidecar`,
    /// commands/brain/config.rs): the multi-tenant engine's brain registry
    /// lives in that process's memory only (see `engine/src/server/brain-registry.ts`
    /// module doc), so a fresh process has forgotten every id this app
    /// previously cached — without this, a subsequent `brain_fetch_*` would
    /// send a now-unrecognized `brainId` and 404. Next use re-resolves
    /// lazily via `active_brain_query_suffix`.
    pub fn clear_all_brain_ids(&mut self) {
        for entry in &mut self.open {
            entry.brain_id = None;
        }
    }

    /// Snapshot this registry into its on-disk shape (see `PersistedRegistry`'s
    /// doc comment for why `brain_id` is deliberately dropped).
    pub fn to_persisted(&self) -> PersistedRegistry {
        PersistedRegistry {
            open: self
                .open
                .iter()
                .map(|e| PersistedProjectEntry { id: e.id.clone(), root: e.root.clone() })
                .collect(),
            active: self.active.clone(),
        }
    }

    /// Rebuild a registry from a persisted snapshot, DROPPING any entry whose
    /// `root` no longer exists on disk (a project folder can be deleted,
    /// moved, or an external drive unmounted between app runs — silently
    /// keeping a dead entry around would let every path-gating call site
    /// listed on `ProjectRegistry`'s doc comment allowlist a root that is no
    /// longer real, and the frontend would show a zone for a project it can
    /// never actually open). `root_exists` is injected (rather than calling
    /// `Path::is_dir` directly) purely so this is unit-testable against
    /// synthetic roots without touching the real filesystem.
    ///
    /// If the previously-active entry was itself pruned, `active` falls back
    /// to the first surviving entry (if any) rather than leaving a registry
    /// that has open projects but no active one — every reader of
    /// `active_root()`/`active_entry()` (this module, `ProjectState` sync,
    /// the frontend's `openProjects.find(e => e.active)`) treats "some
    /// projects open, none active" as an unreachable state elsewhere in this
    /// codebase, so restoring one honestly here avoids introducing it.
    pub fn from_persisted_pruned(persisted: PersistedRegistry, root_exists: impl Fn(&str) -> bool) -> Self {
        let open: Vec<ProjectEntry> = persisted
            .open
            .into_iter()
            .filter(|e| root_exists(&e.root))
            .map(|e| ProjectEntry { id: e.id, root: e.root, brain_id: None })
            .collect();
        let active = persisted
            .active
            .filter(|id| open.iter().any(|e| &e.id == id))
            .or_else(|| open.first().map(|e| e.id.clone()));
        RegistryInner { open, active }
    }
}

/// Serializable snapshot of `RegistryInner`, persisted at
/// `<app_local_data_dir>/projects.json` (T-R1c: the canvas's "every project
/// you opened is back after a restart" contract). Deliberately excludes
/// `brain_id`: the multi-tenant brain sidecar's own in-memory brain registry
/// is forgotten on every process restart (see `clear_all_brain_ids`'s doc
/// comment), so a persisted `brain_id` would always be stale by the time it
/// is read back — every restored entry re-resolves it lazily the same way a
/// freshly-registered one does (`project_register_inner`'s best-effort
/// `/brains/open` call).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PersistedRegistry {
    pub open: Vec<PersistedProjectEntry>,
    pub active: Option<String>,
}

/// One persisted project entry — `id`/`root` only, see `PersistedRegistry`'s
/// doc comment for why `brain_id` is not part of this shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersistedProjectEntry {
    pub id: String,
    pub root: String,
}

/// Load the persisted registry from `path`
/// (`<app_local_data_dir>/projects.json`). `Ok(None)` when the file does not
/// exist yet — first run, or any session before this feature existed —
/// callers treat that identically to "nothing was ever persisted", the same
/// convention `commands::canvas::canvas_state_load_inner` already
/// established for this crate's other JSON-file persistence. A malformed
/// file (corrupted write, hand-edited, a future format change) is an honest
/// `Err`: the caller (`run()`'s `.setup()`, lib.rs) logs it and boots with an
/// empty registry rather than guessing at a partial parse.
pub fn projects_registry_load_inner(path: &Path) -> Result<Option<PersistedRegistry>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("projects_registry_load: read failed for '{}': {}", path.display(), e))?;
    let parsed: PersistedRegistry = serde_json::from_str(&raw)
        .map_err(|e| format!("projects_registry_load: parse failed for '{}': {}", path.display(), e))?;
    Ok(Some(parsed))
}

/// Atomically persist `registry` at `path` — write to a sibling
/// `<path>.tmp` file, then `fs::rename` it over the real path. Same
/// crash-safety rationale as `commands::canvas::canvas_state_save_inner`:
/// `fs::rename` is atomic within the same directory on both Windows and
/// POSIX, so a crash or kill mid-write can never leave a half-written,
/// corrupt `projects.json` for the next boot to trip over.
pub fn projects_registry_save_inner(path: &Path, registry: &PersistedRegistry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("projects_registry_save: create_dir_all failed for '{}': {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(registry)
        .map_err(|e| format!("projects_registry_save: serialize failed: {}", e))?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, json.as_bytes())
        .map_err(|e| format!("projects_registry_save: write failed for '{}': {}", tmp_path.display(), e))?;
    fs::rename(&tmp_path, path).map_err(|e| {
        format!(
            "projects_registry_save: rename failed '{}' -> '{}': {}",
            tmp_path.display(),
            path.display(),
            e
        )
    })
}

/// Multi-root project registry (spec section 5.1) — the SOURCE OF TRUTH for
/// "which projects are open" and "which one is active", replacing
/// `ProjectState`'s single root for that purpose. `ProjectState` itself is
/// kept in sync (see its doc comment) for the many call sites not yet
/// migrated to this type.
pub struct ProjectRegistry(pub Mutex<RegistryInner>);

impl Default for ProjectRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectRegistry {
    pub fn new() -> Self {
        ProjectRegistry(Mutex::new(RegistryInner::default()))
    }

    /// Compat convenience: lock and read the active root in one call.
    /// Returns `None` on a poisoned lock or when nothing is active — never
    /// panics, so a caller can treat it exactly like reading an unset
    /// `ProjectState` (which defaults to an empty string, i.e. also "no
    /// project"). Not yet called from production code: every current
    /// command already holds its own `MutexGuard<RegistryInner>` for other
    /// reasons too (see commands/brain/config.rs's `project_set_active`),
    /// so this is prepared for the call sites named in `ProjectState`'s doc
    /// comment (state.rs) that migrate later with a one-line diff.
    #[allow(dead_code)]
    pub fn active_root(&self) -> Option<String> {
        self.0.lock().ok()?.active_root()
    }
}

/// Holds the single shared SQLite connection backing the event journal (see
/// `commands/journal.rs`). One global connection, not per-project: the
/// fleet cockpit is cross-project by definition, so the append-only
/// `events` table + materialized `missions_current` projection live at the
/// app level (`appDataDir()/journal.db`), not inside any one project's
/// `.lazy/` — see spec `docs/superpowers/specs/2026-07-09-cockpit-v2-fleet-design.md`
/// section 4.1.
///
/// `Arc<Mutex<Connection>>` (rather than a bare `Mutex<Connection>` like
/// `ProjectState` uses) so the connection can be cloned out to background
/// jobs (retention/VACUUM, planned for a later task) that must outlive any
/// single command's `tauri::State` borrow.
pub struct JournalState(pub Arc<Mutex<Connection>>);

impl JournalState {
    pub fn new(conn: Connection) -> Self {
        JournalState(Arc::new(Mutex::new(conn)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn entry(id: &str, root: &str) -> ProjectEntry {
        ProjectEntry { id: id.to_string(), root: root.to_string(), brain_id: None }
    }

    // ── register (idempotency) ───────────────────────────────────────

    #[test]
    fn register_is_idempotent_same_path_twice_yields_one_entry_same_id() {
        let mut inner = RegistryInner::default();
        let first = inner.register(entry("id-1", r"C:\proj"));
        let second = inner.register(entry("id-1", r"C:\proj"));
        assert_eq!(first.id, second.id);
        assert_eq!(inner.open.len(), 1, "registering the same id twice must not duplicate the entry");
        eprintln!("register_is_idempotent_same_path_twice_yields_one_entry_same_id PASSED");
    }

    #[test]
    fn register_preserves_an_already_resolved_brain_id_on_reregister() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj"));
        inner.set_brain_id("id-1", "brain-abc".to_string());

        // Re-registering the same id (e.g. re-opening the same folder) must
        // NOT clobber the brain_id already resolved for it with a fresh None.
        let again = inner.register(entry("id-1", r"C:\proj"));
        assert_eq!(again.brain_id.as_deref(), Some("brain-abc"));
        assert_eq!(inner.open.len(), 1);
        eprintln!("register_preserves_an_already_resolved_brain_id_on_reregister PASSED");
    }

    #[test]
    fn register_of_a_second_distinct_root_adds_a_second_entry() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj-a"));
        inner.register(entry("id-2", r"C:\proj-b"));
        assert_eq!(inner.open.len(), 2);
        eprintln!("register_of_a_second_distinct_root_adds_a_second_entry PASSED");
    }

    // ── active_root (compat accessor) ────────────────────────────────

    #[test]
    fn active_root_is_none_before_anything_is_active() {
        let inner = RegistryInner::default();
        assert_eq!(inner.active_root(), None);
        eprintln!("active_root_is_none_before_anything_is_active PASSED");
    }

    #[test]
    fn active_root_reflects_the_active_entry_after_set_active() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj-a"));
        inner.register(entry("id-2", r"C:\proj-b"));
        inner.set_active("id-2").expect("set_active");
        assert_eq!(inner.active_root().as_deref(), Some(r"C:\proj-b"));
        eprintln!("active_root_reflects_the_active_entry_after_set_active PASSED");
    }

    #[test]
    fn set_active_rejects_an_unregistered_id() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj-a"));
        let result = inner.set_active("nope");
        assert!(result.is_err());
        assert_eq!(inner.active, None, "a rejected set_active must not change the active id");
        eprintln!("set_active_rejects_an_unregistered_id PASSED");
    }

    #[test]
    fn project_registry_new_starts_empty_with_no_active_project() {
        let registry = ProjectRegistry::new();
        assert_eq!(registry.active_root(), None);
        eprintln!("project_registry_new_starts_empty_with_no_active_project PASSED");
    }

    // ── close semantics ───────────────────────────────────────────────

    #[test]
    fn close_the_last_open_project_clears_active() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj"));
        inner.set_active("id-1").unwrap();

        let removed = inner.close("id-1").expect("close");
        assert!(removed);
        assert!(inner.open.is_empty());
        assert_eq!(inner.active, None, "closing the only open project must clear active");
        eprintln!("close_the_last_open_project_clears_active PASSED");
    }

    #[test]
    fn close_a_non_active_project_leaves_active_untouched() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj-a"));
        inner.register(entry("id-2", r"C:\proj-b"));
        inner.set_active("id-1").unwrap();

        let removed = inner.close("id-2").expect("close");
        assert!(removed);
        assert_eq!(inner.open.len(), 1);
        assert_eq!(inner.active.as_deref(), Some("id-1"));
        eprintln!("close_a_non_active_project_leaves_active_untouched PASSED");
    }

    #[test]
    fn close_rejects_closing_the_active_project_while_others_remain_open() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj-a"));
        inner.register(entry("id-2", r"C:\proj-b"));
        inner.set_active("id-1").unwrap();

        let result = inner.close("id-1");
        assert!(result.is_err(), "must not allow closing the active project while another stays open");
        assert_eq!(inner.open.len(), 2, "a rejected close must not mutate the registry");
        assert_eq!(inner.active.as_deref(), Some("id-1"));
        eprintln!("close_rejects_closing_the_active_project_while_others_remain_open PASSED");
    }

    #[test]
    fn close_an_unregistered_id_is_an_idempotent_noop() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj"));
        let removed = inner.close("never-registered").expect("close of unknown id must not error");
        assert!(!removed);
        assert_eq!(inner.open.len(), 1, "an unknown id must not affect other entries");
        eprintln!("close_an_unregistered_id_is_an_idempotent_noop PASSED");
    }

    // ── brain id caching ──────────────────────────────────────────────

    #[test]
    fn active_brain_id_is_none_until_set_then_reflects_the_active_entry() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj-a"));
        inner.register(entry("id-2", r"C:\proj-b"));
        inner.set_active("id-2").unwrap();
        assert_eq!(inner.active_brain_id(), None);

        inner.set_brain_id("id-2", "brain-xyz".to_string());
        assert_eq!(inner.active_brain_id().as_deref(), Some("brain-xyz"));
        // Setting a brain id on the NON-active entry must not leak through.
        inner.set_brain_id("id-1", "brain-other".to_string());
        assert_eq!(inner.active_brain_id().as_deref(), Some("brain-xyz"));
        eprintln!("active_brain_id_is_none_until_set_then_reflects_the_active_entry PASSED");
    }

    #[test]
    fn clear_all_brain_ids_forgets_every_cached_id_but_keeps_entries() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj-a"));
        inner.register(entry("id-2", r"C:\proj-b"));
        inner.set_brain_id("id-1", "brain-a".to_string());
        inner.set_brain_id("id-2", "brain-b".to_string());

        inner.clear_all_brain_ids();

        assert_eq!(inner.open.len(), 2, "entries themselves must survive");
        assert!(inner.open.iter().all(|e| e.brain_id.is_none()));
        eprintln!("clear_all_brain_ids_forgets_every_cached_id_but_keeps_entries PASSED");
    }

    #[test]
    fn all_roots_lists_every_open_root_in_registration_order() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj-a"));
        inner.register(entry("id-2", r"C:\proj-b"));
        assert_eq!(inner.all_roots(), vec![r"C:\proj-a".to_string(), r"C:\proj-b".to_string()]);
        eprintln!("all_roots_lists_every_open_root_in_registration_order PASSED");
    }

    // ── Persistence (T-R1c: registry survives a restart) ─────────────

    #[test]
    fn to_persisted_drops_brain_id_but_keeps_id_root_and_active() {
        let mut inner = RegistryInner::default();
        inner.register(entry("id-1", r"C:\proj-a"));
        inner.set_active("id-1").unwrap();
        inner.set_brain_id("id-1", "brain-a".to_string());

        let persisted = inner.to_persisted();
        assert_eq!(persisted.open.len(), 1);
        assert_eq!(persisted.open[0].id, "id-1");
        assert_eq!(persisted.open[0].root, r"C:\proj-a");
        assert_eq!(persisted.active.as_deref(), Some("id-1"));
        eprintln!("to_persisted_drops_brain_id_but_keeps_id_root_and_active PASSED");
    }

    #[test]
    fn from_persisted_pruned_keeps_every_entry_whose_root_still_exists() {
        let persisted = PersistedRegistry {
            open: vec![
                PersistedProjectEntry { id: "id-1".to_string(), root: r"C:\proj-a".to_string() },
                PersistedProjectEntry { id: "id-2".to_string(), root: r"C:\proj-b".to_string() },
            ],
            active: Some("id-2".to_string()),
        };

        let rebuilt = RegistryInner::from_persisted_pruned(persisted, |_root| true);

        assert_eq!(rebuilt.open.len(), 2);
        assert_eq!(rebuilt.active.as_deref(), Some("id-2"));
        assert!(rebuilt.open.iter().all(|e| e.brain_id.is_none()), "brain_id must not survive a restart");
        eprintln!("from_persisted_pruned_keeps_every_entry_whose_root_still_exists PASSED");
    }

    #[test]
    fn from_persisted_pruned_drops_entries_whose_root_no_longer_exists() {
        let persisted = PersistedRegistry {
            open: vec![
                PersistedProjectEntry { id: "id-1".to_string(), root: r"C:\proj-a".to_string() },
                PersistedProjectEntry { id: "id-2".to_string(), root: r"C:\deleted".to_string() },
            ],
            active: Some("id-1".to_string()),
        };

        let rebuilt = RegistryInner::from_persisted_pruned(persisted, |root| root != r"C:\deleted");

        assert_eq!(rebuilt.open.len(), 1, "the entry whose root no longer exists must be dropped");
        assert_eq!(rebuilt.open[0].id, "id-1");
        assert_eq!(rebuilt.active.as_deref(), Some("id-1"));
        eprintln!("from_persisted_pruned_drops_entries_whose_root_no_longer_exists PASSED");
    }

    #[test]
    fn from_persisted_pruned_falls_back_to_first_survivor_when_the_active_entry_was_pruned() {
        let persisted = PersistedRegistry {
            open: vec![
                PersistedProjectEntry { id: "id-1".to_string(), root: r"C:\proj-a".to_string() },
                PersistedProjectEntry { id: "id-2".to_string(), root: r"C:\deleted".to_string() },
            ],
            // The active entry (id-2) is the one that gets pruned below.
            active: Some("id-2".to_string()),
        };

        let rebuilt = RegistryInner::from_persisted_pruned(persisted, |root| root != r"C:\deleted");

        assert_eq!(rebuilt.open.len(), 1);
        assert_eq!(
            rebuilt.active.as_deref(),
            Some("id-1"),
            "must not leave open projects with no active one just because the previously-active entry was pruned"
        );
        eprintln!("from_persisted_pruned_falls_back_to_first_survivor_when_the_active_entry_was_pruned PASSED");
    }

    #[test]
    fn from_persisted_pruned_of_an_entirely_gone_registry_yields_empty_with_no_active() {
        let persisted = PersistedRegistry {
            open: vec![PersistedProjectEntry { id: "id-1".to_string(), root: r"C:\deleted".to_string() }],
            active: Some("id-1".to_string()),
        };

        let rebuilt = RegistryInner::from_persisted_pruned(persisted, |_root| false);

        assert!(rebuilt.open.is_empty());
        assert_eq!(rebuilt.active, None);
        eprintln!("from_persisted_pruned_of_an_entirely_gone_registry_yields_empty_with_no_active PASSED");
    }

    #[test]
    fn projects_registry_load_returns_none_when_file_absent() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("projects.json");
        let result = projects_registry_load_inner(&path).unwrap();
        assert_eq!(result, None);
        eprintln!("projects_registry_load_returns_none_when_file_absent PASSED");
    }

    #[test]
    fn projects_registry_save_then_load_roundtrips() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("projects.json");
        let registry = PersistedRegistry {
            open: vec![PersistedProjectEntry { id: "id-1".to_string(), root: r"C:\proj-a".to_string() }],
            active: Some("id-1".to_string()),
        };

        projects_registry_save_inner(&path, &registry).unwrap();
        let loaded = projects_registry_load_inner(&path).unwrap();

        assert_eq!(loaded, Some(registry));
        eprintln!("projects_registry_save_then_load_roundtrips PASSED");
    }

    #[test]
    fn projects_registry_save_creates_missing_parent_directory() {
        let tmp = TempDir::new().unwrap();
        let nested = tmp.path().join("does").join("not").join("exist").join("projects.json");
        let registry = PersistedRegistry::default();

        projects_registry_save_inner(&nested, &registry).unwrap();

        assert!(nested.exists());
        eprintln!("projects_registry_save_creates_missing_parent_directory PASSED");
    }

    #[test]
    fn projects_registry_save_never_leaves_a_tmp_file_behind_on_success() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("projects.json");

        projects_registry_save_inner(&path, &PersistedRegistry::default()).unwrap();

        assert!(!tmp.path().join("projects.json.tmp").exists());
        assert!(path.exists());
        eprintln!("projects_registry_save_never_leaves_a_tmp_file_behind_on_success PASSED");
    }

    #[test]
    fn projects_registry_save_overwrite_replaces_previous_content_atomically() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("projects.json");
        let first = PersistedRegistry {
            open: vec![PersistedProjectEntry { id: "id-1".to_string(), root: r"C:\a".to_string() }],
            active: Some("id-1".to_string()),
        };
        let second = PersistedRegistry {
            open: vec![PersistedProjectEntry { id: "id-2".to_string(), root: r"C:\b".to_string() }],
            active: Some("id-2".to_string()),
        };

        projects_registry_save_inner(&path, &first).unwrap();
        projects_registry_save_inner(&path, &second).unwrap();

        let loaded = projects_registry_load_inner(&path).unwrap();
        assert_eq!(loaded, Some(second));
        eprintln!("projects_registry_save_overwrite_replaces_previous_content_atomically PASSED");
    }

    #[test]
    fn projects_registry_load_of_malformed_json_is_an_honest_err() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("projects.json");
        fs::write(&path, b"not json at all").unwrap();

        let result = projects_registry_load_inner(&path);
        assert!(result.is_err(), "a corrupt projects.json must error, never silently look empty");
        eprintln!("projects_registry_load_of_malformed_json_is_an_honest_err PASSED");
    }
}
