/* runner/mod.rs — lazy-runnerd module root.

   P6.a: Detached mission runtime skeleton. Reuses the BrainSidecar pattern
   (single-instance lock, HTTP on 127.0.0.1, bearer token) to own native
   mission execution independently of the UI process.

   This is behind a flag (LAZY_RUNNER=1) — default OFF, zero behavior change.
*/

pub mod server;
pub mod singleinstance;
pub mod commands;

use std::sync::Arc;
use std::sync::Mutex;
use std::collections::HashMap;

/// Shared state: mission_id -> pid for active missions owned by the runner.
pub type RunnerPidState = Arc<Mutex<HashMap<String, u32>>>;

/// Configuration for the runner daemon.
pub struct RunnerConfig {
    pub data_dir: std::path::PathBuf,
    pub port: u16,
    pub token: String,
}

impl RunnerConfig {
    /// Derive config from the app local data dir (same pattern as brain sidecar).
    pub fn from_data_dir(data_dir: std::path::PathBuf) -> Self {
        let runner_dir = data_dir.join("lazy-runnerd");
        let _ = std::fs::create_dir_all(&runner_dir);

        // Read or generate port + token from state file
        let state_file = runner_dir.join("state.json");
        let (port, token) = match std::fs::read_to_string(&state_file) {
            Ok(content) => {
                let v: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
                (
                    v.get("port").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                    v.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                )
            }
            Err(_) => (0u16, String::new()),
        };

        let port = if port > 0 { port } else { 17395 }; // Default runner port
        let token = if token.is_empty() {
            let new_token = uuid::Uuid::new_v4().to_string();
            let state = serde_json::json!({ "port": port, "token": new_token });
            let _ = std::fs::write(&state_file, state.to_string());
            new_token
        } else {
            token
        };

        RunnerConfig {
            data_dir: runner_dir,
            port,
            token,
        }
    }
}
