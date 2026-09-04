//! Unit tests for `updater_service` — split into its own file purely to
//! keep `mod.rs` under the repo's 800-line file guideline; `use super::*`
//! below pulls in every item from `mod.rs` (state, `take_boot_action`,
//! `stage`/`clear_staged`/`prune_orphans`, sha256 helpers, the benign-error
//! classifier). One test per `take_boot_action` branch is mandatory per the
//! spec — see that function's own doc comment for the branch list this
//! section mirrors.

use super::*;

fn staged_fixture(version: &str, file: &str, sha256: &str, attempts: u32) -> StagedUpdate {
    StagedUpdate {
        version: version.to_string(),
        file: file.to_string(),
        sha256: sha256.to_string(),
        notes: Some("release notes".to_string()),
        attempts,
    }
}

fn write_installer(dir: &Path, file: &str, contents: &[u8]) -> String {
    fs::create_dir_all(updates_dir(dir)).unwrap();
    fs::write(updates_dir(dir).join(file), contents).unwrap();
    sha256_hex(contents)
}

// ── load_state / save_state ──────────────────────────────────────

#[test]
fn load_state_of_missing_file_is_default_not_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let state = load_state(tmp.path());
    assert_eq!(state, UpdaterState::default());
    assert!(state.auto_update, "default policy must be auto-update ON");
    eprintln!("load_state_of_missing_file_is_default_not_an_error PASSED");
}

#[test]
fn load_state_of_corrupt_json_fails_open_to_default() {
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(updates_dir(tmp.path())).unwrap();
    fs::write(state_path(tmp.path()), b"not json").unwrap();
    assert_eq!(load_state(tmp.path()), UpdaterState::default());
    eprintln!("load_state_of_corrupt_json_fails_open_to_default PASSED");
}

#[test]
fn save_then_load_state_roundtrips() {
    let tmp = tempfile::tempdir().unwrap();
    let mut state = UpdaterState::default();
    state.auto_update = false;
    state.ignored_version = Some("0.1.12".to_string());
    state.staged = Some(staged_fixture("0.1.13", "Lazy_0.1.13_x64-setup.exe", "deadbeef", 1));
    save_state(tmp.path(), &state).unwrap();
    assert_eq!(load_state(tmp.path()), state);
    eprintln!("save_then_load_state_roundtrips PASSED");
}

#[test]
fn save_state_never_leaves_a_tmp_file_behind_on_success() {
    let tmp = tempfile::tempdir().unwrap();
    save_state(tmp.path(), &UpdaterState::default()).unwrap();
    assert!(!state_path(tmp.path()).with_extension(STATE_TMP_EXTENSION).exists());
    assert!(state_path(tmp.path()).exists());
    eprintln!("save_state_never_leaves_a_tmp_file_behind_on_success PASSED");
}

// ── take_boot_action: branch coverage ────────────────────────────

#[test]
fn no_staged_update_yields_none() {
    let tmp = tempfile::tempdir().unwrap();
    save_state(tmp.path(), &UpdaterState::default()).unwrap();
    assert_eq!(take_boot_action(tmp.path(), "0.1.11"), BootAction::None);
    eprintln!("no_staged_update_yields_none PASSED");
}

#[test]
fn missing_state_file_yields_none() {
    let tmp = tempfile::tempdir().unwrap();
    assert_eq!(take_boot_action(tmp.path(), "0.1.11"), BootAction::None);
    eprintln!("missing_state_file_yields_none PASSED");
}

#[test]
fn staged_version_already_reached_reports_update_applied_and_clears_state() {
    let tmp = tempfile::tempdir().unwrap();
    let sha = write_installer(tmp.path(), "Lazy_0.1.12_x64-setup.exe", b"installer bytes");
    let mut state = UpdaterState::default();
    state.installing_from = Some("0.1.11".to_string());
    state.staged = Some(staged_fixture("0.1.12", "Lazy_0.1.12_x64-setup.exe", &sha, 1));
    save_state(tmp.path(), &state).unwrap();

    let action = take_boot_action(tmp.path(), "0.1.12");
    assert_eq!(action, BootAction::UpdateApplied { from_version: "0.1.11".to_string() });

    let after = load_state(tmp.path());
    assert!(after.staged.is_none(), "staged must be cleared once applied");
    assert!(after.installing_from.is_none());
    eprintln!("staged_version_already_reached_reports_update_applied_and_clears_state PASSED");
}

#[test]
fn staged_version_older_than_current_is_also_treated_as_applied() {
    // e.g. the user manually installed a newer build in the meantime.
    let tmp = tempfile::tempdir().unwrap();
    let sha = write_installer(tmp.path(), "Lazy_0.1.10_x64-setup.exe", b"stale installer");
    let mut state = UpdaterState::default();
    state.staged = Some(staged_fixture("0.1.10", "Lazy_0.1.10_x64-setup.exe", &sha, 0));
    save_state(tmp.path(), &state).unwrap();

    let action = take_boot_action(tmp.path(), "0.1.12");
    assert_eq!(action, BootAction::UpdateApplied { from_version: "unknown".to_string() });
    eprintln!("staged_version_older_than_current_is_also_treated_as_applied PASSED");
}

#[test]
fn missing_installer_file_discards_staged_and_yields_none() {
    let tmp = tempfile::tempdir().unwrap();
    let mut state = UpdaterState::default();
    state.staged = Some(staged_fixture("0.1.12", "Lazy_0.1.12_x64-setup.exe", "deadbeef", 0));
    save_state(tmp.path(), &state).unwrap();

    let action = take_boot_action(tmp.path(), "0.1.11");
    assert_eq!(action, BootAction::None);
    assert!(load_state(tmp.path()).staged.is_none());
    eprintln!("missing_installer_file_discards_staged_and_yields_none PASSED");
}

#[test]
fn sha256_mismatch_discards_staged_and_yields_none() {
    let tmp = tempfile::tempdir().unwrap();
    write_installer(tmp.path(), "Lazy_0.1.12_x64-setup.exe", b"real installer bytes");
    let mut state = UpdaterState::default();
    state.staged =
        Some(staged_fixture("0.1.12", "Lazy_0.1.12_x64-setup.exe", "0000000000000000000000000000000000000000000000000000000000000000", 0));
    save_state(tmp.path(), &state).unwrap();

    let action = take_boot_action(tmp.path(), "0.1.11");
    assert_eq!(action, BootAction::None);
    assert!(load_state(tmp.path()).staged.is_none());
    assert!(!updates_dir(tmp.path()).join("Lazy_0.1.12_x64-setup.exe").exists(), "tampered file must be removed");
    eprintln!("sha256_mismatch_discards_staged_and_yields_none PASSED");
}

#[test]
fn attempts_at_max_discards_staged_and_yields_none_never_loops() {
    let tmp = tempfile::tempdir().unwrap();
    let sha = write_installer(tmp.path(), "Lazy_0.1.12_x64-setup.exe", b"installer bytes");
    let mut state = UpdaterState::default();
    state.staged = Some(staged_fixture("0.1.12", "Lazy_0.1.12_x64-setup.exe", &sha, MAX_INSTALL_ATTEMPTS));
    save_state(tmp.path(), &state).unwrap();

    let action = take_boot_action(tmp.path(), "0.1.11");
    assert_eq!(action, BootAction::None);
    assert!(load_state(tmp.path()).staged.is_none());
    eprintln!("attempts_at_max_discards_staged_and_yields_none_never_loops PASSED");
}

#[test]
fn valid_staged_update_below_max_attempts_returns_install_and_increments_attempts() {
    let tmp = tempfile::tempdir().unwrap();
    let sha = write_installer(tmp.path(), "Lazy_0.1.12_x64-setup.exe", b"installer bytes");
    let mut state = UpdaterState::default();
    state.staged = Some(staged_fixture("0.1.12", "Lazy_0.1.12_x64-setup.exe", &sha, 0));
    save_state(tmp.path(), &state).unwrap();

    let action = take_boot_action(tmp.path(), "0.1.11");
    let expected_exe = updates_dir(tmp.path()).join("Lazy_0.1.12_x64-setup.exe");
    assert_eq!(action, BootAction::Install { exe_path: expected_exe });

    let after = load_state(tmp.path());
    assert_eq!(after.staged.unwrap().attempts, 1);
    assert_eq!(after.installing_from, Some("0.1.11".to_string()));
    eprintln!("valid_staged_update_below_max_attempts_returns_install_and_increments_attempts PASSED");
}

#[test]
fn one_attempt_below_max_still_installs_the_second_time() {
    let tmp = tempfile::tempdir().unwrap();
    let sha = write_installer(tmp.path(), "Lazy_0.1.12_x64-setup.exe", b"installer bytes");
    let mut state = UpdaterState::default();
    state.staged = Some(staged_fixture("0.1.12", "Lazy_0.1.12_x64-setup.exe", &sha, MAX_INSTALL_ATTEMPTS - 1));
    save_state(tmp.path(), &state).unwrap();

    let action = take_boot_action(tmp.path(), "0.1.11");
    assert!(matches!(action, BootAction::Install { .. }));
    assert_eq!(load_state(tmp.path()).staged.unwrap().attempts, MAX_INSTALL_ATTEMPTS);
    eprintln!("one_attempt_below_max_still_installs_the_second_time PASSED");
}

#[test]
fn malformed_current_version_fails_open_to_none() {
    let tmp = tempfile::tempdir().unwrap();
    let sha = write_installer(tmp.path(), "Lazy_0.1.12_x64-setup.exe", b"installer bytes");
    let mut state = UpdaterState::default();
    state.staged = Some(staged_fixture("0.1.12", "Lazy_0.1.12_x64-setup.exe", &sha, 0));
    save_state(tmp.path(), &state).unwrap();

    assert_eq!(take_boot_action(tmp.path(), "not-a-version"), BootAction::None);
    // Nothing mutated — the staged update is still there for the next boot
    // to evaluate once a well-formed version is available again.
    assert!(load_state(tmp.path()).staged.is_some());
    eprintln!("malformed_current_version_fails_open_to_none PASSED");
}

#[test]
fn malformed_staged_version_discards_and_fails_open_to_none() {
    let tmp = tempfile::tempdir().unwrap();
    write_installer(tmp.path(), "Lazy_bad_x64-setup.exe", b"installer bytes");
    let mut state = UpdaterState::default();
    state.staged = Some(staged_fixture("not-a-version", "Lazy_bad_x64-setup.exe", "deadbeef", 0));
    save_state(tmp.path(), &state).unwrap();

    assert_eq!(take_boot_action(tmp.path(), "0.1.11"), BootAction::None);
    assert!(load_state(tmp.path()).staged.is_none());
    eprintln!("malformed_staged_version_discards_and_fails_open_to_none PASSED");
}

// ── stage / clear_staged / prune_orphans ─────────────────────────

#[test]
fn stage_writes_file_computes_sha256_and_persists_state() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = b"a brand new installer payload";
    let staged = stage(tmp.path(), "0.2.0", Some("notes".to_string()), bytes).unwrap();

    assert_eq!(staged.version, "0.2.0");
    assert_eq!(staged.file, "Lazy_0.2.0_x64-setup.exe");
    assert_eq!(staged.attempts, 0);
    assert_eq!(staged.sha256, sha256_hex(bytes));

    let on_disk = fs::read(updates_dir(tmp.path()).join(&staged.file)).unwrap();
    assert_eq!(on_disk, bytes);
    assert_eq!(load_state(tmp.path()).staged, Some(staged));
    eprintln!("stage_writes_file_computes_sha256_and_persists_state PASSED");
}

#[test]
fn stage_rejects_non_semver_version() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(stage(tmp.path(), "not-a-version", None, b"bytes").is_err());
    eprintln!("stage_rejects_non_semver_version PASSED");
}

#[test]
fn stage_replaces_previous_staged_file() {
    let tmp = tempfile::tempdir().unwrap();
    let first = stage(tmp.path(), "0.2.0", None, b"first payload").unwrap();
    assert!(updates_dir(tmp.path()).join(&first.file).exists());

    let second = stage(tmp.path(), "0.2.1", None, b"second payload").unwrap();
    assert!(!updates_dir(tmp.path()).join(&first.file).exists(), "superseded file must be removed");
    assert!(updates_dir(tmp.path()).join(&second.file).exists());
    assert_eq!(load_state(tmp.path()).staged.unwrap().version, "0.2.1");
    eprintln!("stage_replaces_previous_staged_file PASSED");
}

#[test]
fn clear_staged_removes_file_and_state_when_present() {
    let tmp = tempfile::tempdir().unwrap();
    let staged = stage(tmp.path(), "0.2.0", None, b"payload").unwrap();
    assert!(updates_dir(tmp.path()).join(&staged.file).exists());

    clear_staged(tmp.path());

    assert!(!updates_dir(tmp.path()).join(&staged.file).exists());
    assert!(load_state(tmp.path()).staged.is_none());
    eprintln!("clear_staged_removes_file_and_state_when_present PASSED");
}

#[test]
fn clear_staged_is_a_silent_no_op_when_nothing_staged() {
    let tmp = tempfile::tempdir().unwrap();
    clear_staged(tmp.path()); // must not panic
    assert!(load_state(tmp.path()).staged.is_none());
    eprintln!("clear_staged_is_a_silent_no_op_when_nothing_staged PASSED");
}

#[test]
fn prune_orphans_deletes_exes_that_are_not_the_current_staged_file() {
    let tmp = tempfile::tempdir().unwrap();
    let staged = stage(tmp.path(), "0.2.0", None, b"kept payload").unwrap();
    fs::write(updates_dir(tmp.path()).join("Lazy_0.1.9_x64-setup.exe"), b"orphan").unwrap();
    fs::write(updates_dir(tmp.path()).join("not-an-installer.txt"), b"ignored").unwrap();

    prune_orphans(tmp.path());

    assert!(updates_dir(tmp.path()).join(&staged.file).exists(), "the currently staged file must survive");
    assert!(!updates_dir(tmp.path()).join("Lazy_0.1.9_x64-setup.exe").exists(), "orphan exe must be removed");
    assert!(updates_dir(tmp.path()).join("not-an-installer.txt").exists(), "non-exe files are untouched");
    eprintln!("prune_orphans_deletes_exes_that_are_not_the_current_staged_file PASSED");
}

#[test]
fn prune_orphans_on_missing_dir_is_a_silent_no_op() {
    let tmp = tempfile::tempdir().unwrap();
    prune_orphans(tmp.path()); // must not panic even though updates/ was never created
    eprintln!("prune_orphans_on_missing_dir_is_a_silent_no_op PASSED");
}

// ── sha256 helpers ────────────────────────────────────────────────

#[test]
fn sha256_hex_of_file_matches_in_memory_hash() {
    let tmp = tempfile::tempdir().unwrap();
    let bytes = vec![7u8; SHA256_READ_CHUNK_BYTES * 3 + 17]; // spans multiple read chunks
    let path = tmp.path().join("payload.bin");
    fs::write(&path, &bytes).unwrap();
    assert_eq!(sha256_hex_of_file(&path).unwrap(), sha256_hex(&bytes));
    eprintln!("sha256_hex_of_file_matches_in_memory_hash PASSED");
}

#[test]
fn sha256_hex_of_file_errors_on_missing_file() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(sha256_hex_of_file(&tmp.path().join("nope.bin")).is_err());
    eprintln!("sha256_hex_of_file_errors_on_missing_file PASSED");
}

// ── benign platform error mapping ────────────────────────────────

#[test]
fn target_not_found_is_benign() {
    let err = tauri_plugin_updater::Error::TargetNotFound("windows-x86_64".to_string());
    assert!(is_benign_platform_error(&err));
    eprintln!("target_not_found_is_benign PASSED");
}

#[test]
fn targets_not_found_is_benign() {
    let err = tauri_plugin_updater::Error::TargetsNotFound(vec!["windows-x86_64".to_string()]);
    assert!(is_benign_platform_error(&err));
    eprintln!("targets_not_found_is_benign PASSED");
}

#[test]
fn release_not_found_is_not_benign() {
    let err = tauri_plugin_updater::Error::ReleaseNotFound;
    assert!(!is_benign_platform_error(&err));
    eprintln!("release_not_found_is_not_benign PASSED");
}
