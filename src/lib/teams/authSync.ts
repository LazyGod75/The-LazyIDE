/**
 * authSync.ts — Supabase JWT token store + org-context sync for Teams mode.
 *
 * After login (team scope only): store the session access_token and write
 * org-context.json via syncOrgContext (Tauri command teams_write_org_context).
 *
 * The stored token is used by _routeCapture (capture.ts) and checkTeamsHealth
 * when dispatching to the Teams sidecar in TEAMS_AUTH_MODE=supabase.
 *
 * Security: the token is held in module-level memory (renderer process only),
 * never persisted to disk by the frontend. The sidecar verifies it via
 * SUPABASE_JWT_SECRET (Rust env only, never exposed to the renderer).
 *
 * Solo / flag-off: all exports are no-ops when called without a valid session
 * or when scope !== 'team'. Zero behavioral change to the solo path.
 */

import { isTauri } from '../platform/index.js';
import { fetchOrgContextData, syncOrgContext, resyncOrgContext } from './orgContext.js';
import type { OrgContextJson } from './orgContext.js';
import { activateTeamBrainOnLogin } from './activateTeamBrain.js';
import { invalidateCaptureAuthor } from '../brain/captureAuthor.js';

// ── Module-level token store ───────────────────────────────────────
//
// Holds the Supabase access_token for the current Teams session.
// Set by syncTeamsOnLogin / resyncTeams. Cleared on sign-out.
// Never written to disk; lives only in renderer memory.

let _teamsToken: string | null = null;

/** Return the stored Supabase access_token, or null if not in Teams mode. */
export function getTeamsToken(): string | null {
  return _teamsToken;
}

/** Overwrite the stored token (used by sync functions). */
function setTeamsToken(token: string): void {
  _teamsToken = token;
}

/**
 * Clear the stored token on sign-out.
 * Called by useTeamsSync when Supabase emits SIGNED_OUT.
 */
export function clearTeamsToken(): void {
  _teamsToken = null;
  invalidateCaptureAuthor();
}

// ── Team brain activation ──────────────────────────────────────────

/**
 * Activate the team brain from the org context: if the org has a
 * brain_repo_url set in Supabase, clone/switch to it via
 * activateTeamBrainOnLogin. If no URL is set yet (admin hasn't
 * published the brain), this is a no-op — the UI shows the wizard.
 */
async function activateTeamBrainFromOrgContext(ctx: OrgContextJson): Promise<void> {
  if (!isTauri()) return;
  if (!ctx.brainRepoUrl) return;
  await activateTeamBrainOnLogin(ctx.orgId, ctx.brainRepoUrl);
}

// ── Initial sync (call after SIGNED_IN in team scope) ──────────────

/**
 * Fetch the org-context.json payload and write it to the Teams sidecar DATA_DIR.
 * Stores the access_token for subsequent Bearer-authenticated Tauri invocations.
 *
 * No-op (silent) when:
 *   - userId or accessToken is empty
 *   - the user has no org membership (fetchOrgContextData returns null)
 *   - running outside Tauri (syncOrgContext is a no-op outside Tauri)
 *
 * Call-site: useTeamsSync → onAuthStateChange(SIGNED_IN) when scope === 'team'
 */
export async function syncTeamsOnLogin(
  userId: string,
  accessToken: string,
): Promise<void> {
  if (!userId || !accessToken) return;

  try {
    const ctx = await fetchOrgContextData(userId);
    if (!ctx) return; // no org membership — not a Teams user
    await syncOrgContext(ctx);
    await activateTeamBrainFromOrgContext(ctx);
    setTeamsToken(accessToken);
  } catch (err: unknown) {
    console.warn('[teams/authSync] syncTeamsOnLogin failed:', err);
  }
}

// ── Resync (call on TOKEN_REFRESHED or membership change) ──────────

/**
 * Re-fetch org-context.json and re-write it to the Teams sidecar DATA_DIR.
 * Updates the stored access_token.
 *
 * If the user has lost org membership, the token is cleared so that subsequent
 * capture calls fall back to the solo path.
 *
 * Call-site: useTeamsSync → onAuthStateChange(TOKEN_REFRESHED) + after
 *   accept-invite / add-member / remove-member when scope === 'team'.
 */
export async function resyncTeams(
  userId: string,
  accessToken: string,
): Promise<void> {
  if (!userId || !accessToken) return;

  try {
    const ctx = await fetchOrgContextData(userId);
    if (!ctx) {
      // User lost org membership — clear the token so captures fall back to solo
      clearTeamsToken();
      return;
    }
    await resyncOrgContext(ctx);
    await activateTeamBrainFromOrgContext(ctx);
    setTeamsToken(accessToken);
  } catch (err: unknown) {
    console.warn('[teams/authSync] resyncTeams failed:', err);
  }
}

// ── Teams sidecar health check ──────────────────────────────────────

/**
 * Proxy GET /health to the Teams sidecar, passing the stored Bearer token.
 *
 * In TEAMS_AUTH_MODE=supabase the sidecar validates the JWT; passing the
 * access_token here ensures the health check goes through auth.
 *
 * Returns the raw JSON response string, or null on any failure.
 * No-op outside Tauri (returns null).
 */
export async function checkTeamsHealth(): Promise<string | null> {
  if (!isTauri()) return null;
  const token = getTeamsToken();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('teams_health', {
      accessToken: token ?? '',
    });
  } catch (err: unknown) {
    console.warn('[teams/authSync] teams_health check failed:', err);
    return null;
  }
}
