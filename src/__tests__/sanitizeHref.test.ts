import { describe, it, expect } from 'vitest';
import { sanitizeHref } from '../lib/markdown/sanitizeHref';

// Link-sanitization contract for rendered markdown (DEFECT 1 — assistant
// answers are semi-trusted and may carry prompt-injected content from
// files/brain notes). Allowlist, not blocklist: http(s) and scheme-less
// (relative/anchor) targets pass through; everything else is rejected.

describe('sanitizeHref', () => {
  it('allows a plain https URL', () => {
    expect(sanitizeHref('https://example.com/docs')).toBe('https://example.com/docs');
  });

  it('allows a plain http URL', () => {
    expect(sanitizeHref('http://example.com')).toBe('http://example.com');
  });

  it('allows a relative path', () => {
    expect(sanitizeHref('./notes/foo.md')).toBe('./notes/foo.md');
  });

  it('allows a root-relative path', () => {
    expect(sanitizeHref('/settings')).toBe('/settings');
  });

  it('allows a bare anchor', () => {
    expect(sanitizeHref('#section-2')).toBe('#section-2');
  });

  it('rejects javascript: URIs', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBeNull();
  });

  it('rejects javascript: URIs regardless of case', () => {
    expect(sanitizeHref('JavaScript:alert(1)')).toBeNull();
    expect(sanitizeHref('JAVASCRIPT:alert(1)')).toBeNull();
  });

  it('rejects data: URIs', () => {
    expect(sanitizeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects vbscript: URIs', () => {
    expect(sanitizeHref('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects file: URIs', () => {
    expect(sanitizeHref('file:///etc/passwd')).toBeNull();
  });

  it('rejects an unknown custom scheme', () => {
    expect(sanitizeHref('app-secret://exfiltrate')).toBeNull();
  });

  it('rejects a scheme hidden behind a leading control character (tab bypass)', () => {
    expect(sanitizeHref('java\tscript:alert(1)')).toBeNull();
  });

  it('rejects a scheme hidden behind an embedded newline', () => {
    expect(sanitizeHref('java\nscript:alert(1)')).toBeNull();
  });

  it('rejects a scheme preceded by leading whitespace', () => {
    expect(sanitizeHref('   javascript:alert(1)')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(sanitizeHref('')).toBeNull();
  });

  it('preserves query strings and fragments on an allowed URL', () => {
    expect(sanitizeHref('https://example.com/x?y=1#z')).toBe('https://example.com/x?y=1#z');
  });
});
