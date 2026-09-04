//! Unit tests for `system_pressure.rs`, split into this sibling file (same
//! `#[path]` convention `commands/git/worktree/tests.rs` already uses for
//! its own module) purely to keep `system_pressure.rs` itself under this
//! codebase's ~800-line file-size guideline once the percentage-based RAM
//! thresholds / hysteresis / `ram_level` coverage (2026-08 false-alarm fix)
//! was added — no behavioral split, `use super::*;` below still gives every
//! test direct access to the parent module's private items exactly as if
//! this were still an inline `mod tests { ... }` block.

use super::*;

// ── classify_pressure ────────────────────────────────────────────
//
// All tests below use a fixed 16000MB (16GB) total, a common real
// machine size — HIGH_RAM_PERCENT=7% -> 1120MB, ELEVATED_RAM_PERCENT=
// 15% -> 2400MB entry thresholds at that total. `accepted:
// PressureLevel::Normal` (no prior state) collapses hysteresis down to
// plain entry-threshold behavior, matching the OLD absolute-MB tests'
// shape one-for-one; the dedicated hysteresis section below covers the
// `accepted != Normal` recovery-band behavior these do not.

const TOTAL_16GB_MB: u64 = 16000;

#[test]
fn classify_pressure_is_normal_when_ram_and_cpu_are_comfortable() {
    assert_eq!(
        classify_pressure(8000, TOTAL_16GB_MB, 20.0, PressureLevel::Normal),
        (PressureLevel::Normal, PressureLevel::Normal)
    );
    eprintln!("classify_pressure_is_normal_when_ram_and_cpu_are_comfortable PASSED");
}

#[test]
fn classify_pressure_is_elevated_when_ram_drops_below_the_elevated_percent() {
    // 2399MB < 2400MB (15% of 16GB).
    assert_eq!(
        classify_pressure(2399, TOTAL_16GB_MB, 20.0, PressureLevel::Normal),
        (PressureLevel::Elevated, PressureLevel::Elevated)
    );
    eprintln!("classify_pressure_is_elevated_when_ram_drops_below_the_elevated_percent PASSED");
}

#[test]
fn classify_pressure_is_elevated_when_cpu_exceeds_65_pct() {
    assert_eq!(
        classify_pressure(8000, TOTAL_16GB_MB, 66.0, PressureLevel::Normal),
        (PressureLevel::Elevated, PressureLevel::Normal),
        "CPU alone must drive the overall level to Elevated while ram_level stays Normal"
    );
    eprintln!("classify_pressure_is_elevated_when_cpu_exceeds_65_pct PASSED");
}

#[test]
fn classify_pressure_is_high_when_ram_drops_below_the_high_percent() {
    // 1119MB < 1120MB (7% of 16GB).
    assert_eq!(
        classify_pressure(1119, TOTAL_16GB_MB, 20.0, PressureLevel::Normal),
        (PressureLevel::High, PressureLevel::High)
    );
    eprintln!("classify_pressure_is_high_when_ram_drops_below_the_high_percent PASSED");
}

#[test]
fn classify_pressure_is_high_when_cpu_exceeds_85_pct_but_ram_level_stays_normal() {
    // The core fix for "CPU spike reported as a memory problem": overall
    // High, but ram_level must stay Normal so the UI never claims low
    // memory for a pure CPU spike.
    assert_eq!(
        classify_pressure(8000, TOTAL_16GB_MB, 86.0, PressureLevel::Normal),
        (PressureLevel::High, PressureLevel::Normal)
    );
    eprintln!("classify_pressure_is_high_when_cpu_exceeds_85_pct_but_ram_level_stays_normal PASSED");
}

#[test]
fn classify_pressure_high_wins_even_when_ram_alone_would_only_be_elevated() {
    // Low CPU (comfortable) but RAM below the HIGH threshold must still
    // report High overall — the two tiers combine via OR, not AND.
    assert_eq!(
        classify_pressure(1000, TOTAL_16GB_MB, 5.0, PressureLevel::Normal),
        (PressureLevel::High, PressureLevel::High)
    );
    eprintln!("classify_pressure_high_wins_even_when_ram_alone_would_only_be_elevated PASSED");
}

#[test]
fn classify_pressure_ram_at_the_high_threshold_is_not_high_but_still_elevated() {
    // available_ram_mb == 1120 (the High entry threshold) must not trip
    // High (strict `<`), but is still below the 2400 Elevated threshold.
    assert_eq!(
        classify_pressure(1120, TOTAL_16GB_MB, 0.0, PressureLevel::Normal),
        (PressureLevel::Elevated, PressureLevel::Elevated)
    );
    eprintln!("classify_pressure_ram_at_the_high_threshold_is_not_high_but_still_elevated PASSED");
}

#[test]
fn classify_pressure_cpu_at_the_high_threshold_is_not_high_but_still_elevated() {
    // cpu_pct == 85.0 must not trip High (strict `>`), but 85.0 is still
    // above the 65.0 Elevated threshold, so Elevated is correct here.
    assert_eq!(
        classify_pressure(8000, TOTAL_16GB_MB, 85.0, PressureLevel::Normal),
        (PressureLevel::Elevated, PressureLevel::Normal)
    );
    eprintln!("classify_pressure_cpu_at_the_high_threshold_is_not_high_but_still_elevated PASSED");
}

#[test]
fn classify_pressure_ram_and_cpu_at_the_elevated_thresholds_are_normal() {
    // Exactly at the Elevated thresholds must not trip them either
    // (strict `<`/`>`) — the true "just barely comfortable" boundary.
    assert_eq!(
        classify_pressure(2400, TOTAL_16GB_MB, 0.0, PressureLevel::Normal),
        (PressureLevel::Normal, PressureLevel::Normal)
    );
    assert_eq!(
        classify_pressure(8000, TOTAL_16GB_MB, 65.0, PressureLevel::Normal),
        (PressureLevel::Normal, PressureLevel::Normal)
    );
    eprintln!("classify_pressure_ram_and_cpu_at_the_elevated_thresholds_are_normal PASSED");
}

#[test]
fn classify_pressure_scales_with_total_ram_not_an_absolute_floor() {
    // Same available_ram_mb (2000MB), two different machine sizes: High
    // on an 8GB machine (2000 < 7% of 8000 = 560? no -- use a value that
    // demonstrates scaling directly instead of a fixed absolute number).
    // 2000MB is comfortably Normal on a 32GB machine (7%=2240 High
    // threshold... still under, so use Elevated check) but High on a
    // machine with little total RAM.
    let small_total = 4000; // 4GB machine: 7% = 280MB, 15% = 600MB
    let large_total = 32000; // 32GB machine: 7% = 2240MB, 15% = 4800MB
    assert_eq!(
        classify_pressure(2000, small_total, 0.0, PressureLevel::Normal).1,
        PressureLevel::Normal,
        "2000MB free out of 4GB total (50%) must read comfortable, not pressured"
    );
    assert_eq!(
        classify_pressure(2000, large_total, 0.0, PressureLevel::Normal).1,
        PressureLevel::High,
        "2000MB free out of 32GB total (6.25%) must read High -- the same absolute MB figure means something very different on a bigger machine"
    );
    eprintln!("classify_pressure_scales_with_total_ram_not_an_absolute_floor PASSED");
}

// ── classify_pressure hysteresis (recovery band) ──────────────────

#[test]
fn classify_ram_requires_the_wider_recovery_threshold_to_leave_high() {
    // 1500MB clears the ENTRY threshold (1120) but not the RECOVERY
    // threshold (12% of 16GB = 1920) -- must stay High once already
    // accepted High, even though the same value would never have
    // TRIGGERED High from Normal.
    assert_eq!(
        classify_ram(1500, TOTAL_16GB_MB, PressureLevel::High),
        PressureLevel::High
    );
    assert_eq!(
        classify_ram(1500, TOTAL_16GB_MB, PressureLevel::Normal),
        PressureLevel::Elevated,
        "the exact same 1500MB reading must NOT enter High fresh from Normal"
    );
    eprintln!("classify_ram_requires_the_wider_recovery_threshold_to_leave_high PASSED");
}

#[test]
fn classify_cpu_requires_the_wider_recovery_threshold_to_leave_high() {
    // 80% clears the entry threshold (85) but not the recovery
    // threshold (85-10=75) -- must stay High once already accepted High.
    assert_eq!(classify_cpu(80.0, PressureLevel::High), PressureLevel::High);
    assert_eq!(
        classify_cpu(80.0, PressureLevel::Normal),
        PressureLevel::Elevated,
        "the exact same 80% reading must NOT enter High fresh from Normal"
    );
    eprintln!("classify_cpu_requires_the_wider_recovery_threshold_to_leave_high PASSED");
}

/// Test-only helper mirroring one sample of `spawn_pressure_monitor`'s
/// real loop body (classify, then debounce, then apply an accepted
/// change) — a plain function taking `&mut` state rather than a closure
/// capturing `accepted`/`pending` by mutable reference, so callers can
/// still read `accepted` directly via `assert_eq!` between calls
/// (a mutably-capturing closure would keep `accepted` borrowed for its
/// entire lifetime, which the borrow checker rejects the moment an
/// `assert_eq!` also touches it — E0502).
fn simulate_step(
    available_ram_mb: u64,
    total_ram_mb: u64,
    cpu_pct: f32,
    accepted: &mut PressureLevel,
    pending: &mut Option<(PressureLevel, u8)>,
) {
    let (candidate, _) = classify_pressure(available_ram_mb, total_ram_mb, cpu_pct, *accepted);
    let (new_pending, change) = debounce_step(*accepted, *pending, candidate);
    *pending = new_pending;
    if let Some(l) = change {
        *accepted = l;
    }
}

#[test]
fn full_pipeline_does_not_flap_when_ram_oscillates_near_the_entry_threshold() {
    // The exact scenario the audit called out: "normal RAM churn near
    // the boundary flaps Normal<->Elevated<->High". Drives
    // classify_pressure + debounce_step together (the real call shape
    // in `spawn_pressure_monitor`'s loop) across samples that hover
    // just above/below the 1120MB entry threshold but stay below the
    // 1920MB recovery threshold throughout.
    let mut accepted = PressureLevel::Normal;
    let mut pending: Option<(PressureLevel, u8)> = None;

    // Two consecutive low samples accept High.
    simulate_step(1000, TOTAL_16GB_MB, 10.0, &mut accepted, &mut pending);
    simulate_step(1000, TOTAL_16GB_MB, 10.0, &mut accepted, &mut pending);
    assert_eq!(accepted, PressureLevel::High);

    // Now RAM oscillates on both sides of the 1120MB entry threshold,
    // but never reaches the 1920MB recovery threshold -- must stay High
    // on every single sample, not just eventually.
    for available in [1150, 1050, 1200, 1080, 1300, 1000, 1400, 1119, 1121] {
        simulate_step(available, TOTAL_16GB_MB, 10.0, &mut accepted, &mut pending);
        assert_eq!(
            accepted,
            PressureLevel::High,
            "flapped away from High at available_ram_mb={available}"
        );
    }
    eprintln!("full_pipeline_does_not_flap_when_ram_oscillates_near_the_entry_threshold PASSED");
}

#[test]
fn full_pipeline_still_recovers_once_ram_clears_the_recovery_threshold_twice() {
    // The flip side of the no-flap test above: hysteresis must not
    // become a one-way door -- a REAL recovery still downgrades the
    // level once it clears the wider band on 2 consecutive samples.
    let mut accepted = PressureLevel::High;
    let mut pending: Option<(PressureLevel, u8)> = None;

    // 1919MB is still inside the recovery band (< 1920) -- must stay High.
    simulate_step(1919, TOTAL_16GB_MB, 10.0, &mut accepted, &mut pending);
    simulate_step(1919, TOTAL_16GB_MB, 10.0, &mut accepted, &mut pending);
    assert_eq!(accepted, PressureLevel::High);

    // 2000MB clears the High recovery threshold (>=1920MB) on 2
    // consecutive samples -- downgrades to Elevated (2000MB is still
    // below the Elevated recovery threshold of 3200MB, so not all the
    // way to Normal yet).
    simulate_step(2000, TOTAL_16GB_MB, 10.0, &mut accepted, &mut pending);
    simulate_step(2000, TOTAL_16GB_MB, 10.0, &mut accepted, &mut pending);
    assert_eq!(accepted, PressureLevel::Elevated);
    eprintln!("full_pipeline_still_recovers_once_ram_clears_the_recovery_threshold_twice PASSED");
}

// ── is_boot_ram_pressure_high / boot_defer_seconds ────────────────

#[test]
fn is_boot_ram_pressure_high_is_false_when_ram_is_comfortable() {
    assert!(!is_boot_ram_pressure_high(8000, TOTAL_16GB_MB));
    eprintln!("is_boot_ram_pressure_high_is_false_when_ram_is_comfortable PASSED");
}

#[test]
fn is_boot_ram_pressure_high_is_true_below_the_high_threshold() {
    assert!(is_boot_ram_pressure_high(1119, TOTAL_16GB_MB));
    eprintln!("is_boot_ram_pressure_high_is_true_below_the_high_threshold PASSED");
}

#[test]
fn is_boot_ram_pressure_high_at_the_threshold_is_not_high() {
    // Strict `<`, same convention as classify_pressure's own threshold tests.
    assert!(!is_boot_ram_pressure_high(1120, TOTAL_16GB_MB));
    eprintln!("is_boot_ram_pressure_high_at_the_threshold_is_not_high PASSED");
}

#[test]
fn boot_defer_seconds_is_zero_when_pressure_is_comfortable() {
    assert_eq!(boot_defer_seconds(false), 0);
    eprintln!("boot_defer_seconds_is_zero_when_pressure_is_comfortable PASSED");
}

#[test]
fn boot_defer_seconds_is_the_full_constant_under_boot_duress() {
    assert_eq!(boot_defer_seconds(true), BOOT_DEFER_SECS);
    assert_eq!(boot_defer_seconds(true), 90);
    eprintln!("boot_defer_seconds_is_the_full_constant_under_boot_duress PASSED");
}

// ── debounce_step ────────────────────────────────────────────────

#[test]
fn debounce_step_ignores_a_candidate_matching_the_already_accepted_level() {
    let (pending, change) = debounce_step(PressureLevel::Normal, None, PressureLevel::Normal);
    assert_eq!(pending, None);
    assert_eq!(change, None);
    eprintln!("debounce_step_ignores_a_candidate_matching_the_already_accepted_level PASSED");
}

#[test]
fn debounce_step_does_not_accept_a_single_blip_sample() {
    let (pending, change) = debounce_step(PressureLevel::Normal, None, PressureLevel::High);
    assert_eq!(pending, Some((PressureLevel::High, 1)));
    assert_eq!(change, None, "a single differing sample must never be accepted immediately");
    eprintln!("debounce_step_does_not_accept_a_single_blip_sample PASSED");
}

#[test]
fn debounce_step_accepts_after_two_consecutive_matching_samples() {
    let (pending1, change1) = debounce_step(PressureLevel::Normal, None, PressureLevel::High);
    assert_eq!(change1, None);
    let (pending2, change2) = debounce_step(PressureLevel::Normal, pending1, PressureLevel::High);
    assert_eq!(pending2, None, "pending must clear once accepted");
    assert_eq!(change2, Some(PressureLevel::High));
    eprintln!("debounce_step_accepts_after_two_consecutive_matching_samples PASSED");
}

#[test]
fn debounce_step_resets_when_the_candidate_reverts_before_confirmation() {
    // First sample proposes High (not yet accepted), second sample
    // reverts to the still-accepted Normal — must reset pending, not
    // silently carry a stale High count forward.
    let (pending1, _) = debounce_step(PressureLevel::Normal, None, PressureLevel::High);
    let (pending2, change2) = debounce_step(PressureLevel::Normal, pending1, PressureLevel::Normal);
    assert_eq!(pending2, None);
    assert_eq!(change2, None);
    eprintln!("debounce_step_resets_when_the_candidate_reverts_before_confirmation PASSED");
}

#[test]
fn debounce_step_restarts_the_count_when_the_candidate_changes_mid_debounce() {
    // First sample proposes Elevated, second sample proposes High
    // instead (an alternating/noisy signal) — must restart the count at
    // 1 for High, never accumulate across two DIFFERENT candidates.
    let (pending1, _) = debounce_step(PressureLevel::Normal, None, PressureLevel::Elevated);
    let (pending2, change2) = debounce_step(PressureLevel::Normal, pending1, PressureLevel::High);
    assert_eq!(pending2, Some((PressureLevel::High, 1)));
    assert_eq!(change2, None);
    eprintln!("debounce_step_restarts_the_count_when_the_candidate_changes_mid_debounce PASSED");
}

// ── PressureTracker / snapshot / idle-minutes ───────────────────

#[test]
fn system_pressure_state_new_defaults_to_normal_and_never_non_normal() {
    let state = SystemPressureState::new();
    let snap = pressure_snapshot(&state.0);
    assert_eq!(snap.level, PressureLevel::Normal);
    assert_eq!(
        minutes_since_last_non_normal(&state.0),
        u64::MAX,
        "a fresh tracker must report maximal idle (never seen non-Normal)"
    );
    eprintln!("system_pressure_state_new_defaults_to_normal_and_never_non_normal PASSED");
}

#[test]
fn minutes_since_last_non_normal_is_near_zero_right_after_a_non_normal_sample() {
    let state = SystemPressureState::new();
    {
        let mut tracker = state.0.lock().unwrap();
        tracker.last_non_normal_at = Some(Instant::now());
        tracker.current.level = PressureLevel::Elevated;
    }
    assert_eq!(minutes_since_last_non_normal(&state.0), 0);
    eprintln!("minutes_since_last_non_normal_is_near_zero_right_after_a_non_normal_sample PASSED");
}

#[test]
fn pressure_snapshot_reflects_the_latest_stored_numbers() {
    let state = SystemPressureState::new();
    {
        let mut tracker = state.0.lock().unwrap();
        tracker.current = SystemPressure {
            level: PressureLevel::High,
            available_ram_mb: 900,
            total_ram_mb: 16000,
            cpu_pct: 92.5,
            ram_level: PressureLevel::High,
        };
    }
    let snap = pressure_snapshot(&state.0);
    assert_eq!(snap.level, PressureLevel::High);
    assert_eq!(snap.available_ram_mb, 900);
    assert_eq!(snap.total_ram_mb, 16000);
    assert!((snap.cpu_pct - 92.5).abs() < f32::EPSILON);
    eprintln!("pressure_snapshot_reflects_the_latest_stored_numbers PASSED");
}
