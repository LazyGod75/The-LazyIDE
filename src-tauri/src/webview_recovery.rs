//! Crash resilience layer A (Windows only) — WebView2 in-place recovery.
//!
//! Attaches an `ICoreWebView2::add_ProcessFailed` handler to the "main"
//! window (`install_webview_crash_restart_handler`, called once from
//! `lib.rs`'s `run()`, inside `.setup()`) so a crashed WebView2 child
//! process (the renderer/GPU/browser process WebView2 spawns to actually run
//! the page — a SEPARATE process tree from lazy-ide.exe itself) triggers the
//! CHEAPEST recovery that actually fixes it, instead of either doing nothing
//! or reflexively tearing the whole app down.
//!
//! ROUTING OVERHAUL (2026-07-24): journal forensics proved the previous
//! binary "in-place recovery vs. full restart" split was actively harmful —
//! kind 6 (`GPU_PROCESS_EXITED`, which WebView2 auto-recovers on its own per
//! Microsoft's docs) and kind 1 (`RENDER_PROCESS_EXITED`, recoverable with a
//! plain `Reload()`) were both forcing a FULL app restart, killing every
//! running mission for failures that needed no app-level intervention at
//! all, or at most a reload. `decide_recovery_action` (pure, unit-tested
//! exhaustively below) now routes each `COREWEBVIEW2_PROCESS_FAILED_KIND`
//! to one of four `RecoveryAction`s — `LogOnly`, `ReloadWebview`,
//! `RecreateInPlace`, `FullRestart` — see that function's own doc comment
//! for the full policy table. A STORM BREAKER overrides all of it: 3+
//! failures of ANY kind within a 10-minute window force `FullRestart`
//! regardless of what each kind's own policy says, because at that point
//! something is deeply wrong (this app runs on a memory-starved machine
//! where repeated failures are a real risk, not a theoretical one) and a
//! restart is the only path with evidence it actually recovers.
//!
//! `RecreateInPlace` (kinds 0 and 2, or `ReloadWebview`'s own fallback):
//! destroy just the dead "main" `WebviewWindow` and recreate it from the
//! same tauri.conf.json config (same label/URL — see
//! `try_recreate_main_window`), all without exiting the process. See
//! `recover_webview_in_place_or_restart` (and the `run_recovery_sequence`
//! helper it delegates to) for the retry-then-fall-back sequencing, and
//! `is_recovery_in_progress` for why the ordinary `WindowEvent::Destroyed`
//! → `run_exit_cleanup` path (`lib.rs`'s `.on_window_event`) must NOT fire
//! while this is in flight.
//!
//! RE-ARM FIX (2026-07-24): a real crash test proved in-place recovery only
//! ever worked ONCE per app session — after a successful recreate, killing
//! the (new) renderer process again produced ZERO `ProcessFailed` log
//! output, not even this module's own unconditional first `log::warn!`
//! line. Root cause: `add_ProcessFailed`'s COM registration lives on the
//! specific `ICoreWebView2` instance `install_webview_crash_restart_handler`
//! attached it to, and that instance dies along with the "main" window
//! `try_recreate_main_window` destroys — recreating the window builds a
//! BRAND NEW `ICoreWebView2` with no handler on it at all. Fixed by having
//! `run_recovery_sequence` call `install_webview_crash_restart_handler`
//! again immediately after every successful recreate — see that function's
//! own doc comment for why this is safe to call more than once (no
//! double-registration risk) and how it dispatches across threads.
//!
//! Module-scoped (not folded back into `lib.rs`'s composition-root body) so
//! this whole self-contained subsystem — decision logic, retry sequencing,
//! the COM handler itself, and its own unit tests — stays one cohesive file
//! instead of growing the already-large `lib.rs` further (this crate's own
//! "many small files" convention, see e.g. `commands/`'s per-subsystem
//! module split).
//!
//! # MANUAL QA (cannot be exercised from `cargo test`)
//!
//! Everything COM/WebView2-touching here (`install_webview_crash_restart_handler`,
//! `try_recreate_main_window`, and therefore `recover_webview_in_place_or_restart`
//! end to end) needs a real running app + a real WebView2 runtime — there is
//! no way to fake `ICoreWebView2::add_ProcessFailed` firing, a real
//! `ICoreWebView2::Reload()` round-trip, an actual `WebviewWindowBuilder::build()`,
//! or a real `.destroy()` from `cargo test`. Only the pure DECISION logic
//! around these (`decide_recovery_action`, `next_recovery_step`) and the
//! pure SEQUENCING around them (`run_recovery_sequence` — in particular,
//! that a successful recreate is always followed by exactly one handler
//! reinstall) is unit-tested (see `mod tests` below) — re-verify the COM
//! paths by hand after any change here:
//!
//! 1. **In-place recovery, browser process kind** — launch the app, open
//!    Task Manager, find the WebView2 "Browser" process (the one WITHOUT a
//!    tab-specific title, parented under `msedgewebview2.exe`, not
//!    `lazy-ide.exe`), end it. Expect: the window goes blank very briefly
//!    then repaints with the SAME route/state it had before (localStorage
//!    persistence — open the brain/canvas/a project first so there is
//!    visible state to check), `lazy-ide.exe` itself never disappears from
//!    Task Manager, and any running mission's Claude/Codex CLI child process
//!    (start one first) is STILL RUNNING throughout. Confirm the log file
//!    (`<LocalAppData>\<bundle id>\logs`) shows `"WebView2 in-place recovery
//!    succeeded on attempt 1/2"`, never `"falling back to a full app
//!    restart"`.
//! 2. **Render-process-exited kind (Reload path)** — kill the WebView2
//!    "Content" (renderer) process for the main window without killing the
//!    browser process itself. Expect: the log shows `"WebView2 Reload()
//!    succeeded"`, the window repaints without a full window recreate or an
//!    app restart, and any running mission's CLI child process is STILL
//!    RUNNING throughout.
//! 3. **Render-process-unresponsive kind** — harder to trigger deliberately
//!    (needs a genuinely hung page, not just a slow one); if reproduced
//!    (e.g. via a deliberately blocking `while(true){}` injected in devtools
//!    on a throwaway build), expect the same in-place recovery as #1.
//! 4. **Fallback-to-restart path** — hardest to force outside a debugger
//!    (would need `try_recreate_main_window` to fail twice in a row, e.g. by
//!    renaming/removing the frontend's `index.html` asset before triggering
//!    a browser-process kill on a debug build) — if reproduced, expect the
//!    log to show two failed attempts followed by `"falling back to a full
//!    app restart"`, then the ordinary full-restart behavior (same as
//!    before this feature existed): `lazy-ide.exe` itself relaunches, every
//!    sidecar/mission child is cleaned up first (`run_exit_cleanup`).
//! 5. **Storm breaker** — trigger 3 process failures of any kind (even
//!    LogOnly ones, e.g. repeated GPU process kills) within 10 minutes;
//!    expect the 3rd one to force a full restart regardless of its own
//!    kind's ordinary policy.
//! 6. **Handler survives a recovery — kill browser THEN kill renderer
//!    (regression test for the "recovery only works once per session" bug,
//!    fixed 2026-07-24, see the module doc comment's "RE-ARM FIX" note)** —
//!    run #1 above first (kill the WebView2 "Browser" process, confirm
//!    in-place recovery succeeds and the window repaints). THEN, in that
//!    SAME app session without relaunching, immediately run #2 above (kill
//!    the "Content"/renderer process) against the now-RECOVERED window.
//!    Expect the same kind of `"WebView2 Reload() succeeded for
//!    process-failed kind 1"` log line as step #2 — proving
//!    `install_webview_crash_restart_handler` was re-armed on the recreated
//!    window. Before the fix, this second step produced ZERO
//!    `ProcessFailed`-related log lines whatsoever (not even the handler's
//!    own unconditional first `log::warn!` line) and the page stayed dead
//!    forever, because the COM registration died along with the "main"
//!    window step #1's recovery destroyed.
//! 7. **`app.recovered` / `app.processFailedIgnored` journal rows** — after
//!    #1-#4 above, open the FLUX ticker (cockpit footer) and confirm the
//!    friendly line appears (in-place / reload / restart each read
//!    distinctly) — never raw JSON, never silence. A LogOnly kind (e.g. a
//!    GPU process death that WebView2 auto-recovers) should NOT produce a
//!    user-visible FLUX line, only a journal row for telemetry.
//! 8. **`WindowEvent::Destroyed` guard** — during #1, confirm via Task
//!    Manager that the brain sidecar (`node.exe ... lazybrain.js serve`)
//!    and any tracked agent CLI process are NOT killed — this is the exact
//!    regression `is_recovery_in_progress` exists to prevent (see
//!    `lib.rs`'s `.on_window_event` `WindowEvent::Destroyed` handler).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::state::JournalState;

/// Guards `lib.rs`'s `.on_window_event` `WindowEvent::Destroyed` handler
/// against treating an INTENTIONAL destroy-then-recreate
/// (`recover_webview_in_place_or_restart` below) as "the app is closing"
/// and tearing down every mission child / sidecar via `run_exit_cleanup` —
/// exactly the outcome this whole feature exists to avoid ("sidecars, PTYs
/// and mission children survive untouched").
///
/// Set true immediately before `.destroy()`-ing the crashed "main" window;
/// cleared the moment recovery is done ONE WAY OR THE OTHER — on a
/// successful recreate (a real app-exit cleanup is still NOT wanted: the
/// process keeps running) and also right before falling back to
/// `request_restart()` (where a real app-exit cleanup IS wanted again, same
/// as any other restart — `run_exit_cleanup` runs from `RunEvent::Exit`
/// regardless, see that function's own doc comment in `lib.rs`).
///
/// A plain module-level `AtomicBool`, not `tauri::State` — mirrors
/// `commands::brain::sidecar`'s `SHUTTING_DOWN` static exactly (same
/// "app-lifetime, no per-window scoping needed" shape). Private to this
/// module — `lib.rs` reads it only through `is_recovery_in_progress` below,
/// never the raw atomic.
static WEBVIEW_RECOVERY_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Whether an in-place recovery is currently in flight — see
/// `WEBVIEW_RECOVERY_IN_PROGRESS`'s own doc comment. `lib.rs`'s
/// `.on_window_event` calls this (not the raw atomic) so the storage detail
/// stays this module's own.
pub(crate) fn is_recovery_in_progress() -> bool {
    WEBVIEW_RECOVERY_IN_PROGRESS.load(Ordering::SeqCst)
}

/// Attach an `ICoreWebView2::add_ProcessFailed` handler to whichever webview
/// currently holds the "main" label — resolved fresh via
/// `app.get_webview_window("main")` on every call, never cached.
///
/// TWO call sites, by design: once from `lib.rs`'s `run()` `.setup()` at
/// startup, and again from `run_recovery_sequence` (via
/// `recover_webview_in_place_or_restart`) immediately after every
/// successful `try_recreate_main_window` — see the module doc comment's
/// "RE-ARM FIX" note for the real-crash-test evidence that the second call
/// site is not optional: `add_ProcessFailed`'s COM registration lives on
/// the specific `ICoreWebView2` instance this function attaches it to, and
/// that instance dies along with the "main" window `try_recreate_main_window`
/// destroys, so recreating the window without repeating this call leaves
/// the recovered window with NO crash handler at all.
///
/// The SAME function on purpose, not a startup-only variant plus a separate
/// "reinstall" variant: it already does exactly what a re-arm needs
/// (resolve "main" fresh, attach to whatever COM object that resolves to
/// right now), so reuse needs no parameter changes.
///
/// NO double-registration risk between the two call sites (no explicit
/// token/state guard needed): each call resolves "main" AT CALL TIME and
/// only ever lands on a webview that has never had this function called on
/// it before — the startup call targets the config-created window; every
/// recovery call targets a BRAND NEW window `try_recreate_main_window` just
/// finished building, whose predecessor (and that predecessor's own
/// registration) is already destroyed by the time this runs.
///
/// THREADING: safe to call from ANY thread, including the background
/// `std::thread::spawn` `recover_webview_in_place_or_restart` runs on — no
/// extra `run_on_main_thread` wrapping needed. Confirmed by reading tauri
/// 2.11.3's own source rather than assuming: `Webview::with_webview`
/// (`webview/mod.rs`) is documented "The closure is executed on the main
/// thread", and `tauri-runtime-wry`'s `WryWebviewDispatcher::with_webview`
/// funnels through `send_user_message`, which checks
/// `current_thread().id() == context.main_thread_id` — on the main thread
/// (true for the `.setup()` call site) it runs the closure in place
/// immediately; from any OTHER thread (true for the recovery call site) it
/// posts the closure to the main thread's event loop via
/// `EventLoopProxy::send_event` instead and returns without waiting.
/// `with_webview` already IS the dispatch primitive — it does not need to be
/// called from inside another main-thread dispatch.
///
/// Both the `with_webview` dispatch and attaching the COM event handler
/// inside it are fallible (the controller/CoreWebView2 not being ready yet,
/// the COM call itself failing, `with_webview`'s own dispatch failing) —
/// every failure path just logs a warning and returns, never panics or
/// blocks startup. `with_webview` also cannot report what happened INSIDE
/// the closure (its `Result` only covers whether the dispatch itself
/// succeeded), so the closure logs its own failures rather than trying to
/// thread an error back out.
pub(crate) fn install_webview_crash_restart_handler(app: &tauri::AppHandle) {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND;
    use webview2_com::ProcessFailedEventHandler;

    let Some(window) = app.get_webview_window("main") else {
        log::warn!("install_webview_crash_restart_handler: no \"main\" webview window found — skipping");
        return;
    };

    let app_handle = app.clone();
    let dispatched = window.with_webview(move |platform_webview| {
        let controller = platform_webview.controller();
        let webview = match unsafe { controller.CoreWebView2() } {
            Ok(webview) => webview,
            Err(e) => {
                log::warn!("install_webview_crash_restart_handler: CoreWebView2() failed: {}", e);
                return;
            }
        };

        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            // ProcessFailedKind (see COREWEBVIEW2_PROCESS_FAILED_KIND) tells
            // apart a renderer crash from a GPU/utility/PPAPI process crash
            // etc. — best-effort only: a failure reading it still logs and
            // still routes (via this module's own `-1` sentinel, see
            // `decide_recovery_action`'s doc comment), it just loses the
            // "kind" detail in the log line.
            let kind = args
                .as_ref()
                .and_then(|a| {
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(-1);
                    unsafe { a.ProcessFailedKind(&mut kind) }.ok().map(|_| kind.0)
                })
                .unwrap_or(-1);
            log::warn!("WebView2 reported a process failure (kind={})", kind);

            let now = Instant::now();
            let recent = record_failure_and_snapshot(kind, now);
            let action = decide_recovery_action(kind, &recent, now);
            log::info!("process-failed kind {} routed to {:?}", kind, action);

            match action {
                RecoveryAction::LogOnly => {
                    // WebView2 auto-recovers this class of failure on its
                    // own (frame-render/utility/sandbox/GPU/PPAPI/unknown) —
                    // telemetry only, no app-level intervention.
                    emit_process_failed_ignored_journal_event(&app_handle, kind);
                }
                RecoveryAction::ReloadWebview => {
                    // `sender` is the `ICoreWebView2` whose process failed —
                    // `Reload()` is the Microsoft-documented recovery for a
                    // plain RENDER_PROCESS_EXITED, much cheaper than
                    // recreating the whole window. Any failure to even
                    // attempt it (no sender) or a COM-level error from the
                    // call itself falls back to the same in-place recreate
                    // kind 0/2 use — never silently drops the failure.
                    //
                    // NO handler re-registration needed on the success path
                    // below (unlike `RecreateInPlace`, see
                    // `install_webview_crash_restart_handler`'s own doc
                    // comment for why THAT path must re-arm): confirmed from
                    // Microsoft's own WebView2 docs (learn.microsoft.com,
                    // "Process model for WebView2 apps" + the
                    // `COREWEBVIEW2_PROCESS_FAILED_KIND` reference) that a
                    // renderer process is a child managed by the lifetime of
                    // the single browser process a `CoreWebView2Environment`
                    // owns — `RENDER_PROCESS_EXITED` (kind 1) only kills that
                    // child. The `ICoreWebView2` COM object itself, and every
                    // event registration attached to it (including this very
                    // `add_ProcessFailed` handler), lives at the
                    // browser-process level, one level up; only
                    // `BROWSER_PROCESS_EXITED` (kind 0, routed to
                    // `RecreateInPlace` above) invalidates it. `Reload()`
                    // below just asks the still-alive browser process to
                    // spin up a fresh renderer and re-navigate — `sender`
                    // survives the call as the SAME COM object, so this
                    // handler's registration on it stays valid with no
                    // action needed here.
                    let reload_result = sender.as_ref().map(|s| unsafe { s.Reload() });
                    match reload_result {
                        Some(Ok(())) => {
                            log::info!("WebView2 Reload() succeeded for process-failed kind {}", kind);
                            emit_recovery_journal_event(&app_handle, "reload");
                        }
                        other => {
                            log::warn!(
                                "WebView2 Reload() unavailable or failed for kind {} ({:?}) — falling back to in-place recreate",
                                kind, other
                            );
                            let app_for_thread = app_handle.clone();
                            std::thread::spawn(move || {
                                recover_webview_in_place_or_restart(&app_for_thread);
                            });
                        }
                    }
                }
                RecoveryAction::RecreateInPlace => {
                    // Recreating a window deadlocks if done synchronously on
                    // this COM callback's own thread (the same UI/event-loop
                    // thread — see `try_recreate_main_window`'s doc comment
                    // for the exact Tauri-documented hazard this avoids):
                    // hand the whole destroy+recreate sequence to a fresh,
                    // unrelated OS thread instead, matching this crate's own
                    // established pattern for exactly this class of problem
                    // (the brain sidecar boot thread in `lib.rs`'s `run()`'s
                    // `.setup()`).
                    let app_for_thread = app_handle.clone();
                    std::thread::spawn(move || {
                        recover_webview_in_place_or_restart(&app_for_thread);
                    });
                }
                RecoveryAction::FullRestart => {
                    // Only ever reached via the storm breaker (see
                    // `decide_recovery_action`'s doc comment) — no
                    // individual kind maps to this directly anymore.
                    log::warn!(
                        "process-failed storm breaker triggered (repeated failures within the storm window) — requesting a full app restart"
                    );
                    emit_recovery_journal_event(&app_handle, "restart");
                    app_handle.request_restart();
                }
            }
            Ok(())
        }));

        let mut token: i64 = 0;
        if let Err(e) = unsafe { webview.add_ProcessFailed(&handler, &mut token) } {
            log::warn!("install_webview_crash_restart_handler: add_ProcessFailed failed: {}", e);
        }
    });
    if let Err(e) = dispatched {
        log::warn!("install_webview_crash_restart_handler: with_webview dispatch failed: {}", e);
    }
}

/// One recorded `ProcessFailed` event, kept in a small capped in-memory
/// ring so `decide_recovery_action`'s storm-breaker check (see that
/// function's own doc comment) has real history to look at. `Instant`, not
/// wall-clock time: only ever compared against other `Instant`s from this
/// same process run, immune to system clock changes mid-session.
#[derive(Debug, Clone, Copy)]
struct FailureRecord {
    #[allow(dead_code)] // kept for future per-kind telemetry; storm count is kind-agnostic
    kind: i32,
    at: Instant,
}

/// How many `ProcessFailed` events (of ANY kind) within `STORM_WINDOW` trip
/// the storm-breaker override (`RecoveryAction::FullRestart`), regardless of
/// what each individual kind's own policy would otherwise decide.
const STORM_THRESHOLD: usize = 3;
const STORM_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Hard cap on the in-memory ring's own length, independent of
/// `STORM_WINDOW` — bounds memory in a pathological rapid-fire case (e.g.
/// thousands of LogOnly-routed GPU_PROCESS_EXITED events over a long
/// session) without a background pruning task; entries older than
/// `STORM_WINDOW` already stop affecting the storm decision on their own —
/// this constant only bounds the `Vec`'s own growth.
const FAILURE_RING_CAPACITY: usize = 32;

/// In-memory ring of recent `ProcessFailed` events. Module-level `Mutex`,
/// not `tauri::State`: populated from inside a COM callback that only ever
/// has an `AppHandle` in scope, and this data has no reason to be reachable
/// from any Tauri command — mirrors `WEBVIEW_RECOVERY_IN_PROGRESS`'s own
/// "plain module static" rationale above.
static RECENT_FAILURES: Mutex<Vec<FailureRecord>> = Mutex::new(Vec::new());

/// Record `kind` into `RECENT_FAILURES` (capped at `FAILURE_RING_CAPACITY`,
/// oldest dropped first) and return a snapshot for `decide_recovery_action`.
/// A poisoned lock degrades to "no history but this one event" rather than
/// panicking the COM callback thread — losing the storm-detection window
/// under an already-degraded condition (some other thread panicked while
/// holding this exact lock) is an acceptable trade against crashing here.
fn record_failure_and_snapshot(kind: i32, now: Instant) -> Vec<FailureRecord> {
    match RECENT_FAILURES.lock() {
        Ok(mut ring) => {
            ring.push(FailureRecord { kind, at: now });
            if ring.len() > FAILURE_RING_CAPACITY {
                let overflow = ring.len() - FAILURE_RING_CAPACITY;
                ring.drain(0..overflow);
            }
            ring.clone()
        }
        Err(e) => {
            log::warn!(
                "RECENT_FAILURES lock poisoned ({}) — storm detection degraded to this single event",
                e
            );
            vec![FailureRecord { kind, at: now }]
        }
    }
}

/// The four routing outcomes a WebView2 `ProcessFailed` event can be given —
/// see `decide_recovery_action`'s own doc comment for the full policy table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryAction {
    /// Telemetry only — WebView2 auto-recovers this kind on its own.
    LogOnly,
    /// Call `ICoreWebView2::Reload()` on the failed webview; the COM handler
    /// falls back to `RecreateInPlace` if that call itself errors.
    ReloadWebview,
    /// Destroy-and-recreate just the "main" window (see
    /// `recover_webview_in_place_or_restart`).
    RecreateInPlace,
    /// Give up on anything smaller-scoped and request a full app restart —
    /// ONLY ever reached via the storm breaker (no individual kind maps to
    /// this directly).
    FullRestart,
}

/// Pure `ProcessFailed` routing decision — the crux of this module's
/// 2026-07-24 routing overhaul (see the module doc comment for the journal
/// forensics that motivated it). Raw `i32` discriminant, not the
/// `COREWEBVIEW2_PROCESS_FAILED_KIND` newtype itself, so this stays
/// unit-testable with zero COM/webview2-com types involved — mirrors this
/// crate's established pure-decision convention (e.g.
/// `system_pressure::classify_pressure`).
///
/// `recent_failures` MUST already include the event currently being decided
/// — the caller records it first via `record_failure_and_snapshot`, then
/// calls this; the storm check below counts directly off the snapshot, no
/// separate "current event" bookkeeping needed.
///
/// STORM BREAKER (checked first, overrides every kind-based rule below):
/// `STORM_THRESHOLD` (3) or more failures of ANY kind within `STORM_WINDOW`
/// (10 minutes) of `now` → `FullRestart`. Something is deeply wrong at that
/// point; a full restart is the only path this app has evidence actually
/// recovers a machine in that state.
///
/// Otherwise, routed purely by `kind` (`COREWEBVIEW2_PROCESS_FAILED_KIND`'s
/// raw discriminant):
///  - `0` `BROWSER_PROCESS_EXITED` → `RecreateInPlace`. The whole WebView2
///    Runtime browser process died — recreating the `WebviewWindow`
///    re-initializes a fresh `CoreWebView2Environment` from scratch, the
///    only fix available at this scope.
///  - `1` `RENDER_PROCESS_EXITED` → `ReloadWebview`. Journal forensics
///    (2026-07-24) proved this kind was previously routed to a full app
///    restart (killing every running mission) despite
///    `ICoreWebView2::Reload()` being the documented, much cheaper recovery
///    for exactly this kind.
///  - `2` `RENDER_PROCESS_UNRESPONSIVE` → `RecreateInPlace`. The page hung,
///    it did not exit — recreating the window clears the frozen page
///    without paying for a full process restart (unchanged from before this
///    overhaul).
///  - `3`-`8` (frame-render/utility/sandbox-helper/GPU/PPAPI process/broker)
///    → `LogOnly`. Journal forensics proved kind 6 (`GPU_PROCESS_EXITED`)
///    was being force-restarted despite WebView2 auto-recovering it per
///    Microsoft's own docs — these kinds get telemetry only now.
///  - `9` (`UNKNOWN_PROCESS_EXITED`) and any other/unreadable value (this
///    module's own `-1` sentinel for "ProcessFailedKind() failed to read")
///    → `LogOnly`, conservatively: never escalate on a kind this app cannot
///    even identify.
fn decide_recovery_action(kind: i32, recent_failures: &[FailureRecord], now: Instant) -> RecoveryAction {
    let storm_count = recent_failures.iter().filter(|f| now.saturating_duration_since(f.at) <= STORM_WINDOW).count();
    if storm_count >= STORM_THRESHOLD {
        return RecoveryAction::FullRestart;
    }

    const BROWSER_PROCESS_EXITED: i32 = 0;
    const RENDER_PROCESS_EXITED: i32 = 1;
    const RENDER_PROCESS_UNRESPONSIVE: i32 = 2;
    match kind {
        BROWSER_PROCESS_EXITED => RecoveryAction::RecreateInPlace,
        RENDER_PROCESS_EXITED => RecoveryAction::ReloadWebview,
        RENDER_PROCESS_UNRESPONSIVE => RecoveryAction::RecreateInPlace,
        3..=8 => RecoveryAction::LogOnly,
        _ => RecoveryAction::LogOnly, // 9 (unknown) and any unrecognized/unreadable kind
    }
}

/// How many consecutive in-place recreate attempts this app makes before
/// giving up and falling back to a full `request_restart()` — the founder
/// directive's own "fails twice" wording.
const MAX_IN_PLACE_RECOVERY_ATTEMPTS: u8 = 2;

/// Pure retry-loop decision, extracted from `recover_webview_in_place_or_restart`
/// so the "try again vs. give up" arithmetic is unit-tested without any live
/// COM/WebView2 call involved (same pure-core convention as
/// `system_pressure::debounce_step`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryStep {
    /// Attempt another in-place recreate — `attempt` has not yet reached the cap.
    RetryInPlace,
    /// Every allotted attempt failed — fall back to a full `request_restart()`.
    GiveUpAndRestart,
}

fn next_recovery_step(attempt: u8, max_attempts: u8) -> RecoveryStep {
    if attempt < max_attempts {
        RecoveryStep::RetryInPlace
    } else {
        RecoveryStep::GiveUpAndRestart
    }
}

/// Force-close the crashed "main" window and recreate it from the SAME
/// tauri.conf.json `WindowConfig` (label, URL, size, decorations, theme —
/// everything `WebviewWindowBuilder::from_config` restores), all on the
/// CALLING thread, which MUST NOT be the main/event-loop thread — see the
/// call site in `install_webview_crash_restart_handler`'s COM handler, which
/// hands this off to a fresh `std::thread::spawn` specifically because
/// `tauri::WebviewWindowBuilder`'s own docs warn that creating a window
/// synchronously from a callback already running ON the main thread
/// deadlocks (the creation internally blocks waiting for the main thread's
/// event loop to service it — which cannot happen while that same thread is
/// itself blocked here waiting).
///
/// `.destroy()` (not `.close()`): `.close()` emits `WindowEvent::CloseRequested`
/// first, as an interceptable, cancelable user-close request — meaningless
/// (and a needless place for a stray listener to "cancel" a crash recovery)
/// for a window whose webview process is already dead. `.destroy()` force-closes
/// with no such event, freeing the "main" label immediately for reuse (Tauri
/// does not allow two windows with the same label at once).
///
/// Frontend route/scroll/etc. state is NOT captured or restored here — that
/// is the existing frontend persistence layer's job (localStorage survives
/// this recreation untouched: same profile directory, same origin, nothing
/// about a same-process window recreation invalidates it), not this
/// function's. This function's only contract is "the window exists again,
/// pointed at the same URL it was".
fn try_recreate_main_window(app_handle: &tauri::AppHandle, window_label: &str) -> Result<(), String> {
    let config = app_handle
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == window_label)
        .cloned()
        .ok_or_else(|| format!("no \"{}\" window config found in tauri.conf.json", window_label))?;

    if let Some(dead) = app_handle.get_webview_window(window_label) {
        if let Err(e) = dead.destroy() {
            log::warn!(
                "try_recreate_main_window: destroy() of the crashed \"{}\" window failed ({}) — attempting to recreate anyway",
                window_label, e
            );
        }

        // `.destroy()` only POSTS to the main-thread event loop — it returns
        // before the label is actually freed. Building a new window with the
        // same label before that post is processed fails outright
        // (`WebviewWindowBuilder::build failed: a webview with label "main"
        // already exists" — proven by a real crash test). This function only
        // ever runs on a dedicated worker thread (see its own doc comment),
        // so the main event loop IS free to process the pending destroy
        // while this thread polls below — no fixed delay is assumed long
        // enough; poll until the label is actually gone instead.
        const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
        const MAX_WAIT_MS: u64 = 3_000; // ~3s (60 polls at 50ms)

        let mut waited_ms: u64 = 0;
        loop {
            if app_handle.get_webview_window(window_label).is_none() {
                log::info!(
                    "main window destroyed, label freed after {}ms — recreating",
                    waited_ms
                );
                break;
            }
            if waited_ms >= MAX_WAIT_MS {
                return Err(format!(
                    "\"{}\" window destroy did not free label within {}ms timeout",
                    window_label, MAX_WAIT_MS
                ));
            }
            std::thread::sleep(POLL_INTERVAL);
            waited_ms += POLL_INTERVAL.as_millis() as u64;
        }
    }

    tauri::WebviewWindowBuilder::from_config(app_handle, &config)
        .map_err(|e| format!("WebviewWindowBuilder::from_config failed: {}", e))?
        .build()
        .map_err(|e| format!("WebviewWindowBuilder::build failed: {}", e))?;

    Ok(())
}

/// Outcome of one full `run_recovery_sequence` run — see that function's own
/// doc comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoverySequenceOutcome {
    /// `recreate_main_window` succeeded on `attempt` (1-based) and
    /// `reinstall_process_failed_handler` was called exactly once,
    /// immediately after, before returning.
    RecoveredInPlace { attempt: u8 },
    /// Every one of `max_attempts` calls to `recreate_main_window` failed.
    /// `reinstall_process_failed_handler` was NEVER called on this path —
    /// there is no live webview left worth re-arming; the caller must fall
    /// back to a full restart instead.
    GaveUpAfter { attempts: u8 },
}

/// The actual retry-then-fall-back SEQUENCING `recover_webview_in_place_or_restart`
/// runs, extracted into its own generic function so the sequencing itself —
/// not just the retry-count arithmetic `next_recovery_step` already covers —
/// is unit-tested (see `mod tests`'s `run_recovery_sequence_*` tests below)
/// without any live COM/WebView2 call involved: `recreate_main_window` and
/// `reinstall_process_failed_handler` are real `try_recreate_main_window` /
/// `install_webview_crash_restart_handler` calls in production
/// (`recover_webview_in_place_or_restart`, just below, is a thin wrapper
/// supplying them as closures) and simple call-counting closures in tests.
///
/// THE INVARIANT THIS EXISTS TO PROTECT (2026-07-24 fix — see the module doc
/// comment's "RE-ARM FIX" note for the real-crash-test evidence): a
/// successful `recreate_main_window` MUST always be followed by exactly one
/// `reinstall_process_failed_handler` call before returning — the crashed
/// window's OLD `ProcessFailed` COM registration died along with the OLD
/// `ICoreWebView2` instance `recreate_main_window` just destroyed, so
/// skipping this leaves the recovered window permanently unprotected
/// against every SUBSEQUENT crash. Symmetrically, a sequence that gives up
/// (every attempt exhausted) must NEVER call it — there is no live webview
/// left to arm.
///
/// Up to `max_attempts` calls to `recreate_main_window`, giving up (per
/// `next_recovery_step`) only once every attempt has failed.
fn run_recovery_sequence(
    max_attempts: u8,
    mut recreate_main_window: impl FnMut() -> Result<(), String>,
    mut reinstall_process_failed_handler: impl FnMut(),
) -> RecoverySequenceOutcome {
    let mut attempt: u8 = 0;
    loop {
        attempt += 1;
        match recreate_main_window() {
            Ok(()) => {
                reinstall_process_failed_handler();
                return RecoverySequenceOutcome::RecoveredInPlace { attempt };
            }
            Err(e) => {
                log::warn!(
                    "WebView2 in-place recovery attempt {}/{} failed: {}",
                    attempt, max_attempts, e
                );
            }
        }

        if next_recovery_step(attempt, max_attempts) == RecoveryStep::GiveUpAndRestart {
            return RecoverySequenceOutcome::GaveUpAfter { attempts: attempt };
        }
    }
}

/// MUST run on a dedicated OS thread, never the main/event-loop thread — see
/// `try_recreate_main_window`'s own doc comment for the deadlock this
/// avoids. (`install_webview_crash_restart_handler`'s own re-arm call,
/// below, has no such restriction — see ITS doc comment's THREADING note —
/// but this whole function still must not run on the main thread, because
/// `try_recreate_main_window` does.)
///
/// `WEBVIEW_RECOVERY_IN_PROGRESS` is held true for the ENTIRE sequence (both
/// attempts), not just around one `.destroy()` call — a `WindowEvent::Destroyed`
/// for "main" can in principle land at any point while this function is
/// running, and every one of them must be treated as "recovery in flight",
/// not "the app is closing".
fn recover_webview_in_place_or_restart(app_handle: &tauri::AppHandle) {
    WEBVIEW_RECOVERY_IN_PROGRESS.store(true, Ordering::SeqCst);

    let outcome = run_recovery_sequence(
        MAX_IN_PLACE_RECOVERY_ATTEMPTS,
        || try_recreate_main_window(app_handle, "main"),
        || install_webview_crash_restart_handler(app_handle),
    );

    let attempts_failed = match outcome {
        RecoverySequenceOutcome::RecoveredInPlace { attempt } => {
            WEBVIEW_RECOVERY_IN_PROGRESS.store(false, Ordering::SeqCst);
            log::info!(
                "WebView2 in-place recovery succeeded on attempt {}/{}",
                attempt, MAX_IN_PLACE_RECOVERY_ATTEMPTS
            );
            emit_recovery_journal_event(app_handle, "in_place");
            return;
        }
        RecoverySequenceOutcome::GaveUpAfter { attempts } => attempts,
    };

    // Every attempt failed — fall back to the always-correct, conservative
    // path. Clear the guard BEFORE tearing down: `RunEvent::Exit` fires
    // almost immediately afterward (see `lib.rs`'s `run_exit_cleanup` doc
    // comment), and a real app-exit cleanup IS wanted on this path, unlike
    // the successful in-place return above.
    WEBVIEW_RECOVERY_IN_PROGRESS.store(false, Ordering::SeqCst);
    log::warn!(
        "WebView2 in-place recovery failed {} time(s) in a row — falling back to a full app restart",
        attempts_failed
    );
    emit_recovery_journal_event(app_handle, "restart");

    // Relaunch explicitly ourselves rather than trusting
    // `AppHandle::request_restart()`'s own relaunch step — see
    // `spawn_fresh_instance`'s doc comment for why a real crash test proved
    // that step unreliable from exactly this (both in-place attempts already
    // failed) context. On success, tear this process down via `exit()`, NOT
    // `request_restart()`: `exit()` still drives the same
    // `RunEvent::Exit`-triggered `run_exit_cleanup` teardown (the ordinary,
    // already-reliable quit path every normal app close already uses) but,
    // unlike `request_restart()`, never sets tauri's own internal
    // `restart_on_exit` flag — so tauri's own relaunch never also fires
    // alongside ours. Exactly one path spawns a new process; the other only
    // tears the old one down. `request_restart()` is kept ONLY as a
    // last-resort fallback for the (already-degraded, nothing-to-lose) case
    // where the explicit spawn itself fails outright — at that point no
    // relaunch has happened yet either way, so no double-launch risk.
    match spawn_fresh_instance() {
        Ok(()) => {
            log::info!("explicit relaunch of a fresh instance succeeded — exiting this process");
            app_handle.exit(0);
        }
        Err(e) => {
            log::warn!(
                "explicit relaunch spawn failed ({}) — falling back to request_restart() as a last resort",
                e
            );
            app_handle.request_restart();
        }
    }
}

/// Entry point for `startup_watchdog`'s Retry action — the SAME
/// destroy-and-recreate-in-place sequence
/// `install_webview_crash_restart_handler`'s COM callback already uses for
/// a genuine `ProcessFailed` (`RecoveryAction::RecreateInPlace`, and
/// `ReloadWebview`'s own fallback), reused verbatim for a different
/// TRIGGER: a startup-readiness timeout, never a `ProcessFailed` event —
/// see `startup_watchdog`'s own module doc comment for why that event
/// never fires at all in the failure class this covers (no `ICoreWebView2`
/// ever came up successfully, so nothing was ever there to fail).
///
/// A one-line wrapper, not a straight `pub(crate)` on
/// `recover_webview_in_place_or_restart` itself: keeps that function
/// private to this module (its only OTHER caller is the in-module COM
/// callback above) while giving `startup_watchdog` a narrow, purpose-named
/// door in — same "why does a different trigger need a different name"
/// reasoning this module already applies to its own two `emit_*_journal_event`
/// siblings.
///
/// MUST run on the CALLING thread, which MUST NOT be the main thread — same
/// constraint as `recover_webview_in_place_or_restart` itself (see its own
/// doc comment for the deadlock this avoids). `startup_watchdog::run_watchdog`
/// / `handle_stall` already satisfy this the same way this module's own
/// `std::thread::spawn` call sites do.
pub(crate) fn recover_from_startup_stall(app_handle: &tauri::AppHandle) {
    recover_webview_in_place_or_restart(app_handle);
}

/// Explicitly relaunches a fresh instance of this same executable, carrying
/// over the current process's environment — the fallback-path replacement
/// for trusting `AppHandle::request_restart()`'s own relaunch step.
///
/// WHY NOT rely on `request_restart()` alone: tracing tauri 2.11.3's own
/// source (`app.rs::request_restart` / `process.rs::restart`) shows its
/// relaunch (`Command::new(current_binary).spawn()`) only runs from INSIDE
/// the main event loop's `RuntimeRunEvent::Exit` handling, after
/// `request_exit()` successfully round-trips there. A real crash test —
/// deliberately reached through this exact fallback (both in-place recovery
/// attempts already exhausted, i.e. WebView2/the main event loop already in
/// a degraded state) — showed exactly that hand-off failing: the old process
/// exited but no new one ever came up (`lazy-ide.exe` fully gone from Task
/// Manager). Spawning directly, right here, on this worker thread, depends
/// on nothing but the OS process API — no event-loop round-trip left to fail.
fn spawn_fresh_instance() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe() failed: {}", e))?;

    std::process::Command::new(exe)
        .envs(std::env::vars())
        .spawn()
        .map_err(|e| format!("spawn() failed: {}", e))?;

    Ok(())
}

/// Durably records a recovery (`mode`: `"in_place"`, `"reload"`, or
/// `"restart"`) into the event journal (`commands::journal::emit_system_event`, actor `"system"`)
/// so it is COUNTED and HONEST — never just a transient log line nobody
/// reads. `project_id: "unknown"` mirrors `scheduler.ts`'s own
/// `scheduler.throttled` convention for a genuinely machine-level event with
/// no project to scope it to (see that event's own emit call site).
///
/// The durable journal write is the actual source of truth here, DELIBERATELY
/// preferred over relying solely on a live `app.emit` reaching a listener:
/// at the exact moment this fires, the webview is either dead (about to be
/// recreated) or the whole process is about to restart, so a live listener
/// may not exist yet. The frontend's existing pull-based reads
/// (`journal_since` / `journal_activity_feed`, already polled for the FLUX
/// ticker) pick this row up regardless, the same way every other
/// Rust-originated system event in this journal already works. The best-effort
/// live `emit` below is a harmless bonus for an already-mounted listener, not
/// the mechanism this relies on.
///
/// `JournalState` may not be managed yet in the (currently theoretical, since
/// `.setup()` runs to completion long before any real WebView2 crash could
/// fire) case this is called before `.setup()` finishes — `try_state`
/// degrades to a logged warning rather than a panic.
fn emit_recovery_journal_event(app_handle: &tauri::AppHandle, mode: &str) {
    let payload = serde_json::json!({ "mode": mode });

    if let Some(journal_state) = app_handle.try_state::<JournalState>() {
        crate::commands::journal::emit_system_event(&journal_state, "unknown", "app.recovered", payload.clone());
    } else {
        log::warn!(
            "emit_recovery_journal_event: JournalState not managed yet — 'app.recovered' ({}) was not journaled",
            mode
        );
    }

    use tauri::Emitter;
    let _ = app_handle.emit("app.recovered", payload);
}

/// Telemetry-only journal event for `RecoveryAction::LogOnly` kinds — see
/// `decide_recovery_action`'s own doc comment for why these kinds get no
/// app-level intervention. Kept separate from `emit_recovery_journal_event`
/// (this function's sibling, just above) rather than merged into it: this is
/// NOT a "recovered" event (nothing was recovered — WebView2 handled it
/// entirely on its own) and carries a different payload shape (`kind`, not
/// `mode`). No live `app.emit` companion, unlike `emit_recovery_journal_event`:
/// this is pure background telemetry, not something the FLUX ticker needs to
/// surface to the user (see this module's own MANUAL QA note #7).
fn emit_process_failed_ignored_journal_event(app_handle: &tauri::AppHandle, kind: i32) {
    let payload = serde_json::json!({ "kind": kind });

    if let Some(journal_state) = app_handle.try_state::<JournalState>() {
        crate::commands::journal::emit_system_event(&journal_state, "unknown", "app.processFailedIgnored", payload);
    } else {
        log::warn!(
            "emit_process_failed_ignored_journal_event: JournalState not managed yet — 'app.processFailedIgnored' (kind={}) was not journaled",
            kind
        );
    }
}

// ── Pure decision logic — unit tests ────────────────────────────────
//
// The actual recreate (`try_recreate_main_window`) is real COM/WebView2 work
// that cannot be exercised from `cargo test` (see the manual-QA notes this
// shipped with) — what CAN be, and is, unit-tested here is every piece of
// DECISION logic around it: which `ProcessFailedKind` values are worth an
// in-place attempt, and when the retry loop gives up and falls back to a
// full restart.
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    // ── decide_recovery_action: kind-based routing (no storm history) ──

    fn no_history() -> Vec<FailureRecord> {
        Vec::new()
    }

    #[test]
    fn browser_process_exited_recreates_in_place() {
        let now = Instant::now();
        assert_eq!(decide_recovery_action(0, &no_history(), now), RecoveryAction::RecreateInPlace);
        eprintln!("browser_process_exited_recreates_in_place PASSED");
    }

    #[test]
    fn render_process_exited_reloads_the_webview() {
        // Kind 1 — the exact routing this overhaul fixed: previously forced
        // a full app restart despite Reload() being the documented, cheaper
        // recovery (see the module doc comment's journal-forensics note).
        let now = Instant::now();
        assert_eq!(decide_recovery_action(1, &no_history(), now), RecoveryAction::ReloadWebview);
        eprintln!("render_process_exited_reloads_the_webview PASSED");
    }

    #[test]
    fn render_process_unresponsive_recreates_in_place() {
        let now = Instant::now();
        assert_eq!(decide_recovery_action(2, &no_history(), now), RecoveryAction::RecreateInPlace);
        eprintln!("render_process_unresponsive_recreates_in_place PASSED");
    }

    #[test]
    fn frame_utility_sandbox_gpu_ppapi_kinds_are_log_only() {
        // Frame-render/utility/sandbox-helper/GPU/PPAPI process/broker
        // (3-8) — WebView2 auto-recovers all of these on its own.
        let now = Instant::now();
        for kind in 3..=8 {
            assert_eq!(
                decide_recovery_action(kind, &no_history(), now),
                RecoveryAction::LogOnly,
                "kind {} must be LogOnly",
                kind
            );
        }
        eprintln!("frame_utility_sandbox_gpu_ppapi_kinds_are_log_only PASSED");
    }

    #[test]
    fn unknown_kind_nine_is_log_only() {
        let now = Instant::now();
        assert_eq!(decide_recovery_action(9, &no_history(), now), RecoveryAction::LogOnly);
        eprintln!("unknown_kind_nine_is_log_only PASSED");
    }

    #[test]
    fn an_unreadable_kind_is_log_only() {
        // `-1` is this module's own sentinel for "ProcessFailedKind() failed
        // to read" (see the COM handler's `.unwrap_or(-1)` call site) — must
        // be conservative, never escalate on it.
        let now = Instant::now();
        assert_eq!(decide_recovery_action(-1, &no_history(), now), RecoveryAction::LogOnly);
        eprintln!("an_unreadable_kind_is_log_only PASSED");
    }

    #[test]
    fn an_arbitrary_future_kind_is_log_only() {
        let now = Instant::now();
        assert_eq!(decide_recovery_action(100, &no_history(), now), RecoveryAction::LogOnly);
        eprintln!("an_arbitrary_future_kind_is_log_only PASSED");
    }

    // ── decide_recovery_action: storm breaker ───────────────────────

    #[test]
    fn two_recent_failures_do_not_trigger_the_storm_breaker() {
        let now = Instant::now();
        let history = vec![FailureRecord { kind: 0, at: now }, FailureRecord { kind: 0, at: now }];
        // Below STORM_THRESHOLD (3) — ordinary kind-0 policy still applies.
        assert_eq!(decide_recovery_action(0, &history, now), RecoveryAction::RecreateInPlace);
        eprintln!("two_recent_failures_do_not_trigger_the_storm_breaker PASSED");
    }

    #[test]
    fn three_recent_failures_of_the_same_kind_trigger_the_storm_breaker() {
        let now = Instant::now();
        let history = vec![
            FailureRecord { kind: 0, at: now },
            FailureRecord { kind: 0, at: now },
            FailureRecord { kind: 0, at: now },
        ];
        assert_eq!(
            decide_recovery_action(0, &history, now),
            RecoveryAction::FullRestart,
            "storm breaker must override kind 0's own RecreateInPlace policy"
        );
        eprintln!("three_recent_failures_of_the_same_kind_trigger_the_storm_breaker PASSED");
    }

    #[test]
    fn three_recent_failures_of_mixed_kinds_still_trigger_the_storm_breaker() {
        let now = Instant::now();
        let history = vec![
            FailureRecord { kind: 6, at: now }, // GPU, ordinarily LogOnly
            FailureRecord { kind: 1, at: now }, // render exited, ordinarily ReloadWebview
            FailureRecord { kind: 0, at: now }, // browser exited, ordinarily RecreateInPlace
        ];
        assert_eq!(
            decide_recovery_action(0, &history, now),
            RecoveryAction::FullRestart,
            "storm breaker counts ANY kind, not just repeats of the current one"
        );
        eprintln!("three_recent_failures_of_mixed_kinds_still_trigger_the_storm_breaker PASSED");
    }

    #[test]
    fn a_failure_exactly_at_the_storm_window_boundary_is_counted() {
        let now = Instant::now();
        let boundary = now - STORM_WINDOW;
        let history = vec![
            FailureRecord { kind: 0, at: boundary },
            FailureRecord { kind: 0, at: now },
            FailureRecord { kind: 0, at: now },
        ];
        assert_eq!(
            decide_recovery_action(0, &history, now),
            RecoveryAction::FullRestart,
            "storm window boundary is inclusive (<=)"
        );
        eprintln!("a_failure_exactly_at_the_storm_window_boundary_is_counted PASSED");
    }

    #[test]
    fn a_failure_just_outside_the_storm_window_is_not_counted() {
        let now = Instant::now();
        let just_outside = now - STORM_WINDOW - Duration::from_secs(1);
        let history = vec![
            FailureRecord { kind: 0, at: just_outside },
            FailureRecord { kind: 0, at: now },
            FailureRecord { kind: 0, at: now },
        ];
        // Only 2 of the 3 records are within the window — below threshold.
        assert_eq!(
            decide_recovery_action(0, &history, now),
            RecoveryAction::RecreateInPlace,
            "an expired entry must not count toward the storm threshold"
        );
        eprintln!("a_failure_just_outside_the_storm_window_is_not_counted PASSED");
    }

    #[test]
    fn record_failure_and_snapshot_caps_the_ring_at_capacity() {
        // Push well past FAILURE_RING_CAPACITY and confirm the snapshot
        // never exceeds it — proves the ring actually prunes rather than
        // growing unbounded. Uses the real shared RECENT_FAILURES static;
        // safe under parallel test execution since this only asserts an
        // upper bound that holds regardless of what other tests concurrently
        // push (every push goes through the same capping logic).
        for _ in 0..(FAILURE_RING_CAPACITY + 10) {
            record_failure_and_snapshot(6, Instant::now());
        }
        let snapshot = record_failure_and_snapshot(6, Instant::now());
        assert!(snapshot.len() <= FAILURE_RING_CAPACITY, "ring must be capped at {}", FAILURE_RING_CAPACITY);
        eprintln!("record_failure_and_snapshot_caps_the_ring_at_capacity PASSED");
    }

    // ── next_recovery_step ───────────────────────────────────────────

    #[test]
    fn first_failed_attempt_retries_in_place() {
        assert_eq!(next_recovery_step(1, MAX_IN_PLACE_RECOVERY_ATTEMPTS), RecoveryStep::RetryInPlace);
        eprintln!("first_failed_attempt_retries_in_place PASSED");
    }

    #[test]
    fn second_failed_attempt_gives_up_and_restarts() {
        // The founder directive's own wording, verbatim: "fails twice".
        assert_eq!(next_recovery_step(2, MAX_IN_PLACE_RECOVERY_ATTEMPTS), RecoveryStep::GiveUpAndRestart);
        eprintln!("second_failed_attempt_gives_up_and_restarts PASSED");
    }

    #[test]
    fn max_in_place_recovery_attempts_is_exactly_two() {
        // Pins the constant itself, so a future accidental edit (e.g. "just
        // bump it to 3") shows up here instead of only as a silent behavior
        // change in the field.
        assert_eq!(MAX_IN_PLACE_RECOVERY_ATTEMPTS, 2);
        eprintln!("max_in_place_recovery_attempts_is_exactly_two PASSED");
    }

    // ── run_recovery_sequence: the 2026-07-24 re-arm-after-recovery fix ──
    //
    // Regression coverage for the exact bug a real crash test found: recovery
    // succeeding once but leaving the recreated window with no crash handler
    // at all. `recreate_main_window` and `reinstall_process_failed_handler`
    // are plain call-counting closures here — no COM/WebView2 involved — so
    // these assert purely on CALL COUNT AND ORDER, the same shape of
    // guarantee `install_webview_crash_restart_handler`'s production
    // implementation must uphold.

    #[test]
    fn run_recovery_sequence_reinstalls_the_handler_after_a_first_try_success() {
        let recreate_calls = Cell::new(0);
        let reinstall_calls = Cell::new(0);

        let outcome = run_recovery_sequence(
            MAX_IN_PLACE_RECOVERY_ATTEMPTS,
            || {
                recreate_calls.set(recreate_calls.get() + 1);
                Ok(())
            },
            || reinstall_calls.set(reinstall_calls.get() + 1),
        );

        assert_eq!(outcome, RecoverySequenceOutcome::RecoveredInPlace { attempt: 1 });
        assert_eq!(recreate_calls.get(), 1, "recreate must be attempted exactly once when it succeeds immediately");
        assert_eq!(reinstall_calls.get(), 1, "a successful recreate must reinstall the handler exactly once");
        eprintln!("run_recovery_sequence_reinstalls_the_handler_after_a_first_try_success PASSED");
    }

    #[test]
    fn run_recovery_sequence_reinstalls_the_handler_exactly_once_after_a_later_success() {
        // Succeeds only on the 2nd attempt — proves reinstall fires exactly
        // once total (on the eventual success), not once per attempt.
        let recreate_calls = Cell::new(0);
        let reinstall_calls = Cell::new(0);

        let outcome = run_recovery_sequence(
            MAX_IN_PLACE_RECOVERY_ATTEMPTS,
            || {
                let n = recreate_calls.get() + 1;
                recreate_calls.set(n);
                if n < 2 { Err("simulated build failure".to_string()) } else { Ok(()) }
            },
            || reinstall_calls.set(reinstall_calls.get() + 1),
        );

        assert_eq!(outcome, RecoverySequenceOutcome::RecoveredInPlace { attempt: 2 });
        assert_eq!(recreate_calls.get(), 2);
        assert_eq!(reinstall_calls.get(), 1, "reinstall must fire exactly once, not once per attempt");
        eprintln!("run_recovery_sequence_reinstalls_the_handler_exactly_once_after_a_later_success PASSED");
    }

    #[test]
    fn run_recovery_sequence_never_reinstalls_when_every_attempt_fails() {
        let reinstall_calls = Cell::new(0);

        let outcome = run_recovery_sequence(
            MAX_IN_PLACE_RECOVERY_ATTEMPTS,
            || Err("simulated build failure".to_string()),
            || reinstall_calls.set(reinstall_calls.get() + 1),
        );

        assert_eq!(outcome, RecoverySequenceOutcome::GaveUpAfter { attempts: MAX_IN_PLACE_RECOVERY_ATTEMPTS });
        assert_eq!(reinstall_calls.get(), 0, "giving up must never reinstall a handler onto a dead window");
        eprintln!("run_recovery_sequence_never_reinstalls_when_every_attempt_fails PASSED");
    }

    #[test]
    fn run_recovery_sequence_retries_up_to_max_attempts_before_giving_up() {
        let recreate_calls = Cell::new(0);

        let outcome = run_recovery_sequence(
            MAX_IN_PLACE_RECOVERY_ATTEMPTS,
            || {
                recreate_calls.set(recreate_calls.get() + 1);
                Err("simulated build failure".to_string())
            },
            || {},
        );

        assert_eq!(outcome, RecoverySequenceOutcome::GaveUpAfter { attempts: MAX_IN_PLACE_RECOVERY_ATTEMPTS });
        assert_eq!(recreate_calls.get(), MAX_IN_PLACE_RECOVERY_ATTEMPTS as i32, "must try exactly max_attempts times, no more, no fewer");
        eprintln!("run_recovery_sequence_retries_up_to_max_attempts_before_giving_up PASSED");
    }

    #[test]
    fn is_recovery_in_progress_defaults_to_false() {
        // WEBVIEW_RECOVERY_IN_PROGRESS is private to this module and only
        // ever flipped true by `recover_webview_in_place_or_restart`, which
        // needs a real COM/WebView2 crash to run and is never invoked by any
        // test in this file — so it is safe to assert the steady-state
        // default deterministically here.
        assert!(!is_recovery_in_progress());
        eprintln!("is_recovery_in_progress_defaults_to_false PASSED");
    }
}
