import { describe, expect, it } from 'vitest';
import { parseJsonArrayLoose } from '../src/util/json-loose.js';

describe('parseJsonArrayLoose', () => {
  it('parses a clean array', () => {
    expect(parseJsonArrayLoose('[1,2]')).toEqual([1, 2]);
  });
  it('strips code fences and stray prose', () => {
    expect(parseJsonArrayLoose('Sure!\n```json\n[{"a":1}]\n```\nDone.')).toEqual([{ a: 1 }]);
  });
  it('returns null when no array exists', () => {
    expect(parseJsonArrayLoose('no array here')).toBeNull();
  });
});
