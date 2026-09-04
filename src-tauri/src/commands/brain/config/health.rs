//! `brain_fetch_health` and the `cerveau-health` meta-tag parsing it depends
//! on.

use std::fs;

use crate::state::ProjectState;
use crate::commands::brain::sidecar::brain_path_from_project;

/// Parse the current project's brain `_index.html` and extract the
/// `<meta name="cerveau-health" content="...">` tag to build a health summary.
///
/// The brain engine's `health-score` subcommand writes this meta (see
/// `writeHealthMeta` in the vendored lazybrain.js) — NOT `graph` or
/// `index-rebuild`, which never touch it. `brain_rebuild_graph` runs
/// `health-score` as its third step specifically so this stays fresh.
///
/// Filename note: the vendored CLI's brain-root overview page is
/// `_index.html` (underscore-prefixed — see `runBuildIndex`/`writeHealthMeta`
/// in lazybrain.js; confirmed no code anywhere writes a bare `index.html` at
/// the brain root, that name is only used by unrelated static-file-server
/// directory-index fallbacks and the `publish` command's separate export
/// directory). Reading the wrong filename here previously made this command
/// always return `{"score": 0}` regardless of how often health-score ran.
///
/// If the meta is absent (older brain, health-score never run yet) the
/// command returns a zero-score object rather than an error — callers should
/// treat missing fields as unknown.
///
/// Thin wrapper around `brain_fetch_health_inner` (mirrors the
/// `get_brain_info` / `get_brain_info_inner` split above) so the actual
/// meta-tag extraction/parsing is unit-testable against a `TempDir`-backed
/// `_index.html` instead of a live `tauri::State`.
#[tauri::command]
pub(crate) fn brain_fetch_health(
    project_state: tauri::State<ProjectState>,
) -> Result<serde_json::Value, String> {
    let brain_path = brain_path_from_project(&project_state);
    brain_fetch_health_inner(&brain_path)
}

/// Pure core of `brain_fetch_health` — see its doc comment for the overall
/// contract. Takes the already-resolved brain path directly.
///
/// Real filesystem errors reading an EXISTING `_index.html` (permissions, a
/// TOCTOU race where the file is removed between the `exists()` check and
/// the read, ...) still propagate as `Err`. Only a genuinely missing file, a
/// missing/malformed `cerveau-health` meta tag fall back to the zero-score
/// default — matching this function's documented "never break the brain UI
/// over a health-reporting problem" contract.
pub(crate) fn brain_fetch_health_inner(brain_path: &str) -> Result<serde_json::Value, String> {
    let index_path = std::path::Path::new(brain_path).join("_index.html");

    if !index_path.exists() {
        return Ok(serde_json::json!({ "score": 0 }));
    }

    let html = fs::read_to_string(&index_path)
        .map_err(|e| format!("brain_fetch_health: read _index.html failed: {}", e))?;

    let result = match extract_cerveau_health_content(&html) {
        Some(content) => parse_cerveau_health_content(content),
        None => serde_json::json!({ "score": 0 }),
    };
    Ok(result)
}

/// Extract the raw (still HTML-entity-escaped) `content="..."` attribute
/// value of the `<meta name="cerveau-health" ...>` tag from `html`, or
/// `None` if the tag — or its `content` attribute — is not present.
///
/// Simple substring search rather than a real HTML parser: `_index.html` is
/// small and the tag is always written by `writeHealthMeta` in a fixed
/// `<meta name="cerveau-health" content="...">` shape (see
/// engine/src/commands/health-score.ts), so a linear scan is sufficient and
/// avoids pulling in an HTML-parsing dependency for one attribute.
fn extract_cerveau_health_content(html: &str) -> Option<&str> {
    let start = html.find("name=\"cerveau-health\"")?;
    let after = &html[start..];
    let c_start = after.find("content=\"")?;
    let content_begin = c_start + 9; // skip content="
    let c_end = after[content_begin..].find('"')?;
    Some(&after[content_begin..content_begin + c_end])
}

/// Decode the handful of HTML entities that can appear inside the
/// `cerveau-health` meta tag's `content` attribute. `&quot;` is what the
/// engine actually emits today — `writeHealthMeta` escapes the embedded
/// JSON's double quotes via `JSON.stringify(result).replace(/"/g, '&quot;')`
/// (see engine/src/commands/health-score.ts); `&lt;`/`&gt;`/`&amp;` are
/// decoded too for robustness against any other HTML-escaped producer (e.g.
/// a hand-edited file). `&amp;` is decoded LAST so an already-escaped
/// ampersand (a literal `&amp;quot;` in the source, meaning the text
/// "&quot;", not a quote) is not corrupted by a second round of unescaping.
fn html_unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Parse the (still HTML-escaped) `content` attribute of a `cerveau-health`
/// meta tag into the `BrainHealth` JSON shape the frontend expects — score
/// (0-100) plus orphans/brokenLinks/stale/dupes (see the `BrainHealth`
/// interface in src/lib/platform/types.ts).
///
/// Two content shapes are accepted, matching everything `writeHealthMeta`
/// (current and historical) can produce:
///   - a JSON OBJECT, HTML-attribute-escaped (current format):
///     `{&quot;score&quot;:75,&quot;orphans&quot;:3,...}`. Unescaped, then
///     parsed, then score/orphans/brokenLinks/stale/dupes are read from it —
///     fields absent from the JSON stay absent from the result rather than
///     being synthesized (matches the pre-existing "unknown, not zero"
///     contract for a partial object).
///   - a bare JSON NUMBER (legacy format — content was historically just
///     `content="<score>"`, no escaping involved): used directly as the
///     score; the other four metrics are not knowable from a bare number so
///     they are reported as 0 rather than omitted, keeping the result shape
///     stable for the frontend (whose `BrainHealth` type declares every
///     field as a required, never-optional, number).
///
/// Anything else (malformed JSON, an array, a string, null, ...) falls back
/// to the same zero-score default `brain_fetch_health_inner` already returns
/// when the tag or file is absent entirely — never panics, never errors.
fn parse_cerveau_health_content(raw_content: &str) -> serde_json::Value {
    let unescaped = html_unescape(raw_content);

    let parsed: serde_json::Value = match serde_json::from_str(&unescaped) {
        Ok(v) => v,
        Err(_) => return serde_json::json!({ "score": 0 }),
    };

    if parsed.is_object() {
        let score = parsed.get("score").and_then(|s| s.as_f64()).unwrap_or(0.0);
        let mut result = serde_json::json!({ "score": score });
        if let Some(o) = parsed.get("orphans").and_then(|o| o.as_u64()) {
            result["orphans"] = serde_json::json!(o);
        }
        if let Some(b) = parsed.get("brokenLinks").and_then(|b| b.as_u64()) {
            result["brokenLinks"] = serde_json::json!(b);
        }
        if let Some(s) = parsed.get("stale").and_then(|s| s.as_u64()) {
            result["stale"] = serde_json::json!(s);
        }
        if let Some(d) = parsed.get("dupes").and_then(|d| d.as_u64()) {
            result["dupes"] = serde_json::json!(d);
        }
        // TASK 3 (Settings > Memory legibility): denominators for the
        // proportion UI ("3047 of 53268 links"). Absent on an older cached
        // _index.html (health-score run before these fields existed) —
        // stays absent rather than 0, same "unknown, not zero" contract as
        // orphans/brokenLinks/stale/dupes above; the frontend degrades to a
        // bare count when these are missing (see BrainHealth's doc comment,
        // src/lib/platform/types.ts).
        if let Some(n) = parsed.get("totalNotes").and_then(|n| n.as_u64()) {
            result["totalNotes"] = serde_json::json!(n);
        }
        if let Some(l) = parsed.get("totalLinks").and_then(|l| l.as_u64()) {
            result["totalLinks"] = serde_json::json!(l);
        }
        return result;
    }

    if let Some(n) = parsed.as_f64() {
        // Legacy bare-number content: the whole value IS the score.
        return serde_json::json!({
            "score": n,
            "orphans": 0,
            "brokenLinks": 0,
            "stale": 0,
            "dupes": 0,
        });
    }

    serde_json::json!({ "score": 0 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ── brain_fetch_health / cerveau-health meta parsing ──────────────────
    // BUG FIX regression coverage: the meta content is HTML-attribute-escaped
    // JSON (`&quot;` in place of `"`) and must be unescaped before parsing;
    // a bare-number legacy content must be read as the score directly
    // instead of silently falling through `Value::get` on a non-object.

    #[test]
    fn html_unescape_decodes_quot_amp_lt_gt() {
        assert_eq!(html_unescape("&quot;score&quot;"), "\"score\"");
        assert_eq!(html_unescape("a &amp; b"), "a & b");
        assert_eq!(html_unescape("&lt;tag&gt;"), "<tag>");
        // &amp; decoded LAST: an already-escaped ampersand followed by
        // literal text "quot;" must not be corrupted into a quote.
        assert_eq!(html_unescape("&amp;quot;"), "&quot;");
        eprintln!("html_unescape_decodes_quot_amp_lt_gt PASSED");
    }

    #[test]
    fn parse_cerveau_health_content_escaped_json_object() {
        // Exact shape writeHealthMeta emits (engine/src/commands/health-score.ts).
        let content = "{&quot;score&quot;:75,&quot;orphans&quot;:3,&quot;brokenLinks&quot;:0,&quot;stale&quot;:0,&quot;dupes&quot;:0}";
        let result = parse_cerveau_health_content(content);
        assert_eq!(result.get("score").and_then(|v| v.as_f64()), Some(75.0));
        assert_eq!(result.get("orphans").and_then(|v| v.as_u64()), Some(3));
        assert_eq!(result.get("brokenLinks").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(result.get("stale").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(result.get("dupes").and_then(|v| v.as_u64()), Some(0));
        eprintln!("parse_cerveau_health_content_escaped_json_object PASSED (score=75)");
    }

    #[test]
    fn parse_cerveau_health_content_reads_total_notes_and_links_when_present() {
        // Exact shape writeHealthMeta emits once health-score.ts populates
        // totalNotes/totalLinks (TASK 3 — proportion denominators).
        let content = "{&quot;score&quot;:70,&quot;orphans&quot;:14,&quot;brokenLinks&quot;:3047,&quot;stale&quot;:2,&quot;dupes&quot;:2990,&quot;totalNotes&quot;:7531,&quot;totalLinks&quot;:53268}";
        let result = parse_cerveau_health_content(content);
        assert_eq!(result.get("totalNotes").and_then(|v| v.as_u64()), Some(7531));
        assert_eq!(result.get("totalLinks").and_then(|v| v.as_u64()), Some(53268));
        eprintln!("parse_cerveau_health_content_reads_total_notes_and_links_when_present PASSED");
    }

    #[test]
    fn parse_cerveau_health_content_escaped_object_partial_fields_stay_absent() {
        // Only score present — orphans/brokenLinks/stale/dupes absent from
        // the JSON must stay absent from the result (unknown, not zero).
        let content = "{&quot;score&quot;:42}";
        let result = parse_cerveau_health_content(content);
        assert_eq!(result.get("score").and_then(|v| v.as_f64()), Some(42.0));
        assert!(result.get("orphans").is_none());
        assert!(result.get("brokenLinks").is_none());
        assert!(result.get("stale").is_none());
        assert!(result.get("dupes").is_none());
        eprintln!("parse_cerveau_health_content_escaped_object_partial_fields_stay_absent PASSED");
    }

    #[test]
    fn parse_cerveau_health_content_legacy_bare_number() {
        // Pre-JSON-object format: content is just the score, unescaped.
        let result = parse_cerveau_health_content("87");
        assert_eq!(result.get("score").and_then(|v| v.as_f64()), Some(87.0));
        // Unknown metrics are reported as 0, not omitted — keeps the shape
        // stable for the frontend's BrainHealth type (every field required).
        assert_eq!(result.get("orphans").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(result.get("brokenLinks").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(result.get("stale").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(result.get("dupes").and_then(|v| v.as_u64()), Some(0));
        eprintln!("parse_cerveau_health_content_legacy_bare_number PASSED (score=87)");
    }

    #[test]
    fn parse_cerveau_health_content_legacy_bare_number_decimal() {
        let result = parse_cerveau_health_content("42.5");
        assert_eq!(result.get("score").and_then(|v| v.as_f64()), Some(42.5));
        eprintln!("parse_cerveau_health_content_legacy_bare_number_decimal PASSED");
    }

    #[test]
    fn parse_cerveau_health_content_malformed_falls_back_to_zero_score() {
        for garbage in ["not json at all{{{", "", "[1,2,3]", "null", "true", "\"just a string\""] {
            let result = parse_cerveau_health_content(garbage);
            assert_eq!(
                result.get("score").and_then(|v| v.as_f64()),
                Some(0.0),
                "garbage content {:?} must fall back to score 0, got {:?}",
                garbage,
                result
            );
        }
        eprintln!("parse_cerveau_health_content_malformed_falls_back_to_zero_score PASSED");
    }

    #[test]
    fn extract_cerveau_health_content_finds_tag_content() {
        let html = "<!DOCTYPE html><html><head><meta name=\"cerveau-health\" content=\"{&quot;score&quot;:50}\"></head></html>";
        assert_eq!(
            extract_cerveau_health_content(html),
            Some("{&quot;score&quot;:50}")
        );
        eprintln!("extract_cerveau_health_content_finds_tag_content PASSED");
    }

    #[test]
    fn extract_cerveau_health_content_none_when_tag_absent() {
        let html = "<!DOCTYPE html><html><head></head><body></body></html>";
        assert_eq!(extract_cerveau_health_content(html), None);
        eprintln!("extract_cerveau_health_content_none_when_tag_absent PASSED");
    }

    /// The real-world fixture: the engine writes
    /// `content="{&quot;score&quot;:...}"` (HTML-attribute-escaped JSON) —
    /// prove `brain_fetch_health_inner` decodes it end to end from a real
    /// `_index.html` on disk and returns score 75, not 0.
    #[test]
    fn brain_fetch_health_inner_parses_escaped_json_object_from_real_file() {
        let tmp = TempDir::new().expect("TempDir::new");
        let html = "<!DOCTYPE html><html><head><meta name=\"cerveau-health\" content=\"{&quot;score&quot;:75,&quot;orphans&quot;:3,&quot;brokenLinks&quot;:0,&quot;stale&quot;:0,&quot;dupes&quot;:0}\"></head><body></body></html>";
        std::fs::write(tmp.path().join("_index.html"), html).expect("write _index.html");

        let result = brain_fetch_health_inner(tmp.path().to_str().unwrap())
            .expect("brain_fetch_health_inner must succeed for a real file");

        assert_eq!(result.get("score").and_then(|v| v.as_f64()), Some(75.0));
        assert_eq!(result.get("orphans").and_then(|v| v.as_u64()), Some(3));
        assert_eq!(result.get("brokenLinks").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(result.get("stale").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(result.get("dupes").and_then(|v| v.as_u64()), Some(0));
        eprintln!("brain_fetch_health_inner_parses_escaped_json_object_from_real_file PASSED (score=75)");
    }

    #[test]
    fn brain_fetch_health_inner_parses_legacy_bare_number_from_real_file() {
        let tmp = TempDir::new().expect("TempDir::new");
        let html = "<!DOCTYPE html><html><head><meta name=\"cerveau-health\" content=\"42\"></head><body></body></html>";
        std::fs::write(tmp.path().join("_index.html"), html).expect("write _index.html");

        let result = brain_fetch_health_inner(tmp.path().to_str().unwrap())
            .expect("brain_fetch_health_inner must succeed for a real file");

        assert_eq!(result.get("score").and_then(|v| v.as_f64()), Some(42.0));
        assert_eq!(result.get("orphans").and_then(|v| v.as_u64()), Some(0));
        eprintln!("brain_fetch_health_inner_parses_legacy_bare_number_from_real_file PASSED (score=42)");
    }

    #[test]
    fn brain_fetch_health_inner_defaults_to_zero_when_meta_tag_absent() {
        let tmp = TempDir::new().expect("TempDir::new");
        std::fs::write(
            tmp.path().join("_index.html"),
            "<!DOCTYPE html><html><head></head><body></body></html>",
        )
        .expect("write _index.html");

        let result = brain_fetch_health_inner(tmp.path().to_str().unwrap())
            .expect("must succeed even without the meta tag");

        assert_eq!(result.get("score").and_then(|v| v.as_f64()), Some(0.0));
        assert!(result.get("orphans").is_none(), "unset metrics must stay absent, not synthesized");
        eprintln!("brain_fetch_health_inner_defaults_to_zero_when_meta_tag_absent PASSED");
    }

    #[test]
    fn brain_fetch_health_inner_defaults_to_zero_when_index_html_missing() {
        let tmp = TempDir::new().expect("TempDir::new");
        // No _index.html written at all.
        let result = brain_fetch_health_inner(tmp.path().to_str().unwrap())
            .expect("must succeed even without _index.html");
        assert_eq!(result.get("score").and_then(|v| v.as_f64()), Some(0.0));
        eprintln!("brain_fetch_health_inner_defaults_to_zero_when_index_html_missing PASSED");
    }

    #[test]
    fn brain_fetch_health_inner_defaults_to_zero_when_meta_content_malformed() {
        let tmp = TempDir::new().expect("TempDir::new");
        let html = "<!DOCTYPE html><html><head><meta name=\"cerveau-health\" content=\"not-json-at-all\"></head><body></body></html>";
        std::fs::write(tmp.path().join("_index.html"), html).expect("write _index.html");

        let result = brain_fetch_health_inner(tmp.path().to_str().unwrap())
            .expect("malformed content must not error, only default");

        assert_eq!(result.get("score").and_then(|v| v.as_f64()), Some(0.0));
        eprintln!("brain_fetch_health_inner_defaults_to_zero_when_meta_content_malformed PASSED");
    }
}
