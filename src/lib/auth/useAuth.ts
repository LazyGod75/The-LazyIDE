import { useState, useEffect, useCallback } from 'react';
import type { User, Session, AuthError } from '@supabase/supabase-js';
import { supabase } from '../supabase/client.js';
import { isTauri } from '../platform/index.js';
import { openExternal } from '../platform/openExternal.js';
import { isCloudConfigured } from '../envCloud.js';
import { supabaseAnonKey, supabaseUrl } from '../env.js';

export interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
}

export interface SignUpResult {
  error: string | null;
  /** True when Supabase created the user but no session yet (email confirmation
      is enabled server-side). The UI must then show a "check your email" state. */
  needsConfirmation: boolean;
}

export interface ResendResult {
  error: string | null;
  /** When rate-limited (HTTP 429), the number of seconds to wait before retry. */
  retryAfterSec: number | null;
}

export interface AuthActions {
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  /** Resend the signup confirmation email. */
  resendConfirmation: (email: string) => Promise<ResendResult>;
}

// Custom scheme registered in tauri.conf.json → plugins.deep-link.desktop.schemes
// Must also be added to Supabase Auth → Redirect URLs allowlist.
const DESKTOP_REDIRECT_URI = 'lazy://auth-callback';

// Where Supabase should redirect after the user clicks the confirmation /
// recovery email link. On desktop this is the deep-link scheme handled by
// oauthDesktop.ts; on web it is the current origin.
function authRedirectTo(): string {
  return isTauri() ? DESKTOP_REDIRECT_URI : window.location.origin;
}

// Supabase rate-limits transactional emails (HTTP 429, over_email_send_rate_limit).
// Extract the cooldown so the UI can show a friendly countdown.
function parseRetryAfter(error: AuthError): number | null {
  const isRate =
    error.status === 429 ||
    error.code === 'over_email_send_rate_limit' ||
    /rate limit/i.test(error.message);
  if (!isRate) return null;
  const match = /(\d+)\s*second/i.exec(error.message);
  return match ? Number(match[1]) : 60;
}

export function useAuth(): AuthState & AuthActions {
  const cloud = isCloudConfigured(supabaseUrl, supabaseAnonKey);
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(cloud);

  useEffect(() => {
    if (!cloud) return;

    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [cloud]);

  const signUp = useCallback(async (email: string, password: string): Promise<SignUpResult> => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: authRedirectTo() },
    });
    if (error) {
      return { error: error.message, needsConfirmation: false };
    }
    // With email confirmation enabled, Supabase returns a user but no session.
    return { error: null, needsConfirmation: data.session === null };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (isTauri()) {
      return signInWithGoogleDesktop();
    }
    return signInWithGoogleWeb();
  }, []);

  const resendConfirmation = useCallback(async (email: string): Promise<ResendResult> => {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: authRedirectTo() },
    });
    if (!error) return { error: null, retryAfterSec: null };
    return { error: error.message, retryAfterSec: parseRetryAfter(error) };
  }, []);

  return {
    user,
    session,
    loading,
    signUp,
    signIn,
    signOut,
    signInWithGoogle,
    resendConfirmation,
  };
}

// ── Web flow (unchanged) ──────────────────────────────────────────────────────

async function signInWithGoogleWeb(): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  return { error: error?.message ?? null };
}

// ── Desktop flow (Tauri deep-link + PKCE) ────────────────────────────────────
//
// 1. Call signInWithOAuth with skipBrowserRedirect: true so Supabase returns
//    the authorization URL without navigating the WebView.
// 2. Open the URL in the system browser via openExternal (Tauri shell plugin
//    invoke — see src/lib/platform/openExternal.ts for why this must go
//    through invoke() rather than a dynamic import of the plugin package).
// 3. The user authenticates; Google → Supabase → lazy://auth-callback?code=...
// 4. The OS delivers the URL to this running app; oauthDesktop.ts (onOpenUrl)
//    calls exchangeCodeForSession and the session is picked up by onAuthStateChange.

async function signInWithGoogleDesktop(): Promise<{ error: string | null }> {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: DESKTOP_REDIRECT_URI,
        skipBrowserRedirect: true,
      },
    });

    if (error) {
      return { error: error.message };
    }

    if (!data.url) {
      return { error: 'signInWithOAuth returned no authorization URL' };
    }

    // Open the authorization URL in the system browser.
    await openExternal(data.url);

    // Session will be set asynchronously via the deep-link callback in oauthDesktop.ts.
    return { error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error opening browser';
    return { error: message };
  }
}
