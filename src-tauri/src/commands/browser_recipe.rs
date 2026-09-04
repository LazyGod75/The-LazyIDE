//! Recipe execution Tauri commands — Mission D, generic web publishing.
//!
//! Drives the SAME Playwright controller process and `instances()` map as
//! `commands::browser` (see that module for the controller script itself),
//! keyed by a caller-chosen `session_id` instead of the hardcoded
//! `BROWSER_INSTANCE_ID`, so a recipe session never collides with a manual
//! browsing session.
//!
//! All site-specific knowledge — which selector to click, which URL to
//! open, what counts as an unexpected screen — is supplied by the CALLER
//! as data: a "recipe" of steps and guards (see
//! `src/lib/agents/browserRecipe.ts`). This module only knows the generic
//! step kinds (`navigate`/`waitFor`/`click`/`fill`/`upload`/`assert`) and
//! generic guard shapes (`selector`/`textContains`) — never a specific
//! site's shape.
//!
//! Commands:
//! - `browser_recipe_open` — launches (or reuses) a persistent-profile
//!   session so a login survives across executions
//! - `browser_recipe_step` — executes exactly one recipe step, time-bounded,
//!   with a guard check + screenshot proof after every step
//! - `browser_recipe_close` — closes the session and kills the controller
//!
//! "Stop before the final action" (the default validation mode) and the
//! circuit-breaker's "never retry" rule are enforced by the TypeScript
//! caller, which decides per step whether to send it at all — this module
//! only executes whatever single step it's asked to run.

use std::process::{Command, Stdio};

use super::browser::{instances, send_and_receive, write_controller_script, BrowserState};

/// Default per-step bound used when a recipe step omits `timeoutMs` — kept
/// in sync with the controller script's own `10000` fallback so the outer
/// transport timeout (`step_timeout_ms + OUTER_TIMEOUT_MARGIN_MS`) is never
/// tighter than the inner one the controller actually enforces.
const DEFAULT_STEP_TIMEOUT_MS: u64 = 10_000;

/// Margin added on top of a step's own timeout for the OUTER transport
/// read (`send_and_receive`) — the controller enforces the inner bound
/// itself (`withTimeout`, +2000ms there) and always replies with a result
/// object either way; this margin only guards against transport overhead.
const OUTER_TIMEOUT_MARGIN_MS: u64 = 5_000;

/// Sanitizes a caller-supplied profile name into a filesystem-safe slug.
/// Recipes are DATA supplied by the manager/user, never trusted verbatim
/// for a path join — an unsanitized name could contain `..`, path
/// separators, or reserved Windows device names. Non `[a-zA-Z0-9_-]`
/// characters are dropped and the result capped at 64 bytes; an
/// all-invalid or empty input falls back to `"default"`.
fn sanitize_profile_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

/// Root directory under which persistent browser profiles are stored, one
/// subdirectory per sanitized profile name — this is what gives Mission
/// D's "profil connecté persistant" its persistence across app restarts.
/// Prefers `LAZY_APP_CONFIG_DIR` (the same env var
/// `brain::config::expose_app_config_dir` sets at startup, so profiles
/// live alongside the rest of the app's own data); falls back to the OS
/// temp dir when unset (e.g. this module's own unit tests).
fn browser_profiles_root() -> std::path::PathBuf {
    let base = std::env::var("LAZY_APP_CONFIG_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("browser-profiles")
}

/// Resolves the persistent profile directory for a given (unsanitized)
/// profile name. Does not create the directory — callers create it lazily
/// right before launching the persistent context.
fn profile_dir(profile_name: &str) -> std::path::PathBuf {
    browser_profiles_root().join(sanitize_profile_name(profile_name))
}

/// Resolves a recipe step's declared `secretEnvVar` (if any) into a
/// literal `value` field, IN PLACE, removing the `secretEnvVar` key
/// afterward. Recipes may only reference a credential by the NAME of an
/// environment variable — never a literal secret — per Mission D's
/// non-negotiable "identifiants passés par variable d'environnement,
/// jamais écrits dans le dépôt". The resolved value is written only into
/// the JSON message sent to the controller's stdin (never logged —
/// `send_and_receive` logs nothing about message content) and is never
/// echoed back in a step result. Fails fast (rather than filling a blank
/// or wrong value) when the named variable isn't set; the error message
/// names the variable, never a value.
fn resolve_step_secret(step: &mut serde_json::Value) -> Result<(), String> {
    let env_var = match step.get("secretEnvVar").and_then(|v| v.as_str()) {
        Some(name) => name.to_string(),
        None => return Ok(()),
    };
    let value = std::env::var(&env_var)
        .map_err(|_| format!("Environment variable '{}' is not set", env_var))?;
    if let Some(obj) = step.as_object_mut() {
        obj.insert("value".to_string(), serde_json::Value::String(value));
        obj.remove("secretEnvVar");
    }
    Ok(())
}

/// Opens a persistent-profile Playwright session for recipe execution,
/// keyed by `session_id` (distinct from the manual `browser_playwright_*`
/// commands' hardcoded `"default"` instance, so the two never collide in
/// the shared `instances()` map). `profile_name` selects which on-disk
/// profile directory to reuse across runs — the SAME profile name always
/// resumes the SAME logged-in session.
#[tauri::command]
pub fn browser_recipe_open(session_id: String, profile_name: String, headless: bool) -> Result<String, String> {
    let dir = profile_dir(&profile_name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create profile dir: {}", e))?;

    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(mut old) = map.remove(&session_id) {
        let _ = old.child.kill();
        let _ = old.child.wait();
    }

    let script_path = write_controller_script()?;
    let child = Command::new("node")
        .arg(&script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Playwright controller: {}", e))?;
    map.insert(session_id.clone(), BrowserState { child });

    let state = map
        .get_mut(&session_id)
        .ok_or_else(|| "Failed to get recipe session state".to_string())?;

    let msg = serde_json::json!({
        "id": 1,
        "action": "openPersistent",
        "params": { "userDataDir": dir.to_string_lossy(), "headless": headless }
    });
    let response = send_and_receive(state, &msg.to_string(), 30000)?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse controller response: {}", e))?;

    if let Some(err) = parsed.get("error") {
        return Err(format!("Recipe browser open failed: {}", err));
    }

    Ok("Recipe browser session opened".to_string())
}

/// Executes exactly one recipe step against an already-open recipe
/// session. `step_json` / `guards_json` are the recipe's own step and
/// guard definitions, serialized by the TypeScript caller — this command
/// has no built-in notion of what any given step or guard means for a
/// particular site.
///
/// Returns the controller's structured result verbatim as a JSON string:
/// `{ ok, detail, error, guardTripped, screenshotBase64 }`. Never retries
/// — a single failed step or tripped guard is the caller's signal to stop.
#[tauri::command]
pub fn browser_recipe_step(session_id: String, step_json: String, guards_json: String) -> Result<String, String> {
    let mut step: serde_json::Value =
        serde_json::from_str(&step_json).map_err(|e| format!("Invalid step JSON: {}", e))?;
    let guards: serde_json::Value =
        serde_json::from_str(&guards_json).map_err(|e| format!("Invalid guards JSON: {}", e))?;

    resolve_step_secret(&mut step)?;

    let step_timeout_ms = step
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_STEP_TIMEOUT_MS);
    let outer_timeout_ms = step_timeout_ms + OUTER_TIMEOUT_MARGIN_MS;

    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;
    let state = map
        .get_mut(&session_id)
        .ok_or_else(|| "Recipe session not open. Call browser_recipe_open first.".to_string())?;

    let msg = serde_json::json!({
        "id": 2,
        "action": "runStep",
        "params": { "step": step, "guards": guards }
    });
    let response = send_and_receive(state, &msg.to_string(), outer_timeout_ms)?;
    let parsed: serde_json::Value = serde_json::from_str(&response)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(err) = parsed.get("error") {
        return Err(format!("Recipe step transport failed: {}", err));
    }

    let result = parsed.get("result").cloned().unwrap_or(serde_json::Value::Null);
    Ok(result.to_string())
}

/// Closes a recipe session and kills its controller process. Same
/// best-effort-graceful-then-tree-kill-on-drop shape as
/// `browser_playwright_close` in `commands::browser`.
#[tauri::command]
pub fn browser_recipe_close(session_id: String) -> Result<String, String> {
    let mut map = instances().lock().map_err(|e| format!("Lock error: {}", e))?;

    if let Some(mut state) = map.remove(&session_id) {
        let msg = serde_json::json!({
            "id": 3,
            "action": "close",
            "params": {}
        });
        let _ = send_and_receive(&mut state, &msg.to_string(), 5000);
    }

    Ok("Recipe browser session closed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_profile_name_strips_path_traversal_and_separators() {
        assert_eq!(sanitize_profile_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_profile_name("my-brand_2"), "my-brand_2");
        assert_eq!(sanitize_profile_name(""), "default");
        assert_eq!(sanitize_profile_name("////"), "default");
        // Capped at 64 chars regardless of input length.
        let long = "a".repeat(200);
        assert_eq!(sanitize_profile_name(&long).len(), 64);
    }

    #[test]
    fn profile_dir_nests_sanitized_name_under_profiles_root() {
        let dir = profile_dir("Acme Brand!!");
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert_eq!(name, "AcmeBrand");
        assert!(dir.parent().unwrap().ends_with("browser-profiles"));
    }

    #[test]
    fn resolve_step_secret_is_noop_without_secret_env_var() {
        let mut step = serde_json::json!({ "kind": "fill", "selector": "#x", "value": "literal" });
        resolve_step_secret(&mut step).expect("noop must not error");
        assert_eq!(step["value"], "literal");
    }

    #[test]
    fn resolve_step_secret_fails_fast_on_missing_env_var_without_leaking_a_value() {
        let mut step = serde_json::json!({
            "kind": "fill",
            "selector": "#password",
            "secretEnvVar": "LAZY_TEST_NONEXISTENT_SECRET_VAR_XYZ",
        });
        let err = resolve_step_secret(&mut step).expect_err("must fail when env var unset");
        assert!(err.contains("LAZY_TEST_NONEXISTENT_SECRET_VAR_XYZ"));
        assert!(!step.as_object().unwrap().contains_key("value"));
    }

    #[test]
    fn resolve_step_secret_substitutes_value_and_removes_the_env_var_reference() {
        std::env::set_var("LAZY_TEST_SECRET_VAR_ABC", "s3cr3t");
        let mut step = serde_json::json!({
            "kind": "fill",
            "selector": "#password",
            "secretEnvVar": "LAZY_TEST_SECRET_VAR_ABC",
        });
        resolve_step_secret(&mut step).expect("must resolve");
        assert_eq!(step["value"], "s3cr3t");
        assert!(!step.as_object().unwrap().contains_key("secretEnvVar"));
        std::env::remove_var("LAZY_TEST_SECRET_VAR_ABC");
    }
}
