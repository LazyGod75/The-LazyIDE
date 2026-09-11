/**
 * Tests for src/lib/tools/handlers/shell.ts — runCommand's scoped worktree-
 * script path and its security-critical fallthrough behavior.
 *
 * REGRESSION (audit CRITICAL): when the scoped run_worktree_script path was
 * confirmed eligible but its execution then failed (timeout, IPC error, or
 * the command started then failed), the old code caught the error and fell
 * through to the general-purpose run_shell path — running the command
 * UNCONFINED when it was meant to be confined. These tests pin down that a
 * confirmed-eligible-but-failed scoped execution returns an honest error
 * instead of degrading to run_shell, while a plain "not eligible" verdict
 * still falls through to run_shell as before.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { runCommand } from '../lib/tools/handlers/shell';
import type { ToolExecutionContext } from '../lib/tools/handlers/types';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

function makeCtx(permissionMode: 'acceptEdits' | 'full' | 'plan' = 'acceptEdits'): ToolExecutionContext {
  return { rootPath: '/tmp/worktree', policy: { permissionMode }, agentMode: 'default' };
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

describe('runCommand — scoped worktree-script fallthrough security', () => {
  it('falls through to run_shell when the command is NOT eligible (safe)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'is_worktree_script_eligible') return Promise.resolve(false);
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    const result = await runCommand({ command: 'npm test' }, makeCtx('acceptEdits'));

    expect(result).toContain('[exit 0]');
    expect(mockedInvoke).toHaveBeenCalledWith('is_worktree_script_eligible', expect.any(Object));
    expect(mockedInvoke).toHaveBeenCalledWith('run_shell', expect.any(Object));
  });

  it('does NOT fall through to run_shell when scoped execution fails after eligibility was confirmed', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'is_worktree_script_eligible') return Promise.resolve(true);
      if (cmd === 'run_worktree_script') return Promise.reject(new Error('scoped timeout'));
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'unconfined', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    const result = await runCommand({ command: 'npm test' }, makeCtx('acceptEdits'));

    // Must surface an honest error, never the unconfined run_shell output.
    expect(result).toContain('ERROR');
    expect(result).not.toContain('unconfined');
    // run_shell must never have been called.
    const calls = mockedInvoke.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('run_shell');
  });

  it('does NOT fall through to run_shell under full mode either when scoped execution fails', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'is_worktree_script_eligible') return Promise.resolve(true);
      if (cmd === 'run_worktree_script') return Promise.reject(new Error('IPC error'));
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'leaked', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    const result = await runCommand({ command: 'npm run build' }, makeCtx('full'));

    expect(result).toContain('ERROR');
    expect(result).not.toContain('leaked');
    const calls = mockedInvoke.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('run_shell');
  });

  it('returns the scoped result unchanged when the scoped path succeeds', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'is_worktree_script_eligible') return Promise.resolve(true);
      if (cmd === 'run_worktree_script') return Promise.resolve({ stdout: 'built', stderr: '', exitCode: 0 });
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'should-not-happen', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    const result = await runCommand({ command: 'npm run build' }, makeCtx('acceptEdits'));

    expect(result).toContain('[exit 0]');
    expect(result).toContain('built');
    expect(result).not.toContain('should-not-happen');
    const calls = mockedInvoke.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('run_shell');
  });

  it('does not attempt the scoped path at all under plan mode', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'general', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    const result = await runCommand({ command: 'npm test' }, makeCtx('plan'));

    expect(result).toContain('general');
    const calls = mockedInvoke.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain('is_worktree_script_eligible');
    expect(calls).not.toContain('run_worktree_script');
  });
});
