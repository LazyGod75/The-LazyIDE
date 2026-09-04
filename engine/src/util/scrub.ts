/**
 * Secret scrubber — boundary guard before any text is stored in a brain.
 *
 * Replaces common secret patterns with [REDACTED].
 * Never stores raw secrets.
 */

interface SecretPattern {
  readonly name: string;
  readonly re: RegExp;
}

const PATTERNS: readonly SecretPattern[] = [
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'stripe-key', re: /sk_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { name: 'github-pat', re: /ghp_[A-Za-z0-9]{36,}/g },
  { name: 'github-fine-grained', re: /github_pat_[A-Za-z0-9_]{50,}/g },
  { name: 'aws-access-key', re: /AKIA[A-Z0-9]{16}/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'password-kv', re: /password\s*[:=]\s*\S+/gi },
  { name: 'secret-kv', re: /secret\s*[:=]\s*\S+/gi },
  { name: 'apikey-kv', re: /api[_-]?key\s*[:=]\s*\S+/gi },
];

export interface ScrubResult {
  readonly text: string;
  readonly redactions: number;
}

export function scrubSecrets(text: string): { text: string; redactions: number } {
  let result = text;
  let redactions = 0;

  for (const { re } of PATTERNS) {
    re.lastIndex = 0;
    const replaced = result.replace(re, () => {
      redactions++;
      return '[REDACTED]';
    });
    result = replaced;
    re.lastIndex = 0;
  }

  return { text: result, redactions };
}
