//! Resolves what the sidecar runs and where it points: `LazyBrainBin`
//! (node_exe/script + the argv it builds), Bearer token generation, and every
//! path-resolution helper deciding which LazyBrain binary and which brain
//! path to use.

use std::process::Command;

use tauri::Manager;
use uuid::Uuid;

use crate::commands::util::quiet_command;
use crate::commands::brain::config::{env_brain_override, resolve_unified_brain_path, ui_config_path_in_dir};
use crate::state::ProjectState;

/// Resolved paths for running the LazyBrain CLI.
///
/// In dev: node_exe = "node" (system PATH), script = Lazy/engine/dist/bin/lazybrain.js
/// (the internalized engine — built via `cd engine && npm run build`).
/// In prod: node_exe = <resource_dir>/node.exe, script = <resource_dir>/lazybrain/lazybrain.js
#[derive(Debug, Clone)]
pub struct LazyBrainBin {
    /// Path to the node executable (or "node" for system node).
    pub node_exe: String,
    /// Path to lazybrain.js script.
    pub script: String,
}

impl LazyBrainBin {
    /// Build a Command pre-populated with `node_exe script [args...]`.
    pub fn command(&self, args: &[&str]) -> Command {
        let mut cmd = quiet_command(&self.node_exe);
        cmd.arg(&self.script);
        for a in args {
            cmd.arg(a);
        }
        cmd
    }
}

/// Generate a cryptographically random Bearer token for sidecar auth.
///
/// Backed by UUID v4 (`uuid` crate, already a dependency — see `use uuid::Uuid`
/// above), which sources its randomness from the OS CSPRNG via `getrandom`
/// (already present transitively; no new crate needed). 122 bits of entropy
/// is ample for a local-loopback-only secret whose threat model is "any other
/// process/webpage on this machine", not a network-facing credential.
///
/// The vendored lazybrain.js `checkAuth` (src/server/auth.ts) compares this
/// value verbatim against the `Authorization: Bearer <token>` request header,
/// so the exact format only needs to be a non-empty opaque string — the
/// hyphenated UUID form is used as-is.
pub(crate) fn generate_sidecar_token() -> String {
    Uuid::new_v4().to_string()
}

/// Build the argv for `lazybrain serve` — port + the `--token` flag the
/// vendored CLI uses to require Bearer auth (see `registerServe` /
/// `checkAuth` in lazybrain.js). Pure and unit-tested in isolation
/// (`serve_command_args_includes_token_flag`) since inspecting the
/// `std::process::Command` built by `LazyBrainBin::command` is awkward —
/// this is the single source of truth `spawn_at` feeds into it.
pub(crate) fn serve_command_args(port: u16, token: &str) -> Vec<String> {
    vec![
        "serve".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--token".to_string(),
        token.to_string(),
    ]
}

/// Path to the internalized engine build: `Lazy/engine/dist/bin/lazybrain.js`
/// (built via `cd engine && npm run build`). Shared by `resolve_brain_bin`
/// (below) and `resolve_lazybrain_bin_static` (commands/brain/config.rs) so
/// both compute the exact same candidate — see `pick_lazybrain_bin`.
pub(crate) fn engine_dist_script_path() -> std::path::PathBuf {
    let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // src-tauri -> Lazy
    p.push("engine");
    p.push("dist");
    p.push("bin");
    p.push("lazybrain.js");
    p
}

/// Pure priority core for locating the LazyBrain engine binary, given
/// already-computed candidate locations. No I/O beyond `Path::exists()` on
/// the exact candidates handed in, so it is unit-testable with synthetic
/// `TempDir` layouts instead of depending on `CARGO_MANIFEST_DIR!` /
/// `current_exe()` / a live `tauri::App` — none of which can be faked at
/// test time.
///
/// Shared by `resolve_brain_bin` (startup, has a `tauri::App`) and
/// `resolve_lazybrain_bin_static` (config.rs, no app handle available) so
/// both agree on exactly the same priority by construction — a single
/// implementation, not two hand-kept-in-sync copies:
///
/// 1. Internal engine build (`engine_dist_script`) — the vendored-in-repo
///    engine, run with the system "node". Always the freshest local build in
///    dev.
/// 2. Bundled resources (`<resource_dir>/lazybrain/lazybrain.js`), run with
///    `<resource_dir>/node.exe` (falls back to system "node" if no bundled
///    node binary is present). This is exactly what a packaged/installed app
///    ships and runs.
///
/// Deliberately has no third branch for any external sibling repo checkout
/// (e.g. a `../LazyBrain` directory next to this project) — the engine now
/// lives inside this repo (`engine/`), and a stray sibling checkout with its
/// own uncommitted/out-of-sync build must never silently shadow it.
pub(crate) fn pick_lazybrain_bin(
    engine_dist_script: &std::path::Path,
    resource_dir: Option<&std::path::Path>,
) -> Option<LazyBrainBin> {
    // 1. Internal engine build.
    if engine_dist_script.exists() {
        return Some(LazyBrainBin {
            node_exe: "node".to_string(),
            script: engine_dist_script.to_string_lossy().into_owned(),
        });
    }

    // 2. Bundled resources. Try node.exe first (Windows), then node (macOS / Linux).
    let res = resource_dir?;
    let prod_script = res.join("lazybrain").join("lazybrain.js");
    if !prod_script.exists() {
        return None;
    }
    let prod_node_win = res.join("node.exe");
    let prod_node_unix = res.join("node");
    let node_exe = if prod_node_win.exists() {
        prod_node_win.to_string_lossy().into_owned()
    } else if prod_node_unix.exists() {
        prod_node_unix.to_string_lossy().into_owned()
    } else {
        // No bundled node binary alongside the script — fall back to system PATH node.
        "node".to_string()
    };
    Some(LazyBrainBin {
        node_exe,
        script: prod_script.to_string_lossy().into_owned(),
    })
}

/// `<exe_dir>/resources` computed directly from `current_exe()`, bypassing
/// Tauri's `resource_dir()` API. Mirrors `resolve_lazybrain_bin_static`'s
/// (commands/brain/config.rs) own inline computation — see
/// `resolve_brain_bin`'s doc comment for why a second, independent source
/// for this exact path is needed.
fn exe_resource_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("resources")))
}

/// Picks a `LazyBrainBin` trying `primary` first, falling back to
/// `fallback` only if `primary` yields nothing — pure core of
/// `resolve_brain_bin`'s two-source resolution, extracted so it is
/// unit-testable with synthetic `TempDir` layouts instead of requiring a
/// live `tauri::App` (which `resource_dir()` needs) or a real
/// `current_exe()`.
fn pick_lazybrain_bin_with_fallback(
    engine_dist_script: &std::path::Path,
    primary: Option<&std::path::Path>,
    fallback: Option<&std::path::Path>,
) -> Option<LazyBrainBin> {
    pick_lazybrain_bin(engine_dist_script, primary)
        .or_else(|| pick_lazybrain_bin(engine_dist_script, fallback))
}

/// Resolve the LazyBrain bin configuration at app startup.
///
/// Priority: see `pick_lazybrain_bin`. Never resolves to an external sibling
/// repo — only the internalized `engine/dist` build or this app's own
/// bundled `resources/lazybrain`.
///
/// Tries Tauri's official `app.path().resource_dir()` API first (correct
/// for a properly-installed app), then FALLS BACK to `exe_resource_dir()`'s
/// direct `current_exe()`-based computation.
///
/// BUGFIX (M12 dogfood, MAJEUR #5): confirmed empirically (real
/// `cargo build --release` binary, resources genuinely present at
/// `<exe_dir>/resources/lazybrain/lazybrain.js`) that `resource_dir()` can
/// return a path `pick_lazybrain_bin` cannot find the script under — for an
/// unbundled/manually-launched release exe (no NSIS installer in the loop),
/// NOT just a dev build — even though `tauri-build`'s build script already
/// copies `bundle.resources` into `target/<profile>/resources/` regardless
/// of whether the app is later packaged. Before this fix that silently
/// skipped starting the brain sidecar entirely ("LazyBrain bin not found"),
/// on a build whose resources were genuinely correct. This mirrors
/// `resolve_lazybrain_bin_static`'s (config.rs) own reliable fallback,
/// used by every OTHER brain command already — only the STARTUP sidecar-spawn
/// path was still exposed to the unreliable Tauri-API-only resolution.
pub(crate) fn resolve_brain_bin(app: &tauri::App) -> Option<LazyBrainBin> {
    let tauri_resource_dir = app.path().resource_dir().ok();
    let exe_resource_dir = exe_resource_dir();
    pick_lazybrain_bin_with_fallback(
        &engine_dist_script_path(),
        tauri_resource_dir.as_deref(),
        exe_resource_dir.as_deref(),
    )
}

/// Resolve the brain path at app startup (has access to `tauri::App`).
///
/// Priority:
///   1. `LAZYBRAIN_BRAIN_PATH` env var — if set and path exists.
///   2. UI-persisted brain choice (Settings > Memory) — checked here too,
///      not just in `resolve_unified_brain_path`, so a "global"/"custom"
///      choice survives an app restart: this function picks which brain the
///      sidecar boots on *before* any project is opened / `set_project`
///      runs. Read live via this `app` handle rather than the
///      `LAZY_APP_CONFIG_DIR` env-var cache, since that cache is only
///      populated after this same resolution runs during `.setup()`.
///   3. Dev-time: `.lazybrain/brain` sibling to src-tauri (dev convenience).
///   4. Production: `<app_local_data_dir>/lazybrain/brain`.
///   5. Absolute fallback: `~/.lazybrain/brain`.
pub(crate) fn resolve_brain_path(app: &tauri::App) -> String {
    // 1. User-configured override (CLI & IDE share the same brain).
    if let Some(v) = env_brain_override() {
        return v;
    }

    // 2. UI-persisted brain choice — explicit user intent outranks the
    // incidental dev/prod defaults below.
    if let Ok(config_dir) = app.path().app_config_dir() {
        if let Some(v) = ui_config_path_in_dir(&config_dir) {
            return v;
        }
    }

    // 3. Dev-time: use the dedicated brain next to the Lazy project.
    let dev_brain = {
        let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop(); // src-tauri -> Lazy
        p.push(".lazybrain");
        p.push("brain");
        p
    };
    if dev_brain.exists() {
        return dev_brain.to_string_lossy().into_owned();
    }

    // 4. Production: store in app local data directory.
    if let Ok(data_dir) = app.path().app_local_data_dir() {
        let path = data_dir.join("lazybrain").join("brain");
        return path.to_string_lossy().into_owned();
    }

    // 5. Absolute fallback
    dirs_fallback_brain()
}

/// Derive the brain path for the currently-open project.
///
/// Delegates to `resolve_unified_brain_path` so that `LAZYBRAIN_BRAIN_PATH`
/// takes priority over the project-local brain (keeps CLI and IDE in sync).
pub(crate) fn brain_path_from_project(project_state: &tauri::State<ProjectState>) -> String {
    let root = project_state.0.lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    resolve_unified_brain_path(if root.is_empty() { None } else { Some(root.as_str()) })
}

pub(crate) fn dirs_fallback_brain() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    format!("{}/.lazybrain/brain", home)
}

#[cfg(test)]
mod tests {
    /// Tokens must be non-empty, have meaningful entropy, and never repeat
    /// across calls — generate_sidecar_token backs the one Bearer secret
    /// every brain_fetch_* command and the brain-mcp shim rely on to
    /// authenticate to the sidecar.
    #[test]
    fn generate_sidecar_token_is_nonempty_and_unique() {
        let a = super::generate_sidecar_token();
        let b = super::generate_sidecar_token();
        assert!(!a.is_empty(), "token must not be empty");
        assert!(
            a.len() >= 32,
            "token should carry meaningful entropy (UUID v4 hyphenated is 36 chars), got len {}",
            a.len()
        );
        assert_ne!(a, b, "two calls must never produce the same token");
        eprintln!("generate_sidecar_token_is_nonempty_and_unique PASSED");
    }

    /// spawn_at feeds `serve_command_args` straight into `lb.command(...)` —
    /// this is the single source of truth that the `--token` flag actually
    /// reaches the vendored CLI's argv (registerServe's `--token <token>`
    /// option, consumed by checkAuth). Pure/unit-tested here since
    /// inspecting the std::process::Command spawn_at builds is awkward.
    #[test]
    fn serve_command_args_includes_token_flag() {
        let args = super::serve_command_args(4242, "sekrit-token-123");
        assert_eq!(
            args,
            vec!["serve", "--port", "4242", "--token", "sekrit-token-123"],
            "serve argv must carry --port and --token in the order the CLI expects"
        );
        eprintln!("serve_command_args_includes_token_flag PASSED");
    }

    // ── pick_lazybrain_bin priority: internal engine build wins over ──
    // ── bundled resources; there is no external-sibling-repo branch at ──
    // ── all (see doc comment) ──────────────────────────────────────────

    /// When both the internal engine build and the bundled resources copy
    /// exist, the internal engine build must win — always the freshest
    /// local build in dev. This also proves (by construction, not just by
    /// assertion) that the old "prefer an external `../LazyBrain` sibling
    /// repo" behavior is gone: `pick_lazybrain_bin`'s signature has no third
    /// candidate for it to come from.
    #[test]
    fn pick_lazybrain_bin_prefers_internal_engine_over_resources() {
        use tempfile::TempDir;

        let engine_dir = TempDir::new().expect("TempDir::new");
        let engine_script = engine_dir.path().join("lazybrain.js");
        std::fs::write(&engine_script, "// internal engine build").expect("write engine script");

        let res_dir = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(res_dir.path().join("lazybrain")).expect("mkdir lazybrain");
        std::fs::write(res_dir.path().join("lazybrain").join("lazybrain.js"), "// bundled resources copy")
            .expect("write bundled script");
        std::fs::write(res_dir.path().join("node.exe"), "fake node").expect("write fake node.exe");

        let lb = super::pick_lazybrain_bin(&engine_script, Some(res_dir.path()))
            .expect("both candidates exist — must resolve");

        assert_eq!(
            lb.script,
            engine_script.to_string_lossy().into_owned(),
            "internal engine build must win over the bundled resources copy"
        );
        assert_eq!(lb.node_exe, "node", "internal engine build must run with system node");
        eprintln!("pick_lazybrain_bin_prefers_internal_engine_over_resources PASSED");
    }

    /// With no internal engine build present, must fall back to bundled
    /// resources — and prefer the bundled node.exe over system node when
    /// present (packaged-app behavior, preserved as-is by this rework).
    #[test]
    fn pick_lazybrain_bin_falls_back_to_resources_when_internal_engine_missing() {
        use tempfile::TempDir;

        let engine_dir = TempDir::new().expect("TempDir::new");
        let engine_script = engine_dir.path().join("nonexistent").join("lazybrain.js"); // never created

        let res_dir = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(res_dir.path().join("lazybrain")).expect("mkdir lazybrain");
        let bundled_script = res_dir.path().join("lazybrain").join("lazybrain.js");
        std::fs::write(&bundled_script, "// bundled resources copy").expect("write bundled script");
        let node_exe_path = res_dir.path().join("node.exe");
        std::fs::write(&node_exe_path, "fake node").expect("write fake node.exe");

        let lb = super::pick_lazybrain_bin(&engine_script, Some(res_dir.path()))
            .expect("resources candidate exists — must resolve");

        assert_eq!(lb.script, bundled_script.to_string_lossy().into_owned());
        assert_eq!(
            lb.node_exe,
            node_exe_path.to_string_lossy().into_owned(),
            "must prefer the bundled node.exe over system node"
        );
        eprintln!("pick_lazybrain_bin_falls_back_to_resources_when_internal_engine_missing PASSED");
    }

    /// A bundled resources script with no accompanying node binary must
    /// still resolve — falling back to system PATH "node" — mirroring the
    /// tolerance the original `resolve_brain_bin` already had for this case.
    #[test]
    fn pick_lazybrain_bin_falls_back_to_system_node_when_no_bundled_node_binary() {
        use tempfile::TempDir;

        let engine_dir = TempDir::new().expect("TempDir::new");
        let engine_script = engine_dir.path().join("nonexistent").join("lazybrain.js");

        let res_dir = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(res_dir.path().join("lazybrain")).expect("mkdir lazybrain");
        let bundled_script = res_dir.path().join("lazybrain").join("lazybrain.js");
        std::fs::write(&bundled_script, "// bundled, no node binary alongside").expect("write bundled script");
        // Deliberately do NOT create node.exe/node in res_dir.

        let lb = super::pick_lazybrain_bin(&engine_script, Some(res_dir.path()))
            .expect("bundled script alone (no node binary) must still resolve");

        assert_eq!(lb.node_exe, "node", "must fall back to system PATH node when no bundled node binary exists");
        eprintln!("pick_lazybrain_bin_falls_back_to_system_node_when_no_bundled_node_binary PASSED");
    }

    /// Neither candidate present (and no resource_dir at all) must resolve
    /// to `None` rather than panicking or fabricating a path.
    #[test]
    fn pick_lazybrain_bin_returns_none_when_nothing_found() {
        use tempfile::TempDir;

        let engine_dir = TempDir::new().expect("TempDir::new");
        let engine_script = engine_dir.path().join("nonexistent").join("lazybrain.js");
        let empty_res_dir = TempDir::new().expect("TempDir::new"); // no lazybrain/ subdir at all

        assert!(
            super::pick_lazybrain_bin(&engine_script, Some(empty_res_dir.path())).is_none(),
            "must be None when neither the internal engine nor a bundled script exists"
        );
        assert!(
            super::pick_lazybrain_bin(&engine_script, None).is_none(),
            "must be None when there is no resource_dir candidate at all"
        );
        eprintln!("pick_lazybrain_bin_returns_none_when_nothing_found PASSED");
    }

    // ── pick_lazybrain_bin_with_fallback (M12 dogfood fix, MAJEUR #5) ────
    // resolve_brain_bin's two-source resolution: Tauri's resource_dir() API
    // first, falling back to the direct current_exe()-based computation when
    // the API path doesn't actually contain the bundled script — confirmed
    // empirically to matter for an unbundled/manually-launched release exe.

    #[test]
    fn pick_lazybrain_bin_with_fallback_uses_the_fallback_dir_when_the_primary_has_nothing() {
        use tempfile::TempDir;

        let engine_dir = TempDir::new().expect("TempDir::new");
        let engine_script = engine_dir.path().join("nonexistent").join("lazybrain.js"); // never created

        let primary_dir = TempDir::new().expect("TempDir::new"); // empty — simulates a resource_dir() that resolved but has no lazybrain/ under it
        let fallback_dir = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(fallback_dir.path().join("lazybrain")).unwrap();
        let fallback_script = fallback_dir.path().join("lazybrain").join("lazybrain.js");
        std::fs::write(&fallback_script, "// bundled resources copy").expect("write fallback script");

        let lb = super::pick_lazybrain_bin_with_fallback(
            &engine_script,
            Some(primary_dir.path()),
            Some(fallback_dir.path()),
        )
        .expect("must resolve via the fallback dir when the primary dir has no bundled script");

        assert_eq!(lb.script, fallback_script.to_string_lossy());
        eprintln!("pick_lazybrain_bin_with_fallback_uses_the_fallback_dir_when_the_primary_has_nothing PASSED");
    }

    #[test]
    fn pick_lazybrain_bin_with_fallback_prefers_the_primary_dir_when_it_already_has_the_script() {
        use tempfile::TempDir;

        let engine_dir = TempDir::new().expect("TempDir::new");
        let engine_script = engine_dir.path().join("nonexistent").join("lazybrain.js");

        let primary_dir = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(primary_dir.path().join("lazybrain")).unwrap();
        let primary_script = primary_dir.path().join("lazybrain").join("lazybrain.js");
        std::fs::write(&primary_script, "// primary copy").expect("write primary script");

        let fallback_dir = TempDir::new().expect("TempDir::new");
        std::fs::create_dir_all(fallback_dir.path().join("lazybrain")).unwrap();
        std::fs::write(fallback_dir.path().join("lazybrain").join("lazybrain.js"), "// fallback copy")
            .expect("write fallback script");

        let lb = super::pick_lazybrain_bin_with_fallback(
            &engine_script,
            Some(primary_dir.path()),
            Some(fallback_dir.path()),
        )
        .expect("must resolve");

        assert_eq!(lb.script, primary_script.to_string_lossy(), "primary dir must win when it already has the script");
        eprintln!("pick_lazybrain_bin_with_fallback_prefers_the_primary_dir_when_it_already_has_the_script PASSED");
    }

    #[test]
    fn pick_lazybrain_bin_with_fallback_returns_none_when_neither_source_has_it() {
        use tempfile::TempDir;

        let engine_dir = TempDir::new().expect("TempDir::new");
        let engine_script = engine_dir.path().join("nonexistent").join("lazybrain.js");
        let empty_primary = TempDir::new().expect("TempDir::new");
        let empty_fallback = TempDir::new().expect("TempDir::new");

        assert!(
            super::pick_lazybrain_bin_with_fallback(
                &engine_script,
                Some(empty_primary.path()),
                Some(empty_fallback.path()),
            )
            .is_none(),
            "must be None when neither the primary nor the fallback dir has the bundled script"
        );
        assert!(
            super::pick_lazybrain_bin_with_fallback(&engine_script, None, None).is_none(),
            "must be None when neither source resolved to a directory at all"
        );
        eprintln!("pick_lazybrain_bin_with_fallback_returns_none_when_neither_source_has_it PASSED");
    }
}
