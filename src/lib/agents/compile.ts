/* compile.ts — Provider-neutral agent compiler.
   compileAgent(agent, backend) dispatches to the right compiler.
   Phase 1: Claude Code compiler only.
   Phase 2+: add Codex, Anthropic API, etc.

   File writes go through Rust/Tauri write_file command.
*/

import { invoke } from '@tauri-apps/api/core';
import type { LazyAgent, ModelTier } from './agentDef.js';
import type { ProjectCommandTool } from './projectCommandTools.js';
import type { DeclarativeTool } from './declarativeTools.js';
import type { TransformTool } from './transformTools.js';

// ── Backend registry (provider-neutral) ───────────────────────────

export type CompilerBackend = 'claude-code';

// ── Claude Code model mapping ─────────────────────────────────────

function tierToClaudeModel(tier: ModelTier): string {
  switch (tier) {
    case 'haiku':   return 'claude-haiku-4-5';
    case 'opus':    return 'claude-opus-5';
    case 'sonnet':  return 'claude-sonnet-5';
    case 'inherit': return 'claude-sonnet-5'; // sensible default
    default:        return 'claude-sonnet-5';
  }
}

// ── Claude Code agent .md generator ──────────────────────────────

/**
 * Build the Claude Code agent markdown content.
 * Format: frontmatter block + body (systemPrompt).
 *
 * Generated file sample:
 * ---
 * name: security-reviewer
 * description: Use this agent to review code for security…
 * model: claude-sonnet-4-5
 * tools:
 *   deny: [WebSearch, computer]
 * permissionMode: plan
 * maxTurns: 20
 * color: red
 * ---
 *
 * You are a senior security engineer…
 *
 * `projectCommandTools` (W-BYO row 2, optional) — the FULL resolved catalog
 * for the active project (projectCommandTools.listProjectCommandTools()).
 * Only entries the agent actually references (`agent.projectCommandTools`)
 * are rendered, and ONLY when `permissionMode` is 'acceptEdits' or 'full'
 * (the same gate worktreeScriptCommands.ts's R6b bypass itself requires) —
 * this is a documentation/discovery addition only, never a new execution
 * primitive: the model still calls the existing `run_command` tool with the
 * exact command text, which still goes through the existing R6b allowlist
 * unchanged.
 *
 * `declarativeTools` (W-PROVE row 3, optional) — the FULL resolved catalog
 * of the agent's own `web_read`/`file_read` tools (declarativeTools.ts's
 * listDeclarativeTools()). Only entries the agent actually references
 * (`agent.declarativeTools`) are rendered — unlike projectCommandTools,
 * there is no permissionMode gate here at all: neither kind executes code,
 * so there is nothing for a permission mode to bound.
 *
 * `transformTools` (W-CODE, optional) — the FULL resolved catalog of the
 * agent's own user-authored "transformation" tools (transformTools.ts's
 * listTransformTools()). Only entries the agent actually references
 * (`agent.transformTools`) are rendered, DOCUMENTATION ONLY — a native
 * claude-code-CLI agent reading this markdown has no real primitive to
 * invoke a sandboxed in-process JS function the way a MANAGED mission's
 * `run_transform` tool case (toolRuntime.ts) does; rendering the function
 * body into a shell command the CLI's Bash tool could run would hand it
 * full Node ambient authority, defeating the entire point of the sandbox.
 * See toolRuntime.ts's header for the precise managed-only scope statement.
 */
export function buildClaudeCodeAgentMd(
  agent: LazyAgent,
  projectCommandTools: readonly ProjectCommandTool[] = [],
  declarativeTools: readonly DeclarativeTool[] = [],
  transformTools: readonly TransformTool[] = [],
): string {
  const lines: string[] = ['---'];

  lines.push(`name: ${agent.name}`);
  lines.push(`description: ${agent.description}`);
  lines.push(`model: ${tierToClaudeModel(agent.modelTier)}`);

  // Tools
  const allowTools = agent.tools?.allow ?? [];
  const denyTools = agent.tools?.deny ?? [];
  if (allowTools.length > 0 || denyTools.length > 0) {
    lines.push('tools:');
    if (allowTools.length > 0) {
      lines.push(`  allow: [${allowTools.join(', ')}]`);
    }
    if (denyTools.length > 0) {
      lines.push(`  deny: [${denyTools.join(', ')}]`);
    }
  }

  if (agent.permissionMode && agent.permissionMode !== 'default') {
    lines.push(`permissionMode: ${agent.permissionMode}`);
  }

  if (agent.maxTurns !== undefined) {
    lines.push(`maxTurns: ${agent.maxTurns}`);
  }

  if (agent.color) {
    lines.push(`color: ${agent.color}`);
  }

  lines.push('---');
  lines.push('');
  lines.push(agent.systemPrompt);

  const qualifiesForProjectCommands = agent.permissionMode === 'acceptEdits' || agent.permissionMode === 'full';
  const attachedIds = new Set(agent.projectCommandTools ?? []);
  const attachedTools = projectCommandTools.filter((tool) => attachedIds.has(tool.id));
  if (qualifiesForProjectCommands && attachedTools.length > 0) {
    lines.push('', '## Available project commands', '');
    lines.push('Use run_command (Bash) to invoke exactly the command text shown below:');
    lines.push('');
    for (const tool of attachedTools) {
      lines.push(`- **${tool.name}**: \`${tool.command}\` — ${tool.description}`);
    }
  }

  const attachedDeclarativeIds = new Set(agent.declarativeTools ?? []);
  const attachedDeclarativeTools = declarativeTools.filter((tool) => attachedDeclarativeIds.has(tool.id));
  if (attachedDeclarativeTools.length > 0) {
    lines.push('', '## Available declarative tools', '');
    lines.push('Read-only, safe-by-construction — never executes code:');
    lines.push('');
    for (const tool of attachedDeclarativeTools) {
      const summary = tool.kind === 'web_read'
        ? `GET https://${tool.allowedHost} (https only, exact host, size-capped)`
        : `read \`${tool.path}\` (project-relative)`;
      lines.push(`- **${tool.name}**: ${summary} — ${tool.description}`);
    }
  }

  const attachedTransformIds = new Set(agent.transformTools ?? []);
  const attachedTransformTools = transformTools.filter((tool) => attachedTransformIds.has(tool.id));
  if (attachedTransformTools.length > 0) {
    lines.push('', '## Available transformation tools (managed missions only)', '');
    lines.push(
      'These are executed by MANAGED missions via a sandboxed `run_transform` tool ' +
      '(no fs/network/process access — pure computation only). This native Claude ' +
      'Code agent has no equivalent primitive to run them in-process; treat this ' +
      'list as documentation of intent, not a callable tool:',
    );
    lines.push('');
    for (const tool of attachedTransformTools) {
      lines.push(`- **${tool.name}** (id: \`${tool.id}\`) — ${tool.description}`);
    }
  }

  return lines.join('\n');
}

// ── Claude Code skill .md generator ──────────────────────────────

function buildSkillMd(agent: LazyAgent): string {
  const lines: string[] = [
    `# ${agent.displayName}`,
    '',
    agent.description,
    '',
    '## System Prompt',
    '',
    agent.systemPrompt,
  ];

  if (agent.skills && agent.skills.length > 0) {
    lines.push('', '## Related Skills', '');
    agent.skills.forEach((s) => lines.push(`- ${s}`));
  }

  return lines.join('\n');
}

// ── Tauri write helper ────────────────────────────────────────────

async function tauriWriteFile(path: string, content: string): Promise<void> {
  return invoke<void>('write_file', { path, content });
}

// ── Main compiler ──────────────────────────────────────────────────

export interface CompileResult {
  agentMdPath: string;
  skillMdPath?: string;
  content: string;
}

/**
 * Compile a LazyAgent to Claude Code agent definition files.
 * Writes:
 *   <projectRoot>/.claude/agents/<name>.md   — agent definition
 *   <projectRoot>/.claude/skills/<name>/SKILL.md  — if brainScope or skills set
 *
 * Returns the paths and generated content.
 */
export async function compileToClaudeCode(
  agent: LazyAgent,
  projectRoot: string,
): Promise<CompileResult> {
  const agentMd = buildClaudeCodeAgentMd(agent);
  const agentMdPath = `${projectRoot}/.claude/agents/${agent.name}.md`;

  await tauriWriteFile(agentMdPath, agentMd);

  let skillMdPath: string | undefined;

  if (agent.brainScope || (agent.skills && agent.skills.length > 0)) {
    const skillMd = buildSkillMd(agent);
    skillMdPath = `${projectRoot}/.claude/skills/${agent.name}/SKILL.md`;
    await tauriWriteFile(skillMdPath, skillMd);
  }

  return { agentMdPath, skillMdPath, content: agentMd };
}

/**
 * Provider-neutral dispatcher. Extend with additional backends here.
 */
export async function compileAgent(
  agent: LazyAgent,
  projectRoot: string,
  backend: CompilerBackend = 'claude-code',
): Promise<CompileResult> {
  switch (backend) {
    case 'claude-code':
      return compileToClaudeCode(agent, projectRoot);
    default: {
      const _exhaustive: never = backend;
      throw new Error(`compileAgent: unknown backend '${_exhaustive}'`);
    }
  }
}

// ── Web mock (for browser/dev mode without Tauri) ─────────────────

/** In-memory mock of compiled agents (web mode only). */
const _webMockFiles: Map<string, string> = new Map();

export function getWebMockFile(path: string): string | undefined {
  return _webMockFiles.get(path);
}

/**
 * Web-mode compile: generates content but stores in memory instead of disk.
 * Used by tests and browser-only demo mode.
 */
export function compileToClaudeCodeWeb(
  agent: LazyAgent,
  projectRoot: string,
): CompileResult {
  const agentMd = buildClaudeCodeAgentMd(agent);
  const agentMdPath = `${projectRoot}/.claude/agents/${agent.name}.md`;
  _webMockFiles.set(agentMdPath, agentMd);

  let skillMdPath: string | undefined;
  if (agent.brainScope || (agent.skills && agent.skills.length > 0)) {
    const skillMd = buildSkillMd(agent);
    skillMdPath = `${projectRoot}/.claude/skills/${agent.name}/SKILL.md`;
    _webMockFiles.set(skillMdPath, skillMd);
  }

  return { agentMdPath, skillMdPath, content: agentMd };
}
