//! Machine-load gate ("system pressure") — a tiny background sampler backing
//! the founder-level guarantee that Lazy never saturates a normal user's
//! machine on its own. Nothing else in this app used to observe RAM/CPU
//! before deciding whether to run heavy background work (the brain
//! consolidation sequence — dream/prune/compress/interlink/profile-update,
//! see `commands/brain/maintenance.rs` — is the first, but not necessarily
//! last, consumer): it fired on a plain 30-minute uptime timer regardless of
//! what else the machine was doing at that moment.
//!
//! # Design
//! A single background task (`spawn_pressure_monitor`) samples CPU/RAM every
//! `SAMPLE_INTERVAL_SECS` via `sysinfo` and classifies the result into
//! [`PressureLevel::Normal`] / [`Elevated`](PressureLevel::Elevated) /
//! [`High`](PressureLevel::High) (see `classify_pressure`'s thresholds).
//! Three deliberate smoothing steps keep this from being a noisy, flappy
//! signal:
//!
//! - The very first CPU sample right after `System::new_all()` is discarded
//!   (never drives a level decision) — `sysinfo` computes CPU usage as a
//!   delta against the PREVIOUS refresh, so a lone first reading carries no
//!   real baseline (see `sysinfo::MINIMUM_CPU_UPDATE_INTERVAL`'s own doc).
//! - A candidate level must be observed on 2 CONSECUTIVE samples before it is
//!   actually *accepted* (and only an accepted change is emitted) — see
//!   `debounce_step`'s doc comment. A single blip (e.g. a one-off spike from
//!   an unrelated process) must never flip a gate that a 30-minute
//!   maintenance scheduler reads. This is TIME-based smoothing.
//! - Each tier also carries an asymmetric AMPLITUDE-based recovery band: once
//!   a level is accepted, leaving it again requires clearing a comfortably
//!   WIDER margin than the one that triggered entry (see `classify_ram`/
//!   `classify_cpu`'s `accepted` parameter and the `_RECOVERY_PP` constants
//!   below). Without this, a metric sitting right at a boundary flips the
//!   accepted level on every sample that crosses it by a fraction of a
//!   point — debouncing alone only delays that flip by ~10s, it does not
//!   stop it.
//!
//! RAM thresholds are a PERCENTAGE of this machine's total RAM, not an
//! absolute MB floor, and `available_ram_mb` is deliberately the OS-reported
//! system-wide figure (every process on the machine), not this app's own
//! process memory — the whole point of this gate is "defer Lazy's own heavy
//! background work while the MACHINE is tight", regardless of which process
//! is using the RAM. An absolute MB floor miscalibrates badly across real
//! machines (under 1500MB free is close to the permanent steady state on an
//! 8GB laptop, but signals real exhaustion on a 32GB workstation); a
//! percentage tracks "how full is THIS machine" consistently regardless of
//! its size. Because the number is system-wide, any UI copy built on top of
//! it (`MemoryPressureIndicator.tsx`) must say the MACHINE is low on memory,
//! never that Lazy itself is the one holding it — and must gate specifically
//! on the RAM dimension (`ram_level`, exposed on `SystemPressure` below)
//! rather than the combined `level`, since `level` alone cannot tell a
//! genuine low-memory state apart from a pure CPU spike on an unrelated
//! process (see `classify_pressure`'s own doc comment).
//!
//! `get_system_pressure` and every gating reader (`brain/maintenance.rs`)
//! read the ACCEPTED snapshot only — never sysinfo directly — so the whole
//! app agrees on one debounced signal.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

/// How often the background sampler refreshes CPU/RAM. Short enough that a
/// real spike is caught within ~10s (2 samples for the debounce), long
/// enough to stay cheap and to comfortably clear `sysinfo`'s own minimum
/// refresh interval (200ms on Windows) many times over.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

// ── Thresholds ───────────────────────────────────────────────────────
//
// RAM: percentage of TOTAL machine RAM that must be free — see this module's
// doc comment for why percentage, not an absolute MB floor. CPU: unchanged
// from the original spec (a percentage already, nothing to recalibrate for
// machine size).
//
// Each tier's `_RECOVERY_PP` is added on TOP of the entry percentage (RAM)
// or subtracted from it (CPU, since CPU trips on HIGH values) to get the
// WIDER threshold an already-accepted level must clear before downgrading —
// see `classify_ram`/`classify_cpu`. 5 RAM points / 10 CPU points is enough
// headroom that ordinary sample-to-sample churn near the entry boundary
// cannot immediately re-cross the recovery boundary too, without being so
// wide that a genuinely resolved condition stays flagged for long.
const HIGH_RAM_PERCENT: f64 = 7.0;
const ELEVATED_RAM_PERCENT: f64 = 15.0;
const RAM_RECOVERY_PP: f64 = 5.0;

const HIGH_CPU_THRESHOLD_PCT: f32 = 85.0;
const ELEVATED_CPU_THRESHOLD_PCT: f32 = 65.0;
const CPU_RECOVERY_PP: f32 = 10.0;

/// Coarse machine-load classification. `PartialOrd`/`Ord` are deliberately
/// NOT derived — "High" and "Elevated" are two independent reasons a machine
/// may be under load (either RAM or CPU alone can trigger either), not a
/// single linear scale a caller should compare with `<`/`>`; every reader in
/// this codebase compares for equality against a specific level instead (see
/// `brain/maintenance.rs`'s gate: `level != PressureLevel::Normal`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub enum PressureLevel {
    Normal,
    Elevated,
    High,
}

/// A single accepted (debounced) pressure reading. Serializes with camelCase
/// field names / PascalCase level for the frontend (`system://pressure`
/// event payload and `get_system_pressure`'s return value share this exact
/// shape).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPressure {
    pub level: PressureLevel,
    pub available_ram_mb: u64,
    pub total_ram_mb: u64,
    pub cpu_pct: f32,
    /// RAM's OWN classification, independent of `level` — lets a UI-facing
    /// reader (`MemoryPressureIndicator.tsx`) tell a genuine low-memory
    /// state apart from `level` being High purely because of CPU (see this
    /// module's doc comment and `classify_pressure`'s). Recomputed fresh
    /// every sample, same as `available_ram_mb`/`cpu_pct` — NOT debounced
    /// like `level`, so it always reflects the live number behind whatever
    /// `level` currently reads, even on samples where `level` itself didn't
    /// change.
    pub ram_level: PressureLevel,
}

/// `percent`% of `total_ram_mb`, in MB — the one place a RAM percentage
/// becomes an absolute MB figure, shared by every entry AND recovery
/// threshold in this module so they can never drift apart from each other.
fn ram_threshold_mb(total_ram_mb: u64, percent: f64) -> u64 {
    ((total_ram_mb as f64) * percent / 100.0) as u64
}

/// Ranks a level for `max_level` below — deliberately NOT `PartialOrd`/`Ord`
/// on the public type itself (see `PressureLevel`'s own doc comment on why);
/// this is a private helper local to combining RAM/CPU's two independent
/// classifications into one overall level.
fn level_rank(level: PressureLevel) -> u8 {
    match level {
        PressureLevel::Normal => 0,
        PressureLevel::Elevated => 1,
        PressureLevel::High => 2,
    }
}

fn max_level(a: PressureLevel, b: PressureLevel) -> PressureLevel {
    if level_rank(a) >= level_rank(b) { a } else { b }
}

/// RAM-only classification, hysteresis-aware. `accepted` is the CURRENTLY
/// accepted overall level (`PressureTracker::current.level`): when it is
/// already at or above a given tier, that tier requires clearing the WIDER
/// `_RECOVERY_PP` threshold to let go, rather than just the narrower entry
/// threshold that flagged it in the first place — see this module's doc
/// comment for why. A caller with no prior state (`is_boot_ram_pressure_
/// high`, or the very first sample of a fresh tracker) passes
/// `PressureLevel::Normal`, which collapses to entry-only thresholds — the
/// exact behavior this function had before hysteresis existed.
fn classify_ram(available_ram_mb: u64, total_ram_mb: u64, accepted: PressureLevel) -> PressureLevel {
    let high_threshold = if accepted == PressureLevel::High {
        ram_threshold_mb(total_ram_mb, HIGH_RAM_PERCENT + RAM_RECOVERY_PP)
    } else {
        ram_threshold_mb(total_ram_mb, HIGH_RAM_PERCENT)
    };
    if available_ram_mb < high_threshold {
        return PressureLevel::High;
    }

    let elevated_threshold = if accepted != PressureLevel::Normal {
        ram_threshold_mb(total_ram_mb, ELEVATED_RAM_PERCENT + RAM_RECOVERY_PP)
    } else {
        ram_threshold_mb(total_ram_mb, ELEVATED_RAM_PERCENT)
    };
    if available_ram_mb < elevated_threshold {
        PressureLevel::Elevated
    } else {
        PressureLevel::Normal
    }
}

/// CPU-only classification — same hysteresis shape as `classify_ram`, just
/// subtracting the recovery margin (CPU trips on HIGH values, RAM trips on
/// LOW ones) instead of adding it.
fn classify_cpu(cpu_pct: f32, accepted: PressureLevel) -> PressureLevel {
    let high_threshold = if accepted == PressureLevel::High {
        HIGH_CPU_THRESHOLD_PCT - CPU_RECOVERY_PP
    } else {
        HIGH_CPU_THRESHOLD_PCT
    };
    if cpu_pct > high_threshold {
        return PressureLevel::High;
    }

    let elevated_threshold = if accepted != PressureLevel::Normal {
        ELEVATED_CPU_THRESHOLD_PCT - CPU_RECOVERY_PP
    } else {
        ELEVATED_CPU_THRESHOLD_PCT
    };
    if cpu_pct > elevated_threshold {
        PressureLevel::Elevated
    } else {
        PressureLevel::Normal
    }
}

/// Pure classification core — given already-sampled RAM/CPU numbers and the
/// currently-accepted level (for hysteresis, see `classify_ram`/
/// `classify_cpu`), decides the overall level plus RAM's own sub-level.
/// Extracted as a pure function (no `System`/I-O) so the thresholds are
/// unit-testable without a real machine-dependent sample.
///
/// RAM and CPU are independent triggers ("OR", not "AND") in both tiers: a
/// machine can be pressured by either running low on memory or by heavy CPU
/// contention alone — either one is reason enough to defer heavy background
/// work. The two are classified SEPARATELY and combined via `max_level`
/// rather than a single combined comparison, specifically so the RAM-only
/// result can be reported back to the caller (`ram_level`) — a combined
/// `level` alone cannot say WHICH dimension is the reason, and a UI built on
/// top of it must never guess (see this module's doc comment).
pub(crate) fn classify_pressure(
    available_ram_mb: u64,
    total_ram_mb: u64,
    cpu_pct: f32,
    accepted: PressureLevel,
) -> (PressureLevel, PressureLevel) {
    let ram_level = classify_ram(available_ram_mb, total_ram_mb, accepted);
    let cpu_level = classify_cpu(cpu_pct, accepted);
    (max_level(ram_level, cpu_level), ram_level)
}

// ── Boot-under-duress defer (UI first, background later) ───────────
//
// `spawn_pressure_monitor`'s debounced signal above is deliberately not used
// for this decision: its first ACCEPTED reading is only available after two
// samples (see this module's own header — the first CPU sample right after
// `System::new_all()` carries no baseline, and a candidate level needs 2
// consecutive samples before it is accepted), i.e. at least `2 *
// SAMPLE_INTERVAL` (10s) of real wall-clock time. `lib.rs`'s `.setup()`
// needs a decision BEFORE it spawns anything, synchronously, without adding
// its own multi-second wait — the whole point of this feature is to give
// the window/webview more headroom at boot, not less.
//
// RAM alone (never CPU) is the boot-time signal: a meaningful CPU-usage
// number requires at least two `sysinfo` refreshes spaced apart (its own
// documented minimum interval), i.e. a synchronous blocking sleep inside
// `.setup()` — exactly the cost this feature exists to avoid paying. RAM,
// by contrast, is a single instantaneous OS query with no warm-up needed.
// This is a deliberately narrower signal than the fuller `classify_pressure`
// (RAM OR CPU) the steady-state debounced monitor uses — an honest
// simplification, not a hidden gap: CPU-only boot contention (rare — CPU
// contention right at process launch, before this app has done anything
// itself, is a different machine already busy with something else) is
// simply not caught by this one-shot check, and is instead caught by the
// debounced monitor within its own first ~10s once it comes up.

/// One-shot, synchronous RAM-pressure check usable at boot (`lib.rs`'s
/// `.setup()`), before `spawn_pressure_monitor`'s debounced sampler has ever
/// run — see this section's header comment for why RAM alone, not the full
/// `classify_pressure`. Delegates to `classify_ram` with `PressureLevel::
/// Normal` as the "accepted" level (no prior state exists yet at boot, so
/// this collapses to the plain entry threshold) so this can never silently
/// drift from the steady-state "High" definition every other reader in this
/// module agrees on.
pub(crate) fn is_boot_ram_pressure_high(available_ram_mb: u64, total_ram_mb: u64) -> bool {
    classify_ram(available_ram_mb, total_ram_mb, PressureLevel::Normal) == PressureLevel::High
}

/// How long `lib.rs`'s `.setup()` defers starting non-critical, genuinely
/// pressure-heavy background subsystems (journal retention, brain
/// consolidator, the brain sidecar's own boot thread — see each call site's
/// own comment) when `is_boot_ram_pressure_high` reads true at the exact
/// moment the app is booting. Long enough that the window has actually
/// painted and become interactive well before any of these compete for
/// RAM/CPU again; short enough that a user opening the brain or waiting on
/// journal history within the first couple of minutes still gets it.
pub(crate) const BOOT_DEFER_SECS: u64 = 90;

/// Pure arithmetic wrapping `BOOT_DEFER_SECS` behind the boolean decision —
/// extracted so `lib.rs`'s call sites read as an honest "0 when comfortable,
/// BOOT_DEFER_SECS when not" rather than re-deriving the constant/condition
/// pairing at each of the (currently three) spawn call sites.
pub(crate) fn boot_defer_seconds(pressure_high: bool) -> u64 {
    if pressure_high { BOOT_DEFER_SECS } else { 0 }
}

/// Pure debounce step: given the currently-ACCEPTED level, the in-flight
/// debounce state (`Some((candidate, consecutive_count))` or `None` when no
/// candidate is pending), and this sample's raw candidate level, returns the
/// updated debounce state to carry into the next sample, plus
/// `Some(new_level)` iff THIS sample causes an accepted change.
///
/// Extracted as a pure function (no `Instant`/`Mutex`/sysinfo involved) so
/// the debounce logic itself is unit-tested in isolation — mirrors this
/// codebase's established pure-core convention (e.g. `format_brain_id_suffix`
/// in `commands/brain/sidecar.rs`).
///
/// Rules:
///  - A candidate equal to the already-accepted level never starts/continues
///    a pending change (nothing to debounce) — resets any stale pending
///    candidate from an earlier, since-reverted blip.
///  - A candidate matching the CURRENTLY pending one advances its counter;
///    reaching 2 accepts the change (and clears pending).
///  - A candidate that differs from BOTH the accepted level and any pending
///    one restarts the pending count at 1 (an alternating/noisy signal must
///    never accumulate toward acceptance for a level it didn't just see
///    twice in a row).
fn debounce_step(
    accepted: PressureLevel,
    pending: Option<(PressureLevel, u8)>,
    candidate: PressureLevel,
) -> (Option<(PressureLevel, u8)>, Option<PressureLevel>) {
    if candidate == accepted {
        return (None, None);
    }
    match pending {
        Some((level, count)) if level == candidate => {
            if count + 1 >= 2 {
                (None, Some(candidate))
            } else {
                (Some((level, count + 1)), None)
            }
        }
        _ => (Some((candidate, 1)), None),
    }
}

/// Shared, debounced pressure state — the single source of truth every
/// reader (the `get_system_pressure` command, `brain/maintenance.rs`'s dream
/// gate) consults instead of sampling `sysinfo` itself.
pub(crate) struct PressureTracker {
    current: SystemPressure,
    /// `Instant` of the most recent sample where the ACCEPTED level was
    /// non-Normal — refreshed on EVERY sample while still non-Normal (not
    /// just at the moment of transition), so the instant the level flips
    /// back to Normal this timestamp stops advancing and starts "aging".
    /// `None` means the level has never been observed as non-Normal since
    /// this tracker was created — treated as maximally idle (see
    /// `minutes_since_last_non_normal`).
    last_non_normal_at: Option<Instant>,
}

/// Managed Tauri state wrapping the shared tracker — mirrors `BrainState`'s
/// `pub struct Foo(pub Arc<Mutex<Inner>>)` shape (`commands/brain/sidecar.rs`)
/// so `.manage()`/`tauri::State` extraction and passing the raw inner `Arc`
/// into a plain (non-command) background-thread function both work exactly
/// like every other piece of shared state in this app.
pub struct SystemPressureState(pub Arc<Mutex<PressureTracker>>);

impl Default for SystemPressureState {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemPressureState {
    pub fn new() -> Self {
        SystemPressureState(Arc::new(Mutex::new(PressureTracker {
            current: SystemPressure {
                level: PressureLevel::Normal,
                available_ram_mb: 0,
                total_ram_mb: 0,
                cpu_pct: 0.0,
                ram_level: PressureLevel::Normal,
            },
            last_non_normal_at: None,
        })))
    }
}

/// Read the current accepted snapshot. Poison-safe (recovers via
/// `into_inner`, mirrors `BoundedGate`'s convention in `commands/util.rs`) —
/// a poisoned tracker must never take down every future gate check with it.
pub(crate) fn pressure_snapshot(state: &Arc<Mutex<PressureTracker>>) -> SystemPressure {
    state.lock().unwrap_or_else(|e| e.into_inner()).current.clone()
}

/// Minutes since the accepted level was last observed as non-Normal, or
/// `u64::MAX` if it never has been (maximally permissive default — a
/// freshly-started monitor has no evidence of ANY recent pressure, so a
/// caller gating on "N+ minutes of idle" must not block on that alone).
pub(crate) fn minutes_since_last_non_normal(state: &Arc<Mutex<PressureTracker>>) -> u64 {
    let guard = state.lock().unwrap_or_else(|e| e.into_inner());
    match guard.last_non_normal_at {
        Some(t) => t.elapsed().as_secs() / 60,
        None => u64::MAX,
    }
}

/// Test-only constructor: a tracker pre-seeded at a specific level, bypassing
/// the real sampling/debounce loop entirely. `PressureTracker`'s fields are
/// private to this module, so other modules' tests (e.g.
/// `commands::brain::maintenance`'s mid-sequence pressure-abort tests) need
/// this seam to exercise a non-Normal reading without a real `sysinfo`
/// sample.
#[cfg(test)]
pub(crate) fn tracker_with_level_for_test(level: PressureLevel) -> Arc<Mutex<PressureTracker>> {
    Arc::new(Mutex::new(PressureTracker {
        current: SystemPressure {
            level,
            available_ram_mb: 2000,
            total_ram_mb: 16000,
            cpu_pct: 50.0,
            ram_level: level,
        },
        last_non_normal_at: None,
    }))
}

/// Spawn the background sampling loop. Fire-and-forget for the app's whole
/// lifetime (like `spawn_brain_consolidator`/`spawn_scheduler`) — there is no
/// stop switch because the process itself is the natural lifetime bound; a
/// `tauri::async_runtime::spawn` + `tokio::time::sleep` loop, matching every
/// other periodic background task in this codebase, since a `sysinfo`
/// refresh is a cheap syscall, not the kind of long blocking work
/// `spawn_brain_consolidator` isolates onto `spawn_blocking`.
pub(crate) fn spawn_pressure_monitor(app: tauri::AppHandle, state: Arc<Mutex<PressureTracker>>) {
    tauri::async_runtime::spawn(async move {
        let mut sys = sysinfo::System::new_all();

        // Discard the first CPU sample (see this module's doc comment) —
        // one throwaway refresh + sleep before the loop ever computes or
        // acts on a candidate level.
        sys.refresh_cpu_usage();
        tokio::time::sleep(SAMPLE_INTERVAL).await;

        let mut pending: Option<(PressureLevel, u8)> = None;

        loop {
            sys.refresh_cpu_usage();
            sys.refresh_memory();

            let cpu_pct = sys.global_cpu_usage();
            let total_ram_mb = sys.total_memory() / (1024 * 1024);
            let available_ram_mb = sys.available_memory() / (1024 * 1024);

            let accepted_level = pressure_snapshot(&state).level;
            let (candidate, ram_level) =
                classify_pressure(available_ram_mb, total_ram_mb, cpu_pct, accepted_level);
            let (new_pending, accepted_change) = debounce_step(accepted_level, pending, candidate);
            pending = new_pending;

            let level = accepted_change.unwrap_or(accepted_level);
            let snapshot = SystemPressure { level, available_ram_mb, total_ram_mb, cpu_pct, ram_level };

            if let Ok(mut tracker) = state.lock() {
                if level != PressureLevel::Normal {
                    tracker.last_non_normal_at = Some(Instant::now());
                }
                tracker.current = snapshot.clone();
            }

            // Emit on an ACCEPTED change only — a raw numeric wobble that
            // never flips the debounced level must never spam the frontend.
            if let Some(new_level) = accepted_change {
                log::info!(
                    "system pressure changed: {:?} -> {:?} (ram={}MB avail / {}MB total, cpu={:.0}%)",
                    accepted_level, new_level, available_ram_mb, total_ram_mb, cpu_pct
                );
                let _ = app.emit("system://pressure", &snapshot);
            }

            tokio::time::sleep(SAMPLE_INTERVAL).await;
        }
    });
}

/// Return the current (debounced) system pressure snapshot.
#[tauri::command]
pub(crate) fn get_system_pressure(state: tauri::State<SystemPressureState>) -> SystemPressure {
    pressure_snapshot(&state.0)
}

#[cfg(test)]
#[path = "system_pressure_tests.rs"]
mod tests;
