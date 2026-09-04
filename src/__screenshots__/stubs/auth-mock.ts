/* auth-mock.ts — stub for src/lib/auth used in the screenshot harness.
   Returns a fixed user so components render the admin-view branch. */

export interface AuthState {
  user: { id: string; email: string } | null;
  session: null;
  loading: boolean;
}

export interface AuthActions {
  signUp: (email: string, _password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, _password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
}

const MOCK_USER = { id: 'user-admin-001', email: 'alice@acme.com' };

export function useAuth(): AuthState & AuthActions {
  return {
    user: MOCK_USER,
    session: null,
    loading: false,
    signUp: async () => ({ error: null }),
    signIn: async () => ({ error: null }),
    signOut: async () => {},
    signInWithGoogle: async () => ({ error: null }),
  };
}

export function useOAuthCallback() {
  return null;
}
