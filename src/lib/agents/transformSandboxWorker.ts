/* transformSandboxWorker.ts — the untrusted-code EXECUTION BOUNDARY for a
   user-authored "transformation" tool (transformTools.ts), running INSIDE a
   dedicated Web Worker spawned by transformSandbox.ts. Read that module's
   header FIRST for the full threat model — this file is only the half of
   it that must physically run inside the isolated thread.

   This file's job is narrow and load-bearing: strip every ambient-authority
   Web API the standard Worker global scope grants by default (fetch, XHR,
   WebSocket, EventSource, indexedDB, caches, importScripts, nested Worker,
   BroadcastChannel, navigator.sendBeacon), then run the user's function
   body and report back a plain, JSON-safe result or an honest error — never
   an uncaught exception, never a crash.

   Never import anything from the rest of the app here. This file IS the
   isolation boundary; pulling in application code would risk reintroducing
   an ambient capability transitively (anything that ever touches `window`
   or Tauri's injected `__TAURI_INTERNALS__` bridge — neither of which
   exists in a Worker's global scope in the first place, since a Worker has
   `self`, never `window`, by construction of the Web Worker spec, not by
   anything this file does).
*/

export {};

interface IncomingMessage {
  code: string;
  input: unknown;
  maxOutputChars: number;
}

type OutgoingMessage =
  | { __lazyTransformResult: true; ok: true; result: unknown }
  | { __lazyTransformResult: true; ok: false; error: string };

// ── Strip ambient browser APIs ──────────────────────────────────────────
//
// Node/Electron-style ambient authority (require, process, fs, module,
// __dirname, global) is not merely disabled here — it structurally DOES NOT
// EXIST in a Web Worker, because a Tauri webview renderer has no bundled
// Node.js runtime at all (unlike a non-context-isolated Electron renderer).
// What DOES exist by default in a standard Worker global scope, and must be
// removed explicitly, is the set of network/storage Web APIs below — every
// one of these is real ambient authority (it can reach a network host or
// persist data) that a "pure computation" tool must never have.
const globalScope = self as unknown as Record<string, unknown>;
const DANGEROUS_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'indexedDB',
  'caches',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'RTCPeerConnection',
  'importScripts',
] as const;

for (const name of DANGEROUS_GLOBALS) {
  try {
    delete globalScope[name];
  } catch {
    // Some engines expose a non-configurable accessor for a given global —
    // deletion can fail silently. The unconditional overwrite below still
    // neutralizes it either way (a `undefined` value throws "is not a
    // function"/"is not defined" on use, never a real capability).
  }
  try {
    globalScope[name] = undefined;
  } catch {
    // A strict-mode assignment to a non-writable global can throw — if so,
    // the property was non-configurable AND non-writable, i.e. already
    // inert for our purposes (nothing this sandbox does can change its
    // value, so it can't be repurposed by the user's code either).
  }
}

// navigator.sendBeacon is the one remaining silent-exfiltration primitive
// reachable off `navigator`, which is otherwise left intact — userAgent/
// onLine/language carry no ambient authority, only information already
// available to the sandboxed code by other means.
try {
  const nav = globalScope.navigator as { sendBeacon?: unknown } | undefined;
  if (nav) nav.sendBeacon = undefined;
} catch {
  // best-effort
}

// ── Execute one transformation call ─────────────────────────────────────
//
// One worker handles exactly ONE call then is terminated by the caller
// (transformSandbox.ts) — never reused. This is what makes a prototype-
// pollution attempt on `input` (e.g. `input.__proto__.polluted = 1`) a
// dead end: it can only mutate THIS worker's own realm's Object.prototype,
// which ceases to exist the moment transformSandbox.ts calls
// `worker.terminate()` right after reading this message.
self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const { code, input, maxOutputChars } = event.data;
  let outcome: OutgoingMessage;
  try {
    // This IS the sandbox boundary. `code` is the user-authored function
    // BODY; this worker's global scope has already been stripped above.
    // Free identifiers the body references that used to be ambient
    // capabilities (fetch, require, process, window, ...) now resolve to
    // `undefined` or a ReferenceError — never a real capability. Note this
    // is executed inside the Worker's OWN realm (its own Function
    // constructor, its own Object.prototype), never the main thread's.
    const fn = new Function('input', code) as (value: unknown) => unknown;
    const result = fn(input);
    const serialized = JSON.stringify(result === undefined ? null : result);
    if (serialized === undefined) {
      outcome = {
        __lazyTransformResult: true,
        ok: false,
        error: 'output is not JSON-serializable (functions, symbols, and BigInt are not supported)',
      };
    } else if (serialized.length > maxOutputChars) {
      outcome = {
        __lazyTransformResult: true,
        ok: false,
        error: `output exceeds the ${maxOutputChars}-character size cap (was ${serialized.length} characters)`,
      };
    } else {
      outcome = { __lazyTransformResult: true, ok: true, result: JSON.parse(serialized) };
    }
  } catch (err) {
    outcome = {
      __lazyTransformResult: true,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  (self as unknown as { postMessage(message: unknown): void }).postMessage(outcome);
};
