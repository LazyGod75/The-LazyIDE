/**
 * elkjs ships a hand-written `elk-worker.d.ts` for `elk-worker.js`, but not
 * for the minified `elk-worker.min.js` sibling this codebase actually loads
 * (elkLayoutWorker.ts's real Worker side-effect import, layout.ts's
 * in-process fallback, and the elkWorkerBundling/*.test.ts +
 * GraphProposalCardStrictMode.test.tsx suites that drive it directly under
 * jsdom). Both files are the SAME bundle (elk-worker.js minified), and its
 * own CommonJS tail (`module.exports = { default: FakeWorker, Worker:
 * FakeWorker }`) is the real, load-bearing shape every call site narrows
 * with `as unknown as { Worker: ... }` today — declared here for real so
 * that narrowing has an actual (non-`any`) module type to start from.
 */
declare module 'elkjs/lib/elk-worker.min.js' {
  /** A same-process simulation of the DOM `Worker` interface: real
   *  `postMessage`/`onmessage`, no OS thread. Constructed with an (unused
   *  by the in-process path) script URL, matching `new Worker(url)`. */
  class ElkWorker {
    constructor(url?: string);
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(message: unknown): void;
    terminate?(): void;
  }

  export { ElkWorker as Worker };
  export default ElkWorker;
}
