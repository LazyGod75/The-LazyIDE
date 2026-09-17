//! Jev (TypeSafe) Tauri command — `jev_ask`.
//!
//! Why this exists at all: api.typesafe.ai does not emit
//! Access-Control-Allow-Origin, so a browser/WebView fetch can never read
//! the response (CORS preflight succeeds but the actual response carries
//! no ACAO header — verified live). The call therefore runs here, in
//! Rust — which doubles as the TypeSafe-recommended "credentials
//! server-side" posture: the key is read from the OS vault inside this
//! command and NEVER crosses IPC into the WebView. The JS side only ever
//! holds a presence flag (see src/lib/jev/jevMode.ts).
//!
//! Fail-safe contract (mirrors src/lib/jev/jevClient.ts): every failure
//! returns Err(<category message>) — never panics, never includes the key
//! or the request body in the error. Callers fall back to deterministic
//! behavior.

use serde_json::Value;

use super::vault::vault_get;
use super::web::shared_http_client;

const JEV_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
/// Vault key — matches src/lib/vault/vaultClient.ts's
/// `byokVaultKey('typesafe')`.
const JEV_VAULT_KEY: &str = "apikey.typesafe";
const JEV_DEFAULT_MODEL: &str = "jev-latest";
/// Response bodies are small typed judgments — 256 KB is generous already.
const MAX_BODY_BYTES: usize = 256 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 4_000;
const MAX_TIMEOUT_MS: u64 = 30_000;
/// Transient statuses worth one retry — mirrors RETRYABLE_STATUSES in
/// src/lib/jev/jevClient.ts (429/529 are documented retryable by TypeSafe).
const RETRYABLE_STATUSES: [u16; 6] = [408, 429, 500, 502, 503, 529];
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(600);

/// Ask the TypeSafe System One model a bounded typed judgment.
///
/// `state` — arbitrary JSON context for the questions.
/// `questions` — the typed question map ({id: {type, instructions, criteria}}).
/// `model`/`timeout_ms` — optional overrides (bounded).
///
/// Returns the raw API response body as JSON ({model, answers, usage}).
/// Err strings carry a stable category prefix the JS client maps onto
/// JevError categories ("jev: …").
#[tauri::command]
pub(crate) fn jev_ask(
    state: Value,
    questions: Value,
    model: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let key = vault_get(JEV_VAULT_KEY)?
        .ok_or_else(|| "jev: no TypeSafe key configured".to_string())?;

    let timeout = std::time::Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(250, MAX_TIMEOUT_MS),
    );

    let body = serde_json::json!({
        "state": state,
        "model": model.as_deref().unwrap_or(JEV_DEFAULT_MODEL),
        "questions": questions,
    });

    let body = body.to_string();
    // One retry on transient statuses / transport errors — mirrors the JS
    // client's retry-once contract (src/lib/jev/jevClient.ts). 401/403 and
    // timeouts are definitive: no retry.
    let mut last_err = String::new();
    for attempt in 0..=1 {
        let result = shared_http_client()
            .post(JEV_ENDPOINT)
            .timeout(timeout)
            .header("Authorization", format!("Bearer {}", key))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(body.clone())
            .send();

        let response = match result {
            Ok(r) => r,
            Err(e) => {
                if e.is_timeout() {
                    return Err("jev: request timed out".to_string());
                }
                if attempt == 1 {
                    return Err(format!("jev: request failed — {}", e));
                }
                last_err = format!("jev: request failed — {}", e);
                std::thread::sleep(RETRY_DELAY);
                continue;
            }
        };

        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .map_err(|e| format!("jev: response read failed — {}", e))?;
        if bytes.len() > MAX_BODY_BYTES {
            return Err(format!("jev: response too large ({} bytes)", bytes.len()));
        }

        if status == 401 || status == 403 {
            return Err(format!("jev: authentication failed (HTTP {})", status));
        }
        if !(200..300).contains(&status) {
            if RETRYABLE_STATUSES.contains(&status) && attempt == 0 {
                std::thread::sleep(RETRY_DELAY);
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            return Err(format!(
                "jev: HTTP {}{}{}",
                status,
                if text.is_empty() { "" } else { " — " },
                text.chars().take(200).collect::<String>()
            ));
        }

        return serde_json::from_slice(&bytes)
            .map_err(|e| format!("jev: malformed response ({})", e));
    }
    Err(last_err)
}
