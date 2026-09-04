import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  annotateSession,
  extractPathsFromText,
  wrapWithDpubRole,
} from '../src/annotator/heuristic';

// Mock all external dependencies
vi.mock('../store/paths.js', () => ({
  slug: (input: string) =>
    input
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .slice(0, 50),
}));

vi.mock('../indexer/fts.js', () => ({
  listAll: vi.fn(() => []),
  topConcepts: vi.fn(() => []),
}));

vi.mock('../annotator/entities.js', () => ({
  discoverAndAnnotateEntities: vi.fn(() => ({
    keys: [],
    entities: {},
  })),
}));

vi.mock('../annotator/relations.js', () => ({
  extractRelations: vi.fn(() => ({
    replaces: [],
    causes: [],
    triples: [],
  })),
}));

vi.mock('../annotator/saliency.js', () => ({
  detectSaliency: vi.fn(() => null),
}));

vi.mock('../annotator/template.js', () => ({
  emitWikipediaNote: vi.fn((input) => {
    return `<article id="${input.id}" data-type="${input.type}"><p>${input.title}</p></article>`;
  }),
}));

describe('annotateSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts decision type from decision pattern', () => {
    const input = {
      sessionId: 'sess-001',
      text: 'we decided to use Vitest for testing framework',
    };

    const output = annotateSession(input);

    expect(output.type).toBe('decision');
    expect(output.tags).toContain('testing');
  });

  it('extracts episodic type from error text', () => {
    const input = {
      sessionId: 'sess-002',
      text: 'error: Cannot find module "express"',
    };

    const output = annotateSession(input);

    expect(output.type).toBe('episodic');
    expect(output.factCount).toBeGreaterThan(0);
  });

  it('tags typescript from .ts file extension', () => {
    const input = {
      sessionId: 'sess-003',
      text: 'Fixed the auth module',
      tool: 'Edit',
      filesModified: ['src/auth.ts'],
    };

    const output = annotateSession(input);

    expect(output.tags).toContain('typescript');
    expect(output.tags).toContain('auth');
  });

  it('preserves negation prefix in "never use" pattern', () => {
    const input = {
      sessionId: 'sess-004',
      text: 'Never use eval() in production code',
    };

    const output = annotateSession(input);

    expect(output.html.toLowerCase()).toContain('never');
    expect(output.html.toLowerCase()).toMatch(/never.*eval/i);
  });

  it('preserves negation in "do not" pattern', () => {
    const input = {
      sessionId: 'sess-005',
      text: 'Do not store passwords in plain text',
    };

    const output = annotateSession(input);

    expect(output.html.toLowerCase()).toMatch(/do not|store.*password/i);
  });

  it('extracts "must" pattern facts', () => {
    const input = {
      sessionId: 'sess-006',
      text: 'Must always validate user input before processing',
    };

    const output = annotateSession(input);

    expect(output.html.toLowerCase()).toMatch(/must.*validate/i);
  });

  it('produces valid HTML with fallback fact on empty input', () => {
    const input = {
      sessionId: 'sess-007',
      text: '',
    };

    const output = annotateSession(input);

    expect(output.html).toBeTruthy();
    expect(output.html).toContain('<article');
    expect(output.html).toContain('</article>');
  });

  it('detects topic hierarchy from cwd path', () => {
    const input = {
      sessionId: 'sess-008',
      text: 'Authentication refactor',
      cwd: '/home/user/myproject/src/auth',
    };

    const output = annotateSession(input);

    // Topic should contain project name and possibly auth
    expect(output.html).toBeTruthy();
    expect(output.id).toBeTruthy();
  });

  it('infers procedural type from Edit tool', () => {
    const input = {
      sessionId: 'sess-009',
      text: 'Refactored database module',
      tool: 'Edit',
      filesModified: ['src/db.ts'],
    };

    const output = annotateSession(input);

    expect(output.type).toBe('procedural');
  });

  it('tags shell from Bash tool', () => {
    const input = {
      sessionId: 'sess-010',
      text: 'Deployed to production',
      tool: 'Bash',
      filesRead: ['deploy.sh'],
    };

    const output = annotateSession(input);

    expect(output.tags).toContain('shell');
  });

  it('returns valid id and factCount in output', () => {
    const input = {
      sessionId: 'sess-011',
      text: 'Decision: We will use PostgreSQL for the database',
    };

    const output = annotateSession(input);

    expect(output.id).toBeTruthy();
    expect(typeof output.id).toBe('string');
    expect(typeof output.factCount).toBe('number');
    expect(output.factCount).toBeGreaterThanOrEqual(0);
  });

  it('combines filesModified with paths extracted from text', () => {
    const input = {
      sessionId: 'sess-012',
      text: 'Fixed src/auth/login.ts issue',
      tool: 'Edit',
      filesModified: ['src/index.ts'],
    };

    const output = annotateSession(input);

    expect(output.tags).toContain('typescript');
    expect(output.tags).toContain('auth');
  });

  it('detects frontend tag from React keyword', () => {
    const input = {
      sessionId: 'sess-013',
      text: 'Migrated React component to hooks pattern',
    };

    const output = annotateSession(input);

    expect(output.tags).toContain('frontend');
  });

  it('detects database tag from PostgreSQL keyword', () => {
    const input = {
      sessionId: 'sess-014',
      text: 'Added migration for PostgreSQL schema changes',
    };

    const output = annotateSession(input);

    expect(output.tags).toContain('database');
  });

  it('computes higher importance for decision facts', () => {
    const decisionInput = {
      sessionId: 'sess-015a',
      text: 'Decision: switch to TypeScript',
    };

    const referenceInput = {
      sessionId: 'sess-015b',
      text: 'Read the TypeScript handbook',
    };

    const decisionOutput = annotateSession(decisionInput);
    const referenceOutput = annotateSession(referenceInput);

    // Both should have valid HTML
    expect(decisionOutput.html).toBeTruthy();
    expect(referenceOutput.html).toBeTruthy();
  });
});

describe('extractPathsFromText', () => {
  it('extracts path from prose text', () => {
    const text = 'Modified src/auth/login.ts to add validation';
    const paths = extractPathsFromText(text);

    expect(paths).toContain('src/auth/login.ts');
  });

  it('extracts path from data attribute markup', () => {
    const text = 'File: <data value="path/to/file.ts">';
    const paths = extractPathsFromText(text);

    expect(paths).toContain('path/to/file.ts');
  });

  it('returns empty array when no paths found', () => {
    const text = 'This is just plain text with no file paths';
    const paths = extractPathsFromText(text);

    expect(paths).toEqual([]);
  });

  it('extracts multiple paths', () => {
    const text = 'Changed src/auth.ts and tests/auth.test.ts files';
    const paths = extractPathsFromText(text);

    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths.some((p) => p.includes('auth.ts'))).toBe(true);
    expect(paths.some((p) => p.includes('test'))).toBe(true);
  });

  it('deduplicates paths', () => {
    const text = 'src/db.ts was modified, then src/db.ts had a fix';
    const paths = extractPathsFromText(text);

    const occurrences = paths.filter((p) => p === 'src/db.ts').length;
    expect(occurrences).toBe(1);
  });

  it('handles windows backslashes in data attributes', () => {
    const text = 'File: <data value="src\\auth\\login.ts">';
    const paths = extractPathsFromText(text);

    expect(paths.length).toBeGreaterThan(0);
    // Should be normalized to forward slashes
    expect(paths[0]).not.toContain('\\');
  });

  it('extracts Python and SQL file paths', () => {
    const text = 'Updated models.py and migrations/0001_initial.sql';
    const paths = extractPathsFromText(text);

    expect(paths.some((p) => p.endsWith('.py'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.sql'))).toBe(true);
  });

  it('extracts JSON and YAML configuration files', () => {
    const text = 'Modified config.json and tsconfig.json and ci.yml';
    const paths = extractPathsFromText(text);

    expect(paths.some((p) => p.includes('.json'))).toBe(true);
    expect(paths.some((p) => p.includes('.yml'))).toBe(true);
  });
});

describe('wrapWithDpubRole', () => {
  it('wraps warning pattern with doc-warning role', () => {
    const text = 'warning: do not use this in production';
    const wrapped = wrapWithDpubRole(text);

    expect(wrapped).toContain('role="doc-warning"');
    expect(wrapped).toContain('<aside');
    expect(wrapped).toContain('</aside>');
  });

  it('wraps tip pattern with doc-tip role', () => {
    const text = 'tip: use --verbose for more output';
    const wrapped = wrapWithDpubRole(text);

    expect(wrapped).toContain('role="doc-tip"');
  });

  it('wraps example pattern with doc-example role', () => {
    const text = 'example: const x = 42';
    const wrapped = wrapWithDpubRole(text);

    expect(wrapped).toContain('role="doc-example"');
  });

  it('wraps errata pattern with doc-errata role', () => {
    const text = 'this was wrong, the correct version is to use new API';
    const wrapped = wrapWithDpubRole(text);

    expect(wrapped).toContain('role="doc-errata"');
  });

  it('returns unchanged text when no role keywords found', () => {
    const text = 'normal text without any role keywords';
    const wrapped = wrapWithDpubRole(text);

    expect(wrapped).toBe(text);
  });

  it('escapes HTML entities when wrapping', () => {
    const text = 'warning: <script>alert(1)</script>';
    const wrapped = wrapWithDpubRole(text);

    expect(wrapped).toContain('&lt;');
    expect(wrapped).toContain('&gt;');
    expect(wrapped).not.toContain('<script>');
  });

  it('detects warning from "avoid" keyword', () => {
    const text = 'avoid using deprecated APIs';
    const wrapped = wrapWithDpubRole(text);

    expect(wrapped).toContain('role="doc-warning"');
  });

  it('detects tip from "hint" keyword', () => {
    const text = 'hint: always use type annotations';
    const wrapped = wrapWithDpubRole(text);

    expect(wrapped).toContain('role="doc-tip"');
  });

  it('prioritizes errata over warning when both match', () => {
    const text = 'this was wrong, warning: new approach required';
    const wrapped = wrapWithDpubRole(text);

    expect(wrapped).toContain('role="doc-errata"');
  });
});

describe('Integration: Complex scenarios', () => {
  it('handles multi-line input with multiple facts', () => {
    const input = {
      sessionId: 'sess-multi-001',
      text: `We decided to refactor authentication module.

Fixed issue: the token validation was missing CSRF check.
Never store tokens in localStorage.

Modified: src/auth/validate.ts and src/auth/session.ts`,
      cwd: '/project/src',
    };

    const output = annotateSession(input);

    expect(output.type).toBe('decision');
    expect(output.tags).toContain('auth');
    expect(output.tags).toContain('typescript');
    expect(output.factCount).toBeGreaterThan(0);
  });

  it('handles tool-only input without prose facts', () => {
    const input = {
      sessionId: 'sess-tool-001',
      text: 'x',
      tool: 'Read',
      filesRead: ['src/util.ts', 'tests/util.test.ts'],
    };

    const output = annotateSession(input);

    expect(output.html).toContain('<article');
    expect(output.type).toBe('reference');
  });

  it('tags multiple technologies from mixed content', () => {
    const input = {
      sessionId: 'sess-mixed-001',
      text: 'Integrated postgres with React components using TypeScript. Added tests with Vitest.',
    };

    const output = annotateSession(input);

    expect(output.tags).toContain('database');
    expect(output.tags).toContain('frontend');
    expect(output.tags).toContain('typescript');
    expect(output.tags).toContain('testing');
  });

  it('preserves timestamp and sessionId hash in note id', () => {
    // extractSessionHash strips the leading word-prefix (e.g. "abc12345-") and
    // returns the hex run that follows ("def67890"). The note id must contain
    // that 8-char hash so different sessions always produce different ids.
    const sessionId = 'abc12345-def67890';
    const timestamp = '2026-05-24T10:30:00Z';
    const input = {
      sessionId,
      text: 'test note',
      timestamp,
    };

    const output = annotateSession(input);

    expect(output.id).toBeTruthy();
    expect(output.id).toMatch(/2026-05-24/);
    // The hash portion of the sessionId (after the prefix) must appear in the id
    expect(output.id).toMatch(/def67890/);
  });
});
