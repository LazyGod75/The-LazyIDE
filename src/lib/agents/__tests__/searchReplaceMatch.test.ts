import { describe, it, expect } from 'vitest';
import { findSearchMatch, applySearchReplace } from '../searchReplaceMatch';

describe('findSearchMatch — exact tier', () => {
  it('finds an exact substring match', () => {
    const content = 'line 1\nline 2\nline 3\n';
    const match = findSearchMatch(content, 'line 2');
    expect(match).not.toBeNull();
    expect(match?.strategy).toBe('exact');
    expect(content.slice(match!.index, match!.index + match!.length)).toBe('line 2');
  });

  it('returns null for an empty search string', () => {
    expect(findSearchMatch('abc', '')).toBeNull();
  });

  it('returns null when nothing matches at any tier', () => {
    expect(findSearchMatch('const a = 1;', 'totally different content')).toBeNull();
  });
});

describe('findSearchMatch — indent-normalized tier', () => {
  it('matches a block whose indentation differs (spaces vs the real file\'s tabs)', () => {
    const content = 'function foo() {\n\tconst a = 1;\n\treturn a;\n}\n';
    const search = 'function foo() {\n  const a = 1;\n  return a;\n}';
    const match = findSearchMatch(content, search);
    expect(match).not.toBeNull();
    expect(match?.strategy).toBe('indent-normalized');
  });

  it('does not fall back to indent-normalized when an exact match already exists', () => {
    const content = '  const a = 1;\n';
    const match = findSearchMatch(content, '  const a = 1;');
    expect(match?.strategy).toBe('exact');
  });
});

describe('findSearchMatch — blank-stripped tier', () => {
  it('matches when the model omitted a blank line the file actually has', () => {
    const content = 'const a = 1;\n\nconst b = 2;\n';
    const search = 'const a = 1;\nconst b = 2;';
    const match = findSearchMatch(content, search);
    expect(match).not.toBeNull();
    expect(match?.strategy).toBe('blank-stripped');
  });

  it('matches when the model added an extra blank line the file does not have', () => {
    const content = 'const a = 1;\nconst b = 2;\n';
    const search = 'const a = 1;\n\nconst b = 2;';
    const match = findSearchMatch(content, search);
    expect(match).not.toBeNull();
    expect(match?.strategy).toBe('blank-stripped');
  });
});

describe('applySearchReplace', () => {
  it('splices the replacement in at the matched span (exact tier)', () => {
    const result = applySearchReplace('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 99;');
    expect(result).not.toBeNull();
    expect(result?.content).toBe('const a = 99;\nconst b = 2;\n');
    expect(result?.strategy).toBe('exact');
  });

  it('splices correctly via the indent-normalized tier', () => {
    const content = 'function foo() {\n\tconst a = 1;\n}\n';
    const result = applySearchReplace(content, 'function foo() {\n  const a = 1;\n}', 'function foo() {\n  const a = 2;\n}');
    expect(result).not.toBeNull();
    expect(result?.content).toBe('function foo() {\n  const a = 2;\n}\n');
  });

  it('returns null when no tier matches — caller builds a rich error instead', () => {
    const result = applySearchReplace('const a = 1;\n', 'const zzz = 999;', 'const zzz = 1000;');
    expect(result).toBeNull();
  });
});
