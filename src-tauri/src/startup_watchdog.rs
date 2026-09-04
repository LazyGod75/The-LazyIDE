//! Crash resilience layer B (Windows only, same scope as its sibling
//! `webview_recovery.rs`) — startup-readiness watchdog for the ONE class of
//! failure layer A structurally cannot see: the WebView2 native
//! environment/controller never finishes initializing IN THE FIRST PLACE,
//! so the OS process stays alive and healthy (the Rust/Tauri side boots
//! perfectly — reproduced live: profile migration done, `projects.json:
//! restored N open project(s)`, the journal retention scheduler started,
//! the brain sidecar came up and reported ready) while the window itself
//! paints nothing but a blank white rectangle, forever, with zero
//! diagnostics and zero recovery. Reproduced under real memory pressure
//! (~2GB free, CPU ~90%): the process sat at 45MB RSS and the remote
//! debugging port never answered — the browser process WebView2 spawns
//! never came up at all.
//!
//! WHY LAYER A (`webview_recovery.rs`) CANNOT CATCH THIS:
//! `install_webview_crash_restart_handler` reacts to
//! `ICoreWebView2::add_ProcessFailed` — an event that requires a
//! `CoreWebView2` COM object to exist and THEN fail. In the failure this
//! module targets, no such object was ever successfully created, so there
//! is nothing to fail and nothing to attach a handler to; the reproduced
//! symptom (remote-debugging port never answering) is exactly what "native
//! init never finished" looks like from outside the process. This is a gap
//! in what `ProcessFailed`-based recovery can observe, not a bug in it —
//! see that module's own doc comment for its (unrelated, already correct)
//! scope.
//!
//! DESIGN: a plain wall-clock bound on "has the 'main' webview's first page
//! load finished yet", using `tauri::Builder::on_page_load` — the
//! BUILDER-level hook (registered on `tauri::Builder` itself, in `lib.rs`,
//! BEFORE `.build()`/`.run()` creates any window), never the
//! per-`WebviewWindow` variant of the same name. This timing is the whole
//! point: the builder-level hook exists before a single window is created,
//! so the "main" window's own first navigation — whenever it actually
//! starts — is guaranteed to be observed, with no
//! window-already-created-before-listener-attached race to reason about
//! (the per-window variant, attached from inside `.setup()` after the
//! window already exists, would have exactly that race).
//!
//! `PageLoadEvent::Finished` (not `Started`) is the readiness signal:
//! `Started` alone would not rule out a stall mid-navigation, and this
//! bug's own reproduced symptom (remote-debugging port never answering)
//! suggests native init did not progress even that far. `Finished` is the
//! strongest signal available on the Rust side, WITHOUT new frontend
//! cooperation — deliberately not asking the frontend to call back in: the
//! relevant `.tsx` entry points are being edited by other agents today,
//! and this fix stays entirely on the Rust side by design (see this
//! change's own scope note in the commit message).
//!
//! HONEST LIMITATION (do not oversell this — see this codebase's own "no
//! optimistic reading" convention): `Finished` only proves
//! navigation/DOM-load completed at the WebView2 level. It says nothing
//! about whether the frontend JS then actually mounted and painted
//! something past that point — a JS-level hang AFTER `Finished` fires
//! (e.g. a script error blocking the React root render) is a DIFFERENT
//! failure mode this watchdog does not cover. Closing that gap would need
//! a frontend-side heartbeat (e.g. an `invoke()` call once React mounts),
//! deliberately left out of this change's scope.
//!
//! ON TIMEOUT: log visibly, best-effort journal the stall
//! (`app.startupStalled`, mirrors `webview_recovery::emit_recovery_journal_event`'s
//! own degrade-to-warning shape), then show a BLOCKING NATIVE dialog
//! (`tauri_plugin_dialog`, backed by `rfd` on desktop — a real OS-native
//! dialog window, entirely independent of the dead WebView2 page, so it
//! renders even though the app's own window is blank) explaining what
//! happened in plain language and offering Retry / Quit. Retry reuses
//! `webview_recovery::recover_from_startup_stall` — the SAME
//! destroy-and-recreate-in-place sequence already proven for a genuine
//! WebView2 crash — so this fix adds no new recreate/retry/fallback logic
//! of its own, only a new TRIGGER for the existing one. Capped at
//! `MAX_STALL_DIALOGS` dialogs per process lifetime (mirrors
//! `webview_recovery::MAX_IN_PLACE_RECOVERY_ATTEMPTS`'s own "bounded, never
//! infinite" posture) so a machine that stays memory-starved across
//! repeated retries is told plainly instead of being looped forever — the
//! final dialog offers Quit only.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::state::JournalState;

/// Set true the first time the "main" webview's navigation reports
/// `PageLoadEvent::Finished` (see the module doc comment for why
/// `Finished`, not `Started`). Reset to `false` by `handle_stall` right
/// before each Retry recreate (via `webview_recovery::recover_from_startup_stall`
/// creating a brand new "main" window) so a stalled RETRY is judged by a
/// fresh watchdog cycle instead of trusting the ORIGINAL window's
/// already-true flag forever — mirrors `webview_recovery`'s own
/// "re-arm on every recreate" posture for its crash handler.
static MAIN_PAGE_READY: AtomicBool = AtomicBool::new(false);

/// How many stall dialogs (see the module doc comment's "ON TIMEOUT"
/// section) this process has shown so far — capped by `MAX_STALL_DIALOGS`.
static STALL_DIALOGS_SHOWN: AtomicU8 = AtomicU8::new(0);

/// Wall-clock bound on "the 'main' webview has not finished its first page
/// load yet" before this is treated as a genuine stall rather than an
/// ordinary slow-but-healthy boot (first-run migrations, antivirus
/// scanning a freshly-installed exe, a spinning disk). Generous on
/// purpose: the reproduced bug does not recover on its own at all, so
/// there is no real cost to waiting a bit longer before interrupting the
/// user — a shorter bound mainly risks a false-positive dialog on a
/// merely slow (but healthy) machine, which is worse than a few extra
/// seconds of blank window on one that was always going to finish anyway.
const STARTUP_READY_TIMEOUT: Duration = Duration::from_secs(20);

/// How often the watchdog thread polls `MAIN_PAGE_READY` while waiting —
/// short enough that a page which finishes right around the boundary is
/// still caught by the "check again before acting" guard in `run_watchdog`
/// / `handle_stall`, long enough not to spin the thread.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Total stall dialogs this process will ever show before giving up on
/// offering Retry and only offering Quit — see the module doc comment.
const MAX_STALL_DIALOGS: u8 = 2;

/// The `Builder::on_page_load` hook itself — registered once, in `lib.rs`,
/// on the `Builder` BEFORE `.build()`/`.run()` creates any window (see the
/// module doc comment for why this timing matters). Filters to the "main"
/// label only: any other window this app creates has its own lifecycle and
/// is not this watchdog's concern.
pub(crate) fn mark_ready_on_main_page_finished<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Finished {
        MAIN_PAGE_READY.store(true, Ordering::SeqCst);
    }
}

/// Spawns the watchdog thread and returns immediately — all waiting
/// happens on a dedicated OS thread (`run_watchdog`), never the caller's
/// own. Called once at startup (`lib.rs`'s `.setup()`, same call site as
/// `install_webview_crash_restart_handler` — see that function's own doc
/// comment for the analogous "never block `.setup()`" reasoning) and again
/// by `handle_stall` after every Retry, so the recreated window gets its
/// own fresh watchdog cycle too.
pub(crate) fn spawn_startup_watchdog(app_handle: tauri::AppHandle) {
    std::thread::spawn(move || run_watchdog(app_handle));
}

fn run_watchdog(app_handle: tauri::AppHandle) {
    let mut waited = Duration::ZERO;
    while waited < STARTUP_READY_TIMEOUT {
        if MAIN_PAGE_READY.load(Ordering::SeqCst) {
            return; // the ordinary path — the overwhelming majority of boots.
        }
        std::thread::sleep(POLL_INTERVAL);
        waited += POLL_INTERVAL;
    }

    if MAIN_PAGE_READY.load(Ordering::SeqCst) {
        return; // finished right at the boundary — nothing to report.
    }

    log::error!(
        "startup watchdog: the \"main\" webview has not finished loading {}s after startup — \
         the window is very likely showing a blank/white screen with no page content. This \
         usually means the OS could not finish initializing the WebView2 renderer in time \
         (observed cause in the field: severe system memory pressure).",
        STARTUP_READY_TIMEOUT.as_secs()
    );
    emit_startup_stalled_journal_event(&app_handle);

    handle_stall(app_handle);
}

/// Shows the stall dialog (unless the page finished loading in the gap
/// since the timeout fired) and acts on the user's choice. See the module
/// doc comment's "ON TIMEOUT" section for the full design rationale.
fn handle_stall(app_handle: tauri::AppHandle) {
    // One more check right before interrupting the user: the dialog below
    // is genuinely disruptive (a native, focus-stealing modal), so if the
    // page finished loading in the gap between the timeout firing and this
    // function actually running (thread-scheduling delay — not the normal
    // case, but possible), skip it rather than show a stale warning about
    // a problem that already resolved itself.
    if MAIN_PAGE_READY.load(Ordering::SeqCst) {
        log::info!(
            "startup watchdog: page finished loading just before the stall dialog would have shown — skipping it"
        );
        return;
    }

    let shown = STALL_DIALOGS_SHOWN.fetch_add(1, Ordering::SeqCst) + 1;
    let offer_retry = shown <= MAX_STALL_DIALOGS;

    let (title, message, buttons) = if offer_retry {
        (
            "Lazy is stuck starting up",
            "Lazy's window has not finished loading. This usually happens when your computer is \
             very low on memory or under heavy load, which stops the app's browser component \
             from starting.\n\n\
             You can try Retry to recreate the window now, or Quit and reopen Lazy once more \
             memory is free.",
            MessageDialogButtons::OkCancelCustom("Retry".to_string(), "Quit".to_string()),
        )
    } else {
        (
            "Lazy could not start its window",
            "Lazy's window still has not loaded after multiple attempts. Your computer is likely \
             still low on memory or under heavy load.\n\n\
             Please close some other applications to free up memory, then quit and reopen Lazy.",
            MessageDialogButtons::OkCustom("Quit".to_string()),
        )
    };

    // `blocking_show` is documented by tauri-plugin-dialog as unsafe to call
    // from the main thread (it would freeze the whole app waiting on
    // itself) — safe here: `run_watchdog` (this function's only caller)
    // always runs on its own dedicated thread, never the main/event-loop
    // thread (see `spawn_startup_watchdog`'s own doc comment).
    let retry = app_handle
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(buttons)
        .blocking_show();

    if offer_retry && retry {
        log::info!("startup watchdog: user chose Retry — recreating the \"main\" window in place");
        MAIN_PAGE_READY.store(false, Ordering::SeqCst);
        crate::webview_recovery::recover_from_startup_stall(&app_handle);
        // The recreated window gets its own fresh watchdog cycle, in case
        // the retry stalls too (e.g. the machine is still starved) —
        // `MAX_STALL_DIALOGS` still bounds how many times this can repeat.
        spawn_startup_watchdog(app_handle);
    } else {
        log::warn!(
            "startup watchdog: user chose Quit (or retry attempts are exhausted) — exiting cleanly"
        );
        app_handle.exit(0);
    }
}

/// Durably records the stall (`commands::journal::emit_system_event`, actor
/// `"system"`) so it is COUNTED and honest, never just a transient log line
/// nobody reads — mirrors `webview_recovery::emit_recovery_journal_event`'s
/// own rationale and degrade-to-warning shape almost verbatim (including
/// `project_id: "unknown"` for the same "no project to scope a
/// machine-level event to" reason). A live `app.emit` companion is included
/// too, same as that sibling function, though in THIS specific failure mode
/// no frontend listener is realistically mounted to receive it (the whole
/// point of this bug is that the page never finished loading) — kept for
/// consistency and for the (recovered-in-place) case where a later, still
/// this-process, listener could plausibly read it back via the durable
/// journal anyway.
fn emit_startup_stalled_journal_event(app_handle: &tauri::AppHandle) {
    let payload = serde_json::json!({ "timeout_secs": STARTUP_READY_TIMEOUT.as_secs() });

    if let Some(journal_state) = app_handle.try_state::<JournalState>() {
        crate::commands::journal::emit_system_event(&journal_state, "unknown", "app.startupStalled", payload.clone());
    } else {
        log::warn!(
            "emit_startup_stalled_journal_event: JournalState not managed yet — 'app.startupStalled' was not journaled"
        );
    }

    use tauri::Emitter;
    let _ = app_handle.emit("app.startupStalled", payload);
}

// ── Pure/deterministic pieces — unit tests ──────────────────────────
//
// Everything COM/WebView2/native-dialog-touching here (`spawn_startup_watchdog`,
// `run_watchdog`, `handle_stall`) needs a real running app + a real WebView2
// runtime + a real user clicking a real native dialog, exactly like
// `webview_recovery.rs`'s own COM paths — there is no way to fake any of
// that from `cargo test`. What CAN be, and is, unit-tested is the
// `MAX_STALL_DIALOGS` bound the retry-offer decision itself is built from.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_stall_dialogs_is_exactly_two() {
        // Pins the constant so a future accidental edit (e.g. "just bump it
        // to 5") shows up here instead of only as a silent behavior change
        // in the field — same rationale as
        // `webview_recovery::max_in_place_recovery_attempts_is_exactly_two`.
        assert_eq!(MAX_STALL_DIALOGS, 2);
    }

    #[test]
    fn first_and_second_dialog_offer_retry_third_does_not() {
        // Mirrors `handle_stall`'s own `shown <= MAX_STALL_DIALOGS` check
        // without needing a live dialog/COM call.
        let offers_retry = |shown: u8| shown <= MAX_STALL_DIALOGS;
        assert!(offers_retry(1), "first dialog must offer Retry");
        assert!(offers_retry(2), "second dialog must offer Retry");
        assert!(!offers_retry(3), "third dialog must be Quit-only, never an infinite retry loop");
    }

    #[test]
    fn startup_ready_timeout_is_generous_but_bounded() {
        // Guards against an accidental edit collapsing this to something so
        // short it false-positives on an ordinary slow-but-healthy boot, or
        // so long the user is left staring at a blank window for minutes —
        // see the constant's own doc comment for the reasoning.
        assert!(STARTUP_READY_TIMEOUT >= Duration::from_secs(10));
        assert!(STARTUP_READY_TIMEOUT <= Duration::from_secs(60));
    }
}
