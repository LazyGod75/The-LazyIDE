import { describe, it, expect, vi } from 'vitest';
import { appendAfterEditDiff } from '../lib/agents/afterEditDiff';

describe('appendAfterEditDiff', () => {
  it('leaves non-edit observations unchanged', async () => {
    const diffFile = vi.fn();
    const out = await appendAfterEditDiff({
      action: 'read_file',
      observation: 'ok',
      files: ['a.ts'],
      diffFile,
    });
    expect(out).toBe('ok');
    expect(diffFile).not.toHaveBeenCalled();
  });

  it('omits empty, clean, and failed diffs', async () => {
    const diffFile = vi.fn()
      .mockResolvedValueOnce('No changes')
      .mockResolvedValueOnce('ERROR: git_diff failed: missing');
    const out = await appendAfterEditDiff({
      action: 'edit_file',
      observation: 'edited a.ts',
      files: ['a.ts', 'b.ts'],
      diffFile,
    });
    expect(out).toBe('edited a.ts');
  });

  it('appends a real unified diff after a successful write', async () => {
    const diffFile = vi.fn().mockResolvedValue('--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new');
    const out = await appendAfterEditDiff({
      action: 'write_file',
      observation: 'wrote src/foo.ts',
      files: ['src/foo.ts'],
      diffFile,
    });
    expect(out).toContain('wrote src/foo.ts');
    expect(out).toContain('After-edit diff (src/foo.ts)');
    expect(out).toContain('+new');
  });
});
