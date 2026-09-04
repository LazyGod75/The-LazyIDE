//! Multi-tenant brain routing (T0.7 glue for T0.8's engine registry).
//!
//! The sidecar is a SINGLE process serving N brains (spec section 5.2,
//! `engine/src/server/brain-registry.ts`, commit 6dfc281): `POST /brains/open
//! { brainPath }` registers/re-attaches a brain and returns a `brainId`; every
//! data route below then accepts an optional `?brainId=` to pick which brain
//! answers, an absent id keeping today's single-brain behavior unchanged.
//! `active_brain_query_suffix` is the one place that decides which brain a
//! `brain_fetch_*` proxy call should target; everything else just appends its
//! return value to the URL it was already building.

use serde::Deserialize;
use tauri::Manager;

use crate::state::ProjectRegistry;
use crate::commands::brain::config::resolve_unified_brain_path;
use crate::commands::brain::sidecar::state::{BrainState, brain_port_and_token, http_client};

#[derive(Debug, Deserialize)]
struct BrainOpenResponse {
    #[serde(rename = "brainId")]
    brain_id: String,
}

/// `POST /brains/open { brainPath }` on the running multi-tenant sidecar and
/// return the `brainId` it assigns (idempotent on the engine side — opening
/// the same normalized path twice returns the same id, see
/// `engine/src/server/brain-registry.ts`'s `openBrain`).
///
/// Best-effort by contract: every caller treats `Err` as "not registered
/// yet, fall back to the sidecar's default brain" rather than a hard
/// failure — the sidecar may simply not be up yet (e.g. right after app
/// boot, before the background startup thread in lib.rs finishes) or may
/// have just been restarted, forgetting every previously-registered brain
/// (see `RegistryInner::clear_all_brain_ids`). `active_brain_query_suffix`
/// retries this lazily on the next `brain_fetch_*` call either way.
pub(crate) fn brain_open_on_sidecar(port: u16, token: &str, brain_path: &str) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{}/brains/open", port);
    let resp = http_client()
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "brainPath": brain_path }))
        .send()
        .map_err(|e| format!("brain_open_on_sidecar: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("brain_open_on_sidecar: sidecar returned status {}", resp.status()));
    }
    let body: BrainOpenResponse = resp
        .json()
        .map_err(|e| format!("brain_open_on_sidecar: response parse failed: {}", e))?;
    Ok(body.brain_id)
}

/// Pure formatting core of `active_brain_query_suffix`: given an already-
/// resolved brain id (or none) and whether the target URL already carries a
/// query string, build the exact suffix to append. Split out so the
/// `?`-vs-`&` joiner logic is unit-testable without a `tauri::AppHandle`.
fn format_brain_id_suffix(brain_id: Option<&str>, url_has_query: bool) -> String {
    match brain_id {
        Some(id) => format!(
            "{}brainId={}",
            if url_has_query { "&" } else { "?" },
            urlencoding::encode(id)
        ),
        None => String::new(),
    }
}

/// Build the query-string suffix (`""`, `"?brainId=<id>"`, or
/// `"&brainId=<id>"`) that routes a `brain_fetch_*` proxy request to the
/// ACTIVE project's brain. Empty when there is no active project (registry
/// untouched / nothing registered yet): every `brain_fetch_*` call then
/// falls through to the sidecar's default env-configured brain, i.e.
/// today's pre-multi-project behavior, byte-for-byte unchanged.
///
/// Lazily resolves + remembers the active project's brain id on first use:
/// if the active `ProjectRegistry` entry has no `brain_id` yet (e.g. it was
/// registered before the sidecar had finished starting, so
/// `project_register`'s own `/brains/open` attempt silently failed — see
/// that command's doc comment in commands/brain/config.rs), this retries the
/// same call once here rather than letting every subsequent fetch silently
/// answer from the wrong (default) brain.
pub(crate) fn active_brain_query_suffix(app: &tauri::AppHandle, url_has_query: bool) -> String {
    let registry = app.state::<ProjectRegistry>();

    let (active_id, active_root, existing_brain_id) = {
        let guard = match registry.0.lock() {
            Ok(g) => g,
            Err(e) => {
                log::warn!("active_brain_query_suffix: registry lock failed: {}", e);
                return String::new();
            }
        };
        match guard.active_entry() {
            Some(entry) => (entry.id.clone(), entry.root.clone(), entry.brain_id.clone()),
            None => return String::new(),
        }
    };

    let brain_id = existing_brain_id.or_else(|| {
        let brain_state = app.state::<BrainState>();
        let (port, token) = brain_port_and_token(&brain_state);
        let brain_path = resolve_unified_brain_path(Some(&active_root));
        match brain_open_on_sidecar(port, &token, &brain_path) {
            Ok(id) => {
                if let Ok(mut guard) = registry.0.lock() {
                    guard.set_brain_id(&active_id, id.clone());
                }
                Some(id)
            }
            Err(e) => {
                log::debug!("active_brain_query_suffix: lazy /brains/open retry failed: {}", e);
                None
            }
        }
    });

    format_brain_id_suffix(brain_id.as_deref(), url_has_query)
}

#[cfg(test)]
mod tests {
    // ── Multi-tenant brain routing (T0.7) ───────────────────────────────

    /// No brain id resolved (no active project, or lazy /brains/open retry
    /// failed) must produce an empty suffix — the byte-for-byte "fall
    /// through to the sidecar's default brain" compat contract.
    #[test]
    fn format_brain_id_suffix_is_empty_when_no_brain_id() {
        assert_eq!(super::format_brain_id_suffix(None, false), "");
        assert_eq!(super::format_brain_id_suffix(None, true), "");
        eprintln!("format_brain_id_suffix_is_empty_when_no_brain_id PASSED");
    }

    /// A URL with no existing query string gets a leading `?`.
    #[test]
    fn format_brain_id_suffix_uses_question_mark_when_url_has_no_query_yet() {
        assert_eq!(super::format_brain_id_suffix(Some("abc123"), false), "?brainId=abc123");
        eprintln!("format_brain_id_suffix_uses_question_mark_when_url_has_no_query_yet PASSED");
    }

    /// A URL that already has a query string (e.g. brain_fetch_search's
    /// `?q=...&top=...`) gets `&`, never a second `?`.
    #[test]
    fn format_brain_id_suffix_uses_ampersand_when_url_already_has_a_query() {
        assert_eq!(super::format_brain_id_suffix(Some("abc123"), true), "&brainId=abc123");
        eprintln!("format_brain_id_suffix_uses_ampersand_when_url_already_has_a_query PASSED");
    }

    /// The brain id is percent-encoded like every other id this file
    /// forwards into a URL (see brain_fetch_note_meta/backlinks/neighbors) —
    /// defense in depth even though the engine's own ids are plain hex.
    #[test]
    fn format_brain_id_suffix_percent_encodes_the_brain_id() {
        let suffix = super::format_brain_id_suffix(Some("has space"), false);
        assert_eq!(suffix, "?brainId=has%20space");
        eprintln!("format_brain_id_suffix_percent_encodes_the_brain_id PASSED");
    }

    /// `POST /brains/open`'s real response shape (see
    /// `engine/src/server/routes/brains.ts`'s `handleOpenBrain`:
    /// `sendJson(res, 200, { brainId })`) must deserialize into
    /// `BrainOpenResponse` — proven directly against a literal JSON string so
    /// this stays correct without spinning up a real sidecar.
    #[test]
    fn brain_open_response_deserializes_the_engines_actual_shape() {
        let parsed: super::BrainOpenResponse =
            serde_json::from_str(r#"{"brainId":"abcdef0123456789"}"#).expect("must parse the engine's real response shape");
        assert_eq!(parsed.brain_id, "abcdef0123456789");
        eprintln!("brain_open_response_deserializes_the_engines_actual_shape PASSED");
    }
}
