import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted fonts (D10): npm packages, bundled by Vite — no runtime
// dependency on Google Fonts/any CDN (required for the offline-capable
// Tauri desktop app). Only the weights the design system actually uses.
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import './index.css'
import App from './App.tsx'
// QA fix (B3): re-apply the user's persisted accent-color choice (if any)
// before the first render, so there is no flash of the design system's
// default violet — see src/lib/theme/accentTheme.ts.
import { initAccentOnBoot } from './lib/theme/accentTheme'
// Memory-pressure hardening: install window.onerror/unhandledrejection
// capture BEFORE createRoot, so even a crash during the very first render
// (or a render-crash-loop) is journaled — see src/lib/crashReporter.ts.
import { installCrashReporter } from './lib/crashReporter'
// Memory-pressure hardening: watch the renderer's own JS heap and emit
// lazy:memory-pressure so consumers can shed state before an OOM crash —
// see src/lib/agents/memoryGuardian.ts.
import { startMemoryGuardian } from './lib/agents/memoryGuardian'
// Secret-storage hardening (audit 2026-08-12): on desktop, warms the
// synchronous BYOK-key cache from the OS credential vault and — the first
// time a user launches a build with this change — silently migrates any
// `lazy.apikey.*` value still sitting in localStorage into the vault, then
// removes the plaintext copy. No-op in the browser build (no OS vault to
// warm).
//
// AWAITED before the first render (live-app regression, 2026-08-12: a user
// could reach the model picker and send a BYOK mission before this
// resolved, routing to the wrong engine with a cold cache — see
// byokProviders.ts's initByokVault doc comment for the fuller root cause).
// This dependency is real and CONFIRMED, not assumed: loadByokKey/hasByokKey
// (read synchronously by resolveByokAgentTurnStreamer, createOpenAICompatProvider,
// scheduler.ts, anthropicProvider.ts, SettingsSpace.tsx) only see a warmed
// cache once this resolves, so moving this off the first-paint path would
// reintroduce the exact 2026-08-12 bug (blank-but-fast paint, then the
// model picker races the cache warm) — deliberately left synchronous here
// (perf audit 2026-08-15, item 2).
//
// Perf audit 2026-08-15: this comment used to assert the wait was
// "negligible" without ever measuring it. What IS measured (see
// src/__tests__/byokVaultInit.perf.test.ts): the per-provider vault reads
// inside initByokVault() run in PARALLEL (Promise.allSettled), so wall time
// stays close to a SINGLE round trip regardless of how many BYOK providers
// exist (7+ today) — not one that grows per provider. What is NOT measured
// here: the real OS-credential-vault IPC latency itself, which only exists
// inside a live Tauri desktop process (no OS vault, no
// window.__TAURI_INTERNALS__, in this browser/vitest/CI environment) — so
// "negligible in practice" is a claim about parallel fan-out shape, not a
// verified millisecond figure for a real cold boot.
import { initByokVault } from './lib/models/byokProviders'
// Pre-warm manager critical-path dependencies (core prompt + project root)
// AFTER first render — see prewarm.ts's doc comment for what/why.
import { prewarmManager } from './lib/agents/prewarm'

installCrashReporter()
startMemoryGuardian()
initAccentOnBoot()

async function bootstrap(): Promise<void> {
  // Real-boot instrumentation (perf audit 2026-08-15): the ms figure this
  // module's own doc comment above says was never measured can ONLY come
  // from a live Tauri desktop boot (no OS credential vault exists in
  // vitest/CI). Logged unconditionally — this runs exactly once per app
  // launch, so it is not log spam — so the next real desktop session
  // produces the number instead of another unverified assertion.
  const byokVaultStart = performance.now()
  try {
    await initByokVault()
  } catch (err: unknown) {
    console.error('[main] initByokVault failed', err instanceof Error ? err.message : String(err))
  } finally {
    console.info(`[main] initByokVault took ${(performance.now() - byokVaultStart).toFixed(1)}ms`)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  // Fire-and-forget: pre-warm the manager's core prompt (~120KB string
  // build) and project root IPC cache so the first user message's critical
  // path is shorter. Runs AFTER render so it never blocks first paint.
  prewarmManager()
}

void bootstrap()
