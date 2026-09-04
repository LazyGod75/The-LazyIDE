import { describe, it, expect } from 'vitest';
import {
  parseSearchReplaceBlocks,
  parseFileContentBlock,
  parseFileToolAction,
  FILE_CONTENT_ACTIONS,
} from '../searchReplaceProtocol';

describe('parseSearchReplaceBlocks', () => {
  it('parses a single SEARCH/REPLACE block', () => {
    const text = [
      'FILE: src/Foo.tsx',
      '<<<<<<< SEARCH',
      'const a = 1;',
      '=======',
      'const a = 2;',
      '>>>>>>> REPLACE',
    ].join('\n');
    const result = parseSearchReplaceBlocks(text);
    expect(result).not.toBeNull();
    expect(result?.path).toBe('src/Foo.tsx');
    expect(result?.edits).toEqual([{ oldString: 'const a = 1;', newString: 'const a = 2;' }]);
  });

  it('parses multiple SEARCH/REPLACE blocks under one FILE: line, in order', () => {
    const text = [
      'FILE: src/Foo.tsx',
      '<<<<<<< SEARCH',
      'a',
      '=======',
      'b',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'c',
      '=======',
      'd',
      '>>>>>>> REPLACE',
    ].join('\n');
    const result = parseSearchReplaceBlocks(text);
    expect(result?.edits).toEqual([
      { oldString: 'a', newString: 'b' },
      { oldString: 'c', newString: 'd' },
    ]);
  });

  it('preserves real multi-line content with braces/JSX verbatim — no escaping involved', () => {
    const text = [
      'FILE: src/Foo.tsx',
      '<<<<<<< SEARCH',
      'function Foo({ bar }: Props) {',
      '  return <div>{bar}</div>;',
      '}',
      '=======',
      'function Foo({ bar, baz }: Props) {',
      '  return <div>{bar}{baz}</div>;',
      '}',
      '>>>>>>> REPLACE',
    ].join('\n');
    const result = parseSearchReplaceBlocks(text);
    expect(result?.edits[0].oldString).toBe('function Foo({ bar }: Props) {\n  return <div>{bar}</div>;\n}');
    expect(result?.edits[0].newString).toBe(
      'function Foo({ bar, baz }: Props) {\n  return <div>{bar}{baz}</div>;\n}',
    );
  });

  it('returns null when there is no FILE: line', () => {
    const text = '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE';
    expect(parseSearchReplaceBlocks(text)).toBeNull();
  });

  it('returns null when FILE: is present but no complete block follows', () => {
    const text = 'FILE: src/Foo.tsx\nsome prose with no markers';
    expect(parseSearchReplaceBlocks(text)).toBeNull();
  });
});

describe('parseFileContentBlock', () => {
  it('parses FILE: + a fenced code block, ignoring the language tag', () => {
    const text = ['FILE: src/New.tsx', '```tsx', 'export function New() {', '  return null;', '}', '```'].join(
      '\n',
    );
    const result = parseFileContentBlock(text);
    expect(result).not.toBeNull();
    expect(result?.path).toBe('src/New.tsx');
    expect(result?.content).toBe('export function New() {\n  return null;\n}');
  });

  it('works with no language tag on the fence', () => {
    const text = ['FILE: notes.md', '```', 'hello world', '```'].join('\n');
    const result = parseFileContentBlock(text);
    expect(result?.content).toBe('hello world');
  });

  it('returns null when there is no fenced block', () => {
    expect(parseFileContentBlock('FILE: src/New.tsx\nno fence here')).toBeNull();
  });
});

describe('parseFileToolAction', () => {
  it('edit_file: returns old_string/new_string compatible with the existing tool contract', () => {
    const text = 'FILE: a.ts\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE';
    const args = parseFileToolAction('edit_file', text);
    expect(args).toEqual({ path: 'a.ts', old_string: 'x', new_string: 'y' });
  });

  it('multi_edit: returns an edits array compatible with the existing tool contract', () => {
    const text = 'FILE: a.ts\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n<<<<<<< SEARCH\np\n=======\nq\n>>>>>>> REPLACE';
    const args = parseFileToolAction('multi_edit', text);
    expect(args).toEqual({
      path: 'a.ts',
      edits: [
        { old_string: 'x', new_string: 'y' },
        { old_string: 'p', new_string: 'q' },
      ],
    });
  });

  it('write_file: returns path/content compatible with the existing tool contract', () => {
    const text = 'FILE: a.ts\n```\nexport const a = 1;\n```';
    const args = parseFileToolAction('write_file', text);
    expect(args).toEqual({ path: 'a.ts', content: 'export const a = 1;' });
  });

  it('returns null for a non-file action', () => {
    expect(parseFileToolAction('run_command', 'FILE: a.ts\n```\nx\n```')).toBeNull();
  });

  it('returns null when the shape is absent (caller falls back to ARGS/JSON)', () => {
    expect(parseFileToolAction('edit_file', 'no markers here at all')).toBeNull();
  });

  it('FILE_CONTENT_ACTIONS lists exactly the three file-content-bearing tools', () => {
    expect([...FILE_CONTENT_ACTIONS].sort()).toEqual(['edit_file', 'multi_edit', 'write_file']);
  });
});
