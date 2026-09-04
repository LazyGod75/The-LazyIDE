/* runner/commands.rs — Tauri commands for lazy-runnerd integration.

   P6.a: These commands let the UI check if the runner is running,
   get its port/token, and ensure it's started. Behind LAZY_RUNNER=1 flag.
*/

use std::process::Command;
use tauri::Manager;

/// Check if the lazy-runnerd process is running by probing its health endpoint.
#[tauri::command]
pub fn runner_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // Only active when LAZY_RUNNER env is set
    if std::env::var("LAZY_RUNNER").is_err() {
        return Ok(serde_json::json!({ "enabled": false, "running": false }));
    }

    let data_dir = app.path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;

    let state_file = data_dir.join("lazy-runnerd").join("state.json");
    let (port, token) = match std::fs::read_to_string(&state_file) {
        Ok(content) => {
            let v: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
            (
                v.get("port").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                v.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string(),
            )
        }
        Err(_) => return Ok(serde_json::json!({ "enabled": true, "running": false })),
    };

    // Probe health endpoint
    let url = format!("http://127.0.0.1:{}/health", port);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send();

    match resp {
        Ok(r) if r.status().is_success() => {
            let body: serde_json::Value = r.json().unwrap_or_default();
            Ok(serde_json::json!({
                "enabled": true,
                "running": true,
                "port": port,
                "health": body,
            }))
        }
        _ => Ok(serde_json::json!({ "enabled": true, "running": false, "port": port })),
    }
}

/// Ensure the runner daemon is started (spawns it if not running).
#[tauri::command]
pub fn runner_ensure_started(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if std::env::var("LAZY_RUNNER").is_err() {
        return Ok(serde_json::json!({ "enabled": false, "started": false }));
    }

    // Check if already running
    let status = runner_status(app.clone())?;
    if status.get("running").and_then(|r| r.as_bool()).unwrap_or(false) {
        return Ok(serde_json::json!({ "enabled": true, "started": false, "alreadyRunning": true }));
    }

    // Spawn the runner binary
    let data_dir = app.path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to get data dir: {}", e))?;

    let exe_name = if cfg!(windows) { "lazy_runnerd.exe" } else { "lazy_runnerd" };
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get current exe: {}", e))?
        .with_file_name(exe_name);

    if !exe_path.exists() {
        return Err(format!("Runner binary not found at {}", exe_path.display()));
    }

    let mut cmd = Command::new(&exe_path);
    cmd.env("LAZY_RUNNER_DATA_DIR", &data_dir);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    cmd.spawn()
        .map_err(|e| format!("Failed to spawn runner: {}", e))?;

    // Wait briefly for it to start
    std::thread::sleep(std::time::Duration::from_millis(500));

    Ok(serde_json::json!({ "enabled": true, "started": true }))
}
