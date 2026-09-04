//! The flat `brain-projects.json` path-list config (get/set) and the
//! multi-project graph merge (`brain_fetch_graph_merged`) built on top of it.

use std::fs;
use std::process::Stdio;

use tauri::Manager;

use super::bin_resolve::resolve_lazybrain_bin_static;

/// Path to the JSON file that stores the list of configured project roots.
/// Created on first write; read on every command.
fn brain_projects_config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app.path().app_local_data_dir()
        .map_err(|e| format!("get_brain_projects: app_local_data_dir failed: {}", e))?;
    Ok(data_dir.join("lazy").join("brain-projects.json"))
}

/// Return the list of configured project root paths.
///
/// Reads `<app_local_data_dir>/lazy/brain-projects.json` (JSON array of strings).
/// Returns an empty list if the file does not exist yet.
#[tauri::command]
pub(crate) fn get_brain_projects(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let path = brain_projects_config_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("get_brain_projects: read failed: {}", e))?;
    let paths: Vec<String> = serde_json::from_str(&raw)
        .map_err(|e| format!("get_brain_projects: parse failed: {}", e))?;
    Ok(paths)
}

/// Persist the list of configured project root paths.
///
/// Writes a JSON array to `<app_local_data_dir>/lazy/brain-projects.json`.
/// Creates the parent directory if needed.
#[tauri::command]
pub(crate) fn set_brain_projects(paths: Vec<String>, app: tauri::AppHandle) -> Result<(), String> {
    let config_path = brain_projects_config_path(&app)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("set_brain_projects: create_dir_all failed: {}", e))?;
    }
    let json = serde_json::to_string_pretty(&paths)
        .map_err(|e| format!("set_brain_projects: serialize failed: {}", e))?;
    fs::write(&config_path, json)
        .map_err(|e| format!("set_brain_projects: write failed: {}", e))
}

/// Run `lazybrain graph --json --brain <path>` for each configured project
/// and merge all resulting BrainGraphData objects into a single one.
///
/// Nodes are deduplicated by `id`; the first occurrence wins, but every node
/// gains a `sourceProject` field pointing at its origin root.
/// Returns the merged JSON object (compatible with the BrainGraphData TS type).
/// Skips projects whose brain directory does not exist — logs a warning and continues.
///
/// `async fn` + `spawn_blocking`: the body spawns one `node lazybrain.js
/// graph --json` child PER configured project, sequentially — seconds of
/// blocking subprocess time that, as a plain sync command, ran on Tauri's
/// MAIN thread and stalled the whole IPC surface (see `project_register`'s
/// doc comment for the full mechanism and why `spawn_blocking`, not the
/// `(async)` attribute).
#[tauri::command]
pub(crate) async fn brain_fetch_graph_merged(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    match tauri::async_runtime::spawn_blocking(move || brain_fetch_graph_merged_inner(app)).await {
        Ok(result) => result,
        Err(e) => Err(format!("brain_fetch_graph_merged: blocking task join failed: {}", e)),
    }
}

/// Synchronous body of `brain_fetch_graph_merged` — always runs on the
/// blocking pool (see the command's doc comment above).
fn brain_fetch_graph_merged_inner(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let project_roots = get_brain_projects(app)?;

    let lb = resolve_lazybrain_bin_static().ok();

    let mut merged_nodes: Vec<serde_json::Value> = Vec::new();
    let mut merged_edges: Vec<serde_json::Value> = Vec::new();
    let mut seen_node_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut seen_edge_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    for root in &project_roots {
        let brain_path = std::path::Path::new(root)
            .join(".lazybrain")
            .join("brain");

        if !brain_path.exists() {
            log::warn!("brain_fetch_graph_merged: brain not found at {}, skipping", brain_path.display());
            continue;
        }

        let brain_path_str = brain_path.to_string_lossy().into_owned();

        let lb_ref = match &lb {
            Some(b) => b,
            None => {
                log::warn!("brain_fetch_graph_merged: lazybrain.js not found, skipping {}", root);
                continue;
            }
        };

        let output = lb_ref.command(&["graph", "--json", "--brain", &brain_path_str])
            .env("LAZYBRAIN_BRAIN_PATH", &brain_path_str)
            .env("LAZYBRAIN_LOG_LEVEL", "warn")
            .env("LAZYBRAIN_TELEMETRY", "0")
            .env("LAZYBRAIN_EMBEDDINGS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();

        let output = match output {
            Ok(o) => o,
            Err(e) => {
                log::warn!("brain_fetch_graph_merged: spawn failed for {}: {}", root, e);
                continue;
            }
        };

        if !output.status.success() {
            log::warn!("brain_fetch_graph_merged: graph --json exited {} for {}", output.status, root);
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let graph: serde_json::Value = match serde_json::from_str(stdout.trim()) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("brain_fetch_graph_merged: JSON parse failed for {}: {}", root, e);
                continue;
            }
        };

        // Merge nodes — dedupe by id, tag with sourceProject.
        if let Some(nodes) = graph.get("nodes").and_then(|n| n.as_array()) {
            for node in nodes {
                let id = node.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                if id.is_empty() || seen_node_ids.contains(&id) {
                    continue;
                }
                seen_node_ids.insert(id.clone());
                let mut node_obj = node.clone();
                if let Some(map) = node_obj.as_object_mut() {
                    map.insert("sourceProject".to_string(), serde_json::Value::String(root.clone()));
                }
                merged_nodes.push(node_obj);
            }
        }

        // Merge edges — dedupe by source+target pair.
        if let Some(edges) = graph.get("edges").and_then(|e| e.as_array()) {
            for edge in edges {
                let src = edge.get("source").and_then(|s| s.as_str()).unwrap_or("");
                let tgt = edge.get("target").and_then(|t| t.as_str()).unwrap_or("");
                let key = format!("{}:{}", src, tgt);
                if key == ":" || seen_edge_keys.contains(&key) {
                    continue;
                }
                seen_edge_keys.insert(key);
                merged_edges.push(edge.clone());
            }
        }
    }

    Ok(serde_json::json!({
        "nodes": merged_nodes,
        "edges": merged_edges,
    }))
}
