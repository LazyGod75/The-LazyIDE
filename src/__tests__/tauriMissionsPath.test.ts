/**
 * tauriMissionsPath.test.ts
 *
 * Regression coverage for the missions.json "\\?\" verbatim-path bug (5th
 * instance of this bug class — see src/lib/paths.ts's header comment for the
 * first four): TauriPlatform.missions.save/load used to build the
 * .lazy/missions.json path via string concatenation
 * (`${projectRoot}/.lazy/missions.json`) instead of the shared joinPath()
 * helper. A Windows \\?\-prefixed projectRoot (get_project_root's
 * canonicalize() result) then produced a mixed-separator path the Rust fs
 * commands (fs_create_dir/write_file/read_file) could not resolve even
 * though the directory exists on disk — save() failed silently (its caller,
 * agentsStore.tsx's debounce effect, swallows the rejection as "persistence
 * failure must not affect UI") and mission history vanished on every
 * navigation/restart.
 *
 * Mirrors src/__tests__/paths.test.ts's style (verbatim-safe join
 * assertions) but exercises the fix through the real TauriPlatform.missions
 * API, since nativeMissions itself is not exported.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TauriPlatform } from '../lib/platform/tauri';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

interface InvokeCall {
  cmd: string;
  args: unknown;
}

describe('TauriPlatform.missions — verbatim-safe path join', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('save() joins a Windows \\\\?\\ verbatim projectRoot using backslash throughout, never a literal "/"', async () => {
    const calls: InvokeCall[] = [];
    mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      return Promise.resolve(undefined);
    });

    const projectRoot = String.raw`\\?\C:\Users\user\Documents\cerveau\Lazy`;
    await TauriPlatform.missions.save(projectRoot, [{ id: 'M1' }]);

    const createDirCall = calls.find((c) => c.cmd === 'fs_create_dir');
    const writeFileCall = calls.find((c) => c.cmd === 'write_file');

    expect((createDirCall?.args as { path: string }).path).toBe(
      String.raw`\\?\C:\Users\user\Documents\cerveau\Lazy\.lazy`,
    );
    expect((writeFileCall?.args as { path: string }).path).toBe(
      String.raw`\\?\C:\Users\user\Documents\cerveau\Lazy\.lazy\missions.json`,
    );
    expect((writeFileCall?.args as { path: string }).path).not.toContain('/');
    expect((writeFileCall?.args as { content: string }).content).toBe(JSON.stringify([{ id: 'M1' }]));
  });

  it('load() joins the same verbatim-safe path for read_file', async () => {
    const projectRoot = String.raw`\\?\C:\Users\user\Documents\cerveau\Lazy`;
    let readPath = '';
    mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === 'read_file') {
        readPath = (args as { path: string }).path;
        return Promise.resolve(JSON.stringify([{ id: 'M1' }]));
      }
      return Promise.resolve(undefined);
    });

    const result = await TauriPlatform.missions.load(projectRoot);

    expect(readPath).toBe(String.raw`\\?\C:\Users\user\Documents\cerveau\Lazy\.lazy\missions.json`);
    expect(readPath).not.toContain('/');
    expect(result).toEqual([{ id: 'M1' }]);
  });

  it('save()/load() still work with a POSIX projectRoot (no behavior change)', async () => {
    const calls: InvokeCall[] = [];
    mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'read_file') return Promise.resolve(JSON.stringify([]));
      return Promise.resolve(undefined);
    });

    await TauriPlatform.missions.save('/repo', []);
    const writeFileCall = calls.find((c) => c.cmd === 'write_file');
    expect((writeFileCall?.args as { path: string }).path).toBe('/repo/.lazy/missions.json');

    await TauriPlatform.missions.load('/repo');
    const readFileCall = calls.find((c) => c.cmd === 'read_file');
    expect((readFileCall?.args as { path: string }).path).toBe('/repo/.lazy/missions.json');
  });

  it('load() returns null (not throw) when read_file fails — pre-existing "file does not exist yet" behavior preserved', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.reject(new Error('not found'));
      return Promise.resolve(undefined);
    });

    const result = await TauriPlatform.missions.load(String.raw`\\?\C:\repo`);
    expect(result).toBeNull();
  });
});
