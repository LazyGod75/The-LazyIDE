import { describe, expect, it } from 'vitest';
import { annotateSession } from '../src/annotator/heuristic.js';
import { scrubForPublic } from '../src/schema/scrubber.js';

describe('provenance attributes', () => {
  const input = {
    sessionId: 'vibe-abcd1234',
    text: 'We decided to use parameterized queries for the payments module because of injection risk.',
    timestamp: '2026-06-01T12:00:00Z',
    cwd: 'C:/proj/acme',
    agent: 'vibe' as const,
    sourceKind: 'transcript' as const,
    sessionParent: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    gitCommit: 'deadbeef12345678',
    gitBranch: 'main',
  };

  it('emits agent/source-kind/session-parent/git attributes on the article', () => {
    const { html } = annotateSession(input);
    expect(html).toContain('data-cerveau-agent="vibe"');
    expect(html).toContain('data-cerveau-source-kind="transcript"');
    expect(html).toContain('data-cerveau-session-parent="a1b2c3d4e5f60718293a4b5c6d7e8f90"');
    expect(html).toContain('data-cerveau-git-commit="deadbeef12345678"');
    expect(html).toContain('data-cerveau-git-branch="main"');
  });

  it('omits the attributes when fields are absent (claude path unchanged)', () => {
    const { html } = annotateSession({
      sessionId: 'dream-abcd1234',
      text: 'We decided to use vitest for the suite because jest was flaky.',
    });
    expect(html).not.toContain('data-cerveau-agent');
    expect(html).not.toContain('data-cerveau-source-kind');
    expect(html).not.toContain('data-cerveau-git-commit');
  });

  it('survives the public scrubber', () => {
    const { html } = annotateSession(input);
    const { cleaned } = scrubForPublic(html);
    expect(cleaned).toContain('data-cerveau-agent="vibe"');
    expect(cleaned).toContain('data-cerveau-git-commit="deadbeef12345678"');
  });
});
