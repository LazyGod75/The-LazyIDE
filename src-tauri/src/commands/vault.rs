//! vault.rs — OS-native credential vault (Windows Credential Manager /
//! macOS Keychain / Linux Secret Service) via the `keyring` crate.
//!
//! Audit 2026-08-12 found two plaintext-secret leaks: BYOK API keys in the
//! webview's localStorage (a plain SQLite file in the user profile —
//! readable by any process running as that user) and the GitHub OAuth token
//! in `<app_local_data_dir>/lazy/teams/github.json` (plain JSON on disk).
//! This module is the fix for both: a narrow, generic key/value vault
//! backed by the platform credential store, so a secret is encrypted at
//! rest by the OS instead of sitting in a file this app wrote itself.
//!
//! `keyring` (not `tauri-plugin-stronghold`) was chosen deliberately: no
//! extra vault password for the user to manage, and it wraps exactly the
//! platform-native secure-storage API each OS already provides — the same
//! store Windows Credential Manager / Keychain Access / Seahorse expose to
//! the user directly, rather than an app-specific encrypted file the user
//! has no visibility into.
//!
//! Command surface is deliberately narrow and asymmetric:
//!   - `secret_set` / `secret_delete` — write-only, no return of secret data.
//!   - `secret_get` — returns the RAW value. Only for callers that need the
//!     value to do something with it (e.g. put it in an Authorization
//!     header). See byokProviders.ts / vaultClient.ts on the frontend for
//!     the documented list of legitimate raw-value call sites.
//!   - `secret_presence` — returns `{ present, hint }` where `hint` is a
//!     masked tail (e.g. "****…bc1f"), never the full value. This is what
//!     any "is a key configured?" UI check should call.
//!
//! Every error path below formats only the *type* of failure (a keyring
//! `Error` variant's Display, e.g. "no matching entry found") — never the
//! `key` argument's value, and the `value` argument is never placed in any
//! Result::Err, log::*, or Debug output anywhere in this file.

use keyring::Entry;
use serde::Serialize;

/// Keychain "service" — scopes every entry this app creates so it can't
/// collide with an unrelated application's entries in the same OS store.
/// Matches `tauri.conf.json`'s `identifier`.
const SERVICE: &str = "com.lazy.app";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("vault: could not open entry: {}", e))
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretPresence {
    pub present: bool,
    pub hint: Option<String>,
}

/// Masks a secret down to a short, non-reversible display hint: 4 leading
/// stars + the last 4 characters (or all-stars for very short secrets).
/// Never returns enough of the value to reconstruct it.
fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 4 {
        "*".repeat(chars.len())
    } else {
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("****\u{2026}{}", tail) // "****…abcd"
    }
}

// ── Internal vault API (shared with github_oauth.rs's token migration —
//    kept non-command so it can be called directly from Rust, not only via
//    Tauri IPC) ─────────────────────────────────────────────────────────

pub(crate) fn vault_set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("vault: write failed: {}", e))
}

pub(crate) fn vault_get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("vault: read failed: {}", e)),
    }
}

pub(crate) fn vault_delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("vault: delete failed: {}", e)),
    }
}

// ── Tauri commands ───────────────────────────────────────────────────

/// Store `value` under `key` in the OS credential vault. Overwrites any
/// existing entry for the same key.
#[tauri::command]
pub(crate) fn secret_set(key: String, value: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("secret_set: key is empty".to_string());
    }
    vault_set(&key, &value)
}

/// Retrieve the RAW secret for `key`, or `None` if nothing is stored.
/// Callers must only use this when they need the actual value (e.g. to
/// authenticate an HTTP request) — anything that just needs to know
/// whether a key is configured should call `secret_presence` instead.
#[tauri::command]
pub(crate) fn secret_get(key: String) -> Result<Option<String>, String> {
    if key.trim().is_empty() {
        return Err("secret_get: key is empty".to_string());
    }
    vault_get(&key)
}

/// Masked presence check: never returns enough of the secret to
/// reconstruct it. Use this to populate a settings UI's "is a key set"
/// indicator instead of `secret_get`.
#[tauri::command]
pub(crate) fn secret_presence(key: String) -> Result<SecretPresence, String> {
    if key.trim().is_empty() {
        return Err("secret_presence: key is empty".to_string());
    }
    match vault_get(&key)? {
        Some(v) => Ok(SecretPresence {
            present: true,
            hint: Some(mask(&v)),
        }),
        None => Ok(SecretPresence {
            present: false,
            hint: None,
        }),
    }
}

/// Remove the stored secret for `key`, if any. A no-op (not an error) when
/// nothing was stored.
#[tauri::command]
pub(crate) fn secret_delete(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("secret_delete: key is empty".to_string());
    }
    vault_delete(&key)
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Runs against the REAL platform backend (Windows Credential Manager
    /// on this box) — deliberately NOT `keyring::mock`. The mock builder
    /// creates a brand-new, unpersisted `MockCredential` on every
    /// `Entry::new()` call (see its own doc comment: "no persistence other
    /// than in the entry itself"), so it cannot exercise a set-then-get
    /// round trip across two separate `entry(key)` calls the way
    /// `vault_set`/`vault_get`/`secret_presence` actually do in production.
    /// The real backend persists by (service, user) regardless of which
    /// `Entry` object asks — exactly what this module needs verified.
    /// Every test below uses a random, uniquely-suffixed key and cleans up
    /// (via `CleanupGuard`) so no residue is left in the real credential
    /// store, even if an assertion panics mid-test.
    struct CleanupGuard(String);
    impl Drop for CleanupGuard {
        fn drop(&mut self) {
            let _ = vault_delete(&self.0);
        }
    }

    fn unique_key(prefix: &str) -> String {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        format!("test.vault.{}.{}.{}", prefix, std::process::id(), n)
    }

    #[test]
    fn set_then_get_round_trips_the_value() {
        let key = unique_key("roundtrip");
        let _cleanup = CleanupGuard(key.clone());
        vault_set(&key, "sk-super-secret").unwrap();
        assert_eq!(vault_get(&key).unwrap(), Some("sk-super-secret".to_string()));
    }

    #[test]
    fn get_on_missing_key_returns_none_not_error() {
        let key = unique_key("missing");
        assert_eq!(vault_get(&key).unwrap(), None);
    }

    #[test]
    fn delete_removes_the_value() {
        let key = unique_key("delete");
        vault_set(&key, "sk-to-delete").unwrap();
        vault_delete(&key).unwrap();
        assert_eq!(vault_get(&key).unwrap(), None);
    }

    #[test]
    fn delete_on_missing_key_is_a_silent_noop() {
        let key = unique_key("delete-noop");
        // No prior set_password — must not error.
        vault_delete(&key).unwrap();
    }

    #[test]
    fn presence_reports_true_with_masked_hint_when_set() {
        let key = unique_key("presence-set");
        let _cleanup = CleanupGuard(key.clone());
        vault_set(&key, "sk-ant-abcdefgh1234").unwrap();
        let presence = secret_presence(key).unwrap();
        assert!(presence.present);
        let hint = presence.hint.expect("hint must be present when set");
        // The masked hint must show the value's last 4 chars as a
        // recognizability aid, but must NEVER equal or contain the full
        // secret, and must not leak the raw prefix.
        assert!(hint.ends_with("1234"));
        assert_ne!(hint, "sk-ant-abcdefgh1234");
        assert!(!hint.contains("abcdefgh"));
    }

    #[test]
    fn presence_reports_false_with_no_hint_when_unset() {
        let key = unique_key("presence-unset");
        let presence = secret_presence(key).unwrap();
        assert_eq!(
            presence,
            SecretPresence {
                present: false,
                hint: None
            }
        );
    }

    #[test]
    fn presence_never_returns_the_full_secret_to_a_presence_only_caller() {
        // This is the exact contract the audit asked for: a caller that
        // only invokes secret_presence (not secret_get) can never observe
        // the raw value, under any length of secret.
        for secret in ["ab", "sk-1234567890abcdef", "x"] {
            let key = unique_key("presence-safety");
            let _cleanup = CleanupGuard(key.clone());
            vault_set(&key, secret).unwrap();
            let presence = secret_presence(key).unwrap();
            let hint = presence.hint.unwrap_or_default();
            assert_ne!(hint, secret, "presence hint must never equal the raw secret");
            assert!(
                hint.len() < secret.len() || secret.len() <= 4,
                "masked hint must not be as long as (i.e. must not fully encode) a secret longer than 4 chars"
            );
        }
    }

    #[test]
    fn mask_never_reveals_more_than_the_last_four_characters() {
        assert_eq!(mask(""), "");
        assert_eq!(mask("ab"), "**");
        assert_eq!(mask("abcd"), "****");
        assert_eq!(mask("abcde"), "****\u{2026}bcde");
        assert_eq!(mask("sk-ant-api03-abcdef1234"), "****\u{2026}1234");
    }
}
