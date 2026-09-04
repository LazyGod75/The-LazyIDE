import { describe, expect, it } from 'vitest';
import {
  EXCERPT_HEAD_LINES,
  EXCERPT_TAIL_LINES,
  attachExcerpt,
  capHeadTail,
  excerptFromSource,
} from '../symbol-excerpt.js';

describe('capHeadTail', () => {
  it('returns the original text when it fits in head+tail', () => {
    const text = 'a\nb\nc';
    expect(capHeadTail(text, 2, 2)).toBe(text);
  });

  it('keeps the first head and last tail lines, with a marker in between', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    const out = capHeadTail(lines.join('\n'), 3, 2);
    expect(out).toBe('L1\nL2\nL3\n// …\nL9\nL10');
  });
});

describe('excerptFromSource', () => {
  it('captures the preceding JSDoc and a short body unchanged', () => {
    const source = [
      '/**',
      ' * Convert a name to lowercase, non-alphanumeric → hyphen.',
      ' */',
      'function toAnchorId(name: string): string {',
      '  return name.toLowerCase();',
      '}',
    ].join('\n');
    const out = excerptFromSource(source, 4, 6);
    expect(out.jsdoc).toContain('lowercase');
    expect(out.jsdoc).toContain('hyphen');
    expect(out.excerpt).toContain('function toAnchorId');
    expect(out.excerpt).toContain('toLowerCase');
  });

  it('uses head+tail so a finally block at the end of a long function is kept', () => {
    const body = [
      'export async function parseFile(path: string) {',
      ...Array.from({ length: 50 }, (_, i) => `  const x${i} = ${i};`),
      '  try {',
      '    return extract(tree);',
      '  } finally {',
      '    if (tree && typeof tree.delete === "function") {',
      '      tree.delete();',
      '    }',
      '  }',
      '}',
    ];
    const source = body.join('\n');
    const out = excerptFromSource(source, 1, body.length);
    const lineCount = out.excerpt.split('\n').length;
    expect(lineCount).toBe(EXCERPT_HEAD_LINES + 1 + EXCERPT_TAIL_LINES);
    expect(out.excerpt).toContain('finally');
    expect(out.excerpt).toContain('tree.delete');
    expect(out.excerpt).toContain('// …');
  });

  it('returns empty excerpts for an inverted line range', () => {
    expect(excerptFromSource('hello', 5, 1)).toEqual({ jsdoc: '', excerpt: '' });
  });
});

describe('attachExcerpt', () => {
  it('is a non-mutating add of jsdoc/excerpt', () => {
    const source = '/** keep me */\nfunction foo() {\n  return 1;\n}\n';
    const input = { name: 'foo', startLine: 2, endLine: 4 };
    const out = attachExcerpt(source, input);
    expect(out.jsdoc).toContain('keep me');
    expect(out.excerpt).toContain('function foo');
    expect(input).not.toHaveProperty('jsdoc');
  });
});
