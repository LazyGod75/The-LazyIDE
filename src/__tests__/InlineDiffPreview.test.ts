import { describe, it, expect } from 'vitest';
import { computeDiffLines } from '../components/editor/InlineDiffPreview';

// Regression coverage for the flagship Ctrl+K AI-edit diff path: the old
// implementation aligned lines by raw index, so any insertion or deletion
// shifted every subsequent line into a false remove+add wall. computeDiffLines
// now delegates to the Myers algorithm (src/lib/diff/myersDiff.ts), which
// must keep unrelated lines as 'context' and only flag the lines that
// actually changed.

describe('InlineDiffPreview — computeDiffLines (Myers diff)', () => {
  it('one line inserted at top: existing lines stay context, only the new line is added', () => {
    const original = ['line1', 'line2', 'line3'].join('\n');
    const proposed = ['newline', 'line1', 'line2', 'line3'].join('\n');

    const diff = computeDiffLines(original, proposed);

    expect(diff).toEqual([
      { type: 'add', content: 'newline' },
      { type: 'context', content: 'line1' },
      { type: 'context', content: 'line2' },
      { type: 'context', content: 'line3' },
    ]);
  });

  it('one line deleted in the middle: surrounding lines stay context, only the deleted line is removed', () => {
    const original = ['line1', 'line2', 'line3', 'line4'].join('\n');
    const proposed = ['line1', 'line3', 'line4'].join('\n');

    const diff = computeDiffLines(original, proposed);

    expect(diff).toEqual([
      { type: 'context', content: 'line1' },
      { type: 'remove', content: 'line2' },
      { type: 'context', content: 'line3' },
      { type: 'context', content: 'line4' },
    ]);
  });

  it('replacement block: trailing unrelated lines stay context instead of a false remove+add wall', () => {
    // Replacing 1 line with 2 lines shifts every subsequent line's index —
    // exactly the scenario that broke the old index-aligned algorithm (it
    // would have flagged 'd' and 'e' below as removed+re-added too).
    const original = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const proposed = ['a', 'b', 'X', 'Y', 'd', 'e'].join('\n');

    const diff = computeDiffLines(original, proposed);

    // Minimal edit script: only 'c' is removed and 'X'/'Y' are added.
    // 'd' and 'e' must remain context — a naive rewrite would instead
    // produce 9 entries with 'd' and 'e' each shown as remove+add.
    expect(diff).toHaveLength(7);
    expect(diff.filter((d) => d.type === 'remove')).toEqual([{ type: 'remove', content: 'c' }]);
    expect(diff.filter((d) => d.type === 'add')).toEqual([
      { type: 'add', content: 'X' },
      { type: 'add', content: 'Y' },
    ]);
    expect(diff.filter((d) => d.type === 'context')).toEqual([
      { type: 'context', content: 'a' },
      { type: 'context', content: 'b' },
      { type: 'context', content: 'd' },
      { type: 'context', content: 'e' },
    ]);
  });

  it('identical content produces only context lines (no spurious changes)', () => {
    const content = ['a', 'b', 'c'].join('\n');

    const diff = computeDiffLines(content, content);

    expect(diff.every((d) => d.type === 'context')).toBe(true);
    expect(diff).toHaveLength(3);
  });
});
