/* managerSessionGate — unsigned web + free OpenRouter model must not hit the ai-proxy.

   Measured 2026-08-28: LazyManager offered a free OpenRouter id, send failed with
   `ManagedUnavailableError: Session requise pour le mode géré (agent)`.
   supabase/functions/ai-proxy/index.ts authenticates via getUser() — free
   models skip credits, not the JWT. This module is the preflight + the
   unwrap so the bubble never shows Error: Error: LazyManager error: …
*/

import type { ProviderMode } from '../models/index.js';
import { isOpenRouterFreeModel } from '../models/openrouterCatalog.js';
import { supabase } from '../supabase/client.js';

/** True when this manager turn will call streamManagedAgentTurn. */
export function managerTurnNeedsSession(model: string, mode: ProviderMode): boolean {
  if (mode !== 'mock') return false;
  // Only the free rail hits the unsigned-web ai-proxy. Native ids stay on
  // mock/scripted paths; paid OpenRouter ids are not offered unsigned.
  return isOpenRouterFreeModel(model);
}

export async function hasManagedSession(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    return Boolean(data.session?.access_token);
  } catch {
    return false;
  }
}

/** Chat-bubble budget for a formatted manager error. 120 chars (the old
 *  pending-action label budget) cut the live DeepSeek-rail message mid
 *  sentence ("you may n…") after prefixes were already stripped. */
export const MANAGER_ERROR_MAX_CHARS = 400;

const STRIP = [
  /^(Error:\s*)+/i,
  /^Erreur\s*:\s*/i,
  /^Fehler:\s*/i,
  /^错误[：:]\s*/,
  /^エラー:\s*/i,
  /^LazyManager error:\s*/i,
  /^ManagedUnavailableError:\s*/i,
];

/** Innermost human message — strips nested Error:/LazyManager error: wrappers.
 *  Appends the error's diagnostic `code` (e.g. ManagedUnavailableError's
 *  `upstream_error_429` — the ai-proxy's real upstream status) when it is
 *  informative and not already present in the message text: "Erreur du
 *  fournisseur de modèle" alone hides a 429 rate-limit from a hard-down
 *  upstream, which is exactly the distinction a user needs to pick between
 *  "retry in a minute" and "this rail is dead". */
export function formatManagerUserError(err: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = err;
  let msg = '';
  let code: string | undefined;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      msg = current.message || String(current);
      const maybeCode = (current as { code?: unknown }).code;
      if (typeof maybeCode === 'string' && maybeCode && !code) code = maybeCode;
      current = current.cause;
    } else {
      msg = String(current);
      break;
    }
  }
  const stripped = stripManagerErrorPrefixes(msg) || 'unknown error';
  return decorateWithDiagnosticCode(stripped, code);
}

/** Appends the diagnostic code to the stripped message — with named
 *  translations for codes where the bare string is not actionable.
 *  2026-09-11: "Erreur du fournisseur de modèle (upstream_error_429)" told
 *  the user nothing — a shared-quota rate limit reads exactly like a dead
 *  upstream. Name the actual condition; keep the code for support. */
function decorateWithDiagnosticCode(stripped: string, code: string | undefined): string {
  if (code === 'upstream_error_429') {
    return 'Limite de débit atteinte côté fournisseur (quota partagé) — réessayez dans quelques instants ou changez de modèle (upstream_error_429)';
  }
  if (code && code !== 'managed_unavailable' && !stripped.includes(code)) {
    return `${stripped} (${code})`;
  }
  return stripped;
}

/** Render-time backstop for persisted bubbles that still carry nested
 *  `Error: Error: LazyManager error:` wrappers from before ingest sanitizing. */
export function stripManagerErrorPrefixes(raw: string): string {
  let msg = raw.trim();
  let prev = '';
  while (msg !== prev) {
    prev = msg;
    for (const re of STRIP) msg = msg.replace(re, '').trim();
  }
  return msg;
}
