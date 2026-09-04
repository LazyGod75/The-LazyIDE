/**
 * errorMessage.test.ts — F7 fix (silent-failure audit): errorMessage() was
 * duplicated identically in updateStore.ts and browserRecipe.ts. Extracted
 * to src/lib/errorMessage.ts, pure extraction (no logic change). The case
 * that motivated the original `instanceof Error` shape is a DOMException
 * (e.g. AbortError from an aborted fetch/invoke) — this test constructs a
 * real one to prove the extraction preserves the exact original behavior.
 */

import { describe, it, expect } from 'vitest';
import { errorMessage } from '../lib/errorMessage';

describe('errorMessage', () => {
  it('extracts .message from a real Error', () => {
    expect(errorMessage(new Error('plain failure'))).toBe('plain failure');
  });

  it('handles a constructed DOMException the same way as before extraction (the case that motivated this function)', () => {
    // In this runtime (jsdom), DOMException does NOT extend Error, so
    // `err instanceof Error` is false and errorMessage falls through to
    // String(err) — which for a DOMException yields "name: message", not
    // the bare message. This is the EXACT pre-extraction behavior (both
    // updateStore.ts's and browserRecipe.ts's original local copies had
    // the identical `instanceof Error` check) — this test locks it in so
    // the extraction is provably a no-op on behavior, not a silent fix.
    const domException = new DOMException('The operation was aborted.', 'AbortError');
    expect(domException instanceof Error).toBe(false);
    expect(errorMessage(domException)).toBe(String(domException));
    expect(errorMessage(domException)).toBe('AbortError: The operation was aborted.');
  });

  it('falls back to String() for a non-Error thrown value', () => {
    expect(errorMessage('a raw string throw')).toBe('a raw string throw');
    expect(errorMessage(42)).toBe('42');
  });

  it('falls back to String() for a plain object with no message field', () => {
    expect(errorMessage({ code: 'ECONNRESET' })).toBe('[object Object]');
  });
});
