/* transformSandbox.ts — W-CODE (canvas scorecard §4.5 "BYO agents", the
   FINAL genuinely-open slice): SAFE-BY-CONSTRUCTION execution of a user-
   authored "transformation" tool (transformTools.ts) — the n8n Code-node /
   Langflow custom-component parity target. A user writes the BODY of a
   `(input) => output` function; this module is the ONLY place that ever
   actually runs it.

   ── THREAT MODEL ────────────────────────────────────────────────────────

   The code is adversarial by default (it may come from an untrusted agent
   suggestion, a shared `.lazyagent.json` import, or a mistake) and MUST be
   able to do nothing beyond pure computation on the one `input` value it is
   given. Concretely, execution must have ZERO access to:

     - the filesystem (no `fs`, no Tauri `read_file`/`write_file`/... commands)
     - the network (no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
       `navigator.sendBeacon`, WebRTC data channels)
     - the process (no `process`, no `require`/`import`, no child processes)
     - persistent storage (no `indexedDB`, `caches`, `localStorage`)
     - the Tauri IPC bridge (`window.__TAURI_INTERNALS__.invoke(...)`, which
       would otherwise let code call ANY registered Tauri command — full
       ambient authority over the app, not just this feature)
     - the DOM / any other mission's or the app's own in-memory state

   and it must be bounded by a hard wall-clock timeout and a hard output-size
   cap, with every failure mode (syntax error, thrown exception, timeout,
   oversized output, non-JSON-serializable output) surfaced as an honest
   `{ ok: false, error }` — never an uncaught exception that could crash the
   calling mission loop, and never a silent truncation presented as success.

   ── WHY A WEB WORKER (not `new Function`/`eval` in the main thread) ──────

   The mission brief for this module is explicit that `new Function`/`eval`
   in the MAIN render thread is disqualified, and the reason is concrete, not
   theoretical: Tauri injects its IPC bridge onto `window` in the main
   document (`window.__TAURI_INTERNALS__`), which is how EVERY Tauri command
   in this app is invoked (fs reads/writes scoped to open projects,
   `run_shell`, git operations, ...). Code run in the main thread can reach
   `window.__TAURI_INTERNALS__.invoke(...)` directly — that is full ambient
   authority over the app, the exact opposite of "safe by construction".

   A dedicated Web Worker (`new Worker(...)`) is a genuinely separate
   JavaScript realm with its OWN global scope (`self`, never `window`) — it
   structurally has no `window`, no `document`, and therefore no path to
   `__TAURI_INTERNALS__` at all, regardless of what the executed code tries.
   This is not a "best-effort deletion" the way the network APIs below are —
   it is a property of the Web Worker spec that this app does not opt out of.
   On top of that structural guarantee, transformSandboxWorker.ts (the
   worker's own bootstrap, see its header) explicitly strips the network/
   storage Web APIs a Worker DOES expose by default (fetch, XHR, WebSocket,
   EventSource, indexedDB, caches, importScripts, nested Worker,
   BroadcastChannel, navigator.sendBeacon) before ever running user code.

   Node-style ambient authority (`require`, `process`, `fs`, `module`,
   `__dirname`) needs no stripping at all in the browser path: a Tauri
   webview renderer has no bundled Node.js runtime, so those identifiers
   simply do not exist — a ReferenceError, not a blocked capability.

   ── HARD TIMEOUT: why `worker.terminate()`, not a cooperative flag ───────

   JavaScript is single-threaded and cooperative: code running in the SAME
   thread that started a timer cannot be interrupted by that timer (a
   `while (true) {}` body never yields, so it can never "check" a
   cancellation flag). The only way to force-stop CPU-bound synchronous code
   from a browser page is to run it in an actual separate OS thread and kill
   that thread from outside — which is exactly what a Worker is, and exactly
   what `Worker.terminate()` does (an immediate, unconditional halt of
   everything running in that thread, sync or async). This module always
   calls `terminate()` on EVERY code path — success, error, AND timeout — so
   no lingering `setTimeout`/microtask scheduled by the sandboxed code can
   ever run again after a verdict has been returned; the worker is one-shot,
   never reused for a second call.

   ── PROTOTYPE POLLUTION: why it can't leak ───────────────────────────────

   `input` crosses into the worker via `postMessage`, which uses the
   Structured Clone algorithm — the received object graph is reconstructed
   FRESH inside the worker's own realm, using the worker's own
   `Object.prototype` (a different object identity than the main thread's).
   An attempt like `input.__proto__.polluted = 1` inside the sandboxed code
   can only mutate that worker's OWN, disposable `Object.prototype` — which
   is destroyed the instant this module calls `worker.terminate()` right
   after this one call. Nothing survives to a second call (a fresh worker is
   spawned per call) or to the main thread (never shared identity to begin
   with).

   ── OUTPUT: size cap and JSON-only ───────────────────────────────────────

   The result is JSON.stringify'd INSIDE the worker before being posted back
   (transformSandboxWorker.ts) and rejected if it exceeds
   TRANSFORM_MAX_OUTPUT_CHARS or is not JSON-serializable at all (a function,
   symbol, or BigInt anywhere in the return value) — matching the "input is
   JSON-serializable data, output is JSON" contract a calling agent tool
   needs.

   ── NODE/VM FALLBACK: why a second implementation exists ─────────────────

   A real browser `Worker` is unconditionally available everywhere this
   feature actually ships (the Tauri webview, and plain `vite`
   dev/preview — both are real browsers). It is NOT available under Vitest
   (jsdom does not implement Worker) or in this repo's Node-hosted `lazy` CLI
   entry point (package.json's `bin.lazy`), should a managed mission ever run
   there. `runInNodeVm` below provides an EQUALLY hard isolation boundary for
   those hosts using Node's built-in `vm` module — never a new dependency:

     - `vm.createContext()` builds a genuinely fresh realm with its own
       intrinsics (Object, Array, JSON, Math, Function, ...) and does NOT
       inherit the host's globals — `require`/`process`/`fs`/`module`/
       `global` are simply never added to it, so they don't exist as free
       identifiers inside it, exactly like the browser path.
     - `Script#runInContext(ctx, { timeout })` is a genuine V8-level
       interrupt of synchronous execution (confirmed: it hard-kills a
       `while (true) {}` body), sufficient here BECAUSE the sandbox exposes
       no async-scheduling primitive at all (no `Promise`, `setTimeout`,
       `queueMicrotask` is ever added to the context) — nothing can outlive
       the synchronous script the way a microtask could outlive a
       cooperative flag, so there is no need for the extra `worker_threads`
       + hard-terminate layer the browser path needs for the same guarantee.
     - `input`/`output` cross the boundary as JSON STRINGS (not object
       references) for the identical reason `postMessage`'s structured clone
       does the equivalent job in the browser path: a prototype-pollution
       attempt inside the vm context can only reach that context's own
       throwaway `Object.prototype` (reconstructed by ITS OWN `JSON.parse`,
       executed inside the context), never the real caller's `input` object
       or the host Node process's `Object.prototype`.

   The vm module is loaded via a dynamic import of `node:vm`, annotated with
   a Vite "ignore this specifier" comment (see runInNodeVm below) so the
   bundler never tries to statically resolve it, reached ONLY when
   `typeof Worker !== 'function'` — never true in the shipped app, so the
   browser production bundle never attempts to resolve or execute it.
*/

export interface TransformSandboxResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface TransformSandboxOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
}

/** Hard wall-clock cap on one transformation call. */
export const TRANSFORM_TIMEOUT_MS = 1000;

/** Hard cap on the JSON-serialized output size. */
export const TRANSFORM_MAX_OUTPUT_CHARS = 256 * 1024;

/**
 * Runs a user-authored transformation function body against `input`, fully
 * isolated per this module's threat model above. Never throws — every
 * failure mode (syntax error, thrown exception, timeout, oversized or
 * non-JSON output, sandbox startup failure) resolves to `{ ok: false, error }`.
 */
export async function runTransformSandbox(
  code: string,
  input: unknown,
  opts: TransformSandboxOptions = {},
): Promise<TransformSandboxResult> {
  const timeoutMs = opts.timeoutMs ?? TRANSFORM_TIMEOUT_MS;
  const maxOutputChars = opts.maxOutputChars ?? TRANSFORM_MAX_OUTPUT_CHARS;
  if (typeof Worker === 'function') {
    return runInBrowserWorker(code, input, timeoutMs, maxOutputChars);
  }
  return runInNodeVm(code, input, timeoutMs, maxOutputChars);
}

// ── Browser path (production — real dedicated Worker) ──────────────────

function runInBrowserWorker(
  code: string,
  input: unknown,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<TransformSandboxResult> {
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./transformSandboxWorker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      resolve({ ok: false, error: `sandbox worker failed to start: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    // ALWAYS terminate — success, error, or timeout — so no lingering async
    // work scheduled by the sandboxed code ever runs again after a verdict
    // has been returned (see this module's header, "hard timeout" bullet).
    const settle = (out: TransformSandboxResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(out);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, error: `transformation exceeded the ${timeoutMs}ms timeout and was terminated` });
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { __lazyTransformResult?: boolean; ok?: boolean; result?: unknown; error?: string }
        | undefined;
      // Ignore anything not shaped like our own result envelope — e.g. the
      // sandboxed code calling `postMessage` directly. We only ever settle
      // on the first well-formed envelope, or the timeout.
      if (!data || data.__lazyTransformResult !== true) return;
      if (data.ok) settle({ ok: true, result: data.result });
      else settle({ ok: false, error: data.error ?? 'transformation failed' });
    };
    worker.onerror = (event: ErrorEvent) => {
      settle({ ok: false, error: `sandbox worker crashed: ${event.message || 'unknown error'}` });
    };

    try {
      worker.postMessage({ code, input, maxOutputChars });
    } catch (err) {
      settle({ ok: false, error: `input is not structured-cloneable: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

// ── Node/vm path (test environment + this repo's Node CLI host only —
//    NEVER reached inside the shipped desktop app; see this module's header
//    for the full rationale). ─────────────────────────────────────────────

interface MinimalVmScript {
  runInContext(context: object, options: { timeout: number }): unknown;
}

interface MinimalVmModule {
  createContext(sandbox: object): object;
  Script: new (code: string) => MinimalVmScript;
}

async function runInNodeVm(
  code: string,
  input: unknown,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<TransformSandboxResult> {
  let vmMod: MinimalVmModule;
  try {
    // @vite-ignore — this specifier must never be statically resolved/
    // bundled for the browser build (it does not exist there); this branch
    // is only ever reached when `typeof Worker !== 'function'` (see caller),
    // which never happens in the shipped app.
    vmMod = (await import(/* @vite-ignore */ 'node:vm')) as unknown as MinimalVmModule;
  } catch (err) {
    return { ok: false, error: `sandbox unavailable in this environment: ${err instanceof Error ? err.message : String(err)}` };
  }

  let inputJson: string;
  try {
    inputJson = JSON.stringify(input) ?? 'null';
  } catch (err) {
    return { ok: false, error: `input is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}` };
  }

  // A FRESH, empty context per call. No `require`/`process`/`Buffer`/
  // `global`/`module` — those are never added to the sandbox object, so
  // they don't exist as free identifiers inside it (vm.createContext does
  // NOT inherit the host's globals). `__inputJson__` is a STRING, not the
  // caller's `input` object reference — see this module's header,
  // "prototype pollution" bullet, for why that distinction is load-bearing.
  const sandbox = { __inputJson__: inputJson, __maxOutputChars__: maxOutputChars };
  const context = vmMod.createContext(sandbox);

  const wrapped = `
    (function () {
      "use strict";
      var input = JSON.parse(__inputJson__);
      var fn = new Function('input', ${JSON.stringify(code)});
      var result = fn(input);
      var serialized = JSON.stringify(result === undefined ? null : result);
      if (serialized === undefined) {
        return JSON.stringify({ ok: false, error: 'output is not JSON-serializable (functions, symbols, and BigInt are not supported)' });
      }
      if (serialized.length > __maxOutputChars__) {
        return JSON.stringify({ ok: false, error: 'output exceeds the ' + __maxOutputChars__ + '-character size cap (was ' + serialized.length + ' characters)' });
      }
      return JSON.stringify({ ok: true, result: serialized });
    })()
  `;

  try {
    const script = new vmMod.Script(wrapped);
    const outputJson = script.runInContext(context, { timeout: timeoutMs }) as string;
    const parsed = JSON.parse(outputJson) as { ok: boolean; error?: string; result?: string };
    if (!parsed.ok) return { ok: false, error: parsed.error };
    return { ok: true, result: JSON.parse(parsed.result as string) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
