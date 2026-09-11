import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Single source of truth for the running app's version, read once at
// config-eval time from package.json (kept in lockstep with tauri.conf.json's
// "version" field — the two are bumped together at release time). Exposed to
// the frontend as import.meta.env.__APP_VERSION__ via the `define` block
// below, consumed by SettingsSpace.tsx's currentVersion label. Previously
// this constant was referenced in a comment but never actually wired up —
// __APP_VERSION__ was always undefined, so the settings page silently showed
// its hardcoded last-resort fallback ('0.1.0') regardless of the real
// shipping version.
const pkgVersion: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version

// CodeMirror is only loaded by EditorPane, itself lazy (only mounts once the
// Code space opens) — see manualChunks and modulePreload.resolveDependencies
// below, which both read this name so the "what's grouped" and "what's
// excluded from eager preload" decisions can't drift apart.
const VENDOR_CODEMIRROR_CHUNK = 'vendor-codemirror'
const VENDOR_THREE_CHUNK = 'vendor-three'

// Vendor chunks that belong to a single lazy-loaded space and must never be
// eagerly <link rel=modulepreload>'d from the root index.html. Add future
// per-space vendor chunks here (not just to manualChunks) so they stay
// excluded from the eager preload list too.
// elkjs is only ever reached through dynamic import() call sites
// (agentsStore's draft-plan layout, the canvas arrange path inside the lazy
// AgentsSpace chunk, and the preview-layout Worker) — never statically from
// the entry graph — so its vendor chunk must never be eagerly preloaded
// either. Listed here so a future static import cannot silently regress it
// back into the boot path.
const LAZY_SPACE_VENDOR_CHUNKS = [VENDOR_CODEMIRROR_CHUNK, VENDOR_THREE_CHUNK, 'vendor-elkjs']

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const anthropicKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || ''

  return {
  define: {
    'import.meta.env.__APP_VERSION__': JSON.stringify(pkgVersion),
  },
  resolve: {
    dedupe: ['three'],
  },
  // WebView2 (Edge) has supported top-level await for years. Vite's default
  // esbuild target (chrome87) cannot parse @novnc/novnc's TLA and kills the
  // entire `npm run dev` process during dep-scan of desktopViewer.ts.
  esbuild: { target: 'es2022' },
  optimizeDeps: {
    include: ['three', '3d-force-graph', 'three-spritetext'],
    exclude: ['patchright-core', 'playwright-core', 'chromium-bidi', 'playwright', '@novnc/novnc'],
    esbuildOptions: { target: 'es2022' },
    // Only scan src/ for deps — prevents Vite from trying to pre-bundle
    // playwright/patchright imported by _qa-manager.mjs at the repo root.
    entries: ['src/**/*.tsx', 'src/**/*.ts'],
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    // Windows often binds Vite's default `localhost` to IPv6 (::1) only,
    // so 127.0.0.1:5173 refused while localhost:5173 worked — and the
    // brain proxy target is IPv4 127.0.0.1:7700. Listen on 0.0.0.0 so
    // both addresses reach the same app.
    host: true,
    watch: {
      // 2026-08-04 (QA dogfood — the app hot-reloaded in a LOOP, killing
      // every in-flight plan execution): the QA harness's own scratch files
      // (_qa-*.mjs/_qa-*.js/_qa-*.log) live in the repo root, and vite's
      // dev watcher treats any root change as a reason to reload the app.
      // Exclude them so QA probes/logs never interrupt a running app.
      // 2026-08-06 (same loop, second source): .lazy/worktrees/ and
      // .claude/worktrees/ hold live agent worktrees whose own tsconfig/src
      // churn (agent missions writing continuously) made vite purge its
      // cache and force full-reloads on the real app in a loop — the app
      // appeared to hang on a blank screen while agents were running.
      // Excluded too: those trees are separate git checkouts the app never
      // imports at build time (the agent runtime reaches them through the
      // Rust backend, not vite).
      ignored: ['**/_qa-*', '**/dist/**', '**/src-tauri/target/**', '**/.lazy/**', '**/.claude/worktrees/**'],
    },
    proxy: {
      '/_api': {
        target: 'http://127.0.0.1:7700',
        changeOrigin: true,
        timeout: 2000,
        proxyTimeout: 2000,
      },
      '/health': {
        target: 'http://127.0.0.1:7700',
        changeOrigin: true,
        timeout: 2000,
        proxyTimeout: 2000,
      },
      '/anthropic-api': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/anthropic-api/, ''),
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      },
      // Solari cloud (browsers / VM desktops / sandboxes). The browser view is
      // same-origin here, so CORS never applies; Vite forwards to the gateway
      // server-side. The SDK's control/stream URLs stay absolute (wss://) and
      // are unaffected by this proxy.
      '/solari-api': {
        target: 'https://api.getsolari.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/solari-api/, ''),
      },
      // Solari CDP/ws browser sessions. The gateway 403s any WebSocket handshake
      // carrying an Origin header (verified: no-origin opens, any Origin 403s),
      // and a browser WebSocket always sends Origin. So the app dials a
      // same-origin ws:// URL here and Vite strips the Origin before forwarding
      // upstream — mirrors what the SDK's local proxy does in Node.
      '/solari-cdp': {
        target: 'wss://api.getsolari.com',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/solari-cdp/, ''),
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            proxyReq.removeHeader('origin');
            proxyReq.setHeader('host', 'api.getsolari.com');
          });
        },
      },
    },
  },
  build: {
    target: 'es2022',
    modulePreload: {
      // PERF FIX: by default Vite's index.html eagerly <link rel=modulepreload>s
      // every vendor chunk it can reach from the entry — including
      // vendor-codemirror (770KB), even though it's only ever imported
      // dynamically, from EditorPane, which only mounts once the Code space
      // opens (see the manualChunks grouping below). That means WebView2 was
      // parsing/compiling 770KB of CodeMirror on EVERY cold start, whether or
      // not the user ever opens the Code space this session.
      //
      // resolveDependencies is the escape hatch for exactly this case: it
      // only affects the HTML-level preload list (hostType 'html'), i.e. what
      // dist/index.html itself preloads at boot. JS-to-JS preloading
      // (hostType 'js' — e.g. CodeSpace's own chunk preloading EditorPane's
      // dependencies once the Code space actually mounts) is left untouched,
      // so CodeMirror still gets its normal preload hint at the point it's
      // genuinely about to be used.
      resolveDependencies: (_filename, deps, { hostType }) => {
        if (hostType !== 'html') return deps;
        return deps.filter((dep) => !LAZY_SPACE_VENDOR_CHUNKS.some((name) => dep.includes(name)));
      },
    },
    rollupOptions: {
      // CAUTION: marking a @tauri-apps/plugin-* package external does NOT mean
      // "Tauri resolves it at runtime" — there is no such runtime resolution
      // in the webview. It means Rollup leaves any `import('@tauri-apps/plugin-x')`
      // in the output as a literal, unresolved bare specifier, which throws
      // "Failed to resolve module specifier" in the packaged app (confirmed via
      // `npm run build` + grep on dist/assets/*.js).
      //
      // This bit every first-party plugin the app dynamic-imports:
      // - plugin-shell (openExternal.ts): caused the "Passer à Pro" button to
      //   silently do nothing (window.open fallback, which WebView2 never
      //   escalates to the system browser). Fixed by calling
      //   @tauri-apps/api/core's invoke('plugin:shell|open', ...) directly
      //   instead of importing the JS wrapper — nothing imports plugin-shell
      //   anymore, so it stays out of this array.
      // - plugin-os (src/i18n/index.tsx), plugin-updater and plugin-process
      //   (src/lib/updater.ts): the identical throw-on-import bug — silently
      //   broke first-run OS-locale detection and made the auto-updater
      //   (check/download/install/relaunch) permanently non-functional in the
      //   packaged app. Fixed by simply removing them from `external` below.
      //   Unlike plugin-shell, no call-site change was needed: these packages
      //   are nothing but thin invoke() wrappers (see node_modules/@tauri-apps/
      //   plugin-{os,updater,process}/dist-js/index.js), so Vite bundles them
      //   cleanly once they're not marked external, and the existing dynamic
      //   imports resolve for real.
      //
      // Keep this array empty of @tauri-apps/plugin-* entries. If a future
      // one genuinely cannot be bundled (an actual Vite build error, not a
      // hunch), prefer the invoke()-direct approach from openExternal.ts
      // over re-adding it here — either way, verify with `npm run build` +
      // grep on dist/assets/*.js for the literal `import("@tauri-apps/plugin-`
      // specifier.
      //
      // 'node:vm' is a DIFFERENT case, not a Tauri plugin: it's
      // transformSandbox.ts's Node-only fallback path (used by Vitest/jsdom,
      // which has no browser Worker — see that module's header), reached
      // ONLY behind a `typeof Worker !== 'function'` runtime guard that is
      // never true in this browser app. Left unlisted, Vite's default
      // Node-builtin auto-externalization already produces a working (if
      // never-executed) stub and merely prints an informational warning;
      // listing it here explicitly suppresses that warning without changing
      // the resulting bundle at all — this entry is safe to keep, unlike a
      // Tauri plugin external (which would break a call site actually
      // reached at runtime).
      external: ['node:vm'],
      output: {
        manualChunks(id) {
          // CodeMirror — only loaded by EditorPane (lazy). Three.js /
          // 3d-force-graph live in vendor-three (Brain WebGL vault) and are
          // listed in LAZY_SPACE_VENDOR_CHUNKS so they are not eagerly
          // preloaded from index.html.
          if (
            id.includes('node_modules/@codemirror') ||
            id.includes('node_modules/@uiw/react-codemirror') ||
            id.includes('node_modules/@uiw/codemirror') ||
            id.includes('node_modules/@lezer')
          ) {
            return VENDOR_CODEMIRROR_CHUNK;
          }
          if (
            id.includes('node_modules/three') ||
            id.includes('node_modules/3d-force-graph') ||
            id.includes('node_modules/three-spritetext')
          ) {
            return VENDOR_THREE_CHUNK;
          }
          // fix/canvas-node-layout (2026-08) — genuine Rollup automatic-
          // chunk-splitting bug, root-caused by bisecting `npm run build`
          // itself (not app logic: `tsc -b` and `npx vitest run` both stay
          // green throughout every step of this bisection). layout.ts has
          // two elkjs paths: the synchronous main-thread one (layoutZone/
          // layoutAll/laneLayout/layoutDraftGraphInZone, elk.bundled.js) and
          // the in-chat-preview one that offloads to a real Worker
          // (layoutPreviewGraph -> previewLayoutWorkerClient.ts's `new
          // Worker(new URL('./elkLayoutWorker.ts', import.meta.url))`,
          // elk-api.js + elk-worker.min.js). Empirically (bisected call site
          // by call site in agentsStore.tsx), WHICH of those two paths is
          // reachable from WHICH caller changes Rollup's own automatic
          // (non-manual) chunk-splitting decision for elkjs's shared
          // internals — and at least one such combination makes Rollup emit
          // a genuinely invalid root chunk that statically `import`s
          // bindings from the unrelated `vendor-codemirror` manual chunk
          // above, caught by Vite's `vite:build-import-analysis` pass as
          // `Parse error @:1:1` on the emitted entry file (not a warning —
          // the build fails outright). Pinning ALL of elkjs (both the
          // main-thread bundle and the Worker-side/API modules) into ONE
          // explicit chunk removes that ambiguity outright, independent of
          // which layout.ts export any given caller happens to use — see
          // this fix's commit message for the exact bisection trail. It IS
          // in LAZY_SPACE_VENDOR_CHUNKS: the last static entry-graph import
          // was removed (agentsStore's draft-plan layout now dynamic-imports
          // it), so the 1.4MB chunk must not be eagerly preloaded at boot —
          // it loads on first actual canvas/draft use.
          if (id.includes('node_modules/elkjs')) {
            return 'vendor-elkjs';
          }
        },
      },
    },
  },
  }
})
