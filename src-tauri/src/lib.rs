use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

mod state;
mod commands;
mod migration;
mod test_runner;
mod lsp;
mod teams_sidecar;
mod crash_guard;
mod updater_service;
pub mod runner;
mod solari_cdp_proxy;
#[cfg(windows)]
mod webview_recovery;
#[cfg(windows)]
mod startup_watchdog;

use commands::agent::{
    AgentPidState, SchedulerState, kill_tracked_agent_pids, load_scheduled_agents, spawn_scheduler,
};
use commands::brain::maintenance::{
    CONSOLIDATE_INTERVAL_SECS, MaintenancePidState, MissionsActiveState,
    kill_tracked_maintenance_pids, spawn_brain_consolidator,
};
use commands::brain::config::{expose_app_config_dir, expose_lazybrain_env};
use commands::brain::sidecar::{
    BRAIN_PORT, BrainSidecar, BrainState, expose_app_local_data_dir, resolve_brain_bin,
    resolve_brain_path, start_or_restart_brain_sidecar,
};
use commands::journal::{open_journal_for_app, spawn_journal_retention};
use commands::worktree_sweep::spawn_worktree_orphan_sweep;
use commands::system_pressure::{SystemPressureState, spawn_pressure_monitor};
use commands::terminal::{PtyState, kill_all_terminal_sessions};
use state::{JournalState, ProjectRegistry, ProjectState};

/// Install a panic hook that logs the panic message + location before
/// chaining to Rust's default hook. Without this, a background-thread panic
/// left NO trace anywhere in a release build: `windows_subsystem = "windows"`
/// (main.rs) detaches the console, so the default hook's stderr output goes
/// nowhere, and (before this fix) the log plugin was not even registered in
/// release. The worst-hit case was commands/agent.rs's stdout-reader thread
/// (agent_run / spawn_scheduler): a panic there (see the multi-byte
/// char-boundary fixes elsewhere in this change) killed the thread silently,
/// so the mission's `agent://done` event never fired and Mission Control
/// hung forever waiting for a completion that would never come.
///
/// Must be installed before anything else in `run()` so it covers as much of
/// the app's lifetime as possible. `log::error!` calls made here are
/// effectively no-ops until the log plugin registers a few lines into
/// `.setup()` below — an unavoidable, very small gap covering only trivial
/// plugin-registration calls, not any of the actual panic-prone paths
/// (multi-byte slicing, sidecar threads, agent streaming), which all run
/// long after `.setup()` returns.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        log::error!("PANIC at {}: {}", location, message);
        default_hook(info);
    }));
}

/// Crash resilience layer B (Windows only): register this process with
/// Windows' Restart Manager / WER so a hard crash (unhandled exception,
/// not-responding hang, etc. — anything the OS itself catches, as opposed
/// to the Rust-level panics `install_panic_hook` above only logs) relaunches
/// the exe automatically. The `--restarted-after-crash` sentinel is passed
/// back on that relaunch's command line so future startup code can tell
/// "the OS just resurrected us after a crash" apart from a normal
/// user-initiated launch, without needing to invent its own crash-marker
/// file — not consumed anywhere yet, but free to add now while the
/// argument is being wired in the first place.
///
/// `REGISTER_APPLICATION_RESTART_FLAGS(0)` sets none of the RESTART_NO_*
/// opt-out bits, i.e. "restart me after any of: crash, hang, patch, reboot"
/// — the most resilient registration, not a narrower one.
///
/// Complements layer A (`install_webview_crash_restart_handler`, called from
/// `.setup()` below): that one covers a WebView2 child process dying while
/// this outer exe survives; this one covers the outer exe itself dying.
/// Must run at process startup, independent of any App/AppHandle — this is
/// a plain Win32 registration, not a Tauri API.
///
/// Non-fatal: a failure here just means no OS-level auto-relaunch after a
/// crash, logged and otherwise ignored — never a reason to abort startup.
#[cfg(windows)]
fn register_crash_restart() {
    use windows::Win32::System::Recovery::{
        REGISTER_APPLICATION_RESTART_FLAGS, RegisterApplicationRestart,
    };

    // Safety: RegisterApplicationRestart takes a command-line ARGUMENTS
    // string (not the exe path) and a flags bitmask — no pointers/handles
    // outlive this call, and the string comes from a `w!`-embedded 'static
    // literal, not caller-controlled memory.
    let result = unsafe {
        RegisterApplicationRestart(
            windows::core::w!("--restarted-after-crash"),
            REGISTER_APPLICATION_RESTART_FLAGS(0),
        )
    };
    if let Err(e) = result {
        log::warn!("RegisterApplicationRestart failed (crash auto-relaunch unavailable): {}", e);
    }
}

/// Crash resilience layer A (Windows only): WebView2 in-place recovery.
/// Extracted to its own module — see `webview_recovery`'s own module doc
/// comment for the full design (in-place recreate vs. full restart,
/// retry-then-fall-back sequencing, and the `WindowEvent::Destroyed` guard
/// `.on_window_event` below reads via `webview_recovery::is_recovery_in_progress()`).
#[cfg(windows)]
use webview_recovery::install_webview_crash_restart_handler;

/// Crash resilience layer B (Windows only): startup-readiness watchdog for
/// the window never finishing its first paint at all — see
/// `startup_watchdog`'s own module doc comment for why layer A above
/// cannot see this failure class, and for the full design.
#[cfg(windows)]
use startup_watchdog::spawn_startup_watchdog;

/// Hydrate `ProjectRegistry` (already `.manage()`d empty in `run()`, below)
/// from `<app_local_data_dir>/projects.json` at boot (T-R1c persistence
/// fix) — see this function's call site in `run()`'s `.setup()` closure
/// for why this must run before any frontend `project_list`/
/// `project_register` call can observe the registry.
///
/// Roots that no longer exist on disk (folder deleted/moved, an external
/// drive unmounted, since the last run) are dropped — see
/// `state::RegistryInner::from_persisted_pruned`'s doc comment for the
/// exact "drop what's gone, keep what's real" contract and how `active` is
/// re-resolved when the previously-active entry was itself pruned.
/// Missing/corrupt file: log and leave the registry empty (matches the
/// pre-persistence behavior exactly — never worse than before this
/// feature existed).
///
/// A free function with early returns (not inlined into `.setup()` as a
/// nested match/if-let chain) — the nested-block version tripped a rustc
/// NLL quirk (E0597: "borrowed value does not live long enough") around a
/// `MutexGuard` temporary's drop scope specifically when nested two
/// `if let`s deep; confirmed via `cargo check` that the guard usage itself
/// was never actually unsound, only the nesting depth triggered the
/// diagnostic. Flattening into a function with early `return`s (the same
/// shape `project_register_inner`/`project_set_active_inner` elsewhere in
/// this crate already use for their own lock-then-mutate sequences) sidesteps
/// it entirely.
fn hydrate_project_registry_from_disk(app: &tauri::AppHandle) {
    let data_dir = match app.path().app_local_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!(
                "could not resolve app_local_data_dir ({}) — the project registry will not persist across restarts this session",
                e
            );
            return;
        }
    };

    let projects_path = data_dir.join("projects.json");
    let persisted = match state::projects_registry_load_inner(&projects_path) {
        Ok(Some(p)) => p,
        Ok(None) => {
            log::info!("projects.json: not found — fresh install or a pre-persistence session");
            return;
        }
        Err(e) => {
            log::warn!("projects.json: failed to load ({}) — booting with an empty registry", e);
            return;
        }
    };

    let requested = persisted.open.len();
    let rebuilt = state::RegistryInner::from_persisted_pruned(persisted, |root| std::path::Path::new(root).is_dir());
    let survived = rebuilt.open.len();
    if survived < requested {
        log::warn!(
            "projects.json: dropped {} project(s) whose root no longer exists on disk",
            requested - survived
        );
    }
    if survived == 0 {
        log::info!("projects.json: no project survived pruning — booting with an empty registry");
        return;
    }

    log::info!("projects.json: restored {} open project(s), active={:?}", survived, rebuilt.active);
    let active_root = rebuilt.active_root();

    let registry = app.state::<ProjectRegistry>();
    match registry.0.lock() {
        Ok(mut guard) => *guard = rebuilt,
        Err(e) => {
            log::warn!("projects.json: registry lock failed while restoring: {}", e);
            return;
        }
    }

    // Keep the legacy single-root mutex in sync (see ProjectState's doc
    // comment) so every command still reading it directly sees the
    // restored active root from the very first call, not just after the
    // next project_set_active.
    let Some(root) = active_root else { return };
    let project_state = app.state::<ProjectState>();
    match project_state.0.lock() {
        Ok(mut ps) => *ps = root,
        Err(e) => log::warn!("projects.json: project state lock failed while restoring: {}", e),
    };
}

/// Idempotent app-exit cleanup: mark shutdown, tree-kill every tracked
/// agent/maintenance child pid, stop the brain + teams sidecars, stop every
/// MCP server / browser-automation controller child, stop every LSP
/// session, and mark this session's crash-guard exit as clean.
///
/// LSP session cleanup (`lsp::stop_all_lsp_for_exit`) is wired below as of
/// this integration pass — `lsp.rs` was previously owned by a separate
/// in-flight change, so this call was deferred until that change landed.
///
/// P42 ROOT CAUSE this closes: before this fix, this exact sequence only
/// ever ran from the `WindowEvent::Destroyed` handler below (`on_window_event`)
/// — but `AppHandle::request_restart()` (used by
/// `install_webview_crash_restart_handler`'s WebView2-crash recovery path,
/// and available to any future "restart the app" trigger) exits the process
/// via `RunEvent::Exit`, which — until this fix — `Builder::run(context)`
/// handled with a hard-coded NO-OP callback (see that method's own source:
/// `self.build(context)?.run(|_, _| {})`). A restart therefore tore the
/// process down WITHOUT ever running this cleanup, orphaning the brain
/// sidecar (and any tracked agent/maintenance children) every single time —
/// confirmed by tracing `tauri` 2.11.3's own `app.rs`
/// (`make_run_event_loop_callback`): `RuntimeRunEvent::Exit` invokes the
/// `run()` callback BEFORE any restart actually happens, so handling
/// `RunEvent::Exit` in that callback (see `run()`'s new `.build(context)?
/// .run(|app_handle, event| ...)` below) is the ONLY point that reliably
/// covers restart, not just a normal window close.
///
/// Idempotent by construction (every step here already documents its own
/// idempotency — `mark_shutting_down` is a plain flag set, the two
/// `kill_tracked_*` helpers no-op on an empty/already-cleared map,
/// `stop_brain_sidecar_for_exit`/`stop_teams_sidecar_for_exit` no-op when
/// already stopped) — so calling this from BOTH the `Destroyed` handler
/// (still kept, per this fix's own instruction, for the ordinary
/// last-window-closes path) AND `RunEvent::Exit` (which fires shortly after
/// `Destroyed` on that same ordinary path) is always safe, never a
/// double-kill hazard. The MCP/browser/crash-guard steps added later follow
/// the exact same idempotency contract (see their own call sites below).
fn run_exit_cleanup(app_handle: &tauri::AppHandle) {
    commands::brain::sidecar::mark_shutting_down();

    let pty_state = app_handle.state::<PtyState>();
    kill_all_terminal_sessions(&pty_state);

    let agent_pids = app_handle.state::<AgentPidState>();
    kill_tracked_agent_pids(&agent_pids);

    let maintenance_pids = app_handle.state::<MaintenancePidState>();
    kill_tracked_maintenance_pids(&maintenance_pids);

    let brain_state = app_handle.state::<BrainState>();
    commands::brain::sidecar::stop_brain_sidecar_for_exit(&brain_state);

    let teams_state = app_handle.state::<teams_sidecar::TeamsSidecarState>();
    teams_sidecar::stop_teams_sidecar_for_exit(&teams_state);

    commands::mcp::kill_all_mcp_servers();
    commands::browser::kill_browser_instance();

    let lsp_state = app_handle.state::<lsp::LspState>();
    lsp::stop_all_lsp_for_exit(&lsp_state);

    // Crash-guard layer C (crash_guard.rs): this session is ending through
    // an ordinary, accounted-for path (not an unhandled exception the SEH
    // handler would have caught) — mark it clean so the NEXT boot's
    // `read_startup_crash_state` does not mistake it for an unclean end.
    // Safe to call unconditionally on every platform: `mark_clean_exit` is a
    // no-op off Windows (see that function's own doc comment), and
    // idempotent (atomic swap, no lock) so running from both this function
    // AND the `RunEvent::Exit` path below is never a double-close hazard.
    if let Ok(data_dir) = app_handle.path().app_local_data_dir() {
        crash_guard::mark_clean_exit(&crash_guard::marker_path(&data_dir));
    }
}

/// Lock `teams_state` and start the Teams sidecar if healthy — extracted to
/// a free function (not inlined as a `match` nested inside `.setup()`'s own
/// `if env var { if let Some(script) { ... } }` chain) purely to sidestep a
/// rustc NLL quirk: nesting a match/if-let around a `MutexGuard` temporary
/// two levels deep trips E0597 ("borrowed value does not live long
/// enough") — the exact same class of false positive
/// `hydrate_project_registry_from_disk`'s own doc comment already
/// documents for this codebase. Flattening into a function with no nested
/// control flow around the lock sidesteps it entirely, same fix.
///
/// Poison-safe (was `.expect("TeamsSidecarState lock")`): a poisoned lock
/// degrades to a logged warning rather than panicking `.setup()` — same
/// "never propagate a panic out of app startup" contract
/// `commands::agent::kill_tracked_agent_pids` established for this crate's
/// other shared-state locks.
fn start_teams_sidecar_if_healthy(
    teams_state: &teams_sidecar::TeamsSidecarState,
    node_exe: &str,
    script: &str,
    port: u16,
    data_dir: &str,
    auth_mode: &str,
    jwt_secret: &str,
) {
    match teams_state.0.lock() {
        Ok(mut sidecar) => {
            let started = sidecar.start(node_exe, script, port, data_dir, auth_mode, jwt_secret);
            if started {
                log::info!("Teams sidecar ready at :{}", port);
            } else {
                log::warn!("Teams sidecar did not become healthy — teams capture will fail");
            }
        }
        Err(e) => log::warn!(
            "TeamsSidecarState lock poisoned ({}) — Teams sidecar not started this session",
            e
        ),
    }
}

pub fn run() {
    install_panic_hook();

    // Crash resilience layer B — see register_crash_restart's own doc
    // comment. No AppHandle/window needed, so this runs as early as
    // possible, right alongside the panic hook above.
    #[cfg(windows)]
    register_crash_restart();

    let context = tauri::generate_context!();

    // ── Host-crash forensics (crash resilience layer C) ──
    //
    // Read any marker the PREVIOUS session left (an unclean end — layer C's
    // SEH handler, `crash_guard::install` below, wrote it) and derive this
    // boot's `StartupCrashState` BEFORE re-arming a fresh marker for THIS
    // session — otherwise this boot's own fresh marker would immediately be
    // read back as "the previous session crashed". Deliberately runs before
    // both the migration pass just below AND the Builder: the whole point
    // of layer C is to catch a host-process crash as early in the process
    // lifetime as possible, including during migration's own file copying.
    // `resolve_pre_builder_data_dir` mirrors `migration::run_startup_migration`'s
    // own pre-Builder path resolution (see that module's doc comment for
    // why this must happen this early); both degrade to a safe no-op when
    // `LOCALAPPDATA` is unset (non-Windows, or a broken environment) — see
    // `crash_guard`'s own module doc comment for the full design.
    let restarted_after_crash = std::env::args().any(|a| a == "--restarted-after-crash");
    let crash_guard_dir = crash_guard::resolve_pre_builder_data_dir(&context.config().identifier);
    let startup_crash_state = crash_guard_dir
        .as_deref()
        .map(|dir| crash_guard::read_startup_crash_state(dir, restarted_after_crash))
        .unwrap_or(crash_guard::StartupCrashState::Clean);
    if let Some(dir) = &crash_guard_dir {
        crash_guard::install(&crash_guard::marker_path(dir));
    }

    // ── Auto-update: apply a staged update before anything else starts ──
    //
    // See `updater_service`'s own module doc comment for the full model
    // (staged-to-disk this session, applied at the START of the NEXT boot —
    // never `Update::install`/`download_and_install`, which `exit(0)`
    // unconditionally on Windows and bypass `RunEvent::Exit` entirely).
    // Reuses the EXACT same pre-Builder `data_dir` resolution as
    // `crash_guard` just above (`crash_guard_dir`) — must run before the
    // Builder exists, so before any sidecar/agent/thread that would need
    // killing on a self-relaunch. `log::*` is not wired yet (the log plugin
    // registers in `.setup()` below), hence `eprintln!` here — same
    // pre-Builder logging caveat `crash_guard`/`migration` already document;
    // `updater_service::take_boot_action`'s own `log::*` calls additionally
    // cover the SAME decision for the (non-boot) callers that run after the
    // log plugin is up, e.g. a future manual re-check of this exact state.
    let mut boot_update_applied: Option<String> = None;
    if let Some(dir) = &crash_guard_dir {
        match updater_service::take_boot_action(dir, env!("CARGO_PKG_VERSION")) {
            updater_service::BootAction::Install { exe_path } => {
                // This exit is VOLUNTARY (we are about to hand off to the
                // freshly staged installer) — mark it clean so the NEXT
                // boot's `crash_guard::read_startup_crash_state` does not
                // mistake it for an unclean end (the exact bug this whole
                // module exists to fix: `Update::install`'s own unconditional
                // `exit(0)` never got a chance to do this).
                crash_guard::mark_clean_exit(&crash_guard::marker_path(dir));

                // /S = silent (currentUser install, no UAC prompt), /R =
                // relaunch after install, /UPDATE = the NSIS "update mode"
                // Tauri's own bundled installer script expects, /ARGS =
                // prefix before the current process's own argv so the
                // relaunched app sees the same args it was started with
                // (mirrors the plugin's own `install_inner`, `updater.rs:812-814`).
                let mut cmd = std::process::Command::new(&exe_path);
                cmd.args(["/S", "/R", "/UPDATE", "/ARGS"]).args(std::env::args().skip(1));
                match cmd.spawn() {
                    Ok(_) => std::process::exit(0),
                    Err(e) => {
                        // Fail-open: do NOT exit — continue this boot
                        // normally. `take_boot_action` already persisted the
                        // incremented attempt count, so a persistently
                        // unspawnable installer self-discards after
                        // MAX_INSTALL_ATTEMPTS on a later boot rather than
                        // wedging this one.
                        eprintln!(
                            "updater_service: failed to spawn staged installer {} ({}) — continuing normal boot (fail-open)",
                            exe_path.display(),
                            e
                        );
                    }
                }
            }
            updater_service::BootAction::UpdateApplied { from_version } => {
                eprintln!("updater_service: update applied successfully (was {from_version})");
                boot_update_applied = Some(from_version);
            }
            updater_service::BootAction::None => {}
        }
    }

    // ── One-shot profile migration com.lazy.dev → com.lazy.app ──
    //
    // MUST run here, before the Builder is even constructed: WebView2 opens
    // its user-data LevelDB (%LOCALAPPDATA%\<identifier>\EBWebView) as soon
    // as the first window is created inside `.run()`, and copying a LevelDB
    // that is already open would tear it — so this is the only point in the
    // process lifetime where the copy is safe. The new identifier comes from
    // the generated context so it can never drift from tauri.conf.json.
    // `log::*` is not wired yet (the log plugin registers in `.setup()`),
    // hence the returned report, logged below once the plugin is up.
    let migration_report = migration::run_startup_migration(&context.config().identifier);

    // C72 — local Origin-strip CDP proxy for packaged Tauri (mirrors vite /solari-cdp).
    // Start before Builder::manage so the port is known; a bind failure yields
    // port 0 and the frontend falls back to direct wss://api.getsolari.com.
    let solari_cdp_port = match solari_cdp_proxy::start_solari_cdp_proxy() {
        Ok(port) => port,
        Err(err) => {
            eprintln!("[lazy] solari_cdp_proxy failed to start: {err}");
            0
        }
    };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .manage(PtyState::new())
        .manage(BrainState::new())
        .manage(ProjectState::new())
        .manage(ProjectRegistry::new())
        .manage(AgentPidState::new())
        .manage(MaintenancePidState::new())
        .manage(MissionsActiveState::new())
        .manage(SystemPressureState::new())
        .manage(SchedulerState::new())
        .manage(lsp::LspState::new())
        .manage(teams_sidecar::TeamsSidecarState::new())
        .manage(crash_guard::StartupCrashStateManaged(startup_crash_state))
        .manage(updater_service::UpdaterRuntimeState::new(boot_update_applied))
        .manage(std::sync::Arc::new(solari_cdp_proxy::SolariCdpProxyState {
            port: solari_cdp_port,
        }));

    // ── Startup-readiness watchdog registration (see startup_watchdog.rs's
    // own module doc comment) ── MUST be attached to the `Builder` itself,
    // before `.build()`/`.run()` below creates the "main" window, not from
    // inside `.setup()` (unlike layer A's crash handler, which needs a
    // live window to attach to and so has no choice but to run from
    // `.setup()`) — see that module's doc comment for the
    // window-already-created-before-listener-attached race this timing
    // avoids.
    #[cfg(windows)]
    let builder = builder.on_page_load(startup_watchdog::mark_ready_on_main_page_finished);

    builder
        .setup(move |app| {
            // Register updater plugin (desktop only — not available on mobile).
            // `tauri_plugin_updater::Builder` (this one) does not expose an
            // `on_before_exit` hook — only the per-call `UpdaterBuilder`
            // returned by `UpdaterExt::updater_builder()` does, and that
            // hook only ever fires from `Update::install`'s own
            // `install_inner` (updater.rs:837), a path `updater_service.rs`
            // never calls — so there is nothing to wire here (spec A.3).
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // OS info plugin — used for locale detection on first run.
            app.handle().plugin(tauri_plugin_os::init())?;

            // Deep-link: register all configured schemes at runtime so the OS
            // routes lazy://auth-callback to this app during development on
            // Windows and Linux (on macOS the Info.plist handles it at install).
            #[cfg(any(windows, target_os = "linux"))]
            app.deep_link().register_all()?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            } else {
                // Release: previously NO log plugin was registered at all here —
                // combined with `windows_subsystem = "windows"` (main.rs)
                // detaching the console, a release crash left literally no
                // trace anywhere (confirmed: the app ran, and the log file was
                // frozen at the last debug-build session). Register the same
                // plugin here too, writing to the OS-standard app log
                // directory (TargetKind::LogDir — `<LocalAppData>\<bundle
                // id>\logs` on Windows) instead of the default Stdout target,
                // which is pointless with no attached console. Bounded via
                // rotation so this never grows unbounded over an installed
                // app's lifetime.
                use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .targets([Target::new(TargetKind::LogDir { file_name: None })])
                        .level(log::LevelFilter::Info)
                        .rotation_strategy(RotationStrategy::KeepSome(3))
                        .max_file_size(5 * 1024 * 1024) // 5 MiB per file, ~15 MiB retained
                        .build(),
                )?;
            }

            // Now that the log plugin is registered, flush the report of the
            // pre-Builder profile migration (see top of `run()`).
            migration::log_report(&migration_report);

            // Same deferred-logging caveat as the migration report just
            // above applies to the pre-Builder crash-guard read (see
            // `crash_guard`'s own module doc comment): log it now that the
            // log plugin is up. `SafeMode` also feeds the boot-defer
            // decision immediately below.
            let startup_crash_state = app.state::<crash_guard::StartupCrashStateManaged>().0;
            match startup_crash_state {
                crash_guard::StartupCrashState::Clean => {
                    log::info!("startup crash state: clean exit last session");
                }
                crash_guard::StartupCrashState::RecoveredFromCrash { consecutive } => {
                    log::warn!(
                        "startup crash state: recovered from an unclean exit last session (consecutive={})",
                        consecutive
                    );
                }
                crash_guard::StartupCrashState::SafeMode { consecutive } => {
                    log::error!(
                        "startup crash state: SAFE MODE — {} unclean exits within the last 15 minutes — deferring non-critical background subsystems regardless of measured RAM",
                        consecutive
                    );
                }
            }

            // ── Boot-under-duress defer (UI first, background later) ──
            //
            // A one-shot, synchronous RAM check — NOT the debounced
            // system-pressure monitor (spawned much further below in this
            // same `.setup()`): that monitor's first ACCEPTED reading needs
            // ~10s of real wall-clock time (two samples for its own
            // debounce — see its module doc), and this decision must be
            // made HERE, before anything else spawns, without itself adding
            // a multi-second delay (see
            // `system_pressure::is_boot_ram_pressure_high`'s own doc comment
            // for why RAM alone, never CPU, is used for this one specific
            // check).
            //
            // When the machine already reads High pressure at the exact
            // moment this app is booting, OR this boot is a crash-guard
            // `SafeMode` (see just above — a crash LOOP, not just a single
            // recovered crash), `boot_defer_secs` below is threaded through
            // to the non-critical, genuinely pressure-heavy background
            // subsystem starts further down (journal retention, the local
            // agent scheduler, the brain consolidator, the brain sidecar's
            // own boot thread — see each call site's own comment) so the
            // window/webview get full headroom first.
            let boot_defer_secs = {
                let mut sys = sysinfo::System::new();
                sys.refresh_memory();
                let available_ram_mb = sys.available_memory() / (1024 * 1024);
                let total_ram_mb = sys.total_memory() / (1024 * 1024);
                let ram_pressure_high =
                    commands::system_pressure::is_boot_ram_pressure_high(available_ram_mb, total_ram_mb);
                let safe_mode = matches!(startup_crash_state, crash_guard::StartupCrashState::SafeMode { .. });
                let secs = commands::system_pressure::boot_defer_seconds(ram_pressure_high || safe_mode);
                if safe_mode {
                    log::warn!(
                        "Crash-loop SafeMode — deferring non-critical background subsystems by {}s regardless of measured RAM",
                        secs
                    );
                } else if ram_pressure_high {
                    log::warn!(
                        "Boot-time system pressure High (available RAM {}MB) — deferring non-critical background subsystems by {}s so the window/webview get full headroom first",
                        available_ram_mb, secs
                    );
                }
                secs
            };

            // ── Crash resilience layer A (see its own doc comment) ──
            // The window(s) configured in tauri.conf.json are created before
            // `.setup()` runs, so "main" already exists here.
            #[cfg(windows)]
            install_webview_crash_restart_handler(app.handle());

            // ── Crash resilience layer B (see startup_watchdog.rs's own
            // module doc comment) ── catches the window never finishing its
            // first paint at all (the `on_page_load` hook this watches was
            // already registered on the `Builder` above, before "main" was
            // created, so no readiness event can be missed by starting the
            // watchdog only now).
            #[cfg(windows)]
            spawn_startup_watchdog(app.handle().clone());

            // ── Expose app config dir for the UI-persisted brain choice ──
            // set_brain_config / import_brain_from_github write
            // brain-config.json here (resolved live via their own
            // AppHandle); resolve_unified_brain_path — called from ~15
            // places with no AppHandle in scope — reads it back through
            // this cached env var instead. See app_config_dir_from_env's
            // doc comment for why both approaches resolve to the same dir.
            if let Ok(config_dir) = app.path().app_config_dir() {
                expose_app_config_dir(&config_dir);
            } else {
                log::warn!(
                    "could not resolve app config dir — UI-persisted brain choice will be unavailable this session"
                );
            }

            // ── Expose app local data dir for the cross-process sidecar ──
            // ── single-instance guard (fix #2) ──
            // start_or_restart_brain_sidecar (sidecar.rs) — called both from
            // this thread's boot spawn below AND from restart_brain_sidecar
            // (config.rs) on every project switch/retry, neither of which
            // always has a fresh AppHandle-based resolution in scope — reads
            // this back via the same env-var-as-a-cache trick
            // expose_app_config_dir already uses just above. See
            // expose_app_local_data_dir's own doc comment.
            if let Ok(data_dir) = app.path().app_local_data_dir() {
                expose_app_local_data_dir(&data_dir);
            } else {
                log::warn!(
                    "could not resolve app local data dir — the cross-process brain sidecar single-instance guard will be unavailable this session"
                );
            }

            // ── Hydrate the multi-project registry from disk (T-R1c) ──
            //
            // `ProjectRegistry` was `.manage()`d above empty (a fresh
            // in-memory Mutex) — without this, every project the user had
            // open was forgotten on every restart, and AppContext.tsx's
            // boot effect could only ever re-register the ONE path cached
            // under the legacy `lazy.lastProject` localStorage key. Restore
            // `<app_local_data_dir>/projects.json` here, before any
            // frontend `project_list`/`project_register` call can observe
            // the registry, so a non-empty persisted registry is what the
            // very first `listProjects()` sees. See
            // `hydrate_project_registry_from_disk`'s own doc comment for
            // the pruning contract.
            hydrate_project_registry_from_disk(app.handle());

            // ── Open the event journal (SQLite, WAL) ──
            //
            // Single global db (not per-project): the fleet cockpit is
            // cross-project by definition, so the append-only `events`
            // table + materialized `missions_current` projection (see
            // commands/journal.rs's module doc and spec section 4.1) live
            // at the app level, not inside any one project's `.lazy/`.
            // Always managed — `open_journal_for_app` degrades to a
            // logged-error in-memory fallback rather than ever leaving
            // `JournalState` unmanaged, so every `journal_*` command has a
            // real connection to extract via `tauri::State` regardless of
            // filesystem failures on this machine.
            app.manage(JournalState::new(open_journal_for_app(app)));

            // ── Spawn periodic journal retention (spec section 4.4) ──
            //
            // Audit follow-up: retention existed as code (src/lib/journal/
            // retention.ts) but was wired nowhere. One pass 5 minutes after
            // startup, then every 24h — see spawn_journal_retention's own
            // doc comment (commands/journal.rs) for why the delay/interval
            // and the `tauri::async_runtime::spawn` + `spawn_blocking`
            // shape mirror spawn_brain_consolidator below exactly.
            //
            // Boot-under-duress: when `boot_defer_secs` is non-zero (see
            // this closure's own boot-pressure check, above), the actual
            // `spawn_journal_retention` call — and therefore its own
            // internal timers — is itself delayed by that many seconds, on
            // top of (not instead of) its own 5-minute initial delay. Zero
            // added behavior change when pressure is comfortable (the
            // common case): the `if boot_defer_secs > 0` branch below is
            // never taken, so this stays byte-for-byte the pre-existing
            // immediate-spawn call.
            {
                let journal_state = app.state::<JournalState>();
                let conn = Arc::clone(&journal_state.0);
                if boot_defer_secs > 0 {
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(boot_defer_secs)).await;
                        spawn_journal_retention(conn);
                    });
                    log::info!(
                        "Journal retention scheduler deferred {}s (boot pressure High), then 5 min initial delay, then every 24h",
                        boot_defer_secs
                    );
                } else {
                    spawn_journal_retention(conn);
                    log::info!("Journal retention scheduler started (5 min initial delay, then every 24h)");
                }
            }

            // ── Spawn periodic orphan-worktree sweep (worktree-leak follow-up,
            // Fix 2) ──
            //
            // `archiveMission` (agentsStore.tsx) now reclaims a mission's
            // worktree the moment it archives it, but that is a best-effort
            // JS-side call — a hard crash mid-cleanup, or any mission
            // archived by a build that predates that fix, leaves an orphan
            // directory under `<repo>/.lazy/worktrees/` forever. This is
            // that recovery path — see worktree_sweep.rs's module doc for
            // the three-tier safety model. Modeled EXACTLY on the journal
            // retention scheduler immediately above (same shape, same
            // boot-under-duress deferral): 5 min initial delay, then every
            // 24h; the 5-minute delay doubles as this scheduler's own
            // "boot-time" pass (giving the mission-load effect and the
            // journal db a moment to settle first, same rationale as
            // journal retention's own initial delay).
            {
                let journal_state = app.state::<JournalState>();
                let conn = Arc::clone(&journal_state.0);
                let app_handle = app.handle().clone();
                if boot_defer_secs > 0 {
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(boot_defer_secs)).await;
                        spawn_worktree_orphan_sweep(app_handle, conn);
                    });
                    log::info!(
                        "Worktree orphan sweep scheduler deferred {}s (boot pressure High), then 5 min initial delay, then every 24h",
                        boot_defer_secs
                    );
                } else {
                    spawn_worktree_orphan_sweep(app_handle, conn);
                    log::info!("Worktree orphan sweep scheduler started (5 min initial delay, then every 24h)");
                }
            }

            // ── Spawn LazyBrain daemon sidecar (off the setup thread) ──
            //
            // Perf: `ensure_brain_init` (a blocking subprocess) and
            // `start_or_restart_brain_sidecar`'s health-check wait (up to
            // ~5s, ~10s with the port-fallback retry) together were the
            // dominant ~7s of cold-start time — `.setup()` runs
            // synchronously and blocks the window from becoming interactive
            // until it returns, so the user stared at a frozen (but
            // visible) window for the whole duration.
            //
            // The brain UI already degrades gracefully when the sidecar
            // isn't up yet: `BrainSidecar::new()` gives `BrainState` a real
            // (non-Option) port + token immediately at construction (see
            // `.manage(BrainState::new())` above, which runs before this
            // closure), and every `get_brain_port` / `get_brain_connection`
            // / `brain_fetch_*` command reads those plain fields with a
            // safe fallback — a fetch issued before the sidecar is actually
            // listening just gets a connection-refused error (or an empty
            // Vec for brain_fetch_backlinks/neighbors), never a panic. So
            // there is nothing here that genuinely needs `.setup()` to wait
            // for.
            //
            // Moved onto a dedicated background thread (not
            // `tauri::async_runtime::spawn`: everything below is 100%
            // synchronous blocking I/O — a subprocess spawn/wait and
            // blocking `reqwest` calls — so a plain OS thread avoids
            // occupying one of the tokio runtime's worker threads for the
            // whole ~5-10s instead of using `spawn_blocking` for the same
            // effect). `.setup()` returns immediately and the window is
            // interactive at once; `BrainState` (already constructed and
            // managed, see `.manage(BrainState::new())` above) is the SAME
            // shared `Arc<Mutex<BrainSidecar>>` this thread populates once
            // the sidecar actually becomes healthy — only WHEN that happens
            // changes, not the mechanism or the state it lands in.
            let lb = resolve_brain_bin(app);
            let brain_path = resolve_brain_path(app);

            // Expose resolved paths as env vars so future child sidecars
            // (e.g. Teams sidecar, Phase 1+) can reuse the same resolution.
            // Fast (just sets process env vars) — safe to keep synchronous.
            if let Some(ref lb) = lb {
                expose_lazybrain_env(lb);
            }

            if let Some(lb_for_thread) = lb.clone() {
                let brain_state_arc = app.state::<BrainState>().0.clone();
                let brain_path_for_thread = brain_path.clone();
                let brain_boot_defer_secs = boot_defer_secs;
                std::thread::spawn(move || {
                    // Boot-under-duress: this is THE single heaviest startup
                    // task in the whole app (a Node.js subprocess plus its
                    // own embedding-model load — see the RAM-crash incident
                    // `ensure_brain_init`'s own doc history references) so
                    // it is the clearest "pressure-heavy background start"
                    // the founder directive names. A plain blocking
                    // `std::thread::sleep` (not `tokio::time::sleep` — this
                    // is already a dedicated OS thread doing 100% blocking
                    // I/O, see this closure's own doc comment above) delays
                    // ONLY this thread; `.setup()` itself already returned
                    // long ago and the window is interactive regardless.
                    if brain_boot_defer_secs > 0 {
                        log::info!(
                            "Brain sidecar startup deferred {}s (boot pressure High) so the window/webview get full headroom first",
                            brain_boot_defer_secs
                        );
                        std::thread::sleep(std::time::Duration::from_secs(brain_boot_defer_secs));
                    }

                    // Auto-init: create the brain directory structure if
                    // absent (see ensure_brain_init's own doc comment for
                    // its failure-caching — this no longer re-attempts a
                    // known-failing init on every single boot). Store the
                    // outcome on BrainState right away so get_brain_connection
                    // can surface a genuine init failure to the UI instead of
                    // silently letting start_or_restart_brain_sidecar below
                    // boot a daemon against a brain init just declared broken
                    // (see BrainSidecar::init_failed_reason's doc comment) —
                    // overwritten with None the next time this brain_path is
                    // (re)initialized successfully (project switch, retry).
                    let init_failure = BrainSidecar::ensure_brain_init(&lb_for_thread, &brain_path_for_thread);
                    if let Ok(mut sidecar) = brain_state_arc.lock() {
                        sidecar.init_failed_reason = init_failure;
                    }

                    if start_or_restart_brain_sidecar(
                        &brain_state_arc, &lb_for_thread, &brain_path_for_thread, BRAIN_PORT,
                    ) {
                        let port = brain_state_arc.lock().map(|s| s.port).unwrap_or(BRAIN_PORT);
                        log::info!("Brain sidecar ready at :{}", port);
                    } else {
                        let port = brain_state_arc.lock().map(|s| s.port).unwrap_or(BRAIN_PORT);
                        log::warn!(
                            "Brain sidecar did not become healthy (last port tried: {}) — brain UI will degrade to mock mode",
                            port
                        );
                    }
                });
            } else {
                // Honest boot surface (M12 dogfood fix, MAJEUR #5): record
                // that the binary itself was never found — as opposed to
                // "found but not yet healthy" — so get_brain_connection can
                // report `binMissingReason` instead of the frontend reading
                // a silent zero/connection-refused indistinguishable from
                // "still starting up". See BrainSidecar::bin_missing's doc
                // comment.
                if let Ok(mut sidecar) = app.state::<BrainState>().0.lock() {
                    sidecar.bin_missing = true;
                }
                log::warn!("LazyBrain bin not found — brain sidecar not started");
            }

            // ── Spawn LazyBrain-Teams sidecar (when LAZY_TEAMS_ENABLED=1) ──
            //
            // Gated on the LAZY_TEAMS_ENABLED environment variable so solo users
            // are never affected.  The Tauri commands teams_health / teams_capture
            // are always registered — they fail gracefully when the sidecar is off.
            //
            // `wait_healthy` (teams_sidecar.rs) blocks synchronously for AT
            // LEAST ~5s (10 x 500ms sleep) and, measured, considerably more
            // when the sidecar never becomes healthy — see that function's
            // own doc comment for the measured ~25s worst case on this dev
            // machine, well past the "up to 5s" this comment used to assert
            // without measuring. Same cost SHAPE the brain sidecar used to
            // pay directly on this setup thread before it was moved onto its
            // own `std::thread::spawn` above (see that block's doc comment,
            // and commit 0e08036). Mirrored here: only cheap, non-blocking
            // work (env var read, script resolution, free-port probe) stays
            // inline; the actual spawn + health wait moves to a dedicated OS
            // thread so `.setup()` returns immediately even once this flag
            // is flipped on for team-brain users.
            if std::env::var("LAZY_TEAMS_ENABLED").as_deref() == Ok("1") {
                if let Some(script) = teams_sidecar::resolve_teams_script() {
                    let node_exe = lb
                        .as_ref()
                        .map(|lb| lb.node_exe.clone())
                        .unwrap_or_else(|| "node".to_string());

                    let data_dir = app
                        .path()
                        .app_local_data_dir()
                        .map(|d| d.join("lazy").join("teams").to_string_lossy().into_owned())
                        .unwrap_or_else(|_| "/tmp/lazy-teams".to_string());

                    let port = teams_sidecar::TeamsSidecar::find_free_port(7777);

                    // Clone the Arc, not the whole `App`/`AppHandle` — same
                    // "hand the thread only what it needs" shape as the
                    // brain sidecar thread above (`brain_state_arc`).
                    let teams_state_arc = app.state::<teams_sidecar::TeamsSidecarState>().0.clone();

                    // Read auth mode and JWT secret from env (server-side only).
                    // SUPABASE_JWT_SECRET is never exposed to the renderer process.
                    // auth_mode is empty for solo/demo — sidecar gets no auth env vars.
                    let auth_mode = std::env::var("TEAMS_AUTH_MODE").unwrap_or_default();
                    let jwt_secret = std::env::var("SUPABASE_JWT_SECRET").unwrap_or_default();

                    std::thread::spawn(move || {
                        // Delegates to `start_teams_sidecar_if_healthy` (this
                        // file, above `run()`), constructing a fresh
                        // `TeamsSidecarState` newtype around the cloned Arc —
                        // the function only ever locks `.0`, so this is
                        // identical to passing the original state handle.
                        let teams_state = teams_sidecar::TeamsSidecarState(teams_state_arc);
                        start_teams_sidecar_if_healthy(&teams_state, &node_exe, &script, port, &data_dir, &auth_mode, &jwt_secret);
                    });
                } else {
                    log::warn!("LAZY_TEAMS_ENABLED=1 but server script not found — sidecar not started");
                }
            }

            // ── Start local agent scheduler ───────────────────────
            //
            // Boot-under-duress: same `boot_defer_secs` deferral as journal
            // retention / worktree sweep / brain consolidator below — a
            // non-zero value (RAM pressure High OR crash-guard SafeMode, see
            // this closure's own check above) delays the `spawn_scheduler`
            // call itself so the window/webview get full headroom first;
            // zero (the common case) leaves this byte-for-byte the
            // pre-existing immediate-spawn call.
            {
                let project_state = app.state::<ProjectState>();
                let scheduler_state = app.state::<SchedulerState>();
                let agent_pids_state = app.state::<AgentPidState>();

                // Load initial schedules. Poison-safe (was
                // `.expect("scheduler lock")`): a poisoned lock degrades to
                // a logged warning and an empty schedule for this session,
                // same "never propagate a panic out of `.setup()`" contract
                // `commands::agent::kill_tracked_agent_pids` established for
                // this crate's other shared-state locks.
                let initial_agents = load_scheduled_agents(&project_state);
                match scheduler_state.agents.lock() {
                    Ok(mut guard) => *guard = initial_agents,
                    Err(e) => log::warn!(
                        "scheduler_state lock poisoned ({}) — starting with an empty schedule this session",
                        e
                    ),
                }

                let app_handle_for_scheduler = app.handle().clone();
                let scheduler_agents = scheduler_state.agents.clone();
                let scheduler_agent_pids = agent_pids_state.0.clone();
                if boot_defer_secs > 0 {
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(boot_defer_secs)).await;
                        spawn_scheduler(app_handle_for_scheduler, scheduler_agents, scheduler_agent_pids);
                    });
                    log::info!(
                        "Local agent scheduler deferred {}s (boot pressure High / crash-loop SafeMode)",
                        boot_defer_secs
                    );
                } else {
                    spawn_scheduler(app_handle_for_scheduler, scheduler_agents, scheduler_agent_pids);
                    log::info!("Local agent scheduler started");
                }
            }

            // ── Spawn the system pressure monitor (fix #4) ───────
            // Backs both the dream-gating check just below and the
            // `get_system_pressure` command / `system://pressure` event the
            // frontend can read directly. See system_pressure.rs's module
            // doc for the sampling/debounce design.
            {
                let pressure_state = app.state::<SystemPressureState>();
                spawn_pressure_monitor(app.handle().clone(), Arc::clone(&pressure_state.0));
                log::info!("System pressure monitor started (5s sampling, 2-sample debounce)");
            }

            // ── Spawn periodic brain consolidation (R4) ──────────
            // Runs the real 5-step maintenance sequence (dream, prune,
            // compress, interlink, profile-update — see maintenance.rs's
            // module doc for why each command/flag was chosen) every
            // CONSOLIDATE_INTERVAL_SECS. Non-LLM only (LAZYBRAIN_CLAUDE_BIN
            // sentinel). Claude Code JSONL ingested via R5 env pass. Gated
            // (fix #3, see maintenance.rs's "Dream gating" section) on
            // system pressure being Normal, no active user mission, and
            // either the 22:00-08:00 night window or 30+ min of
            // Normal-pressure idle.
            // Boot-under-duress: same `boot_defer_secs` deferral as journal
            // retention above — a non-zero value delays the
            // `spawn_brain_consolidator` call itself (and therefore its own
            // internal CONSOLIDATE_INTERVAL_SECS-first-pass timer) by that
            // many extra seconds; zero (comfortable pressure, the common
            // case) leaves this byte-for-byte the pre-existing immediate call.
            {
                let consolidate_brain_path = resolve_brain_path(app);
                let maint_pid_state = app.state::<MaintenancePidState>();
                let pressure_state = app.state::<SystemPressureState>();
                let missions_active_state = app.state::<MissionsActiveState>();
                let maint_arc = Arc::clone(&maint_pid_state.0);
                let pressure_arc = Arc::clone(&pressure_state.0);
                let missions_arc = Arc::clone(&missions_active_state.0);
                if boot_defer_secs > 0 {
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(boot_defer_secs)).await;
                        spawn_brain_consolidator(consolidate_brain_path, true, maint_arc, pressure_arc, missions_arc);
                    });
                    log::info!(
                        "Brain consolidator deferred {}s (boot pressure High), then interval={}s (non-LLM 5-step maintenance sequence, dream-gated)",
                        boot_defer_secs, CONSOLIDATE_INTERVAL_SECS
                    );
                } else {
                    spawn_brain_consolidator(consolidate_brain_path, true, maint_arc, pressure_arc, missions_arc);
                    log::info!(
                        "Brain consolidator started (interval={}s, non-LLM 5-step maintenance sequence, dream-gated)",
                        CONSOLIDATE_INTERVAL_SECS
                    );
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Kill daemon + orphaned child processes when the last window closes.
            if let tauri::WindowEvent::Destroyed = event {
                // AgentPidState is a plain HashMap<String, u32> with no Drop-based
                // cleanup — the OS does not kill child processes just because this
                // process exits, so tracked claude/codex CLI missions (and their
                // own child processes, tree-killed via /T) must be killed
                // explicitly here or they survive as orphans after the app closes.
                //
                // BrainState / TeamsSidecarState DO carry a Drop impl
                // (BrainSidecar / TeamsSidecar), but Drop does NOT run on this
                // exit path — Tauri/winit tears down the process once this
                // handler returns, before Rust gets a chance to run destructors
                // on managed state. Proven by real-app QA: after switching
                // project (set_project restarts the brain sidecar with a NEW
                // pid) and then closing the window, the LazyBrain sidecar
                // `node.exe lazybrain.js serve --port <port> --token <token>`
                // (plus its own worker child process) survived as an orphan —
                // still answering HTTP 200 on /_api/search — after
                // lazy-ide.exe had already exited. Both sidecars are now
                // stopped explicitly here, same as AgentPidState above, and
                // BrainSidecar::stop / TeamsSidecar::stop now tree-kill
                // (taskkill /PID <pid> /T /F) so the sidecar's own child
                // processes are reaped too, not just the direct pid.
                //
                // BrainState is constructed once and mutated in place across
                // project switches (see restart_brain_sidecar's doc comment in
                // commands/brain/config.rs), so this single call covers both
                // the first-launch sidecar and any post-switch restart — there
                // is always exactly one "current" pid being targeted.
                //
                // MANUAL QA RE-VERIFY (a real Destroyed event cannot be
                // triggered from `cargo test`): launch the app, switch project
                // at least once (so the sidecar restarts with a new pid), close
                // the window, then confirm via Task Manager / `tasklist` that
                // no `node.exe ... lazybrain.js serve` process (or child of it)
                // remains, and that GET http://127.0.0.1:<port>/_api/search no
                // longer answers. Repeat once WITHOUT switching project first
                // (first-launch sidecar only) to confirm that path too.
                //
                // Single-window app (see tauri.conf.json "windows": [...]) — the
                // main window's Destroyed event is equivalent to "the app is
                // closing" for this app.
                //
                // Mark shutdown BEFORE stopping the sidecar: the initial
                // sidecar startup (lib.rs's `.setup()`) now runs on a
                // background thread that may still be retrying on a
                // different port if the window closes within the first few
                // seconds of launch — see SHUTTING_DOWN's doc comment
                // (commands/brain/sidecar.rs) for the orphan-spawn race this
                // closes.
                //
                // IN-PLACE WEBVIEW RECOVERY GUARD: an intentional
                // destroy()-then-recreate of "main" (webview_recovery's
                // `recover_webview_in_place_or_restart`, triggered by
                // `install_webview_crash_restart_handler`'s ProcessFailed COM
                // callback) also destroys this same single window — WITHOUT
                // the app actually closing. Without this guard, EVERY
                // in-place recovery would run the exact full-shutdown
                // cleanup below (killing every mission child/sidecar) that
                // this whole feature exists to avoid.
                // `webview_recovery::is_recovery_in_progress()` reads true
                // for the recovery attempt's entire duration (both tries,
                // see that module's own doc comment) and only ever false
                // again once recovery either succeeds (process keeps
                // running, cleanup genuinely must NOT run) or gives up and
                // calls `request_restart()` (which clears the flag itself
                // before requesting the restart — that path DOES want the
                // ordinary cleanup, via `RunEvent::Exit` below, same as any
                // other restart).
                #[cfg(windows)]
                if webview_recovery::is_recovery_in_progress() {
                    log::info!(
                        "WindowEvent::Destroyed during an in-place WebView2 recovery — skipping run_exit_cleanup (sidecars/mission children stay alive)"
                    );
                    return;
                }

                // Delegates to `run_exit_cleanup` (this file, above `run()`)
                // — the SAME steps now also run from `RunEvent::Exit` below
                // (fix #1: a restart previously skipped all of this
                // entirely, see that function's doc comment for the P42
                // root cause). Safe to run from both paths: every step is
                // independently idempotent.
                run_exit_cleanup(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_dir,
            commands::fs::read_file,
            commands::fs::read_file_base64,
            commands::fs::read_text_file,
            commands::fs::write_file,
            commands::fs::append_to_file,
            commands::fs::get_project_root,
            commands::fs::get_cwd,
            commands::fs::find_git_root,
            commands::brain::config::set_project,
            commands::brain::config::project_register,
            commands::brain::config::project_create,
            commands::brain::config::project_set_active,
            commands::brain::config::project_close,
            commands::brain::config::project_list,
            commands::terminal::terminal_spawn,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill,
            commands::git::git_status,
            commands::git::git_diff,
            commands::git::git_current_branch,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_commit,
            commands::git::git_push,
            commands::git::git_can_push,
            commands::git::git_orphan_worktrees,
            commands::git::git_branches,
            commands::git::git_log,
            commands::fs::fs_rename,
            commands::fs::fs_remove,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::brain::sidecar::get_brain_port,
            commands::brain::sidecar::get_brain_connection,
            commands::brain::config::get_brain_info,
            commands::brain::config::set_brain_config,
            commands::brain::config::brain_retry_sidecar,
            commands::brain::config::import_brain_from_github,
            commands::brain::publish::brain_publish_github,
            commands::brain::sidecar::brain_fetch_graph,
            commands::brain::sidecar::brain_fetch_note_meta,
            commands::brain::sidecar::brain_fetch_search,
            commands::brain::sidecar::brain_fetch_backlinks,
            commands::brain::sidecar::brain_fetch_neighbors,
            commands::brain::capture::brain_capture,
            commands::brain::capture::brain_rebuild_graph,
            commands::brain::capture::brain_recompose_all,
            commands::brain::config::get_brain_projects,
            commands::brain::config::set_brain_projects,
            commands::brain::config::brain_fetch_graph_merged,
            commands::brain::config::brain_fetch_health,
            commands::brain::config::brain_stats,
            commands::brain::config::brain_health_detail,
            commands::brain::config::brain_wipe,
            commands::brain::config::brain_query_css,
            commands::brain::config::brain_neighbours,
            commands::teams::teams_health,
            commands::teams::teams_write_org_context,
            commands::teams::teams_resync,
            commands::teams::teams_active_config_read,
            commands::teams::teams_active_config_write,
            commands::teams::teams_active_config_clear,
            commands::teams::teams_archive_copy,
            commands::teams_git::teams_pull_repo,
            commands::teams_git::teams_push_repo,
            commands::github_oauth::github_oauth_device_code,
            commands::github_oauth::github_oauth_poll_token,
            commands::github_oauth::github_api_get,
            commands::github_oauth::github_api_post,
            commands::github_oauth::teams_github_token_write,
            commands::github_oauth::teams_github_token_read,
            commands::github_oauth::teams_github_token_clear,
            commands::vault::secret_set,
            commands::vault::secret_get,
            commands::vault::secret_presence,
            commands::vault::secret_delete,
            solari_cdp_proxy::solari_cdp_proxy_base,
            commands::shell::run_tests,
            commands::shell::run_shell,
            commands::shell::is_worktree_script_eligible,
            commands::shell::run_worktree_script,
            commands::chat::model_chat_stream,
            commands::chat::claude_available,
            commands::chat::claude_chat_stream,
            commands::chat::claude_chat_stream_cancel,
            commands::chat::codex_chat_stream_cancel,
            commands::chat::agent_cli_available,
            commands::chat::agent_cli_chat_stream,
            commands::git::agent_create_worktree,
            commands::git::agent_worktree_diff,
            commands::git::agent_merge_worktree,
            commands::git::agent_discard_worktree,
            commands::git::git_revert_merge,
            commands::agent::agent_run,
            commands::agent::agent_run_kill,
            commands::agent::agent_run_live_ids,
            commands::agent::lazy_agents_list,
            commands::agent::lazy_agent_save,
            commands::agent::lazy_agent_delete,
            commands::agent::reload_agent_schedules,
            commands::agent::agent_schedule_cloud_stub,
            commands::brain::search::brain_fetch_search_scoped,
            commands::brain::search::brain_fetch_recall_scoped,
            commands::brain::search::brain_fetch_startup_context,
            commands::brain::history_import::detect_history_sources,
            commands::brain::history_import::brain_seed_estimate,
            commands::brain::history_import::brain_seed,
            lsp::lsp_start,
            lsp::lsp_request,
            lsp::lsp_notify,
            lsp::lsp_stop,
            lsp::lsp_available,
            commands::brain::maintenance::brain_consolidate_now,
            commands::brain::ops::brain_ops_status,
            commands::web::web_fetch,
            commands::web::web_search,
            commands::journal::journal_emit,
            commands::journal::journal_emit_batch,
            commands::journal::journal_query_events,
            commands::journal::journal_since,
            commands::journal::journal_missions_current,
            commands::journal::journal_fleet_overview,
            commands::journal::journal_attention_inbox,
            commands::journal::journal_activity_feed,
            commands::journal::journal_agent_stats,
            commands::journal::journal_retention_run,
            commands::journal::journal_frontend_error,
            commands::canvas::canvas_state_load,
            commands::canvas::canvas_state_save,
            commands::mcp::mcp_spawn_server,
            commands::mcp::mcp_call_server,
            commands::mcp::mcp_send_server_stdin,
            commands::mcp::mcp_stop_server,
            commands::mcp::mcp_sse_call,
            commands::browser::browser_playwright_open,
            commands::browser::browser_playwright_navigate,
            commands::browser::browser_playwright_click,
            commands::browser::browser_playwright_fill,
            commands::browser::browser_playwright_screenshot,
            commands::browser::browser_playwright_snapshot,
            commands::browser::browser_playwright_close,
            commands::browser_recipe::browser_recipe_open,
            commands::browser_recipe::browser_recipe_step,
            commands::browser_recipe::browser_recipe_close,
            commands::brain::maintenance::set_missions_active,
            commands::system_pressure::get_system_pressure,
            commands::util::get_abandoned_drain_thread_count,
            crash_guard::get_startup_recovery_state,
            runner::commands::runner_status,
            runner::commands::runner_ensure_started,
            updater_service::updater_check,
            updater_service::updater_download,
            updater_service::updater_state,
            updater_service::updater_set_auto,
            updater_service::updater_ignore_version,
            updater_service::updater_clear_staged,
            updater_service::updater_restart_and_apply,
        ])
        .build(context)
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // `Builder::run(context)` (the convenience method this replaces)
            // is EXACTLY `self.build(context)?.run(|_, _| {})` — see that
            // method's own source (tauri 2.11.3, app.rs) — i.e. a hard-coded
            // NO-OP callback. `RunEvent::Exit` fires on EVERY path that
            // tears the process down, including `AppHandle::request_restart()`
            // (traced: `make_run_event_loop_callback` invokes this callback
            // for `RuntimeRunEvent::Exit` BEFORE any restart happens) — the
            // exact gap that orphaned the brain sidecar on every restart
            // before this fix (see `run_exit_cleanup`'s doc comment for the
            // full P42 root-cause trace). The `WindowEvent::Destroyed`
            // handler above is kept as-is for the ordinary last-window-closes
            // path; both call the same idempotent cleanup.
            if let tauri::RunEvent::Exit = event {
                run_exit_cleanup(app_handle);
            }

            // IN-PLACE WEBVIEW RECOVERY GUARD, part 2 (part 1 is the
            // `WindowEvent::Destroyed` guard in `.on_window_event` above):
            // destroying the sole "main" window from
            // `webview_recovery::recover_webview_in_place_or_restart` makes
            // tauri's runtime treat it as "the last window closed" and fire
            // `RunEvent::ExitRequested` — which, left unhandled, commits the
            // app to exiting (the `RunEvent::Exit` handled above runs next)
            // BEFORE the recreated window can keep the process alive. A real
            // crash test proved this exact gap: the log confirmed "WebView2
            // in-place recovery succeeded on attempt 1/2", yet zero
            // lazy-ide.exe processes remained afterward.
            // `webview_recovery::is_recovery_in_progress()` stays true for
            // the destroy-then-rebuild sequence's entire duration — set
            // before `.destroy()` is even called, cleared only once
            // `WebviewWindowBuilder::build()` has actually returned `Ok`
            // (see `recover_webview_in_place_or_restart`'s own doc comment in
            // webview_recovery.rs) — so it reliably tells apart this
            // in-flight recovery from an ordinary user-initiated exit, which
            // must keep behaving exactly as before (no `prevent_exit()`
            // call, so the ordinary shutdown proceeds untouched).
            #[cfg(windows)]
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if webview_recovery::is_recovery_in_progress() {
                    log::info!(
                        "ExitRequested during in-place WebView2 recovery — prevented (window is being recreated)"
                    );
                    api.prevent_exit();
                }
            }
        });
}

// ── Permission helpers ─────────────────────────────────────────────

/// Map a `permission_mode` string to the CLI flag that must be appended to the
/// `claude` invocation.  This is a pure function so it can be unit-tested without
/// spinning up a real Tauri context.
///
/// Mapping:
///   None / "acceptEdits"     → "--permission-mode=acceptEdits"  (safe default for worktrees)
///   "plan"                   → "--permission-mode=plan"          (read-only / produce a plan)
///   "full" | "bypassPermissions" → "--dangerously-skip-permissions"  (full autonomy, user opt-in only)
///   "default" | anything else → "" (no extra flag)
pub(crate) fn permission_flag(mode: Option<&str>) -> &'static str {
    match mode.unwrap_or("acceptEdits") {
        "full" | "bypassPermissions" => "--dangerously-skip-permissions",
        "plan"                       => "--permission-mode=plan",
        "acceptEdits"                => "--permission-mode=acceptEdits",
        "default" | ""               => "",  // expected: no extra flag
        _ => {
            eprintln!("[lazy] unknown permission_mode: {:?}; falling back to acceptEdits flag", mode);
            ""
        }
    }
}

#[cfg(test)]
mod tests {
    /// None defaults to acceptEdits (safe worktree default, no silent bypass).
    #[test]
    fn permission_flag_none_defaults_to_accept_edits() {
        let flag = super::permission_flag(None);
        assert_eq!(flag, "--permission-mode=acceptEdits",
            "None must map to acceptEdits, not bypassPermissions");
        eprintln!("permission_flag_none_defaults_to_accept_edits PASSED: {}", flag);
    }

    /// "acceptEdits" maps to --permission-mode=acceptEdits.
    #[test]
    fn permission_flag_accept_edits() {
        let flag = super::permission_flag(Some("acceptEdits"));
        assert_eq!(flag, "--permission-mode=acceptEdits");
        eprintln!("permission_flag_accept_edits PASSED");
    }

    /// "plan" maps to --permission-mode=plan (read-only).
    #[test]
    fn permission_flag_plan() {
        let flag = super::permission_flag(Some("plan"));
        assert_eq!(flag, "--permission-mode=plan");
        eprintln!("permission_flag_plan PASSED");
    }

    /// "full" maps to --dangerously-skip-permissions (explicit user opt-in).
    #[test]
    fn permission_flag_full_maps_to_bypass() {
        let flag = super::permission_flag(Some("full"));
        assert_eq!(flag, "--dangerously-skip-permissions",
            "'full' must map to bypass flag");
        eprintln!("permission_flag_full_maps_to_bypass PASSED");
    }

    /// Legacy "bypassPermissions" still maps to the bypass flag (backward compat).
    #[test]
    fn permission_flag_bypass_permissions_legacy() {
        let flag = super::permission_flag(Some("bypassPermissions"));
        assert_eq!(flag, "--dangerously-skip-permissions");
        eprintln!("permission_flag_bypass_permissions_legacy PASSED");
    }

    /// "default" produces no extra flag.
    #[test]
    fn permission_flag_default_no_extra_flag() {
        let flag = super::permission_flag(Some("default"));
        assert_eq!(flag, "");
        eprintln!("permission_flag_default_no_extra_flag PASSED");
    }

    /// Cold-boot regression guard (perf audit 2026-08-15): `start_teams_sidecar_if_healthy`
    /// calls `TeamsSidecar::wait_healthy`, which blocks synchronously for a
    /// 5s floor and, measured, up to ~25s on the failure path (see
    /// `teams_sidecar::tests::wait_healthy_blocking_cost_against_unreachable_port_is_measured`
    /// and that function's own doc comment). This MUST run off the Tauri
    /// `.setup()` thread — the same bug class
    /// commit 0e08036 fixed for the brain sidecar (see the `std::thread::spawn`
    /// this file wraps the brain-sidecar boot in, a few hundred lines above
    /// the teams-sidecar block this test inspects).
    ///
    /// This is a structural/source guard, not a runtime timing measurement:
    /// `App::setup`'s closure cannot be invoked from a plain `#[test]`
    /// without a live Tauri window, so there is no way to assert "the setup
    /// thread was not blocked" by actually running `.setup()` in this test
    /// binary. What this test CAN and does check: the call site text is
    /// still present in this file, and a `std::thread::spawn(` appears
    /// between the "Spawn LazyBrain-Teams sidecar" section comment and that
    /// call site. It catches someone deleting the thread-spawn wrapper and
    /// re-inlining the call directly into `.setup()` (the exact regression
    /// this fix addresses); it will NOT catch a more creative regression
    /// (e.g. moving the call into a *different*, already-blocking spawn) —
    /// that class of bug needs the real timing test above, or a live
    /// cold-boot benchmark, neither of which this unit-test suite can host.
    #[test]
    fn teams_sidecar_health_wait_stays_off_setup_thread() {
        let src = include_str!("lib.rs");
        let section_marker = "Spawn LazyBrain-Teams sidecar";
        let section_pos = src
            .find(section_marker)
            .expect("section comment moved/renamed — update this guard's marker text");

        let call_site = "start_teams_sidecar_if_healthy(&teams_state, &node_exe, &script, port, &data_dir, &auth_mode, &jwt_secret);";
        let call_pos = src[section_pos..]
            .find(call_site)
            .map(|rel| section_pos + rel)
            .expect("start_teams_sidecar_if_healthy call site text moved — update this guard");

        let between = &src[section_pos..call_pos];
        assert!(
            between.contains("std::thread::spawn("),
            "start_teams_sidecar_if_healthy is no longer wrapped in std::thread::spawn — \
             this reintroduces the ~5s blocking cold-boot stall on the Tauri setup thread \
             once LAZY_TEAMS_ENABLED=1 (see teams_sidecar.rs wait_healthy)"
        );
        eprintln!("teams_sidecar_health_wait_stays_off_setup_thread PASSED");
    }

    /// Cold-boot regression guard, item 5 of the same 2026-08-15 perf audit:
    /// the audit found `missionPerfGuard.test.ts` covers mission
    /// system-prompt character budgets, NOT startup, and that literally NO
    /// test anywhere measured cold-boot wall-clock — which is exactly how
    /// the original brain-sidecar regression (commit 0e08036 fixed it: ~7s
    /// -> ~1.7s cold start, see the "Spawn LazyBrain daemon sidecar (off the
    /// setup thread)" block above) could have silently reappeared with zero
    /// warning. This is the SAME structural-guard technique as
    /// `teams_sidecar_health_wait_stays_off_setup_thread` above, applied to
    /// the brain sidecar's own call site — closing the gap for BOTH
    /// sidecars this file spawns, not just the one item 1 of this audit
    /// touched.
    ///
    /// Same honest limitation as its teams-sidecar counterpart: structural
    /// (greps this file's own source for the call site still living inside
    /// a `std::thread::spawn(`), not a live timing measurement — catches
    /// "someone deleted the thread-spawn wrapper and re-inlined the call
    /// onto `.setup()`", not every conceivable regression shape.
    #[test]
    fn brain_sidecar_boot_stays_off_setup_thread() {
        let src = include_str!("lib.rs");
        let section_marker = "Spawn LazyBrain daemon sidecar (off the setup thread)";
        let section_pos = src
            .find(section_marker)
            .expect("section comment moved/renamed — update this guard's marker text");

        let call_site = "if start_or_restart_brain_sidecar(";
        let call_pos = src[section_pos..]
            .find(call_site)
            .map(|rel| section_pos + rel)
            .expect("start_or_restart_brain_sidecar call site text moved — update this guard");

        let between = &src[section_pos..call_pos];
        assert!(
            between.contains("std::thread::spawn("),
            "start_or_restart_brain_sidecar is no longer wrapped in std::thread::spawn — \
             this reintroduces the ~7s blocking cold-boot stall on the Tauri setup thread \
             commit 0e08036 originally fixed (ensure_brain_init + the sidecar health wait)"
        );
        eprintln!("brain_sidecar_boot_stays_off_setup_thread PASSED");
    }
}

// Pure decision-logic unit tests for in-place WebView2 recovery now live in
// `webview_recovery.rs`'s own `mod tests`, alongside the functions they
// exercise — see that module's doc comment for why this whole subsystem was
// extracted out of this file.
