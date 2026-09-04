/**
 * createRuleBlock.test.ts
 *
 * Regression coverage for a Windows verbatim-path bug in createRuleBlock.ts:
 * loadRuleBlocks/createRuleBlock built the '.lazy/rules' path via
 * `${projectRoot}/${RULES_DIR}`.replace(/\\/g, '/') — forcing every
 * separator to a literal '/'. For a verbatim ('\\?\'-prefixed) projectRoot
 * (get_project_root's canonicalize() result on Windows) this was worse than
 * a plain hardcoded '/' join: it rewrote the '\\?\' prefix itself into
 * '//?/', an unresolvable path, in addition to mixing separators in the
 * appended suffix. Same underlying bug class as missionQueue.ts/
 * artifacts.ts — see src/lib/paths.ts's header comment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadRuleBlocks, createRuleBlock } from '../lib/ai/createRuleBlock';

const createDir = vi.fn().mockResolvedValue(undefined);
const writeFile = vi.fn().mockResolvedValue(undefined);
const readDir = vi.fn().mockResolvedValue([]);
const capture = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    fs: { createDir, writeFile, readDir, readFile: vi.fn().mockRejectedValue(new Error('not found')) },
    brain: { capture },
  })),
}));

describe('createRuleBlock — verbatim-safe path join', () => {
  beforeEach(() => {
    createDir.mockClear().mockResolvedValue(undefined);
    writeFile.mockClear().mockResolvedValue(undefined);
    readDir.mockClear().mockResolvedValue([]);
    capture.mockClear().mockResolvedValue({ ok: true });
  });

  it('createRuleBlock() persists via a verbatim-safe joined path using backslash throughout, never a literal "/"', async () => {
    const projectRoot = String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project`;

    const rule = await createRuleBlock(projectRoot, {
      name: 'Naming Convention',
      description: 'Files use kebab-case',
      content: 'All new files should use kebab-case naming.',
    });

    expect(createDir).toHaveBeenCalledWith(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy\rules`,
    );
    const [writtenPath] = writeFile.mock.calls[0] as [string, string];
    expect(writtenPath).toBe(
      String.raw`\\?\C:\Users\user\Documents\cerveau\qa-project\.lazy\rules\naming-convention.md`,
    );
    expect(writtenPath).not.toContain('/');
    expect(rule.path).toBe(writtenPath);
  });

  it('loadRuleBlocks() reads the directory via the same verbatim-safe joined path', async () => {
    const projectRoot = String.raw`\\?\C:\repo`;
    await loadRuleBlocks(projectRoot);

    expect(readDir).toHaveBeenCalledWith(String.raw`\\?\C:\repo\.lazy\rules`);
  });

  it('still works with a POSIX projectRoot (no behavior change)', async () => {
    const rule = await createRuleBlock('/repo', {
      name: 'test rule',
      description: 'desc',
      content: 'content',
    });

    expect(createDir).toHaveBeenCalledWith('/repo/.lazy/rules');
    expect(rule.path).toBe('/repo/.lazy/rules/test-rule.md');
  });
});
