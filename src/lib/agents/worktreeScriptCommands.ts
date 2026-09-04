/* worktreeScriptCommands — TS-side mirror of the Rust scoped worktree-script
   allowlist (src-tauri/src/commands/shell.rs's matches_worktree_script_allowlist).

   BLOQUANT (R5 dogfood, 2026-07): a verification mission ("vérifier que le
   build passe") had every npm/PowerShell/Bash attempt blocked by the managed
   loop's general Bash permission gate (managedToolPermissions.ts) — 'ask'
   fails closed for any unattended mission, correctly, since there is no
   synchronous approval surface. The fix is NOT to loosen the general Bash
   rule (that would be a hole); it is a narrow, additional escape hatch: an
   acceptEdits/full mission may run its OWN package.json scripts (or the
   cargo equivalent) inside its OWN worktree, nothing else.

   This module is the TS-side half of that allowlist — used by
   managedToolPermissions.checkToolExecution to decide whether a run_command
   call is even ELIGIBLE to bypass the general Bash rule and reach
   toolRuntime.ts's scoped path (which calls the Rust
   is_worktree_script_eligible / run_worktree_script commands, the actual
   tamper-proof enforcement point — see that file's own header comment for
   why the check is duplicated on both sides, mirroring the existing
   sensitiveCommands.ts <-> shell.rs's check_command_denylist convention).

   Deliberately kept in lock-step with the Rust allowlist: same tokenized
   (not substring) matching, same "no chaining/piping/redirection/
   substitution" rule, same command shapes. A mismatch between the two
   sides is not a security hole (Rust is authoritative and re-checks from
   scratch), but it WOULD produce a confusing "the gate said yes but the
   command was rejected" — kept identical on purpose.
*/

/** Characters that turn a single literal invocation into a shell pipeline/
 *  chain/substitution — forbidden here for the same reason shell.rs's
 *  matches_worktree_script_allowlist forbids them: a qualifying call is
 *  always ONE literal command, never "allowed command + something else". */
const FORBIDDEN_CHARS = ['&', '|', ';', '\n', '\r', '`', '$', '>', '<'];

/** Command-shape allowlist, expressed as tokenized prefixes. `null` in the
 *  script-name slot means "any single token is accepted there" (e.g. `npm
 *  run <any script name>`) — mirrors the Rust `_script` wildcard binding. */
const ALLOWED_SHAPES: ReadonlyArray<ReadonlyArray<string | null>> = [
  ['npm', 'run', null],
  ['npm', 'test'],
  ['npm', 'ci'],
  ['npm', 'install'],
  ['npx', 'tsc'],
  ['npx', 'vite', 'build'],
  ['npx', 'vitest'],
  ['cargo', 'check'],
  ['cargo', 'build'],
  ['cargo', 'test'],
];

function matchesShape(tokens: string[], shape: ReadonlyArray<string | null>): boolean {
  if (tokens.length < shape.length) return false;
  return shape.every((expected, i) => expected === null || expected === tokens[i]);
}

/**
 * True when `command` is a literal invocation of one of the allowlisted
 * package-manager/build/test scripts — the same narrow set
 * shell.rs's matches_worktree_script_allowlist enforces server-side. Never
 * true for a command carrying chaining/piping/redirection/substitution
 * characters, regardless of what precedes them.
 */
export function isWorktreeScriptCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (FORBIDDEN_CHARS.some((ch) => trimmed.includes(ch))) return false;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return ALLOWED_SHAPES.some((shape) => matchesShape(tokens, shape));
}
