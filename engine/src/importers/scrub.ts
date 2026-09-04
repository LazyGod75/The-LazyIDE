/**
 * Basic secret / PII scrubber for import adapters.
 *
 * Reuses the same patterns as the publish scrubber (schema/scrubber.ts) but
 * operates on raw text strings instead of HTML. Replaces matched patterns
 * with a placeholder so notes remain useful without leaking secrets.
 */

interface ScrubPattern {
  label: string;
  pattern: RegExp;
  replacement: string;
}

const SCRUB_PATTERNS: ScrubPattern[] = [
  {
    label: 'sk- API key',
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    replacement: '[API_KEY]',
  },
  {
    label: 'Google API key',
    pattern: /AIza[0-9A-Za-z\-_]{30,}/g,
    replacement: '[GOOGLE_KEY]',
  },
  {
    label: 'GitHub PAT',
    pattern: /ghp_[A-Za-z0-9]{30,}/g,
    replacement: '[GITHUB_TOKEN]',
  },
  {
    label: 'PEM private key block',
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    replacement: '[PRIVATE_KEY]',
  },
  {
    label: 'Slack token',
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacement: '[SLACK_TOKEN]',
  },
  {
    label: 'AWS access key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[AWS_KEY]',
  },
  {
    label: 'JWT token',
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[JWT]',
  },
  {
    label: 'npm token',
    pattern: /npm_[A-Za-z0-9]{36}/g,
    replacement: '[NPM_TOKEN]',
  },
  {
    label: 'Supabase key',
    pattern: /sbp_[A-Za-z0-9]{40,}/g,
    replacement: '[SUPABASE_KEY]',
  },
  {
    label: 'Bearer token',
    pattern: /[Bb]earer\s+[A-Za-z0-9\-_.+/=]{20,}/g,
    replacement: 'Bearer [TOKEN]',
  },
];

/**
 * Scrub obvious secrets from a text string.
 * Returns the cleaned text. Replacements are non-reversible.
 */
export function scrubText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SCRUB_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
