import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Wiring smoke test: the daemon source must route /capture-vibe to runCaptureVibe.
// Behavior is covered by tests/capture-vibe.test.ts; the full HTTP round-trip is
// covered by the P2 manual demo (hook -> daemon -> note).
describe('daemon /capture-vibe wiring', () => {
  it('routes the endpoint', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'daemon.ts'), 'utf8');
    expect(src).toContain("case '/capture-vibe'");
    expect(src).toContain('runCaptureVibe');
  });
});
