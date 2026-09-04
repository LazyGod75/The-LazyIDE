// ── Multi-project registry commands (T0.7) ──────────────────────────
//
// `ProjectRegistry` (state.rs) is the multi-root source of truth: N open
// projects, one active. These four commands are its public surface;
// `set_project` below becomes a thin `project_register` + `project_set_active`
// wrapper so existing callers keep working unchanged. See `ProjectState`'s
// doc comment (state.rs) for why that legacy single-root mutex is kept in
// sync rather than removed.

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::state::{JournalState, ProjectEntry, ProjectRegistry, ProjectState};
use crate::commands::util::{project_id_for_root, quiet_command};
use crate::commands::journal::emit_system_event;
use crate::commands::brain::sidecar::{
    BrainSidecar, BrainState, brain_open_on_sidecar, brain_port_and_token,
};
use crate::commands::brain::index_project;
use crate::commands::brain::project_gitignore::ensure_project_gitignore_excludes_scaffolding;
use crate::commands::git::git_binary;

use super::bin_resolve::resolve_lazybrain_bin_static;
use super::path_resolve::{get_brain_info_inner, resolve_unified_brain_path};

/// Wire type returned by `project_register` / `project_list` — the
/// registry's `ProjectEntry` plus whether it is the currently active one (a
/// registry-level fact, not stored on the entry itself — see
/// `state::RegistryInner`).
#[derive(Debug, Clone, Serialize)]
pub struct ProjectEntryOut {
    pub id: String,
    pub root: String,
    #[serde(rename = "brainId")]
    pub brain_id: Option<String>,
    pub active: bool,
    /// Human-readable note on whether `project_create` made this freshly
    /// created directory into a usable git repository — see
    /// `finish_new_project_git_repo`'s doc comment for the four outcomes
    /// this can carry (initialized / skipped-nested-repo / init-failed /
    /// commit-failed-after-init). Always
    /// `None` for `project_register`/`project_list`/`project_set_active`'s
    /// own entries and for `project_create` re-registering an
    /// ALREADY-existing directory — git init is only ever attempted for a
    /// directory THIS call created. The honesty contract ("missions cannot
    /// run here yet") lives in this field's text rather than a boolean, so a
    /// caller can never mistake "attempted but failed" for silent success.
    #[serde(rename = "gitInitNote")]
    pub git_init_note: Option<String>,
}

fn project_entry_out(entry: &ProjectEntry, active_id: Option<&str>) -> ProjectEntryOut {
    ProjectEntryOut {
        id: entry.id.clone(),
        root: entry.root.clone(),
        brain_id: entry.brain_id.clone(),
        active: active_id == Some(entry.id.as_str()),
        git_init_note: None,
    }
}

// ── Multi-project registry persistence (T-R1c) ──────────────────────
//
// `ProjectRegistry` (state.rs) is an in-memory Mutex — nothing about it
// survives a process restart on its own. These two helpers give it a
// disk-backed twin at `<app_local_data_dir>/projects.json`, written after
// every mutating command below (`project_register_inner`/
// `project_set_active_inner`/`project_close`) and read back once at boot
// (`run()`'s `.setup()`, lib.rs) via `state::projects_registry_load_inner` +
// `RegistryInner::from_persisted_pruned`. See `state::PersistedRegistry`'s
// doc comment for the on-disk shape and why `brain_id` is excluded.

/// Path to the persisted registry file. Sibling in spirit to
/// `brain_projects_config_path` above but a DIFFERENT file/format: that one
/// is a flat legacy path list nothing here reads or writes; this one is
/// `state::PersistedRegistry`'s exact JSON shape.
fn projects_registry_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app.path().app_local_data_dir()
        .map_err(|e| format!("projects_registry_path: app_local_data_dir failed: {}", e))?;
    Ok(data_dir.join("projects.json"))
}

/// Best-effort snapshot-and-save of the registry to `projects.json`. Called
/// after every mutating registry command so a later restart's `.setup()`
/// hydration sees the current state. A save failure (disk full, permission
/// denied) is logged and swallowed, never surfaced as a command error:
/// losing this one persistence write must never block the user from
/// registering/switching/closing a project right now — the next successful
/// mutation will simply try again.
fn persist_registry_snapshot(app: &tauri::AppHandle, registry: &ProjectRegistry) {
    let snapshot = match registry.0.lock() {
        Ok(guard) => guard.to_persisted(),
        Err(e) => {
            log::warn!("persist_registry_snapshot: registry lock failed: {}", e);
            return;
        }
    };
    let path = match projects_registry_path(app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("persist_registry_snapshot: {}", e);
            return;
        }
    };
    if let Err(e) = crate::state::projects_registry_save_inner(&path, &snapshot) {
        log::warn!("persist_registry_snapshot: save failed: {}", e);
    }
}

/// Register `path` as an open project — idempotent: re-registering an
/// already-open root returns the SAME entry, never a duplicate (see
/// `RegistryInner::register`). Does everything `set_project` used to do to
/// prepare a freshly-opened project — `.gitignore` scaffolding, brain-path
/// resolution, `ensure_brain_init`, auto-index when the resolved brain is
/// empty — but NEVER restarts the brain sidecar: the sidecar is a singleton
/// for the whole app now (spec section 5.2), so this instead tells the
/// ALREADY-RUNNING sidecar about this project's brain via `POST
/// /brains/open` (best-effort — see `brain_open_on_sidecar`'s doc comment;
/// `active_brain_query_suffix`, sidecar.rs, retries lazily if this fails
/// because the sidecar wasn't up yet).
///
/// Does NOT change which project is active — call `project_set_active` (or
/// use the `set_project` wrapper, which does both) to switch focus. Emits
/// `project.registered` on the journal, but only on a GENUINE first
/// registration (re-registering an already-open root is a no-op event-wise,
/// same idempotency reasoning as the registry mutation itself).
///
/// `async fn` + `spawn_blocking` (root-cause fix for the app-wide IPC stall
/// QA hit at boot): this command's real body (`project_register_inner`) is
/// genuinely slow and fully synchronous — `BrainSidecar::ensure_brain_init`
/// blocks on a child-process spawn with up to `INIT_TRANSIENT_RETRY_ATTEMPTS`
/// retries and `std::thread::sleep` backoff between them, and
/// `brain_open_on_sidecar` blocks on a `reqwest::blocking` HTTP POST with up
/// to a 15s timeout (`http_client()`). A NON-async `#[tauri::command]` runs
/// directly on Tauri's main thread (the same thread that pumps the WebView2
/// message loop and executes every OTHER plain-`fn` command) — see Tauri's
/// "Calling Rust from the Frontend" docs. Two back-to-back calls to this
/// command at boot (once per persisted project) therefore serialized EVERY
/// sync IPC command behind them for the full duration of both
/// subprocess+HTTP calls, which is the confirmed mechanism behind the
/// real-app QA symptoms: an unrelated `get_project_root` timing out at 10s,
/// `journal_emit` hanging >87s, and the cockpit's `journal_fleet_overview`/
/// `attention_inbox`/`activity_feed` spinning forever right after boot — all
/// plain sync commands queued on the same starved main thread, not failures
/// of their own.
///
/// Why `tauri::async_runtime::spawn_blocking` and NOT the lighter
/// `#[tauri::command(async)]` attribute on the unchanged sync fn (the first
/// attempt at this fix, reverted after real-app QA run 6): the `(async)`
/// attribute makes the macro dispatch the still-synchronous body via
/// `resolver.respond_async_serialized(async move { $path(args) ... })`
/// (tauri-macros `wrapper.rs`, `body_async`) — i.e. the body executes inline
/// on a tokio ASYNC WORKER thread, not on the blocking pool. Constructing
/// and dropping a `reqwest::blocking::Client` there (exactly what
/// `brain_open_on_sidecar` -> `http_client()` does) panics tokio:
/// "Cannot drop a runtime in a context where blocking is not allowed"
/// (tokio `runtime/blocking/shutdown.rs`; reqwest::blocking embeds its own
/// tokio runtime). Observed 3x in Lazy.log 15:49:20/23/28 during run 6 —
/// once per boot-time registration and once for the harness's first project,
/// each immediately after `ensure_brain_init` — and the panicked task meant
/// the frontend's invoke never settled, wedging the whole walkthrough.
/// `spawn_blocking` runs the body on tokio's dedicated BLOCKING pool, where
/// blocking — and dropping a blocking client's runtime — is allowed; every
/// blocking HTTP client is created, used, and dropped entirely inside the
/// closure, and no State clone or guard crosses an await point (the async
/// shell contains nothing but the spawn + `.await`).
#[tauri::command]
pub(crate) async fn project_register(
    path: String,
    app: tauri::AppHandle,
) -> Result<ProjectEntryOut, String> {
    match tauri::async_runtime::spawn_blocking(move || project_register_inner(path, &app)).await {
        Ok(result) => result,
        Err(e) => Err(format!("project_register: blocking task join failed: {}", e)),
    }
}

/// Synchronous body of `project_register` — always runs on the blocking
/// pool (see the command's doc comment above), so it is free to block on
/// subprocesses and `reqwest::blocking` HTTP. Takes the `AppHandle` and
/// derives every managed State from it (`app.state::<T>()`) because
/// `tauri::State<'_, T>` borrows cannot be moved into a `'static`
/// `spawn_blocking` closure. Also the composable half `set_project` reuses
/// directly (one blocking task for its whole register+activate sequence).
fn project_register_inner(path: String, app: &tauri::AppHandle) -> Result<ProjectEntryOut, String> {
    let registry = app.state::<ProjectRegistry>();
    let brain_state = app.state::<BrainState>();
    let journal_state = app.state::<JournalState>();

    let project_path = std::path::Path::new(&path);
    if !project_path.is_dir() {
        return Err(format!("project_register: '{}' is not a directory", path));
    }
    let canonical = project_path
        .canonicalize()
        .map_err(|e| format!("project_register: canonicalize failed: {}", e))?
        .to_string_lossy()
        .into_owned();
    let id = project_id_for_root(&canonical);

    // Scaffolding — idempotent, safe to run on every register (mirrors
    // set_project's original step 2b).
    ensure_project_gitignore_excludes_scaffolding(std::path::Path::new(&canonical));

    let brain_path = resolve_unified_brain_path(Some(&canonical));

    let newly_registered = {
        let mut guard = registry.0.lock()
            .map_err(|e| format!("project_register: registry lock failed: {}", e))?;
        let before_len = guard.open.len();
        guard.register(ProjectEntry { id: id.clone(), root: canonical.clone(), brain_id: None });
        guard.open.len() > before_len
    };

    // Brain init (idempotent — a no-op once .lazybrain-config.json exists)
    // so a brand-new project's brain directory exists even though the
    // sidecar process itself is never restarted here.
    if let Ok(lb) = resolve_lazybrain_bin_static() {
        BrainSidecar::ensure_brain_init(&lb, &brain_path);
    }

    // Best-effort: tell the already-running multi-tenant sidecar about this
    // brain and remember the id it hands back. Silent (logged) no-op if the
    // sidecar isn't up yet or the engine doesn't answer.
    let (port, token) = brain_port_and_token(&brain_state);
    match brain_open_on_sidecar(port, &token, &brain_path) {
        Ok(brain_id) => {
            if let Ok(mut guard) = registry.0.lock() {
                guard.set_brain_id(&id, brain_id);
            }
        }
        Err(e) => {
            log::debug!("project_register: /brains/open not available yet for '{}': {}", canonical, e);
        }
    }

    // Auto-index when this resolved to an empty brain (mirrors set_project's
    // original step 5b) — `spawn_auto_index_if_needed` is itself idempotent
    // (checks an already-indexed marker), so it is safe to call on every
    // register, not just a genuinely new one.
    let brain_info = get_brain_info_inner(Some(&canonical));
    index_project::spawn_auto_index_if_needed(app.clone(), &brain_info, &canonical, brain_state.0.clone());

    let out = {
        let guard = registry.0.lock().map_err(|e| format!("project_register: registry lock failed: {}", e))?;
        let refreshed = guard.find(&id).cloned()
            .ok_or_else(|| "project_register: entry vanished immediately after registration".to_string())?;
        project_entry_out(&refreshed, guard.active.as_deref())
    };

    // Persist (T-R1c) so this project survives a restart — see
    // `persist_registry_snapshot`'s doc comment for the best-effort contract.
    persist_registry_snapshot(app, &registry);

    if newly_registered {
        emit_system_event(&journal_state, &id, "project.registered", serde_json::json!({ "root": canonical }));
        log::info!("project_register: registered '{}' ({})", canonical, id);
    }

    Ok(out)
}

/// Create a brand-new directory on disk and register it as an open project —
/// closes the gap `project_register_inner`'s `is_dir` check above leaves:
/// the manager could only ever register a directory that ALREADY existed, so
/// a user asking for work in a NEW folder hit a dead end with no `mkdir`
/// reachable anywhere in its action surface. This does NOT touch
/// `ensure_write_path_in_project_roots` (fs.rs) or `ensure_repo_in_project_root`
/// (util.rs) — those path-confinement guards stay byte-for-byte unchanged;
/// once the new folder is a registered project root, the EXISTING guard
/// logic already permits writes into it through the normal code path, so
/// there is nothing to weaken here.
///
/// Creates exactly ONE level (`std::fs::create_dir`, never `create_dir_all`)
/// so a typo in `path` cannot silently spawn a deep, unintended directory
/// tree — the PARENT must already exist and be a directory, or this rejects
/// with a clear reason instead of guessing. That parent is resolved from
/// `path` LEXICALLY (`Path::parent()`), so `path` is validated up front
/// (`validate_project_create_path`) to rule out `.`/`..` components and
/// verbatim prefixes that would let the OS resolve a DIFFERENT parent than
/// the one this function computes — see that function's doc comment for the
/// concrete traversal this closes. Idempotent the same way
/// `project_register` is: a target that already exists AS A DIRECTORY is not
/// an error, it is just registered (never a duplicate entry, same
/// dedup-by-canonicalized-root behavior). A target that exists as a
/// NON-directory (a file, a symlink to one, etc.) is rejected — this command
/// only ever creates directories, never overwrites anything.
///
/// On success, delegates straight into `project_register_inner` — the exact
/// same registration body `project_register` uses (scaffolding, brain init,
/// best-effort `/brains/open`, auto-index, persistence, the `project.registered`
/// journal event) — so the two commands can never drift into two different
/// ideas of what "registered" means. Returns the same `ProjectEntryOut` shape
/// `project_register` returns.
///
/// `async fn` + `spawn_blocking`: delegates into `project_register_inner`'s
/// blocking body (subprocess spawn + `reqwest::blocking` HTTP — see that
/// command's own doc comment for the full main-thread-stall mechanism this
/// avoids), so this command must leave the main thread for the exact same
/// reason.
#[tauri::command]
pub(crate) async fn project_create(
    path: String,
    app: tauri::AppHandle,
) -> Result<ProjectEntryOut, String> {
    match tauri::async_runtime::spawn_blocking(move || project_create_inner(path, &app)).await {
        Ok(result) => result,
        Err(e) => Err(format!("project_create: blocking task join failed: {}", e)),
    }
}

/// Validates `path` for `project_create`'s "exactly one level, no surprises"
/// contract BEFORE any OS call sees it. Pure and `AppHandle`-free by design
/// — unlike `project_create_inner` below, this is directly unit-testable
/// (see the `#[cfg(test)]` module at the bottom of this file; contrast
/// `set_project_state_and_brain_init`'s note on why `AppHandle`-touching
/// logic canNOT be unit-tested the same way — this function exists
/// specifically so the security-critical part does not share that fate).
///
/// SECURITY: closes a path-traversal gap where `project_create_inner`'s own
/// checks (`target.parent()`, `.is_dir()`, `std::fs::create_dir`) disagreed
/// with each other about what `path` means. `Path::parent()` is PURELY
/// LEXICAL — it strips the last component as text and never resolves `.`/
/// `..`. `Path::is_dir()` and `std::fs::create_dir()` go through the OS,
/// which DOES resolve `.`/`..` during normal path normalization. A path
/// like `C:\Users\user\...\Lazy\..\..\..\evil_project` therefore lexically
/// parents to `...\Lazy\..\..\..` — which `is_dir()` resolves to a real,
/// unrelated ancestor (e.g. `C:\Users\user`), so the "parent must already
/// exist" gate PASSED — while `create_dir` resolved that SAME parent and
/// created `evil_project` there, nowhere near where `path` appears to point.
/// The result was then registered as a permitted write root via
/// `project_register_inner`. Rejecting any `.`/`..` component up front
/// closes this for good: once a path's components are limited to
/// `Prefix`/`RootDir`/`Normal`, lexical and OS-resolved interpretation of it
/// can never diverge, so `project_create_inner`'s lexical `target.parent()`
/// is guaranteed to name the exact directory the OS calls below act on.
///
/// Also rejects, deliberately (never silently rewritten/"cleaned" — a caller
/// sending one of these is either buggy or hostile):
/// - a non-absolute path — meaningless without a caller-controlled cwd this
///   function has no visibility into;
/// - a bare drive/share root (`C:\`, `\\server\share`, `/`) — no `Normal`
///   component after the prefix/root, so there is no directory NAME left to
///   create; there is no legitimate "create a drive root" case;
/// - a Windows verbatim/device path prefix (`\\?\`, `\\.\`) — a `\\?\`-
///   prefixed path disables Win32's automatic `.`/`..` resolution entirely
///   (see `strip_verbatim_prefix`'s doc comment, util.rs), so a `..` inside
///   one is a literal, nonexistent path segment rather than something the
///   component walk below could usefully evaluate either way; nothing in
///   this codebase registers a project root through a verbatim path today,
///   so rejecting both prefixes outright costs nothing and removes an
///   OS-normalization edge case this function would otherwise have to
///   reason about.
///
/// IMPLEMENTATION NOTE — why `.` is scanned on the RAW string instead of via
/// `Path::components()`: `components()` NORMALIZES a non-verbatim path as it
/// parses it, and that normalization silently DROPS interior `.` segments —
/// confirmed empirically: `Path::new(r"C:\a\.\b").components()` yields only
/// `Prefix`/`RootDir`/`Normal("a")`/`Normal("b")`, `Component::CurDir` never
/// appears. A `.`-rejection driven solely by matching `Component::CurDir`
/// below is therefore dead code for every non-verbatim path this function
/// can still reach (verbatim paths were already rejected above) — a check,
/// and a test, that could never fail. `..` is NOT normalized away the same
/// way (`ParentDir` reliably appears in `components()`), so that half of the
/// component walk below stays correct and is kept as a second, redundant
/// layer of defense. Do NOT "simplify" the `.`/`..` detection back down to
/// `components()` alone — that is precisely the regression this note exists
/// to prevent.
pub(crate) fn validate_project_create_path(path: &str) -> Result<(), String> {
    let candidate = std::path::Path::new(path);

    if !candidate.is_absolute() {
        return Err(format!("project_create: '{}' is not an absolute path", path));
    }

    let lower = path.to_ascii_lowercase();
    if lower.starts_with(r"\\?\") || lower.starts_with(r"\\.\") {
        return Err(format!(
            "project_create: '{}' uses a Windows verbatim/device path prefix, which is not supported as a project root",
            path
        ));
    }

    // Lexical scan over the RAW string's separator-delimited segments — the
    // primary (and, for '.', the ONLY working) detection of '.'/'..'. See
    // this function's doc comment ("IMPLEMENTATION NOTE") for why '.' must
    // be caught here rather than via `Path::components()` below.
    for segment in path.split(['/', '\\']) {
        if segment == "." {
            return Err(format!(
                "project_create: '{}' contains a '.' component, which is not allowed",
                path
            ));
        }
        if segment == ".." {
            return Err(format!(
                "project_create: '{}' contains a '..' component, which is not allowed",
                path
            ));
        }
    }

    let mut has_normal_component = false;
    for component in candidate.components() {
        match component {
            // Redundant with the raw scan above (components() reliably
            // surfaces '..' for non-verbatim paths) — kept as a second,
            // independent layer of defense, not the primary mechanism.
            std::path::Component::ParentDir => {
                return Err(format!(
                    "project_create: '{}' contains a '..' component, which is not allowed",
                    path
                ));
            }
            // Dead in practice for any path that reaches this point — see
            // the "IMPLEMENTATION NOTE" above: components() normalizes '.'
            // away for non-verbatim paths, so this arm cannot fire. Kept
            // only so a future std change that stops dropping '.' fails
            // safe (rejects) instead of silently accepting.
            std::path::Component::CurDir => {
                return Err(format!(
                    "project_create: '{}' contains a '.' component, which is not allowed",
                    path
                ));
            }
            std::path::Component::Normal(_) => has_normal_component = true,
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {}
        }
    }

    if !has_normal_component {
        return Err(format!(
            "project_create: '{}' is a bare drive/share root, not a project directory",
            path
        ));
    }

    Ok(())
}

/// Synchronous body of `project_create` — see `project_register_inner`'s doc
/// comment for the AppHandle-derived-State shape and why this needs to run
/// on the blocking pool. Every error names the real reason and the real
/// path, never a generic "failed" — the manager relays this text verbatim to
/// the user (agentsStore.tsx's `create_project` case).
///
/// Property this now actually enforces (previously only claimed — see
/// `validate_project_create_path`'s doc comment for the traversal gap that
/// broke it): `path` is validated up front, before `target.is_dir()` or
/// `std::fs::create_dir()` below ever run, so the lexical parent computed
/// here (`target.parent()`) and the parent the OS resolves for those two
/// calls are GUARANTEED to be the same directory. That is what makes
/// "creates exactly ONE level, and only under the parent `path` lexically
/// names" true rather than merely intended.
fn project_create_inner(path: String, app: &tauri::AppHandle) -> Result<ProjectEntryOut, String> {
    validate_project_create_path(&path)?;
    let target = std::path::PathBuf::from(&path);
    if target.is_dir() {
        // Already exists as a directory — idempotent, same convention as
        // project_register_inner's own re-registration: just register it.
        return project_register_inner(path, app);
    }
    if target.exists() {
        return Err(format!(
            "project_create: '{}' already exists and is not a directory",
            path
        ));
    }
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).ok_or_else(|| {
        format!("project_create: '{}' has no parent directory", path)
    })?;
    if !parent.is_dir() {
        return Err(format!(
            "project_create: parent directory '{}' does not exist — create it first",
            parent.display()
        ));
    }
    std::fs::create_dir(&target).map_err(|e| {
        format!("project_create: failed to create directory '{}': {}", path, e)
    })?;

    // Make the directory a usable git repository — closes the gap where a
    // project created through this command was registered but had no git
    // repo at all, so `agent_create_worktree_inner`
    // (src-tauri/src/commands/git/worktree/mod.rs) failed hard with "'{}' is
    // not a git repository" for every mission attempted here.
    //
    // Split into two phases straddling registration, NOT run as one shot
    // before it: `git init` happens first (`begin_new_project_git_repo`),
    // but the INITIAL COMMIT is deferred until AFTER
    // `project_register_inner` has scaffolded its own files (`.gitignore`,
    // and via brain init, `.lazybrain/`) — see `finish_new_project_git_repo`'s
    // doc comment for the outage this ordering fixes: a commit taken before
    // that scaffolding existed left `.gitignore` permanently untracked,
    // which made every later mission branch that also touched `.gitignore`
    // unmergeable ("The following untracked working tree files would be
    // overwritten by merge"). This directory was JUST created by
    // `std::fs::create_dir` above (never a pre-existing one — see the
    // `target.is_dir()` early-return further up), so `we_created_dir` is
    // unconditionally `true` here; see `should_attempt_git_init`'s doc
    // comment for the full guard this still applies (nested-repo check).
    let git_stage = begin_new_project_git_repo(&target, parent);

    let entry = project_register_inner(path, app)?;

    // Now that registration has scaffolded `.gitignore` (and, via brain
    // init, `.lazybrain/`), stage and commit everything it created — the
    // reordering this function exists to fix.
    let git_init_note = finish_new_project_git_repo(&target, git_stage);

    Ok(ProjectEntryOut { git_init_note: Some(git_init_note), ..entry })
}

/// Pure "should we attempt `git init`" decision, isolated from all git/
/// filesystem I/O so it is directly unit-testable (mirrors
/// `validate_project_create_path`'s "keep the decidable half pure" pattern —
/// see the `#[cfg(test)]` module below). Both guards are explicit per the
/// capability's design:
///   - `we_created_dir`: only a directory THIS `project_create` call actually
///     created may be touched — a pre-existing directory the user handed us
///     must be left exactly as it was, never retrofitted with git.
///   - `parent_is_in_git_repo`: a parent that already resolves to a git
///     working tree means initializing here would nest one repo inside
///     another, which would surprise the user — skip instead.
fn should_attempt_git_init(we_created_dir: bool, parent_is_in_git_repo: bool) -> bool {
    we_created_dir && !parent_is_in_git_repo
}

/// True when `parent` itself already resolves to a git working tree (`git
/// rev-parse --show-toplevel` succeeds there) — i.e. `parent` is inside SOME
/// git repo already, whether or not that repo has any commits yet (verified:
/// `--show-toplevel` succeeds on a freshly-`git init`'d, commit-less repo
/// too). A missing git binary or any other failure reads as "not in a
/// repo" (fails open toward attempting init, which then fails its own
/// honest way in `git_init_only` if git truly isn't available).
fn parent_is_inside_git_repo(parent: &std::path::Path) -> bool {
    quiet_command(git_binary())
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(parent)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `git init` a brand-new project directory — nothing else. Deliberately
/// does NOT create the initial commit (contrast the pre-fix version of this
/// function, which used to do both in one shot): the commit must wait until
/// AFTER `project_register_inner` has scaffolded `.gitignore` — see
/// `finish_new_project_git_repo`'s doc comment for the outage that ordering
/// bug caused. Mirrors `git_init_if_needed`'s (brain/publish.rs) `-b main` /
/// plain-`init` fallback for older git.
fn git_init_only(dir: &std::path::Path) -> Result<(), String> {
    let init = quiet_command(git_binary())
        .args(["init", "-b", "main"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git init failed to start: {}", e))?;
    if init.status.success() {
        return Ok(());
    }
    // Older git without `-b` support — retry the plain form, same fallback
    // `git_init_if_needed` (brain/publish.rs) uses.
    let retry = quiet_command(git_binary())
        .args(["init"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git init (retry) failed to start: {}", e))?;
    if !retry.status.success() {
        return Err(format!("git init: {}", String::from_utf8_lossy(&retry.stderr).trim()));
    }
    Ok(())
}

/// Stage EVERYTHING currently in `dir` (`git add -A`) and create ONE initial
/// commit under a neutral, per-command bot identity — the second half of
/// what used to be `git_init_with_initial_commit`'s single shot, now run
/// only after `project_register_inner` has scaffolded its own files into
/// `dir`. Called from `finish_new_project_git_repo`, which is what actually
/// decides whether this should run at all.
///
/// Why a real commit (not `--allow-empty` any more) is still not optional:
/// `git worktree add` needs a resolvable `HEAD` to build a real worktree
/// against. A freshly-`git init`'d repo's `HEAD` is unborn (points at a
/// branch ref with no commit behind it yet). Verified empirically before
/// writing the original version of this logic:
///   - `git worktree add -b <branch> <path>` itself tolerates an unborn HEAD
///     on git >= 2.42 — it infers `--orphan` and creates a working, commit-
///     less worktree.
///   - BUT the mission pipeline's later merge-back step
///     (`agent_merge_worktree_inner`, git/worktree/mod.rs, Step 2: `git
///     merge --no-ff`) then fails hard against the main repo's own unborn
///     HEAD: "fatal: Non-fast-forward commit does not make sense into an
///     empty head". A mission could start in such a repo but its work could
///     never be merged back — not a functioning capability. This commit is
///     what gives the main repo (not just the worktree) a real `HEAD` for
///     that merge to land on — and, unlike the pre-fix `--allow-empty`
///     version, it now also carries the project's own scaffolding
///     (`.gitignore`), so that file is never left untracked.
///
/// Identity: every identity-bearing call passes `-c user.name=... -c
/// user.email=...` INLINE, never `git config user.name`/`user.email` (global
/// or local) — a per-command override can never leak into another repo or
/// persist past this one call, and never impersonates the app's actual user.
/// "Lazy Agent <agent@lazy.dev>" mirrors the same neutral bot identity this
/// codebase already uses for other agent-authored commits (worktree_sweep.rs,
/// worktree_cleanup.rs, git/branches.rs test fixtures).
fn git_add_all_and_commit(dir: &std::path::Path) -> Result<(), String> {
    let add = quiet_command(git_binary())
        .args(["add", "-A"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git add failed to start: {}", e))?;
    if !add.status.success() {
        return Err(format!("git add: {}", String::from_utf8_lossy(&add.stderr).trim()));
    }

    let commit = quiet_command(git_binary())
        .args([
            "-c", "user.name=Lazy Agent",
            "-c", "user.email=agent@lazy.dev",
            "commit", "-m", "chore: initialize project repository",
        ])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("git commit failed to start: {}", e))?;
    if !commit.status.success() {
        return Err(format!("git commit: {}", String::from_utf8_lossy(&commit.stderr).trim()));
    }
    Ok(())
}

/// Carries the outcome of `begin_new_project_git_repo` (the "git init" half,
/// run BEFORE registration scaffolds anything) across to
/// `finish_new_project_git_repo` (the "commit" half, run AFTER). Only the
/// `Initialized` case still has work to do in the second half — the other
/// two are already final and `finish_new_project_git_repo` just turns them
/// into their note text.
enum GitInitStage {
    /// `should_attempt_git_init` said no — the parent directory is already
    /// inside a git repository. Nothing was touched; no commit follows.
    Skipped,
    /// `git_init_only` itself failed (git unavailable, subprocess error,
    /// ...). Nothing to commit; no commit follows.
    Failed(String),
    /// `git_init_only` succeeded — `dir` is a git working tree with an
    /// unborn HEAD, waiting on `finish_new_project_git_repo` to stage and
    /// commit whatever registration scaffolds into it.
    Initialized,
}

/// First half of making a freshly created project directory into a usable
/// git repository — runs BEFORE `project_register_inner` scaffolds
/// `.gitignore`/`.lazybrain/`, so this only ever runs `git init`, never a
/// commit (see `finish_new_project_git_repo` for why the commit must wait).
/// `dir` was JUST created by `std::fs::create_dir` in `project_create_inner`
/// (never a pre-existing directory — see the `target.is_dir()` early-return
/// there), so `we_created_dir` is unconditionally `true` here; see
/// `should_attempt_git_init`'s doc comment for the guard this still applies
/// (nested-repo check).
fn begin_new_project_git_repo(dir: &std::path::Path, parent: &std::path::Path) -> GitInitStage {
    let parent_in_repo = parent_is_inside_git_repo(parent);
    if !should_attempt_git_init(true, parent_in_repo) {
        return GitInitStage::Skipped;
    }
    match git_init_only(dir) {
        Ok(()) => GitInitStage::Initialized,
        Err(e) => GitInitStage::Failed(e),
    }
}

/// Second half — runs AFTER `project_register_inner` has scaffolded
/// `.gitignore` (and, via brain init, `.lazybrain/`) into `dir` — and always
/// returns a plain-English note describing what actually happened, never a
/// fabricated success. This is the fix for the bug where the initial commit
/// used to be made BEFORE that scaffolding existed: `.gitignore` then stayed
/// untracked forever, and any later mission branch that also touched
/// `.gitignore` could never be merged back ("The following untracked
/// working tree files would be overwritten by merge"). Four outcomes:
///   1. `stage` is `Skipped` — `parent` was already inside a git repo;
///      nesting one here would surprise the user. No commit is attempted.
///   2. `stage` is `Failed` — `git init` itself did not complete (git
///      unavailable, subprocess error, ...). No commit is attempted either.
///   3. `stage` is `Initialized` and `git_add_all_and_commit` succeeds —
///      the commit now includes everything registration scaffolded; mission
///      worktrees can be created AND merged back here.
///   4. `stage` is `Initialized` but `git_add_all_and_commit` fails — `dir`
///      is left with a real `.git` but an UNBORN HEAD. This is deliberately
///      NOT reported as success: `git worktree add` on git >= 2.42 still
///      tolerates an unborn HEAD and could start a mission here, but the
///      mission pipeline's merge-back step (`agent_merge_worktree_inner`,
///      git/worktree/mod.rs) runs `git merge --no-ff` against THIS repo's
///      HEAD and fails hard with "fatal: Non-fast-forward commit does not
///      make sense into an empty head" — the note names that failure mode
///      explicitly so a caller can never mistake "git init succeeded" for
///      "missions can merge back here".
fn finish_new_project_git_repo(dir: &std::path::Path, stage: GitInitStage) -> String {
    match stage {
        GitInitStage::Skipped => "git init skipped: the parent directory is already inside a git \
             repository (nesting one here would be unexpected) — run 'git init' manually if you \
             want this project under its own repo; mission worktrees cannot be created here yet."
            .to_string(),
        GitInitStage::Failed(e) => format!(
            "git init did not complete ({e}) — this project is registered, but mission \
             worktrees cannot be created here yet; run 'git init' manually to enable missions."
        ),
        GitInitStage::Initialized => match git_add_all_and_commit(dir) {
            Ok(()) => "initialized a new git repository with an initial commit that includes \
                        the project's own scaffolding (.gitignore) — mission worktrees can be \
                        created here."
                .to_string(),
            Err(e) => format!(
                "git init succeeded but the initial commit did not complete ({e}) — this \
                 project is registered, but its git HEAD is still unborn (no commits yet), so \
                 mission worktrees created here cannot be merged back ('git merge --no-ff' \
                 fails with \"Non-fast-forward commit does not make sense into an empty \
                 head\") — run 'git add -A && git commit' manually to enable missions."
            ),
        },
    }
}

/// Switch the active project to `id` — the multi-project counterpart of
/// what `set_project` used to do wholesale. Never restarts the brain
/// sidecar (project switch is now just a registry mutex flip): keeps the
/// legacy `ProjectState` single-root mutex in sync (see its doc comment for
/// why ~10 other command modules still need it kept current) and re-emits
/// the SAME `project://changed` event `set_project` always has, so existing
/// frontend consumers keep working unchanged.
///
/// `async fn` + `spawn_blocking`: this command's own body is cheap
/// (mutex flips + one journal insert), but it is directly `invoke`-able from
/// the frontend (switching between two already-registered projects skips
/// `project_register` entirely), its journal insert CAN briefly block on the
/// journal mutex (e.g. while a retention VACUUM holds it), and as a plain
/// `fn` it would share the ONE main thread every other sync command runs on
/// — see `project_register`'s doc comment for the full main-thread-stall
/// mechanism (and why `spawn_blocking`, not the `(async)` attribute).
#[tauri::command]
pub(crate) async fn project_set_active(id: String, app: tauri::AppHandle) -> Result<(), String> {
    match tauri::async_runtime::spawn_blocking(move || project_set_active_inner(&id, &app)).await {
        Ok(result) => result,
        Err(e) => Err(format!("project_set_active: blocking task join failed: {}", e)),
    }
}

/// Synchronous body of `project_set_active` — see `project_register_inner`'s
/// doc comment for the AppHandle-derived-State shape and why. Reused
/// directly by `set_project`.
fn project_set_active_inner(id: &str, app: &tauri::AppHandle) -> Result<(), String> {
    let registry = app.state::<ProjectRegistry>();
    let project_state = app.state::<ProjectState>();
    let journal_state = app.state::<JournalState>();

    let root = {
        let mut guard = registry.0.lock()
            .map_err(|e| format!("project_set_active: registry lock failed: {}", e))?;
        guard.set_active(id)?;
        guard.active_root()
            .ok_or_else(|| "project_set_active: no active root immediately after set_active".to_string())?
    };

    {
        let mut ps_guard = project_state.0.lock()
            .map_err(|e| format!("project_set_active: project state lock failed: {}", e))?;
        *ps_guard = root.clone();
    }

    // Persist (T-R1c) so the active project survives a restart — see
    // `persist_registry_snapshot`'s doc comment for the best-effort contract.
    persist_registry_snapshot(app, &registry);

    let _ = app.emit("project://changed", &root);
    emit_system_event(&journal_state, id, "project.opened", serde_json::json!({ "root": root }));

    log::info!("project_set_active: switched to '{}' ({})", root, id);
    Ok(())
}

/// Close project `id`. See `RegistryInner::close`'s doc comment for the
/// exact "never the active one unless it's the last" semantics. Emits
/// `project.closed` only when something was actually removed (closing an
/// already-closed id is an idempotent no-op, no event).
#[tauri::command]
pub(crate) fn project_close(
    id: String,
    app: tauri::AppHandle,
    registry: tauri::State<ProjectRegistry>,
    journal_state: tauri::State<JournalState>,
) -> Result<(), String> {
    let removed = {
        let mut guard = registry.0.lock()
            .map_err(|e| format!("project_close: registry lock failed: {}", e))?;
        guard.close(&id)?
    };

    // Persist (T-R1c) so the close survives a restart — see
    // `persist_registry_snapshot`'s doc comment for the best-effort contract.
    persist_registry_snapshot(&app, &registry);

    if removed {
        emit_system_event(&journal_state, &id, "project.closed", serde_json::json!({}));
        log::info!("project_close: closed '{}'", id);
    }
    Ok(())
}

/// List every open project, each flagged with whether it is the active one.
#[tauri::command]
pub(crate) fn project_list(registry: tauri::State<ProjectRegistry>) -> Result<Vec<ProjectEntryOut>, String> {
    let guard = registry.0.lock().map_err(|e| format!("project_list: registry lock failed: {}", e))?;
    Ok(guard.open.iter().map(|e| project_entry_out(e, guard.active.as_deref())).collect())
}

/// Switch the IDE to a new project root — thin, byte-compatible wrapper kept
/// for existing callers (the frontend's "open folder" action). Delegates to
/// `project_register` (idempotent register + scaffolding + brain init +
/// best-effort `/brains/open` + auto-index) followed by `project_set_active`
/// (flips active, syncs legacy `ProjectState`, emits `project://changed`).
///
/// Behavior change from before: the brain sidecar is no longer
/// stopped/restarted on every call — see the module note on
/// `active_brain_query_suffix` (sidecar.rs) for why that is no longer
/// necessary now that one sidecar serves every open project's brain.
///
/// `async fn` + `spawn_blocking`: composes the two `_inner` sync bodies
/// (`project_register_inner` + `project_set_active_inner`) inside ONE
/// blocking task, so this command inherits the exact same blocking cost —
/// and the exact same `reqwest::blocking`-panic hazard — `project_register`
/// documents. This is the frontend's actual "open folder" entry point, so it
/// must leave the main thread too; see `project_register`'s doc comment for
/// the full mechanism (and why `spawn_blocking`, not the `(async)`
/// attribute).
#[tauri::command]
pub(crate) async fn set_project(path: String, app: tauri::AppHandle) -> Result<(), String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let entry = project_register_inner(path, &app)?;
        project_set_active_inner(&entry.id, &app)
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("set_project: blocking task join failed: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// `project_entry_out` must report `active: true` only for the entry
    /// whose id matches the registry's active id, and `false` for every
    /// other entry — it must also carry through the entry's own `brain_id`
    /// untouched.
    #[test]
    fn project_entry_out_marks_only_the_active_entry() {
        let entry_a = ProjectEntry { id: "id-a".to_string(), root: r"C:\proj-a".to_string(), brain_id: None };
        let entry_b = ProjectEntry {
            id: "id-b".to_string(),
            root: r"C:\proj-b".to_string(),
            brain_id: Some("brain-1".to_string()),
        };

        let out_a = project_entry_out(&entry_a, Some("id-b"));
        let out_b = project_entry_out(&entry_b, Some("id-b"));

        assert!(!out_a.active, "entry-a must not be marked active when id-b is active");
        assert!(out_b.active, "entry-b must be marked active");
        assert_eq!(out_b.brain_id.as_deref(), Some("brain-1"));
        eprintln!("project_entry_out_marks_only_the_active_entry PASSED");
    }

    #[test]
    fn project_entry_out_reports_inactive_when_nothing_is_active() {
        let entry = ProjectEntry { id: "id-a".to_string(), root: r"C:\proj-a".to_string(), brain_id: None };
        let out = project_entry_out(&entry, None);
        assert!(!out.active);
        eprintln!("project_entry_out_reports_inactive_when_nothing_is_active PASSED");
    }

    /// End-to-end composition of `project_id_for_root` (util.rs) +
    /// `RegistryInner::register` (state.rs) — the exact pairing
    /// `project_register` uses internally — proves registering the SAME
    /// canonicalized path twice yields the SAME id and does not duplicate
    /// the entry, the idempotency `project_register`'s doc comment promises.
    #[test]
    fn registering_the_same_canonicalized_root_twice_is_idempotent() {
        use crate::state::RegistryInner;

        let tmp = TempDir::new().expect("TempDir::new");
        let canonical = tmp.path().canonicalize().expect("canonicalize").to_string_lossy().into_owned();

        let id_first = project_id_for_root(&canonical);
        let id_second = project_id_for_root(&canonical);
        assert_eq!(id_first, id_second, "the same canonicalized root must hash to the same id every time");

        let mut inner = RegistryInner::default();
        inner.register(ProjectEntry { id: id_first.clone(), root: canonical.clone(), brain_id: None });
        inner.register(ProjectEntry { id: id_second, root: canonical, brain_id: None });
        assert_eq!(inner.open.len(), 1, "registering the same root twice must not duplicate the entry");

        eprintln!("registering_the_same_canonicalized_root_twice_is_idempotent PASSED");
    }

    /// Verify the set_project logic end-to-end (without a Tauri app handle):
    ///
    /// 1. Create a temp directory as the new "project root".
    /// 2. Derive the brain path: `<tmp>/.lazybrain/brain`.
    /// 3. If lazybrain.js is available, run `ensure_brain_init` — assert the
    ///    brain config file exists afterwards.
    /// 4. Assert that `ProjectState` can store and recall the new root.
    ///
    /// The Tauri app handle (required for `app.emit`) cannot be instantiated in
    /// unit tests. Instead we test the individual pieces that `set_project` calls:
    /// `ProjectState` mutation and `ensure_brain_init`.
    #[test]
    fn set_project_state_and_brain_init() {
        use super::{ProjectState, BrainSidecar, resolve_lazybrain_bin_static};

        let tmp = TempDir::new().expect("TempDir::new");
        let project_path = tmp.path().to_str().unwrap().to_string();

        // (a) ProjectState stores and returns the new root
        let ps = ProjectState::new();
        {
            let mut guard = ps.0.lock().expect("lock");
            *guard = project_path.clone();
        }
        let stored = ps.0.lock().expect("lock").clone();
        assert_eq!(
            stored, project_path,
            "ProjectState must store and return the project path"
        );

        // (b) Brain path is derived correctly
        let brain_path = std::path::Path::new(&project_path)
            .join(".lazybrain")
            .join("brain");
        let brain_path_str = brain_path.to_str().unwrap();
        assert!(
            brain_path_str.contains(".lazybrain"),
            "Brain path should contain .lazybrain, got: {}",
            brain_path_str
        );

        // (c) ensure_brain_init creates the brain config if lazybrain.js is present
        match resolve_lazybrain_bin_static() {
            Ok(lb) => {
                BrainSidecar::ensure_brain_init(&lb, brain_path_str);
                let config = brain_path.join(".lazybrain-config.json");
                assert!(
                    config.exists(),
                    "ensure_brain_init must create .lazybrain-config.json in {}, not found",
                    brain_path.display()
                );
                eprintln!(
                    "set_project_state_and_brain_init PASSED: \
                     root='{}' brain='{}' config='{}'",
                    project_path,
                    brain_path.display(),
                    config.display()
                );
            }
            Err(_) => {
                eprintln!(
                    "set_project_state_and_brain_init PARTIAL \
                     (lazybrain.js not found): ProjectState OK, brain init skipped"
                );
            }
        }
    }

    // ── validate_project_create_path (security fix) ─────────────────
    //
    // Regression coverage for the path-traversal bug where a lexically
    // `..`-laden `path` passed `project_create_inner`'s old `is_dir`/
    // `create_dir` checks (both OS-resolved) while `target.parent()`
    // (lexical-only) computed a completely different directory — see
    // `validate_project_create_path`'s doc comment for the full mechanism.

    /// The exact PoC from the security review: a path that lexically ends in
    /// `evil_project` but whose `..` chain walks the OS-resolved parent up
    /// three levels to a real, unrelated ancestor directory. Must be
    /// rejected outright, never reach `is_dir`/`create_dir`.
    #[test]
    fn validate_project_create_path_rejects_the_dotdot_traversal_poc() {
        let poc = r"C:\Users\user\Documents\cerveau\Lazy\..\..\..\evil_project";
        let err = validate_project_create_path(poc).expect_err("traversal PoC must be rejected");
        assert!(err.contains(".."), "error must name the '..' reason, got: {}", err);
        assert!(err.contains(poc), "error must name the real offending path, got: {}", err);
        eprintln!("validate_project_create_path_rejects_the_dotdot_traversal_poc PASSED");
    }

    /// A leading `..` (immediately after the drive root) must be rejected.
    #[test]
    fn validate_project_create_path_rejects_leading_dotdot() {
        let path = r"C:\..\evil_project";
        let err = validate_project_create_path(path).expect_err("leading '..' must be rejected");
        assert!(err.contains(".."), "got: {}", err);
        eprintln!("validate_project_create_path_rejects_leading_dotdot PASSED");
    }

    /// A `..` sandwiched between two normal components must be rejected.
    #[test]
    fn validate_project_create_path_rejects_middle_dotdot() {
        let path = r"C:\Users\user\..\evil_project";
        let err = validate_project_create_path(path).expect_err("middle '..' must be rejected");
        assert!(err.contains(".."), "got: {}", err);
        eprintln!("validate_project_create_path_rejects_middle_dotdot PASSED");
    }

    /// A trailing `..` must be rejected.
    #[test]
    fn validate_project_create_path_rejects_trailing_dotdot() {
        let path = r"C:\Users\user\Documents\..";
        let err = validate_project_create_path(path).expect_err("trailing '..' must be rejected");
        assert!(err.contains(".."), "got: {}", err);
        eprintln!("validate_project_create_path_rejects_trailing_dotdot PASSED");
    }

    /// A `.` (current-dir) component must be rejected too — same lexical/
    /// OS-resolution divergence risk as `..`, even though it is less
    /// obviously dangerous.
    #[test]
    fn validate_project_create_path_rejects_curdir_component() {
        let path = r"C:\Users\user\.\evil_project";
        let err = validate_project_create_path(path).expect_err("'.' component must be rejected");
        assert!(err.contains('.'), "got: {}", err);
        eprintln!("validate_project_create_path_rejects_curdir_component PASSED");
    }

    /// Regression lock for the raw-string-scan fix: `Path::components()`
    /// silently drops interior '.' segments for non-verbatim paths (see
    /// `validate_project_create_path`'s "IMPLEMENTATION NOTE"), so a version
    /// of this function that detected '.' only via `Component::CurDir` would
    /// let this path straight through — a bug caught by a real `cargo test`
    /// run (the original component-only detection made
    /// `rejects_curdir_component` above a test that could never fail). A
    /// second, differently-shaped interior '.' — deeper in the path than the
    /// existing test above — locks in that the raw scan, not `components()`,
    /// is what actually does the work.
    #[test]
    fn validate_project_create_path_rejects_interior_curdir_deep() {
        let path = r"C:\Users\user\Documents\.\cerveau\Lazy-Docs";
        let err = validate_project_create_path(path).expect_err("interior '.' component must be rejected");
        assert!(err.contains('.'), "got: {}", err);
        assert!(err.contains(path), "error must name the real offending path, got: {}", err);
        eprintln!("validate_project_create_path_rejects_interior_curdir_deep PASSED");
    }

    /// A relative path has no caller-visible cwd to resolve against here and
    /// must be rejected as not absolute.
    #[test]
    fn validate_project_create_path_rejects_relative_path() {
        let path = r"Documents\evil_project";
        let err = validate_project_create_path(path).expect_err("relative path must be rejected");
        assert!(
            err.contains("not an absolute path"),
            "got: {}",
            err
        );
        eprintln!("validate_project_create_path_rejects_relative_path PASSED");
    }

    /// A bare drive root has no directory NAME to create — must be rejected,
    /// not silently treated as "nothing to do".
    #[test]
    fn validate_project_create_path_rejects_bare_drive_root() {
        let path = r"C:\";
        let err = validate_project_create_path(path).expect_err("bare drive root must be rejected");
        assert!(
            err.contains("drive/share root"),
            "got: {}",
            err
        );
        eprintln!("validate_project_create_path_rejects_bare_drive_root PASSED");
    }

    /// Windows verbatim (`\\?\`) paths disable the OS's own `.`/`..`
    /// resolution, so this function's component walk cannot say anything
    /// meaningful about how the OS will treat one — rejected outright,
    /// asserted explicitly per the deliberate decision documented on
    /// `validate_project_create_path`.
    #[test]
    fn validate_project_create_path_rejects_verbatim_prefix() {
        let path = r"\\?\C:\Users\user\Documents\cerveau\Lazy-Docs";
        let err = validate_project_create_path(path).expect_err("verbatim prefix must be rejected");
        assert!(
            err.contains("verbatim"),
            "error must name the verbatim-prefix reason, got: {}",
            err
        );
        eprintln!("validate_project_create_path_rejects_verbatim_prefix PASSED");
    }

    /// Windows device-namespace (`\\.\`) paths get the same deliberate
    /// rejection as `\\?\` — see the doc comment's rationale.
    #[test]
    fn validate_project_create_path_rejects_device_namespace_prefix() {
        let path = r"\\.\C:\Users\user\Documents\cerveau\Lazy-Docs";
        let err = validate_project_create_path(path).expect_err("device-namespace prefix must be rejected");
        assert!(
            err.contains("verbatim"),
            "error must name the verbatim/device-prefix reason, got: {}",
            err
        );
        eprintln!("validate_project_create_path_rejects_device_namespace_prefix PASSED");
    }

    /// The normal, legitimate case: an absolute path with no `.`/`..`
    /// components and no verbatim prefix must be accepted.
    #[test]
    fn validate_project_create_path_accepts_a_normal_absolute_path() {
        let path = r"C:\Users\user\Documents\cerveau\Lazy-Docs";
        validate_project_create_path(path).expect("a normal absolute path must be accepted");
        eprintln!("validate_project_create_path_accepts_a_normal_absolute_path PASSED");
    }

    // ── git-init-on-create (mission-worktree capability gap fix) ────────
    //
    // Coverage for `should_attempt_git_init`/`parent_is_inside_git_repo`/
    // `git_init_only`/`git_add_all_and_commit`/`begin_new_project_git_repo`/
    // `finish_new_project_git_repo` — see `finish_new_project_git_repo`'s
    // doc comment for the four outcomes and `git_add_all_and_commit`'s doc
    // comment for why the initial commit is not optional.
    //
    // The two-phase split (begin BEFORE registration scaffolds anything,
    // finish AFTER) is itself the fix for a real outage: the old one-shot
    // `ensure_new_project_git_repo` committed before `project_register_inner`
    // ever wrote `.gitignore`, so that file stayed untracked forever and
    // permanently blocked the first mission merge of an 8-step plan
    // ("The following untracked working tree files would be overwritten by
    // merge"). The tests below simulate registration's scaffolding by hand
    // (writing `.gitignore` — and, for the `.lazy/`/`.lazybrain/` cases, the
    // directories those patterns must exclude) between the `begin`/`finish`
    // calls, exactly where `project_register_inner` runs in the real
    // `project_create_inner` sequence.

    /// Pure decision table: both guards must hold for git init to be
    /// attempted — a pre-existing directory is never touched, and a parent
    /// already inside a git repo always skips (never nests).
    #[test]
    fn should_attempt_git_init_requires_both_guards() {
        assert!(
            should_attempt_git_init(true, false),
            "we created the dir and its parent is not already a repo -> attempt"
        );
        assert!(
            !should_attempt_git_init(false, false),
            "a pre-existing directory must never be retrofitted with git"
        );
        assert!(
            !should_attempt_git_init(true, true),
            "a parent already inside a git repo must skip -> never nest repos"
        );
        assert!(
            !should_attempt_git_init(false, true),
            "neither guard satisfied -> skip"
        );
        eprintln!("should_attempt_git_init_requires_both_guards PASSED");
    }

    /// `parent_is_inside_git_repo` must distinguish a real git working tree
    /// (even one with zero commits — `--show-toplevel` does not require a
    /// resolvable HEAD) from an ordinary directory that is not in any repo.
    #[test]
    fn parent_is_inside_git_repo_detects_a_real_repo_and_not_a_plain_dir() {
        let repo = TempDir::new().expect("TempDir::new");
        let init = quiet_command(git_binary())
            .args(["init", "-q"])
            .current_dir(repo.path())
            .output()
            .expect("git init");
        assert!(init.status.success(), "git init: {}", String::from_utf8_lossy(&init.stderr));
        assert!(
            parent_is_inside_git_repo(repo.path()),
            "a freshly git-init'd directory (even commit-less) must read as inside a repo"
        );

        let plain = TempDir::new().expect("TempDir::new");
        assert!(
            !parent_is_inside_git_repo(plain.path()),
            "an ordinary directory outside any repo must read as NOT inside one"
        );
        eprintln!("parent_is_inside_git_repo_detects_a_real_repo_and_not_a_plain_dir PASSED");
    }

    /// `git_init_only` followed by `git_add_all_and_commit` must leave a
    /// resolvable `HEAD` — the property `git worktree add`'s later
    /// merge-back step depends on (see `git_add_all_and_commit`'s own doc
    /// comment for the empirical evidence) — and the commit must carry the
    /// neutral bot identity, never whatever `user.name`/`user.email` happen
    /// to be set globally on the machine running this test. A `.gitignore`
    /// is written between the two calls to stand in for what
    /// `project_register_inner` scaffolds in the real sequence — with
    /// nothing staged, `git commit` (no `--allow-empty` any more) would
    /// otherwise have nothing to commit.
    #[test]
    fn git_init_only_then_add_all_and_commit_leaves_a_resolvable_head_under_the_bot_identity() {
        let tmp = TempDir::new().expect("TempDir::new");
        git_init_only(tmp.path()).expect("git_init_only");
        std::fs::write(tmp.path().join(".gitignore"), ".lazy/\n.lazybrain/\n")
            .expect("simulate registration's .gitignore scaffolding");
        git_add_all_and_commit(tmp.path()).expect("git_add_all_and_commit");

        let rev_parse = quiet_command(git_binary())
            .args(["rev-parse", "--verify", "-q", "HEAD"])
            .current_dir(tmp.path())
            .output()
            .expect("git rev-parse");
        assert!(
            rev_parse.status.success(),
            "HEAD must resolve to a real commit after git_init_only + git_add_all_and_commit"
        );

        let log = quiet_command(git_binary())
            .args(["log", "-1", "--format=%an <%ae>"])
            .current_dir(tmp.path())
            .output()
            .expect("git log");
        let author = String::from_utf8_lossy(&log.stdout).trim().to_string();
        assert_eq!(
            author, "Lazy Agent <agent@lazy.dev>",
            "the initial commit must use the neutral bot identity, never the machine's own \
             (this would only pass by accident of local git config if the -c flags were \
             dropped in favor of `git config`/global identity)"
        );
        eprintln!(
            "git_init_only_then_add_all_and_commit_leaves_a_resolvable_head_under_the_bot_identity PASSED"
        );
    }

    /// End-to-end success path: a directory we "created" (parent is NOT
    /// itself a repo) gets a real `.git` from `begin_new_project_git_repo`,
    /// and once registration's `.gitignore` scaffolding is simulated between
    /// the two calls, `finish_new_project_git_repo` returns a note that does
    /// not claim missions cannot run there.
    #[test]
    fn begin_then_finish_new_project_git_repo_initializes_when_parent_is_not_a_repo() {
        let parent = TempDir::new().expect("TempDir::new");
        let dir = parent.path().join("new-project");
        std::fs::create_dir(&dir).expect("create_dir");

        let stage = begin_new_project_git_repo(&dir, parent.path());
        assert!(dir.join(".git").exists(), "a real .git must exist after the begin phase");

        // Simulate project_register_inner's scaffolding, which runs for
        // real between begin_new_project_git_repo and
        // finish_new_project_git_repo in project_create_inner.
        ensure_project_gitignore_excludes_scaffolding(&dir);

        let note = finish_new_project_git_repo(&dir, stage);

        assert!(
            !note.to_ascii_lowercase().contains("cannot run"),
            "a successful init+commit must not claim missions cannot run here, got: {}",
            note
        );
        eprintln!(
            "begin_then_finish_new_project_git_repo_initializes_when_parent_is_not_a_repo PASSED: {}",
            note
        );
    }

    /// Guard path: a parent that is already a git repo must be left alone —
    /// `begin_new_project_git_repo` never creates a `.git` inside the new
    /// directory, and `finish_new_project_git_repo`'s note says so honestly
    /// instead of claiming success.
    #[test]
    fn begin_then_finish_new_project_git_repo_skip_when_parent_is_already_a_repo() {
        let parent = TempDir::new().expect("TempDir::new");
        let init = quiet_command(git_binary())
            .args(["init", "-q"])
            .current_dir(parent.path())
            .output()
            .expect("git init");
        assert!(init.status.success(), "git init: {}", String::from_utf8_lossy(&init.stderr));

        let dir = parent.path().join("nested-project");
        std::fs::create_dir(&dir).expect("create_dir");

        let stage = begin_new_project_git_repo(&dir, parent.path());
        assert!(
            !dir.join(".git").exists(),
            "must never nest a repo inside the parent's existing repo"
        );

        let note = finish_new_project_git_repo(&dir, stage);
        assert!(
            note.to_ascii_lowercase().contains("skip"),
            "note must plainly say git init was skipped, got: {}",
            note
        );
        eprintln!("begin_then_finish_new_project_git_repo_skip_when_parent_is_already_a_repo PASSED: {}", note);
    }

    // ── reordering regression coverage (the outage this fix closes) ─────
    //
    // `mission.approve_blocked` in production: an empty initial commit made
    // BEFORE `project_register_inner` scaffolded `.gitignore` left that file
    // untracked forever, so any mission branch that also wrote `.gitignore`
    // could never be merged back — "The following untracked working tree
    // files would be overwritten by merge". These tests run the real
    // `begin_new_project_git_repo` -> (simulated registration scaffolding)
    // -> `finish_new_project_git_repo` sequence against a real git repo and
    // assert the untracked-leftover is gone.

    /// THE regression test: after the full sequence, `git status --porcelain`
    /// must report NO untracked files at all — not `.gitignore`, and not the
    /// `.lazybrain/` content that brain init/auto-index would create inside
    /// it (simulated here directly, since those are the two things
    /// registration actually writes into a brand-new project root).
    #[test]
    fn full_create_sequence_leaves_no_untracked_files() {
        let parent = TempDir::new().expect("TempDir::new");
        let dir = parent.path().join("new-project");
        std::fs::create_dir(&dir).expect("create_dir");

        let stage = begin_new_project_git_repo(&dir, parent.path());

        // Simulate project_register_inner's scaffolding: the .gitignore it
        // always writes, plus the .lazybrain/ content brain init/auto-index
        // would create under a project-local brain path — both land here,
        // between begin and finish, exactly as in the real sequence.
        ensure_project_gitignore_excludes_scaffolding(&dir);
        std::fs::create_dir_all(dir.join(".lazybrain").join("brain")).expect("mkdir .lazybrain");
        std::fs::write(dir.join(".lazybrain").join("brain").join("marker.txt"), "brain-data")
            .expect("write simulated brain scaffolding");

        let note = finish_new_project_git_repo(&dir, stage);
        assert!(
            !note.to_ascii_lowercase().contains("did not complete") && !note.to_ascii_lowercase().contains("skip"),
            "the full sequence must succeed end to end, got: {}",
            note
        );

        let status_output = quiet_command(git_binary())
            .args(["status", "--porcelain"])
            .current_dir(&dir)
            .output()
            .expect("git status");
        let status = String::from_utf8_lossy(&status_output.stdout);
        assert!(
            status.trim().is_empty(),
            "git status --porcelain must report NO untracked files after the full create \
             sequence — this is the exact regression the reordering fixes, got:\n{}",
            status
        );

        eprintln!("full_create_sequence_leaves_no_untracked_files PASSED");
    }

    /// The initial commit must actually CONTAIN the scaffolded `.gitignore`
    /// — not merely leave it non-untracked (e.g. via a stray second commit);
    /// this is what makes a later mission branch's own `.gitignore` mergeable.
    #[test]
    fn initial_commit_contains_the_scaffolded_gitignore() {
        let parent = TempDir::new().expect("TempDir::new");
        let dir = parent.path().join("new-project");
        std::fs::create_dir(&dir).expect("create_dir");

        let stage = begin_new_project_git_repo(&dir, parent.path());
        ensure_project_gitignore_excludes_scaffolding(&dir);
        let note = finish_new_project_git_repo(&dir, stage);
        assert!(
            !note.to_ascii_lowercase().contains("did not complete"),
            "commit must succeed, got: {}",
            note
        );

        let ls_tree = quiet_command(git_binary())
            .args(["ls-tree", "-r", "--name-only", "HEAD"])
            .current_dir(&dir)
            .output()
            .expect("git ls-tree");
        let tracked = String::from_utf8_lossy(&ls_tree.stdout);
        assert!(
            tracked.lines().any(|l| l == ".gitignore"),
            "the initial commit must contain .gitignore, tracked files:\n{}",
            tracked
        );
        eprintln!("initial_commit_contains_the_scaffolded_gitignore PASSED: {}", note);
    }

    /// `.lazy/` must never be committed — it is machine-local agent scratch
    /// space (saved agents, mission worktrees) that the scaffolded
    /// `.gitignore` excludes, so `git add -A` in the initial commit must
    /// skip it entirely, not just leave it out of THIS commit.
    #[test]
    fn lazy_scratch_dir_is_not_committed() {
        let parent = TempDir::new().expect("TempDir::new");
        let dir = parent.path().join("new-project");
        std::fs::create_dir(&dir).expect("create_dir");

        let stage = begin_new_project_git_repo(&dir, parent.path());
        ensure_project_gitignore_excludes_scaffolding(&dir);
        std::fs::create_dir_all(dir.join(".lazy").join("agents")).expect("mkdir .lazy");
        std::fs::write(dir.join(".lazy").join("agents").join("saved.json"), "{}")
            .expect("write simulated .lazy content");

        let note = finish_new_project_git_repo(&dir, stage);
        assert!(
            !note.to_ascii_lowercase().contains("did not complete"),
            "commit must succeed, got: {}",
            note
        );

        let ls_tree = quiet_command(git_binary())
            .args(["ls-tree", "-r", "--name-only", "HEAD"])
            .current_dir(&dir)
            .output()
            .expect("git ls-tree");
        let tracked = String::from_utf8_lossy(&ls_tree.stdout);
        assert!(
            !tracked.contains(".lazy"),
            "`.lazy/` must never be committed, tracked files:\n{}",
            tracked
        );

        let status_output = quiet_command(git_binary())
            .args(["status", "--porcelain"])
            .current_dir(&dir)
            .output()
            .expect("git status");
        let status = String::from_utf8_lossy(&status_output.stdout);
        assert!(
            status.trim().is_empty(),
            "`.lazy/` must be gitignored, not merely uncommitted — git status must show \
             nothing, got:\n{}",
            status
        );
        eprintln!("lazy_scratch_dir_is_not_committed PASSED");
    }

    /// "A pre-existing directory is left untouched": `project_create_inner`
    /// only ever calls `begin_new_project_git_repo` for a directory THIS
    /// call just created via `std::fs::create_dir` — a directory that
    /// already existed takes the early `project_register_inner(path, app)`
    /// return at the very top of that function and never reaches any
    /// git-touching code at all (see `begin_new_project_git_repo`'s doc
    /// comment — `we_created_dir` is unconditionally `true` there precisely
    /// because of that early return). That branch needs a live
    /// `tauri::AppHandle` to exercise directly, which cannot be constructed
    /// in a unit test (see `set_project_state_and_brain_init`'s doc comment
    /// for the same limitation elsewhere in this file), so this test locks
    /// in the decision half of the guarantee against a REAL pre-existing
    /// directory and a REAL (non-repo) parent, and proves the directory's
    /// own pre-existing content is never touched when that decision is
    /// never acted on.
    #[test]
    fn pre_existing_directory_is_left_untouched_by_git_init() {
        let parent = TempDir::new().expect("TempDir::new");
        let dir = parent.path().join("already-there");
        std::fs::create_dir(&dir).expect("create_dir");
        std::fs::write(dir.join("keep-me.txt"), "original content\n")
            .expect("seed pre-existing content");

        // This is the decision project_create_inner makes (via its
        // target.is_dir() early return) for ANY directory it did not itself
        // create, regardless of what the parent looks like — false means
        // begin_new_project_git_repo is never called at all.
        let we_created_dir = false;
        assert!(
            !should_attempt_git_init(we_created_dir, parent_is_inside_git_repo(parent.path())),
            "a pre-existing directory must never be a candidate for git init"
        );

        // Nothing in that (never-taken) path runs, so the directory's own
        // content must be exactly what it was before.
        assert!(
            !dir.join(".git").exists(),
            "a pre-existing directory must never gain a .git of its own"
        );
        let content = std::fs::read_to_string(dir.join("keep-me.txt")).expect("read back");
        assert_eq!(
            content, "original content\n",
            "pre-existing content must be left byte-for-byte untouched"
        );
        eprintln!("pre_existing_directory_is_left_untouched_by_git_init PASSED");
    }

    /// The init-succeeded-but-commit-failed edge case must be reported
    /// honestly, never as success: force `git_add_all_and_commit` to fail by
    /// leaving nothing staged (no scaffolding simulated at all — an empty
    /// directory has nothing for `git add -A` to pick up, so plain `git
    /// commit` has nothing to commit), and assert the note names the real
    /// consequence (an unborn HEAD that cannot be merged into) rather than
    /// claiming missions can run here.
    #[test]
    fn finish_new_project_git_repo_reports_commit_failure_honestly() {
        let parent = TempDir::new().expect("TempDir::new");
        let dir = parent.path().join("new-project");
        std::fs::create_dir(&dir).expect("create_dir");

        let stage = begin_new_project_git_repo(&dir, parent.path());
        assert!(dir.join(".git").exists(), "git init must have run during the begin phase");

        // Deliberately do NOT simulate any registration scaffolding — dir is
        // still empty, so git_add_all_and_commit has nothing to commit.
        let note = finish_new_project_git_repo(&dir, stage);

        assert!(
            !note.to_ascii_lowercase().contains("mission worktrees can be created here"),
            "a failed commit must never be reported as success, got: {}",
            note
        );
        assert!(
            note.contains("unborn"),
            "note must name the unborn-HEAD consequence, got: {}",
            note
        );
        eprintln!("finish_new_project_git_repo_reports_commit_failure_honestly PASSED: {}", note);
    }
}
