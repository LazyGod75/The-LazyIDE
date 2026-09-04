/**
 * BreadcrumbBar.test.ts — coverage for breadcrumbSegments, the pure
 * function behind the Code space breadcrumb's crumb list.
 *
 * Defect fixed here (observed live, 2026-08-15, file `app.js` under the
 * `uc-smoke-b` project):
 *   1. The breadcrumb rendered a literal "?" as its first crumb — the
 *      Windows extended-length ("verbatim") `\\?\` path prefix being split
 *      on the path separator like any other segment, because the old
 *      implementation ran `path.split(/[/\\]/)` on the raw, unstripped
 *      path straight from the editor tab (itself typically Rust
 *      canonicalize() output, always \\?\-prefixed on Windows — see
 *      paths.ts's header comment for this bug class's history).
 *   2. The breadcrumb showed the FULL absolute path from the drive root
 *      (8 segments) instead of being relative to the file's owning
 *      project, unlike VS Code's workspace-relative convention.
 *
 * breadcrumbSegments fixes both by reusing paths.ts's stripVerbatimPrefix
 * (via fileTree.ts's relativeToRoot) rather than re-deriving \\?\ handling
 * here, and by rendering relative to the owning project's root (with the
 * project name as the first crumb) when that root is known.
 */

import { describe, it, expect } from 'vitest';
import { breadcrumbSegments } from '../components/editor/BreadcrumbBar';

describe('breadcrumbSegments', () => {
  it('renders project-relative segments (project name first) for a verbatim-prefixed (\\\\?\\) path — the live repro', () => {
    const path = String.raw`\\?\C:\Users\dev\Documents\cerveau\scratchpad\uc-smoke-b\app.js`;
    const projectRoot = String.raw`C:\Users\dev\Documents\cerveau\scratchpad\uc-smoke-b`;
    expect(breadcrumbSegments(path, projectRoot)).toEqual(['uc-smoke-b', 'app.js']);
  });

  it('renders project-relative segments for a plain "C:\\..." path with nested directories', () => {
    const path = String.raw`C:\Users\dev\Documents\cerveau\Lazy\src\components\editor\BreadcrumbBar.tsx`;
    const projectRoot = String.raw`C:\Users\dev\Documents\cerveau\Lazy`;
    expect(breadcrumbSegments(path, projectRoot)).toEqual(['Lazy', 'src', 'components', 'editor', 'BreadcrumbBar.tsx']);
  });

  it('renders project-relative segments for a UNC ("\\\\server\\share\\...") path', () => {
    const path = String.raw`\\server\share\repo\src\app.js`;
    const projectRoot = String.raw`\\server\share\repo`;
    expect(breadcrumbSegments(path, projectRoot)).toEqual(['repo', 'src', 'app.js']);
  });

  it('degrades gracefully (no crash) to the stripped absolute path when the file is outside any known project root', () => {
    const path = String.raw`\\?\C:\Users\dev\Downloads\scratch.js`;
    expect(() => breadcrumbSegments(path, null)).not.toThrow();
    expect(breadcrumbSegments(path, null)).toEqual(['C:', 'Users', /'dev'/, 'Downloads', 'scratch.js']);
  });

  it('never leaves a literal "?" segment for a verbatim-prefixed path with no known project root', () => {
    const path = String.raw`\\?\C:\Users\dev\Downloads\scratch.js`;
    expect(breadcrumbSegments(path, null)).not.toContain('?');
  });
});
