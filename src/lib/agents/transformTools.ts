/* transformTools.ts — W-CODE (canvas scorecard §4.5 "BYO agents"): the
   FINAL genuinely-open slice — a user-authored ARBITRARY LOGIC tool, the
   n8n Code-node / Langflow custom-component parity target.

   Every prior BYO tool kind in this codebase either runs nothing
   (declarativeTools.ts's `web_read`/`file_read` — read-only) or runs only a
   pre-vetted ALLOWLISTED shape (projectCommandTools.ts's "commande de
   projet" — a command that must already pass `isWorktreeScriptCommand`).
   Neither lets a user hand an agent genuinely free-form logic. A
   `TransformTool` is the missing piece: the user writes the BODY of a
   `(input) => output` JavaScript function, and that body is executed
   VERBATIM, with no allowlist on its shape — this is only safe because
   execution never happens here. This module owns AUTHORING (validate,
   store, list) exactly like its two siblings; RUNNING a `TransformTool`
   always goes through transformSandbox.ts's isolated worker/vm — see that
   module's header for the full threat model this design depends on.

   Persistence mirrors projectCommandTools.ts/declarativeTools.ts's own
   documented pattern exactly: one JSON file under the active project's
   `.lazy/transformTools.json` (Tauri), falling back to localStorage then an
   in-memory mock array (web/tests) — same three-tier fallback, same
   reasoning (no dedicated Rust command needed; this is pure JSON-blob
   storage under the existing sandboxed fs commands other tool catalogs
   already use).

   Authored via the same AgentWizard.tsx Capacités form as the other two
   kinds (TransformToolsSection) — a user names/describes a transformation
   once, and every agent that attaches it can then discover and call it
   (compile.ts's buildClaudeCodeAgentMd renders the catalog the same way;
   toolRuntime.ts's `run_transform`/`list_transforms` tool cases execute it
   for MANAGED missions — see toolRuntime.ts's own header for why NATIVE
   claude-code-CLI missions cannot: there is no real primitive there for a
   sandboxed in-process JS call, only Bash/Read/Write, and rendering the
   function body into Bash-executed `node -e` would reintroduce full Node
   ambient authority, defeating the entire point).
*/

import { createToolCollectionStore } from './toolCollectionStore.js';

// ── Type ─────────────────────────────────────────────────────────────

export interface TransformTool {
  id: string;
  name: string;
  description: string;
  /** The BODY of a `(input) => output` function — e.g.
   *  `return input.items.map((x) => x * 2);`. Never executed directly by
   *  this module; always run through transformSandbox.ts. */
  code: string;
  createdAt: string;
}

export interface TransformToolValidation {
  valid: boolean;
  errors: string[];
}

/** Author-time cap on SOURCE SIZE (distinct from
 *  transformSandbox.TRANSFORM_MAX_OUTPUT_CHARS, which caps the runtime
 *  OUTPUT) — generous enough for real transformation logic, small enough
 *  that a pasted-in giant blob is rejected honestly at save time rather
 *  than silently accepted and only failing later at call time. */
export const TRANSFORM_CODE_MAX_CHARS = 20_000;

// ── Author-time validation ──────────────────────────────────────────────

/**
 * Parses (NEVER executes) the candidate function body to catch a syntax
 * error at author time, before it is ever saved. Constructing a `Function`
 * only PARSES its body — calling the resulting function is what would
 * execute it, and this helper never does that. Runtime execution of a saved
 * tool always goes through transformSandbox.ts's isolated worker/vm, never
 * this function — this is a syntax pre-check for UX only, not a security
 * boundary (an author-time syntax check on the AUTHOR's own machine, in the
 * AUTHOR's own main thread, carries no more risk than parsing any other
 * text the author just typed — it is not adversarial input at this point).
 */
export function checkTransformSyntax(code: string): string | null {
  try {
    new Function('input', code);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function validateTransformTool(input: { name: string; description: string; code: string }): TransformToolValidation {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('name is required');
  if (!input.description.trim()) errors.push('description is required');
  if (!input.code.trim()) {
    errors.push('code is required');
  } else if (input.code.length > TRANSFORM_CODE_MAX_CHARS) {
    errors.push(`code exceeds the ${TRANSFORM_CODE_MAX_CHARS}-character limit`);
  } else {
    const syntaxError = checkTransformSyntax(input.code);
    if (syntaxError) errors.push(`code has a syntax error: ${syntaxError}`);
  }
  return { valid: errors.length === 0, errors };
}

// ── Runtime shape guard (agentImportExport.ts-style untrusted-input path) ──

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTransformToolLike(value: unknown): value is TransformTool {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.code === 'string' &&
    typeof value.createdAt === 'string'
  );
}

// ── Persistence (mirrors projectCommandTools.ts/declarativeTools.ts; the
//    list/persist/save/delete/reset plumbing itself now lives in
//    toolCollectionStore.ts, shared across all three catalogs — see that
//    module's header for the extraction and its deliberate limits) ────

const store = createToolCollectionStore<TransformTool>({
  storageFileName: 'transformTools.json',
  localStorageKey: 'lazy.agents.transformTools',
  isLike: isTransformToolLike,
});

/** List every transformation tool stored for the active project. */
export async function listTransformTools(): Promise<TransformTool[]> {
  return store.list();
}

/**
 * Saves (creates or updates) a tool. THROWS on validation failure — the
 * enforcement point, never bypassed by a caller that skips the separate
 * `validateTransformTool` check (same discipline as
 * projectCommandTools.saveProjectCommandTool / declarativeTools.saveDeclarativeTool).
 */
export async function saveTransformTool(tool: TransformTool): Promise<void> {
  const validation = validateTransformTool(tool);
  if (!validation.valid) {
    throw new Error(`Invalid transformation tool: ${validation.errors.join('; ')}`);
  }
  await store.save(tool);
}

/** Deletes a tool by id. Never throws if the id is already absent. */
export async function deleteTransformTool(id: string): Promise<void> {
  await store.remove(id);
}

/** Mints a fresh id for a brand-new tool — same shape as
 *  projectCommandTools.ts's generateProjectCommandToolId. */
export function generateTransformToolId(): string {
  return `ttool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Test-only reset. */
export function _resetTransformToolsForTests(): void {
  store.resetForTests();
}
