//! Global Agent Canvas state persistence (W3, spec section 6/7).
//!
//! Two commands persisting the canvas layout + chain graph at
//! `<app_local_data_dir>/canvas/<key>.json` — PROJECT-INDEPENDENT, unlike
//! every per-project `.lazy/canvas/*.json` file `canvasPersistence.ts`
//! wrote before this wave (see that module's header for the W1a deviation
//! this closes: `canvas/chains.json` "may cross projects" per spec section 7,
//! so it needs a single global home, not one scoped to whichever project
//! happened to be active when it was last saved).
//!
//! `key` is allowlisted to `layout` / `chains` (canvasTypes.ts's two
//! versioned schemas, `CanvasLayoutFileV1`/`ChainsFileV1`) — anything else
//! is rejected before touching disk, so this pair can never become a
//! general-purpose KV store for arbitrary frontend state.
//!
//! Atomic write: write to a sibling `<key>.json.tmp` file, then
//! `fs::rename` it over the real path. `fs::rename` is atomic within the
//! same directory/filesystem on both Windows and POSIX, so a crash or kill
//! mid-write can never leave a half-written, corrupt `layout.json`/
//! `chains.json` for the next load to trip over — the load either sees the
//! complete old file or the complete new one, never a partial write.
//!
//! Split into `_inner` functions taking a plain `&Path` (the resolved
//! `<app_local_data_dir>/canvas` directory) plus thin `#[tauri::command]`
//! wrappers that resolve that directory from a real `AppHandle` — same
//! separation `commands/journal.rs` uses (`_inner` takes a `&Connection`,
//! not `tauri::State`) so the actual logic is unit-testable against a
//! `tempfile::TempDir` without a running Tauri app.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

const ALLOWED_KEYS: [&str; 2] = ["layout", "chains"];

fn validate_key(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!(
            "canvas_state: unknown key '{}' (allowed: {})",
            key,
            ALLOWED_KEYS.join(", ")
        ))
    }
}

/// Load `<canvas_dir>/<key>.json`. Returns `None` when the file does not
/// exist yet (first run / never saved) — the TS side (`canvasPersistence.ts`)
/// treats that identically to "no state saved" and falls back to defaults,
/// matching every other persistence module's convention in this crate
/// (e.g. `journal.rs`'s `missions_current` empty-result handling).
pub(crate) fn canvas_state_load_inner(canvas_dir: &Path, key: &str) -> Result<Option<String>, String> {
    validate_key(key)?;
    let path = canvas_dir.join(format!("{}.json", key));
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("canvas_state_load: read failed for '{}': {}", path.display(), e))
}

/// Atomically persist `json` at `<canvas_dir>/<key>.json` (see this
/// module's header for the write-tmp-then-rename rationale).
pub(crate) fn canvas_state_save_inner(canvas_dir: &Path, key: &str, json: &str) -> Result<(), String> {
    validate_key(key)?;
    fs::create_dir_all(canvas_dir)
        .map_err(|e| format!("canvas_state_save: create_dir_all failed for '{}': {}", canvas_dir.display(), e))?;

    let path = canvas_dir.join(format!("{}.json", key));
    let tmp_path = canvas_dir.join(format!("{}.json.tmp", key));
    fs::write(&tmp_path, json.as_bytes())
        .map_err(|e| format!("canvas_state_save: write failed for '{}': {}", tmp_path.display(), e))?;
    fs::rename(&tmp_path, &path).map_err(|e| {
        format!(
            "canvas_state_save: rename failed '{}' -> '{}': {}",
            tmp_path.display(),
            path.display(),
            e
        )
    })
}

fn canvas_dir_for_app(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("canvas_state: app_local_data_dir failed: {}", e))?;
    Ok(data_dir.join("canvas"))
}

/// Load global canvas state for `key` (`"layout"` | `"chains"`).
#[tauri::command]
pub(crate) fn canvas_state_load(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let canvas_dir = canvas_dir_for_app(&app)?;
    canvas_state_load_inner(&canvas_dir, &key)
}

/// Persist global canvas state for `key` (`"layout"` | `"chains"`).
#[tauri::command]
pub(crate) fn canvas_state_save(app: tauri::AppHandle, key: String, json: String) -> Result<(), String> {
    let canvas_dir = canvas_dir_for_app(&app)?;
    canvas_state_save_inner(&canvas_dir, &key, &json)
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_returns_none_when_file_absent() {
        let tmp = TempDir::new().unwrap();
        let result = canvas_state_load_inner(tmp.path(), "layout").unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let tmp = TempDir::new().unwrap();
        canvas_state_save_inner(tmp.path(), "chains", r#"{"version":1,"chains":[],"drafts":[]}"#).unwrap();

        let loaded = canvas_state_load_inner(tmp.path(), "chains").unwrap();
        assert_eq!(loaded, Some(r#"{"version":1,"chains":[],"drafts":[]}"#.to_string()));
    }

    #[test]
    fn save_creates_missing_parent_directory() {
        let tmp = TempDir::new().unwrap();
        let nested = tmp.path().join("does").join("not").join("exist");

        canvas_state_save_inner(&nested, "layout", "{}").unwrap();

        assert!(nested.join("layout.json").exists());
    }

    #[test]
    fn save_never_leaves_a_tmp_file_behind_on_success() {
        let tmp = TempDir::new().unwrap();
        canvas_state_save_inner(tmp.path(), "layout", "{}").unwrap();
        assert!(!tmp.path().join("layout.json.tmp").exists());
        assert!(tmp.path().join("layout.json").exists());
    }

    #[test]
    fn overwrite_replaces_previous_content_atomically() {
        let tmp = TempDir::new().unwrap();
        canvas_state_save_inner(tmp.path(), "layout", r#"{"v":1}"#).unwrap();
        canvas_state_save_inner(tmp.path(), "layout", r#"{"v":2}"#).unwrap();

        let loaded = canvas_state_load_inner(tmp.path(), "layout").unwrap();
        assert_eq!(loaded, Some(r#"{"v":2}"#.to_string()));
    }

    #[test]
    fn rejects_a_key_outside_the_allowlist() {
        let tmp = TempDir::new().unwrap();
        let save_err = canvas_state_save_inner(tmp.path(), "evil", "{}").unwrap_err();
        assert!(save_err.contains("unknown key"));

        let load_err = canvas_state_load_inner(tmp.path(), "../../etc/passwd").unwrap_err();
        assert!(load_err.contains("unknown key"));
    }

    #[test]
    fn layout_and_chains_keys_are_independent_files() {
        let tmp = TempDir::new().unwrap();
        canvas_state_save_inner(tmp.path(), "layout", r#"{"kind":"layout"}"#).unwrap();
        canvas_state_save_inner(tmp.path(), "chains", r#"{"kind":"chains"}"#).unwrap();

        assert_eq!(
            canvas_state_load_inner(tmp.path(), "layout").unwrap(),
            Some(r#"{"kind":"layout"}"#.to_string())
        );
        assert_eq!(
            canvas_state_load_inner(tmp.path(), "chains").unwrap(),
            Some(r#"{"kind":"chains"}"#.to_string())
        );
    }
}
