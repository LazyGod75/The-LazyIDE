/* App — root component. Wraps everything in AppProvider + EditorStoreProvider.
   EditorStoreProvider is at the root so CommandPalette can open files
   without requiring the user to be in CodeSpace first.
*/

import { useEffect } from 'react';
import { AppProvider } from './app/AppContext';
import { I18nProvider } from './i18n';
import { EditorStoreProvider } from './components/editor/editorStore';
import { AppShell } from './components/AppShell';
import { AuthGate } from './components/auth/AuthGate';
import { useOAuthCallback } from './lib/auth/oauthDesktop';
import { readActiveBrainConfigAsync } from './lib/teams/activeBrainConfig';

function App() {
  // Register the Tauri deep-link listener for the OAuth callback.
  // No-op on web; on desktop it handles lazy://auth-callback → Supabase session.
  useOAuthCallback();

  // Hydrate the durable active brain config from disk once at boot so a
  // restart restores the active team brain instead of leaving the cache null.
  useEffect(() => {
    void readActiveBrainConfigAsync().catch(() => { /* best-effort */ });
  }, []);

  // AuthGate is a pass-through on the web build. On desktop it offers
  // sign-in or skip (guest / BYOK / CLI). It lives inside I18nProvider so
  // AuthScreen has translations.
  return (
    <I18nProvider>
      <AppProvider>
        <AuthGate>
          <EditorStoreProvider>
            <AppShell />
          </EditorStoreProvider>
        </AuthGate>
      </AppProvider>
    </I18nProvider>
  );
}

export default App;
