import { describe, expect, it } from 'vitest';
import { extractRelations } from '../src/annotator/relations';

describe('extractRelations - comprehensive pattern testing', () => {
  describe('causal relations', () => {
    it('should extract "because" patterns', () => {
      const result = extractRelations('We switched from JWT to OAuth because the audit flagged it');
      expect(result.causes.length).toBeGreaterThan(0);
      expect(result.causes[0]).toContain('audit');
    });

    it('should extract "was caused by" patterns', () => {
      const result = extractRelations(
        'The issue was caused by a race condition in the connection pool',
      );
      expect(result.causes.length).toBeGreaterThan(0);
    });

    it('should extract "the reason was" patterns', () => {
      const result = extractRelations('The reason was a memory leak in the cache layer');
      expect(result.causes.length).toBeGreaterThan(0);
    });

    it('should extract "fixed by" patterns', () => {
      const result = extractRelations('Fixed by updating the connection pool timeout');
      expect(result.causes.length).toBeGreaterThan(0);
    });

    it('should handle French "parce que"', () => {
      const result = extractRelations('parce que nous avions un problème de concurrence');
      expect(result.causes.length).toBeGreaterThan(0);
    });

    it('should handle French "en raison de"', () => {
      const result = extractRelations('en raison de problèmes de synchronisation');
      expect(result.causes.length).toBeGreaterThan(0);
    });
  });

  describe('replaces relations', () => {
    it('should extract "replaced the X with Y"', () => {
      const result = extractRelations('Replaced the old middleware with express-session');
      expect(result.replaces.length).toBeGreaterThan(0);
      expect(result.replaces).toContain('middleware');
    });

    it('should extract "migrated from X to Y"', () => {
      const result = extractRelations('We migrated from SQLite to PostgreSQL for scalability');
      expect(result.replaces.length).toBeGreaterThan(0);
      expect(result.replaces).toContain('sqlite');
    });

    it('should extract "instead of X, now using Y"', () => {
      const result = extractRelations('Instead of Redis, now using in-memory cache');
      expect(result.replaces.length).toBeGreaterThan(0);
      expect(result.replaces).toContain('redis');
    });

    it('should extract "deprecated X in favor of Y"', () => {
      const result = extractRelations('Deprecated the old API in favor of GraphQL');
      expect(result.replaces.length).toBeGreaterThan(0);
      expect(result.replaces).toContain('api');
    });

    it('should extract "switched from X to Y"', () => {
      const result = extractRelations('We switched from JWT to OAuth because the audit flagged it');
      expect(result.replaces.length).toBeGreaterThan(0);
      expect(result.replaces).toContain('jwt');
    });
  });

  describe('triple relations', () => {
    it('should extract "using X for Y"', () => {
      const result = extractRelations('Using PostgreSQL instead of SQLite for production');
      expect(result.triples.length).toBeGreaterThan(0);
      expect(result.triples.some((t) => t.includes('postgresql'))).toBeTruthy();
    });

    it('should extract "X requires Y"', () => {
      const result = extractRelations('Express requires Node.js');
      expect(result.triples.length).toBeGreaterThan(0);
      expect(result.triples.some((t) => t.includes('requires'))).toBeTruthy();
    });

    it('should extract "configured X with Y"', () => {
      const result = extractRelations('Configured the server with TLS certificates');
      expect(result.triples.length).toBeGreaterThan(0);
      expect(result.triples.some((t) => t.includes('configured-with'))).toBeTruthy();
    });

    it('should extract "X replaces Y" from migration patterns', () => {
      const result = extractRelations('We migrated from SQLite to PostgreSQL for scalability');
      expect(result.triples.some((t) => t.includes('replaces'))).toBeTruthy();
    });

    it('should extract "X led to Y"', () => {
      const result = extractRelations(
        'The slow query led to performance degradation in production',
      );
      expect(result.triples.length).toBeGreaterThan(0);
      expect(result.triples.some((t) => t.includes('caused'))).toBeTruthy();
    });
  });

  describe('edge cases and robustness', () => {
    it('should handle text without relations gracefully', () => {
      const result = extractRelations('The quick brown fox jumps over the lazy dog');
      // Should return empty arrays, not crash
      expect(result.causes).toEqual([]);
      expect(result.replaces).toEqual([]);
    });

    it('should not match stopwords as meaningful entities', () => {
      const result = extractRelations('X uses the and this is bad');
      // Should not create triples with stopwords
      expect(
        result.triples.every((t) => !t.includes('|the|') && !t.includes('|bad|')),
      ).toBeTruthy();
    });

    it('should limit output arrays to max sizes', () => {
      const text = 'because A and because B and because C and because D';
      const result = extractRelations(text);
      expect(result.causes.length).toBeLessThanOrEqual(3);
    });

    it('should deduplicate relations', () => {
      const text = 'We migrated from JWT to OAuth. We switched from JWT to OAuth.';
      const result = extractRelations(text);
      // Should only have one JWT in replaces
      const jwtCount = result.replaces.filter((r) => r === 'jwt').length;
      expect(jwtCount).toBeLessThanOrEqual(1);
    });
  });
});
