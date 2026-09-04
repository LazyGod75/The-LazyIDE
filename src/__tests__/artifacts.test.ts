/**
 * artifacts.test.ts
 *
 * Regression coverage for the real-app QA bug: artifacts.ts's saveArtifacts/
 * loadArtifacts/listArtifacts built the '.lazy/artifacts' path via string
 * concatenation (`${repoPath}/${ARTIFACTS_DIR}`) instead of the shared
 * joinPath() helper. A Windows '\\?\'-prefixed repoPath then produced a
 * mixed-separator path the Rust fs commands rejected as "outside project
 * root" even though '.lazy/artifacts' exists on disk — the real console
 * error was:
 *   "[artifacts] Failed to save: access denied: path
 *    '\\?\C:\...\qa-project/.lazy/artifacts' is outside project root
 *    '\\?\C:\...\qa-project'"
 *
 * See src-tauri/src/commands/fs.rs (ensure_write_path_in_project_root) and
 * src/lib/paths.ts's header comment for the full bug-class history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveArtifacts, loadArtifacts, listArtifacts } from '../lib/agents/artifacts';
import type { Mission } from '../lib/agents/types';

const createDir = vi.fn().mockResolvedValue(undefined);
const writeFile = vi.fn().mockResolvedValue(undefined);
const readFile = vi.fn().mockRejectedValue(new Error('not found'));
const readDir = vi.fn().mockResolvedValue([]);

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    fs: { createDir, writeFile, readFile, readDir },
  })),
}));

function makeMission(): Mission {
  return {
    id: 'm-1',
    title: 'Test mission',
    status: 'review',
    model: 'haiku',
  } as unknown as Mission;
}

describe('artifacts — verbatim-safe path join', () => {
  beforeEach(() => {
    createDir.mockClear().mockResolvedValue(undefined);
    writeFile.mockClear().mockResolvedValue(undefined);
    readFile.mockClear().mockRejectedValue(new Error('not found'));
    readDir.mockClear().mockResolvedValue([]);
  });

  it('saveArtifacts() persists via a verbatim-safe joined path using backslash throughout, never a literal "/"', async () => {
    const repoPath = String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project`;
    await saveArtifacts(repoPath, makeMission());

    expect(createDir).toHaveBeenCalledWith(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy\artifacts`,
    );
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath] = writeFile.mock.calls[0] as [string, string];
    expect(writtenPath).toBe(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy\artifacts\m-1.json`,
    );
    expect(writtenPath).not.toContain('/');
  });

  it('loadArtifacts() reads via the same verbatim-safe joined path', async () => {
    const repoPath = String.raw`\\?\C:\repo`;
    await loadArtifacts(repoPath, 'm-1');

    expect(readFile).toHaveBeenCalledWith(String.raw`\\?\C:\repo\.lazy\artifacts\m-1.json`);
  });

  it('listArtifacts() reads the directory via the same verbatim-safe joined path', async () => {
    const repoPath = String.raw`\\?\C:\repo`;
    await listArtifacts(repoPath);

    expect(readDir).toHaveBeenCalledWith(String.raw`\\?\C:\repo\.lazy\artifacts`);
  });

  it('still works with a POSIX repoPath (no behavior change)', async () => {
    await saveArtifacts('/repo', makeMission());

    expect(createDir).toHaveBeenCalledWith('/repo/.lazy/artifacts');
    expect(writeFile).toHaveBeenCalledWith('/repo/.lazy/artifacts/m-1.json', expect.any(String));
  });

  it('a save failure is caught and warned, never thrown (best-effort)', async () => {
    createDir.mockRejectedValueOnce(new Error('access denied: outside project root'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(saveArtifacts('/repo', makeMission())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith('[artifacts] Failed to save:', expect.any(Error));
    warnSpy.mockRestore();
  });
});
