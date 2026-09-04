//! Resolving the LazyBrain engine binary (`resolve_lazybrain_bin_static`) and
//! exposing that resolution as process-level environment variables.

use crate::commands::brain::sidecar::{
    LazyBrainBin, engine_dist_script_path, pick_lazybrain_bin,
};

/// Resolve the LazyBrain bin configuration without a `tauri::App` handle.
/// Used by Tauri commands that fire after app setup (brain_capture, etc.).
///
/// Priority: identical to `resolve_brain_bin` (sidecar.rs) — both delegate to
/// the shared `pick_lazybrain_bin` priority core so every call site agrees on
/// exactly the same engine:
/// 1. Internal engine build: engine/dist/bin/lazybrain.js (system "node").
/// 2. Packaged app resources: <exe_dir>/resources/lazybrain/lazybrain.js
///    (+ <exe_dir>/resources/node.exe).
///
/// Never resolves to an external sibling repo (e.g. `../LazyBrain`) — see
/// `pick_lazybrain_bin`'s doc comment for why.
pub(crate) fn resolve_lazybrain_bin_static() -> Result<LazyBrainBin, String> {
    let resource_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("resources")));
    pick_lazybrain_bin(&engine_dist_script_path(), resource_dir.as_deref())
        .ok_or_else(|| "lazybrain.js not found — brain write unavailable".to_string())
}

/// Legacy alias: returns just the script path string for callers that only need it.
#[allow(dead_code)]
pub(crate) fn resolve_bin_path_static() -> Result<String, String> {
    resolve_lazybrain_bin_static().map(|lb| lb.script)
}

/// Expose the resolved LazyBrain binary paths as process-level environment
/// variables so that future child sidecars (e.g. a Teams collaboration sidecar)
/// can reuse exactly the same engine resolution without duplicating discovery logic.
///
/// Sets:
///   LAZYBRAIN_NODE   — path to the node executable (or "node" for system PATH)
///   LAZYBRAIN_SCRIPT — path to lazybrain.js
///
/// Called once at app startup after `resolve_brain_bin`. Child processes inherit
/// these variables. The CLI (src/cli/lib/paths.ts) already reads LAZYBRAIN_SCRIPT.
///
/// Note: called from the single-threaded Tauri setup closure, before worker
/// threads are spawned — no data race on process env.
pub(crate) fn expose_lazybrain_env(lb: &LazyBrainBin) {
    std::env::set_var("LAZYBRAIN_NODE", &lb.node_exe);
    std::env::set_var("LAZYBRAIN_SCRIPT", &lb.script);
    log::info!(
        "LazyBrain env exposed: LAZYBRAIN_NODE={} LAZYBRAIN_SCRIPT={}",
        lb.node_exe,
        lb.script
    );
}

/// Return the value of `LAZYBRAIN_BRAIN_PATH` from the environment **only if**
/// the variable is set, non-empty, and the path it names actually exists on disk.
///
/// This is the highest-priority brain path override and must be checked first
/// everywhere a brain path is resolved.  Users who have a dedicated brain
/// (e.g. managed by the `lazybrain` CLI) set this variable and expect every
/// tool — including the IDE — to use the same brain.
pub(crate) fn env_brain_override() -> Option<String> {
    let v = std::env::var("LAZYBRAIN_BRAIN_PATH").ok()?;
    if v.is_empty() {
        return None;
    }
    if std::path::Path::new(&v).exists() {
        Some(v)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── resolve_lazybrain_bin_static priority: internal engine build wins, ──
    // ── external sibling repo is never chosen (real-machine regression) ──

    /// When the internalized engine build (`engine/dist/bin/lazybrain.js`)
    /// is present, it must be the one resolved — proven against this
    /// environment's real build rather than only via synthetic fixtures
    /// (the synthetic-fixture equivalent of this priority is unit-tested in
    /// isolation as `pick_lazybrain_bin_prefers_internal_engine_over_resources`
    /// in sidecar.rs). This test instead exercises the real
    /// `engine_dist_script_path()` / `resolve_lazybrain_bin_static` wiring
    /// end to end. Skips when the engine has not been built in this
    /// environment (`cd engine && npm run build`).
    #[test]
    fn resolve_lazybrain_bin_static_prefers_internal_engine_dist_when_present() {
        let engine_dist = engine_dist_script_path();
        if !engine_dist.exists() {
            eprintln!(
                "SKIP resolve_lazybrain_bin_static_prefers_internal_engine_dist_when_present \
                 (engine/dist/bin/lazybrain.js not built in this environment — run \
                 `cd engine && npm run build`)"
            );
            return;
        }

        let lb = resolve_lazybrain_bin_static()
            .expect("engine/dist/bin/lazybrain.js exists on disk — resolution must succeed");

        assert_eq!(
            std::path::Path::new(&lb.script).canonicalize().expect("resolved script must exist"),
            engine_dist.canonicalize().expect("engine dist script must exist"),
            "must resolve to the internal engine build, not the bundled resources copy"
        );
        assert_eq!(lb.node_exe, "node", "internal engine build must run with system node");
        eprintln!(
            "resolve_lazybrain_bin_static_prefers_internal_engine_dist_when_present PASSED (script={})",
            lb.script
        );
    }

    /// The exact regression this priority rework fixes: on a machine with an
    /// external `../LazyBrain` sibling checkout present (its own, possibly
    /// stale/uncommitted build — e.g. this repo owner's dev machine),
    /// `resolve_lazybrain_bin_static` must NEVER resolve to it. Skips only
    /// when no sibling exists on this machine (nothing to prove a negative
    /// against); when it IS present, this test actually exercises the
    /// regression this rework guards against.
    #[test]
    fn resolve_lazybrain_bin_static_never_resolves_to_external_sibling_repo() {
        let sibling_script = {
            let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            p.pop(); // src-tauri -> Lazy
            p.pop(); // Lazy -> cerveau
            p.push("LazyBrain");
            p.push("dist");
            p.push("bin");
            p.push("lazybrain.js");
            p
        };
        if !sibling_script.exists() {
            eprintln!(
                "SKIP resolve_lazybrain_bin_static_never_resolves_to_external_sibling_repo \
                 (no ../LazyBrain sibling checkout on this machine — nothing to prove)"
            );
            return;
        }

        match resolve_lazybrain_bin_static() {
            Ok(lb) => {
                let resolved = std::path::Path::new(&lb.script).canonicalize().ok();
                let sibling = sibling_script.canonicalize().ok();
                assert_ne!(
                    resolved, sibling,
                    "resolve_lazybrain_bin_static must never resolve to the external sibling \
                     repo ({}), even when it exists on this machine — got {}",
                    sibling_script.display(),
                    lb.script
                );
                eprintln!(
                    "resolve_lazybrain_bin_static_never_resolves_to_external_sibling_repo PASSED \
                     (sibling present on this machine but NOT chosen; resolved={})",
                    lb.script
                );
            }
            Err(e) => {
                // Resolution failing entirely (no internal engine, no
                // resources) is fine — the property under test is "never
                // silently falls back to the sibling", and an Err trivially
                // satisfies that.
                eprintln!(
                    "resolve_lazybrain_bin_static_never_resolves_to_external_sibling_repo PASSED \
                     (resolution failed rather than falling back to the sibling: {})",
                    e
                );
            }
        }
    }
}
