//! Sidecar readiness polling (`wait_ready_at`) and the background recall
//! pre-warm fired the moment a freshly-spawned sidecar is declared healthy.

use std::sync::atomic::Ordering;

use super::SHUTTING_DOWN;
use crate::commands::brain::sidecar::state::http_client_with_timeout;

/// Poll a real 200 endpoint every 500 ms until the server responds (up to 5 s).
/// Free-function twin of `BrainSidecar::wait_ready` (which delegates here),
/// taking a `(port, token)` snapshot instead of `&self` so it can run
/// WITHOUT holding `&self` — and therefore without holding whatever
/// `MutexGuard` a caller obtained `self` through. See
/// `start_or_restart_brain_sidecar` below for why that matters: it is the
/// entire reason this function exists rather than being inlined back into
/// `wait_ready`.
pub(crate) fn wait_ready_at(port: u16, token: &str) -> bool {
    let url = format!("http://127.0.0.1:{}/_api/search?q=ping&top=1", port);
    let client = reqwest::blocking::Client::new();
    for attempt in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        match client.get(&url).header("Authorization", format!("Bearer {}", token)).send() {
            Ok(resp) if resp.status().is_success() => {
                log::info!("LazyBrain sidecar ready (port={}, attempt={})", port, attempt + 1);
                return true;
            }
            Ok(resp) => {
                log::debug!(
                    "LazyBrain sidecar readiness probe returned {} (attempt {})",
                    resp.status(),
                    attempt + 1
                );
            }
            Err(e) => {
                log::debug!(
                    "LazyBrain sidecar readiness connect failed: {} (attempt {})",
                    e,
                    attempt + 1
                );
            }
        }
    }
    log::warn!("LazyBrain sidecar did not become ready within 5 s (port={}) — continuing", port);
    false
}

/// Representative natural-language query used to pre-warm the turn-mode
/// recall pipeline (see `spawn_brain_recall_warmup`). Deliberately shaped —
/// but NOT deliberately meaningful, see below — like a real per-turn
/// assistant question:
///   - 3 to 15 whitespace tokens, no quoted phrase, so the engine's
///     `pickLevel` (retrieval/router.ts) routes it to `L2_L3_HYBRID` — the
///     SAME level (and therefore the SAME listAllWithText()/
///     loadAllStoredEmbeddings()/loadBacklinks() first-call cost) that
///     almost every real first message hits.
///   - >= 12 chars and >= 3 real words so `isTrivialPrompt`
///     (inject-context/scoring.ts) never short-circuits it before `route()`
///     ever runs.
///   - Does NOT start with why/how/what/when/should/can/could/would/is/
///     fix:/error: — every one of those is an earlier routing shortcut in
///     router.ts (Phase 2-4c: path-prefix, negative-memory, error-pattern,
///     Q-pattern) that can return BEFORE Phase 5's level dispatch — i.e.
///     before `listAllWithText()` ever runs — which would silently defeat
///     this whole warmup.
///   - Leads with an invented, deliberately-unique token so it can never
///     accidentally substring-match a real project/topic name and trigger
///     `tryFeatureMapInject`'s fast path (inject-context/session-inject.ts),
///     which — like the routing shortcuts above — answers from a cheap
///     local heuristic scan instead of ever calling `route()`.
const BRAIN_WARMUP_QUERY: &str = "xqzwarmupinternal recall pipeline cache priming diagnostic check";

/// Fire a single background, best-effort turn-mode recall against a
/// just-declared-healthy sidecar so the FIRST expensive query pays its cost
/// during project open instead of during the user's first message.
///
/// Why this exists: the engine's own boot-time warmup (`commands/serve.ts`'s
/// `embedderWarmupStart` block) only loads the ONNX embedding model — a
/// measured ~2.4 s, not the bottleneck. The actual turn-mode recall pipeline
/// (`/_api/recall`, `runTurnInjectDetailed` → `route(..., hydrateNote:
/// true)`) additionally pays a large ONE-TIME per-process cost the first
/// time it runs: the engine's `corpus-cache.ts`/`note-read.ts` freshness-
/// gated caches for `listAllWithText()`/`loadAllStoredEmbeddings()` are
/// empty on a fresh sidecar process and only get populated by whichever
/// query runs first — measured at 40-177 s on a realistic 5881-note/324 MB
/// brain (vs. 0.6-1 s once warm), and growing with corpus size. Without
/// this warmup, that cost lands on the user's actual first message, which
/// is exactly the "brain timed out on both attempts, working with no
/// memory" failure this fix addresses. `wait_ready_at`'s own health probe
/// (`q=ping`) never triggers it: a 1-token query is always routed to plain
/// keyword L2 and never calls `hydrateNote`/`listAllWithText` at all.
///
/// Never blocks the caller: spawns its own OS thread and returns
/// immediately — the project-open path this is called from must stay fast.
/// Never surfaces an error to the user: every outcome (start, success,
/// non-2xx, transport failure) is only ever logged, at debug/info/warn
/// level — see this function's log lines below.
///
/// Fires exactly once per sidecar lifecycle: the only two call sites are the
/// `wait_ready_at` success branches in `start_or_restart_brain_sidecar`,
/// which is the sole place a NEW child process is ever declared healthy —
/// so there is no separate "already warmed" flag to keep in sync; a later
/// project switch that spawns another fresh child naturally gets its own
/// warmup call for that child's own cold caches.
///
/// Harmless if the app closes mid-flight: this is a plain OS thread with no
/// `JoinHandle` kept anywhere, torn down with the rest of the process on
/// exit like every other detached background thread in this codebase; nothing
/// waits on it, nothing retries it, and it never touches `BrainState`.
pub(crate) fn spawn_brain_recall_warmup(port: u16, token: String) {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        // Re-check: a shutdown that started between the caller's check above
        // and this thread actually getting scheduled should still skip
        // firing a brand new HTTP request into a sidecar that may already
        // be on its way down.
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }
        let start = std::time::Instant::now();
        log::debug!("brain sidecar warmup: starting background recall warmup (port={})", port);
        let url = format!(
            "http://127.0.0.1:{}/_api/recall?q={}&maxTokens=16&nudge=tool",
            port,
            urlencoding::encode(BRAIN_WARMUP_QUERY)
        );
        // Generous timeout: this call exists specifically to absorb the
        // worst-case cold first-query cost (measured up to ~177 s — see doc
        // comment above), not to bound it. A client-side timeout here would
        // not stop the sidecar's own SQLite work anyway (better-sqlite3 runs
        // synchronously, un-abortable once started) — it would only cost us
        // an accurate success/duration log line.
        let client = http_client_with_timeout(240);
        let result = client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            // Tags this as a synthetic internal call so recall.ts (server/
            // routes/recall.ts) skips its telemetry write — this warmup
            // ping is cache-priming, not a real user query, and must not
            // inflate Settings > Memory's "Queries (24h)" diagnostic.
            .header("X-Lazy-Warmup", "1")
            .send();
        let elapsed = start.elapsed();
        match result {
            Ok(resp) if resp.status().is_success() => {
                log::info!(
                    "brain sidecar warmup: background recall warmup succeeded in {:?} (port={})",
                    elapsed, port
                );
            }
            Ok(resp) => {
                log::warn!(
                    "brain sidecar warmup: background recall warmup returned {} after {:?} (port={})",
                    resp.status(), elapsed, port
                );
            }
            Err(e) => {
                log::warn!(
                    "brain sidecar warmup: background recall warmup failed after {:?} (port={}): {}",
                    elapsed, port, e
                );
            }
        }
    });
}
