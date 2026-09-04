/* managedToolPermissions.test.ts — safe test-command auto-allow (F5 fix). */
import { describe, it, expect } from 'vitest';
import { isSafeTestCommand } from '../managedToolPermissions';
import { classifySensitiveCommand } from '../sensitiveCommands';

describe('isSafeTestCommand', () => {
  it('allows direct node --test invocations', () => {
    expect(isSafeTestCommand('node --test debounce.test.mjs')).toBe(true);
    expect(isSafeTestCommand('node --test')).toBe(true);
    expect(isSafeTestCommand('node --test test/')).toBe(true);
  });

  it('allows pytest and vitest runners', () => {
    expect(isSafeTestCommand('pytest')).toBe(true);
    expect(isSafeTestCommand('pytest tests/')).toBe(true);
    expect(isSafeTestCommand('vitest run')).toBe(true);
    expect(isSafeTestCommand('npx vitest run')).toBe(true);
  });

  it('rejects dangerous node flags', () => {
    expect(isSafeTestCommand('node -e "process.exit()"')).toBe(false);
    expect(isSafeTestCommand('node --eval "rmSync()"')).toBe(false);
    expect(isSafeTestCommand('node --check evil.js')).toBe(false);
  });

  it('rejects chained/piped commands', () => {
    expect(isSafeTestCommand('node --test && rm -rf /')).toBe(false);
    expect(isSafeTestCommand('node --test | tee out')).toBe(false);
  });

  it('rejects non-test commands', () => {
    expect(isSafeTestCommand('node server.js')).toBe(false);
    expect(isSafeTestCommand('git push --force')).toBe(false);
    expect(isSafeTestCommand('')).toBe(false);
  });
});

describe('classifySensitiveCommand (node --test is not sensitive)', () => {
  it('never flags ordinary test runner commands', () => {
    expect(classifySensitiveCommand('node --test debounce.test.mjs').sensitive).toBe(false);
    expect(classifySensitiveCommand('npm run test').sensitive).toBe(false);
    expect(classifySensitiveCommand('pytest tests/').sensitive).toBe(false);
  });

  it('still flags genuinely dangerous commands', () => {
    expect(classifySensitiveCommand('git push --force origin main').sensitive).toBe(true);
    expect(classifySensitiveCommand('npm publish').sensitive).toBe(true);
  });
});
