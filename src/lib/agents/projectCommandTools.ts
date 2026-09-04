/* projectCommandTools.ts — W-BYO row 2 (canvas scorecard §4.5 "BYO agents",
   the deeper "custom tool" half of the one genuinely-open row).

   Scope, stated up front (per this wave's own instruction — "scope
   honestly, don't fake a sandbox"): this is NOT a general user-defined-tool
   system. A "commande de projet" tool is a NAMED, DESCRIBED binding onto a
   command that must already pass `isWorktreeScriptCommand`
   (worktreeScriptCommands.ts) — the exact same narrow allowlist
   (`npm run <script>` / `npm test|ci|install` / `npx tsc|vite build|vitest`
   / `cargo check|build|test`, no chaining/piping/redirection/substitution)
   the R6b scoped-worktree-script gate already enforces server-side
   (shell.rs's `matches_worktree_script_allowlist`) for acceptEdits/full
   missions. Saving a tool whose command does NOT match that allowlist is
   REJECTED outright (`validateProjectCommandTool`) — there is no path in
   this module to author a tool that runs arbitrary shell text.

   This is deliberately a NAMING/CATALOG/DISCOVERY layer, not a new
   execution primitive: attaching a tool to an agent
   (`LazyAgent.projectCommandTools`, agentDef.ts) never grants new
   capability — an acceptEdits/full agent can ALREADY run any
   `isWorktreeScriptCommand`-matching command via the pre-existing R6b
   bypass in `managedToolPermissions.checkToolExecution`, with or without
   this catalog. What this catalog adds is real BYO value anyway: a
   user-authored, friendly name + description for a specific project
   command (e.g. "Lancer les tests d'intégration" -> `npm run test:integration`)
   that shows up as a discoverable, first-class capability in the agent
   wizard and in the compiled agent definition (compile.ts's
   `buildClaudeCodeAgentMd`) — the n8n-custom-node / AutoGen-tool authoring
   UX, safely bounded by an execution gate that already existed.

   Explicitly OUT of scope, and left as a design note rather than a fake
   implementation: a tool that runs an ARBITRARY user-authored shell string
   (not from the R6b allowlist) would need a real sandboxing story (a
   container, a restricted shell, a resource/time-boxed subprocess with no
   filesystem access outside a scratch dir) before it could be exposed to
   an autonomous, unattended agent — that is a product/security decision,
   not an engineering afternoon, and is NOT implemented here.

   Persistence mirrors approvalMode.ts's own documented pattern exactly
   (same module, same comment reproduced here for anyone reading only one
   of the two files): the only generic file-IO Tauri commands available are
   sandboxed to whichever project is currently OPEN
   (`ensure_write_path_in_any_open_project`, fs.rs) — there is no dedicated
   Rust command for this catalog, so it is stored as ONE JSON file under
   the ACTIVE project's `.lazy/projectCommandTools.json`, exactly like
   `approvalModes.json`. Web (non-Tauri): falls back to an in-memory mock
   array, mirroring agentsStorage.ts's `_mockStore` convention.
*/

import { isWorktreeScriptCommand } from './worktreeScriptCommands.js';
import { createToolCollectionStore } from './toolCollectionStore.js';

// ── Type ─────────────────────────────────────────────────────────────

export interface ProjectCommandTool {
  id: string;
  /** User-facing name, e.g. "Lancer les tests". */
  name: string;
  /** Must pass `isWorktreeScriptCommand` — validated on save, never on read
   *  (a file already on disk is trusted the same way canvasPersistence.ts's
   *  own load functions trust their own prior writes; only IMPORTED files
   *  from agentImportExport.ts re-validate, since those are untrusted). */
  command: string;
  description: string;
  createdAt: string;
}

export interface ProjectCommandToolValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a candidate tool BEFORE it is ever saved — the one and only
 * gate standing between "user typed a command" and "this becomes callable
 * by an agent". Rejects honestly rather than silently coercing.
 */
export function validateProjectCommandTool(input: {
  name: string;
  command: string;
  description: string;
}): ProjectCommandToolValidation {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('name is required');
  if (!input.command.trim()) {
    errors.push('command is required');
  } else if (!isWorktreeScriptCommand(input.command)) {
    errors.push(
      'command must be an allowlisted npm/cargo script (npm run <script>, npm test/ci/install, npx tsc/vite build/vitest, cargo check/build/test) — arbitrary shell commands are not permitted for user-defined project-command tools',
    );
  }
  if (!input.description.trim()) errors.push('description is required');
  return { valid: errors.length === 0, errors };
}

// ── Runtime shape guard (agentImportExport.ts's untrusted-input path) ───

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural check only — does NOT re-validate `command` against the
 *  allowlist (a caller that needs that guarantee, e.g. an import flow,
 *  should call `validateProjectCommandTool` explicitly; this guard only
 *  proves "this parses as a ProjectCommandTool", matching
 *  canvasPersistence.ts's own shape-vs-domain-rule separation). */
export function isProjectCommandToolLike(value: unknown): value is ProjectCommandTool {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.command === 'string' &&
    typeof value.description === 'string' &&
    typeof value.createdAt === 'string'
  );
}

// ── Persistence (mirrors approvalMode.ts's documented pattern; the
//    list/persist/save/delete/reset plumbing itself now lives in
//    toolCollectionStore.ts, shared with transformTools.ts/declarativeTools.ts —
//    see that module's header for the extraction and its deliberate limits) ──

const store = createToolCollectionStore<ProjectCommandTool>({
  storageFileName: 'projectCommandTools.json',
  localStorageKey: 'lazy.agents.projectCommandTools',
  isLike: isProjectCommandToolLike,
});

/** List every project-command tool stored for the active project. */
export async function listProjectCommandTools(): Promise<ProjectCommandTool[]> {
  return store.list();
}

/**
 * Saves (creates or updates) a tool. THROWS on validation failure — this
 * is the enforcement point, never bypassed by a caller that skips the
 * separate `validateProjectCommandTool` check.
 */
export async function saveProjectCommandTool(tool: ProjectCommandTool): Promise<void> {
  const validation = validateProjectCommandTool(tool);
  if (!validation.valid) {
    throw new Error(`Invalid project command tool: ${validation.errors.join('; ')}`);
  }
  await store.save(tool);
}

/** Deletes a tool by id. Never throws if the id is already absent. */
export async function deleteProjectCommandTool(id: string): Promise<void> {
  await store.remove(id);
}

/** Mints a fresh id for a brand-new tool — same shape as agentDef.ts's own
 *  `createNewAgent` id convention. */
export function generateProjectCommandToolId(): string {
  return `pctool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Test-only reset. */
export function _resetProjectCommandToolsForTests(): void {
  store.resetForTests();
}
