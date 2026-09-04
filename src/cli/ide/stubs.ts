/**
 * src/cli/ide/stubs.ts — no-op stubs for app modules the IDE tool runtime
 * imports but that cannot run headless (Tauri platform, LazyBrain sidecar,
 * journal/bus events, cost store, transforms).
 *
 * These are wired via an esbuild plugin (scripts/build-idebench.mjs) so the
 * REAL src/lib/tools/toolRuntime.ts + managedAgentPolicy.ts can be bundled for
 * Node. Every stub keeps the exact export shape the importer expects.
 */

// ── platform ────────────────────────────────────────────────────────────
export type Platform = 'web' | 'tauri';
export function getPlatform(): Platform {
  return 'web';
}

// ── brain/captureQueue ──────────────────────────────────────────────────
export function isConflictError(): boolean {
  return false;
}

// ── brain/context ───────────────────────────────────────────────────────
export function buildPromptBrainContext(): string {
  return '';
}
export function normalizeRecall<T>(r: T): T {
  return r;
}

// ── models/costStore ────────────────────────────────────────────────────
export function recordRecallSaving(): void {
  /* no-op */
}

// ── brain/brainTool ─────────────────────────────────────────────────────
export async function runBrainQueryCss(): Promise<unknown[]> {
  return [];
}
export async function runBrainNeighbours(): Promise<unknown[]> {
  return [];
}

// ── agents/transformTools ───────────────────────────────────────────────
export type TransformTool = { name: string; description: string };
export function listTransformTools(): TransformTool[] {
  return [];
}

// ── agents/transformSandbox ─────────────────────────────────────────────
export async function runTransformSandbox(): Promise<unknown> {
  return undefined;
}

// ── bus ─────────────────────────────────────────────────────────────────
export function emit(): void {
  /* no-op */
}

// ── journal/journal ─────────────────────────────────────────────────────
export function emitBuffered(): void {
  /* no-op */
}

// ── agents/agentsStorage ────────────────────────────────────────────────
export function listAgents(): unknown[] {
  return [];
}

// ── models/systemPrompts ────────────────────────────────────────────────
export const RECALL_TEACHING = '';

// ── agents/managedToolPermissions ───────────────────────────────────────
export type AgentPermissionMode = 'default' | 'ask' | 'exclude';
/** Headless benchmark policy: allow every tool (return null = allowed). */
export function checkToolExecution(): string | null {
  return null;
}
