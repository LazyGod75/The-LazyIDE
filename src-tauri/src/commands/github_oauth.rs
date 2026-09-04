//! github_oauth.rs — GitHub OAuth device flow + narrow api.github.com proxy
//! (design §10: "The app connects via GitHub OAuth (device flow) and can
//! create the private repos").
//!
//! Device flow (why: desktop app, no client_secret to embed — the token
//! exchange works with only the public client_id):
//!   1. `github_oauth_device_code(client_id)` → POST
//!      https://github.com/login/device/code → { device_code, user_code,
//!      verification_uri, interval, expires_in }.
//!   2. The user opens verification_uri and enters user_code in a browser.
//!   3. `github_oauth_poll_token(client_id, device_code)` polls POST
//!      https://github.com/login/oauth/access_token until authorized →
//!      { access_token, ... } or { error, error_description }.
//!
//! Token storage: `teams_github_token_write/read/clear` persist the OAuth
//! token + identity in the OS credential vault (see `commands::vault`,
//! `keyring` crate — Windows Credential Manager / macOS Keychain / Linux
//! Secret Service), under `GITHUB_TOKEN_VAULT_KEY`. Before 2026-08-12 this
//! was a plaintext JSON file at `<app_local_data_dir>/lazy/teams/github.json`
//! (still referenced below purely as a one-time migration source: any
//! reader that finds no vault entry falls back to that legacy path, moves
//! the token into the vault, and deletes the file — silent, so an upgrading
//! user never has to reconnect GitHub and never keeps a plaintext copy
//! behind).
//!
//! `github_api_get`/`github_api_post` are a NARROW proxy: only
//! https://api.github.com/* URLs are accepted (SSRF guard), used by the
//! frontend for `/user`, `/user/orgs`, `/user/repos` (repo provisioning).

use std::path::PathBuf;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use tauri::Manager;

// ── Result types ─────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeResult {
    pub ok: bool,
    pub device_code: Option<String>,
    pub user_code: Option<String>,
    pub verification_uri: Option<String>,
    pub interval: Option<u64>,
    pub expires_in: Option<u64>,
    pub error: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TokenPollResult {
    pub ok: bool,
    pub access_token: Option<String>,
    pub token_type: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitHubApiResult {
    pub ok: bool,
    pub status: u16,
    pub body: String,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubTokenStore {
    pub token: String,
    pub login: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub updated_at: i64,
}

fn http_client() -> Client {
    Client::builder()
        .user_agent("lazy-ide")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| Client::new())
}
// ── Device flow commands ─────────────────────────────────────────────

/// Step 1: request a device code + user code from GitHub.
#[tauri::command]
pub(crate) fn github_oauth_device_code(client_id: String) -> DeviceCodeResult {
    if client_id.trim().is_empty() {
        return DeviceCodeResult {
            ok: false,
            device_code: None,
            user_code: None,
            verification_uri: None,
            interval: None,
            expires_in: None,
            error: Some("client_id is empty".to_string()),
        };
    }
    let client = http_client();
    let resp = match client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.trim().to_string())])
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            return DeviceCodeResult {
                ok: false,
                device_code: None,
                user_code: None,
                verification_uri: None,
                interval: None,
                expires_in: None,
                error: Some(format!("device code request failed: {}", e)),
            };
        }
    };
    let status = resp.status().as_u16();
    let text = match resp.text() {
        Ok(t) => t,
        Err(e) => {
            return DeviceCodeResult {
                ok: false,
                device_code: None,
                user_code: None,
                verification_uri: None,
                interval: None,
                expires_in: None,
                error: Some(format!("read device code response: {}", e)),
            };
        }
    };
    if status != 200 {
        return DeviceCodeResult {
            ok: false,
            device_code: None,
            user_code: None,
            verification_uri: None,
            interval: None,
            expires_in: None,
            error: Some(format!("device code endpoint returned {}: {}", status, text)),
        };
    }
    match serde_json::from_str::<DeviceCodeResponse>(&text) {
        Ok(d) => DeviceCodeResult {
            ok: true,
            device_code: Some(d.device_code),
            user_code: Some(d.user_code),
            verification_uri: Some(d.verification_uri),
            interval: Some(d.interval.max(1)),
            expires_in: Some(d.expires_in),
            error: None,
        },
        Err(e) => DeviceCodeResult {
            ok: false,
            device_code: None,
            user_code: None,
            verification_uri: None,
            interval: None,
            expires_in: None,
            error: Some(format!("parse device code response: {} ({})", e, text)),
        },
    }
}
/// Step 3: poll for the access token. Returns `ok:false` with an `error`
/// while the user hasn"t authorized yet — the frontend retries until the
/// device code expires or `ok:true`.
#[tauri::command]
pub(crate) fn github_oauth_poll_token(
    client_id: String,
    device_code: String,
) -> TokenPollResult {
    if device_code.trim().is_empty() {
        return TokenPollResult {
            ok: false,
            access_token: None,
            token_type: None,
            scope: None,
            error: Some("device_code is empty".to_string()),
            error_description: None,
        };
    }
    let client = http_client();
    let resp = match client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.trim().to_string()),
            ("device_code", device_code.trim().to_string()),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
        ])
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            return TokenPollResult {
                ok: false,
                access_token: None,
                token_type: None,
                scope: None,
                error: Some(format!("poll request failed: {}", e)),
                error_description: None,
            };
        }
    };
    let text = match resp.text() {
        Ok(t) => t,
        Err(e) => {
            return TokenPollResult {
                ok: false,
                access_token: None,
                token_type: None,
                scope: None,
                error: Some(format!("read poll response: {}", e)),
                error_description: None,
            };
        }
    };
    #[derive(Deserialize)]
    struct PollRaw {
        access_token: Option<String>,
        token_type: Option<String>,
        scope: Option<String>,
        error: Option<String>,
        error_description: Option<String>,
    }
    let parsed: PollRaw = match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            return TokenPollResult {
                ok: false,
                access_token: None,
                token_type: None,
                scope: None,
                error: Some(format!("parse poll response: {} ({})", e, text)),
                error_description: None,
            };
        }
    };
    if let Some(token) = parsed.access_token {
        TokenPollResult {
            ok: true,
            access_token: Some(token),
            token_type: parsed.token_type,
            scope: parsed.scope,
            error: None,
            error_description: None,
        }
    } else {
        TokenPollResult {
            ok: false,
            access_token: None,
            token_type: None,
            scope: None,
            error: parsed.error,
            error_description: parsed.error_description,
        }
    }
}
// ── Narrow api.github.com proxy ──────────────────────────────────────

const API_PREFIX: &str = "https://api.github.com/";

fn valid_api_url(url: &str) -> Result<&str, String> {
    if !url.starts_with(API_PREFIX) {
        return Err(format!("github_api: URL must start with {}", API_PREFIX));
    }
    Ok(url)
}

fn api_client() -> Client {
    Client::builder()
        .user_agent("lazy-ide")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// GET a GitHub API endpoint with the OAuth token (`Authorization: token …`).
#[tauri::command]
pub(crate) fn github_api_get(url: String, token: String) -> GitHubApiResult {
    let url = match valid_api_url(&url) {
        Ok(u) => u,
        Err(e) => {
            return GitHubApiResult {
                ok: false,
                status: 0,
                body: String::new(),
                error: Some(e),
            };
        }
    };
    let client = api_client();
    let resp = match client
        .get(url)
        .header("Authorization", format!("token {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            return GitHubApiResult {
                ok: false,
                status: 0,
                body: String::new(),
                error: Some(format!("github_api_get request failed: {}", e)),
            };
        }
    };
    let status = resp.status().as_u16();
    let body = resp.text().unwrap_or_default();
    if status >= 400 {
        return GitHubApiResult {
            ok: false,
            status,
            body: body.clone(),
            error: Some(format!("GitHub API returned {}: {}", status, body)),
        };
    }
    GitHubApiResult {
        ok: true,
        status,
        body,
        error: None,
    }
}

/// POST a JSON body to a GitHub API endpoint with the OAuth token.
#[tauri::command]
pub(crate) fn github_api_post(url: String, token: String, body: String) -> GitHubApiResult {
    let url = match valid_api_url(&url) {
        Ok(u) => u,
        Err(e) => {
            return GitHubApiResult {
                ok: false,
                status: 0,
                body: String::new(),
                error: Some(e),
            };
        }
    };
    let client = api_client();
    let resp = match client
        .post(url)
        .header("Authorization", format!("token {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("Content-Type", "application/json")
        .body(body)
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            return GitHubApiResult {
                ok: false,
                status: 0,
                body: String::new(),
                error: Some(format!("github_api_post request failed: {}", e)),
            };
        }
    };
    let status = resp.status().as_u16();
    let body_text = resp.text().unwrap_or_default();
    if status >= 400 {
        return GitHubApiResult {
            ok: false,
            status,
            body: body_text.clone(),
            error: Some(format!("GitHub API returned {}: {}", status, body_text)),
        };
    }
    GitHubApiResult {
        ok: true,
        status,
        body: body_text,
        error: None,
    }
}
// ── Token storage (OS credential vault, with legacy-file migration) ───

use super::vault;

/// Vault key the token + identity JSON is stored under (see `secrets.rs`).
const GITHUB_TOKEN_VAULT_KEY: &str = "teams.github_oauth_token";

/// Pre-2026-08-12 storage location — kept only so
/// `migrate_legacy_github_token_file_at` can find and migrate a token
/// written by an older build. Never written to again by this module.
fn legacy_github_token_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("lazy").join("teams").join("github.json"))
        .unwrap_or_else(|_| PathBuf::from("lazy-teams-github.json"))
}

/// Persist the GitHub OAuth token + identity in the OS credential vault.
#[tauri::command]
pub(crate) fn teams_github_token_write(payload: GitHubTokenStore) -> Result<(), String> {
    let json = serde_json::to_string(&payload)
        .map_err(|e| format!("teams_github_token_write: serialize: {}", e))?;
    vault::vault_set(GITHUB_TOKEN_VAULT_KEY, &json)?;
    // Safe to log: no secret value, just that a write happened.
    log::info!("github oauth token stored in OS credential vault");
    Ok(())
}

/// Read the stored GitHub OAuth token, or `None` when nothing is stored
/// anywhere (vault or legacy file). On the FIRST read after upgrading from
/// a build that used the plaintext `github.json` file, this transparently
/// migrates that file's contents into the vault and deletes the file —
/// silent, one-time, no user action required.
#[tauri::command]
pub(crate) fn teams_github_token_read(
    app: tauri::AppHandle,
) -> Result<Option<GitHubTokenStore>, String> {
    if let Some(json) = vault::vault_get(GITHUB_TOKEN_VAULT_KEY)? {
        let parsed: GitHubTokenStore = serde_json::from_str(&json)
            .map_err(|e| format!("teams_github_token_read: parse vault entry: {}", e))?;
        return Ok(Some(parsed));
    }
    migrate_legacy_github_token_file_at(&legacy_github_token_path(&app), GITHUB_TOKEN_VAULT_KEY)
}

/// Migration path: the vault had nothing — look for the legacy plaintext
/// file at `path`. If it exists, move its contents into the vault entry
/// `vault_key` and delete the file. If it doesn't exist either, this is the
/// no-op path: nothing to migrate, return `Ok(None)` without touching the
/// filesystem or the vault.
///
/// Pure function of `(path, vault_key)` (no `tauri::AppHandle`) so it is
/// directly unit-testable with a tempdir — see `token_storage_tests` below.
fn migrate_legacy_github_token_file_at(
    path: &std::path::Path,
    vault_key: &str,
) -> Result<Option<GitHubTokenStore>, String> {
    if !path.exists() {
        return Ok(None); // no-op path: nothing in the vault, nothing on disk
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("teams_github_token_read: read legacy file: {}", e))?;
    let parsed: GitHubTokenStore = serde_json::from_str(&raw)
        .map_err(|e| format!("teams_github_token_read: parse legacy file: {}", e))?;
    let json = serde_json::to_string(&parsed)
        .map_err(|e| format!("teams_github_token_read: re-serialize for vault: {}", e))?;
    vault::vault_set(vault_key, &json)?;
    std::fs::remove_file(path)
        .map_err(|e| format!("teams_github_token_read: remove legacy file: {}", e))?;
    log::info!("migrated github oauth token from legacy file to OS credential vault");
    Ok(Some(parsed))
}

/// Delete the stored GitHub OAuth token (sign-out / disconnect). Clears
/// both the vault entry and, defensively, any leftover legacy file (e.g. a
/// user who disconnects before ever triggering the read-path migration
/// above).
#[tauri::command]
pub(crate) fn teams_github_token_clear(app: tauri::AppHandle) -> Result<(), String> {
    vault::vault_delete(GITHUB_TOKEN_VAULT_KEY)?;
    remove_legacy_file_if_present(&legacy_github_token_path(&app))
}

/// Pure helper for `teams_github_token_clear`'s legacy-file cleanup, kept
/// free of `tauri::AppHandle` so it is directly unit-testable.
fn remove_legacy_file_if_present(path: &std::path::Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|e| format!("teams_github_token_clear: remove legacy file: {}", e))?;
    }
    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod token_storage_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    // Runs against the REAL platform backend (Windows Credential Manager on
    // this box), same reasoning as vault.rs's own tests: keyring::mock hands
    // out a fresh, unpersisted credential on every `Entry::new()` call, so it
    // can't exercise a real set-then-get round trip across separate
    // `vault::vault_*` calls. `CleanupGuard` deletes the test's vault key on
    // drop (including on panic) so no residue is left behind.
    struct CleanupGuard(String);
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            let _ = vault::vault_delete(&self.0);
        }
    }

    fn unique_vault_key() -> String {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        format!("test.github_token.{}.{}", std::process::id(), n)
    }

    fn sample_store() -> GitHubTokenStore {
        GitHubTokenStore {
            token: "gho_testtoken1234567890".to_string(),
            login: "octocat".to_string(),
            name: Some("The Octocat".to_string()),
            email: None,
            updated_at: 1_700_000_000,
        }
    }

    #[test]
    fn migration_path_moves_legacy_file_into_vault_and_deletes_it() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_path = dir.path().join("github.json");
        let vault_key = unique_vault_key();
        let _cleanup = CleanupGuard(vault_key.clone());
        let store = sample_store();
        std::fs::write(&legacy_path, serde_json::to_string(&store).unwrap()).unwrap();

        // Precondition: vault empty, legacy file present.
        assert_eq!(vault::vault_get(&vault_key).unwrap(), None);
        assert!(legacy_path.exists());

        let migrated = migrate_legacy_github_token_file_at(&legacy_path, &vault_key).unwrap();

        assert_eq!(migrated.as_ref().map(|s| s.token.as_str()), Some(store.token.as_str()));
        assert_eq!(migrated.as_ref().map(|s| s.login.as_str()), Some(store.login.as_str()));
        // Old location is empty: the file must be gone.
        assert!(!legacy_path.exists(), "legacy plaintext file must be removed after migration");
        // New location has the value: the vault must now hold it.
        let vaulted_json = vault::vault_get(&vault_key).unwrap().expect("vault must hold the migrated token");
        let vaulted: GitHubTokenStore = serde_json::from_str(&vaulted_json).unwrap();
        assert_eq!(vaulted.token, store.token);
    }

    #[test]
    fn noop_path_when_nothing_to_migrate() {
        let dir = tempfile::tempdir().unwrap();
        // Deliberately do NOT create github.json.
        let legacy_path = dir.path().join("github.json");
        let vault_key = unique_vault_key();

        let result = migrate_legacy_github_token_file_at(&legacy_path, &vault_key).unwrap();

        assert_eq!(result, None);
        assert_eq!(vault::vault_get(&vault_key).unwrap(), None, "no-op must not create a vault entry");
        assert!(!legacy_path.exists());
    }

    #[test]
    fn write_then_read_round_trips_via_vault_directly() {
        let vault_key = unique_vault_key();
        let _cleanup = CleanupGuard(vault_key.clone());
        let store = sample_store();
        let json = serde_json::to_string(&store).unwrap();
        vault::vault_set(&vault_key, &json).unwrap();

        let read_back = vault::vault_get(&vault_key).unwrap().expect("value must round-trip");
        let parsed: GitHubTokenStore = serde_json::from_str(&read_back).unwrap();
        assert_eq!(parsed.token, store.token);
        assert_eq!(parsed.login, store.login);
    }

    #[test]
    fn clear_removes_legacy_file_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_path = dir.path().join("github.json");
        std::fs::write(&legacy_path, "{}").unwrap();

        remove_legacy_file_if_present(&legacy_path).unwrap();

        assert!(!legacy_path.exists());
    }

    #[test]
    fn clear_is_a_noop_when_no_legacy_file_present() {
        let dir = tempfile::tempdir().unwrap();
        let legacy_path = dir.path().join("github.json");

        // Must not error just because there was nothing to remove.
        remove_legacy_file_if_present(&legacy_path).unwrap();
    }
}
