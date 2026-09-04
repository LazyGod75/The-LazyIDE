//! Read-only fetch proxies ──────────────────────────────────────────
//!
//! Every proxy below is an `async fn` whose whole body runs inside
//! `tauri::async_runtime::spawn_blocking`: each one makes a
//! `reqwest::blocking` HTTP call (up to `http_client()`'s 15s timeout, plus
//! `active_brain_query_suffix`'s own possible lazy `/brains/open` POST). As
//! plain sync commands they ran on Tauri's MAIN thread — the same thread
//! that serves every other sync invoke AND the custom-protocol asset
//! requests — so one slow/hung sidecar fetch (e.g. right after an
//! auto-index sidecar restart) stalled the entire IPC surface for its full
//! duration. And a `reqwest::blocking` client must never live on a tokio
//! ASYNC worker (drop panics with "Cannot drop a runtime in a context where
//! blocking is not allowed"), so the blocking pool is the only correct
//! home. See `project_register` (commands/brain/config.rs) for the full
//! mechanism write-up. `BrainState` is re-derived from the owned
//! `AppHandle` inside each closure because a `tauri::State<'_, T>` borrow
//! cannot move into a `'static` `spawn_blocking` closure.

use tauri::Manager;

use crate::commands::brain::sidecar::routing::active_brain_query_suffix;
use crate::commands::brain::sidecar::state::{BrainState, brain_port_and_token, http_client};

/// Proxy GET /_api/graph to the LazyBrain sidecar (bypasses WebView2 loopback isolation).
/// Returns the raw JSON body as a string; the TS client parses it.
#[tauri::command]
pub(crate) async fn brain_fetch_graph(app: tauri::AppHandle) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrainState>();
        let (port, token) = brain_port_and_token(&state);
        let suffix = active_brain_query_suffix(&app, false);
        let url = format!("http://127.0.0.1:{}/_api/graph{}", port, suffix);
        http_client()
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .map_err(|e| format!("brain_fetch_graph: {}", e))?
            .text()
            .map_err(|e| format!("brain_fetch_graph text: {}", e))
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("brain_fetch_graph: blocking task join failed: {}", e)),
    }
}

/// Proxy GET /_api/note-meta/:id to the LazyBrain sidecar.
#[tauri::command]
pub(crate) async fn brain_fetch_note_meta(id: String, app: tauri::AppHandle) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrainState>();
        let (port, token) = brain_port_and_token(&state);
        // Proper percent-encoding prevents query/path injection (#44).
        let encoded = urlencoding::encode(&id);
        let suffix = active_brain_query_suffix(&app, false);
        let url = format!("http://127.0.0.1:{}/_api/note-meta/{}{}", port, encoded, suffix);
        http_client()
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .map_err(|e| format!("brain_fetch_note_meta: {}", e))?
            .text()
            .map_err(|e| format!("brain_fetch_note_meta text: {}", e))
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("brain_fetch_note_meta: blocking task join failed: {}", e)),
    }
}

/// Proxy GET /_api/search?q=:q&top=:top to the LazyBrain sidecar.
#[tauri::command]
pub(crate) async fn brain_fetch_search(q: String, top: u32, app: tauri::AppHandle) -> Result<String, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrainState>();
        let (port, token) = brain_port_and_token(&state);
        // Proper percent-encoding prevents query parameter injection (#44).
        let encoded_q = urlencoding::encode(&q);
        let suffix = active_brain_query_suffix(&app, true);
        let url = format!("http://127.0.0.1:{}/_api/search?q={}&top={}{}", port, encoded_q, top, suffix);
        http_client()
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .map_err(|e| format!("brain_fetch_search: {}", e))?
            .text()
            .map_err(|e| format!("brain_fetch_search text: {}", e))
    })
    .await
    {
        Ok(result) => result,
        Err(e) => Err(format!("brain_fetch_search: blocking task join failed: {}", e)),
    }
}

/// Proxy GET /_api/notes/:id/backlinks to the LazyBrain sidecar.
/// Returns a JSON array of node id strings; returns empty array on error.
#[tauri::command]
pub(crate) async fn brain_fetch_backlinks(id: String, app: tauri::AppHandle) -> Result<Vec<String>, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrainState>();
        let (port, token) = brain_port_and_token(&state);
        let encoded = urlencoding::encode(&id);
        let suffix = active_brain_query_suffix(&app, false);
        let url = format!("http://127.0.0.1:{}/_api/notes/{}/backlinks{}", port, encoded, suffix);
        match http_client().get(&url).header("Authorization", format!("Bearer {}", token)).send() {
            Ok(resp) => {
                let text = resp.text().unwrap_or_default();
                // Parse JSON array of strings; return empty vec on any parse error
                serde_json::from_str::<Vec<String>>(&text).unwrap_or_default()
            }
            Err(_) => Vec::new(),
        }
    })
    .await
    {
        Ok(list) => Ok(list),
        Err(e) => Err(format!("brain_fetch_backlinks: blocking task join failed: {}", e)),
    }
}

/// Proxy GET /_api/notes/:id/neighbors to the LazyBrain sidecar.
/// Returns a JSON array of node id strings; returns empty array on error.
#[tauri::command]
pub(crate) async fn brain_fetch_neighbors(id: String, app: tauri::AppHandle) -> Result<Vec<String>, String> {
    match tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BrainState>();
        let (port, token) = brain_port_and_token(&state);
        let encoded = urlencoding::encode(&id);
        let suffix = active_brain_query_suffix(&app, false);
        let url = format!("http://127.0.0.1:{}/_api/notes/{}/neighbors{}", port, encoded, suffix);
        match http_client().get(&url).header("Authorization", format!("Bearer {}", token)).send() {
            Ok(resp) => {
                let text = resp.text().unwrap_or_default();
                serde_json::from_str::<Vec<String>>(&text).unwrap_or_default()
            }
            Err(_) => Vec::new(),
        }
    })
    .await
    {
        Ok(list) => Ok(list),
        Err(e) => Err(format!("brain_fetch_neighbors: blocking task join failed: {}", e)),
    }
}
