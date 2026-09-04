/* projectRootCache — module-level IPC cache for resolveProjectRoot.
   Extracted from agentsStore.tsx so the test setup (src/__tests__/setup.ts)
   can reset it between tests without importing the full agentsStore module.
   The cache is simple: a string with an invalidation function called on
   project://changed. Dedup of concurrent callers was removed — see
   resolveProjectRoot's doc comment in agentsStore.tsx for why. */

import { emit } from '../bus.js';

let _cachedProjectRoot: string | null = null;
let _startupContextCache: { root: string; value: string | undefined } | null = null;

/** Read the cached root, or null if not cached. */
export function getCachedProjectRoot(): string | null {
  return _cachedProjectRoot;
}

/** Set the cached root (called by resolveProjectRoot after a successful IPC).
 *  Emits 'projectRoot:resolved' so listeners (useCanvasFlowGraph's bot loader)
 *  can reload without polling. */
export function setCachedProjectRoot(root: string): void {
  const wasEmpty = _cachedProjectRoot === null;
  _cachedProjectRoot = root;
  if (wasEmpty) emit('projectRoot:resolved', { root });
}

/** Cached first-turn brain snapshot for `root`, or null on a miss. */
export function getStartupContextCache(root: string): { hit: true; value: string | undefined } | { hit: false } {
  if (_startupContextCache && _startupContextCache.root === root) {
    return { hit: true, value: _startupContextCache.value };
  }
  return { hit: false };
}

export function setStartupContextCache(root: string, value: string | undefined): void {
  _startupContextCache = { root, value };
}

const _startupInjectedConversations = new Set<string>();

/** True once this conversation already injected the first-turn snapshot
    (fetched or cache-peeked), so later turns do not wait again. */
export function hasInjectedStartupContext(conversationId: string): boolean {
  return _startupInjectedConversations.has(conversationId);
}

export function markStartupContextInjected(conversationId: string): void {
  _startupInjectedConversations.add(conversationId);
}

/** Warm snapshot with no IPC — only if both project root and startup
    caches already hit. Greetings use this so TTFT never waits 5s. */
export function peekStartupContextIfCached(): string | undefined {
  if (!_cachedProjectRoot) return undefined;
  const cached = getStartupContextCache(_cachedProjectRoot);
  return cached.hit ? cached.value : undefined;
}

let _sidecarReachableCache: { at: number; value: boolean } | null = null;
const SIDECAR_REACHABLE_TTL_MS = 20_000;

export function getSidecarReachableCache(): { hit: true; value: boolean } | { hit: false } {
  if (_sidecarReachableCache && Date.now() - _sidecarReachableCache.at < SIDECAR_REACHABLE_TTL_MS) {
    return { hit: true, value: _sidecarReachableCache.value };
  }
  return { hit: false };
}

export function setSidecarReachableCache(value: boolean): void {
  _sidecarReachableCache = { at: Date.now(), value };
}

/** Invalidate the cache — call when the active project changes
 *  (project://changed event) or between tests. */
export function invalidateProjectRootCache(): void {
  _cachedProjectRoot = null;
  _startupContextCache = null;
  _sidecarReachableCache = null;
  _startupInjectedConversations.clear();
}
