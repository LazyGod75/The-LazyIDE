/* eslint-rules/no-raw-path-ops.js — local ESLint rule guarding against the
   recurring "\\?\ verbatim-prefix" Windows path bug class documented in
   src/lib/paths.ts's header comment. That header lists eight-plus prior
   fixes, every one the same shape: code splits/replaces a raw path string
   directly (`.split(/[\\/]/)`, `.replace(/\\/g, '/')`) instead of going
   through the shared helpers in paths.ts, and a Windows extended-length
   prefix (`\\?\`, produced by Rust's `canonicalize()`) leaks into the UI
   as a stray "?" segment or silently breaks a same-directory comparison
   downstream.

   This rule does NOT try to solve the bug generally (that requires runtime
   knowledge of where a string actually came from) — it flags the specific
   *syntactic* patterns that have caused every documented recurrence so
   far: manual backslash-separator splitting/replacing, and raw
   `.startsWith()` containment checks, on a variable whose name looks
   path-derived. It is deliberately narrow (backslash-aware patterns only,
   name-heuristic gated) to keep false positives low.

   NOT included: a bare `a.path === b.path` equality check. An earlier
   version of this rule flagged that pattern too, but running it against
   this codebase (2026-08) surfaced ~54 hits, and manual review found the
   large majority compared two values from the SAME in-memory source (e.g.
   `tab.path === activeTabPath`, both sourced from the same editor-tab
   state) rather than two paths from different origins disagreeing on a
   verbatim prefix — the actual documented failure mode. That check was
   dropped rather than shipped noisy; see this file's test suite
   (eslint-rules/__tests__/no-raw-path-ops.test.ts) for the exact boundary
   that IS enforced, including cases it must NOT flag.

   Escape hatch: `// path-lint-ignore: <reason>` on the previous line (or
   same line) opts a single site out — use it for genuine non-path values
   that merely have a path-ish name, or for code that is itself part of
   the normalization helpers. Prefer fixing the call site over reaching
   for this comment.
*/

// Names that look like they hold a filesystem path. Matches whole
// identifiers (`path`, `root`, `dir`, `cwd`) and camelCase-suffixed forms
// (`filePath`, `projectRoot`, `mergeIntoDir`, `repoPath`, `lazyDir`,
// `dirPath`, `targetPath`). Deliberately excludes generic short names and
// unrelated words that happen to contain the substring (e.g. `directive`,
// `rooted`, `cwdEnv` would still match `cwd`, which is acceptable — `cwd`
// alone is not a common non-path identifier in this codebase).
const PATH_NAME_RE = /^(path|dir|root|cwd)$|(^|[a-z0-9])(Path|Dir|Root|Cwd)$/;

// Helper functions from src/lib/paths.ts (and their known re-exports) that
// already normalize a path before further string ops touch it — an object
// expression that is a call to one of these is never itself flagged as
// the "raw" value.
const SAFE_HELPER_NAMES = new Set([
  'stripVerbatimPrefix',
  'normalizeForPathCompare',
  'normalizeRepoPathForGit',
  'joinPath',
  'basename',
  'relativeToRoot',
  'isPathWithinRoot',
  'isAbsolutePathWin',
]);

const SPLIT_REPLACE_METHODS = new Set(['split', 'replace', 'replaceAll']);

const OPT_OUT_RE = /path-lint-ignore/;

/** Best-effort short name for a node used purely for the path-ish name
 *  heuristic — identifiers use their own name, member expressions use the
 *  final (non-computed) property name (e.g. `graph.projectRoot` -> the
 *  `projectRoot` part), everything else (call results, computed access,
 *  literals) is not name-checkable and returns null. */
function pathishName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  return null;
}

function looksPathish(node) {
  const name = pathishName(node);
  return typeof name === 'string' && PATH_NAME_RE.test(name);
}

/** True when `node` is a call to one of the paths.ts safe helpers, so its
 *  *result* is already normalized and should not itself trigger the rule
 *  (e.g. `stripVerbatimPrefix(root).replace(/\\/g, '/')` is the documented
 *  correct pattern, not a violation). */
function isSafeHelperCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  const name = callee.type === 'Identifier' ? callee.name
    : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
      ? callee.property.name
      : null;
  return typeof name === 'string' && SAFE_HELPER_NAMES.has(name);
}

/** True when a regex literal's source would match a Windows backslash
 *  separator (the actually-dangerous case — a verbatim `\\?\` prefix is
 *  all-backslash, so only backslash-aware patterns can produce the "?"
 *  leaking-crumb bug or a mixed-separator join). A forward-slash-only
 *  split (`.split('/')`) is out of scope: it cannot itself misinterpret a
 *  `\\?\` prefix and is extremely common for non-filesystem strings (URLs,
 *  git-style relative paths, dotted keys), which is exactly the kind of
 *  site that would make this rule noisy without adding real signal. */
function regexMatchesBackslash(regexNode) {
  return typeof regexNode.regex?.pattern === 'string' && regexNode.regex.pattern.includes('\\\\');
}

function stringIsBackslash(node) {
  return node.type === 'Literal' && typeof node.value === 'string' && node.value === '\\';
}

function looksLikeSeparatorArg(node) {
  if (!node) return false;
  if (node.type === 'Literal' && node.regex) return regexMatchesBackslash(node);
  if (stringIsBackslash(node)) return true;
  return false;
}

/** Comment-based opt-out: a `path-lint-ignore` marker attached to the
 *  reported node — either a trailing `//` comment on the same line, or
 *  anywhere inside the contiguous block of `//` line-comments sitting
 *  directly above it (so a multi-line explanatory comment only needs the
 *  marker on ONE of its lines, not specifically the last one). Mirrors the
 *  shape of a standard `eslint-disable-next-line` but scoped to this
 *  rule's own vocabulary so it reads as an intentional, documented
 *  decision rather than a blanket lint suppression. */
function hasOptOutComment(context, node) {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  const comments = sourceCode.getAllComments().filter((c) => c.type === 'Line');
  const nodeLine = node.loc.start.line;

  // Trailing comment on the same line as the flagged code.
  if (comments.some((c) => c.loc.start.line === nodeLine && OPT_OUT_RE.test(c.value))) {
    return true;
  }

  // Walk the contiguous run of line-comments immediately above the node
  // (each one line above the next, no gap) and check every line in that
  // block, not just the one touching the code.
  const byLine = new Map(comments.map((c) => [c.loc.end.line, c]));
  let line = nodeLine - 1;
  while (byLine.has(line)) {
    if (OPT_OUT_RE.test(byLine.get(line).value)) return true;
    line -= 1;
  }
  return false;
}

export const noRawPathOps = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow manual Windows path separator splitting/replacing or raw startsWith containment checks on path-like values; use src/lib/paths.ts helpers instead.',
    },
    schema: [],
    messages: {
      rawSplitReplace:
        'Manual "{{method}}" with a backslash-separator pattern on path-like "{{name}}". A raw Windows path can carry a "\\\\?\\" verbatim prefix (Rust canonicalize() output) that this will mis-split/mis-replace — see src/lib/paths.ts (basename, joinPath, relativeToRoot, stripVerbatimPrefix). Opt out with a `// path-lint-ignore: <reason>` comment if this value is genuinely not a raw filesystem path.',
      rawStartsWith:
        'Raw ".startsWith()" containment check between path-like values "{{object}}" and "{{arg}}". Use isPathWithinRoot from src/lib/paths.ts, which normalizes verbatim prefixes and separators on both sides first. Opt out with a `// path-lint-ignore: <reason>` comment if these are not raw filesystem paths.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier') return;
        const method = callee.property.name;

        if (SPLIT_REPLACE_METHODS.has(method)) {
          const object = callee.object;
          if (isSafeHelperCall(object)) return;
          if (!looksPathish(object)) return;
          const arg = node.arguments[0];
          if (!looksLikeSeparatorArg(arg)) return;
          if (hasOptOutComment(context, node)) return;
          context.report({
            node,
            messageId: 'rawSplitReplace',
            data: { method, name: pathishName(object) ?? '?' },
          });
          return;
        }

        if (method === 'startsWith') {
          const object = callee.object;
          const arg = node.arguments[0];
          if (isSafeHelperCall(object) || isSafeHelperCall(arg)) return;
          if (!looksPathish(object) || !looksPathish(arg)) return;
          if (hasOptOutComment(context, node)) return;
          context.report({
            node,
            messageId: 'rawStartsWith',
            data: { object: pathishName(object) ?? '?', arg: pathishName(arg) ?? '?' },
          });
        }
      },
    };
  },
};
