import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    headless: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // Use a web-mode vite config that stubs @tauri-apps/plugin-shell so
    // the dev server resolves cleanly without a Tauri runtime installed.
    // NOTE: this suite runs the MOCKED web build, not the real Tauri desktop
    // app — results here are not desktop guarantees.
    command: 'npx vite --config e2e/vite-web.config.ts --port 5173',
    url: 'http://localhost:5173',
    // Reuse a local dev server for speed, but never in CI: reusing an
    // existing server there risks silently attaching to a stale process
    // already bound to :5173 and testing the wrong state with no signal.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
