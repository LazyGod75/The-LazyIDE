/**
 * Tests for:
 * - extractFileNeuronStubs: HTML parsing of stored file-neuron articles
 * - buildConvNotes: conversation note extraction with data-cerveau-files-modified
 * - File-neuron re-render preserves architecture + children sections (Issue 1)
 * - Multi-project concept neuron uses correct projectRoot (Issue 2)
 * - Text-mention regex: bare filename without slash is NOT treated as path (Issue 3)
 * - Multi-project path layout tests: nested subproject, flat Python, flat JS (Issue 5)
 * - Fallback item when conv note has filesModified but no classifiable text (Issue 6)
 * - French accent-optional classification + sentence-split extension
 *   preservation for conv->file-neuron attachment (Issue 8, 2026-07-04)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import {
  buildEvidenceFromTags,
  runFileNeuronEnrichment,
} from '../src/commands/conv-file-enrichment.js';
import {
  buildBasenameIndex,
  buildBodyMentions,
  buildConvNotesFromHtml,
  extractFileNeuronStubs,
  splitIntoSentenceChunks,
} from '../src/commands/enrich.js';
import { runInit } from '../src/commands/init.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { closeDb } from '../src/indexer/fts.js';
import { readAllNotes } from '../src/store/reader.js';
import type { NoteFile } from '../src/store/reader.js';
import { resetConfigForTests } from '../src/util/config.js';

// ---------------------------------------------------------------------------
// Fixtures: pre-rendered file-neuron HTML
// ---------------------------------------------------------------------------

/**
 * Build a minimal NoteFile wrapping composeFileNeuron output for a given node.
 */
function makeFileNeuronNote(node: CodeNode): NoteFile {
  const html = composeFileNeuron(node, 2); // inbound=2 to test it is preserved
  return {
    path: `/fake/${node.filePath.replace(/\//g, '-')}.html`,
    id: node.id,
    html,
    sizeBytes: html.length,
    mtimeMs: Date.now(),
  };
}

const NODE_WITH_IMPORTS_EXPORTS: CodeNode = {
  id: 'file:src/auth.ts',
  title: 'src/auth.ts',
  type: 'file',
  filePath: 'src/auth.ts',
  projectRoot: '/project-alpha',
  language: 'typescript',
  lineCount: 80,
  imports: ['./session', './validator'],
  exports: ['login', 'logout', 'AuthService'],
};

const NODE_WITH_AST: CodeNode = {
  id: 'file:src/api.ts',
  title: 'src/api.ts',
  type: 'file',
  filePath: 'src/api.ts',
  projectRoot: '/project-alpha',
  language: 'typescript',
  lineCount: 120,
  imports: ['./db', './auth'],
  exports: ['createRoute', 'ApiServer'],
  astFunctions: [
    {
      name: 'createRoute',
      startLine: 10,
      endLine: 30,
      params: ['method', 'path'],
      isExported: true,
    },
    { name: 'handleError', startLine: 35, endLine: 45, params: ['err'], isExported: false },
  ],
  astClasses: [
    { name: 'ApiServer', methods: ['start', 'stop'], isExported: true, extends: 'EventEmitter' },
    { name: 'RouteCache', methods: ['get', 'set'], isExported: false },
  ],
};

// ---------------------------------------------------------------------------
// extractFileNeuronStubs: HTML parsing
// ---------------------------------------------------------------------------

describe('extractFileNeuronStubs — HTML parsing', () => {
  it('extracts filePath from data-code-file attribute', () => {
    const note = makeFileNeuronNote(NODE_WITH_IMPORTS_EXPORTS);
    const stubs = extractFileNeuronStubs([note]);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].filePath).toBe('src/auth.ts');
  });

  it('extracts projectRoot from data-cerveau-source="code-scanner:ROOT"', () => {
    const note = makeFileNeuronNote(NODE_WITH_IMPORTS_EXPORTS);
    const stubs = extractFileNeuronStubs([note]);
    expect(stubs[0].projectRoot).toBe('/project-alpha');
  });

  it('extracts language from data-code-language attribute', () => {
    const note = makeFileNeuronNote(NODE_WITH_IMPORTS_EXPORTS);
    const stubs = extractFileNeuronStubs([note]);
    expect(stubs[0].language).toBe('typescript');
  });

  it('extracts lineCount from data-code-lines attribute', () => {
    const note = makeFileNeuronNote(NODE_WITH_IMPORTS_EXPORTS);
    const stubs = extractFileNeuronStubs([note]);
    expect(stubs[0].lineCount).toBe(80);
  });

  it('parses imports from architecture section (NOT empty array)', () => {
    const note = makeFileNeuronNote(NODE_WITH_IMPORTS_EXPORTS);
    const stubs = extractFileNeuronStubs([note]);
    expect(stubs[0].imports).toContain('./session');
    expect(stubs[0].imports).toContain('./validator');
  });

  it('parses exports from architecture section (NOT empty array)', () => {
    const note = makeFileNeuronNote(NODE_WITH_IMPORTS_EXPORTS);
    const stubs = extractFileNeuronStubs([note]);
    expect(stubs[0].exports).toContain('login');
    expect(stubs[0].exports).toContain('logout');
    expect(stubs[0].exports).toContain('AuthService');
  });

  it('parses astFunctions from children section', () => {
    const note = makeFileNeuronNote(NODE_WITH_AST);
    const stubs = extractFileNeuronStubs([note]);
    const fns = stubs[0].astFunctions ?? [];
    const names = fns.map((f) => f.name);
    expect(names).toContain('createRoute');
    expect(names).toContain('handleError');
  });

  it('parses astFunctions params correctly', () => {
    const note = makeFileNeuronNote(NODE_WITH_AST);
    const stubs = extractFileNeuronStubs([note]);
    const fn = (stubs[0].astFunctions ?? []).find((f) => f.name === 'createRoute');
    expect(fn).toBeDefined();
    expect(fn!.params).toContain('method');
    expect(fn!.params).toContain('path');
  });

  it('parses astFunctions isExported flag', () => {
    const note = makeFileNeuronNote(NODE_WITH_AST);
    const stubs = extractFileNeuronStubs([note]);
    const exported = (stubs[0].astFunctions ?? []).find((f) => f.name === 'createRoute');
    const notExported = (stubs[0].astFunctions ?? []).find((f) => f.name === 'handleError');
    expect(exported!.isExported).toBe(true);
    expect(notExported!.isExported).toBe(false);
  });

  it('parses astClasses from children section', () => {
    const note = makeFileNeuronNote(NODE_WITH_AST);
    const stubs = extractFileNeuronStubs([note]);
    const classes = stubs[0].astClasses ?? [];
    const names = classes.map((c) => c.name);
    expect(names).toContain('ApiServer');
    expect(names).toContain('RouteCache');
  });

  it('parses astClasses extends field', () => {
    const note = makeFileNeuronNote(NODE_WITH_AST);
    const stubs = extractFileNeuronStubs([note]);
    const cls = (stubs[0].astClasses ?? []).find((c) => c.name === 'ApiServer');
    expect(cls).toBeDefined();
    expect(cls!.extends).toBe('EventEmitter');
  });

  it('parses astClasses methods', () => {
    const note = makeFileNeuronNote(NODE_WITH_AST);
    const stubs = extractFileNeuronStubs([note]);
    const cls = (stubs[0].astClasses ?? []).find((c) => c.name === 'ApiServer');
    expect(cls!.methods).toContain('start');
    expect(cls!.methods).toContain('stop');
  });

  it('skips notes without data-cerveau-type="file-neuron"', () => {
    const nonNeuron: NoteFile = {
      path: '/fake/note.html',
      id: 'some-id',
      html: '<article id="some-id" data-cerveau-type="reference"><p>hello</p></article>',
      sizeBytes: 100,
      mtimeMs: Date.now(),
    };
    const stubs = extractFileNeuronStubs([nonNeuron]);
    expect(stubs).toHaveLength(0);
  });

  it('returns empty array when data-code-file is missing', () => {
    // A note with file-neuron type but no data-code-file
    const note: NoteFile = {
      path: '/fake/note.html',
      id: 'bad-id',
      html: '<article id="bad-id" data-cerveau-type="file-neuron" data-cerveau-source="code-scanner:/root"><p>x</p></article>',
      sizeBytes: 100,
      mtimeMs: Date.now(),
    };
    const stubs = extractFileNeuronStubs([note]);
    expect(stubs).toHaveLength(0);
  });

  it('EXACT attribute name guard: data-code-file (not data-code-fiel) must be present', () => {
    // Verify that a typo in the attribute name would cause failure (regression guard)
    const note: NoteFile = {
      path: '/fake/note.html',
      id: 'typo-id',
      html: '<article id="typo-id" data-cerveau-type="file-neuron" data-cerveau-source="code-scanner:/root" data-code-fiel="src/typo.ts"><p>x</p></article>',
      sizeBytes: 100,
      mtimeMs: Date.now(),
    };
    // Should fail to extract (no valid data-code-file match)
    const stubs = extractFileNeuronStubs([note]);
    expect(stubs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildConvNotes: attribute name guard
// ---------------------------------------------------------------------------

describe('buildConvNotes — attribute name correctness', () => {
  it('data-cerveau-files-modified (not data-cerveau-files-modifed) must parse correctly', () => {
    // The correct attribute is data-cerveau-files-modified (double 'i')
    // A note with the correct spelling should be parseable.
    // We test the regex directly here since buildConvNotes is not exported.
    // Guard: match against the correct attribute name.
    const correctHtml =
      '<article data-cerveau-files-modified="src/auth.ts,src/utils.ts"></article>';
    const correctMatch = correctHtml.match(/data-cerveau-files-modified\s*=\s*["']([^"']+)["']/i);
    expect(correctMatch).not.toBeNull();
    expect(correctMatch![1]).toBe('src/auth.ts,src/utils.ts');
  });

  it('TYPO guard: data-cerveau-files-modifed (missing i) does NOT match the correct regex', () => {
    // If someone writes the attribute with a typo, it must NOT match the correct regex
    const typoHtml = '<article data-cerveau-files-modifed="src/auth.ts"></article>';
    const correctRegex = /data-cerveau-files-modified\s*=\s*["']([^"']+)["']/i;
    expect(correctRegex.test(typoHtml)).toBe(false);
  });

  it('data-cerveau-files-read attribute name is correct', () => {
    const html = '<article data-cerveau-files-read="src/config.ts"></article>';
    const match = html.match(/data-cerveau-files-read\s*=\s*["']([^"']+)["']/i);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('src/config.ts');
  });
});

// ---------------------------------------------------------------------------
// Text-mention path regex: bare filename without slash is NOT a path
// ---------------------------------------------------------------------------

describe('buildEvidenceFromTags — text-mention path regex', () => {
  it('bare filename without slash (e.g. "auth.ts") is NOT treated as a file path', () => {
    // The regex requires at least one slash: rawPath.includes('/')
    const evidence = buildEvidenceFromTags({
      filesModified: [],
      filesRead: [],
      itemText: 'The auth.ts file has a bug in the login function',
    });
    // "auth.ts" has no slash → should NOT be treated as a path neuron
    const entry = evidence.find((e) => e.neuronId === 'file:auth.ts');
    expect(entry).toBeUndefined();
  });

  it('path with slash (e.g. "src/auth.ts") IS treated as a file path', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: [],
      filesRead: [],
      itemText: 'Changed src/auth.ts to fix the login bug',
    });
    const entry = evidence.find((e) => e.neuronId === 'file:src/auth.ts');
    expect(entry).toBeDefined();
    expect(entry!.weight).toBe(0.85);
  });

  it('filename-only like "index.js" does NOT become a neuron evidence', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: [],
      filesRead: [],
      itemText: 'Updated index.js to export the new handler',
    });
    const entry = evidence.find((e) => e.neuronId === 'file:index.js');
    expect(entry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue 1: File-neuron re-render preserves architecture + children
// ---------------------------------------------------------------------------

describe('File-neuron re-render preserves code sections after enrichment (Issue 1)', () => {
  let tmpDir: string;
  const origBrainPath = process.env.LAZYBRAIN_BRAIN_PATH;
  const origCachePath = process.env.LAZYBRAIN_CACHE_PATH;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-preserve-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.LAZYBRAIN_BRAIN_PATH = origBrainPath;
    process.env.LAZYBRAIN_CACHE_PATH = origCachePath;
    resetConfigForTests();
  });

  it('enriched file-neuron still has architecture section (imports/exports) and children anchors', async () => {
    // Node with imports, exports, and AST data
    const node: CodeNode = {
      id: 'file:src/scanner.ts',
      title: 'src/scanner.ts',
      type: 'file',
      filePath: 'src/scanner.ts',
      projectRoot: '/my-project',
      language: 'typescript',
      lineCount: 150,
      imports: ['./utils', './parser'],
      exports: ['scan', 'ScanResult'],
      astFunctions: [
        { name: 'scan', startLine: 10, endLine: 50, params: ['dir', 'opts'], isExported: true },
        { name: 'walk', startLine: 55, endLine: 90, params: ['path'], isExported: false },
      ],
      astClasses: [{ name: 'ScanResult', methods: ['toJson', 'merge'], isExported: true }],
    };

    // Step 1: run enrichment with this node and a conv note that modifies it
    await runFileNeuronEnrichment({
      projectRoot: '/my-project',
      fileNodes: [node],
      convNotes: [
        {
          id: 'conv-scanner-2026-05-28',
          filesModified: ['src/scanner.ts'],
          filesRead: [],
          timestamp: '2026-05-28',
          classifiedItems: [
            {
              kind: 'decision' as const,
              text: 'decided to use recursive walk for directory scanning',
              sourceId: 'conv-scanner-2026-05-28',
            },
          ],
        },
      ],
    });

    const notes = readAllNotes();
    const enrichedNote = notes.find(
      (n) =>
        n.html.includes('data-cerveau-type="file-neuron"') && n.html.includes('src/scanner.ts'),
    );

    expect(enrichedNote).toBeDefined();
    const html = enrichedNote!.html;

    // Architecture section must be present
    expect(html).toContain('data-section="architecture"');
    // Imports must still be rendered
    expect(html).toContain('./utils');
    expect(html).toContain('./parser');
    // Exports must still be rendered
    expect(html).toContain('scan');
    expect(html).toContain('ScanResult');
    // Children section with function/class anchors must be present
    expect(html).toContain('data-section="children"');
    expect(html).toContain('id="fn-scan"');
    expect(html).toContain('id="fn-walk"');
    expect(html).toContain('id="cls-scanresult"');
    // Decisions section must ALSO be present (enrichment was applied)
    expect(html).toContain('data-section="decisions"');
    expect(html).toContain('decided to use recursive walk');
  });
});

// ---------------------------------------------------------------------------
// Issue 2: Multi-project concept neuron uses correct projectRoot
// ---------------------------------------------------------------------------

describe('Multi-project: concept neuron carries correct project root (Issue 2)', () => {
  let tmpDir: string;
  const origBrainPath = process.env.LAZYBRAIN_BRAIN_PATH;
  const origCachePath = process.env.LAZYBRAIN_CACHE_PATH;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-multiproj-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.LAZYBRAIN_BRAIN_PATH = origBrainPath;
    process.env.LAZYBRAIN_CACHE_PATH = origCachePath;
    resetConfigForTests();
  });

  it('concept neuron from project-beta files carries project-beta name, not project-alpha', async () => {
    // Two projects: alpha files go to section (single file dominates),
    // beta files spread across 3 → concept route.
    const nodesAlpha: CodeNode[] = [
      {
        id: 'file:src/index.ts',
        title: 'src/index.ts',
        type: 'file',
        filePath: 'src/index.ts',
        projectRoot: '/C/Users/johndoe/Documents/project-alpha',
        language: 'typescript',
        lineCount: 20,
        imports: [],
        exports: ['main'],
      },
    ];

    const nodesBeta: CodeNode[] = [
      {
        id: 'file:lib/a.ts',
        title: 'lib/a.ts',
        type: 'file',
        filePath: 'lib/a.ts',
        projectRoot: '/C/Users/johndoe/Documents/project-beta',
        language: 'typescript',
        lineCount: 30,
        imports: [],
        exports: ['A'],
      },
      {
        id: 'file:lib/b.ts',
        title: 'lib/b.ts',
        type: 'file',
        filePath: 'lib/b.ts',
        projectRoot: '/C/Users/johndoe/Documents/project-beta',
        language: 'typescript',
        lineCount: 25,
        imports: [],
        exports: ['B'],
      },
      {
        id: 'file:lib/c.ts',
        title: 'lib/c.ts',
        type: 'file',
        filePath: 'lib/c.ts',
        projectRoot: '/C/Users/johndoe/Documents/project-beta',
        language: 'typescript',
        lineCount: 20,
        imports: [],
        exports: ['C'],
      },
    ];

    // The conv note modifies 3 beta files equally → concept placement
    await runFileNeuronEnrichment({
      projectRoot: '/C/Users/johndoe/Documents/project-alpha', // global = alpha
      fileNodes: [...nodesAlpha, ...nodesBeta],
      convNotes: [
        {
          id: 'conv-beta-spread-2026-05-28',
          // Beta files only (3 equal weight → concept)
          filesModified: ['lib/a.ts', 'lib/b.ts', 'lib/c.ts'],
          filesRead: [],
          timestamp: '2026-05-28',
          classifiedItems: [
            {
              kind: 'idea' as const,
              text: 'idea to refactor beta lib modules into a single entry point',
              sourceId: 'conv-beta-spread-2026-05-28',
            },
          ],
        },
      ],
    });

    const notes = readAllNotes();
    const conceptNote = notes.find(
      (n) =>
        n.html.includes('data-cerveau-type="concept"') &&
        n.html.includes('refactor beta lib modules'),
    );

    expect(conceptNote).toBeDefined();
    // The concept neuron should reference project-beta, NOT project-alpha
    expect(conceptNote!.html).toContain('project-beta');
    expect(conceptNote!.html).not.toContain('project-alpha');
  });
});

// ---------------------------------------------------------------------------
// Issue 4: path-convention regression — conv note stores parent-relative path,
//           file-neuron id uses sub-project-relative path.
//
// Real scenario reproduced from production failure (2026-05-28):
//   - Claude project folder: C--Users-user-Documents-Acme
//   - dream.ts decodes → projectRoot: C:/Users/user/Documents/Acme
//   - Tool call path: C:\Users\user\Documents\Acme\acme-app\app\details\cal\index.jsx
//   - relativise(absPath, acmeRoot) → "acme-app/app/details/cal/index.jsx"
//   - stored in data-cerveau-files-modified (already relative, includes sub-dir prefix)
//   - code-scanner scans acme-app → file-neuron id: file:app/details/cal/index.jsx
//   - buildConvNotes tried to relativise "acme-app/app/..." against acme-app root → null
//   - Result: ZERO evidence built → file-neurons got no conv sections
//
// Fix: buildConvNotes now reconstructs absolute path via data-cerveau-cwd + stored rel,
//      then re-relativises against each file-neuron projectRoot.
// ---------------------------------------------------------------------------

describe('buildConvNotesFromHtml — path-convention regression (Issue 4)', () => {
  // Build a minimal file-neuron NoteFile for the regression scenario.
  // projectRoot = Windows-style absolute path of the sub-project.
  function makeFileNeuronHtml(filePath: string, projectRoot: string): NoteFile {
    const node: CodeNode = {
      id: `file:${filePath}`,
      title: filePath,
      type: 'file',
      filePath,
      projectRoot,
      language: 'javascript',
      lineCount: 100,
      imports: [],
      exports: [],
    };
    const html = composeFileNeuron(node, 0);
    return {
      path: `/fake/${filePath.replace(/\//g, '-')}.html`,
      id: `file:${filePath}`,
      html,
      sizeBytes: html.length,
      mtimeMs: Date.now(),
    };
  }

  // Build a minimal conv note NoteFile with the REAL format: path already relative
  // to the parent dir (as stored by dream.ts when the claude project folder is the
  // parent of the actual scanned sub-project).
  function makeConvNoteHtml(opts: {
    id: string;
    cwd: string;
    filesModified: string;
    content: string;
  }): NoteFile {
    const html = [
      `<article id="${opts.id}"`,
      `  data-cerveau-type="fact"`,
      `  data-cerveau-created="2026-05-28T10:00:00Z"`,
      `  data-cerveau-cwd="${opts.cwd}"`,
      `  data-cerveau-files-modified="${opts.filesModified}"`,
      '>',
      `<p>${opts.content}</p>`,
      '</article>',
    ].join('\n');
    return {
      path: `/fake/${opts.id}.html`,
      id: opts.id,
      html,
      sizeBytes: html.length,
      mtimeMs: Date.now(),
    };
  }

  it('resolves parent-relative path (acme-app/app/...) to sub-project-relative (app/...) matching file-neuron id', () => {
    // Simulate: cwd=Acme parent, file-neuron in acme-app sub-project
    const fileNeuronNote = makeFileNeuronHtml(
      'app/details/cal/index.jsx',
      'C:/Users/user/Documents/Acme/acme-app',
    );
    const stubs = extractFileNeuronStubs([fileNeuronNote]);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].id).toBe('file:app/details/cal/index.jsx');

    // Conv note: path stored as parent-relative by dream.ts
    //   cwd = C:/Users/user/Documents/Acme (parent)
    //   filesModified = acme-app/app/details/cal/index.jsx (relative to cwd)
    const convNote = makeConvNoteHtml({
      id: 'conv-acme-fix-test',
      cwd: 'C:/Users/user/Documents/Acme',
      filesModified: 'acme-app/app/details/cal/index.jsx',
      content: 'decided to fix the calendar component layout to match design spec',
    });

    const projectRoots = stubs.map((s) => s.projectRoot);
    // projectRoots = ['C:/Users/user/Documents/Acme/acme-app']

    const convNotes = buildConvNotesFromHtml([convNote], projectRoots);

    // Without the fix: convNotes would be empty (null from relativise, items skipped)
    // With the fix: path is reconstructed as absolute, then matched to acme-app root
    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesModified).toContain('app/details/cal/index.jsx');
  });

  it('evidence neuronId from resolved path matches file-neuron id exactly', () => {
    // This is the core guard: the path that becomes file:... in evidence must equal
    // the file-neuron stub id so canonicalMerge attaches to the right neuron.
    const fileNeuronNote = makeFileNeuronHtml(
      'src/auth/login.ts',
      'C:/Users/johndoe/Documents/MyProject/MyProject_app',
    );
    const stubs = extractFileNeuronStubs([fileNeuronNote]);

    const convNote = makeConvNoteHtml({
      id: 'conv-auth-fix-test',
      cwd: 'C:/Users/johndoe/Documents/MyProject',
      filesModified: 'MyProject_app/src/auth/login.ts',
      content: 'decided to use JWT for authentication',
    });

    const projectRoots = stubs.map((s) => s.projectRoot);
    const convNotes = buildConvNotesFromHtml([convNote], projectRoots);

    expect(convNotes).toHaveLength(1);
    const resolvedPath = convNotes[0].filesModified[0];
    // resolvedPath must match stubs[0].filePath so buildEvidenceFromTags produces
    // neuronId 'file:src/auth/login.ts' which equals stubs[0].id
    expect(`file:${resolvedPath}`).toBe(stubs[0].id);
  });

  it('concept neuron created when path resolves correctly and evidence spreads across 3 files', async () => {
    // Regression guard for the spread/concept path
    const projectRoot = 'C:/Users/johndoe/Documents/ParentDir/SubProject';
    const projectRoots = [projectRoot];

    // Conv note stores paths relative to PARENT dir (SubProject/ prefix)
    const convNote = makeConvNoteHtml({
      id: 'conv-spread-fix-test',
      cwd: 'C:/Users/johndoe/Documents/ParentDir',
      filesModified: 'SubProject/app/a.ts,SubProject/app/b.ts,SubProject/app/c.ts',
      content: 'decided to refactor the module into smaller pieces for maintainability',
    });

    const convNotes = buildConvNotesFromHtml([convNote], projectRoots);
    expect(convNotes).toHaveLength(1);
    // All 3 files should resolve correctly
    expect(convNotes[0].filesModified).toHaveLength(3);
    expect(convNotes[0].filesModified).toContain('app/a.ts');
    expect(convNotes[0].filesModified).toContain('app/b.ts');
    expect(convNotes[0].filesModified).toContain('app/c.ts');
  });

  it('absolute path in data-cerveau-files-modified still resolves correctly (backward compat)', () => {
    // Even if a future version stores absolute paths, the resolution must still work
    const fileNeuronNote = makeFileNeuronHtml(
      'src/utils.ts',
      'C:/Users/johndoe/Documents/MyProject',
    );
    const stubs = extractFileNeuronStubs([fileNeuronNote]);

    const convNote = makeConvNoteHtml({
      id: 'conv-abs-path-test',
      cwd: 'C:/Users/johndoe/Documents/MyProject',
      filesModified: 'C:/Users/johndoe/Documents/MyProject/src/utils.ts',
      content: 'fixed the bug in utils that caused crashes on null input',
    });

    const projectRoots = stubs.map((s) => s.projectRoot);
    const convNotes = buildConvNotesFromHtml([convNote], projectRoots);

    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesModified).toContain('src/utils.ts');
  });
});

// ---------------------------------------------------------------------------
// Issue 4 — E2E: path fix yields fileNeuronsEnriched > 0 + conceptNeuronsCreated > 0
// ---------------------------------------------------------------------------

describe('Issue 4 — E2E: enrichment populates file-neurons after path fix', () => {
  let tmpDir: string;
  const origBrainPath = process.env.LAZYBRAIN_BRAIN_PATH;
  const origCachePath = process.env.LAZYBRAIN_CACHE_PATH;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-pathfix-e2e-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.LAZYBRAIN_BRAIN_PATH = origBrainPath;
    process.env.LAZYBRAIN_CACHE_PATH = origCachePath;
    resetConfigForTests();
  });

  it('file-neuron gets decisions section when conv uses parent-relative path (real Acme scenario)', async () => {
    // Exact production scenario: conv note modified acme-app/app/details/cal/index.jsx
    // (relative to the Acme parent dir), file-neuron id = file:app/details/cal/index.jsx
    const projectRoot = 'C:/Users/user/Documents/Acme/acme-app';

    const fileNode: CodeNode = {
      id: 'file:app/details/cal/index.jsx',
      title: 'app/details/cal/index.jsx',
      type: 'file',
      filePath: 'app/details/cal/index.jsx',
      projectRoot,
      language: 'javascript',
      lineCount: 120,
      imports: [],
      exports: ['CalendarView'],
    };

    // Simulate what buildConvNotesFromHtml produces after the fix:
    // The conv note had filesModified = 'acme-app/app/details/cal/index.jsx'
    // and cwd = 'C:/Users/user/Documents/Acme'
    // After fix: resolves to 'app/details/cal/index.jsx'
    const report = await runFileNeuronEnrichment({
      projectRoot,
      fileNodes: [fileNode],
      convNotes: [
        {
          id: 'conv-acme-calendar-2026-05-28',
          filesModified: ['app/details/cal/index.jsx'],
          filesRead: [],
          timestamp: '2026-05-28',
          classifiedItems: [
            {
              kind: 'decision' as const,
              text: 'decided to fix the calendar layout to match the Figma design spec',
              sourceId: 'conv-acme-calendar-2026-05-28',
            },
          ],
        },
      ],
    });

    // Core assertion: at least 1 file-neuron was enriched
    expect(report.fileNeuronsEnriched).toBeGreaterThanOrEqual(1);
    expect(report.errors).toHaveLength(0);

    // Verify the written file-neuron contains the decisions section
    const notes = readAllNotes();
    const fileNeuronNote = notes.find(
      (n) =>
        n.html.includes('data-cerveau-type="file-neuron"') &&
        n.html.includes('app/details/cal/index.jsx'),
    );
    expect(fileNeuronNote).toBeDefined();
    expect(fileNeuronNote!.html).toContain('data-section="decisions"');
    expect(fileNeuronNote!.html).toContain('decided to fix the calendar layout');
  });

  it('concept neuron created when resolved evidence spreads equally across 3 files (real spread scenario)', async () => {
    const projectRoot = 'C:/Users/user/Documents/Acme/acme-app';

    const fileNodes: CodeNode[] = [
      {
        id: 'file:app/auth/login.tsx',
        title: 'app/auth/login.tsx',
        type: 'file',
        filePath: 'app/auth/login.tsx',
        projectRoot,
        language: 'typescript',
        lineCount: 80,
        imports: [],
        exports: ['LoginScreen'],
      },
      {
        id: 'file:app/auth/signup.tsx',
        title: 'app/auth/signup.tsx',
        type: 'file',
        filePath: 'app/auth/signup.tsx',
        projectRoot,
        language: 'typescript',
        lineCount: 90,
        imports: [],
        exports: ['SignupScreen'],
      },
      {
        id: 'file:app/auth/reset.tsx',
        title: 'app/auth/reset.tsx',
        type: 'file',
        filePath: 'app/auth/reset.tsx',
        projectRoot,
        language: 'typescript',
        lineCount: 60,
        imports: [],
        exports: ['ResetScreen'],
      },
    ];

    // After the path fix, these paths resolve correctly from the conv note
    const report = await runFileNeuronEnrichment({
      projectRoot,
      fileNodes,
      convNotes: [
        {
          id: 'conv-acme-auth-2026-05-28',
          // All 3 auth screens modified equally → spread → concept neuron
          filesModified: ['app/auth/login.tsx', 'app/auth/signup.tsx', 'app/auth/reset.tsx'],
          filesRead: [],
          timestamp: '2026-05-28',
          classifiedItems: [
            {
              kind: 'decision' as const,
              text: 'decided to unify the auth screens under a common AuthLayout component',
              sourceId: 'conv-acme-auth-2026-05-28',
            },
          ],
        },
      ],
    });

    // Core assertion: concept neuron created (evidence spread across 3 equal files)
    expect(report.conceptNeuronsCreated).toBeGreaterThanOrEqual(1);

    const notes = readAllNotes();
    const conceptNote = notes.find((n) => n.html.includes('data-cerveau-type="concept"'));
    expect(conceptNote).toBeDefined();
    expect(conceptNote!.html).toContain('decided to unify the auth screens');
  });
});

// ---------------------------------------------------------------------------
// Issue 5: Multi-project path layout resolution
//
// Tests that buildConvNotesFromHtml correctly resolves paths for THREE distinct
// project layout patterns:
//   A) Nested subproject: conv CWD is the parent, file lives in a named sub-dir
//   B) Flat Python repo: conv CWD == project root, paths are simple relative paths
//   C) Flat JS sub-project: conv CWD == marketing sub-dir, paths are sub-relative
//
// In ALL cases the resolved path must produce a neuronId that matches the
// file-neuron stub's id EXACTLY.
// ---------------------------------------------------------------------------

/** Build a minimal conv-note NoteFile for use in buildConvNotesFromHtml. */
function makeConvNoteForLayout(opts: {
  id: string;
  cwd: string;
  filesModified: string[];
  content: string;
}): NoteFile {
  const html = [
    `<article id="${opts.id}"`,
    `  data-cerveau-type="episodic"`,
    `  data-cerveau-created="2026-05-28T10:00:00Z"`,
    `  data-cerveau-cwd="${opts.cwd}"`,
    `  data-cerveau-files-modified="${opts.filesModified.join(',')}"`,
    '>',
    `<p>${opts.content}</p>`,
    '</article>',
  ].join('\n');
  return {
    path: `/fake/${opts.id}.html`,
    id: opts.id,
    html,
    sizeBytes: html.length,
    mtimeMs: Date.now(),
  };
}

/** Build a minimal file-neuron NoteFile. */
function makeFileNeuronForLayout(filePath: string, projectRoot: string): NoteFile {
  const node: CodeNode = {
    id: `file:${filePath}`,
    title: filePath,
    type: 'file',
    filePath,
    projectRoot,
    language: 'typescript',
    lineCount: 50,
    imports: [],
    exports: [],
  };
  const html = composeFileNeuron(node, 0);
  return {
    path: `/fake/${filePath.replace(/\//g, '-')}.html`,
    id: `file:${filePath}`,
    html,
    sizeBytes: html.length,
    mtimeMs: Date.now(),
  };
}

describe('buildConvNotesFromHtml — multi-project layout resolution (Issue 5)', () => {
  it('Layout A: nested subproject — conv CWD is parent, file is in sub-dir', () => {
    // Scenario: mobile app where conversation runs from Acme/ but edits acme-app/ files.
    // CWD  = /projects/Acme
    // Tool path relativised to CWD → stored as: acme-app/app/auth/login.tsx
    // File-neuron projectRoot = /projects/Acme/acme-app
    // File-neuron filePath   = app/auth/login.tsx
    // Expected resolved: app/auth/login.tsx → neuronId = file:app/auth/login.tsx

    const projectRoot = '/projects/Acme/acme-app';
    const convCwd = '/projects/Acme';
    const storedRelPath = 'acme-app/app/auth/login.tsx'; // relative to parent CWD

    const fileNeuronNote = makeFileNeuronForLayout('app/auth/login.tsx', projectRoot);
    const stubs = extractFileNeuronStubs([fileNeuronNote]);

    const convNote = makeConvNoteForLayout({
      id: 'conv-layout-a',
      cwd: convCwd,
      filesModified: [storedRelPath],
      content: 'decided to refactor the login screen to use the new design system',
    });

    const convNotes = buildConvNotesFromHtml(
      [convNote],
      stubs.map((s) => s.projectRoot),
    );
    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesModified).toContain('app/auth/login.tsx');
    expect(`file:${convNotes[0].filesModified[0]}`).toBe(stubs[0].id);
  });

  it('Layout B: flat Python repo — conv CWD == project root, simple relative paths', () => {
    // Scenario: Tradelab Python project.
    // CWD  = /projects/Tradelab
    // Tool path relativised to CWD → stored as: sentinel/backtest.py
    // File-neuron projectRoot = /projects/Tradelab
    // File-neuron filePath   = sentinel/backtest.py

    const projectRoot = '/projects/Tradelab';
    const convCwd = '/projects/Tradelab';
    const storedRelPath = 'sentinel/backtest.py';

    const fileNeuronNote = makeFileNeuronForLayout('sentinel/backtest.py', projectRoot);
    const stubs = extractFileNeuronStubs([fileNeuronNote]);

    const convNote = makeConvNoteForLayout({
      id: 'conv-layout-b',
      cwd: convCwd,
      filesModified: [storedRelPath],
      content: 'fixed the optimizer crash when kp equals zero minimum',
    });

    const convNotes = buildConvNotesFromHtml(
      [convNote],
      stubs.map((s) => s.projectRoot),
    );
    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesModified).toContain('sentinel/backtest.py');
    expect(`file:${convNotes[0].filesModified[0]}`).toBe(stubs[0].id);
  });

  it('Layout C: flat JS sub-project — conv CWD == marketing sub-dir', () => {
    // Scenario: marketing JS project under a parent dir.
    // CWD  = /projects/Acme/marketing
    // Tool path relativised to CWD → stored as: _bot/publish.py
    // File-neuron projectRoot = /projects/Acme/marketing
    // File-neuron filePath   = _bot/publish.py

    const projectRoot = '/projects/Acme/marketing';
    const convCwd = '/projects/Acme/marketing';
    const storedRelPath = '_bot/publish.py';

    const fileNeuronNote = makeFileNeuronForLayout('_bot/publish.py', projectRoot);
    const stubs = extractFileNeuronStubs([fileNeuronNote]);

    const convNote = makeConvNoteForLayout({
      id: 'conv-layout-c',
      cwd: convCwd,
      filesModified: [storedRelPath],
      content: 'added retry logic with exponential backoff to publish.py always use this pattern',
    });

    const convNotes = buildConvNotesFromHtml(
      [convNote],
      stubs.map((s) => s.projectRoot),
    );
    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesModified).toContain('_bot/publish.py');
    expect(`file:${convNotes[0].filesModified[0]}`).toBe(stubs[0].id);
  });

  it('Layout A: Windows-style paths with backslash in stored path normalise correctly', () => {
    // Same as Layout A but stored path uses backslash (Windows tool output).
    const projectRoot = 'C:/projects/Acme/acme-app';
    const convCwd = 'C:/projects/Acme';
    const storedRelPath = 'acme-app\\app\\auth\\login.tsx'; // backslash variant

    const fileNeuronNote = makeFileNeuronForLayout('app/auth/login.tsx', projectRoot);
    const stubs = extractFileNeuronStubs([fileNeuronNote]);

    const convNote = makeConvNoteForLayout({
      id: 'conv-layout-a-win',
      cwd: convCwd,
      filesModified: [storedRelPath],
      content: 'decided to use the new auth flow based on JWT tokens',
    });

    const convNotes = buildConvNotesFromHtml(
      [convNote],
      stubs.map((s) => s.projectRoot),
    );
    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesModified).toContain('app/auth/login.tsx');
  });

  it('Layout B: multiple files in same flat project all resolve correctly', () => {
    // Multiple files modified in a single conv — all should resolve.
    const projectRoot = '/projects/Tradelab';
    const convCwd = '/projects/Tradelab';

    const fileNeurons = [
      makeFileNeuronForLayout('sentinel/backtest.py', projectRoot),
      makeFileNeuronForLayout('tradebot/bot.py', projectRoot),
      makeFileNeuronForLayout('risk/calculator.py', projectRoot),
    ];
    const stubs = extractFileNeuronStubs(fileNeurons);

    const convNote = makeConvNoteForLayout({
      id: 'conv-layout-b-multi',
      cwd: convCwd,
      filesModified: ['sentinel/backtest.py', 'tradebot/bot.py', 'risk/calculator.py'],
      content: 'decided to unify risk calculation across all tradelab modules',
    });

    const convNotes = buildConvNotesFromHtml(
      [convNote],
      stubs.map((s) => s.projectRoot),
    );
    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesModified).toHaveLength(3);
    expect(convNotes[0].filesModified).toContain('sentinel/backtest.py');
    expect(convNotes[0].filesModified).toContain('tradebot/bot.py');
    expect(convNotes[0].filesModified).toContain('risk/calculator.py');
  });
});

// ---------------------------------------------------------------------------
// Issue 6: Fallback item when conv note has filesModified but no classifiable text
//
// Many real conversations only say things like "Updated the auth module" or
// "Refactored the bot script" — generic prose that does not match any
// decision/bug/idea/rule/qa classifier pattern.
//
// Before the fix: if (items.length === 0) continue → conv silently dropped.
// After the fix: a fallback item is synthesised from the first prose chunk so
// the file-neuron still receives a section linking it to this conversation.
// ---------------------------------------------------------------------------

describe('buildConvNotesFromHtml — fallback item for unclassified text with filesModified (Issue 6)', () => {
  it('conv note with filesModified and generic (unclassified) text still produces a ConvNote', () => {
    // Text deliberately avoids all classifier keywords
    const projectRoot = '/projects/Tradelab';

    const convNote = makeConvNoteForLayout({
      id: 'conv-unclassified',
      cwd: projectRoot,
      filesModified: ['sentinel/backtest.py'],
      // No decision/bug/idea/rule/qa keywords — purely generic prose
      content: 'Updated the backtest configuration to use the new parameter set',
    });

    const convNotes = buildConvNotesFromHtml([convNote], [projectRoot]);
    // Without fix: would be [] because items.length === 0 triggers continue
    // With fix: at least one ConvNote is produced via the fallback item
    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesModified).toContain('sentinel/backtest.py');
    expect(convNotes[0].classifiedItems).toHaveLength(1);
    // Fallback uses 'activity' — the honest kind for keyword-less conversations.
    expect(convNotes[0].classifiedItems[0].kind).toBe('activity');
  });

  it('fallback item text is derived from the first meaningful prose chunk', () => {
    const projectRoot = '/projects/Tradelab';

    const convNote = makeConvNoteForLayout({
      id: 'conv-unclassified-text',
      cwd: projectRoot,
      filesModified: ['tradebot/bot.py'],
      content: 'Refactored the tradelab bot to use a cleaner architecture with separate modules',
    });

    const convNotes = buildConvNotesFromHtml([convNote], [projectRoot]);
    expect(convNotes).toHaveLength(1);
    // Fallback item should contain the prose text
    expect(convNotes[0].classifiedItems[0].text.length).toBeGreaterThan(10);
    expect(convNotes[0].classifiedItems[0].text).toMatch(/[Rr]efactored/);
  });

  it('conv note with NO filesModified and unclassified text is still skipped', () => {
    // The fallback only activates when filesModified is non-empty.
    // A conv with no file tags and no classified items should still be dropped.
    const convNoteNoFiles = makeConvNoteForLayout({
      id: 'conv-no-files-unclassified',
      cwd: '/projects/Tradelab',
      filesModified: [], // ← empty
      content: 'Updated the backtest configuration to use the new parameter set',
    });
    // Remove filesModified from HTML so it's truly absent
    const noFilesHtml = convNoteNoFiles.html.replace(/data-cerveau-files-modified="[^"]*"/, '');
    const noFilesNote: NoteFile = { ...convNoteNoFiles, html: noFilesHtml };

    const convNotes = buildConvNotesFromHtml([noFilesNote], ['/projects/Tradelab']);
    // Should be empty — no file tags, no classified items → nothing to attach
    expect(convNotes).toHaveLength(0);
  });

  it('conv note with classified text AND filesModified uses the classified items (not fallback)', () => {
    // When real classified items exist, the fallback should NOT add a duplicate.
    const projectRoot = '/projects/Tradelab';

    const convNote = makeConvNoteForLayout({
      id: 'conv-classified-with-files',
      cwd: projectRoot,
      filesModified: ['sentinel/backtest.py'],
      content: 'decided to use walk-forward validation with 12 windows for robustness',
    });

    const convNotes = buildConvNotesFromHtml([convNote], [projectRoot]);
    expect(convNotes).toHaveLength(1);
    // Should have exactly 1 classified item (decision from "decided to"), not 2
    const decisions = convNotes[0].classifiedItems.filter((i) => i.kind === 'decision');
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    // All items should be from the classifier, text should contain "decided"
    expect(decisions[0].text).toMatch(/decided/i);
  });

  it('file-neuron gets a section even when conv text contains no classifier keywords (E2E)', async () => {
    // This is the core E2E test: a conv that only says "Updated X" should still
    // enrich the file-neuron with a section linking the conv.
    const brainPath = mkdtempSync(join(tmpdir(), 'lazybrain-fallback-e2e-'));
    const origBrainPath = process.env.LAZYBRAIN_BRAIN_PATH;
    const origCachePath = process.env.LAZYBRAIN_CACHE_PATH;

    process.env.LAZYBRAIN_BRAIN_PATH = join(brainPath, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(brainPath, '.lazybrain', '_cache');
    resetConfigForTests();

    try {
      await runInit({ path: join(brainPath, '.lazybrain', 'brain') });

      const projectRoot = '/projects/Tradelab';
      const fileNode: CodeNode = {
        id: 'file:sentinel/backtest.py',
        title: 'sentinel/backtest.py',
        type: 'file',
        filePath: 'sentinel/backtest.py',
        projectRoot,
        language: 'python',
        lineCount: 200,
        imports: [],
        exports: ['run_backtest'],
      };

      // Build a conv note via buildConvNotesFromHtml first, using generic text
      const convNote = makeConvNoteForLayout({
        id: 'conv-fallback-e2e',
        cwd: projectRoot,
        filesModified: ['sentinel/backtest.py'],
        content: 'Updated the backtest configuration to use the new parameter set from the sweep',
      });

      const convNotes = buildConvNotesFromHtml([convNote], [projectRoot]);
      expect(convNotes).toHaveLength(1); // fallback must activate

      const report = await runFileNeuronEnrichment({
        projectRoot,
        fileNodes: [fileNode],
        convNotes,
      });

      expect(report.fileNeuronsEnriched).toBeGreaterThanOrEqual(1);

      const notes = readAllNotes();
      const fileNeuronNote = notes.find(
        (n) =>
          n.html.includes('data-cerveau-type="file-neuron"') &&
          n.html.includes('sentinel/backtest.py'),
      );
      expect(fileNeuronNote).toBeDefined();
      // The file-neuron should have at least one enrichment section.
      // Fallback items are rendered as 'activity' (not 'decisions'), so check for
      // either the dedicated activity section or any of the richer sections.
      const hasAnySection =
        fileNeuronNote!.html.includes('data-section="decisions"') ||
        fileNeuronNote!.html.includes('data-section="bugs"') ||
        fileNeuronNote!.html.includes('data-section="ideas"') ||
        fileNeuronNote!.html.includes('data-section="rules"') ||
        fileNeuronNote!.html.includes('data-section="activity"');
      expect(hasAnySection).toBe(true);
    } finally {
      closeDb();
      rmSync(brainPath, { recursive: true, force: true });
      process.env.LAZYBRAIN_BRAIN_PATH = origBrainPath;
      process.env.LAZYBRAIN_CACHE_PATH = origCachePath;
      resetConfigForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// Issue 7: Body-mention fusion — conv notes with no tool-trace file attrs
// can still enrich file-neurons via path mentions in the note body text.
//
// Root cause (verified 2026-05-29):
//   - buildConvNotes previously skipped ALL notes with no files-modified/read.
//   - ~1480/1498 conversation notes had no tool-trace file attrs → zero coverage.
//   - buildEvidenceFromTags only scanned the single classified item text (~300 chars).
//
// Fix:
//   1. buildConvNotes: when fileNodes provided, call buildBodyMentions on the
//      stripped note body → resolve path mentions unambiguously → filesBodyMentions.
//   2. Notes without tool-trace attrs are kept when filesBodyMentions is non-empty.
//   3. buildEvidenceFromTags: adds filesBodyMentions at weight 0.85.
//   4. Ambiguous basenames (same basename, multiple files) are NOT attached.
// ---------------------------------------------------------------------------

describe('buildBasenameIndex', () => {
  it('maps lowercased basename to all relPaths sharing it', () => {
    const index = buildBasenameIndex(['src/auth.ts', 'app/auth.ts', 'src/utils.ts']);
    expect(index.get('auth.ts')).toHaveLength(2);
    expect(index.get('utils.ts')).toHaveLength(1);
  });

  it('returns empty map for empty input', () => {
    const index = buildBasenameIndex([]);
    expect(index.size).toBe(0);
  });

  it('handles paths with backslash separators', () => {
    const index = buildBasenameIndex(['src\\auth.ts']);
    // buildBasenameIndex normalises separators internally
    expect(index.get('auth.ts')).toBeDefined();
  });
});

describe('buildBodyMentions — unit tests', () => {
  const relPaths = ['src/auth.ts', 'src/utils.ts', 'app/details/cal/index.jsx'];
  const relPathSet = new Set(relPaths);
  const basenameIndex = buildBasenameIndex(relPaths);

  it('exact relPath mention in body resolves correctly', () => {
    const result = buildBodyMentions('Changed src/auth.ts to add login', relPathSet, basenameIndex);
    expect(result).toContain('src/auth.ts');
  });

  it('relative path with "./" prefix also resolves', () => {
    const result = buildBodyMentions('Edited ./src/auth.ts today', relPathSet, basenameIndex);
    expect(result).toContain('src/auth.ts');
  });

  it('deep path mention resolves via suffix match', () => {
    // "details/cal/index.jsx" is a suffix of "app/details/cal/index.jsx"
    const result = buildBodyMentions(
      'Fixed details/cal/index.jsx layout',
      relPathSet,
      basenameIndex,
    );
    expect(result).toContain('app/details/cal/index.jsx');
  });

  it('bare filename without slash is NOT resolved', () => {
    const result = buildBodyMentions('Updated auth.ts directly', relPathSet, basenameIndex);
    // "auth.ts" has no slash → should not resolve to src/auth.ts
    expect(result).not.toContain('src/auth.ts');
  });

  it('ambiguous suffix (matches multiple relPaths) is NOT attached', () => {
    // Both "src/auth.ts" and "app/auth.ts" share the same suffix "auth.ts"
    const ambiguousRelPaths = ['src/auth.ts', 'app/auth.ts'];
    const ambiguousSet = new Set(ambiguousRelPaths);
    const ambiguousIndex = buildBasenameIndex(ambiguousRelPaths);
    // "auth.ts" matches both → ambiguous → must not attach
    const result = buildBodyMentions('Refactored auth.ts logic', ambiguousSet, ambiguousIndex);
    expect(result).not.toContain('src/auth.ts');
    expect(result).not.toContain('app/auth.ts');
  });

  it('ambiguous full suffix (e.g. auth/login.ts matches two paths) is NOT attached', () => {
    const twoLoginPaths = ['frontend/auth/login.ts', 'backend/auth/login.ts'];
    const twoSet = new Set(twoLoginPaths);
    const twoIndex = buildBasenameIndex(twoLoginPaths);
    // "auth/login.ts" is a suffix of BOTH → ambiguous
    const result = buildBodyMentions('Modified auth/login.ts to fix issue', twoSet, twoIndex);
    expect(result).not.toContain('frontend/auth/login.ts');
    expect(result).not.toContain('backend/auth/login.ts');
  });

  it('multiple unambiguous paths in one body all resolve', () => {
    const result = buildBodyMentions(
      'Modified src/auth.ts and also src/utils.ts to fix the import chain',
      relPathSet,
      basenameIndex,
    );
    expect(result).toContain('src/auth.ts');
    expect(result).toContain('src/utils.ts');
  });

  it('returns empty array when body has no path-like tokens', () => {
    const result = buildBodyMentions(
      'Discussed the architecture of the system',
      relPathSet,
      basenameIndex,
    );
    expect(result).toHaveLength(0);
  });

  it('returns empty array when relPathSet is empty', () => {
    const result = buildBodyMentions('Modified src/auth.ts', new Set(), new Map());
    expect(result).toHaveLength(0);
  });

  it('deduplicates multiple mentions of the same path', () => {
    const result = buildBodyMentions(
      'src/auth.ts was touched, src/auth.ts updated again',
      relPathSet,
      basenameIndex,
    );
    expect(result.filter((p) => p === 'src/auth.ts')).toHaveLength(1);
  });
});

describe('buildConvNotesFromHtml — body-mention fusion (Issue 7)', () => {
  // Build a conv note with NO files-modified attr, only body text mentioning a file path.
  function makeConvNoteNoTraceAttrs(opts: {
    id: string;
    content: string;
  }): NoteFile {
    const html = [
      `<article id="${opts.id}"`,
      `  data-cerveau-type="episodic"`,
      `  data-cerveau-created="2026-05-29T10:00:00Z"`,
      '>',
      `<p>${opts.content}</p>`,
      '</article>',
    ].join('\n');
    return {
      path: `/fake/${opts.id}.html`,
      id: opts.id,
      html,
      sizeBytes: html.length,
      mtimeMs: Date.now(),
    };
  }

  const AUTH_NODE: CodeNode = {
    id: 'file:src/auth.ts',
    title: 'src/auth.ts',
    type: 'file',
    filePath: 'src/auth.ts',
    projectRoot: '/project',
    language: 'typescript',
    lineCount: 80,
    imports: [],
    exports: ['login'],
  };

  const UTILS_NODE: CodeNode = {
    id: 'file:src/utils.ts',
    title: 'src/utils.ts',
    type: 'file',
    filePath: 'src/utils.ts',
    projectRoot: '/project',
    language: 'typescript',
    lineCount: 40,
    imports: [],
    exports: ['hash'],
  };

  it('conv note with NO files-modified attr but body mentions one file → filesBodyMentions populated', () => {
    const convNote = makeConvNoteNoTraceAttrs({
      id: 'conv-body-mention-test',
      // deliberately uses a classifier keyword so it is not dropped
      content: 'decided to refactor src/auth.ts to use the new session interface',
    });

    const convNotes = buildConvNotesFromHtml([convNote], ['/project'], [AUTH_NODE, UTILS_NODE]);

    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesModified).toHaveLength(0);
    expect(convNotes[0].filesRead).toHaveLength(0);
    expect(convNotes[0].filesBodyMentions).toContain('src/auth.ts');
  });

  it('conv note with body mention of one file but no tool-trace attrs produces a ConvNote', () => {
    // The note mentions src/auth.ts in its body with a decision keyword
    const convNote = makeConvNoteNoTraceAttrs({
      id: 'conv-body-only',
      content: 'decided to use bcrypt in src/auth.ts for password hashing',
    });

    const convNotes = buildConvNotesFromHtml([convNote], ['/project'], [AUTH_NODE, UTILS_NODE]);

    // Before fix: would be [] because no files-modified/read → skipped immediately.
    // After fix: found via body mention → ConvNote produced.
    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].classifiedItems).toHaveLength(1);
    expect(convNotes[0].classifiedItems[0].kind).toBe('decision');
  });

  it('conv note mentioning an ambiguous basename does NOT produce a ConvNote for that file', () => {
    // Two nodes share basename "login.ts" → ambiguous → not attached
    const loginA: CodeNode = {
      id: 'file:frontend/login.ts',
      title: 'frontend/login.ts',
      type: 'file',
      filePath: 'frontend/login.ts',
      projectRoot: '/project',
      language: 'typescript',
      lineCount: 50,
      imports: [],
      exports: [],
    };
    const loginB: CodeNode = {
      id: 'file:backend/login.ts',
      title: 'backend/login.ts',
      type: 'file',
      filePath: 'backend/login.ts',
      projectRoot: '/project',
      language: 'typescript',
      lineCount: 60,
      imports: [],
      exports: [],
    };

    const convNote = makeConvNoteNoTraceAttrs({
      id: 'conv-ambiguous-basename',
      content: 'decided to refactor login.ts to use the new session flow with JWT',
    });

    const convNotes = buildConvNotesFromHtml([convNote], ['/project'], [loginA, loginB]);

    // "login.ts" is ambiguous (matches frontend/login.ts and backend/login.ts).
    // The note should be dropped (no evidence → no ConvNote).
    expect(convNotes).toHaveLength(0);
  });

  it('conv note with no tool-trace and no matching body paths is still dropped', () => {
    const convNote = makeConvNoteNoTraceAttrs({
      id: 'conv-no-evidence',
      content: 'discussed the general architecture without mentioning any specific file',
    });

    const convNotes = buildConvNotesFromHtml([convNote], ['/project'], [AUTH_NODE, UTILS_NODE]);

    expect(convNotes).toHaveLength(0);
  });

  it('body mention + no fileNodes provided → note is still dropped (no index to match against)', () => {
    // When fileNodes is not passed, body-mention matching is disabled.
    const convNote = makeConvNoteNoTraceAttrs({
      id: 'conv-no-filenodes',
      content: 'decided to use bcrypt in src/auth.ts for password hashing',
    });

    const convNotes = buildConvNotesFromHtml(
      [convNote],
      ['/project'],
      // No fileNodes argument → body-mention matching disabled
    );

    // No tool-trace attrs and no fileNodes → dropped.
    expect(convNotes).toHaveLength(0);
  });
});

describe('buildEvidenceFromTags — filesBodyMentions (Issue 7)', () => {
  it('filesBodyMentions paths get weight 0.85', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: [],
      filesRead: [],
      itemText: 'generic text without path',
      filesBodyMentions: ['src/auth.ts'],
    });
    const entry = evidence.find((e) => e.neuronId === 'file:src/auth.ts');
    expect(entry).toBeDefined();
    expect(entry!.weight).toBe(0.85);
  });

  it('filesModified weight (1.0) overrides filesBodyMentions (0.85) for the same file', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: ['src/auth.ts'],
      filesRead: [],
      itemText: 'some change',
      filesBodyMentions: ['src/auth.ts'],
    });
    const entries = evidence.filter((e) => e.neuronId === 'file:src/auth.ts');
    expect(entries).toHaveLength(1);
    expect(entries[0].weight).toBe(1.0);
  });

  it('empty filesBodyMentions produces no extra evidence entries', () => {
    const withEmpty = buildEvidenceFromTags({
      filesModified: [],
      filesRead: [],
      itemText: 'no paths here',
      filesBodyMentions: [],
    });
    const withUndefined = buildEvidenceFromTags({
      filesModified: [],
      filesRead: [],
      itemText: 'no paths here',
    });
    expect(withEmpty).toHaveLength(0);
    expect(withUndefined).toHaveLength(0);
  });
});

describe('Body-mention fusion — E2E: conv note without tool-trace enriches file-neuron (Issue 7)', () => {
  let tmpDir: string;
  const origBrainPath = process.env.LAZYBRAIN_BRAIN_PATH;
  const origCachePath = process.env.LAZYBRAIN_CACHE_PATH;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-body-mention-e2e-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.LAZYBRAIN_BRAIN_PATH = origBrainPath;
    process.env.LAZYBRAIN_CACHE_PATH = origCachePath;
    resetConfigForTests();
  });

  it('file-neuron gets decisions section from conv note that only mentions the file in its body', async () => {
    // This is the core regression test for Issue 7.
    // A conv note has NO data-cerveau-files-modified/read — only a body mention.
    const projectRoot = '/project';
    const fileNode: CodeNode = {
      id: 'file:src/auth.ts',
      title: 'src/auth.ts',
      type: 'file',
      filePath: 'src/auth.ts',
      projectRoot,
      language: 'typescript',
      lineCount: 80,
      imports: [],
      exports: ['login'],
    };

    // Build a conv note with NO tool-trace attributes — only body text
    const convNoteHtml = [
      '<article id="conv-body-e2e-test"',
      '  data-cerveau-type="episodic"',
      '  data-cerveau-created="2026-05-29T10:00:00Z"',
      '>',
      '<p>decided to use bcrypt in src/auth.ts for all password hashing operations</p>',
      '</article>',
    ].join('\n');

    const convNoteFile: NoteFile = {
      path: '/fake/conv-body-e2e-test.html',
      id: 'conv-body-e2e-test',
      html: convNoteHtml,
      sizeBytes: convNoteHtml.length,
      mtimeMs: Date.now(),
    };

    const convNotes = buildConvNotesFromHtml([convNoteFile], [projectRoot], [fileNode]);

    // Must produce one ConvNote with the body mention
    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].filesBodyMentions).toContain('src/auth.ts');

    const report = await runFileNeuronEnrichment({
      projectRoot,
      fileNodes: [fileNode],
      convNotes,
    });

    expect(report.fileNeuronsEnriched).toBeGreaterThanOrEqual(1);

    const notes = readAllNotes();
    const fileNeuronNote = notes.find(
      (n) => n.html.includes('data-cerveau-type="file-neuron"') && n.html.includes('src/auth.ts'),
    );
    expect(fileNeuronNote).toBeDefined();
    expect(fileNeuronNote!.html).toContain('data-section="decisions"');
    expect(fileNeuronNote!.html).toContain('decided to use bcrypt');
  });

  it('ambiguous basename in body does NOT produce spurious enrichment', async () => {
    // Two files share basename "login.ts". A conv note mentioning "login.ts" (no slash)
    // should NOT be attached to either file-neuron.
    const projectRoot = '/project';
    const loginA: CodeNode = {
      id: 'file:frontend/login.ts',
      title: 'frontend/login.ts',
      type: 'file',
      filePath: 'frontend/login.ts',
      projectRoot,
      language: 'typescript',
      lineCount: 50,
      imports: [],
      exports: [],
    };
    const loginB: CodeNode = {
      id: 'file:backend/login.ts',
      title: 'backend/login.ts',
      type: 'file',
      filePath: 'backend/login.ts',
      projectRoot,
      language: 'typescript',
      lineCount: 60,
      imports: [],
      exports: [],
    };

    const convNoteHtml = [
      '<article id="conv-ambiguous-e2e"',
      '  data-cerveau-type="episodic"',
      '  data-cerveau-created="2026-05-29T10:00:00Z"',
      '>',
      '<p>decided to refactor login.ts to use the JWT session flow for authentication</p>',
      '</article>',
    ].join('\n');

    const convNoteFile: NoteFile = {
      path: '/fake/conv-ambiguous-e2e.html',
      id: 'conv-ambiguous-e2e',
      html: convNoteHtml,
      sizeBytes: convNoteHtml.length,
      mtimeMs: Date.now(),
    };

    const convNotes = buildConvNotesFromHtml([convNoteFile], [projectRoot], [loginA, loginB]);

    // "login.ts" without a slash is NOT a valid path → no ConvNote produced.
    // Even if it were, "login.ts" would be ambiguous between the two files.
    expect(convNotes).toHaveLength(0);

    const report = await runFileNeuronEnrichment({
      projectRoot,
      fileNodes: [loginA, loginB],
      convNotes,
    });

    // No enrichment should have happened
    expect(report.fileNeuronsEnriched).toBe(0);
    expect(report.conceptNeuronsCreated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue 8: French accent-optional classification + sentence-split extension
// preservation (2026-07-04)
//
// Root cause of the reported conv->file-neuron attachment failure:
//   1. CLASSIFIERS 'decision'/'idea' patterns required the ACCENTED French
//      spelling ("décidé"/"idée"). A note saying "on a decide d'utiliser X"
//      (no accent — common with fast typing / non-French keyboards) matched
//      NO classifier and silently fell back to the generic 'activity' kind.
//   2. `plainText.split(/[.!\n]+/)` treated the '.' in a file extension
//      (e.g. "LocaleSwitcher.tsx") as a sentence terminator, so the
//      classified item's text was truncated to "LocaleSwitcher" — the
//      extension silently dropped from the displayed decision/bug text.
//
// Both are fixed in commands/enrich.ts: the CLASSIFIERS regexes are now
// accent-optional (`d[ée]cid[ée]e?s?`, `d[ée]cisions?`, `id[ée]e`,
// `am[ée]liorer`), and buildConvNotes now chunks text via the new exported
// splitIntoSentenceChunks(), which protects BODY_PATH_RE matches from being
// split on their own extension dot.
// ---------------------------------------------------------------------------

describe('splitIntoSentenceChunks — file-path extension protection (Issue 8)', () => {
  it('keeps a mid-sentence file path with its extension intact (not split at the dot)', () => {
    const text =
      "On a decide d'utiliser next-intl dans src/components/layout/LocaleSwitcher.tsx parce que c'est la solution native de Next.";
    const chunks = splitIntoSentenceChunks(text);
    const withPath = chunks.find((c) => c.includes('LocaleSwitcher'));
    expect(withPath).toBeDefined();
    expect(withPath).toContain('src/components/layout/LocaleSwitcher.tsx');
    // The extension must NOT have been split into its own orphan chunk.
    expect(chunks).not.toContain("tsx parce que c'est la solution native de Next");
  });

  it('still splits on a genuine sentence-ending period after the path', () => {
    const text = 'Fixed src/auth.ts today. Also updated the tests.';
    const chunks = splitIntoSentenceChunks(text)
      .map((c) => c.trim())
      .filter(Boolean);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('src/auth.ts');
    expect(chunks[1]).toMatch(/^Also updated the tests/);
  });

  it('preserves extension when the path is the very last token (no trailing text)', () => {
    const text = 'decided to use bcrypt for password hashing in src/auth.ts';
    const chunks = splitIntoSentenceChunks(text);
    expect(chunks.some((c) => c.includes('src/auth.ts'))).toBe(true);
    // Must not produce an orphan "ts" chunk from the split extension.
    expect(chunks.map((c) => c.trim())).not.toContain('ts');
  });

  it('handles multiple distinct path mentions in the same text, each restored correctly', () => {
    const text = 'Touched src/a.ts and also src/b.ts in the same commit.';
    const chunks = splitIntoSentenceChunks(text);
    const joined = chunks.join(' ');
    expect(joined).toContain('src/a.ts');
    expect(joined).toContain('src/b.ts');
  });

  it('returns the same result as a plain split when the text has no path-like tokens', () => {
    const text = 'This is a plain sentence with no file paths at all. Second sentence here.';
    expect(splitIntoSentenceChunks(text)).toEqual(text.split(/[.!\n]+/));
  });
});

describe('splitIntoSentenceChunks — dotted code-identifier protection', () => {
  it('keeps a method call intact: tree.delete()', () => {
    const text = 'We call tree.delete() to remove the stale node from the index.';
    const chunks = splitIntoSentenceChunks(text);
    const withCall = chunks.find((c) => c.includes('tree.delete()'));
    expect(withCall).toBeDefined();
    // Must not have been split into "tree" and an orphan "delete() ..." chunk.
    expect(chunks.map((c) => c.trim())).not.toContain('delete() to remove the stale node');
  });

  it('reproduces and fixes the exact reported regression: "no tree.delete() found"', () => {
    const text = 'Investigated the bug: no tree.delete() found in the trace.';
    const chunks = splitIntoSentenceChunks(text);
    expect(chunks.join(' ')).toContain('tree.delete()');
  });

  it('keeps a multi-segment property chain intact: a.b.c', () => {
    const text = 'The value lives at a.b.c and nowhere else.';
    const chunks = splitIntoSentenceChunks(text);
    expect(chunks.join(' ')).toContain('a.b.c');
  });

  it('keeps a PascalCase.member reference intact: Foo.bar', () => {
    const text = 'Call Foo.bar when the state changes.';
    const chunks = splitIntoSentenceChunks(text);
    expect(chunks.join(' ')).toContain('Foo.bar');
  });

  it('keeps a private field access intact: this.#priv', () => {
    const text = 'Reads this.#priv directly instead of the getter.';
    const chunks = splitIntoSentenceChunks(text);
    expect(chunks.join(' ')).toContain('this.#priv');
  });

  it('keeps an indexed-then-dotted access intact: arr[0].x', () => {
    const text = 'It reads arr[0].x before validating the shape.';
    const chunks = splitIntoSentenceChunks(text);
    expect(chunks.join(' ')).toContain('arr[0].x');
  });

  it('keeps a decimal number intact: 3.14', () => {
    const text = 'The constant is 3.14 in this module.';
    const chunks = splitIntoSentenceChunks(text);
    expect(chunks.join(' ')).toContain('3.14');
  });

  it('keeps a dotted version string intact: v0.1.17', () => {
    const text = 'We shipped v0.1.17 last night.';
    const chunks = splitIntoSentenceChunks(text);
    expect(chunks.join(' ')).toContain('v0.1.17');
  });

  it('does not swallow a genuine sentence boundary right after a call: obj.foo().', () => {
    const text = 'Now call obj.foo(). Then move on.';
    const chunks = splitIntoSentenceChunks(text)
      .map((c) => c.trim())
      .filter(Boolean);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('obj.foo()');
    expect(chunks[1]).toMatch(/^Then move on/);
  });

  it('still splits genuine prose sentences with no dotted identifiers', () => {
    const text = 'This is fine. It really is.';
    const chunks = splitIntoSentenceChunks(text)
      .map((c) => c.trim())
      .filter(Boolean);
    expect(chunks).toHaveLength(2);
  });

  it('leaves an ellipsis alone (no crash, no swallowed identifier)', () => {
    const text = 'Wait... that changes things.';
    expect(() => splitIntoSentenceChunks(text)).not.toThrow();
    const chunks = splitIntoSentenceChunks(text);
    expect(chunks.join(' ')).toContain('that changes things');
  });

  it('does not confuse a numbered-list period with a dotted identifier', () => {
    const text = '1. First item. 2. Second item.';
    const chunks = splitIntoSentenceChunks(text)
      .map((c) => c.trim())
      .filter(Boolean);
    // "1." and "2." must remain genuine sentence terminators, not fused
    // into a single "1. First item" chunk containing a swallowed period.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildConvNotesFromHtml — French accent-optional classifier (Issue 8)', () => {
  const LOCALE_NODE: CodeNode = {
    id: 'file:src/components/layout/LocaleSwitcher.tsx',
    title: 'src/components/layout/LocaleSwitcher.tsx',
    type: 'file',
    filePath: 'src/components/layout/LocaleSwitcher.tsx',
    projectRoot: '/lazysite-internet',
    language: 'typescript',
    lineCount: 73,
    imports: [],
    exports: ['LocaleSwitcher'],
  };

  function makeDecisionNote(id: string, content: string): NoteFile {
    const html = [
      `<article id="${id}"`,
      '  data-cerveau-type="episodic"',
      '  data-cerveau-created="2026-07-04T10:00:00Z"',
      '  data-cerveau-source="lazy-ide:assistant"',
      '>',
      `<p>${content}</p>`,
      '</article>',
    ].join('\n');
    return { path: `/fake/${id}.html`, id, html, sizeBytes: html.length, mtimeMs: Date.now() };
  }

  it('classifies an UNACCENTED "on a decide d\'utiliser" as a decision (not a keyword-less activity)', () => {
    const convNote = makeDecisionNote(
      'conv-fr-noaccent',
      "On a decide d'utiliser next-intl dans src/components/layout/LocaleSwitcher.tsx parce que c'est la solution native de Next.",
    );
    const convNotes = buildConvNotesFromHtml([convNote], ['/lazysite-internet'], [LOCALE_NODE]);

    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].classifiedItems).toHaveLength(1);
    expect(convNotes[0].classifiedItems[0].kind).toBe('decision');
    // The extension must survive in the classified item text.
    expect(convNotes[0].classifiedItems[0].text).toContain(
      'src/components/layout/LocaleSwitcher.tsx',
    );
  });

  it('classifies an ACCENTED "on a décidé d\'utiliser" as a decision (regression guard)', () => {
    const convNote = makeDecisionNote(
      'conv-fr-accent',
      "On a décidé d'utiliser next-intl dans src/components/layout/LocaleSwitcher.tsx parce que c'est la solution native de Next.",
    );
    const convNotes = buildConvNotesFromHtml([convNote], ['/lazysite-internet'], [LOCALE_NODE]);

    expect(convNotes).toHaveLength(1);
    expect(convNotes[0].classifiedItems).toHaveLength(1);
    expect(convNotes[0].classifiedItems[0].kind).toBe('decision');
    expect(convNotes[0].classifiedItems[0].text).toContain(
      'src/components/layout/LocaleSwitcher.tsx',
    );
  });

  it('classifies an UNACCENTED "idee" the same as accented "idée"', () => {
    const noAccent = makeDecisionNote(
      'conv-idea-noaccent',
      'Une bonne idee serait de refactoriser src/components/layout/LocaleSwitcher.tsx pour simplifier la logique.',
    );
    const accent = makeDecisionNote(
      'conv-idea-accent',
      'Une bonne idée serait de refactoriser src/components/layout/LocaleSwitcher.tsx pour simplifier la logique.',
    );
    const notesNoAccent = buildConvNotesFromHtml([noAccent], ['/lazysite-internet'], [LOCALE_NODE]);
    const notesAccent = buildConvNotesFromHtml([accent], ['/lazysite-internet'], [LOCALE_NODE]);

    expect(notesNoAccent[0].classifiedItems[0].kind).toBe('idea');
    expect(notesAccent[0].classifiedItems[0].kind).toBe('idea');
  });

  it('end-to-end: unaccented French decision attaches to the decisions section, not activity', async () => {
    const brainPath = mkdtempSync(join(tmpdir(), 'lazybrain-fr-classifier-e2e-'));
    const origBrainPath = process.env.LAZYBRAIN_BRAIN_PATH;
    const origCachePath = process.env.LAZYBRAIN_CACHE_PATH;
    process.env.LAZYBRAIN_BRAIN_PATH = join(brainPath, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(brainPath, '.lazybrain', '_cache');
    resetConfigForTests();

    try {
      await runInit({ path: join(brainPath, '.lazybrain', 'brain') });

      const convNote = makeDecisionNote(
        'conv-fr-e2e',
        "On a decide d'utiliser next-intl dans src/components/layout/LocaleSwitcher.tsx parce que c'est la solution native de Next.",
      );
      const convNotes = buildConvNotesFromHtml([convNote], ['/lazysite-internet'], [LOCALE_NODE]);
      expect(convNotes[0].classifiedItems[0].kind).toBe('decision');

      const report = await runFileNeuronEnrichment({
        projectRoot: '/lazysite-internet',
        fileNodes: [LOCALE_NODE],
        convNotes,
      });
      expect(report.fileNeuronsEnriched).toBeGreaterThanOrEqual(1);

      const notes = readAllNotes();
      const fileNeuronNote = notes.find(
        (n) =>
          n.html.includes('data-cerveau-type="file-neuron"') &&
          n.html.includes('LocaleSwitcher.tsx'),
      );
      expect(fileNeuronNote).toBeDefined();
      expect(fileNeuronNote!.html).toContain('data-section="decisions"');
      expect(fileNeuronNote!.html).not.toContain('data-section="activity"');
      expect(fileNeuronNote!.html).toContain('src/components/layout/LocaleSwitcher.tsx');
    } finally {
      closeDb();
      rmSync(brainPath, { recursive: true, force: true });
      process.env.LAZYBRAIN_BRAIN_PATH = origBrainPath;
      process.env.LAZYBRAIN_CACHE_PATH = origCachePath;
      resetConfigForTests();
    }
  });
});
