/* agentDef.ts — Provider-neutral LazyAgent schema (source of truth).
   A LazyAgent compiles to whatever backend is active (Phase 1: Claude Code).
   Never mutate — always return new objects.
*/

// ── Color palette (8 colors from design system) ───────────────────

export type AgentColor =
  | 'violet'
  | 'cyan'
  | 'green'
  | 'amber'
  | 'pink'
  | 'red'
  | 'blue'
  | 'indigo';

export const AGENT_COLOR_MAP: Record<AgentColor, string> = {
  violet: '#7C5CFF',
  cyan:   '#4FC3F7',
  green:  '#66E27A',
  amber:  '#FFC76B',
  pink:   '#FF7BB0',
  red:    '#F87171',
  blue:   '#60A5FA',
  indigo: '#9B7CFF',
};

// ── Model tier ────────────────────────────────────────────────────

export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'inherit';

// ── Memory scope ──────────────────────────────────────────────────

export type MemoryScope = 'user' | 'project' | 'local';

// ── Agent scope ───────────────────────────────────────────────────

export type AgentScope = 'user' | 'project';

// ── Trigger configuration ──────────────────────────────────────────

export interface DragDropTrigger {
  acceptsFileTypes?: string[];
}

export interface ScheduleTrigger {
  cron: string;
  mode: 'local' | 'cloud';
  enabled: boolean;
}

export interface AgentTriggers {
  manual: true;
  dragDrop?: DragDropTrigger;
  schedule?: ScheduleTrigger;
  event?: string; // placeholder
}

// ── Tool permissions ──────────────────────────────────────────────

export interface AgentTools {
  allow?: string[];
  deny?: string[];
}

// ── Main schema ───────────────────────────────────────────────────

export interface LazyAgent {
  id: string;
  /** kebab-case unique name, used as filename */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Routing description: "when to use" — min 20 words recommended */
  description: string;
  color: AgentColor;
  tags: string[];
  systemPrompt: string;
  skills?: string[];
  brainScope?: string;
  memory?: MemoryScope;
  modelTier: ModelTier;
  effort?: 'low' | 'medium' | 'high';
  tools?: AgentTools;
  /** Permission mode for this agent.
   * 'default' = no extra flag (agent library / wizard default)
   * 'acceptEdits' = auto-accept file edits in isolated worktrees
   * 'plan' = read-only, produce a plan
   * 'full' = full bypass (--dangerously-skip-permissions), explicit opt-in only
   * 'bypassPermissions' = legacy alias for 'full' (kept for backward compatibility)
   */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'full' | 'bypassPermissions';
  /**
   * Explicit allowlist of tool names passed to --allowedTools at runtime.
   * Mirrors tools.allow but available as a flat array for direct wiring.
   */
  allowedTools?: string[];
  /**
   * Explicit denylist of tool names passed to --disallowedTools at runtime.
   * Mirrors tools.deny but available as a flat array for direct wiring.
   */
  deniedTools?: string[];
  maxTurns?: number;
  isolation?: 'worktree' | null;
  /**
   * W-BYO row 2 — ids of `ProjectCommandTool`s (projectCommandTools.ts) this
   * agent is granted awareness of. Purely a DISCOVERY/naming layer: the
   * actual execution still goes through the existing `run_command` tool and
   * the existing R6b scoped-worktree-script gate
   * (worktreeScriptCommands.ts/managedToolPermissions.ts) unchanged — no new
   * execution surface is introduced by this field. Only meaningful when
   * `permissionMode` is 'acceptEdits' or 'full' (the same modes the R6b gate
   * itself requires); see projectCommandTools.ts's module header.
   */
  projectCommandTools?: string[];
  /**
   * W-PROVE row 3 — ids of `DeclarativeTool`s (declarativeTools.ts) this
   * agent is granted awareness of: a « lecture web » (allowlisted-host HTTP
   * GET) and/or a « lecture fichier projet » (project-relative file read).
   * Same DISCOVERY-only convention as `projectCommandTools` above — neither
   * declarative kind executes user-authored code, so unlike that field this
   * one carries no `permissionMode` gate at all (see AgentWizard.tsx's
   * DeclarativeToolsSection).
   */
  declarativeTools?: string[];
  /**
   * W-CODE — ids of `TransformTool`s (transformTools.ts) this agent is
   * granted awareness of: a user-authored PURE JS `(input) => output`
   * function, run in an isolated sandbox with zero ambient authority (no
   * fs/network/process — see transformSandbox.ts's module header for the
   * full threat model). Same DISCOVERY-only convention as
   * `projectCommandTools`/`declarativeTools` above — no `permissionMode`
   * gate (a pure computation has no side effects to bound) — see
   * AgentWizard.tsx's TransformToolsSection.
   */
  transformTools?: string[];
  triggers: AgentTriggers;
  scope: AgentScope;
  createdAt: string;
}

// ── Validation ────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateAgent(agent: Partial<LazyAgent>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!agent.name || agent.name.trim().length === 0) {
    errors.push('name is required');
  } else if (!/^[a-z0-9-]+$/.test(agent.name)) {
    errors.push('name must be kebab-case (lowercase, hyphens only)');
  }

  if (!agent.displayName || agent.displayName.trim().length === 0) {
    errors.push('displayName is required');
  }

  if (!agent.systemPrompt || agent.systemPrompt.trim().length === 0) {
    errors.push('systemPrompt is required');
  }

  const descWordCount = (agent.description ?? '').split(/\s+/).filter(Boolean).length;
  if (descWordCount < 20) {
    warnings.push(`description has ${descWordCount} words — 20+ recommended for good routing`);
  }

  if (!agent.modelTier) {
    errors.push('modelTier is required');
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Starter templates ─────────────────────────────────────────────

export function createAgentTemplate(templateKey: 'security-reviewer' | 'test-writer' | 'refactor'): Omit<LazyAgent, 'id' | 'createdAt' | 'scope'> {
  const base: Pick<LazyAgent, 'triggers' | 'modelTier' | 'memory' | 'isolation'> = {
    triggers: { manual: true },
    modelTier: 'sonnet',
    memory: 'project',
    isolation: 'worktree',
  };

  switch (templateKey) {
    case 'security-reviewer':
      return {
        ...base,
        name: 'security-reviewer',
        displayName: 'Security Reviewer',
        description:
          'Use this agent to review code for security vulnerabilities, exposed secrets, injection risks, missing authentication, and unsafe dependencies. Run before any commit touching auth, API, or data handling code.',
        color: 'red',
        tags: ['security', 'review'],
        systemPrompt:
          'You are a senior security engineer. Review the provided code for: hardcoded secrets, SQL injection, XSS, CSRF, authentication bypass, insecure dependencies, exposed error details, and missing rate limiting. For each issue: severity (CRITICAL/HIGH/MEDIUM/LOW), file+line, description, and fix recommendation. End with a checklist summary.',
        tools: { deny: ['WebSearch', 'computer'] },
        permissionMode: 'plan',
        maxTurns: 20,
      };

    case 'test-writer':
      return {
        ...base,
        name: 'test-writer',
        displayName: 'Test Writer',
        description:
          'Use this agent to write unit tests, integration tests, and E2E tests for new or existing code. It follows TDD principles: write tests first, then verify they fail, then implement. Targets 80%+ coverage.',
        color: 'green',
        tags: ['tests', 'tdd', 'quality'],
        systemPrompt:
          'You are a TDD expert. Write comprehensive tests following the Red-Green-Refactor cycle. Use the project\'s existing test framework. Create tests that cover: happy path, edge cases, error handling, and boundary conditions. Aim for 80%+ coverage. Comment each test with the scenario it validates.',
        tools: { allow: ['Read', 'Write', 'Edit', 'Bash'] },
        permissionMode: 'acceptEdits',
        maxTurns: 30,
        effort: 'high',
      };

    case 'refactor':
      return {
        ...base,
        name: 'refactor-cleaner',
        displayName: 'Refactor Cleaner',
        description:
          'Use this agent to clean up code: remove dead code, reduce complexity, improve naming, apply immutable patterns, split large files, and eliminate duplication. Never changes behavior — only improves structure.',
        color: 'violet',
        tags: ['refactor', 'cleanup', 'quality'],
        systemPrompt:
          'You are a senior software engineer focused on code quality. Refactor the target code to: remove dead code, improve naming clarity, apply immutable patterns (never mutate, always return new), split functions > 50 lines, split files > 800 lines, eliminate duplication. NEVER change observable behavior. Write a summary of every change made.',
        tools: { allow: ['Read', 'Write', 'Edit', 'Bash'] },
        permissionMode: 'acceptEdits',
        maxTurns: 40,
        effort: 'medium',
      };
  }
}

// ── Factory ───────────────────────────────────────────────────────

export function createNewAgent(partial: Partial<LazyAgent> = {}): LazyAgent {
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: '',
    displayName: '',
    description: '',
    color: 'violet',
    tags: [],
    systemPrompt: '',
    modelTier: 'sonnet',
    triggers: { manual: true },
    scope: 'project',
    createdAt: new Date().toISOString(),
    ...partial,
  };
}
