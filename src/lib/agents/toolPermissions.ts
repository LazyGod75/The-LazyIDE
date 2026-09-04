// toolPermissions.ts — Tool permission system with glob patterns.
//
// Inspired by Continue's allow/ask/exclude model, but adapted for Lazy's
// agent system and enhanced with brain-powered permission learning.
//
// Permission levels:
// - allow:  tool is auto-approved
// - ask:    user is prompted before each call
// - exclude: tool is blocked entirely
//
// Glob patterns:
// - Write(/** /*.ts) — matches Write calls where the primary arg matches the glob
// - Bash(npm install*) — matches Bash calls starting with "npm install"
// - Write(*) — matches all Write calls
//
// Persistence:
// - ~/.lazy/permissions.yaml (user-level, cross-project)
// - .lazy/permissions.yaml (project-level, overrides user-level)
// - Precedence: mode policies > CLI flags > project yaml > user yaml > defaults
//
// Brain synergy:
// - When the user approves/asks/rejects a tool call, the brain captures the decision
// - After N decisions, the brain generates a workflow_suggestion insight
// - That insight is converted into a permission rule automatically

// ── Types ─────────────────────────────────────────────────────────

export type PermissionLevel = 'allow' | 'ask' | 'exclude';

export interface PermissionRule {
  // Tool name with optional glob pattern: e.g. Write(glob) or Bash(cmd*)
  pattern: string;
  level: PermissionLevel;
  /** Source of this rule: "user", "project", "brain", "cli", "default" */
  source: 'user' | 'project' | 'brain' | 'cli' | 'default';
  /** When the rule was created */
  createdAt: string;
  /** Optional description (for brain-generated rules) */
  description?: string;
}

export interface PermissionConfig {
  rules: PermissionRule[];
}

export type AgentPermissionMode = 'auto' | 'readonly' | 'default';

// ── Defaults ──────────────────────────────────────────────────────

export const DEFAULT_RULES: PermissionRule[] = [
  // Read-only tools: always allowed
  { pattern: 'Read', level: 'allow', source: 'default', createdAt: '', description: 'Read files' },
  { pattern: 'List', level: 'allow', source: 'default', createdAt: '', description: 'List directories' },
  { pattern: 'Search', level: 'allow', source: 'default', createdAt: '', description: 'Search codebase' },
  { pattern: 'Fetch', level: 'allow', source: 'default', createdAt: '', description: 'Fetch URLs' },
  { pattern: 'Diff', level: 'allow', source: 'default', createdAt: '', description: 'View diffs' },
  { pattern: 'Grep', level: 'allow', source: 'default', createdAt: '', description: 'Grep files' },
  { pattern: 'Glob', level: 'allow', source: 'default', createdAt: '', description: 'Glob search' },
  // Write tools: ask by default
  { pattern: 'Write', level: 'ask', source: 'default', createdAt: '', description: 'Write files' },
  { pattern: 'Edit', level: 'ask', source: 'default', createdAt: '', description: 'Edit files' },
  { pattern: 'MultiEdit', level: 'ask', source: 'default', createdAt: '', description: 'Multi-edit files' },
  // Dangerous tools: ask by default
  { pattern: 'Bash', level: 'ask', source: 'default', createdAt: '', description: 'Run shell commands' },
];

// ── Pattern matching ──────────────────────────────────────────────

// Parse a pattern like Write(glob) into { tool, glob }
function parsePattern(pattern: string): { tool: string; glob: string | null } {
  const parenIdx = pattern.indexOf('(');
  if (parenIdx === -1) return { tool: pattern, glob: null };
  const tool = pattern.slice(0, parenIdx);
  const glob = pattern.slice(parenIdx + 1, pattern.lastIndexOf(')'));
  return { tool, glob: glob || null };
}

// Regex-special characters that must be escaped when they appear literally
// in a glob (i.e. everywhere outside the '*', '**', and '?' tokens handled
// below).
const REGEX_SPECIAL_CHARS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/**
 * Convert a glob pattern to a RegExp for matching against tool arguments:
 * '**' -> '.*' (matches anything, including '/'); '*' -> '[^/]*' (matches
 * anything except '/', so a single star stays within one path/command
 * segment — use '**' when a pattern needs to cross one, e.g. a run_command
 * rule like Bash(rm -rf**) matching "rm -rf /tmp/build"); '?' -> '.'; every
 * other character is escaped so it matches literally.
 *
 * Single-pass, character-by-character construction — NOT insert-a-
 * placeholder-then-regex-escape-then-un-escape (the previous approach):
 * the escape step there necessarily also escaped the '.', '[', ']', '^'
 * characters just inserted for '.*'/'[^/]*', and the "re-introduce" fixup
 * afterwards expected an escaped '\*' that the escape step never produced
 * (it doesn't escape '*') — so it silently never matched, leaving every
 * '*'/'**' in every glob broken (matching nothing). One pass avoids the
 * insert/escape ordering problem entirely.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      pattern += '.*';
      i += 1; // consume both '*' of '**'
    } else if (ch === '*') {
      pattern += '[^/]*';
    } else if (ch === '?') {
      pattern += '.';
    } else if (REGEX_SPECIAL_CHARS.has(ch)) {
      pattern += `\\${ch}`;
    } else {
      pattern += ch;
    }
  }
  return new RegExp(`^${pattern}$`);
}

// Check if a tool call matches a permission pattern.
// pattern: the rule pattern e.g. Write(glob)
// toolName: the actual tool name being called
// toolArg: the primary argument e.g. file path or command string
export function matchesPattern(pattern: string, toolName: string, toolArg?: string): boolean {
  const { tool, glob } = parsePattern(pattern);
  if (tool !== toolName && tool !== '*') return false;
  if (!glob) return true; // No glob = match any arg
  if (!toolArg) return false;
  if (glob === '*') return true;

  try {
    return globToRegExp(glob).test(toolArg);
  } catch {
    // If regex fails, fall back to simple includes
    return toolArg.includes(glob.replace(/\*/g, ''));
  }
}

// ── Permission resolution ─────────────────────────────────────────

/**
 * Resolve the permission level for a tool call by checking rules in precedence order.
 * Returns the first matching rule's level, or the default for the tool.
 *
 * 'readonly' is a hard ceiling enforced BEFORE any rule is consulted: only
 * read-only tools are ever allowed, and rules cannot loosen it.
 *
 * 'auto' has NO special-case here (SECURITY FIX): it used to short-circuit
 * straight to 'allow' for every tool, which meant an explicit 'exclude'
 * rule (e.g. "never touch .env", a brain-learned "never run rm -rf") was
 * silently bypassed the instant a mission ran unattended — a CRITICAL gap
 * once this engine is actually wired into a live agent loop (see
 * managedAgentPolicy.checkToolExecution, the first real caller). 'auto' now
 * resolves through the exact same rule-matching as 'default': 'exclude'
 * and 'allow' rules are honored exactly as configured, honestly. What a
 * caller DOES with an 'ask' verdict when no human is attending to answer it
 * is a mode-aware policy decision that belongs to the caller, not here —
 * this function's only job is to report what the rules say.
 */
export function resolvePermission(
  toolName: string,
  toolArg: string | undefined,
  rules: PermissionRule[],
  mode: AgentPermissionMode = 'default',
): PermissionLevel {
  if (mode === 'readonly') {
    // Only read-only tools allowed
    const readOnlyTools = ['Read', 'List', 'Search', 'Fetch', 'Diff', 'Grep', 'Glob'];
    if (readOnlyTools.includes(toolName)) return 'allow';
    return 'exclude';
  }

  // Check rules in order (rules are already sorted by precedence) — applies
  // to 'auto' and 'default' alike.
  for (const rule of rules) {
    if (matchesPattern(rule.pattern, toolName, toolArg)) {
      return rule.level;
    }
  }

  // Fall back to defaults
  const defaultRule = DEFAULT_RULES.find(r => r.pattern === toolName || r.pattern === toolName.split('(')[0]);
  return defaultRule?.level ?? 'ask';
}

// ── Persistence ───────────────────────────────────────────────────

const USER_PERMS_KEY = 'lazy.permissions.user';
const PROJECT_PERMS_KEY = 'lazy.permissions.project';

const VALID_PERMISSION_LEVELS: ReadonlySet<PermissionLevel> = new Set(['allow', 'ask', 'exclude']);
const VALID_RULE_SOURCES: ReadonlySet<PermissionRule['source']> = new Set([
  'user',
  'project',
  'brain',
  'cli',
  'default',
]);

/** True when `value` is a structurally valid PermissionRule. Every field is
 *  checked explicitly (no schema library in this repo) rather than trusted
 *  via a type cast. */
function isValidPermissionRule(value: unknown): value is PermissionRule {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.pattern === 'string' &&
    typeof r.level === 'string' &&
    VALID_PERMISSION_LEVELS.has(r.level as PermissionLevel) &&
    typeof r.source === 'string' &&
    VALID_RULE_SOURCES.has(r.source as PermissionRule['source']) &&
    typeof r.createdAt === 'string' &&
    (r.description === undefined || typeof r.description === 'string')
  );
}

/**
 * Parses a persisted PermissionConfig, validating its shape explicitly.
 *
 * SECURITY: this is a permissions system, not just a data cache — invalid or
 * unrecognised data must never be trusted into a MORE permissive state than
 * DEFAULT_RULES already provides. A top-level shape that isn't a well-formed
 * `{ rules: [...] }` (corrupted JSON, hand-edited to something else, an
 * array instead of an object, etc.) is discarded entirely, falling back to
 * `{ rules: [] }` — the app's curated DEFAULT_RULES then apply instead of an
 * unverifiable structure. Inside a well-formed array, each individual rule
 * is validated on its own (isValidPermissionRule) and a rule that fails
 * validation is DROPPED rather than trusted — never assumed to be an
 * 'allow', and never assumed to carry the level a corrupted file might
 * claim. When in doubt, the rule is refused, never granted. Never throws.
 */
function parsePermissionConfig(raw: string): PermissionConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rules: [] };
  }
  if (typeof parsed !== 'object' || parsed === null) return { rules: [] };
  const rawRules = (parsed as Record<string, unknown>).rules;
  if (!Array.isArray(rawRules)) return { rules: [] };
  return { rules: rawRules.filter(isValidPermissionRule) };
}

export function loadUserPermissions(): PermissionConfig {
  try {
    const raw = localStorage.getItem(USER_PERMS_KEY);
    if (!raw) return { rules: [] };
    return parsePermissionConfig(raw);
  } catch {
    return { rules: [] };
  }
}

export function saveUserPermissions(config: PermissionConfig): void {
  try {
    localStorage.setItem(USER_PERMS_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

export function loadProjectPermissions(): PermissionConfig {
  try {
    const raw = localStorage.getItem(PROJECT_PERMS_KEY);
    if (!raw) return { rules: [] };
    return parsePermissionConfig(raw);
  } catch {
    return { rules: [] };
  }
}

export function saveProjectPermissions(config: PermissionConfig): void {
  try {
    localStorage.setItem(PROJECT_PERMS_KEY, JSON.stringify(config));
  } catch { /* ignore */ }
}

/**
 * Get the merged permission rules in precedence order:
 * project rules > user rules > defaults
 */
export function getMergedRules(): PermissionRule[] {
  const project = loadProjectPermissions().rules;
  const user = loadUserPermissions().rules;
  // Project rules first (higher precedence), then user rules, then defaults
  return [...project, ...user, ...DEFAULT_RULES];
}

/**
 * Add a permission rule. Automatically deduplicates by pattern.
 */
export function addPermissionRule(
  pattern: string,
  level: PermissionLevel,
  source: 'user' | 'project' | 'brain' = 'user',
  description?: string,
): void {
  const config = source === 'project' ? loadProjectPermissions() : loadUserPermissions();
  const existing = config.rules.find(r => r.pattern === pattern);
  if (existing) {
    existing.level = level;
    existing.description = description;
  } else {
    config.rules.push({
      pattern,
      level,
      source,
      createdAt: new Date().toISOString(),
      description,
    });
  }
  if (source === 'project') saveProjectPermissions(config);
  else saveUserPermissions(config);
}

/**
 * Remove a permission rule by pattern.
 */
export function removePermissionRule(pattern: string, source: 'user' | 'project' = 'user'): void {
  const config = source === 'project' ? loadProjectPermissions() : loadUserPermissions();
  config.rules = config.rules.filter(r => r.pattern !== pattern);
  if (source === 'project') saveProjectPermissions(config);
  else saveUserPermissions(config);
}

// ── Brain-powered permission learning ─────────────────────────────

/**
 * Record a user's permission decision for brain capture.
 * After N decisions on the same tool+pattern, a rule is auto-generated.
 */
interface PermissionDecision {
  tool: string;
  arg?: string;
  decision: PermissionLevel;
  timestamp: string;
}

const DECISIONS_KEY = 'lazy.permissionDecisions';
const AUTO_RULE_THRESHOLD = 3;

function loadDecisions(): PermissionDecision[] {
  try {
    const raw = localStorage.getItem(DECISIONS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PermissionDecision[];
  } catch {
    return [];
  }
}

function saveDecisions(decisions: PermissionDecision[]): void {
  try {
    // Keep only last 100 decisions
    localStorage.setItem(DECISIONS_KEY, JSON.stringify(decisions.slice(-100)));
  } catch { /* ignore */ }
}

/**
 * Record a permission decision and potentially auto-generate a rule.
 * Returns the auto-generated rule if one was created, or null.
 */
export function recordPermissionDecision(
  tool: string,
  arg: string | undefined,
  decision: PermissionLevel,
): PermissionRule | null {
  const decisions = loadDecisions();
  const entry: PermissionDecision = {
    tool,
    arg,
    decision,
    timestamp: new Date().toISOString(),
  };
  decisions.push(entry);
  saveDecisions(decisions);

  // Check if we have enough decisions to auto-generate a rule
  const similar = decisions.filter(d =>
    d.tool === tool &&
    d.decision === decision &&
    decisions.indexOf(d) > decisions.length - 50, // recent decisions only
  );

  if (similar.length >= AUTO_RULE_THRESHOLD) {
    // Try to find a common pattern in the args
    const args = similar.map(d => d.arg).filter(Boolean) as string[];
    let pattern = tool;

    if (args.length > 0) {
      // Simple heuristic: if all args share a file extension, create a glob
      const extensions = new Set(args.map(a => a.split('.').pop() ?? ''));
      if (extensions.size === 1) {
        const ext = [...extensions][0];
        pattern = `${tool}(**/*.${ext})`;
      } else {
        // Check if all args start with the same directory
        const dirs = new Set(args.map(a => a.split('/')[0] ?? a.split('\\')[0] ?? ''));
        if (dirs.size === 1) {
          const dir = [...dirs][0];
          pattern = `${tool}(${dir}/**)`;
        }
      }
    }

    const rule: PermissionRule = {
      pattern,
      level: decision,
      source: 'brain',
      createdAt: new Date().toISOString(),
      description: `Auto-generated from ${similar.length} repeated decisions`,
    };

    addPermissionRule(pattern, decision, 'user', rule.description);
    return rule;
  }

  return null;
}
