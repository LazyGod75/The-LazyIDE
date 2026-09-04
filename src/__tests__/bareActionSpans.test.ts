import { describe, it, expect } from 'vitest';
import {
  closeJsonObject,
  extractBareActionObjectSpans,
  parseTypedJsonObject,
} from '../lib/agents/bareActionSpans';

describe('closeJsonObject', () => {
  it('ignores braces inside strings', () => {
    const raw = '{"type":"x","msg":"a { b } c"}';
    const closed = closeJsonObject(raw, 0);
    expect(closed?.raw).toBe(raw);
  });

  it('returns null when the object is unclosed', () => {
    expect(closeJsonObject('{"type":"x"', 0)).toBeNull();
  });
});

describe('parseTypedJsonObject', () => {
  it('rejects arrays and objects without a string type', () => {
    expect(parseTypedJsonObject('[]')).toBeNull();
    expect(parseTypedJsonObject('{"n":1}')).toBeNull();
    expect(parseTypedJsonObject('not-json')).toBeNull();
  });
});

describe('extractBareActionObjectSpans', () => {
  it('finds a typed object in surrounding prose', () => {
    const spans = extractBareActionObjectSpans('see {"type":"create_draft","title":"a"} later');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.obj.type).toBe('create_draft');
  });

  it('does not invent a span from a brace that is not JSON', () => {
    expect(extractBareActionObjectSpans('style={{ color: 1 }}')).toEqual([]);
  });
});
