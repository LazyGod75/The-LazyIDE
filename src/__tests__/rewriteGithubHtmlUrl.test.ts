import { describe, it, expect } from 'vitest';
import { rewriteGithubHtmlUrl } from '../lib/tools/handlers/network';

describe('rewriteGithubHtmlUrl', () => {
  it('rewrites a repo root to README on HEAD', () => {
    expect(rewriteGithubHtmlUrl('https://github.com/openclaw/openclaw')).toBe(
      'https://raw.githubusercontent.com/openclaw/openclaw/HEAD/README.md',
    );
  });

  it('rewrites a blob URL to raw.githubusercontent.com', () => {
    expect(
      rewriteGithubHtmlUrl('https://github.com/openclaw/openclaw/blob/main/src/session.ts'),
    ).toBe('https://raw.githubusercontent.com/openclaw/openclaw/main/src/session.ts');
  });

  it('leaves non-GitHub URLs untouched', () => {
    expect(rewriteGithubHtmlUrl('https://example.com/x')).toBe('https://example.com/x');
  });
});
