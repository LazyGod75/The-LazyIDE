/**
 * oauthDesktop.ts — Tauri v2 deep-link OAuth callback handler.
 *
 * How it works:
 * 1. signInWithGoogle (useAuth) opens the Supabase authorization URL in the
 *    system browser with redirectTo = 'lazy://auth-callback'.
 * 2. After the user authenticates, Google redirects to Supabase, which
 *    redirects to lazy://auth-callback?code=<pkce_code> (PKCE flow).
 * 3. The OS routes the custom scheme back to this running Tauri app.
 * 4. onOpenUrl fires; this module parses the URL and exchanges it for a
 *    Supabase session.
 * 5. supabase.auth.onAuthStateChange picks up the new session and updates
 *    the useAuth hook automatically.
 *
 * This module is imported only from App.tsx (useOAuthCallback hook).
 * It is a no-op when called outside Tauri (isTauri() === false).
 *
 * Fix 5 (security): the implicit-flow branch (lazy://auth-callback
 * #access_token=...&refresh_token=...) has been removed. It parsed tokens
 * straight off the URL fragment and called supabase.auth.setSession()
 * unconditionally, with no state/nonce binding back to the flow that
 * initiated sign-in — any process able to invoke the lazy:// custom scheme
 * with an attacker-supplied access_token/refresh_token pair could have
 * injected a session. The PKCE code branch below is safe (the code is
 * single-use and bound to a verifier held only by this app instance) and is
 * the only flow Supabase's authorization URL actually issues for this app
 * (redirectTo = 'lazy://auth-callback' with the default PKCE flow type) —
 * nothing in this codebase depended on the implicit-flow branch.
 */

import { useEffect } from 'react';
import type { EmailOtpType } from '@supabase/supabase-js';
import { isTauri } from '../platform/index.js';
import { supabase } from '../supabase/client.js';

const DEEP_LINK_CALLBACK_HOST = 'auth-callback';

type ParsedOAuthUrl =
  | { code: string }
  | { tokenHash: string; type: EmailOtpType };

/**
 * Parse a deep-link URL and extract the PKCE code or the email OTP token
 * (signup / recovery confirmation links).
 *
 * Returns null when the URL is not an auth callback — so non-auth deep links
 * are silently ignored.
 */
function parseOAuthUrl(raw: string): ParsedOAuthUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  // Only handle lazy://auth-callback
  if (parsed.hostname !== DEEP_LINK_CALLBACK_HOST) {
    return null;
  }

  // PKCE flow (OAuth): lazy://auth-callback?code=<code>
  const code = parsed.searchParams.get('code');
  if (code) {
    return { code };
  }

  // Email confirmation / recovery: lazy://auth-callback?token_hash=...&type=signup
  const tokenHash = parsed.searchParams.get('token_hash');
  const type = parsed.searchParams.get('type');
  if (tokenHash && type) {
    return { tokenHash, type: type as EmailOtpType };
  }

  return null;
}

/**
 * Process a single deep-link URL. Exchanges it for a Supabase session.
 * Errors are logged and silently swallowed — auth failures are surfaced via
 * the normal onAuthStateChange flow returning null session.
 */
async function handleDeepLinkUrl(url: string): Promise<void> {
  const parsed = parseOAuthUrl(url);
  if (!parsed) return;

  try {
    if ('code' in parsed) {
      // PKCE flow (OAuth)
      const { error } = await supabase.auth.exchangeCodeForSession(parsed.code);
      if (error) {
        console.error('[oauthDesktop] exchangeCodeForSession failed:', error.message);
      }
    } else {
      // Email confirmation / recovery link
      const { error } = await supabase.auth.verifyOtp({
        token_hash: parsed.tokenHash,
        type: parsed.type,
      });
      if (error) {
        console.error('[oauthDesktop] verifyOtp failed:', error.message);
      }
    }
  } catch (err: unknown) {
    console.error('[oauthDesktop] unexpected error processing deep link:', err);
  }
}

/**
 * React hook — mount once in App.tsx.
 *
 * On Tauri:
 * - Registers the onOpenUrl listener for hot-start (app already running).
 * - Also checks getCurrent() to handle the cold-start case (app launched
 *   directly via the deep link).
 *
 * On web: complete no-op (isTauri() === false).
 */
export function useOAuthCallback(): void {
  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;

    async function setup(): Promise<void> {
      // Lazy-import so the module is never bundled in web builds.
      const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');

      // Cold-start: app was launched via the deep link.
      const startUrls = await getCurrent();
      if (startUrls) {
        for (const url of startUrls) {
          await handleDeepLinkUrl(url);
        }
      }

      // Hot-start: app is already running; OS sends the URL via the event.
      const off = await onOpenUrl(async (urls: string[]) => {
        for (const url of urls) {
          await handleDeepLinkUrl(url);
        }
      });

      unlisten = off;
    }

    setup().catch((err: unknown) => {
      console.error('[oauthDesktop] setup failed:', err);
    });

    return () => {
      unlisten?.();
    };
  }, []);
}
