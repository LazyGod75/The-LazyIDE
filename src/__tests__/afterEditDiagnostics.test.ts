import { describe, it, expect, vi } from 'vitest';
import { appendAfterEditDiagnostics } from '../lib/agents/afterEditDiagnostics';

describe('appendAfterEditDiagnostics', () => {
  it('leaves non-edit observations unchanged', async () => {
    const diagnose = vi.fn();
    const out = await appendAfterEditDiagnostics({
      action: 'read_file',
      observation: 'ok',
      files: ['a.ts'],
      diagnose,
    });
    expect(out).toBe('ok');
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('does not run diagnostics after a failed edit', async () => {
    const diagnose = vi.fn();
    const out = await appendAfterEditDiagnostics({
      action: 'write_file',
      observation: 'ERROR: disk full',
      files: ['a.ts'],
      diagnose,
    });
    expect(out).toBe('ERROR: disk full');
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('omits empty, clean, and missing-LSP results', async () => {
    const diagnose = vi.fn()
      .mockResolvedValueOnce('No diagnostics')
      .mockResolvedValueOnce('LSP not available: no server');
    const out = await appendAfterEditDiagnostics({
      action: 'edit_file',
      observation: 'edited a.ts',
      files: ['a.ts', 'b.ts'],
      diagnose,
    });
    expect(out).toBe('edited a.ts');
  });

  it('appends real diagnostics for a successful write', async () => {
    const diagnose = vi.fn().mockResolvedValue('error TS2322: Type string is not assignable');
    const out = await appendAfterEditDiagnostics({
      action: 'write_file',
      observation: 'wrote src/foo.ts',
      files: ['src/foo.ts'],
      diagnose,
    });
    expect(out).toContain('wrote src/foo.ts');
    expect(out).toContain('After-edit diagnostics (src/foo.ts)');
    expect(out).toContain('error TS2322');
  });
});
