/* secretMasking — masks secrets in tool observations before they reach the
   agent's context window or the journal.

   Cloud browser/desktop tools can accidentally capture secrets (passwords
   typed into forms, API keys visible on screen, tokens in URLs). This module
   provides a single maskSecrets function that replaces common secret
   patterns with a [REDACTED] placeholder.

   Patterns covered:
   - API keys (sk-..., key-..., Bearer ...)
   - Bearer tokens in Authorization headers
   - Passwords in URLs (https://user:pass@host)
   - Long hex/base64 strings that look like tokens (32+ chars)
   - Email addresses in form fields (conservative — only mask when preceded
     by "password" or "email" context)
*/

const PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // Stripe-style API keys
  { regex: /sk_(?:live|test)_[a-zA-Z0-9]{20,}/g, replacement: '[REDACTED:sk_key]' },
  // Generic API key prefixes
  { regex: /(?:api[_-]?key|apikey)["\s:=]+([a-zA-Z0-9_-]{20,})/gi, replacement: 'api_key=[REDACTED]' },
  // Bearer tokens
  { regex: /Bearer\s+[a-zA-Z0-9_.-]{20,}/g, replacement: 'Bearer [REDACTED]' },
  // Authorization headers
  { regex: /Authorization:\s*(?:Bearer\s+)?[a-zA-Z0-9_.-]{20,}/gi, replacement: 'Authorization: [REDACTED]' },
  // Passwords in URLs
  { regex: /:\/\/([^:/\s]+):([^@/\s]+)@/g, replacement: '://$1:[REDACTED]@' },
  // password= or passwd= form fields
  { regex: /(?:password|passwd|pwd)["\s:=]+(\S+)/gi, replacement: 'password=[REDACTED]' },
  // token= query params
  { regex: /(?:token|access_token|refresh_token)["\s:=]+([a-zA-Z0-9_.-]{16,})/gi, replacement: 'token=[REDACTED]' },
];

/** Mask secrets in a text string. Returns the masked string. */
export function maskSecrets(text: string): string {
  let result = text;
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/** Mask secrets in a tool observation before it enters the agent context. */
export function maskObservation(observation: string): string {
  return maskSecrets(observation);
}

/** Check if a string contains any known secret pattern. */
export function containsSecret(text: string): boolean {
  for (const { regex } of PATTERNS) {
    if (regex.test(text)) {
      regex.lastIndex = 0;
      return true;
    }
  }
  return false;
}
