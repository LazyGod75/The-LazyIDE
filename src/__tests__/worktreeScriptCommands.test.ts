/**
 * Tests for worktreeScriptCommands.ts — the TS-side mirror of the Rust
 * scoped worktree-script allowlist (src-tauri/src/commands/shell.rs's
 * matches_worktree_script_allowlist). See that Rust file's table-driven
 * tests for the authoritative, execution-side coverage; this suite pins
 * down the TS-side gate-eligibility mirror used by
 * managedToolPermissions.checkToolExecution.
 */

import { describe, it, expect } from 'vitest';
import { isWorktreeScriptCommand } from '../lib/agents/worktreeScriptCommands';

describe('isWorktreeScriptCommand — accepts known build/test shapes', () => {
  it.each([
    'npm run build',
    'npm run build:web',
    'npm test',
    'npm test -- --run',
    'npm ci',
    'npm install',
    'npx tsc',
    'npx tsc --noEmit',
    'npx vite build',
    'npx vitest',
    'npx vitest run',
    'cargo check',
    'cargo build',
    'cargo build --release',
    'cargo test',
    'cargo test --lib',
  ])('allows "%s"', (cmd) => {
    expect(isWorktreeScriptCommand(cmd)).toBe(true);
  });
});

describe('isWorktreeScriptCommand — rejects non-script commands', () => {
  it.each([
    '',
    '   ',
    'rm -rf .',
    'git push --force',
    'npmrun build',
    'curl http://evil.example',
    'shutdown /s',
    'npx',
    'npm',
    'cargo',
  ])('denies "%s"', (cmd) => {
    expect(isWorktreeScriptCommand(cmd)).toBe(false);
  });
});

describe('isWorktreeScriptCommand — rejects chaining, piping, redirection, substitution', () => {
  it.each([
    'npm run build && rm -rf .',
    'npm test; shutdown /s',
    'npm test | sh',
    'npm run build > out.log',
    'npm run build $(evil)',
    'npm run build `evil`',
    'npm test\nrm -rf .',
  ])('denies "%s"', (cmd) => {
    expect(isWorktreeScriptCommand(cmd)).toBe(false);
  });
});
