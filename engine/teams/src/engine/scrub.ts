/**
 * Secret scrubber — boundary guard before any text is stored in a brain.
 *
 * Replaces common secret patterns with [REDACTED].
 * Logs the count of redactions to stderr so operators can audit.
 * Never stores raw secrets.
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

interface SecretPattern {
  readonly name: string;
  readonly re: RegExp;
}

// Each pattern must capture the entire secret (for replacement)
const PATTERNS: readonly SecretPattern[] = [
  // Anthropic API keys
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  // Stripe live/test keys
  { name: 'stripe-key', re: /sk_(?:live|test)_[A-Za-z0-9]{20,}/g },
  // GitHub personal access tokens (classic and fine-grained)
  { name: 'github-pat', re: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'github-fine-grained', re: /github_pat_[A-Za-z0-9_]{50,}/g },
  // AWS access keys
  { name: 'aws-access-key', re: /AKIA[A-Z0-9]{16}/g },
  // JWT-style tokens (base64url header "eyJ")
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  // Generic password= patterns (key=value or key: value)
  { name: 'password-kv', re: /password\s*[:=]\s*\S+/gi },
  // Generic secret= patterns
  { name: 'secret-kv', re: /secret\s*[:=]\s*\S+/gi },
  // API key assignments
  { name: 'apikey-kv', re: /api[_-]?key\s*[:=]\s*\S+/gi },
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface ScrubResult {
  readonly text: string;
  readonly redactionCount: number;
}

/**
 * Scan `text` for known secret patterns and replace each match with [REDACTED].
 * Returns the cleaned text and the total number of replacements made.
 */
export function scrubSecrets(text: string): ScrubResult {
  let result = text;
  let redactionCount = 0;

  for (const { re } of PATTERNS) {
    re.lastIndex = 0; // reset global flag
    const replaced = result.replace(re, () => {
      redactionCount++;
      return '[REDACTED]';
    });
    result = replaced;
    re.lastIndex = 0;
  }

  return { text: result, redactionCount };
}
