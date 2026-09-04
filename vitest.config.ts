import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// See vite.config.ts for the full rationale — kept identical here so tests
// see the same import.meta.env.__APP_VERSION__ value dev/build does.
const pkgVersion: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version;

export default defineConfig({
  define: {
    'import.meta.env.__APP_VERSION__': JSON.stringify(pkgVersion),
  },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['src/__tests__/setup.ts'],
    globals: true,
    clearMocks: true,
    // The suite's product code intentionally logs a lot (managerEngine,
    // missionQueue, devPreview, etc. all trace real decisions — several
    // tests assert on exactly this output). Vitest's default console
    // interception ships EVERY one of those console calls back to the main
    // orchestrator process over the SAME birpc/IPC channel used for
    // module transforms and task lifecycle RPCs (fetch/resolveId/
    // onTaskUpdate/snapshotSaved — see console.BYGVloWk.js's
    // state().rpc.onUserConsoleLog). Under the full suite's ~11 parallel
    // forks (numCpus-1), that shared channel gets congested enough that
    // unrelated RPC calls miss vitest's own internal 60s birpc timeout —
    // observed directly as "[vitest-worker]: Timeout calling fetch/
    // resolveId/onTaskUpdate/snapshotSaved" on a rotating set of files that
    // all pass individually (the CI-blocking flake). Disabling interception
    // lets each worker write straight to its own inherited stdout/stderr
    // pipe (a channel separate from the IPC one), removing that traffic
    // from the RPC path entirely. In-test console assertions
    // (vi.spyOn(console, 'warn'), etc.) are unaffected — they wrap
    // whichever console object exists, intercepted or not.
    disableConsoleIntercept: true,
    exclude: ['**/.claude/**', '**/.lazy/**', 'node_modules/**', 'dist/**', 'src-tauri/**', 'e2e/**', 'engine/**', 'bench/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/__tests__/**',
        'src/cli/**',
        'src/lib/platform/tauri.ts',
      ],
    },
  },
});
