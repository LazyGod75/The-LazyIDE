//! The `BrainConfig` on-disk shape (`brain-config.json`) — read/write/persist
//! and the UI-persisted-path resolution it feeds.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::Manager;

const BRAIN_CONFIG_FILENAME: &str = "brain-config.json";

/// The user's persisted brain choice. Mirrors the TypeScript
/// `BrainSetConfigOptions` shape (src/lib/platform/tauri.ts /
/// src/lib/platform/web.ts) — `mode` selects which resolver branch wins,
/// `path` is required for "global"/"custom" and unused for "project".
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct BrainConfig {
    pub mode: String, // "project" | "global" | "custom"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Directory Lazy's own small JSON config files (currently just
/// `brain-config.json`) live in, cached as a process env var at startup
/// (mirrors `expose_lazybrain_env`) so context-free call sites — like
/// `resolve_unified_brain_path`, invoked from ~15 places with no
/// `AppHandle` in scope — can find it without threading an AppHandle
/// through every one of them. `set_brain_config` / `import_brain_from_github`
/// resolve the same directory live from their own `AppHandle` instead (see
/// `persist_brain_config`) — both resolve to the same path in practice,
/// since `app.path().app_config_dir()` is a pure function of the app's
/// bundle identifier and the OS, not of runtime state.
fn app_config_dir_from_env() -> Option<std::path::PathBuf> {
    std::env::var("LAZY_APP_CONFIG_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
}

/// Expose the app config directory as a process env var. Call once from the
/// Tauri `.setup()` closure, alongside `expose_lazybrain_env`.
pub(crate) fn expose_app_config_dir(dir: &Path) {
    std::env::set_var("LAZY_APP_CONFIG_DIR", dir.to_string_lossy().into_owned());
}

/// Read + parse a `brain-config.json` at an explicit path. Split out from
/// the directory-level helpers below so it's unit-testable against a
/// `TempDir` path instead of the real app config dir / env var.
///
/// Fails open on any error (missing file, unreadable, invalid JSON) — a
/// corrupt or absent config file must never break brain resolution; it
/// simply means "no UI override configured yet", falling through to
/// project/home exactly like before this feature existed.
fn read_brain_config_at(path: &Path) -> Option<BrainConfig> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<BrainConfig>(&text) {
        Ok(cfg) => Some(cfg),
        Err(e) => {
            log::warn!("brain-config.json at {} is invalid JSON: {} — ignoring", path.display(), e);
            None
        }
    }
}

/// Write `config` to `path` as pretty JSON, creating the parent directory
/// first if needed (the very first write on a fresh install).
fn write_brain_config_at(path: &Path, config: &BrainConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create config dir {}: {}", parent.display(), e))?;
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("failed to serialize brain config: {}", e))?;
    fs::write(path, json).map_err(|e| format!("failed to write {}: {}", path.display(), e))
}

/// Persist `config` to `<app_config_dir>/brain-config.json` via a live
/// `AppHandle`. The resolver's own reads go through the cached
/// `LAZY_APP_CONFIG_DIR` env var instead (see `app_config_dir_from_env`) —
/// both resolve to the same directory.
///
/// `pub(super)`: called both by `brain_config_apply` (`apply_brain_config`)
/// and by `path_resolve` (`resolve_seed_brain_path`'s seed-time persistence)
/// — two sibling submodules of `config`, hence visibility reaching the
/// `config` module and its descendants rather than staying file-private.
pub(super) fn persist_brain_config(app: &tauri::AppHandle, config: &BrainConfig) -> Result<(), String> {
    let dir = app.path().app_config_dir()
        .map_err(|e| format!("could not resolve app config directory: {}", e))?;
    write_brain_config_at(&dir.join(BRAIN_CONFIG_FILENAME), config)
}

/// A "custom" brain path may point at either the brain LEAF directly (note
/// files right there — the common case for a hand-picked existing brain
/// folder) or its ROOT, the `<root>/{brain/, .lazybrain-config.json}` layout
/// `brain_publish_github` produces and that a plain `git clone` of a
/// published brain reproduces verbatim. If a `brain` subdirectory exists,
/// descend into it; otherwise use the given path as the leaf, as-is. Mirrors
/// `resolve_publish_root`'s inverse (root-from-leaf) heuristic.
fn custom_brain_leaf(path: &Path) -> std::path::PathBuf {
    let nested = path.join("brain");
    if nested.is_dir() {
        nested
    } else {
        path.to_path_buf()
    }
}

/// The brain path a persisted `BrainConfig` implies, or `None` if it
/// doesn't override anything (mode == "project", or a "global"/"custom"
/// entry missing its required path — treated as absent rather than an
/// error so a half-written config file degrades to the project/home
/// fallback instead of breaking resolution).
///
///   - "project": no override.
///   - "global":  `path` is a directory chosen to HOUSE a brain the same
///     way `~/` houses the home-fallback brain — the brain itself lives at
///     `<path>/.lazybrain/brain`.
///   - "custom":  `path` IS the brain (leaf-or-root, see `custom_brain_leaf`)
///     — e.g. a folder cloned via `import_brain_from_github`.
fn ui_config_effective_path(cfg: &BrainConfig) -> Option<String> {
    let raw = cfg.path.as_deref().map(str::trim).filter(|p| !p.is_empty())?;
    match cfg.mode.as_str() {
        "global" => Some(Path::new(raw).join(".lazybrain").join("brain").to_string_lossy().into_owned()),
        "custom" => Some(custom_brain_leaf(Path::new(raw)).to_string_lossy().into_owned()),
        _ => None,
    }
}

/// Read a persisted `BrainConfig` from a specific app-config directory
/// (rather than the cached env var) and resolve its effective brain path.
/// Shared by `ui_persisted_brain_path` (context-free, via the cached
/// `LAZY_APP_CONFIG_DIR`) and `resolve_brain_path` (startup, has a live
/// `tauri::App` and so can read the directory directly without depending on
/// `.setup()` ordering).
pub(crate) fn ui_config_path_in_dir(config_dir: &Path) -> Option<String> {
    read_brain_config_at(&config_dir.join(BRAIN_CONFIG_FILENAME)).and_then(|cfg| ui_config_effective_path(&cfg))
}

/// Convenience: the effective UI-config brain path, straight from disk, via
/// the cached `LAZY_APP_CONFIG_DIR` env var. `None` when unset (e.g. this
/// process's `.setup()` never ran — every unit test in this file) or when
/// no config has been written yet.
///
/// `pub(super)`: consumed by `path_resolve` (`resolve_unified_brain_path` /
/// `resolve_seed_brain_path`), a sibling submodule of `config`.
pub(super) fn ui_persisted_brain_path() -> Option<String> {
    app_config_dir_from_env().and_then(|d| ui_config_path_in_dir(&d))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn write_and_read_brain_config_roundtrip() {
        let tmp = TempDir::new().expect("TempDir::new");
        let path = tmp.path().join("brain-config.json");
        let config = BrainConfig { mode: "custom".to_string(), path: Some("/some/brain".to_string()) };

        write_brain_config_at(&path, &config).expect("write_brain_config_at failed");
        let read_back = read_brain_config_at(&path).expect("read_brain_config_at must find the file just written");

        assert_eq!(read_back, config);
        eprintln!("write_and_read_brain_config_roundtrip PASSED");
    }

    #[test]
    fn write_brain_config_at_creates_missing_parent_dir() {
        let tmp = TempDir::new().expect("TempDir::new");
        let path = tmp.path().join("nested").join("dir").join("brain-config.json");
        let config = BrainConfig { mode: "project".to_string(), path: None };

        write_brain_config_at(&path, &config).expect("must create parent dirs on first write");
        assert!(path.exists());
        eprintln!("write_brain_config_at_creates_missing_parent_dir PASSED");
    }

    #[test]
    fn read_brain_config_at_missing_file_returns_none() {
        let tmp = TempDir::new().expect("TempDir::new");
        let path = tmp.path().join("does-not-exist.json");
        assert!(read_brain_config_at(&path).is_none());
        eprintln!("read_brain_config_at_missing_file_returns_none PASSED");
    }

    #[test]
    fn read_brain_config_at_invalid_json_returns_none_not_panic() {
        let tmp = TempDir::new().expect("TempDir::new");
        let path = tmp.path().join("brain-config.json");
        std::fs::write(&path, "not valid json{{{").expect("write garbage");
        assert!(read_brain_config_at(&path).is_none(), "invalid JSON must fail open, not panic");
        eprintln!("read_brain_config_at_invalid_json_returns_none_not_panic PASSED");
    }

    #[test]
    fn ui_config_effective_path_project_mode_is_always_none() {
        let with_path = BrainConfig { mode: "project".to_string(), path: Some("/whatever".to_string()) };
        let without_path = BrainConfig { mode: "project".to_string(), path: None };
        assert_eq!(ui_config_effective_path(&with_path), None);
        assert_eq!(ui_config_effective_path(&without_path), None);
        eprintln!("ui_config_effective_path_project_mode_is_always_none PASSED");
    }

    #[test]
    fn ui_config_effective_path_global_mode_nests_lazybrain_brain_dir() {
        let tmp = TempDir::new().expect("TempDir::new");
        let cfg = BrainConfig { mode: "global".to_string(), path: Some(tmp.path().to_str().unwrap().to_string()) };

        let effective = ui_config_effective_path(&cfg).expect("global mode with a path must resolve");
        let expected = tmp.path().join(".lazybrain").join("brain").to_str().unwrap().to_string();
        assert_eq!(effective, expected);
        eprintln!("ui_config_effective_path_global_mode_nests_lazybrain_brain_dir PASSED");
    }

    #[test]
    fn ui_config_effective_path_custom_mode_flat_vs_nested() {
        let flat = TempDir::new().expect("TempDir::new"); // no brain/ subdir
        let flat_cfg = BrainConfig { mode: "custom".to_string(), path: Some(flat.path().to_str().unwrap().to_string()) };
        assert_eq!(
            ui_config_effective_path(&flat_cfg).expect("must resolve"),
            flat.path().to_str().unwrap().to_string(),
            "flat custom dir (no nested brain/) must be used as-is"
        );

        let root = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(root.path().join("brain")).expect("mkdir brain");
        let root_cfg = BrainConfig { mode: "custom".to_string(), path: Some(root.path().to_str().unwrap().to_string()) };
        assert_eq!(
            ui_config_effective_path(&root_cfg).expect("must resolve"),
            root.path().join("brain").to_str().unwrap().to_string(),
            "root-shaped custom dir (has brain/) must descend into it"
        );
        eprintln!("ui_config_effective_path_custom_mode_flat_vs_nested PASSED");
    }

    #[test]
    fn ui_config_effective_path_missing_or_empty_path_is_none() {
        let no_path = BrainConfig { mode: "global".to_string(), path: None };
        let empty_path = BrainConfig { mode: "custom".to_string(), path: Some("   ".to_string()) };
        assert_eq!(ui_config_effective_path(&no_path), None);
        assert_eq!(ui_config_effective_path(&empty_path), None);
        eprintln!("ui_config_effective_path_missing_or_empty_path_is_none PASSED");
    }

    #[test]
    fn custom_brain_leaf_flat_vs_nested() {
        let flat = TempDir::new().expect("TempDir::new");
        assert_eq!(custom_brain_leaf(flat.path()).to_str().unwrap(), flat.path().to_str().unwrap());

        let root = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(root.path().join("brain")).expect("mkdir brain");
        assert_eq!(
            custom_brain_leaf(root.path()).to_str().unwrap(),
            root.path().join("brain").to_str().unwrap()
        );
        eprintln!("custom_brain_leaf_flat_vs_nested PASSED");
    }
}
