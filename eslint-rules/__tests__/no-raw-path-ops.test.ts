/* no-raw-path-ops.test.ts — unit tests for the local ESLint rule that
   guards against the recurring "\\?\ verbatim-prefix" Windows path bug
   class (see ../no-raw-path-ops.js's header and src/lib/paths.ts's header
   for the documented history). Runs the rule directly through ESLint's
   Linter API against small code snippets — no RuleTester dependency, no
   new devDependency (eslint is already installed).

   Split into two groups on purpose: MUST FLAG (the exact shapes that
   caused real recurrences) and MUST NOT FLAG (the false-positive
   boundary) — per this task's requirement that false-positive coverage
   matters as much as true-positive coverage for a rule meant to stay on
   by default.
*/
import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import { noRawPathOps } from '../no-raw-path-ops.js';

const linter = new Linter();

function lint(code: string): string[] {
  const messages = linter.verify(code, {
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { local: { rules: { 'no-raw-path-ops': noRawPathOps } } },
    rules: { 'local/no-raw-path-ops': 'error' },
  });
  return messages.map((m) => m.messageId ?? m.ruleId ?? 'unknown');
}

describe('local/no-raw-path-ops — must flag', () => {
  it('flags .split on a backslash/forward-slash character class ([\\\\/])', () => {
    const out = lint(`function f(filePath) { return filePath.split(/[\\\\/]/); }`);
    expect(out).toEqual(['rawSplitReplace']);
  });

  it('flags .split with the class written the other order ([/\\\\])', () => {
    const out = lint(`function f(path) { return path.split(/[/\\\\]/); }`);
    expect(out).toEqual(['rawSplitReplace']);
  });

  it('flags .replace(/\\\\/g, ...) converting backslashes on a path-like value', () => {
    const out = lint(`function f(projectRoot) { return projectRoot.replace(/\\\\/g, '/'); }`);
    expect(out).toEqual(['rawSplitReplace']);
  });

  it('flags .replace with a literal single-backslash string argument', () => {
    // Using String.raw-equivalent escaping: the source text is `'\\'`.
    const out = lint(`function f(root) { return root.split('\\\\'); }`);
    expect(out).toEqual(['rawSplitReplace']);
  });

  it('flags a member-expression path-like object (graph.projectRoot)', () => {
    const out = lint(`function f(graph) { return graph.projectRoot.split(/[\\\\/]/); }`);
    expect(out).toEqual(['rawSplitReplace']);
  });

  it('flags common path-ish suffixes: repoPath, mergeIntoDir, lazyDir, dirPath, cwd', () => {
    const names = ['repoPath', 'mergeIntoDir', 'lazyDir', 'dirPath', 'cwd', 'targetPath'];
    for (const name of names) {
      const out = lint(`function f(${name}) { return ${name}.split(/[\\\\/]/); }`);
      expect(out, `expected ${name} to be flagged`).toEqual(['rawSplitReplace']);
    }
  });

  it('flags a raw .startsWith() containment check between two path-like values', () => {
    const out = lint(`function f(resolvedPath, rootPath) { return resolvedPath.startsWith(rootPath); }`);
    expect(out).toEqual(['rawStartsWith']);
  });

  it('reproduces the real BreadcrumbBar.tsx bug shape (recurrence #8)', () => {
    // path.split(/[/\\]/) directly on a raw prop, no stripVerbatimPrefix.
    const out = lint(`function f(path) { const pathSegments = path.split(/[/\\\\]/).filter(Boolean); return pathSegments; }`);
    expect(out).toEqual(['rawSplitReplace']);
  });
});

describe('local/no-raw-path-ops — known limitation (no dataflow tracking)', () => {
  it('flags splitting a variable assigned FROM a safe helper call one line above (relPath = relativeToRoot(...)) — this is a real, expected false positive; the rule only recognizes the helper call as the DIRECT split object, since it has no dataflow analysis. Callers document and opt out via path-lint-ignore (see BreadcrumbBar.tsx breadcrumbSegments for the real example this test mirrors).', () => {
    const out = lint(
      `function f(root, path) {
         const relPath = relativeToRoot(root, path);
         return relPath.split(/[\\\\/]+/).filter(Boolean);
       }`,
    );
    expect(out).toEqual(['rawSplitReplace']);
  });
});

describe('local/no-raw-path-ops — must NOT flag (false-positive boundary)', () => {
  it('does not flag a forward-slash-only split (common for URLs / git-style / dotted keys)', () => {
    const out = lint(`function f(topic) { return topic.split('/'); }`);
    expect(out).toEqual([]);
  });

  it('does not flag splitting on "." (extensions, JSONPath-like keys)', () => {
    const out = lint(`function f(filePath) { return filePath.split('.').pop(); }`);
    expect(out).toEqual([]);
  });

  it('does not flag when the object is already the result of a safe helper call', () => {
    const out = lint(
      `function f(root) { return stripVerbatimPrefix(root).replace(/\\\\/g, '/'); }`,
    );
    expect(out).toEqual([]);
  });

  it('does not flag names that are not path-like (id, topic, description)', () => {
    const out = lint(`function f(id) { return id.split(/[\\\\/]/); }`);
    expect(out).toEqual([]);
  });

  it('does not flag .startsWith() against a string literal (not two path-like values)', () => {
    const out = lint(`function f(name) { return name.startsWith('_'); }`);
    expect(out).toEqual([]);
  });

  it('does not flag .startsWith() when only one side looks path-like', () => {
    const out = lint(`function f(rootPath, scheme) { return rootPath.startsWith(scheme); }`);
    expect(out).toEqual([]);
  });

  it('honors a same-line path-lint-ignore opt-out comment', () => {
    const out = lint(
      `function f(mentionedPath) {
         return mentionedPath.split(/[\\\\/]+/); // path-lint-ignore: free text, not a real fs path
       }`,
    );
    expect(out).toEqual([]);
  });

  it('honors a path-lint-ignore comment on the line directly above', () => {
    const out = lint(
      `function f(mentionedPath) {
         // path-lint-ignore: free text, not a real fs path
         return mentionedPath.split(/[\\\\/]+/);
       }`,
    );
    expect(out).toEqual([]);
  });

  it('honors path-lint-ignore anywhere inside a multi-line comment block above the call', () => {
    const out = lint(
      `function f(mentionedPath) {
         // mentionedPath is extracted from free-text task prompts, never a
         // canonicalize() result — segment-count only.
         // path-lint-ignore: not a real fs path
         return mentionedPath.split(/[\\\\/]+/);
       }`,
    );
    expect(out).toEqual([]);
  });

  it('does NOT honor a path-lint-ignore comment separated by a blank line', () => {
    const out = lint(
      `function f(mentionedPath) {
         // path-lint-ignore: not attached, there is a blank line below

         return mentionedPath.split(/[\\\\/]+/);
       }`,
    );
    expect(out).toEqual(['rawSplitReplace']);
  });

  it('does not flag unrelated string methods (toLowerCase, trim, includes)', () => {
    const out = lint(
      `function f(filePath) { return filePath.toLowerCase().trim().includes('src'); }`,
    );
    expect(out).toEqual([]);
  });
});
