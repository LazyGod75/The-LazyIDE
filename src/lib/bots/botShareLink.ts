/* botShareLink — deep-link encoding/decoding for shared LazyBots.

   A shared bot is encoded as a URL-safe base64 JSON payload in a deep-link:
     lazy://bot/<base64-encoded-ShareableBot>

   The deep-link can be opened by the LazyIDE app to import the bot. The
   encoding uses URL-safe base64 (RFC 4648) so the link works in browsers,
   messaging apps, and email.
*/

import type { ShareableBot } from './botShare.js';
import { validateShareableBot, importShareableBot } from './botShare.js';
import type { BotConfig } from './botTypes.js';

const DEEP_LINK_PREFIX = 'lazy://bot/';

/** Encode a ShareableBot into a deep-link string. */
export function encodeBotShareLink(shared: ShareableBot): string {
  const json = JSON.stringify(shared);
  const b64 = urlSafeBase64Encode(json);
  return `${DEEP_LINK_PREFIX}${b64}`;
}

/** Decode a deep-link string back into a ShareableBot.
 *  Returns an error string if the link is invalid. */
export function decodeBotShareLink(link: string): { bot: ShareableBot } | { error: string } {
  if (!link.startsWith(DEEP_LINK_PREFIX)) {
    return { error: `Invalid link: must start with ${DEEP_LINK_PREFIX}` };
  }
  const b64 = link.slice(DEEP_LINK_PREFIX.length);
  let json: string;
  try {
    json = urlSafeBase64Decode(b64);
  } catch {
    return { error: 'Invalid link: corrupted base64 payload' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: 'Invalid link: corrupted JSON payload' };
  }
  const validationError = validateShareableBot(parsed);
  if (validationError) return { error: validationError };
  return { bot: parsed as ShareableBot };
}

/** Decode a deep-link and import it as a new BotConfig.
 *  Returns the imported bot or an error. */
export function importFromShareLink(link: string): { bot: BotConfig } | { error: string } {
  const result = decodeBotShareLink(link);
  if ('error' in result) return result;
  return { bot: importShareableBot(result.bot) };
}

/** Check if a string is a valid bot share link. */
export function isBotShareLink(str: string): boolean {
  return str.startsWith(DEEP_LINK_PREFIX);
}

// ── URL-safe base64 helpers ────────────────────────────────────────

function urlSafeBase64Encode(str: string): string {
  // Use btoa if available (browser/Tauri), otherwise Buffer (node/test).
  if (typeof btoa === 'function') {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const b64 = Buffer.from(str, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function urlSafeBase64Decode(b64: string): string {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4);
  if (typeof atob === 'function') {
    return decodeURIComponent(escape(atob(padded)));
  }
  return Buffer.from(padded, 'base64').toString('utf-8');
}
