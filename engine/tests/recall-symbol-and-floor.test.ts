import { describe, expect, it } from 'vitest';
import {
  hitsPassingMinScore,
  isTrivialPrompt,
  queryLooksLikeCodeSymbol,
} from '../src/commands/inject-context/scoring.js';

describe('queryLooksLikeCodeSymbol', () => {
  it('accepts camelCase exports and file paths', () => {
    expect(queryLooksLikeCodeSymbol('rotateRefreshToken')).toBe(true);
    expect(queryLooksLikeCodeSymbol('src/auth.ts')).toBe(true);
    expect(queryLooksLikeCodeSymbol('sign_access_token')).toBe(true);
  });

  it('rejects acknowledgements', () => {
    expect(queryLooksLikeCodeSymbol('ok')).toBe(false);
    expect(queryLooksLikeCodeSymbol('merci')).toBe(false);
    expect(queryLooksLikeCodeSymbol('continue')).toBe(false);
  });
});

describe('isTrivialPrompt — symbol lookup', () => {
  it('does not treat a camelCase identifier as an ack', () => {
    expect(isTrivialPrompt('rotateRefreshToken')).toBe(false);
    expect(isTrivialPrompt('what about rotateRefreshToken')).toBe(false);
  });

  it('still skips real acks and JSON dumps', () => {
    expect(isTrivialPrompt('ok')).toBe(true);
    expect(isTrivialPrompt('continue')).toBe(true);
    expect(isTrivialPrompt('{ "key": "value" }')).toBe(true);
    expect(isTrivialPrompt('short')).toBe(true);
  });
});

describe('hitsPassingMinScore', () => {
  it('keeps BM25 micro-scores when the absolute floor would wipe the set', () => {
    const hits = [
      { id: 'a', score: 0.0000012 },
      { id: 'b', score: 0.0000011 },
      { id: 'c', score: 0.0000002 },
    ];
    const kept = hitsPassingMinScore(hits, 0.01, new Set());
    expect(kept.map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('keeps the absolute floor for ordinary below-threshold BM25 (L1 0.3 vs 0.5)', () => {
    const hits = [{ id: 'weak', score: 0.3 }];
    expect(hitsPassingMinScore(hits, 0.5, new Set())).toEqual([]);
  });

  it('keeps the absolute floor when at least one hit clears it', () => {
    const hits = [
      { id: 'strong', score: 0.5 },
      { id: 'weak', score: 0.02 },
    ];
    expect(hitsPassingMinScore(hits, 0.45, new Set()).map((h) => h.id)).toEqual(['strong']);
  });

  it('drops already-injected ids', () => {
    const hits = [{ id: 'a', score: 0.5 }];
    expect(hitsPassingMinScore(hits, 0.01, new Set(['a']))).toEqual([]);
  });
});
