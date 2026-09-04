/* agentImportExport.ts — W-BYO row 1 (canvas scorecard §4.5 "BYO agents",
   the ONE genuinely-open row): the concrete AutoGen-Studio-Gallery / n8n-
   custom-node "share a definition as a file" story for a LazyAgent.

   Truth-note (see this wave's report for the full account): a LazyAgent
   preset ALREADY exists (AgentWizard.tsx/agentDef.ts/agentsStorage.ts) and
   the palette already lists every saved agent (CanvasPalette.tsx's
   `listAgents()` call) — none of that was missing. The real gap the
   scorecard's own §4 row 5 named was narrower: no way to take ONE agent
   definition OUT of this machine's `agentsStorage` and hand it to a
   teammate (or another machine) as a portable file, and no way to bring one
   back in safely. This module is exactly that — an export/import pair for
   a SINGLE LazyAgent, following the identical pattern
   canvasExportImport.ts already established for the whole canvas (versioned
   JSON envelope, explicit runtime validation of untrusted input, fresh-id
   remap on import, Blob-download / file-picker-upload as the platform save
   path — see that module's header for why THAT is the honest "existing
   save-file platform path" in this app, not the sandboxed project-scoped fs
   commands).

   Scope of "optional attached macro/toolset" (per this wave's brief): a
   canvas MACRO is a chain-of-nodes template, not a property of one agent —
   attaching one to a single agent's export would be a category error (a
   macro can reference several different agents' drafts at once). What
   DOES meaningfully travel with an agent is the set of user-authored
   PROJECT-COMMAND TOOLS (projectCommandTools.ts, this wave's row 2) it
   references via `LazyAgent.projectCommandTools` — those are embedded
   verbatim in the envelope (by id, resolved to their full definition at
   export time) so an imported agent's "commandes de projet" toggles aren't
   silently empty on the receiving machine. Embedding is best-effort: an
   agent that references no project-command tools exports an empty array,
   never an error.

   Never trust an imported file: `parseAgentExportEnvelope` runs a full
   explicit runtime shape check (this codebase's established convention —
   see canvasPersistence.ts's `isChain`/`isDraftSpec` etc. — no zod
   dependency exists in this repo, so this follows the same hand-rolled
   guard style, not a new dependency for one feature) AND re-runs
   `validateAgent`'s own structural rules (kebab-case name, required
   fields), rejecting a well-typed-but-invalid agent just as strictly as a
   malformed one. Nothing is ever partially imported.
*/

import type { AgentColor, AgentScope, AgentTools, DragDropTrigger, LazyAgent, ScheduleTrigger, AgentTriggers } from './agentDef.js';
import { validateAgent } from './agentDef.js';
import type { ProjectCommandTool } from './projectCommandTools.js';
import { isProjectCommandToolLike } from './projectCommandTools.js';

// ── Envelope schema ────────────────────────────────────────────────────

export const AGENT_EXPORT_KIND = 'lazy-agent-export' as const;
export const AGENT_EXPORT_VERSION = 1 as const;

/** The versioned, shareable envelope — one agent + the project-command
 *  tools it references (see this module's header for why NOT a macro). */
export interface LazyAgentExportEnvelopeV1 {
  version: 1;
  kind: typeof AGENT_EXPORT_KIND;
  exportedAtMs: number;
  agent: LazyAgent;
  projectCommandTools: ProjectCommandTool[];
}

/**
 * Builds the export envelope. `availableTools` is the exporting project's
 * full project-command-tool catalog (projectCommandTools.listProjectCommandTools())
 * — only the ones this agent actually references (`agent.projectCommandTools`)
 * are embedded, resolved to their full definition (a bare id would be
 * useless on a machine that never had that tool).
 */
export function buildAgentExportEnvelope(
  agent: LazyAgent,
  availableTools: readonly ProjectCommandTool[] = [],
  nowMs: number = Date.now(),
): LazyAgentExportEnvelopeV1 {
  const referencedIds = new Set(agent.projectCommandTools ?? []);
  const embeddedTools = availableTools.filter((tool) => referencedIds.has(tool.id));
  return {
    version: AGENT_EXPORT_VERSION,
    kind: AGENT_EXPORT_KIND,
    exportedAtMs: nowMs,
    agent: { ...agent },
    projectCommandTools: embeddedTools,
  };
}

// ── Validation (never trust an imported file) ───────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const AGENT_COLORS = new Set<AgentColor>(['violet', 'cyan', 'green', 'amber', 'pink', 'red', 'blue', 'indigo']);
const MODEL_TIERS = new Set(['haiku', 'sonnet', 'opus', 'inherit']);
const MEMORY_SCOPES = new Set(['user', 'project', 'local']);
const AGENT_SCOPES = new Set<AgentScope>(['user', 'project']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'full', 'bypassPermissions']);
const EFFORTS = new Set(['low', 'medium', 'high']);

function isDragDropTrigger(value: unknown): value is DragDropTrigger | undefined {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  return value.acceptsFileTypes === undefined || isStringArray(value.acceptsFileTypes);
}

function isScheduleTrigger(value: unknown): value is ScheduleTrigger | undefined {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  return (
    typeof value.cron === 'string' &&
    (value.mode === 'local' || value.mode === 'cloud') &&
    typeof value.enabled === 'boolean'
  );
}

function isAgentTriggers(value: unknown): value is AgentTriggers {
  if (!isPlainObject(value)) return false;
  if (value.manual !== true) return false;
  if (!isDragDropTrigger(value.dragDrop)) return false;
  if (!isScheduleTrigger(value.schedule)) return false;
  if (value.event !== undefined && typeof value.event !== 'string') return false;
  return true;
}

function isAgentTools(value: unknown): value is AgentTools | undefined {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  if (value.allow !== undefined && !isStringArray(value.allow)) return false;
  if (value.deny !== undefined && !isStringArray(value.deny)) return false;
  return true;
}

/** Structural (type-shape) check only — `validateAgent` (agentDef.ts) is
 *  run separately for the domain rules (kebab-case name, required fields). */
function isLazyAgentLike(value: unknown): value is LazyAgent {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== 'string' || !value.id) return false;
  if (typeof value.name !== 'string') return false;
  if (typeof value.displayName !== 'string') return false;
  if (typeof value.description !== 'string') return false;
  if (typeof value.color !== 'string' || !AGENT_COLORS.has(value.color as AgentColor)) return false;
  if (!isStringArray(value.tags)) return false;
  if (typeof value.systemPrompt !== 'string') return false;
  if (value.skills !== undefined && !isStringArray(value.skills)) return false;
  if (value.brainScope !== undefined && typeof value.brainScope !== 'string') return false;
  if (value.memory !== undefined && !MEMORY_SCOPES.has(String(value.memory))) return false;
  if (typeof value.modelTier !== 'string' || !MODEL_TIERS.has(value.modelTier)) return false;
  if (value.effort !== undefined && !EFFORTS.has(String(value.effort))) return false;
  if (!isAgentTools(value.tools)) return false;
  if (value.permissionMode !== undefined && !PERMISSION_MODES.has(String(value.permissionMode))) return false;
  if (value.allowedTools !== undefined && !isStringArray(value.allowedTools)) return false;
  if (value.deniedTools !== undefined && !isStringArray(value.deniedTools)) return false;
  if (value.maxTurns !== undefined && typeof value.maxTurns !== 'number') return false;
  if (value.isolation !== undefined && value.isolation !== null && value.isolation !== 'worktree') return false;
  if (value.projectCommandTools !== undefined && !isStringArray(value.projectCommandTools)) return false;
  if (!isAgentTriggers(value.triggers)) return false;
  if (typeof value.scope !== 'string' || !AGENT_SCOPES.has(value.scope as AgentScope)) return false;
  if (typeof value.createdAt !== 'string') return false;
  return true;
}

/**
 * Validates a parsed JSON value against {@link LazyAgentExportEnvelopeV1}.
 * Returns `null` for anything malformed — wrong version/kind, a field
 * failing its shape check, OR an agent that's well-typed but fails
 * `validateAgent`'s own domain rules (e.g. non-kebab-case name) — same
 * "fail honestly, never half-apply" discipline canvasExportImport.ts's
 * `parseCanvasExportEnvelope` already follows.
 */
export function parseAgentExportEnvelope(raw: unknown): LazyAgentExportEnvelopeV1 | null {
  if (!isPlainObject(raw)) return null;
  if (raw.version !== AGENT_EXPORT_VERSION) return null;
  if (raw.kind !== AGENT_EXPORT_KIND) return null;
  if (typeof raw.exportedAtMs !== 'number') return null;
  if (!isLazyAgentLike(raw.agent)) return null;
  if (!validateAgent(raw.agent).valid) return null;
  if (!Array.isArray(raw.projectCommandTools) || !raw.projectCommandTools.every(isProjectCommandToolLike)) return null;
  return raw as unknown as LazyAgentExportEnvelopeV1;
}

// ── Filename ─────────────────────────────────────────────────────────

/** Deterministic, sortable export filename — `.lazyagent.json` so the file
 *  extension itself documents what it is (mirrors canvasExportImport.ts's
 *  `canvasExportFileName`, minus the timestamp-only name since an agent
 *  export is more useful named after the agent it contains). */
export function agentExportFileName(agentName: string, nowMs: number = Date.now()): string {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const safe =
    agentName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'agent';
  return `${safe}-${iso}.lazyagent.json`;
}

// ── Import remap ─────────────────────────────────────────────────────

export interface RemapAgentImportOptions {
  /** Scope the imported agent lands in — defaults to 'project' (the safer
   *  default: a freshly-imported, unaudited agent definition starts scoped
   *  to the current project rather than silently becoming available
   *  user-wide across every project). */
  scope?: AgentScope;
  /** Injectable for tests — defaults to the same id shape agentDef.ts's own
   *  `createNewAgent` already uses. */
  idFactory?: () => string;
}

/**
 * Mints a BRAND NEW id for the imported agent (never reuses the exported
 * id, which could collide with an agent already in this machine's
 * `agentsStorage` — including a second import of the SAME file) and resets
 * `createdAt` to now. Every other field is carried over verbatim — an
 * import is a real, editable starting point, not a locked template.
 */
export function remapImportedAgent(
  envelope: LazyAgentExportEnvelopeV1,
  opts: RemapAgentImportOptions = {},
): LazyAgent {
  const idFactory = opts.idFactory ?? (() => `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return {
    ...envelope.agent,
    id: idFactory(),
    scope: opts.scope ?? 'project',
    createdAt: new Date().toISOString(),
  };
}
