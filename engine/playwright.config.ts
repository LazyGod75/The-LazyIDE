import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for LazyBrain wiki smoke tests.
 *
 * The wiki server is started automatically via webServer.
 * Override the port via E2E_PORT env var (default: 4299 — avoids clash with
 * the dev server on 4242 or any other long-running lazybrain serve instance).
 *
 * If a server is already running on the chosen port, Playwright reuses it
 * instead of trying to spawn a second one (reuseExistingServer: !CI).
 */

const E2E_PORT = Number(process.env.E2E_PORT ?? 4299);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',

  // Individual test timeout — generous for slow CI environments.
  timeout: 30_000,

  // How many times to retry a failed test (0 locally, 1 on CI).
  retries: process.env.CI ? 1 : 0,

  // Run tests sequentially to keep a single server instance stable.
  workers: 1,

  use: {
    baseURL: BASE_URL,
    // Capture screenshots only on failure for faster local runs.
    screenshot: 'only-on-failure',
    // Capture video only on first retry to avoid large CI artefacts.
    video: 'on-first-retry',
    // Trace on first retry for debugging.
    trace: 'on-first-retry',
    // CSP is enforced as-is — the bootstrap has been extracted to /lib/main.js
    // (an external ES module) so `script-src 'self'` no longer blocks it.
    // bypassCSP must remain absent so the test exercises real CSP behaviour.
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // Launch the wiki against the brain.
    //
    // Brain path resolution order (highest priority first):
    //   1. E2E_BRAIN env var — explicit override (e.g. a dedicated test brain)
    //   2. Repo-embedded .lazybrain — present when running from source
    //   3. Default lazybrain brain — used when no override is set
    //
    // The --brain flag goes BEFORE the `serve` sub-command so that Commander
    // picks it up as a global option (sets LAZYBRAIN_BRAIN_PATH_CLI internally).
    //
    // tsx resolves TypeScript so no prior `npm run build` is needed.
    command: process.env.E2E_BRAIN
      ? `npx tsx bin/lazybrain.ts --brain ${process.env.E2E_BRAIN} serve --port ${E2E_PORT}`
      : `npx tsx bin/lazybrain.ts serve --port ${E2E_PORT}`,
    url: BASE_URL,
    // Allow up to 20 s for the server to start (it loads SQLite + FTS index,
    // and tsx compilation adds a few seconds on first run).
    timeout: 20_000,
    // Reuse an already-running server when developing locally; in CI always
    // start a fresh one.
    reuseExistingServer: !process.env.CI,
    // Suppress server stdout so test output stays readable.
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
