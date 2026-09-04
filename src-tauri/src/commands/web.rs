//! Web search and fetch Tauri commands for the managed agent.
//!
//! `web_fetch` — fetches a URL, cleans the HTML (removes scripts/styles/nav
//! noise but PRESERVES structural HTML: headings, links, code blocks, articles,
//! data-* attributes), returns clean HTML compatible with the LazyBrain
//! which stores notes as HTML with data-cerveau-* attributes.
//! Inspired by mistral-vibe's web_fetch tool: proper User-Agent, Cloudflare
//! bot-detection retry, URL normalization, configurable timeout, content
//! truncation with notice.
//!
//! `web_search` — searches the web via DuckDuckGo's HTML endpoint, parses
//! results (title + URL + snippet), returns structured JSON. No API key
//! required — works out of the box.
//!
//! Memory hardening: both commands cap the raw response body at
//! HARD_CAP_BYTES regardless of Content-Length (which can lie or be
//! absent), reject EXPLICITLY non-textual content types before decoding
//! (a missing/unparseable Content-Type header defaults to text/plain —
//! see `resolve_content_type`), bound clean_html's input independent of
//! the requested max_chars, and share one lazily-initialized HTTP client +
//! a small concurrency guard instead of building a fresh client and
//! running unbounded in parallel per call.

use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::sync::OnceLock;

use serde::Serialize;

use crate::commands::util::{truncate_on_char_boundary, BoundedGate};

const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const HONEST_USER_AGENT: &str = "LazyIDE/1.0";

/// Ceiling for the model-facing content returned after cleaning —
/// toolRegistry.ts's web_fetch description promises the model "max 120000".
const MAX_CONTENT_BYTES: usize = 120_000;
/// Floor for the model-facing content — a caller-supplied max_chars below
/// this would return a near-useless sliver.
const MIN_CONTENT_CHARS: usize = 500;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 120;

/// Hard cap on raw response body bytes read off the wire, applied
/// regardless of what Content-Length claims (it can lie, or be absent
/// under chunked transfer-encoding). Shared by web_fetch and web_search's
/// DDG page fetch.
const HARD_CAP_BYTES: u64 = 5 * 1024 * 1024; // 5 MB

/// Cap on the raw (pre-clean) HTML handed to clean_html's ~38 sequential
/// full-buffer regex passes, so the cleaning pipeline's cost is bounded
/// independent of both HARD_CAP_BYTES and the caller's requested max_chars.
const PRE_CLEAN_CAP_BYTES: usize = 2 * 1024 * 1024; // 2 MB

// ── SSRF guard ──────────────────────────────────────────────────────
//
// web_fetch/web_search are exposed to an agentic model, which can be
// prompt-injected into requesting an attacker-chosen URL (or redirected to
// one by a compromised/malicious server). Without this guard the shared
// blocking client would happily reach into the local network or the cloud
// metadata endpoint (169.254.169.254) from the desktop process. Enforced
// both before the initial request (`host_is_blocked` call sites in
// web_fetch/web_search) and on every redirect hop (the client's
// `redirect::Policy::custom` below), since a first hop to a public host
// can still redirect to a private one.
//
// No `url` crate dependency exists in this crate's Cargo.toml today (it is
// only a transitive dependency of reqwest, which is not usable from here
// without adding it explicitly) — per the task's preference to avoid a new
// dependency when avoidable, host/scheme extraction below is done with
// manual authority parsing (`url_host_and_default_port`), shared by both
// the pre-send check and the redirect closure (fed via `Url::as_str()`).

/// Returns true if `ip` falls in a range web_fetch/web_search must never
/// reach: loopback, RFC1918 private space, link-local (which covers the
/// cloud-metadata endpoint 169.254.169.254), unspecified, broadcast,
/// multicast, shared/CGNAT space, IETF benchmarking space, documentation
/// ranges, and the IETF protocol-assignments block. IPv6 loopback,
/// unspecified, unique-local, link-local, multicast, and IPv4-mapped/
/// compatible addresses whose embedded IPv4 is itself blocked.
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

/// IPv4 half of `is_blocked_ip`. Uses std's classifiers where they exist
/// (loopback/private/link-local/unspecified/broadcast/multicast) and adds
/// explicit checks for ranges std does not classify: shared address space
/// / CGNAT (100.64.0.0/10), IETF benchmarking (198.18.0.0/15), the three
/// TEST-NET documentation ranges, and 192.0.0.0/24 (IETF protocol
/// assignments).
fn is_blocked_ipv4(v4: Ipv4Addr) -> bool {
    if v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local() // 169.254.0.0/16 — includes metadata 169.254.169.254
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
    {
        return true;
    }

    let o = v4.octets();

    // Shared address space / CGNAT: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
    if o[0] == 100 && (64..=127).contains(&o[1]) {
        return true;
    }

    // IETF benchmarking: 198.18.0.0/15 (198.18.0.0 - 198.19.255.255)
    if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        return true;
    }

    // Documentation ranges: TEST-NET-1/2/3
    if (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
    {
        return true;
    }

    // IETF protocol assignments: 192.0.0.0/24 (distinct from 192.0.2.0/24
    // above; covers NAT64/DNS64 and other reserved sub-blocks).
    if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        return true;
    }

    false
}

/// IPv6 half of `is_blocked_ip`.
fn is_blocked_ipv6(v6: Ipv6Addr) -> bool {
    if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
        return true;
    }

    let seg0 = v6.segments()[0];

    // Unique local addresses: fc00::/7
    if (seg0 & 0xFE00) == 0xFC00 {
        return true;
    }

    // Link-local: fe80::/10
    if (seg0 & 0xFFC0) == 0xFE80 {
        return true;
    }

    // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) — re-check
    // the embedded IPv4 address so a mapped form of a blocked address (e.g.
    // ::ffff:169.254.169.254) can't slip past the IPv6 checks above.
    if let Some(embedded) = v6.to_ipv4_mapped().or_else(|| v6.to_ipv4()) {
        return is_blocked_ipv4(embedded);
    }

    false
}

/// Extracts the (host, default_port) pair from a fully-qualified http(s)
/// URL string, without pulling in the `url` crate. Handles userinfo
/// (`user:pass@host`), a trailing port, and bracketed IPv6 literals
/// (`[::1]`, `[::1]:8080`). Returns Err for any non-http/https scheme —
/// this doubles as the defensive scheme check for redirect hops, since
/// reqwest's own default redirect handling already restricts redirects to
/// http/https.
fn url_host_and_default_port(url: &str) -> Result<(String, u16), String> {
    let (rest, default_port) = if let Some(rest) = url.strip_prefix("https://") {
        (rest, 443u16)
    } else if let Some(rest) = url.strip_prefix("http://") {
        (rest, 80u16)
    } else {
        return Err(format!("blocked by SSRF guard: unsupported scheme in '{}'", url));
    };

    // Authority ends at the first '/', '?', or '#'.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];

    // Strip userinfo ("user:pass@host") if present — take the part after
    // the LAST '@' so a password containing '@' doesn't break the split.
    let host_port = match authority.rsplit_once('@') {
        Some((_userinfo, rest)) => rest,
        None => authority,
    };

    if host_port.is_empty() {
        return Err(format!("URL has no host: {}", url));
    }

    let host = if let Some(after_bracket) = host_port.strip_prefix('[') {
        // Bracketed IPv6 literal: "[::1]" or "[::1]:8080".
        match after_bracket.find(']') {
            Some(end) => &host_port[..end + 2],
            None => return Err(format!("malformed IPv6 host literal in URL: {}", url)),
        }
    } else {
        // Plain "host[:port]" — strip a trailing port if present.
        match host_port.rsplit_once(':') {
            Some((h, port_str)) if port_str.chars().all(|c| c.is_ascii_digit()) && !port_str.is_empty() => h,
            _ => host_port,
        }
    };

    if host.is_empty() {
        return Err(format!("URL has no host: {}", url));
    }

    Ok((host.to_string(), default_port))
}

/// Checks whether `host` (no port; brackets stripped if it's a bracketed
/// IPv6 literal) resolves to an address `is_blocked_ip` must reject.
///
/// - An IP literal (the common case: reqwest/std already canonicalize
///   decimal/hex-obfuscated literals down to a normal dotted/colon form
///   before this is ever called) is checked directly.
/// - A hostname is resolved via the OS resolver and EVERY returned address
///   is checked — a hostname can resolve to several addresses, and
///   blocking on the first one only would leave a private A/AAAA record
///   hidden behind a public-looking one unguarded. Resolution failure is
///   treated as blocked (fail-closed): reqwest would fail the request
///   anyway, so returning Err here changes nothing except the error
///   message.
fn host_is_blocked(host: &str, default_port: u16) -> Result<(), String> {
    let bare = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);

    if let Ok(ip) = bare.parse::<IpAddr>() {
        return if is_blocked_ip(ip) {
            Err(format!("blocked by SSRF guard: {} -> {}", host, ip))
        } else {
            Ok(())
        };
    }

    match (host, default_port).to_socket_addrs() {
        Ok(addrs) => {
            for addr in addrs {
                let ip = addr.ip();
                if is_blocked_ip(ip) {
                    return Err(format!("blocked by SSRF guard: {} -> {}", host, ip));
                }
            }
            Ok(())
        }
        Err(e) => Err(format!("blocked by SSRF guard: failed to resolve host '{}': {}", host, e)),
    }
}

/// Runs the SSRF guard against a full URL string: extracts the host (and
/// scheme-derived default port) and checks it. Shared by the pre-send
/// check in web_fetch/web_search and by the redirect policy below, so both
/// call sites enforce identically.
pub(crate) fn guard_url(url: &str) -> Result<(), String> {
    let (host, default_port) = url_host_and_default_port(url)?;
    host_is_blocked(&host, default_port)
}

// ── Shared HTTP client ─────────────────────────────────────────────

static HTTP_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

/// Shared blocking HTTP client for web_fetch + web_search, built once and
/// reused instead of constructing a fresh client (and its own connection
/// pool) on every call. Per-request timeout is still applied via
/// `RequestBuilder::timeout()` at each call site.
///
/// Redirect policy: a custom closure replaces the previous
/// `Policy::limited(10)` — it still caps at 10 hops, but additionally runs
/// the SSRF guard (`guard_url`) against every redirect target, since a
/// first request to a public host can still redirect (once, or after N
/// hops) to a private/loopback/metadata address.
pub(crate) fn shared_http_client() -> &'static reqwest::blocking::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    return attempt.stop();
                }
                match guard_url(attempt.url().as_str()) {
                    Ok(()) => attempt.follow(),
                    Err(e) => attempt.error(e),
                }
            }))
            .timeout(std::time::Duration::from_secs(MAX_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

// ── Concurrency guard ───────────────────────────────────────────────

/// Max number of web_fetch/web_search calls allowed to run at once.
/// Defense-in-depth: without this, a burst of agent tool calls could open
/// several simultaneous blocking HTTP downloads (and, for web_fetch,
/// several clean_html passes) at the same time. Mirrors the
/// COLD_FALLBACK_LOCK serialize-instead-of-parallelize pattern in
/// commands/brain/search.rs, extended to a small counting semaphore
/// (capacity 2) instead of capacity 1.
///
/// Bounded via the shared `BoundedGate` (commands/util.rs) — previously a
/// hand-rolled WEB_OPS_COUNT/WEB_OPS_CVAR/WebOpsGuard pair duplicating
/// brain/capture.rs's own CaptureSemaphore/CapturePermit, now unified into
/// one poison-safe implementation both modules share.
const MAX_CONCURRENT_WEB_OPS: u32 = 2;
static WEB_OPS_GATE: BoundedGate = BoundedGate::new(MAX_CONCURRENT_WEB_OPS);

// ── Result types ───────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    pub url: String,
    pub content: String,
    pub content_type: String,
    pub was_truncated: bool,
    pub status_code: u16,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub query: String,
    pub results: Vec<WebSearchResultItem>,
}

// ── URL normalization ──────────────────────────────────────────────

/// Normalize a URL to always have an http(s) scheme.
/// Handles protocol-relative URLs (//example.com) and bare URLs (example.com).
fn normalize_url(url: &str) -> String {
    let raw = url.trim();
    let stripped = if raw.starts_with("//") {
        raw.trim_start_matches('/')
    } else {
        raw
    };
    if stripped.starts_with("http://") || stripped.starts_with("https://") {
        stripped.to_string()
    } else {
        format!("https://{}", stripped)
    }
}

// ── HTML cleaning (preserves structural HTML for Brain) ───────────

/// Tags whose entire content (inner HTML) should be removed — noise/boilerplate.
const NOISE_BLOCK_TAGS: &[&str] = &[
    "script", "style", "noscript", "iframe", "svg", "math", "template",
];

/// Tags that are typically boilerplate/navigation — remove content but keep
/// the rest of the page. These are removed with their inner content.
const BOILERPLATE_TAGS: &[&str] = &[
    "nav", "header", "footer", "aside",
];

/// Clean HTML for Brain ingestion: removes noise (scripts, styles, nav,
/// footer, cookie banners, ads) but PRESERVES structural HTML tags
/// (h1-h6, p, a, code, pre, ul, li, blockquote, article, section, data, etc.)
/// so the result is compatible with the Brain's data-cerveau-* CSS queries.
///
/// Key design decision: we keep HTML, not convert to Markdown, because
/// the Brain stores notes as HTML with data-cerveau-* attributes and
/// brain_query_css runs CSS selectors over them.
fn clean_html(html: &str) -> String {
    // Remove noise block tags entirely (with their content)
    let mut result = html.to_string();
    for tag in NOISE_BLOCK_TAGS {
        result = remove_tags_block(&result, tag);
    }

    // Remove boilerplate tags (nav, header, footer, aside)
    for tag in BOILERPLATE_TAGS {
        result = remove_tags_block(&result, tag);
    }

    // Remove HTML comments
    result = regex_replace_str(&result, r"<!--.*?-->", "");

    // Remove common ad/cookie/banner divs by class pattern
    result = remove_by_class_pattern(&result, r"(?i)cookie|consent|gdpr|banner|advert|ad-|ads|popup|modal|overlay|sidebar|social|share|newsletter|subscribe");

    // Remove <form> blocks (usually search/login forms, not content)
    result = remove_tags_block(&result, "form");

    // Remove inline event handlers (onclick, onload, etc.) — security
    result = regex_replace_str(&result, r#"(?i)\s+on\w+\s*=\s*["'][^"']*["']"#, "");

    // Remove inline style attributes (keep <style> tags already removed, but
    // inline style="..." attributes are noise for content extraction)
    result = regex_replace_str(&result, r#"(?i)\s+style\s*=\s*["'][^"']*["']"#, "");

    // Remove class attributes — they're page-specific CSS, not semantic
    result = regex_replace_str(&result, r#"(?i)\s+class\s*=\s*["'][^"']*["']"#, "");

    // Remove id attributes — page-specific, not semantic
    result = regex_replace_str(&result, r#"(?i)\s+id\s*=\s*["'][^"']*["']"#, "");

    // Remove data-* attributes EXCEPT data-cerveau-* (preserve for Brain)
    // Match data-x where x is not "cerveau"
    result = regex_replace_str(&result, r#"(?i)\s+data-(?!cerveau)[a-z0-9-]+\s*=\s*["'][^"']*["']"#, "");

    // Remove role attributes except doc-warning, doc-note (Brain uses these)
    result = regex_replace_str(&result, r#"(?i)\s+role\s*=\s*["'](?!doc-warning|doc-note)[^"']*["']"#, "");

    // Decode HTML entities
    result = decode_html_entities(&result);

    // Clean up whitespace: collapse multiple blank lines, trim lines
    result = clean_whitespace(&result);

    result
}

/// Remove a block tag and its contents entirely.
fn remove_tags_block(html: &str, tag: &str) -> String {
    let pattern = format!(r"(?is)<{}\b[^>]*>.*?</{}>", tag, tag);
    regex_replace_str(html, &pattern, "")
}

/// Remove elements whose class attribute matches the given pattern.
fn remove_by_class_pattern(html: &str, pattern: &str) -> String {
    let full_pattern = format!(
        r#"(?is)<(div|section|span|p|ul|ol)\b[^>]*class\s*=\s*["'][^"']*(?:{})[^"']*["'][^>]*>.*?</\1>"#,
        pattern
    );
    regex_replace_str(html, &full_pattern, "")
}

/// Clean text content: strip remaining tags, trim whitespace.
fn clean_text(s: &str) -> String {
    let s = regex_replace_str(s, r"(?is)<[^>]+>", "");
    decode_html_entities(&s).trim().to_string()
}

/// All named entities decode_html_entities understands.
const HTML_ENTITIES: &[(&str, &str)] = &[
    ("&amp;", "&"),
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&quot;", "\""),
    ("&#39;", "'"),
    ("&apos;", "'"),
    ("&nbsp;", " "),
    ("&mdash;", "—"),
    ("&ndash;", "–"),
    ("&hellip;", "…"),
    ("&laquo;", "«"),
    ("&raquo;", "»"),
    ("&copy;", "©"),
    ("&reg;", "®"),
    ("&trade;", "™"),
    ("&deg;", "°"),
    ("&times;", "×"),
    ("&divide;", "÷"),
];

/// Decode common HTML entities in a single left-to-right pass, instead of
/// 17 sequential full-buffer `String::replace` calls (each of which
/// reallocates and rescans the entire string). Also avoids the chained-call
/// double-decode bug: e.g. "&amp;lt;" now correctly decodes to the literal
/// "&lt;" instead of a second pass turning that into "<".
fn decode_html_entities(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut rest = s;
    'outer: while let Some(amp_pos) = rest.find('&') {
        result.push_str(&rest[..amp_pos]);
        let tail = &rest[amp_pos..];
        for (entity, decoded) in HTML_ENTITIES {
            if tail.starts_with(entity) {
                result.push_str(decoded);
                rest = &tail[entity.len()..];
                continue 'outer;
            }
        }
        // '&' didn't start a known entity — copy it literally and move on.
        result.push('&');
        rest = &tail[1..];
    }
    result.push_str(rest);
    result
}

/// Collapse multiple blank lines, trim each line, limit overall length.
fn clean_whitespace(s: &str) -> String {
    let lines: Vec<&str> = s.lines().map(|l| l.trim()).collect();
    let mut result = String::new();
    let mut prev_blank = false;
    for line in &lines {
        if line.is_empty() {
            if !prev_blank {
                result.push('\n');
            }
            prev_blank = true;
        } else {
            result.push_str(line);
            result.push('\n');
            prev_blank = false;
        }
    }
    result.trim().to_string()
}

/// Helper: apply a regex replacement with a string.
fn regex_replace_str(text: &str, pattern: &str, replacement: &str) -> String {
    match regex::Regex::new(pattern) {
        Ok(re) => re.replace_all(text, replacement).to_string(),
        Err(_) => text.to_string(),
    }
}

// ── DuckDuckGo HTML parsing ────────────────────────────────────────

/// Parse DuckDuckGo HTML search results page into structured items.
///
/// DEVIATION FROM A "PER-RESULT `<div>` BLOCK" PARSE (deliberate — see the
/// bug this replaced): the natural approach delimits each hit's own
/// `<div class="result ...">...</div>` block first, then searches inside
/// each block for its title/snippet links. That requires knowing where a
/// block ends despite an unknown-depth nested `result__body` div inside it
/// — the obvious way to express that boundary is a `(?=...)` lookahead, but
/// the `regex` crate this project depends on (`Cargo.toml`: `regex = "1"`,
/// the standard linear-time engine, not `fancy-regex`) does NOT support
/// look-around at all: `Regex::new` returns `Err` for any pattern
/// containing it. The original version of this function used exactly that
/// lookahead, so `Regex::new` silently failed every single call and this
/// function returned an empty `Vec` unconditionally — `web_search` never
/// surfaced a real result. Caught by
/// `parse_ddg_html_extracts_title_url_snippet_from_a_realistic_fixture`
/// below, which failed until this was rewritten.
///
/// Fix: never delimit blocks at all. Collect every `result__a` title+href
/// link and every `result__snippet` link independently (both regexes are
/// simple, lookahead-free, and DO compile), each in page order, then pair
/// them up POSITIONALLY (`i`-th title with `i`-th snippet) — DuckDuckGo's
/// HTML always emits exactly one snippet link per organic result
/// immediately following its title, so this ordering holds; if a page ever
/// has fewer snippets than titles (a stripped-down or ad-only variant),
/// pairing degrades to an empty snippet for the extra titles rather than
/// crashing — "tolerant" parsing, not paired to hard structural assumptions.
fn parse_ddg_html(html: &str) -> Vec<WebSearchResultItem> {
    let mut results = Vec::new();

    let link_re = match regex::Regex::new(r#"(?is)<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)</a>"#) {
        Ok(re) => re,
        Err(_) => return results,
    };

    let snippet_re = match regex::Regex::new(r#"(?is)<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>"#) {
        Ok(re) => re,
        Err(_) => return results,
    };

    let snippets: Vec<String> = snippet_re
        .captures_iter(html)
        .map(|cap| clean_text(&cap[1]))
        .collect();

    for (i, link_cap) in link_re.captures_iter(html).enumerate() {
        let raw_url = &link_cap[1];
        let title = clean_text(&link_cap[2]);

        // DuckDuckGo wraps URLs in a redirect: //duckduckgo.com/l/?uddg=ENCODED_URL&...
        // Extract the actual URL from the uddg parameter
        let url = extract_ddg_url(raw_url);

        if title.is_empty() || url.is_empty() {
            continue;
        }

        let snippet = snippets.get(i).cloned().unwrap_or_default();

        results.push(WebSearchResultItem { title, url, snippet });

        if results.len() >= 10 {
            break;
        }
    }

    results
}

/// Extract the actual URL from a DuckDuckGo redirect link.
fn extract_ddg_url(raw: &str) -> String {
    // DDG redirect format: //duckduckgo.com/l/?uddg=ENCODED&rut=...
    // or sometimes just the direct URL
    if raw.contains("uddg=") {
        if let Some(start) = raw.find("uddg=") {
            let after = &raw[start + 5..];
            let end = after.find('&').unwrap_or(after.len());
            let encoded = &after[..end];
            return urlencoding::decode(encoded)
                .map(|s| s.to_string())
                .unwrap_or_else(|_| encoded.to_string());
        }
    }
    // Not a redirect — return as-is (strip leading //)
    raw.trim_start_matches("//").to_string()
}

// ── Body reading & content-type gating ─────────────────────────────
//
// Char-boundary-safe truncation is shared via commands/util.rs's
// `truncate_on_char_boundary` (identical `&str, usize -> &str` signature) —
// this module used to keep its own duplicate copy (`truncate_at_char_boundary`,
// with its own single-case unit test); removed in favor of the shared one,
// which carries broader edge-case coverage (accented/CJK/emoji straddling
// the cut, zero max_bytes) than the copy it replaces.

/// Whether a content-type should be decoded as text and passed through
/// clean_html. Binary/unrecognized types (images, PDFs, video, generic
/// octet-stream, etc.) are rejected before any download/decode work is
/// spent on them.
fn is_textual_content_type(content_type: &str) -> bool {
    let lower = content_type.to_ascii_lowercase();
    let base = lower.split(';').next().unwrap_or("").trim();
    base.starts_with("text/")
        || base == "application/json"
        || base == "application/xhtml+xml"
        || base == "application/xml"
}

/// Resolves the content-type `web_fetch` should proceed with, given the
/// (possibly absent) Content-Type response header:
///   - present + textual (`is_textual_content_type`)      -> echoed back
///   - present + EXPLICITLY non-textual (image/*,
///     application/octet-stream, video/*, application/pdf, ...)
///                                                          -> rejected
///   - absent, OR present but unparseable (non-ASCII header bytes — see
///     the `.and_then(|v| v.to_str().ok())` call site)     -> defaults to
///     "text/plain" and proceeds (the historical default: many servers
///     omit Content-Type entirely for plain HTML/text responses, so
///     rejecting those outright was a regression — only an EXPLICIT
///     non-textual type is a real signal worth rejecting on).
fn resolve_content_type(header: Option<&str>, url: &str) -> Result<String, String> {
    match header {
        Some(ct) if is_textual_content_type(ct) => Ok(ct.to_string()),
        None => Ok("text/plain".to_string()),
        Some(ct) => Err(format!(
            "unsupported content-type '{}' for web_fetch (only text/*, application/json, application/xhtml+xml, application/xml are fetched): {}",
            ct, url,
        )),
    }
}

/// Read a response body with a hard byte cap, regardless of what
/// Content-Length claimed (it can lie, or be absent under chunked
/// transfer-encoding). Reads up to `cap + 1` bytes so a body landing
/// exactly at the cap isn't misreported as capped. Returns the
/// lossily-decoded body (capped at `cap` bytes) and whether it was capped.
fn read_capped_body(response: reqwest::blocking::Response, cap: u64) -> std::io::Result<(String, bool)> {
    let mut buf: Vec<u8> = Vec::new();
    response.take(cap + 1).read_to_end(&mut buf)?;
    let was_capped = buf.len() as u64 > cap;
    if was_capped {
        buf.truncate(cap as usize);
    }
    // Lossy UTF-8 decode: an exact byte cut can land mid-codepoint, which is
    // fine for this best-effort tool content (not a file write).
    Ok((String::from_utf8_lossy(&buf).into_owned(), was_capped))
}

// ── Tauri commands ─────────────────────────────────────────────────

/// Fetch a URL and return its content as clean HTML (preserves structure for Brain).
///
/// - Normalizes the URL (adds https:// if missing)
/// - Sends proper browser-like headers
/// - Retries with an honest User-Agent on Cloudflare 403 challenge
/// - Cleans HTML: removes scripts/styles/nav/footer/ads but PRESERVES
///   headings, links, code blocks, articles, data-cerveau-* attributes
/// - Truncates to MAX_CONTENT_BYTES with a notice
/// - Returns content_type and status_code for debugging
#[tauri::command]
pub(crate) fn web_fetch(
    url: String,
    timeout_secs: Option<u64>,
    max_chars: Option<usize>,
) -> Result<WebFetchResult, String> {
    let normalized = normalize_url(&url);

    // Validate scheme
    if !normalized.starts_with("http://") && !normalized.starts_with("https://") {
        return Err(format!("Invalid URL scheme. Must be http or https: {}", normalized));
    }

    // SSRF guard: block requests to loopback/private/link-local/metadata
    // addresses before ever opening a connection. Redirect hops are
    // re-checked by the shared client's custom redirect policy.
    guard_url(&normalized)?;

    let timeout = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .min(MAX_TIMEOUT_SECS);

    // Clamp to the ceiling toolRegistry.ts's web_fetch description promises
    // the model ("max 120000") — previously unbounded when the caller
    // passed a larger max_chars.
    let max_content = max_chars
        .unwrap_or(MAX_CONTENT_BYTES)
        .min(MAX_CONTENT_BYTES)
        .max(MIN_CONTENT_CHARS);

    let _web_op_guard = WEB_OPS_GATE.acquire();
    let client = shared_http_client();

    // First attempt with browser User-Agent
    let response = client
        .get(&normalized)
        .timeout(std::time::Duration::from_secs(timeout))
        .header("User-Agent", BROWSER_USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .map_err(|e| format!("Request failed: {}", e))?;

    let status_code = response.status().as_u16();

    // Cloudflare bot detection retry: if 403 with cf-mitigated: challenge,
    // retry with honest User-Agent
    let response = if status_code == 403 && response.headers().get("cf-mitigated").map(|v| v.to_str().unwrap_or("")) == Some("challenge") {
        client
            .get(&normalized)
            .timeout(std::time::Duration::from_secs(timeout))
            .header("User-Agent", HONEST_USER_AGENT)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .map_err(|e| format!("Retry request failed: {}", e))?
    } else {
        response
    };

    let status_code = response.status().as_u16();
    if !response.status().is_success() {
        return Err(format!("HTTP error {}: {}", status_code, normalized));
    }

    // Pre-check Content-Length when present: fail fast on obviously
    // oversized pages before spending time downloading them. Content-Length
    // can be absent or wrong (chunked transfer-encoding, lying servers) —
    // the hard byte cap in read_capped_body below is the real backstop.
    if let Some(len) = response.content_length() {
        if len > HARD_CAP_BYTES {
            return Err(format!(
                "page too large ({:.1} MB, cap {} MB): {}",
                len as f64 / 1_048_576.0,
                HARD_CAP_BYTES / 1_048_576,
                normalized,
            ));
        }
    }

    let content_type_header = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let content_type = resolve_content_type(content_type_header.as_deref(), &normalized)?;

    let (body, body_was_capped) = read_capped_body(response, HARD_CAP_BYTES)
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    // Bound the input to clean_html's ~38-pass pipeline independent of the
    // requested max_chars, so a multi-MB page never runs the full pipeline
    // just because the caller asked for a small max_chars.
    let pre_clean_capped = body.len() > PRE_CLEAN_CAP_BYTES;
    let body_for_clean = truncate_on_char_boundary(&body, PRE_CLEAN_CAP_BYTES);

    // Clean HTML (preserve structure for Brain) if content type indicates HTML
    let content = if content_type.contains("text/html") || content_type.contains("application/xhtml") {
        clean_html(body_for_clean)
    } else {
        body_for_clean.to_string()
    };

    // Truncate to the model-facing max_content
    let content_bytes = content.as_bytes();
    let final_truncated = content_bytes.len() > max_content;
    let content = if final_truncated {
        let truncated = String::from_utf8_lossy(&content_bytes[..max_content.min(content_bytes.len())]).to_string();
        format!("{}\n\n[Content truncated due to size limit]", truncated)
    } else {
        content
    };

    Ok(WebFetchResult {
        url: normalized,
        content,
        content_type,
        was_truncated: body_was_capped || pre_clean_capped || final_truncated,
        status_code,
    })
}

/// Search the web using DuckDuckGo's HTML endpoint.
///
/// Returns structured results with title, URL, and snippet for each hit.
/// No API key required — uses DuckDuckGo's free HTML search.
#[tauri::command]
pub(crate) fn web_search(
    query: String,
    max_results: Option<u32>,
) -> Result<WebSearchResult, String> {
    if query.trim().is_empty() {
        return Err("Search query cannot be empty".to_string());
    }

    let max = max_results.unwrap_or(8).min(20);
    let encoded_q = urlencoding::encode(&query);
    let url = format!("https://html.duckduckgo.com/html/?q={}", encoded_q);

    // SSRF guard: url is a fixed public DuckDuckGo host today, so this
    // will always pass, but running it here hardens against any future
    // change to how `url` is built and keeps this call site consistent
    // with web_fetch. Redirect hops are re-checked by the shared client's
    // custom redirect policy.
    guard_url(&url)?;

    let _web_op_guard = WEB_OPS_GATE.acquire();
    let client = shared_http_client();

    let response = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .header("User-Agent", BROWSER_USER_AGENT)
        .header("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .map_err(|e| format!("Search request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Search request returned HTTP {}", response.status()));
    }

    // Same hard-cap rationale as web_fetch — fixed DDG URL is lower risk
    // but still uncapped response.text() before this fix.
    if let Some(len) = response.content_length() {
        if len > HARD_CAP_BYTES {
            return Err(format!(
                "search results page too large ({:.1} MB, cap {} MB)",
                len as f64 / 1_048_576.0,
                HARD_CAP_BYTES / 1_048_576,
            ));
        }
    }

    let (html, _was_capped) = read_capped_body(response, HARD_CAP_BYTES)
        .map_err(|e| format!("Failed to read search results: {}", e))?;

    let mut results = parse_ddg_html(&html);
    results.truncate(max as usize);

    Ok(WebSearchResult {
        query: query.clone(),
        results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Char-boundary-safe truncation (formerly this module's own
    // `truncate_at_char_boundary_respects_utf8` test) is now covered by
    // commands/util.rs's `truncate_on_char_boundary_*` tests (accented/CJK/
    // emoji straddling the cut, zero max_bytes, unchanged-under-limit) —
    // see FIX 2a in the review this change came from.

    /// is_textual_content_type: accepts the whitelisted textual types
    /// (including a charset parameter) and rejects binary types.
    #[test]
    fn is_textual_content_type_classifies_known_types() {
        assert!(is_textual_content_type("text/html; charset=utf-8"));
        assert!(is_textual_content_type("application/json"));
        assert!(is_textual_content_type("application/xhtml+xml"));
        assert!(is_textual_content_type("text/plain"));
        assert!(!is_textual_content_type("image/png"));
        assert!(!is_textual_content_type("application/octet-stream"));
        assert!(!is_textual_content_type("application/pdf"));
        eprintln!("is_textual_content_type_classifies_known_types PASSED");
    }

    /// resolve_content_type: a missing (or unparseable, per the
    /// `.and_then(|v| v.to_str().ok())` call site) Content-Type header
    /// defaults to "text/plain" and proceeds — the historical default,
    /// restored after a regression started rejecting these responses
    /// outright with "unsupported content-type '(missing)'".
    #[test]
    fn resolve_content_type_defaults_missing_header_to_text_plain() {
        let result = resolve_content_type(None, "https://example.com");
        assert_eq!(result, Ok("text/plain".to_string()));
        eprintln!("resolve_content_type_defaults_missing_header_to_text_plain PASSED");
    }

    /// A present, textual Content-Type is echoed back unchanged (including
    /// any charset parameter).
    #[test]
    fn resolve_content_type_passes_through_a_present_textual_type() {
        let result = resolve_content_type(Some("text/html; charset=utf-8"), "https://example.com");
        assert_eq!(result, Ok("text/html; charset=utf-8".to_string()));
        eprintln!("resolve_content_type_passes_through_a_present_textual_type PASSED");
    }

    /// A present, EXPLICITLY non-textual Content-Type is still rejected —
    /// the missing-header default above must not weaken this half of the
    /// gate.
    #[test]
    fn resolve_content_type_rejects_a_present_non_textual_type() {
        let result = resolve_content_type(Some("image/png"), "https://example.com/photo.png");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("image/png"));
        assert!(err.contains("unsupported content-type"));
        eprintln!("resolve_content_type_rejects_a_present_non_textual_type PASSED");
    }

    /// decode_html_entities: decodes known entities in one left-to-right
    /// pass and leaves unknown entities / plain text untouched. Also proves
    /// the rewrite no longer double-decodes a freshly-formed entity — a
    /// chained `.replace()` pipeline would turn "&amp;lt;" into "<"; a
    /// correct single pass yields the literal "&lt;".
    #[test]
    fn decode_html_entities_single_pass_no_double_decode() {
        assert_eq!(decode_html_entities("Tom &amp; Jerry"), "Tom & Jerry");
        assert_eq!(decode_html_entities("&amp;lt;"), "&lt;");
        assert_eq!(decode_html_entities("&unknown; stays"), "&unknown; stays");
        assert_eq!(decode_html_entities("no entities here"), "no entities here");
        eprintln!("decode_html_entities_single_pass_no_double_decode PASSED");
    }

    /// is_blocked_ip: loopback, private, link-local/metadata, shared/CGNAT,
    /// unspecified, and their IPv6 equivalents (including the IPv4-mapped
    /// form) must be blocked; ordinary public IPv4/IPv6 addresses must not.
    #[test]
    fn is_blocked_ip_classifies_private_and_public_addresses() {
        let blocked: &[&str] = &[
            "127.0.0.1",
            "169.254.169.254", // cloud metadata endpoint
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "100.64.0.1", // shared address space / CGNAT
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ];
        for addr in blocked {
            let ip: IpAddr = addr.parse().unwrap_or_else(|_| panic!("test fixture '{}' must parse", addr));
            assert!(is_blocked_ip(ip), "{} should be blocked", addr);
        }

        let allowed: &[&str] = &[
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",           // example.com
            "2606:4700:4700::1111",    // public IPv6 (Cloudflare)
        ];
        for addr in allowed {
            let ip: IpAddr = addr.parse().unwrap_or_else(|_| panic!("test fixture '{}' must parse", addr));
            assert!(!is_blocked_ip(ip), "{} should NOT be blocked", addr);
        }

        eprintln!("is_blocked_ip_classifies_private_and_public_addresses PASSED");
    }

    /// host_is_blocked with IP literals only (no DNS involved, so this test
    /// has no network dependency): loopback/metadata/IPv6-loopback are
    /// blocked, an ordinary public IP is allowed.
    #[test]
    fn host_is_blocked_checks_ip_literals_without_dns() {
        assert!(host_is_blocked("127.0.0.1", 443).is_err());
        assert!(host_is_blocked("169.254.169.254", 443).is_err());
        assert!(host_is_blocked("[::1]", 443).is_err());
        assert!(host_is_blocked("8.8.8.8", 443).is_ok());
        eprintln!("host_is_blocked_checks_ip_literals_without_dns PASSED");
    }

    // ── parse_ddg_html / extract_ddg_url (P-SEARCH fixture coverage) ────
    //
    // A trimmed-down but structurally real DuckDuckGo HTML results page:
    // each hit is a `<div class="result ...">` wrapping a nested
    // `result__body` div (title link + snippet link), same shape DDG's
    // actual html.duckduckgo.com/html/ endpoint returns. Exercises the
    // lazy `(.*?)</div>\s*(?=<div|</body|$)` block boundary across NESTED
    // divs (title/snippet live one level deeper than the block matcher's
    // own `<div class="result...">`), the uddg-redirect URL decode, HTML
    // entity decoding in the snippet, and the trailing-wrapper-div edge
    // case for the LAST result in the page.
    const DDG_FIXTURE_TWO_RESULTS: &str = concat!(
        r#"<div class="results">"#,
        r#"<div class="result results_links results_links_deep web-result">"#,
        r#"<div class="links_main links_deep result__body">"#,
        r#"<h2 class="result__title">"#,
        r#"<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust%2Dlang.org%2F&amp;rut=abc">Rust Programming Language</a>"#,
        r#"</h2>"#,
        r#"<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rust%2Dlang.org%2F&amp;rut=abc">A language empowering everyone to build reliable &amp; efficient software.</a>"#,
        r#"</div>"#,
        r#"</div>"#,
        r#"<div class="result results_links results_links_deep web-result">"#,
        r#"<div class="links_main links_deep result__body">"#,
        r#"<h2 class="result__title">"#,
        r#"<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust%2Dlang.org%2Fbook%2F&amp;rut=def">The Rust Book</a>"#,
        r#"</h2>"#,
        r#"<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdoc.rust%2Dlang.org%2Fbook%2F&amp;rut=def">Learn Rust with the official book.</a>"#,
        r#"</div>"#,
        r#"</div>"#,
        r#"</div>"#,
    );

    /// parse_ddg_html on a realistic two-result fixture: both results are
    /// found, in page order, with titles/snippets HTML-entity-decoded and
    /// URLs extracted (and percent-decoded) from DuckDuckGo's `uddg=`
    /// redirect wrapper rather than left as the raw `//duckduckgo.com/l/?...`
    /// link.
    #[test]
    fn parse_ddg_html_extracts_title_url_snippet_from_a_realistic_fixture() {
        let results = parse_ddg_html(DDG_FIXTURE_TWO_RESULTS);

        assert_eq!(results.len(), 2, "expected exactly 2 results, got: {:?}", results);

        assert_eq!(results[0].title, "Rust Programming Language");
        assert_eq!(results[0].url, "https://www.rust-lang.org/");
        assert_eq!(
            results[0].snippet,
            "A language empowering everyone to build reliable & efficient software."
        );

        assert_eq!(results[1].title, "The Rust Book");
        assert_eq!(results[1].url, "https://doc.rust-lang.org/book/");
        assert_eq!(results[1].snippet, "Learn Rust with the official book.");

        eprintln!("parse_ddg_html_extracts_title_url_snippet_from_a_realistic_fixture PASSED");
    }

    /// parse_ddg_html on an empty/garbage page returns no results instead of
    /// erroring — the Tauri command layer turns this into a "No web results"
    /// message for the model rather than a hard failure.
    #[test]
    fn parse_ddg_html_returns_empty_for_a_page_with_no_result_blocks() {
        let results = parse_ddg_html("<html><body><p>No results found.</p></body></html>");
        assert!(results.is_empty());
        eprintln!("parse_ddg_html_returns_empty_for_a_page_with_no_result_blocks PASSED");
    }

    /// parse_ddg_html caps at 10 results even when the page has more —
    /// mirrors the Tauri command's own `results.truncate(max)`, but this
    /// proves the parser itself never builds an unbounded Vec from a page
    /// DuckDuckGo padded with extra hits.
    #[test]
    fn parse_ddg_html_caps_at_ten_results() {
        let mut fixture = String::from(r#"<div class="results">"#);
        for i in 0..15 {
            fixture.push_str(&format!(
                r#"<div class="result web-result"><div class="links_main result__body"><a class="result__a" href="https://example.com/{i}">Result {i}</a><a class="result__snippet">snippet {i}</a></div></div>"#,
            ));
        }
        fixture.push_str("</div>");

        let results = parse_ddg_html(&fixture);
        assert_eq!(results.len(), 10);
        eprintln!("parse_ddg_html_caps_at_ten_results PASSED");
    }

    /// extract_ddg_url: decodes the `uddg=` redirect wrapper (percent-decoded,
    /// stopping at the next `&`) and passes through a direct (non-redirect)
    /// link with only its leading `//` stripped.
    #[test]
    fn extract_ddg_url_handles_redirect_and_direct_links() {
        assert_eq!(
            extract_ddg_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath&rut=xyz"),
            "https://example.com/path"
        );
        assert_eq!(extract_ddg_url("//example.com/direct"), "example.com/direct");
        eprintln!("extract_ddg_url_handles_redirect_and_direct_links PASSED");
    }

    /// url_host_and_default_port: extracts host + scheme default port from
    /// plain, ported, and bracketed-IPv6 authorities, and rejects
    /// non-http(s) schemes.
    #[test]
    fn url_host_and_default_port_parses_authority_forms() {
        assert_eq!(
            url_host_and_default_port("https://example.com/path?q=1"),
            Ok(("example.com".to_string(), 443))
        );
        assert_eq!(
            url_host_and_default_port("http://example.com:8080/"),
            Ok(("example.com".to_string(), 80))
        );
        assert_eq!(
            url_host_and_default_port("http://user:pass@example.com/"),
            Ok(("example.com".to_string(), 80))
        );
        assert_eq!(
            url_host_and_default_port("https://[::1]:8443/"),
            Ok(("[::1]".to_string(), 443))
        );
        assert!(url_host_and_default_port("ftp://example.com/").is_err());
        eprintln!("url_host_and_default_port_parses_authority_forms PASSED");
    }
}
