/**
 * healthPanelGitCheck.test.ts
 *
 * Regression coverage for the Settings > Health "Git: down" false red
 * (observed live 2026-08-14): TauriPlatform.health() used to call
 * git_current_branch with repoPath: '.', which resolves against the app
 * PROCESS's cwd — the workspace parent directory — instead of any
 * registered project root. The Rust path-jail guard
 * (commands/util.rs::ensure_repo_in_any_open_project) then rejected every
 * single check with "access denied: '.' is outside every registered
 * project root (N checked)", even though git itself was perfectly healthy.
 *
 * Confirmed as a false red by running git directly inside a real registered
 * root (`git -C <root> rev-parse --abbrev-ref HEAD`), which succeeds — git
 * was never the problem, only the path the health check happened to probe.
 *
 * These tests pin the fix: the git check must target the active project's
 * root (get_project_root, kept in sync with the registry by
 * project_set_active — see state.rs's ProjectState doc comment), and must
 * report 'unknown' (not 'down') when no project is open at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TauriPlatform } from '../lib/platform/tauri';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

describe('TauriPlatform.health() — git check targets the active project root', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('reports git "ok" and passes the ACTIVE PROJECT ROOT to git_current_branch — never repoPath: "."', async () => {
    const projectRoot = String.raw`C:\Users\user\Documents\cerveau\scratchpad\uc-smoke-c`;
    let gitRepoPathArg: unknown;
    mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'get_project_root') return Promise.resolve(projectRoot);
      if (cmd === 'git_current_branch') {
        gitRepoPathArg = (args as { repoPath: string }).repoPath;
        return Promise.resolve('master');
      }
      return Promise.resolve(undefined);
    });

    const report = await TauriPlatform.health();

    expect(gitRepoPathArg).toBe(projectRoot);
    expect(gitRepoPathArg).not.toBe('.');
    expect(report.git).toBe('ok');
  });

  it('reports git "unknown" (not "down") when no project is open, and never calls git_current_branch at all', async () => {
    let gitCalled = false;
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_project_root') return Promise.resolve('');
      if (cmd === 'git_current_branch') {
        gitCalled = true;
        return Promise.resolve('master');
      }
      return Promise.resolve(undefined);
    });

    const report = await TauriPlatform.health();

    expect(gitCalled).toBe(false);
    expect(report.git).toBe('unknown');
    expect(report.git).not.toBe('down');
  });

  it('still reports git "down" with the real error when a project IS open but git genuinely fails', async () => {
    const projectRoot = String.raw`C:\Users\user\Documents\cerveau\Lazy`;
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_project_root') return Promise.resolve(projectRoot);
      if (cmd === 'git_current_branch') {
        return Promise.reject(new Error('git rev-parse failed: not a git repository'));
      }
      return Promise.resolve(undefined);
    });

    const report = await TauriPlatform.health();

    expect(report.git).toBe('down');
    expect(report.details?.git).toContain('git rev-parse failed');
  });
});
