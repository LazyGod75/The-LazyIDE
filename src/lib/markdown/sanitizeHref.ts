/* sanitizeHref — allowlist-based link target validation for rendered
   markdown. Model output is semi-trusted (it may echo prompt-injected
   content from files or brain notes back into a link target), so a raw
   `[text](href)` href is NEVER trusted as-is.

   Policy: allow http(s) and scheme-less (relative/anchor/query) targets
   only. Everything else — javascript:, data:, vbscript:, file:, and any
   other scheme — is rejected. This is an ALLOWLIST, not a blocklist: a
   caller does not need to know every dangerous scheme name in advance,
   which is a stronger guarantee than pattern-matching "javascript:" etc.
*/

/** RFC 3986 scheme grammar: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":" */
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** Matches ASCII C0 control characters (U+0000-U+001F) and DEL (U+007F) —
 *  used to strip classic scheme-sniffing bypasses like "java\tscript:". */
// eslint-disable-next-line no-control-regex -- deliberate: stripping C0/DEL is the point of this regex
const CONTROL_CHARS_RE = new RegExp('[\\x00-\\x1F\\x7F]', 'g');

/**
 * Returns a safe href string, or null if the input must not be rendered as
 * a clickable link (callers should fall back to plain text, keeping the
 * visible label but dropping the dangerous target).
 */
export function sanitizeHref(raw: string): string | null {
  if (!raw) return null;

  // Strip ASCII control characters and surrounding whitespace before
  // inspecting the scheme.
  const cleaned = raw.replace(CONTROL_CHARS_RE, '').trim();
  if (!cleaned) return null;

  const schemeMatch = SCHEME_RE.exec(cleaned);
  if (!schemeMatch) {
    // No scheme — relative path, anchor (#section), or query. Safe: the
    // WebView can only resolve this against the app's own origin, it can
    // never execute code this way.
    return cleaned;
  }

  const scheme = schemeMatch[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' ? cleaned : null;
}
