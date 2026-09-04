//! lazy_agent JSON CRUD: user-scope (~/.lazy/agents/) and project-scope
//! (<project>/.lazy/agents/) storage for saved agent definitions.

use std::fs;

use serde::{Deserialize, Serialize};

use crate::state::ProjectState;

/// Payload returned by lazy_agents_list for each stored agent.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StoredAgentEntry {
    /// The raw agent JSON (deserialised by the TS side).
    pub agent: serde_json::Value,
    /// "user" or "project"
    pub scope: String,
}

/// Resolve user-scope agents directory: ~/.lazy/agents/
pub(crate) fn user_agents_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    std::path::Path::new(&home).join(".lazy").join("agents")
}

/// Resolve project-scope agents directory: <ProjectState>/.lazy/agents/
pub(crate) fn project_agents_dir(project_state: &tauri::State<ProjectState>) -> Option<std::path::PathBuf> {
    let root = project_state.0.lock().ok()?;
    if root.is_empty() {
        return None;
    }
    Some(std::path::Path::new(root.as_str()).join(".lazy").join("agents"))
}

/// Read all *.json files from a directory as StoredAgentEntry items.
fn read_agent_dir(dir: &std::path::Path, scope: &str) -> Vec<StoredAgentEntry> {
    let mut result = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return result,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(agent) = serde_json::from_str::<serde_json::Value>(&content) {
                result.push(StoredAgentEntry {
                    agent,
                    scope: scope.to_string(),
                });
            }
        }
    }
    result
}

/// List all saved agents (user scope + project scope).
///
/// User agents: ~/.lazy/agents/*.json
/// Project agents: <project>/.lazy/agents/*.json
#[tauri::command]
pub(crate) fn lazy_agents_list(
    project_state: tauri::State<ProjectState>,
) -> Result<Vec<StoredAgentEntry>, String> {
    let mut result = Vec::new();

    // User scope
    let user_dir = user_agents_dir();
    result.extend(read_agent_dir(&user_dir, "user"));

    // Project scope
    if let Some(proj_dir) = project_agents_dir(&project_state) {
        result.extend(read_agent_dir(&proj_dir, "project"));
    }

    Ok(result)
}

/// Save (create or update) a LazyAgent JSON to the appropriate directory.
///
/// scope: "user" → ~/.lazy/agents/<name>.json
/// scope: "project" → <project>/.lazy/agents/<name>.json
#[tauri::command]
pub(crate) fn lazy_agent_save(
    scope: String,
    agent_json: String,
    project_state: tauri::State<ProjectState>,
) -> Result<(), String> {
    // Parse to extract the name/id for the filename
    let parsed: serde_json::Value = serde_json::from_str(&agent_json)
        .map_err(|e| format!("lazy_agent_save: invalid JSON: {}", e))?;

    let name = parsed.get("name")
        .and_then(|n| n.as_str())
        .filter(|n| !n.is_empty())
        .ok_or_else(|| "lazy_agent_save: agent.name is required".to_string())?;

    // Sanitize name: allow only alphanumeric, dash, and underscore to prevent
    // directory traversal writes (e.g. "../../../etc/passwd").
    let safe_name: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe_name.is_empty() {
        return Err("lazy_agent_save: agent name contains no valid characters".to_string());
    }

    let dir = match scope.as_str() {
        "user" => user_agents_dir(),
        "project" => project_agents_dir(&project_state)
            .ok_or_else(|| "lazy_agent_save: no project open for project-scope agent".to_string())?,
        _ => return Err(format!("lazy_agent_save: invalid scope '{}'", scope)),
    };

    fs::create_dir_all(&dir)
        .map_err(|e| format!("lazy_agent_save: create_dir_all failed: {}", e))?;

    let file_path = dir.join(format!("{}.json", safe_name));

    // Pretty-print for human readability
    let pretty = serde_json::to_string_pretty(&parsed)
        .map_err(|e| format!("lazy_agent_save: serialize failed: {}", e))?;

    fs::write(&file_path, pretty)
        .map_err(|e| format!("lazy_agent_save: write failed for '{}': {}", file_path.display(), e))
}

/// Delete a LazyAgent by id (looks up by id field in stored JSON files).
///
/// scope: "user" | "project"
#[tauri::command]
pub(crate) fn lazy_agent_delete(
    scope: String,
    id: String,
    project_state: tauri::State<ProjectState>,
) -> Result<(), String> {
    let dir = match scope.as_str() {
        "user" => user_agents_dir(),
        "project" => project_agents_dir(&project_state)
            .ok_or_else(|| "lazy_agent_delete: no project open".to_string())?,
        _ => return Err(format!("lazy_agent_delete: invalid scope '{}'", scope)),
    };

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("lazy_agent_delete: read_dir failed: {}", e))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if v.get("id").and_then(|i| i.as_str()) == Some(id.as_str()) {
                    fs::remove_file(&path)
                        .map_err(|e| format!("lazy_agent_delete: remove failed: {}", e))?;
                    return Ok(());
                }
            }
        }
    }

    Err(format!("lazy_agent_delete: agent '{}' not found in scope '{}'", id, scope))
}
