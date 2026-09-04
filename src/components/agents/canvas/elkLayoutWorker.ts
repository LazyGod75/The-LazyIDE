/* elkLayoutWorker.ts — off-main-thread elkjs execution boundary for the
   in-chat plan-preview graph (GraphProposalCard.tsx via layout.ts's
   `layoutPreviewGraph`). Read layout.ts's own header first for the split
   between this worker path and the still-synchronous-in-thread canvas paths
   (layoutZone/layoutAll/laneLayout) it did NOT move here.

   ── CORRECTED 2026-08 (real-app regression, verified live) ───────────────

   The FIRST version of this file did `import ELK from 'elkjs/lib/elk.bundled.js';
   const elk = new ELK();` — the exact same construction layout.ts already
   used successfully on the MAIN thread. It crashed 100% of the time inside
   a real Worker with `TypeError: _Worker is not a constructor`, reproduced
   live via CDP and root-caused by reading elkjs's own source
   (node_modules/elkjs/lib/elk.bundled.js and elk-worker.min.js):

   `elk.bundled.js`'s default export (`ELKNode`) auto-picks a worker
   implementation at construction time by internally requiring
   `elk-worker.min.js` and reading its `Worker` export. That file's OWN
   top-level code branches on `typeof document === 'undefined' && typeof
   self !== 'undefined'`:
     - On the MAIN thread, `document` is defined -> it takes the "I am
       being required as a library" branch and exports a working in-process
       `Worker` (a synchronous, setTimeout-based simulation) -> `new ELK()`
       with zero args works. This is the path layoutZone/layoutAll/
       laneLayout still use, unchanged.
     - Inside a REAL Worker, `document` is undefined and `self` IS defined
       -> it takes the OPPOSITE branch: "I must BE the worker" and
       self-installs `self.onmessage`, WITHOUT ever setting `module.exports`.
       `elk.bundled.js`'s constructor then reads `.Worker` off that empty
       export (`undefined`) and hands it to elk-api.js's base ELK
       constructor as the workerFactory result — `new undefined(url)` is
       exactly `_Worker is not a constructor`. Reproduced directly (outside
       any bundler, in plain Node with `document` deleted and `self` set):
       constructing elk.bundled.js's ELK throws this exact message — see
       elkWorkerBundling.test.ts for the same proof run as a real test.

   `elk.bundled.js` therefore CANNOT run inside a Worker — it structurally
   assumes it is always the main-thread caller. The fix is to use the OTHER
   half of that SAME branch on purpose: THIS file simply loads
   `elk-worker.min.js` for its side effect, running INSIDE a real Worker,
   where `typeof document === 'undefined' && typeof self !== 'undefined'`
   is genuinely true — so it takes the "I must BE the worker" branch and
   self-installs the correct `self.onmessage` dispatcher, implementing the
   exact `{cmd, id}` message protocol elk-api.js's `ELK` class (the main-
   thread half, see previewLayoutWorkerClient.ts) already speaks via its
   own `PromisedWorker` wrapper. Verified end-to-end (register + layout,
   producing real positions) in elkWorkerBundling.test.ts.

   There is no code of ours left to write here — the entire worker-side
   protocol (algorithm registration, layout requests, id-based responses)
   is elkjs's own, battle-tested implementation.
*/
export {};

import 'elkjs/lib/elk-worker.min.js';
