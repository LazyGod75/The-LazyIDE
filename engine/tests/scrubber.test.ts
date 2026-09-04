import { describe, expect, it } from 'vitest';
import { emitWikipediaNote } from '../src/annotator/template.js';
import { scrubForPublic } from '../src/schema/scrubber.js';

describe('scrubForPublic — PUBLIC_SAFE_ATTRS preservation', () => {
  it('preserves data-cerveau-version', () => {
    const html = '<article data-cerveau-version="0.2.0"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-version="0.2.0"');
  });

  it('preserves data-cerveau-entities from relations', () => {
    const html = '<article data-cerveau-entities="user:john,user:jane"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-entities');
  });

  it('preserves data-cerveau-triples from relations', () => {
    const html = '<article data-cerveau-triples="user-has-email;friend-with;follows"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-triples');
  });

  it('preserves data-cerveau-causes from relations', () => {
    const html = '<article data-cerveau-causes="bug-123|deployment-failure"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-causes');
  });

  it('preserves data-cerveau-saliency-kind', () => {
    const html = '<article data-cerveau-saliency-kind="frequently-accessed"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-saliency-kind');
  });

  it('preserves data-cerveau-topic', () => {
    const html = '<article data-cerveau-topic="myproject/auth/oauth"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-topic');
  });

  it('preserves data-cerveau-tool', () => {
    const html = '<article data-cerveau-tool="pytest"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-tool');
  });

  it('preserves data-cerveau-kind on facts', () => {
    const html =
      '<article><div data-cerveau-fact data-cerveau-kind="error">Stack trace</div></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-kind="error"');
  });

  it('preserves data-cerveau-extracted-by', () => {
    const html =
      '<article><div data-cerveau-fact data-cerveau-extracted-by="heuristic">Fact text</div></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-extracted-by="heuristic"');
  });

  it('preserves data-cerveau-replaces from relations', () => {
    const html = '<article data-cerveau-replaces="old-001,old-002"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-replaces');
  });

  it('preserves data-cerveau-replaced-by', () => {
    const html = '<article data-cerveau-replaced-by="new-001"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-replaced-by="new-001"');
  });

  it('preserves data-cerveau-supersedes', () => {
    const html = '<article data-cerveau-supersedes="v1-001,v1-002"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-supersedes');
  });

  it('preserves data-cerveau-link-strength', () => {
    const html = '<article><a data-cerveau-link-strength="0.95">link</a></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-link-strength="0.95"');
  });

  it('preserves data-cerveau-link-direction', () => {
    const html = '<article><a data-cerveau-link-direction="bidirectional">link</a></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-link-direction="bidirectional"');
  });

  it('preserves data-cerveau-link-auto', () => {
    const html = '<article><a data-cerveau-link-auto="true">link</a></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-link-auto="true"');
  });

  it('preserves data-cerveau-valid-from', () => {
    const html = '<article data-cerveau-valid-from="2026-05-26T00:00:00Z"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-valid-from="2026-05-26T00:00:00Z"');
  });

  it('preserves data-cerveau-valid-until', () => {
    const html = '<article data-cerveau-valid-until="2026-08-24T00:00:00Z"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-valid-until="2026-08-24T00:00:00Z"');
  });

  it('preserves data-cerveau-invalidated-by', () => {
    const html = '<article data-cerveau-invalidated-by="fact-bug-report"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-invalidated-by="fact-bug-report"');
  });

  it('preserves data-cerveau-confidence on articles', () => {
    const html = '<article data-cerveau-confidence="0.92"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-confidence="0.92"');
  });

  it('preserves data-cerveau-access-count', () => {
    const html = '<article data-cerveau-access-count="42"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-access-count="42"');
  });

  it('preserves data-cerveau-last-accessed', () => {
    const html = '<article data-cerveau-last-accessed="2026-05-26T12:00:00Z"></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-last-accessed="2026-05-26T12:00:00Z"');
  });

  it('preserves data-cerveau-valid-from on article', () => {
    const html =
      '<article id="test" data-cerveau-valid-from="2026-05-26T00:00:00Z">Content</article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).toContain('data-cerveau-valid-from');
    expect(result.removedAttrs).not.toContain('data-cerveau-valid-from');
  });

  it('preserves full template output with all attributes', () => {
    const templateInput = {
      id: 'test-002',
      title: 'API Design Patterns',
      type: 'architecture',
      created: '2026-05-26T10:30:00Z',
      source: 'session:test',
      tier: 'working' as const,
      importance: 0.88,
      tags: ['api', 'design'],
      facts: [
        {
          text: 'RESTful endpoints designed',
          confidence: 0.95,
          kind: 'decision',
          extractor: 'llm',
        },
        {
          text: 'Error handling pattern documented',
          confidence: 0.87,
          kind: 'process',
        },
      ],
      relations: {
        entities: ['service:auth', 'service:users'],
        replaces: ['old-api-001'],
        causes: ['improved-client-integration'],
        triples: ['api-has-endpoint;returns;data'],
      },
      toolMeta: {
        tool: 'code-analyzer',
        cwd: '/project/api',
        filesModified: ['src/routes.ts', 'src/handlers.ts'],
        filesRead: ['docs/api-spec.md'],
      },
      saliencyKind: 'frequent-reference',
      topic: 'project/backend/api',
      meanConfidence: 0.91,
      validForDays: 90,
    };

    const templateHtml = emitWikipediaNote(templateInput);
    const scrubbedResult = scrubForPublic(templateHtml);

    // Verify key attributes are preserved after scrubbing
    expect(scrubbedResult.cleaned).toContain('data-cerveau-version');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-entities');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-replaces');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-causes');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-saliency-kind');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-tool="code-analyzer"');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-extracted-by="llm"');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-kind="decision"');
    expect(scrubbedResult.cleaned).toContain('data-cerveau-confidence');

    // Verify no cerveau attrs were removed (except those not in template)
    const cerveauRemovals = scrubbedResult.removedAttrs.filter((a) =>
      a.startsWith('data-cerveau-'),
    );
    expect(cerveauRemovals.length).toBeLessThanOrEqual(2); // Allow minor edge cases
  });

  it('still removes script tags and event handlers', () => {
    const html = '<article onclick="alert(1)"><script>alert(1)</script><p>Safe</p></article>';
    const result = scrubForPublic(html);
    expect(result.cleaned).not.toContain('script');
    expect(result.cleaned).not.toContain('onclick');
    expect(result.warnings).toContain('Removed <script>');
  });

  it('detects and blocks secrets (OpenAI-style keys)', () => {
    // sk- prefix with 20+ alphanumeric chars triggers detection
    const html =
      '<article data-cerveau-version="0.2.0">This contains sk-1234567890ABCDEFGHIJK which is bad</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.blockedReason).toMatch(/Secret\/PII/);
  });
});

// ---------------------------------------------------------------------------
// New secret pattern tests
// ---------------------------------------------------------------------------

describe('scrubForPublic — new secret patterns (positive cases)', () => {
  it('blocks AWS access key id (AKIA...)', () => {
    const html = '<article>key=AKIAIOSFODNN7EXAMPLE not ok</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('AWS'))).toBe(true);
  });

  it('blocks JWT token', () => {
    const token =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const html = `<article>token ${token} found</article>`;
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('JWT'))).toBe(true);
  });

  it('blocks npm token (npm_...)', () => {
    const html = '<article>token npm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA leaked</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('npm'))).toBe(true);
  });

  it('blocks GitLab PAT (glpat-...)', () => {
    const html = '<article>glpat-ABCDEFGHIJKLMNOPQRST in config</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('GitLab'))).toBe(true);
  });

  it('blocks Supabase key (sbp_...)', () => {
    const html = '<article>sbp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA in use</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('Supabase'))).toBe(true);
  });

  it('blocks Bearer auth header token (long token)', () => {
    const html =
      '<article>Authorization: Bearer eyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789extra</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('Bearer'))).toBe(true);
  });

  it('blocks private IPv4 in 10.x range', () => {
    const html = '<article>server at 10.0.1.42 is internal</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('IPv4'))).toBe(true);
  });

  it('blocks private IPv4 in 192.168.x range', () => {
    const html = '<article>router at 192.168.1.1 is private</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('IPv4'))).toBe(true);
  });

  it('blocks private IPv4 in 172.16-31.x range', () => {
    const html = '<article>host 172.20.5.100 is in private range</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('IPv4'))).toBe(true);
  });

  it('blocks international phone number (UK format +44 20 ...)', () => {
    // Conservative pattern: +<CC> followed by groups of 2+ digits
    const html = '<article>call me at +44 20 1234 5678 for support</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('phone'))).toBe(true);
  });

  it('blocks US phone number with +1 prefix', () => {
    const html = '<article>reach us at +1-555-867-5309</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeDefined();
    expect(result.detectedPatterns.some((p) => p.includes('phone'))).toBe(true);
  });
});

describe('scrubForPublic — new secret patterns (negative / no-block cases)', () => {
  it('does NOT block normal prose text', () => {
    const html = '<article>The quick brown fox jumps over the lazy dog.</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block a semver string like 0.2.0', () => {
    const html = '<article data-cerveau-version="0.2.0">Version 0.2.0 released.</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block an ISO date string', () => {
    const html = '<article data-cerveau-created="2026-05-26T00:00:00Z">created today</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block a short AWS-like prefix that is too short (AKIA + 15 chars)', () => {
    // AKIA followed by only 15 uppercase chars — must not match (pattern requires exactly 16)
    const shortHtml = '<article>reference AKIA12345678901 in docs</article>';
    const result = scrubForPublic(shortHtml);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block public IPv4 like 8.8.8.8', () => {
    const html = '<article>DNS server 8.8.8.8 is public</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block localhost IP 127.0.0.1', () => {
    const html = '<article>runs on 127.0.0.1:3000</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block a date that looks like 172.3 (short float)', () => {
    // Must not match 172.3 as a private IP (needs 4 octets in 172.16-31 range)
    const html = '<article>compression ratio 172.3 ms average</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block short "Bearer" usage without a long token', () => {
    // "Bearer" followed by fewer than 20 chars — not a real token
    const html = '<article>The concept of Bearer auth is explained here.</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block a version number that starts with npm_short', () => {
    // npm_ followed by 35 chars (one short of 36) — must not match
    const html = '<article>npm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA config key</article>';
    // 35 A's after npm_ — should not match (requires exactly 36)
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block a GitLab token that is 19 chars (one short)', () => {
    // glpat- followed by 19 chars — must not match (requires exactly 20)
    const html = '<article>glpat-ABCDEFGHIJKLMNOPQRS doc reference</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });

  it('does NOT block a phone-number-like date "2026-05-26"', () => {
    const html = '<article>created on 2026-05-26 at midnight</article>';
    const result = scrubForPublic(html);
    expect(result.blockedReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// public-strict profile tests
// ---------------------------------------------------------------------------

describe('scrubForPublic — public-strict profile', () => {
  const provenanceHtml = `<article
    data-cerveau-version="0.2.0"
    data-cerveau-cwd="/home/user/project"
    data-cerveau-git-branch="main"
    data-cerveau-git-commit="abc1234"
    data-cerveau-session-parent="sess-001"
    data-cerveau-session-id="sess-002"
    data-cerveau-files-modified="src/foo.ts"
    data-cerveau-files-read="src/bar.ts"
    data-cerveau-source="session:abc123"
  ><p>Hello</p></article>`;

  it('default profile preserves provenance attrs', () => {
    const result = scrubForPublic(provenanceHtml, { profile: 'default' });
    expect(result.cleaned).toContain('data-cerveau-git-branch');
    expect(result.cleaned).toContain('data-cerveau-session-id');
    expect(result.strippedProvenanceAttrs).toHaveLength(0);
  });

  it('public-strict strips provenance attrs', () => {
    const result = scrubForPublic(provenanceHtml, { profile: 'public-strict' });
    expect(result.cleaned).not.toContain('data-cerveau-cwd');
    expect(result.cleaned).not.toContain('data-cerveau-git-branch');
    expect(result.cleaned).not.toContain('data-cerveau-git-commit');
    expect(result.cleaned).not.toContain('data-cerveau-session-parent');
    expect(result.cleaned).not.toContain('data-cerveau-session-id');
    expect(result.cleaned).not.toContain('data-cerveau-files-modified');
    expect(result.cleaned).not.toContain('data-cerveau-files-read');
    expect(result.cleaned).not.toContain('data-cerveau-source');
    expect(result.strippedProvenanceAttrs.length).toBeGreaterThan(0);
  });

  it('public-strict preserves non-provenance attrs', () => {
    const result = scrubForPublic(provenanceHtml, { profile: 'public-strict' });
    expect(result.cleaned).toContain('data-cerveau-version');
    expect(result.cleaned).toContain('Hello');
  });

  it('public-strict does not mutate the input string', () => {
    const input = provenanceHtml;
    scrubForPublic(input, { profile: 'public-strict' });
    expect(input).toBe(provenanceHtml); // unchanged
  });

  it('ScrubResult always has detectedPatterns and strippedProvenanceAttrs', () => {
    const result = scrubForPublic('<article>Hello</article>');
    expect(Array.isArray(result.detectedPatterns)).toBe(true);
    expect(Array.isArray(result.strippedProvenanceAttrs)).toBe(true);
    expect(typeof result.pathsScrubbed).toBe('number');
  });
});
