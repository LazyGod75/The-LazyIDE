//! Brain-everywhere: wires a scoped `brain_search` MCP tool into native
//! claude missions (see `run.rs`'s "claude" branch of `agent_run`).

use crate::commands::brain::config::resolve_lazybrain_bin_static;

/// Resolve the path to the bundled `brain-search-server.mjs` stdio MCP script
/// that exposes a scoped `brain_search` tool to native claude missions.
///
/// Dev:  <CARGO_MANIFEST_DIR>/resources/brain-mcp/brain-search-server.mjs
/// Prod: <exe_dir>/resources/brain-mcp/brain-search-server.mjs
///
/// Mirrors resolve_lazybrain_bin_static's dev/prod resolution. NOTE: the prod
/// path additionally requires `resources/brain-mcp/brain-search-server.mjs` to
/// be declared in tauri.conf.json's `bundle.resources` map (alongside the
/// existing lazybrain/node.exe entries) so it ships in the packaged app — NOT
/// yet added there (tauri.conf.json is outside this change's scope). Dev
/// builds are unaffected since this resolves straight off disk.
fn resolve_brain_mcp_script() -> Result<String, String> {
    let dev_script = {
        let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("resources");
        p.push("brain-mcp");
        p.push("brain-search-server.mjs");
        p
    };
    if dev_script.exists() {
        return Ok(dev_script.to_string_lossy().into_owned());
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let prod_script = exe_dir.join("resources").join("brain-mcp").join("brain-search-server.mjs");
            if prod_script.exists() {
                return Ok(prod_script.to_string_lossy().into_owned());
            }
        }
    }

    Err("brain-search-server.mjs not found — brain MCP unavailable".to_string())
}

/// Build a `--mcp-config` JSON file wiring a scoped `brain_search` tool into a
/// native claude mission (see agent_run's "claude" branch).
///
/// Writes an `mcpServers.brain` entry pointing at brain-search-server.mjs,
/// with the mission's project brain path + the resolved LazyBrain node/script
/// passed via `env` (never argv) so the spawned MCP server needs zero CLI
/// parsing. The server itself answers brain_search via the warm HTTP sidecar
/// first, falling back to a cold `lazybrain search` subprocess — see
/// brain-search-server.mjs for that chain.
///
/// Fails open: returns `None` (no MCP wiring at all — the mission runs exactly
/// as it did before this feature existed) when the brain doesn't exist yet for
/// this project, or the lazybrain bin / brain-mcp script can't be resolved.
///
/// `brain_port` must be the brain sidecar's actual bound port (read from
/// `BrainState`, not the `BRAIN_PORT` constant) — `BrainSidecar::start` may
/// have fallen back to a different port if `BRAIN_PORT` was already taken,
/// and the wired MCP server needs the real port to reach it. Likewise
/// `brain_token` must be the sidecar's actual Bearer token (`BrainState`'s
/// `BrainSidecar::token`) — without it every warm-path HTTP call the MCP
/// shim makes gets 401'd by the sidecar's `checkAuth` and silently falls
/// back to the much slower cold CLI path.
///
/// The returned path is a freshly-written temp file
/// (`<tmp>/lazy-brain-mcp-<sanitized-mission-id>.json`); the caller must
/// remove it once the child process has exited (see agent_run's cleanup after
/// `child.wait()` — removing it any earlier risks the CLI reading a
/// half-written or missing file at its own startup).
pub(crate) fn build_brain_mcp_config(mission_id: &str, brain_path: &str, brain_port: u16, brain_token: &str) -> Option<std::path::PathBuf> {
    if brain_path.is_empty() || !std::path::Path::new(brain_path).exists() {
        log::debug!("build_brain_mcp_config: no brain at '{}' — skipping MCP wiring", brain_path);
        return None;
    }
    let lb = match resolve_lazybrain_bin_static() {
        Ok(lb) => lb,
        Err(e) => {
            log::debug!("build_brain_mcp_config: lazybrain bin unavailable: {}", e);
            return None;
        }
    };
    let mcp_script = match resolve_brain_mcp_script() {
        Ok(s) => s,
        Err(e) => {
            log::debug!("build_brain_mcp_config: {}", e);
            return None;
        }
    };

    let config = serde_json::json!({
        "mcpServers": {
            "brain": {
                "command": lb.node_exe,
                "args": [mcp_script],
                "env": {
                    "LAZYBRAIN_BRAIN_PATH": brain_path,
                    "LAZYBRAIN_NODE": lb.node_exe,
                    "LAZYBRAIN_SCRIPT": lb.script,
                    "BRAIN_MCP_HTTP_PORT": brain_port.to_string(),
                    "BRAIN_MCP_HTTP_TOKEN": brain_token,
                }
            }
        }
    });

    // Mission ids are internally generated, but sanitize defensively before
    // using one as part of a filename (belt-and-suspenders, not a trust boundary).
    let safe_id: String = mission_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let path = std::env::temp_dir().join(format!("lazy-brain-mcp-{}.json", safe_id));

    match std::fs::write(&path, config.to_string()) {
        Ok(()) => {
            log::info!("agent_run: brain_search MCP wired for mission {} (brain={})", mission_id, brain_path);
            Some(path)
        }
        Err(e) => {
            log::warn!("build_brain_mcp_config: failed to write {}: {}", path.display(), e);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    #[cfg(test)]
    use crate::commands::brain::sidecar::BRAIN_PORT;

    /// Fails open: no brain directory for this project → None, no file written,
    /// no dependency on the LazyBrain CLI even being resolvable. This is the
    /// path every mission takes today when a project has never been brain-
    /// initialized — agent_run must fall back to running with no MCP wiring.
    #[test]
    fn build_brain_mcp_config_none_when_brain_missing() {
        let tmp = TempDir::new().expect("TempDir::new");
        let missing_brain = tmp.path().join("does-not-exist").join("brain");
        let missing_brain_str = missing_brain.to_str().unwrap();

        let result = super::build_brain_mcp_config("test-mission-missing-brain", missing_brain_str, BRAIN_PORT, "test-token");
        assert!(result.is_none(), "must fail open (None) when the brain path does not exist");
        eprintln!("build_brain_mcp_config_none_when_brain_missing PASSED");
    }

    /// Fails open on an empty brain_path too (unresolved project, matches
    /// brain_path_from_project's empty-string default before a project is set).
    #[test]
    fn build_brain_mcp_config_none_when_brain_path_empty() {
        let result = super::build_brain_mcp_config("test-mission-empty-brain", "", BRAIN_PORT, "test-token");
        assert!(result.is_none(), "must fail open (None) for an empty brain_path");
        eprintln!("build_brain_mcp_config_none_when_brain_path_empty PASSED");
    }

    /// When the brain exists AND the LazyBrain CLI + brain-mcp script both
    /// resolve, the generated --mcp-config file must be valid JSON wiring a
    /// `brain` stdio server whose env carries this exact brain path — the
    /// scoping guarantee the "brain-everywhere" feature depends on.
    ///
    /// Skips (does not fail) when the internal engine build / bundled
    /// resources or the brain-mcp script are not present, matching the
    /// existing convention used by brain_capture_writes_neuron for
    /// environment-dependent checks.
    #[test]
    fn build_brain_mcp_config_writes_valid_json_when_available() {
        if crate::commands::brain::config::resolve_lazybrain_bin_static().is_err() {
            eprintln!("SKIP build_brain_mcp_config_writes_valid_json_when_available — lazybrain.js not found");
            return;
        }
        if super::resolve_brain_mcp_script().is_err() {
            eprintln!("SKIP build_brain_mcp_config_writes_valid_json_when_available — brain-search-server.mjs not found");
            return;
        }

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(&brain_dir).expect("create_dir_all brain");
        let brain_path = brain_dir.to_str().unwrap().to_string();

        let cfg_path = super::build_brain_mcp_config("test-mission-ok", &brain_path, BRAIN_PORT, "test-token-xyz")
            .expect("build_brain_mcp_config must return Some when brain + lazybrain + script all resolve");

        let raw = std::fs::read_to_string(&cfg_path).expect("read generated mcp-config file");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("generated mcp-config must be valid JSON");

        let brain_server = &parsed["mcpServers"]["brain"];
        assert!(brain_server["command"].as_str().is_some(), "command must be set");
        let args = brain_server["args"].as_array().expect("args must be an array");
        assert!(
            args.first().and_then(|a| a.as_str()).map(|s| s.ends_with("brain-search-server.mjs")).unwrap_or(false),
            "args[0] must point at brain-search-server.mjs, got: {:?}",
            args
        );
        assert_eq!(
            brain_server["env"]["LAZYBRAIN_BRAIN_PATH"].as_str(),
            Some(brain_path.as_str()),
            "LAZYBRAIN_BRAIN_PATH must be scoped to this mission's project brain"
        );
        assert_eq!(
            brain_server["env"]["BRAIN_MCP_HTTP_TOKEN"].as_str(),
            Some("test-token-xyz"),
            "BRAIN_MCP_HTTP_TOKEN must be passed through so the shim can authenticate to the warm sidecar"
        );

        // Cleanup — production code only removes this after agent_run's
        // child.wait(), which never runs in this unit test.
        let _ = std::fs::remove_file(&cfg_path);
        eprintln!("build_brain_mcp_config_writes_valid_json_when_available PASSED");
    }

    /// Mission ids are sanitized before being used in the generated temp
    /// filename — defensive hygiene, not a trust boundary (ids are internally
    /// generated), but must not silently drop the file or panic on odd input,
    /// and must never escape the OS temp dir via path traversal.
    #[test]
    fn build_brain_mcp_config_sanitizes_mission_id_for_filename() {
        if crate::commands::brain::config::resolve_lazybrain_bin_static().is_err() || super::resolve_brain_mcp_script().is_err() {
            eprintln!("SKIP build_brain_mcp_config_sanitizes_mission_id_for_filename — lazybrain/script not found");
            return;
        }

        let tmp = TempDir::new().expect("TempDir::new");
        let brain_dir = tmp.path().join("brain");
        std::fs::create_dir_all(&brain_dir).expect("create_dir_all brain");
        let brain_path = brain_dir.to_str().unwrap().to_string();

        let weird_id = "../../weird id/with spaces";
        let cfg_path = super::build_brain_mcp_config(weird_id, &brain_path, BRAIN_PORT, "test-token")
            .expect("must still succeed with an unusual mission id");

        assert!(cfg_path.exists(), "generated config file must exist at {:?}", cfg_path);
        assert_eq!(
            cfg_path.parent(),
            Some(std::env::temp_dir().as_path()),
            "sanitization must keep the file inside the OS temp dir (no path traversal)"
        );

        let _ = std::fs::remove_file(&cfg_path);
        eprintln!("build_brain_mcp_config_sanitizes_mission_id_for_filename PASSED");
    }
}
