import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOOL = join(__dirname, '..', 'plugins', 'lazybrain', 'vibe', 'tools', 'lazybrain_read.py');

describe('lazybrain_read.py invariants', () => {
  const src = readFileSync(TOOL, 'utf8');
  it('subclasses the builtin Read and keeps the registration name', () => {
    expect(src).toContain('from vibe.core.tools.builtins.read import Read as BuiltinRead');
    expect(src).toContain('class Read(BuiltinRead)');
  });
  it('only overrides get_result_extra (run is @final upstream)', () => {
    expect(src).toContain('def get_result_extra');
    expect(src).not.toMatch(/\n\s+def run\(/);
  });
  it('never raises out of the override', () => {
    expect(src).toContain('except Exception');
    expect(src).toContain('return base');
  });
});
