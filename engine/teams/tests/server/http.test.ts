/**
 * Tests: HTTP router — matching, params, 404, 405, body parsing.
 */

import { describe, expect, it } from 'vitest';
import { Router } from '../../src/server/http.js';

describe('Router.match', () => {
  it('matches a simple GET route', () => {
    const router = new Router();
    router.register('GET', '/healthz', async () => {});
    const result = router.match('GET', '/healthz');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({});
  });

  it('extracts :param values', () => {
    const router = new Router();
    router.register('GET', '/t/:slug', async () => {});
    const result = router.match('GET', '/t/my-team');
    expect(result).not.toBeNull();
    expect(result!.params.slug).toBe('my-team');
  });

  it('extracts multiple :params', () => {
    const router = new Router();
    router.register('GET', '/t/:slug/wiki/note/:noteId', async () => {});
    const result = router.match('GET', '/t/alpha/wiki/note/note-001');
    expect(result).not.toBeNull();
    expect(result!.params.slug).toBe('alpha');
    expect(result!.params.noteId).toBe('note-001');
  });

  it('returns null for unknown path', () => {
    const router = new Router();
    router.register('GET', '/healthz', async () => {});
    expect(router.match('GET', '/unknown')).toBeNull();
  });

  it('returns null for wrong method (405 case)', () => {
    const router = new Router();
    router.register('GET', '/healthz', async () => {});
    expect(router.match('POST', '/healthz')).toBeNull();
    // But pathExists should be true
    expect(router.pathExists('/healthz')).toBe(true);
  });

  it('pathExists returns false for unknown path', () => {
    const router = new Router();
    router.register('GET', '/healthz', async () => {});
    expect(router.pathExists('/nope')).toBe(false);
  });

  it('does not match partial paths', () => {
    const router = new Router();
    router.register('GET', '/a/b/c', async () => {});
    expect(router.match('GET', '/a/b')).toBeNull();
    expect(router.match('GET', '/a/b/c/d')).toBeNull();
  });

  it('decodes URI-encoded params', () => {
    const router = new Router();
    router.register('GET', '/t/:slug', async () => {});
    const result = router.match('GET', '/t/my%20team');
    expect(result!.params.slug).toBe('my team');
  });

  it('matches POST method', () => {
    const router = new Router();
    router.register('POST', '/login', async () => {});
    expect(router.match('POST', '/login')).not.toBeNull();
    expect(router.match('GET', '/login')).toBeNull();
  });

  it('handles method case-insensitively in register', () => {
    const router = new Router();
    router.register('get', '/ping', async () => {});
    expect(router.match('GET', '/ping')).not.toBeNull();
  });
});
