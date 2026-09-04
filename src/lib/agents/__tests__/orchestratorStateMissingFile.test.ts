/* orchestratorStateMissingFile.test.ts — Regression coverage for the
   console-noise fix: a project with no `.lazy/orchestrators.json` yet (the
   NORMAL state for any project that has never had an orchestrator created)
   must resolve to an empty list WITHOUT throwing and WITHOUT logging at
   warn/error level — see orchestratorState.ts's loadOrchestratorsJson doc
   comment for the locale bug this fixes (the previous English-substring
   check never matched the OS's own localized "file not found" message, so
   this branch fired console.warn on every single missing-file read).

   A genuine, unrelated failure (not a missing-file condition) must still be
   logged — this is not "swallow every read_file error silently", only the
   expected-absence case.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listOrchestrators, createOrchestrator } from '../orchestratorState';

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const createDirMock = vi.fn();

vi.mock('../../platform', () => ({
  getPlatform: () => ({
    fs: {
      readFile: readFileMock,
      writeFile: writeFileMock,
      createDir: createDirMock,
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  writeFileMock.mockResolvedValue(undefined);
  createDirMock.mockResolvedValue(undefined);
});

describe('loadOrchestratorsJson — absent .lazy/orchestrators.json', () => {
  it('resolves to [] without logging when the OS reports ENOENT in English (os error 2)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileMock.mockRejectedValue(
      new Error("read_file: metadata failed for 'C:\\proj\\.lazy\\orchestrators.json': The system cannot find the file specified. (os error 2)"),
    );

    const result = await listOrchestrators('C:\\proj');

    expect(result).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('resolves to [] without logging when the OS message is LOCALIZED (French Windows, os error 2) — the real reported bug', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Byte-for-byte the message reported in production: French Windows
    // FormatMessageW text, which contains none of the old English
    // substrings ('cannot find', 'No such file', 'not find') this check
    // used to require.
    readFileMock.mockRejectedValue(
      new Error(
        "read_file: metadata failed for 'C:\\Users\\user\\Documents\\cerveau\\scratchpad\\uc-smoke-2026-08-12\\.lazy\\orchestrators.json': Le fichier spécifié est introuvable. (os error 2)",
      ),
    );

    const result = await listOrchestrators('C:\\Users\\user\\Documents\\cerveau\\scratchpad\\uc-smoke-2026-08-12');

    expect(result).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('resolves to [] without logging for the missing-parent-directory case (os error 3)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileMock.mockRejectedValue(
      new Error("path canonicalize failed for 'C:\\proj\\.lazy\\orchestrators.json': Le chemin d’accès spécifié est introuvable. (os error 3)"),
    );

    const result = await listOrchestrators('C:\\proj');

    expect(result).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still logs a genuine, unrelated failure (permission denied) instead of swallowing it silently', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileMock.mockRejectedValue(new Error('read_file failed: access is denied (os error 5)'));

    const result = await listOrchestrators('C:\\proj');

    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[orchestratorState] load failed:');
    warnSpy.mockRestore();
  });

  it('createOrchestrator on a brand-new project (no orchestrators.json yet) never warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readFileMock.mockRejectedValue(
      new Error("read_file: metadata failed for 'C:\\proj\\.lazy\\orchestrators.json': Le fichier spécifié est introuvable. (os error 2)"),
    );

    const orch = await createOrchestrator({
      projectRoot: 'C:\\proj',
      projectId: 'p1',
      name: 'First plan',
      objective: 'Ship it',
      steps: [{ description: 'Do the thing' }],
    });

    expect(orch.id).toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
