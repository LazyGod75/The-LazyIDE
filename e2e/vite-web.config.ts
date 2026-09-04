/**
 * vite-web.config.ts — Vite config for E2E tests (web/browser mode).
 * Extends the root vite.config with an alias that mocks @tauri-apps/plugin-shell
 * so the dev server resolves cleanly without a Tauri runtime.
 *
 * Used exclusively by playwright.config.ts via `--config e2e/vite-web.config.ts`.
 */

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Vite plugin that serves mock brain graph data for E2E tests.
// Self-contained — does not depend on a running brain server.
const MOCK_NODES = [
  { id: 'auth-oauth2-pkce', title: 'Migration OAuth2 PKCE', type: 'decision', topic: 'Auth', importance: 0.9, cluster: 'Auth' },
  { id: 'auth-bug-342', title: 'Bug #342 handler dupliqué', type: 'bug', topic: 'Auth', importance: 0.7, cluster: 'Auth' },
  { id: 'auth-base-handler', title: 'BaseHandler', type: 'concept', topic: 'Auth', importance: 0.8, cluster: 'Auth' },
  { id: 'auth-ts', title: 'auth.ts', type: 'file', topic: 'Auth', importance: 0.5, cluster: 'Auth' },
  { id: 'auth-strategy', title: 'Stratégie Auth', type: 'concept', topic: 'Auth', importance: 0.6, cluster: 'Auth' },
  { id: 'payment-module', title: 'Module Paiement', type: 'module', topic: 'Paiement', importance: 0.8, cluster: 'Paiement' },
  { id: 'payment-webhooks', title: 'Stripe webhooks idempotency', type: 'decision', topic: 'Paiement', importance: 0.7, cluster: 'Paiement' },
  { id: 'payment-checkout', title: 'Checkout flow', type: 'concept', topic: 'Paiement', importance: 0.5, cluster: 'Paiement' },
  { id: 'tests-vitest', title: 'Migration Vitest', type: 'decision', topic: 'Tests', importance: 0.6, cluster: 'Tests' },
  { id: 'tests-coverage', title: 'Couverture 80%', type: 'concept', topic: 'Tests', importance: 0.5, cluster: 'Tests' },
  { id: 'infra-postgres', title: 'Postgres vs SQLite', type: 'decision', topic: 'Infra', importance: 0.9, cluster: 'Infra' },
  { id: 'infra-rate-limit', title: 'Rate Limiting', type: 'decision', topic: 'Infra', importance: 0.6, cluster: 'Infra' },
  { id: 'ui-design-system', title: 'Design System', type: 'concept', topic: 'UI', importance: 0.7, cluster: 'UI' },
  { id: 'ui-theme', title: 'Theme dark/light', type: 'decision', topic: 'UI', importance: 0.5, cluster: 'UI' },
];

const MOCK_EDGES = [
  { from: 'auth-oauth2-pkce', to: 'auth-bug-342', type: 'suit' },
  { from: 'auth-oauth2-pkce', to: 'auth-base-handler', type: 'uses' },
  { from: 'auth-oauth2-pkce', to: 'auth-strategy', type: 'refines' },
  { from: 'auth-base-handler', to: 'auth-ts', type: 'implements' },
  { from: 'auth-bug-342', to: 'auth-base-handler', type: 'follows' },
  { from: 'payment-module', to: 'payment-webhooks', type: 'contains' },
  { from: 'payment-module', to: 'payment-checkout', type: 'contains' },
  { from: 'payment-webhooks', to: 'infra-postgres', type: 'uses' },
  { from: 'tests-vitest', to: 'tests-coverage', type: 'improves' },
  { from: 'auth-oauth2-pkce', to: 'infra-rate-limit', type: 'depends' },
  { from: 'ui-design-system', to: 'ui-theme', type: 'implements' },
];

const MOCK_NOTE_META: Record<string, { id: string; title: string; type: string; topic: string | null; tags: string; importance: number; created: string | null }> = {
  'auth-oauth2-pkce': { id: 'auth-oauth2-pkce', title: 'Migration OAuth2 PKCE', type: 'decision', topic: 'Auth', tags: '#auth,#security,#oauth', importance: 0.9, created: '2026-03-14' },
  'auth-bug-342': { id: 'auth-bug-342', title: 'Bug #342 handler dupliqué', type: 'bug', topic: 'Auth', tags: '#bug,#auth', importance: 0.7, created: '2026-03-10' },
  'payment-module': { id: 'payment-module', title: 'Module Paiement', type: 'module', topic: 'Paiement', tags: '#stripe,#payments', importance: 0.8, created: '2026-04-01' },
};

function brainMockApi(): Plugin {
  return {
    name: 'brain-mock-api',
    configureServer(server) {
      server.middlewares.use('/_api/graph', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ nodes: MOCK_NODES, edges: MOCK_EDGES }));
      });
      server.middlewares.use('/_api/note-meta', (req, res) => {
        const url = req.url ?? '';
        const id = url.split('/').pop()?.split('?')[0] ?? '';
        const meta = MOCK_NOTE_META[decodeURIComponent(id)];
        res.setHeader('Content-Type', 'application/json');
        if (meta) {
          res.end(JSON.stringify(meta));
        } else {
          res.statusCode = 404;
          res.end('{"error":"not found"}');
        }
      });
      server.middlewares.use('/_api/note', (req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end('<section data-section="tldr">Mock note content for E2E testing.</section>');
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    brainMockApi(),
  ],
  resolve: {
    alias: {
      // Provide a minimal stub so dynamic `import('@tauri-apps/plugin-shell')`
      // resolves at dev time without throwing. The real checkout.ts already
      // wraps the import in a try/catch and falls back to window.open.
      '@tauri-apps/plugin-shell': path.resolve(
        import.meta.dirname,
        'stubs/tauri-plugin-shell.ts',
      ),
    },
  },
  build: {
    rollupOptions: {
      external: ['@tauri-apps/plugin-shell'],
    },
  },
});
