import { describe, expect, it } from 'vitest';
import { extractRelations } from '../src/annotator/relations';

describe('extractRelations', () => {
  it('should extract causal relations from "because"', () => {
    const result = extractRelations('We switched from JWT to OAuth because the audit flagged it');
    expect(result.causes.length).toBeGreaterThan(0);
  });

  it('should extract causal relations from "was caused by"', () => {
    const result = extractRelations(
      'The issue was caused by a race condition in the connection pool',
    );
    expect(result.causes.length).toBeGreaterThan(0);
  });

  it('should extract replaces relations', () => {
    const result = extractRelations('Replaced the old middleware with express-session');
    expect(result.replaces.length).toBeGreaterThan(0);
  });

  it('should extract uses relations from "using"', () => {
    const result = extractRelations('Using PostgreSQL instead of SQLite for production');
    expect(result.triples.length).toBeGreaterThan(0);
  });

  it('should handle French "parce que"', () => {
    const result = extractRelations('parce que nous avions un problème de concurrence');
    expect(result.causes.length).toBeGreaterThan(0);
  });

  it('should extract from migrated pattern', () => {
    const result = extractRelations('We migrated from SQLite to PostgreSQL for scalability');
    expect(result.replaces.length).toBeGreaterThan(0);
  });

  it('should extract from "instead of" pattern', () => {
    const result = extractRelations('Instead of Redis, now using in-memory cache');
    expect(result.replaces.length).toBeGreaterThan(0);
  });

  it('should extract from deprecated pattern', () => {
    const result = extractRelations('Deprecated the old API in favor of GraphQL');
    expect(result.replaces.length).toBeGreaterThan(0);
  });

  it('should extract configured relations', () => {
    const result = extractRelations('Configured the server with TLS certificates');
    expect(result.triples.some((t) => t.includes('configured-with'))).toBeTruthy();
  });

  it('should extract requires relations', () => {
    const result = extractRelations('Express requires Node.js');
    expect(result.triples.some((t) => t.includes('requires'))).toBeTruthy();
  });
});
