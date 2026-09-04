/* actionClassifier.ts — Deterministic-first classification of cloud action
   tools into approval ActionClasses, plus a pluggable model fallback seam
   that is never consulted when the deterministic rules are confident.

   The priority order matters (see classifyAction): password targets and
   exec/file_write tools are recognised first, read-only tools are always
   'browse', then URL path markers, then interactive target-text markers.
   Anything else — including a genuine "Read more" link — is honestly
   'unknown', which the gate treats as REQUIRE (the intended fail-safe).

   classifyAction is pure and synchronous and never calls any model; the
   fallback can only ADD signal, never weaken a confident class.
*/

import type { ActionClass, PageContext } from './approvalTypes.js';
import { CLOUD_READONLY_TOOLS } from './approvalTypes.js';

export type ClassifyFallback = (
  tool: string,
  args: Record<string, unknown>,
  page: PageContext,
) => Promise<ActionClass | null>;

// ── Deterministic markers (lowercased before matching) ────────────

const URL_COMPOSE_MARKERS = ['compose', '/post', 'intent/tweet', 'publish', 'draft'];
const URL_PAY_MARKERS = ['checkout', '/pay', 'billing', 'cart'];
const URL_CREDENTIALS_MARKERS = ['login', '/signin', 'password', 'account/settings'];
const URL_DELETE_MARKERS = ['delete', 'remove', 'settings/deactivate'];

const TARGET_SEND = /\b(post|tweet|publish|send|submit|reply|share)\b/i;
const TARGET_PAY = /\b(buy|purchase|pay|checkout|order|subscribe)\b/i;
const TARGET_DELETE = /\b(delete|remove|unsubscribe|deactivate|destroy)\b/i;

/** Matches selectors like `input[type=password]`, `input[type="password"]`
 *  or `type = password` (no /g flag — .test() must stay stateless). */
const PASSWORD_SELECTOR = /type\s*=\s*["']?password/i;

function isPasswordTarget(args: Record<string, unknown>, page: PageContext): boolean {
  if (page.inputType === 'password') return true;
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && PASSWORD_SELECTOR.test(value)) return true;
  }
  return false;
}

export function classifyAction(tool: string, args: Record<string, unknown>, page: PageContext): ActionClass {
  // 1. Typing into a password input — the highest-priority signal.
  if (isPasswordTarget(args, page)) return 'credentials';
  // 2. Command execution.
  if (tool.endsWith('_exec') || tool === 'cloud_sandbox_run_code') return 'exec';
  // 3. File writes.
  if (tool === 'cloud_sandbox_write_file') return 'file_write';
  // 4. Read-only tools — opening/closing sessions and navigating are not
  //    world-changing actions.
  if (CLOUD_READONLY_TOOLS.has(tool)) return 'browse';

  // 5. URL path patterns (case-insensitive).
  const url = page.url?.toLowerCase();
  if (url) {
    if (URL_COMPOSE_MARKERS.some((marker) => url.includes(marker))) return 'compose';
    if (URL_PAY_MARKERS.some((marker) => url.includes(marker))) return 'pay';
    if (URL_CREDENTIALS_MARKERS.some((marker) => url.includes(marker))) return 'credentials';
    if (URL_DELETE_MARKERS.some((marker) => url.includes(marker))) return 'delete';
  }

  // 6. Interactive target text patterns (case-insensitive). The compose URL
  //    check already returned above, so a Post click here is 'send'.
  const targetText = page.targetText?.toLowerCase() ?? '';
  if (TARGET_SEND.test(targetText)) return 'send';
  if (TARGET_PAY.test(targetText)) return 'pay';
  if (TARGET_DELETE.test(targetText)) return 'delete';

  // 7. Interactive target with no recognized pattern, or unmatched — be
  //    honest: unknown is gated, and that is the intended fail-safe.
  return 'unknown';
}

/** Deterministic class when confident (anything other than 'unknown');
 *  otherwise the fallback's result, or 'unknown' when the fallback is
 *  absent, throws, or returns null. An 'unknown' from the fallback STAYS
 *  unknown — the caller gates it. */
export async function classifyWithFallback(
  tool: string,
  args: Record<string, unknown>,
  page: PageContext,
  fallback?: ClassifyFallback,
): Promise<ActionClass> {
  const deterministic = classifyAction(tool, args, page);
  if (deterministic !== 'unknown') return deterministic;
  if (!fallback) return 'unknown';
  try {
    const result = await fallback(tool, args, page);
    return result === null ? 'unknown' : result;
  } catch {
    // The fallback must never open the gate through a crash.
    return 'unknown';
  }
}
