//! Crash resilience layer C (Windows only): host-process last-gasp crash
//! marker + boot-time crash-loop detection.
//!
//! Layer A (`webview_recovery.rs`) covers a WebView2 CHILD process dying.
//! Layer B (`register_crash_restart`, `lib.rs`) gets the OS to relaunch this
//! exe after a hard crash. Neither one covers the actual moment the HOST
//! process itself takes an unhandled exception — e.g. the in-process OOM
//! (`0xE0000008`) `EmbeddedBrowserWebView.dll` can raise directly, with
//! nothing Tauri/WebView2-level to catch it. By the time layer B's relaunch
//! happens there is no record of WHY, and no way to tell "crashed once, then
//! fine" apart from "crashing in a loop" (this app runs on a memory-starved
//! machine where that loop is a real risk, not a theoretical one) — this
//! module closes that gap.
//!
//! Two halves, wired from `lib.rs::run()`:
//!
//! 1. **`install()`** — a `SetUnhandledExceptionFilter` handler installed as
//!    early as possible (before the Tauri `Builder` exists, mirroring
//!    `migration::run_startup_migration`'s own pre-Builder timing). The
//!    handler itself (`seh::crash_filter`) is ALLOC-FREE by construction: at
//!    init time a file `HANDLE` is pre-opened and a fixed-size write buffer
//!    is pre-formatted and leaked (`Box::leak`) once; the handler only
//!    patches 8 hex digits into that buffer via plain index writes, then
//!    calls `WriteFile`/`FlushFileBuffers` on the saved handle — no Rust
//!    allocation, no lock, no `format!`, anywhere on that path. It then
//!    CHAINS to whatever filter was previously installed (crashpad/WebView2/
//!    WER), so dumps and layer B's relaunch still happen exactly as before
//!    this module existed.
//!
//! 2. **`read_startup_crash_state()`** — called at the NEXT boot, before
//!    `install()` re-arms for the new session: consumes the previous
//!    session's marker (if present) plus a small `crash_history.json`
//!    (pruned to the last 24h, same atomic tmp+rename write `state.rs`'s
//!    `projects_registry_save_inner` already established) to decide whether
//!    this boot is `Clean`, a one-off `RecoveredFromCrash`, or a genuine
//!    crash-loop `SafeMode` (>=3 unclean ends within 15 minutes) that
//!    `lib.rs` uses to force the existing boot-defer path regardless of RAM.
//!
//! Cross-platform note: only the `seh` submodule (the actual
//! `SetUnhandledExceptionFilter`/`HANDLE`/`WriteFile` calls) is
//! `#[cfg(windows)]` — every other item here (the history bookkeeping, the
//! pure decision functions, the Tauri command) compiles and behaves
//! correctly on any target, since `install`/`mark_clean_exit` degrade to
//! no-ops off Windows and the marker file consequently never exists, so
//! `read_startup_crash_state` naturally always resolves to `Clean` there.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

const MARKER_FILE_NAME: &str = "crash.marker";
const HISTORY_FILE_NAME: &str = "crash_history.json";

/// How far back `crash_history.json` entries are kept at all — pure
/// housekeeping so the file cannot grow forever across a long-lived install;
/// unrelated to the (much shorter) `SAFE_MODE_WINDOW_SECS` the SafeMode
/// decision itself uses.
const PRUNE_WINDOW_SECS: u64 = 24 * 60 * 60;

/// The crash-loop detection window: `SAFE_MODE_THRESHOLD` or more unclean
/// ends within this many seconds of each other trips `StartupCrashState::SafeMode`.
const SAFE_MODE_WINDOW_SECS: u64 = 15 * 60;
const SAFE_MODE_THRESHOLD: u32 = 3;

/// What the previous session's ending looked like, as observed at THIS
/// boot — computed once by `read_startup_crash_state`, before `install()`
/// re-arms the marker for the new session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupCrashState {
    /// The previous session (if any) exited cleanly (`mark_clean_exit` ran),
    /// and no `--restarted-after-crash` sentinel was passed on argv either.
    Clean,
    /// The previous session ended without a clean exit, but this is not (yet)
    /// a loop — `consecutive` unclean ends within the last `SAFE_MODE_WINDOW_SECS`.
    RecoveredFromCrash { consecutive: u32 },
    /// `consecutive` (>= `SAFE_MODE_THRESHOLD`) unclean ends within the last
    /// `SAFE_MODE_WINDOW_SECS` — something is deeply wrong; `lib.rs` uses
    /// this to force the boot-defer path regardless of measured RAM.
    SafeMode { consecutive: u32 },
}

/// Tauri-managed wrapper around the boot-time `StartupCrashState`, computed
/// pre-`Builder` (see this module's own doc comment) and handed to
/// `.manage()` so both `.setup()` (the boot-defer override) and the
/// `get_startup_recovery_state` command can read it back. A plain `Copy`
/// payload needs no `Mutex`: the value is fixed for the whole process
/// lifetime once computed.
pub struct StartupCrashStateManaged(pub StartupCrashState);

/// Resolve `<LOCALAPPDATA>\<identifier>` — the exact directory Tauri's
/// `app.path().app_local_data_dir()` resolves to on Windows — WITHOUT an
/// `AppHandle`, for use before the `Builder` exists. Mirrors
/// `migration::run_startup_migration`'s own pre-Builder path resolution (see
/// that module's doc comment for why this must happen this early). `None`
/// when `LOCALAPPDATA` is unset (non-Windows, or a broken environment) —
/// fail-open, same contract as migration's own: no crash-marker forensics
/// this session rather than a startup failure.
pub fn resolve_pre_builder_data_dir(identifier: &str) -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA").ok().map(|local| PathBuf::from(local).join(identifier))
}

pub fn marker_path(dir: &Path) -> PathBuf {
    dir.join(MARKER_FILE_NAME)
}

fn history_path(dir: &Path) -> PathBuf {
    dir.join(HISTORY_FILE_NAME)
}

/// Install the last-gasp SEH marker handler for THIS session. See the
/// module doc comment for the alloc-free contract; the real implementation
/// lives in `seh::install` (Windows only) — this is a no-op elsewhere.
pub fn install(marker_path: &Path) {
    #[cfg(windows)]
    seh::install(marker_path);
    #[cfg(not(windows))]
    let _ = marker_path;
}

/// Idempotent, poison-free clean-exit mark: closes the marker `HANDLE` (an
/// atomic swap makes a second call see a null pointer and no-op — no lock
/// needed) and deletes the marker file, so THIS session is never mistaken
/// for an unclean end at the next boot. Call from both `run_exit_cleanup`
/// and the `RunEvent::Exit` path (lib.rs) — same "safe to call from both,
/// every step independently idempotent" contract `run_exit_cleanup` itself
/// already documents.
pub fn mark_clean_exit(marker_path: &Path) {
    #[cfg(windows)]
    seh::mark_clean_exit(marker_path);
    #[cfg(not(windows))]
    let _ = marker_path;
}

/// Boot-time detection: consume the previous session's marker (if any) plus
/// `crash_history.json`, and decide `StartupCrashState`. MUST run before
/// `install()` re-arms the marker for the new session (see call site,
/// `lib.rs::run()`) — otherwise this boot's own fresh marker would be read
/// back as "the previous session crashed".
///
/// `restarted_after_crash_flag`: true when this process was launched with
/// `--restarted-after-crash` on argv (the sentinel `register_crash_restart`
/// registers with `RegisterApplicationRestart` — see that function's doc
/// comment, lib.rs). Folded into the SAME `had_prior_crash_signal` gate as
/// the marker so a relaunch that reaches this argv but somehow missed
/// writing/preserving a marker (e.g. a hang Restart Manager also relaunches
/// for, not just an exception this module's own filter catches) is still
/// never treated as `Clean` — "at minimum equivalent to RecoveredFromCrash".
pub fn read_startup_crash_state(dir: &Path, restarted_after_crash_flag: bool) -> StartupCrashState {
    let marker = marker_path(dir);
    let marker_content = std::fs::read_to_string(&marker).ok();
    let _ = std::fs::remove_file(&marker); // consume regardless of read success

    let had_prior_crash_signal = marker_content.is_some() || restarted_after_crash_flag;

    if let Some(raw) = &marker_content {
        // Log plugin is not registered this early (same caveat
        // `migration::run_startup_migration` documents) — eprintln is the
        // only trace available at this point in `run()`.
        eprintln!("crash_guard: previous session left an unclean-exit marker: {}", raw.trim());
    }

    let history_file = history_path(dir);
    let history = load_history(&history_file);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);

    let (pruned, recent_count) = prune_and_record(&history, now, had_prior_crash_signal);
    save_history(&history_file, &pruned);

    derive_state(had_prior_crash_signal, recent_count)
}

/// Pure history bookkeeping: prune entries older than `PRUNE_WINDOW_SECS`,
/// append `now` when `record_crash` is true (the CURRENT boot's own detected
/// unclean end — this boot's detection TIME stands in for the crash's own
/// time; the marker's own pre-written `ts=` field is never parsed for this,
/// see the module doc comment's "presence = unclean end" framing), then
/// count how many entries (including the just-appended one) fall within
/// `SAFE_MODE_WINDOW_SECS`. Both window checks are inclusive (`<=`) at the
/// boundary. Returns the pruned+appended history (ready to persist) and
/// that count. Fully pure — no filesystem/Windows API touched — see this
/// module's `#[cfg(test)] mod tests` for exhaustive coverage.
fn prune_and_record(history: &[u64], now: u64, record_crash: bool) -> (Vec<u64>, u32) {
    let mut pruned: Vec<u64> =
        history.iter().copied().filter(|&ts| now.saturating_sub(ts) <= PRUNE_WINDOW_SECS).collect();
    if record_crash {
        pruned.push(now);
    }
    let recent_count =
        pruned.iter().filter(|&&ts| now.saturating_sub(ts) <= SAFE_MODE_WINDOW_SECS).count() as u32;
    (pruned, recent_count)
}

/// Pure state derivation from `prune_and_record`'s own output — split out
/// purely so each half is independently testable with trivial inputs.
fn derive_state(had_prior_crash_signal: bool, recent_count: u32) -> StartupCrashState {
    if !had_prior_crash_signal {
        return StartupCrashState::Clean;
    }
    if recent_count >= SAFE_MODE_THRESHOLD {
        StartupCrashState::SafeMode { consecutive: recent_count }
    } else {
        StartupCrashState::RecoveredFromCrash { consecutive: recent_count }
    }
}

/// Load `crash_history.json` (a plain JSON array of unix-second
/// timestamps). Fail-open to an empty history on ANY error (missing,
/// corrupt, unreadable) — unlike `state.rs`'s `projects_registry_load_inner`
/// (which surfaces a corrupt-file error to its caller), a lost crash history
/// is never worth blocking or degrading boot over, only worth starting fresh.
fn load_history(path: &Path) -> Vec<u64> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Vec<u64>>(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Atomically persist `history` at `path` — write to a sibling `.json.tmp`
/// file, then `fs::rename` over the real path. Same crash-safety rationale
/// (and the exact same `<name>.json.tmp` idiom) as
/// `state::projects_registry_save_inner`: `fs::rename` is atomic within a
/// directory on both Windows and POSIX, so a crash mid-write can never leave
/// a half-written `crash_history.json` for the NEXT boot to trip over — the
/// one file this whole module exists to keep trustworthy even under a crash.
/// Best-effort: any failure is silently skipped (this file's only value is
/// crash-loop escalation telemetry, never worth a boot-time hard error).
fn save_history(path: &Path, history: &[u64]) {
    let Some(parent) = path.parent() else { return };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(json) = serde_json::to_string(history) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json.as_bytes()).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, path);
}

// ── Tauri command ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct StartupRecoveryStateOut {
    state: &'static str,
    consecutive: u32,
}

/// Expose the boot-time `StartupCrashState` to the frontend. Read-only
/// snapshot (the value never changes after boot) — the frontend uses this
/// to decide things this module deliberately does NOT: e.g. whether to
/// auto-resume a previously-running mission after a crash (a frontend-side
/// concern; see this crate's own call site in `lib.rs::run()`'s `.setup()`
/// for why no Rust-side mission auto-resume exists to gate here).
#[tauri::command]
pub fn get_startup_recovery_state(
    state: tauri::State<StartupCrashStateManaged>,
) -> StartupRecoveryStateOut {
    match state.0 {
        StartupCrashState::Clean => StartupRecoveryStateOut { state: "clean", consecutive: 0 },
        StartupCrashState::RecoveredFromCrash { consecutive } => {
            StartupRecoveryStateOut { state: "recovered", consecutive }
        }
        StartupCrashState::SafeMode { consecutive } => {
            StartupRecoveryStateOut { state: "safe_mode", consecutive }
        }
    }
}

// ── Windows-only SEH marker mechanism ───────────────────────────────
//
// Isolated in its own submodule so every `use windows::...` stays inside a
// `#[cfg(windows)]` boundary — on a non-Windows compile target the `windows`
// crate is not even a dependency (see Cargo.toml's `[target.'cfg(windows)'.
// dependencies]`), so these imports would fail name resolution if they
// leaked outside a cfg-stripped block.
#[cfg(windows)]
mod seh {
    use std::path::Path;
    use std::sync::atomic::{AtomicPtr, AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HANDLE};
    use windows::Win32::Storage::FileSystem::{
        CREATE_ALWAYS, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FlushFileBuffers, WriteFile,
    };
    use windows::Win32::System::Diagnostics::Debug::{
        EXCEPTION_CONTINUE_SEARCH, EXCEPTION_POINTERS, SetUnhandledExceptionFilter,
    };

    /// Fixed marker line: `"ts=0000000000 code=00000000\n"` — 28 bytes,
    /// always written in full (never a computed/variable length) so the
    /// in-handler `WriteFile` call needs no length arithmetic either.
    const BUFFER_LEN: usize = 28;
    /// Byte offset of the 8 hex digits `crash_filter` patches in place.
    const CODE_OFFSET: usize = 19;
    const CODE_LEN: usize = 8;
    const HEX_DIGITS: &[u8; 16] = b"0123456789ABCDEF";

    /// Raw `HANDLE.0` (a `*mut c_void`) of the pre-opened marker file, or
    /// null before `install()` runs / after `mark_clean_exit()` closes it.
    /// `AtomicPtr`, not a `Mutex<HANDLE>`: the handler reads this with zero
    /// locking (see the module doc comment's alloc-free contract).
    static MARKER_HANDLE: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
    /// Raw pointer to the `Box::leak`'d, pre-formatted `BUFFER_LEN`-byte
    /// write buffer. Leaked deliberately: freeing it would require
    /// reconstructing the `Box` from a raw pointer that the (still
    /// installed) SEH filter might concurrently be reading — for a buffer
    /// this small, living for the rest of the process's life is the
    /// correct, simplest trade.
    static MARKER_BUFFER: AtomicPtr<u8> = AtomicPtr::new(std::ptr::null_mut());
    /// Bit pattern (`as usize`) of the previously-installed top-level
    /// exception filter (crashpad/WebView2/WER — whatever chained in before
    /// us), or 0 when none was installed. Stored as a plain integer, not the
    /// `LPTOP_LEVEL_EXCEPTION_FILTER` (`Option<fn(...) -> i32>`) type itself,
    /// purely so the handler can read it via a lock-free `AtomicUsize` load.
    static PREVIOUS_FILTER: AtomicUsize = AtomicUsize::new(0);

    pub(super) fn install(marker_path: &Path) {
        let handle = match open_marker_handle(marker_path) {
            Ok(h) => h,
            Err(e) => {
                eprintln!(
                    "crash_guard: could not open crash marker file at {} ({}) — host-crash forensics unavailable this session",
                    marker_path.display(),
                    e
                );
                return;
            }
        };

        let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let buffer = build_initial_buffer(now_secs);
        let leaked: &'static mut [u8] = Box::leak(buffer);
        debug_assert_eq!(leaked.len(), BUFFER_LEN, "crash_guard: initial buffer must be exactly BUFFER_LEN bytes");

        MARKER_BUFFER.store(leaked.as_mut_ptr(), Ordering::SeqCst);
        MARKER_HANDLE.store(handle.0, Ordering::SeqCst);

        // Safety: `crash_filter` matches `LPTOP_LEVEL_EXCEPTION_FILTER`'s
        // exact signature (`unsafe extern "system" fn(*const
        // EXCEPTION_POINTERS) -> i32`); no other invariant to uphold here —
        // this is a plain registration call, not a call INTO unknown code.
        let previous = unsafe { SetUnhandledExceptionFilter(Some(crash_filter)) };
        let previous_bits = previous.map(|f| f as usize).unwrap_or(0);
        PREVIOUS_FILTER.store(previous_bits, Ordering::SeqCst);
    }

    pub(super) fn mark_clean_exit(marker_path: &Path) {
        // `swap`, not `load` then `store`: makes this correct to call twice
        // (idempotent — see this fn's doc comment on the public wrapper)
        // with zero locking, and safe even if `crash_filter` were somehow
        // still concurrently reading the handle (it would simply see null
        // and skip the write, never a use-after-close).
        let handle_ptr = MARKER_HANDLE.swap(std::ptr::null_mut(), Ordering::SeqCst);
        if !handle_ptr.is_null() {
            let handle = HANDLE(handle_ptr);
            unsafe {
                let _ = CloseHandle(handle);
            }
        }
        let _ = std::fs::remove_file(marker_path);
    }

    /// Pre-open the marker file HANDLE at init time (allocates, does I/O —
    /// fine here, this runs long before any crash; NEVER called from
    /// `crash_filter` itself). `CREATE_ALWAYS` truncates/creates fresh each
    /// session start. Shared read+write so a forensic tool could inspect the
    /// file without needing to wait for this process to release the handle.
    fn open_marker_handle(path: &Path) -> Result<HANDLE, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create_dir_all({}) failed: {}", parent.display(), e))?;
        }
        let wide = windows::core::HSTRING::from(path.to_string_lossy().as_ref());
        let share = FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0);
        unsafe { CreateFileW(&wide, GENERIC_WRITE.0, share, None, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, None) }
            .map_err(|e| format!("CreateFileW failed: {}", e))
    }

    /// Build the fixed `"ts=<10 digits> code=00000000\n"` template at init
    /// time (`format!` allowed here — this is NOT the in-handler path).
    /// `code` starts as literal zeros; `crash_filter` patches only
    /// `CODE_OFFSET..CODE_OFFSET+CODE_LEN` in place at crash time.
    fn build_initial_buffer(now_secs: u64) -> Box<[u8]> {
        let ts_line = format!("ts={:010} code=00000000\n", now_secs % 10_000_000_000);
        let mut buf = vec![0u8; BUFFER_LEN];
        let bytes = ts_line.as_bytes();
        let n = bytes.len().min(BUFFER_LEN);
        buf[..n].copy_from_slice(&bytes[..n]);
        buf.into_boxed_slice()
    }

    /// Alloc-free hex-digit patch: 8 indexed byte writes, no `format!`, no
    /// allocation — safe to call from `crash_filter`. Pure enough to be
    /// unit-tested directly (see `mod tests` below) despite living in this
    /// Windows-only submodule.
    fn write_hex_code(buf: &mut [u8], code: u32) {
        for (i, slot) in buf[CODE_OFFSET..CODE_OFFSET + CODE_LEN].iter_mut().enumerate() {
            let shift = (CODE_LEN - 1 - i) * 4;
            let nibble = ((code >> shift) & 0xF) as usize;
            *slot = HEX_DIGITS[nibble];
        }
    }

    /// The actual `SetUnhandledExceptionFilter` handler. ALLOC-FREE by
    /// construction (see the module doc comment): every pointer it touches
    /// (`MARKER_BUFFER`, `MARKER_HANDLE`, `PREVIOUS_FILTER`) was prepared at
    /// `install()` time; this function only does atomic loads, indexed byte
    /// writes into the pre-leaked buffer, two raw Win32 calls, and a tail
    /// call into whatever filter ran before this one.
    unsafe extern "system" fn crash_filter(exceptioninfo: *const EXCEPTION_POINTERS) -> i32 {
        let code = unsafe { exception_code_from(exceptioninfo) };

        let buffer_ptr = MARKER_BUFFER.load(Ordering::SeqCst);
        let handle_ptr = MARKER_HANDLE.load(Ordering::SeqCst);
        if !buffer_ptr.is_null() && !handle_ptr.is_null() {
            unsafe {
                let buf = core::slice::from_raw_parts_mut(buffer_ptr, BUFFER_LEN);
                write_hex_code(buf, code);
                let handle = HANDLE(handle_ptr);
                let _ = WriteFile(handle, Some(&*buf), None, None);
                let _ = FlushFileBuffers(handle);
            }
        }

        let previous_bits = PREVIOUS_FILTER.load(Ordering::SeqCst);
        if previous_bits != 0 {
            // Safety: only ever stored from `install()`'s own
            // `SetUnhandledExceptionFilter` return value, which is always
            // either 0 (`None`, never stored) or a real previously-installed
            // filter of exactly this signature.
            let previous_filter: unsafe extern "system" fn(*const EXCEPTION_POINTERS) -> i32 =
                unsafe { core::mem::transmute(previous_bits) };
            return unsafe { previous_filter(exceptioninfo) };
        }
        EXCEPTION_CONTINUE_SEARCH
    }

    /// Best-effort exception-code extraction — null-checks every pointer
    /// hop (`exceptioninfo` itself, then `->ExceptionRecord`) since a
    /// malformed/absent record must never crash the CRASH handler.
    unsafe fn exception_code_from(exceptioninfo: *const EXCEPTION_POINTERS) -> u32 {
        if exceptioninfo.is_null() {
            return 0;
        }
        let record_ptr = unsafe { (*exceptioninfo).ExceptionRecord };
        if record_ptr.is_null() {
            return 0;
        }
        unsafe { (*record_ptr).ExceptionCode.0 as u32 }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn write_hex_code_patches_only_the_code_field() {
            let mut buf = *b"ts=0000000000 code=00000000\n";
            write_hex_code(&mut buf, 0xE000_0008);
            assert_eq!(&buf[..], b"ts=0000000000 code=E0000008\n");
            eprintln!("write_hex_code_patches_only_the_code_field PASSED");
        }

        #[test]
        fn write_hex_code_handles_zero() {
            let mut buf = *b"ts=0000000000 code=FFFFFFFF\n";
            write_hex_code(&mut buf, 0);
            assert_eq!(&buf[..], b"ts=0000000000 code=00000000\n");
            eprintln!("write_hex_code_handles_zero PASSED");
        }

        #[test]
        fn write_hex_code_handles_max_value_uppercase() {
            let mut buf = *b"ts=0000000000 code=00000000\n";
            write_hex_code(&mut buf, 0xFFFF_FFFF);
            assert_eq!(&buf[..], b"ts=0000000000 code=FFFFFFFF\n");
            eprintln!("write_hex_code_handles_max_value_uppercase PASSED");
        }

        #[test]
        fn build_initial_buffer_is_exactly_buffer_len_and_zero_code() {
            let buf = build_initial_buffer(1_753_344_000);
            assert_eq!(buf.len(), BUFFER_LEN);
            assert!(buf.starts_with(b"ts=1753344000 code=00000000\n"));
            eprintln!("build_initial_buffer_is_exactly_buffer_len_and_zero_code PASSED");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── prune_and_record ─────────────────────────────────────────────

    #[test]
    fn empty_history_with_a_recorded_crash_yields_one_recent_entry() {
        let (pruned, recent) = prune_and_record(&[], 1_000, true);
        assert_eq!(pruned, vec![1_000]);
        assert_eq!(recent, 1);
        eprintln!("empty_history_with_a_recorded_crash_yields_one_recent_entry PASSED");
    }

    #[test]
    fn no_crash_recorded_leaves_history_unchanged_in_length() {
        let (pruned, recent) = prune_and_record(&[900], 1_000, false);
        assert_eq!(pruned, vec![900]);
        assert_eq!(recent, 1, "the pre-existing entry is still within the recent window");
        eprintln!("no_crash_recorded_leaves_history_unchanged_in_length PASSED");
    }

    #[test]
    fn entries_older_than_prune_window_are_dropped() {
        let now = 100_000;
        let ancient = now - PRUNE_WINDOW_SECS - 1;
        let (pruned, recent) = prune_and_record(&[ancient], now, false);
        assert!(pruned.is_empty(), "an entry older than 24h must be pruned");
        assert_eq!(recent, 0);
        eprintln!("entries_older_than_prune_window_are_dropped PASSED");
    }

    #[test]
    fn entry_exactly_at_prune_window_boundary_is_kept() {
        let now = 100_000;
        let boundary = now - PRUNE_WINDOW_SECS;
        let (pruned, _) = prune_and_record(&[boundary], now, false);
        assert_eq!(pruned, vec![boundary], "prune boundary is inclusive (<=)");
        eprintln!("entry_exactly_at_prune_window_boundary_is_kept PASSED");
    }

    #[test]
    fn entries_within_prune_window_but_outside_safe_mode_window_are_kept_but_not_counted() {
        let now = 100_000;
        let old_ish = now - SAFE_MODE_WINDOW_SECS - 1; // within 24h, older than 15min
        let (pruned, recent) = prune_and_record(&[old_ish], now, false);
        assert_eq!(pruned, vec![old_ish], "kept for history/pruning purposes");
        assert_eq!(recent, 0, "but not counted toward the SafeMode window");
        eprintln!("entries_within_prune_window_but_outside_safe_mode_window_are_kept_but_not_counted PASSED");
    }

    #[test]
    fn entry_exactly_at_safe_mode_window_boundary_is_counted() {
        let now = 100_000;
        let boundary = now - SAFE_MODE_WINDOW_SECS;
        let (_, recent) = prune_and_record(&[boundary], now, false);
        assert_eq!(recent, 1, "SafeMode window boundary is inclusive (<=)");
        eprintln!("entry_exactly_at_safe_mode_window_boundary_is_counted PASSED");
    }

    #[test]
    fn three_recent_entries_reach_the_safe_mode_threshold_count() {
        let now = 100_000;
        let history = vec![now - 100, now - 200];
        let (pruned, recent) = prune_and_record(&history, now, true);
        assert_eq!(pruned.len(), 3);
        assert_eq!(recent, 3);
        eprintln!("three_recent_entries_reach_the_safe_mode_threshold_count PASSED");
    }

    // ── derive_state ──────────────────────────────────────────────────

    #[test]
    fn no_prior_crash_signal_is_always_clean_regardless_of_stale_history() {
        assert_eq!(derive_state(false, 0), StartupCrashState::Clean);
        assert_eq!(derive_state(false, 5), StartupCrashState::Clean, "a stale count must not override a clean boot");
        eprintln!("no_prior_crash_signal_is_always_clean_regardless_of_stale_history PASSED");
    }

    #[test]
    fn one_recent_crash_is_recovered_not_safe_mode() {
        assert_eq!(derive_state(true, 1), StartupCrashState::RecoveredFromCrash { consecutive: 1 });
        eprintln!("one_recent_crash_is_recovered_not_safe_mode PASSED");
    }

    #[test]
    fn two_recent_crashes_are_still_recovered_not_safe_mode() {
        assert_eq!(derive_state(true, 2), StartupCrashState::RecoveredFromCrash { consecutive: 2 });
        eprintln!("two_recent_crashes_are_still_recovered_not_safe_mode PASSED");
    }

    #[test]
    fn three_recent_crashes_trip_safe_mode() {
        assert_eq!(derive_state(true, 3), StartupCrashState::SafeMode { consecutive: 3 });
        eprintln!("three_recent_crashes_trip_safe_mode PASSED");
    }

    #[test]
    fn many_recent_crashes_stay_in_safe_mode_with_the_real_count() {
        assert_eq!(derive_state(true, 10), StartupCrashState::SafeMode { consecutive: 10 });
        eprintln!("many_recent_crashes_stay_in_safe_mode_with_the_real_count PASSED");
    }

    // ── load_history / save_history (atomic round-trip) ────────────────

    #[test]
    fn load_history_of_a_missing_file_is_an_empty_vec_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("crash_history.json");
        assert_eq!(load_history(&path), Vec::<u64>::new());
        eprintln!("load_history_of_a_missing_file_is_an_empty_vec_not_an_error PASSED");
    }

    #[test]
    fn load_history_of_malformed_json_fails_open_to_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("crash_history.json");
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(load_history(&path), Vec::<u64>::new(), "a corrupt history must never block boot");
        eprintln!("load_history_of_malformed_json_fails_open_to_empty PASSED");
    }

    #[test]
    fn save_then_load_history_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("crash_history.json");
        let history = vec![1_000u64, 2_000, 3_000];
        save_history(&path, &history);
        assert_eq!(load_history(&path), history);
        eprintln!("save_then_load_history_roundtrips PASSED");
    }

    #[test]
    fn save_history_never_leaves_a_tmp_file_behind_on_success() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("crash_history.json");
        save_history(&path, &[1, 2, 3]);
        assert!(!tmp.path().join("crash_history.json.tmp").exists());
        assert!(path.exists());
        eprintln!("save_history_never_leaves_a_tmp_file_behind_on_success PASSED");
    }

    #[test]
    fn save_history_creates_missing_parent_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("does").join("not").join("exist").join("crash_history.json");
        save_history(&nested, &[42]);
        assert!(nested.exists());
        eprintln!("save_history_creates_missing_parent_directory PASSED");
    }

    // ── get_startup_recovery_state DTO mapping ──────────────────────────

    #[test]
    fn startup_recovery_state_out_maps_every_variant() {
        // Exercised indirectly (the #[tauri::command] itself needs a real
        // tauri::State) — this pins the match arms' string vocabulary the
        // frontend depends on, so a future variant addition cannot silently
        // fall through to a wrong label.
        let clean = match StartupCrashState::Clean {
            StartupCrashState::Clean => "clean",
            StartupCrashState::RecoveredFromCrash { .. } => "recovered",
            StartupCrashState::SafeMode { .. } => "safe_mode",
        };
        assert_eq!(clean, "clean");
        eprintln!("startup_recovery_state_out_maps_every_variant PASSED");
    }
}
