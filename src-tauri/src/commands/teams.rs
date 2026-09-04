//! LazyBrain-Teams sidecar Tauri commands (health/capture/search/org
//! context). Both commands are always registered; the sidecar may not be
//! running when LAZY_TEAMS_ENABLED is unset (graceful degradation).

use std::fs;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::teams_sidecar;
use crate::commands::brain::sidecar::http_client;

/// Proxy GET /health to the LazyBrain-Teams sidecar.
///
/// When `access_token` is provided and non-empty (TEAMS_AUTH_MODE=supabase),
/// the request carries `Authorization: Bearer <token>` so the sidecar can
/// validate the caller's Supabase JWT.
/// Passing None or an empty string omits the header — solo/demo mode unchanged.
#[tauri::command]
pub(crate) fn teams_health(
    access_token: Option<String>,
    state: tauri::State<teams_sidecar::TeamsSidecarState>,
) -> Result<String, String> {
    let port = state.0.lock().map(|s| s.port).unwrap_or(7777);
    let url = format!("http://127.0.0.1:{}/health", port);

    let client = http_client();
    let mut builder = client.get(&url);

    if let Some(ref token) = access_token {
        if !token.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", token));
        }
    }

    builder
        .send()
        .map_err(|e| format!("teams_health: {}", e))?
        .text()
        .map_err(|e| format!("teams_health text: {}", e))
}

/// Proxy POST /t/:slug/capture to the LazyBrain-Teams sidecar.
///
/// Arguments:
///   slug      — team identifier matching the endpoint segment
///   payload   — CaptureEvent JSON (forwarded as-is to the server)
///   token     — Bearer token (read by TS from a secure keychain / env var)
///   server_url — optional override; defaults to http://127.0.0.1:<port>
///
/// The Rust layer prevents WebView2 loopback isolation and avoids exposing
/// the Bearer token to the renderer process via network headers.
#[tauri::command]
pub(crate) fn teams_capture(
    slug: String,
    payload: serde_json::Value,
    token: String,
    server_url: Option<String>,
    state: tauri::State<teams_sidecar::TeamsSidecarState>,
) -> Result<(), String> {
    if slug.is_empty() {
        return Err("teams_capture: slug must not be empty".to_string());
    }
    if token.is_empty() {
        return Err("teams_capture: token must not be empty".to_string());
    }

    let port = state.0.lock().map(|s| s.port).unwrap_or(7777);
    let base = server_url.unwrap_or_else(|| format!("http://127.0.0.1:{}", port));
    // Percent-encode slug to prevent path injection (#teams-1)
    let encoded_slug = urlencoding::encode(&slug);
    let url = format!("{}/t/{}/capture", base.trim_end_matches('/'), encoded_slug);

    let body = serde_json::to_string(&payload)
        .map_err(|e| format!("teams_capture: serialize payload: {}", e))?;

    let resp = http_client()
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .map_err(|e| format!("teams_capture: request failed: {}", e))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        Err(format!("teams_capture: server returned {}: {}", status, text.trim()))
    }
}

/// Proxy GET /search or GET /dept/:slug/search to the LazyBrain-Teams sidecar.
///
/// When `dept_slug` is Some(non-empty string), routes to
/// GET /dept/:slug/search?q=:q&top=:top (department-scoped search).
/// Otherwise routes to GET /search?q=:q&top=:top (org-wide federated search).
///
/// The `access_token` (Supabase JWT) is forwarded as `Authorization: Bearer <token>`
/// when non-empty, so the sidecar can validate the caller in supabase auth mode.
/// Returns the raw JSON body (array of search results) for the TS client to parse.
/// Returns "[]" immediately when query is blank.
#[tauri::command]
pub(crate) fn teams_search(
    q: String,
    top: u32,
    dept_slug: Option<String>,
    access_token: Option<String>,
    state: tauri::State<teams_sidecar::TeamsSidecarState>,
) -> Result<String, String> {
    if q.trim().is_empty() {
        return Ok("[]".to_string());
    }

    let port = state.0.lock().map(|s| s.port).unwrap_or(7777);
    let encoded_q = urlencoding::encode(&q);
    let capped_top = top.min(50);

    let url = match dept_slug.as_deref() {
        Some(slug) if !slug.trim().is_empty() => {
            let encoded_slug = urlencoding::encode(slug);
            format!(
                "http://127.0.0.1:{}/dept/{}/search?q={}&top={}",
                port, encoded_slug, encoded_q, capped_top
            )
        }
        _ => format!(
            "http://127.0.0.1:{}/search?q={}&top={}",
            port, encoded_q, capped_top
        ),
    };

    let client = http_client();
    let mut builder = client.get(&url);

    if let Some(ref token) = access_token {
        if !token.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", token));
        }
    }

    builder
        .send()
        .map_err(|e| format!("teams_search: {}", e))?
        .text()
        .map_err(|e| format!("teams_search text: {}", e))
}

/// A single team entry in org-context.json.
/// Phase 0: teams map to departments (no separate teams table yet).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrgContextTeam {
    pub slug: String,
    pub name: String,
    /// "private" | "org-readable"
    pub visibility: String,
    /// "lead" | "member" | "viewer" | null
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dept_id: Option<String>,
}

/// A department entry in org-context.json.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OrgContextDept {
    pub id: String,
    pub slug: String,
}

/// The full org-context.json payload.
/// Built by the TS frontend, persisted to disk by Rust.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OrgContextJson {
    pub user_id: String,
    pub org_id: String,
    pub org_slug: String,
    pub is_org_admin: bool,
    pub teams: Vec<OrgContextTeam>,
    pub depts: Vec<OrgContextDept>,
}

/// Inner write — separated from the Tauri command so unit tests can
/// call it without an AppHandle.
pub(crate) fn write_org_context_inner(
    payload: &OrgContextJson,
    data_dir: &str,
) -> Result<(), String> {
    fs::create_dir_all(data_dir)
        .map_err(|e| format!("write_org_context: create_dir_all: {}", e))?;
    let path = std::path::Path::new(data_dir).join("org-context.json");
    let json = serde_json::to_string_pretty(payload)
        .map_err(|e| format!("write_org_context: serialize: {}", e))?;
    fs::write(&path, json.as_bytes())
        .map_err(|e| format!("write_org_context: write: {}", e))?;
    log::info!("teams org-context written to {:?}", path);
    Ok(())
}

/// Resolve the Teams DATA_DIR from the app handle (mirrors the path in run()).
fn teams_data_dir(app: &tauri::AppHandle) -> String {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("lazy").join("teams").to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/tmp/lazy-teams".to_string())
}

/// Write org-context.json to the Teams sidecar DATA_DIR (step 1).
///
/// Called by the TS frontend after authentication + Supabase org fetch.
/// In solo mode the TS call-site must NOT invoke this command.
#[tauri::command]
pub(crate) fn teams_write_org_context(
    payload: OrgContextJson,
    app: tauri::AppHandle,
) -> Result<(), String> {
    write_org_context_inner(&payload, &teams_data_dir(&app))
}

/// Re-write org-context.json after an org membership change (step 4).
///
/// Call when the user's role, team, or department changes.
/// Semantics identical to teams_write_org_context; separated for
/// TS-side telemetry / UX distinction.
#[tauri::command]
pub(crate) fn teams_resync(
    payload: OrgContextJson,
    app: tauri::AppHandle,
) -> Result<(), String> {
    write_org_context_inner(&payload, &teams_data_dir(&app))
}

fn active_config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    std::path::Path::new(&teams_data_dir(app)).join("active.json")
}

#[tauri::command]
pub(crate) fn teams_active_config_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = active_config_path(&app);
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub(crate) fn teams_active_config_write(content: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = active_config_path(&app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("teams_active_config_write: create_dir_all: {}", e))?;
    }
    fs::write(&path, content.as_bytes())
        .map_err(|e| format!("teams_active_config_write: write: {}", e))
}

#[tauri::command]
pub(crate) fn teams_active_config_clear(app: tauri::AppHandle) -> Result<(), String> {
    let path = active_config_path(&app);
    let _ = fs::remove_file(&path);
    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("copy_dir_recursive: create_dir_all {:?}: {}", dst, e))?;
    for entry in fs::read_dir(src)
        .map_err(|e| format!("copy_dir_recursive: read_dir {:?}: {}", src, e))?
    {
        let entry = entry.map_err(|e| format!("copy_dir_recursive: entry: {}", e))?;
        let name = entry.file_name();
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("copy_dir_recursive: copy {:?}: {}", src_path, e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn teams_archive_copy(src: String, dst: String) -> Result<(), String> {
    let src_path = std::path::Path::new(&src);
    let dst_path = std::path::Path::new(&dst);
    if !src_path.exists() {
        return Err(format!("teams_archive_copy: source does not exist: {}", src));
    }
    copy_dir_recursive(src_path, dst_path)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    /// Verify org_context_write_roundtrip:
    /// Build an OrgContextJson, write it via write_org_context_inner,
    /// read back the file and verify camelCase JSON keys match the contract.
    #[test]
    fn org_context_write_roundtrip() {
        use super::{OrgContextJson, OrgContextTeam, OrgContextDept, write_org_context_inner};

        let tmp = TempDir::new().expect("TempDir::new");
        let dir = tmp.path().to_str().unwrap();

        let ctx = OrgContextJson {
            user_id: "user-uuid-123".to_string(),
            org_id: "org-uuid-456".to_string(),
            org_slug: "acme-corp".to_string(),
            is_org_admin: false,
            teams: vec![
                OrgContextTeam {
                    slug: "engineering".to_string(),
                    name: "Engineering".to_string(),
                    visibility: "org-readable".to_string(),
                    role: Some("member".to_string()),
                    dept_id: Some("dept-uuid-789".to_string()),
                },
                OrgContextTeam {
                    slug: "design".to_string(),
                    name: "Design".to_string(),
                    visibility: "org-readable".to_string(),
                    role: None,
                    dept_id: Some("dept-uuid-abc".to_string()),
                },
            ],
            depts: vec![
                OrgContextDept { id: "dept-uuid-789".to_string(), slug: "engineering".to_string() },
                OrgContextDept { id: "dept-uuid-abc".to_string(), slug: "design".to_string() },
            ],
        };

        write_org_context_inner(&ctx, dir).expect("write_org_context_inner must succeed");

        let path = std::path::Path::new(dir).join("org-context.json");
        assert!(path.exists(), "org-context.json must be created at {:?}", path);

        let raw = std::fs::read_to_string(&path).expect("read org-context.json");
        let parsed: serde_json::Value = serde_json::from_str(&raw).expect("parse JSON");

        assert_eq!(parsed["userId"].as_str(),       Some("user-uuid-123"), "userId");
        assert_eq!(parsed["orgId"].as_str(),         Some("org-uuid-456"),  "orgId");
        assert_eq!(parsed["orgSlug"].as_str(),       Some("acme-corp"),     "orgSlug");
        assert_eq!(parsed["isOrgAdmin"].as_bool(),   Some(false),           "isOrgAdmin");

        let teams = parsed["teams"].as_array().expect("teams array");
        assert_eq!(teams.len(), 2, "2 teams");
        assert_eq!(teams[0]["slug"].as_str(),       Some("engineering"));
        assert_eq!(teams[0]["visibility"].as_str(), Some("org-readable"));
        assert_eq!(teams[0]["role"].as_str(),       Some("member"));
        assert_eq!(teams[0]["deptId"].as_str(),     Some("dept-uuid-789"));
        assert!(teams[1]["role"].is_null(), "null role serialises as JSON null");
        assert_eq!(teams[1]["deptId"].as_str(), Some("dept-uuid-abc"));

        let depts = parsed["depts"].as_array().expect("depts array");
        assert_eq!(depts.len(), 2, "2 depts");
        assert_eq!(depts[0]["id"].as_str(),   Some("dept-uuid-789"));
        assert_eq!(depts[0]["slug"].as_str(), Some("engineering"));

        eprintln!("org_context_write_roundtrip PASSED: camelCase contract verified");
    }
}
