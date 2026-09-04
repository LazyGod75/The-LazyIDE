/**
 * TDD tests for Task 3: AGGREGATE neuron composer + scanner builder.
 *
 * Covers:
 * 3.1 — composeAggregateNeuron produces valid, structured HTML
 * 3.2 — buildAggregateNeurons groups file nodes into module + project aggregates
 * 3.3 — file-neuron generation still works unchanged after adding aggregates
 */

import { describe, expect, it } from 'vitest';
import { composeAggregateNeuron } from '../src/annotator/blocks/composers/aggregate-neuron.js';
import type { AggregateNeuronDescriptor } from '../src/annotator/blocks/composers/aggregate-neuron.js';
import { buildAggregateNeurons, codeNodesToNotes } from '../src/graph/code-scanner.js';
import type { CodeNode, CodeScanResult } from '../src/graph/code-scanner.js';
import { validateNote } from '../src/schema/validator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODULE_DESC: AggregateNeuronDescriptor = {
  id: 'module:src/auth',
  kind: 'module',
  title: 'src/auth',
  path: 'src/auth',
  projectName: 'myproject',
  children: [
    { id: 'file:src/auth/login.ts', title: 'login.ts', kind: 'file' },
    { id: 'file:src/auth/logout.ts', title: 'logout.ts', kind: 'file' },
  ],
  stats: {
    fileCount: 2,
    totalLines: 150,
    languages: ['typescript'],
  },
};

const PROJECT_DESC: AggregateNeuronDescriptor = {
  id: 'project:myproject',
  kind: 'project',
  title: 'myproject',
  path: '',
  projectName: 'myproject',
  children: [
    { id: 'module:src/auth', title: 'auth', kind: 'module' },
    { id: 'module:src/utils', title: 'utils', kind: 'module' },
    { id: 'file:src/index.ts', title: 'index.ts', kind: 'file' },
  ],
  stats: {
    fileCount: 5,
    totalLines: 400,
    languages: ['typescript', 'javascript'],
  },
  subModules: [
    { id: 'module:src/auth', title: 'auth' },
    { id: 'module:src/utils', title: 'utils' },
  ],
};

// ---------------------------------------------------------------------------
// 3.1 — composeAggregateNeuron basic structure
// ---------------------------------------------------------------------------

describe('composeAggregateNeuron — basic structure (3.1)', () => {
  it('returns a string containing data-cerveau-type="aggregate-neuron"', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('data-cerveau-type="aggregate-neuron"');
  });

  it('contains data-cerveau-version="0.2.0"', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('data-cerveau-version="0.2.0"');
  });

  it('contains data-code-project attribute', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('data-code-project=');
  });

  it('article tag starts the output and closes with </article>', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('<article');
    expect(html.trim()).toMatch(/<\/article>\s*$/);
  });

  it('contains a breadcrumb nav', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('class="breadcrumb"');
  });

  it('breadcrumb includes project name', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('myproject');
  });

  it('breadcrumb for nested module includes path segment', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('src');
  });

  it('contains an infobox with kind', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('class="infobox"');
    expect(html).toContain('module');
  });

  it('infobox shows fileCount', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('2');
  });

  it('infobox shows totalLines', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('150');
  });

  it('infobox shows languages', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('typescript');
  });

  it('contains a tldr section', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('data-section="tldr"');
  });

  it('tldr for module includes directory name and file count', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('data-section="tldr"');
    const tldrMatch = html.match(/<section data-section="tldr">([\s\S]*?)<\/section>/);
    expect(tldrMatch).not.toBeNull();
    expect(tldrMatch![1]).toContain('2');
  });

  it('tldr for project includes project name and stats', () => {
    const html = composeAggregateNeuron(PROJECT_DESC);
    const tldrMatch = html.match(/<section data-section="tldr">([\s\S]*?)<\/section>/);
    expect(tldrMatch).not.toBeNull();
    expect(tldrMatch![1]).toContain('myproject');
  });

  it('contains a children section with links to child neurons', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('data-section="children"');
  });

  it('children section links to file child ids', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('file:src/auth/login.ts');
    expect(html).toContain('file:src/auth/logout.ts');
  });

  it('children section renders one link per child', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    // Two children → two anchors
    const matches = html.match(/href="#\/file:src\/auth\//g);
    expect(matches).toHaveLength(2);
  });

  it('project: children section links to module child ids', () => {
    const html = composeAggregateNeuron(PROJECT_DESC);
    expect(html).toContain('module:src/auth');
    expect(html).toContain('module:src/utils');
  });

  it('contains a data-cerveau-topic matching the path', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    expect(html).toContain('data-cerveau-topic=');
  });
});

// ---------------------------------------------------------------------------
// 3.1 — see-also section (conditional)
// ---------------------------------------------------------------------------

describe('composeAggregateNeuron — see-also (3.1)', () => {
  it('renders see-also when seeAlso links are provided', () => {
    const descWithSeeAlso: AggregateNeuronDescriptor = {
      ...MODULE_DESC,
      seeAlso: [{ id: 'module:src/utils', title: 'utils' }],
    };
    const html = composeAggregateNeuron(descWithSeeAlso);
    expect(html).toContain('data-section="see-also"');
    expect(html).toContain('module:src/utils');
  });

  it('omits see-also when no seeAlso links', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    // MODULE_DESC has no seeAlso
    expect(html).not.toContain('data-section="see-also"');
  });
});

// ---------------------------------------------------------------------------
// 3.1 — validates against schema
// ---------------------------------------------------------------------------

describe('composeAggregateNeuron — schema validation (3.1)', () => {
  it('module aggregate passes validateNote without errors', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    const result = validateNote(html);
    const errors = result.issues.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  it('project aggregate passes validateNote without errors', () => {
    const html = composeAggregateNeuron(PROJECT_DESC);
    const result = validateNote(html);
    const errors = result.issues.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  it('does not emit INVALID_TYPE warning', () => {
    const html = composeAggregateNeuron(MODULE_DESC);
    const result = validateNote(html);
    const invalidType = result.issues.find((i) => i.code === 'INVALID_TYPE');
    expect(invalidType).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helpers for scanner tests
// ---------------------------------------------------------------------------

function makeNode(filePath: string, overrides: Partial<CodeNode> = {}): CodeNode {
  return {
    id: `file:${filePath}`,
    title: filePath,
    type: 'file',
    filePath,
    projectRoot: '/project',
    language: 'typescript',
    lineCount: 50,
    imports: [],
    exports: ['foo'],
    ...overrides,
  };
}

function makeResult(nodes: CodeNode[], projectRoot = '/project'): CodeScanResult {
  return {
    projectRoot,
    projectName: 'myproject',
    nodes,
    edges: [],
    stats: {
      files: nodes.length,
      modules: nodes.length,
      languages: { typescript: nodes.length },
    },
  };
}

// ---------------------------------------------------------------------------
// 3.2 — buildAggregateNeurons: correct count and shape
// ---------------------------------------------------------------------------

describe('buildAggregateNeurons — structure (3.2)', () => {
  it('returns an empty array for an empty project', () => {
    const result = makeResult([]);
    const aggregates = buildAggregateNeurons(result);
    expect(aggregates).toHaveLength(0);
  });

  it('flat project: returns one project aggregate and one module per directory', () => {
    // Files: src/a.ts, src/b.ts (same dir) → one module:src + one project root
    const result = makeResult([makeNode('src/a.ts'), makeNode('src/b.ts')]);
    const aggregates = buildAggregateNeurons(result);
    // Must have at least project + src module
    expect(aggregates.length).toBeGreaterThanOrEqual(2);
  });

  it('nested dirs: yields one module per non-empty directory', () => {
    // src/a/x.ts, src/a/y.ts, src/b/z.ts → modules: src/a, src/b, src (parent), project
    const result = makeResult([
      makeNode('src/a/x.ts'),
      makeNode('src/a/y.ts'),
      makeNode('src/b/z.ts'),
    ]);
    const aggregates = buildAggregateNeurons(result);
    const ids = aggregates.map((h) => h.id);
    expect(ids).toContain('module:src/a');
    expect(ids).toContain('module:src/b');
  });

  it('nested dirs: project aggregate is present', () => {
    const result = makeResult([makeNode('src/a/x.ts'), makeNode('src/b/z.ts')]);
    const aggregates = buildAggregateNeurons(result);
    const projectAgg = aggregates.find((h) => h.kind === 'project');
    expect(projectAgg).toBeDefined();
  });

  it('module aggregate has correct fileCount', () => {
    const result = makeResult([makeNode('src/a.ts'), makeNode('src/b.ts')]);
    const aggregates = buildAggregateNeurons(result);
    const srcModule = aggregates.find((h) => h.id === 'module:src');
    expect(srcModule).toBeDefined();
    expect(srcModule!.stats.fileCount).toBe(2);
  });

  it('module aggregate has correct totalLines', () => {
    const result = makeResult([
      makeNode('src/a.ts', { lineCount: 30 }),
      makeNode('src/b.ts', { lineCount: 70 }),
    ]);
    const aggregates = buildAggregateNeurons(result);
    const srcModule = aggregates.find((h) => h.id === 'module:src');
    expect(srcModule!.stats.totalLines).toBe(100);
  });

  it('module aggregate lists distinct languages', () => {
    const result = makeResult([
      makeNode('src/a.ts', { language: 'typescript' }),
      makeNode('src/b.js', { language: 'javascript' }),
    ]);
    const aggregates = buildAggregateNeurons(result);
    const srcModule = aggregates.find((h) => h.id === 'module:src');
    expect(srcModule!.stats.languages).toContain('typescript');
    expect(srcModule!.stats.languages).toContain('javascript');
  });

  it('module children include file-neuron ids for that directory', () => {
    const result = makeResult([makeNode('src/a.ts'), makeNode('src/b.ts')]);
    const aggregates = buildAggregateNeurons(result);
    const srcModule = aggregates.find((h) => h.id === 'module:src');
    const childIds = srcModule!.children.map((c) => c.id);
    expect(childIds).toContain('file:src/a.ts');
    expect(childIds).toContain('file:src/b.ts');
  });

  it('project aggregate children include direct sub-module ids', () => {
    const result = makeResult([makeNode('src/a.ts'), makeNode('lib/b.ts')]);
    const aggregates = buildAggregateNeurons(result);
    const projectAgg = aggregates.find((h) => h.kind === 'project');
    expect(projectAgg).toBeDefined();
    const childIds = projectAgg!.children.map((c) => c.id);
    // src and lib should be children of the project
    expect(childIds.some((id) => id.includes('src') || id.includes('lib'))).toBe(true);
  });

  it('root-level files are children of the project aggregate', () => {
    const result = makeResult([makeNode('index.ts'), makeNode('src/a.ts')]);
    const aggregates = buildAggregateNeurons(result);
    const projectAgg = aggregates.find((h) => h.kind === 'project');
    expect(projectAgg).toBeDefined();
    const childIds = projectAgg!.children.map((c) => c.id);
    expect(childIds).toContain('file:index.ts');
  });
});

// ---------------------------------------------------------------------------
// 3.2 — project: and module: id prefix assertions
// ---------------------------------------------------------------------------

describe('buildAggregateNeurons — id prefixes (3.2)', () => {
  it('project aggregate id starts with "project:"', () => {
    const result = makeResult([makeNode('src/a.ts'), makeNode('src/b.ts')]);
    const aggregates = buildAggregateNeurons(result);
    const projectAgg = aggregates.find((h) => h.kind === 'project');
    expect(projectAgg).toBeDefined();
    expect(projectAgg!.id).toMatch(/^project:/);
  });

  it('module aggregate id starts with "module:"', () => {
    const result = makeResult([makeNode('src/a.ts'), makeNode('src/b.ts')]);
    const aggregates = buildAggregateNeurons(result);
    const moduleAgg = aggregates.find((h) => h.kind === 'module');
    expect(moduleAgg).toBeDefined();
    expect(moduleAgg!.id).toMatch(/^module:/);
  });

  it('project aggregate id uses project name, not "module:root"', () => {
    const result = makeResult([makeNode('src/a.ts')]);
    const aggregates = buildAggregateNeurons(result);
    const projectAgg = aggregates.find((h) => h.kind === 'project');
    expect(projectAgg).toBeDefined();
    expect(projectAgg!.id).toBe('project:myproject');
    expect(projectAgg!.id).not.toBe('module:root');
  });
});

// ---------------------------------------------------------------------------
// 3.2 — buildAggregateNeurons returns HTML strings
// ---------------------------------------------------------------------------

describe('buildAggregateNeurons — HTML output (3.2)', () => {
  it('returns HTML strings each containing data-cerveau-type="aggregate-neuron"', () => {
    const result = makeResult([makeNode('src/a.ts'), makeNode('src/b.ts')]);
    const htmlList = buildAggregateNeurons(result).map((desc) => composeAggregateNeuron(desc));
    for (const html of htmlList) {
      expect(html).toContain('data-cerveau-type="aggregate-neuron"');
    }
  });

  it('each aggregate HTML passes validateNote without errors', () => {
    const result = makeResult([makeNode('src/a.ts'), makeNode('src/b.ts')]);
    const htmlList = buildAggregateNeurons(result).map((desc) => composeAggregateNeuron(desc));
    for (const html of htmlList) {
      const validation = validateNote(html);
      const errors = validation.issues.filter((i) => i.level === 'error');
      expect(errors).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3.3 — file-neuron generation unchanged
// ---------------------------------------------------------------------------

describe('codeNodesToNotes still works (3.3)', () => {
  it('file-neurons still produced after adding buildAggregateNeurons', () => {
    const result = makeResult([makeNode('src/a.ts'), makeNode('src/b.ts')]);
    const notes = codeNodesToNotes(result);
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note).toContain('data-cerveau-type="file-neuron"');
    }
  });

  it('aggregate neurons are NOT returned by codeNodesToNotes', () => {
    const result = makeResult([makeNode('src/a.ts')]);
    const notes = codeNodesToNotes(result);
    for (const note of notes) {
      expect(note).not.toContain('data-cerveau-type="aggregate-neuron"');
    }
  });
});

// ---------------------------------------------------------------------------
// 3.4 — production wiring: both file-neurons AND aggregate-neurons are produced
// ---------------------------------------------------------------------------

describe('production wiring: file-neurons + aggregate-neurons from same scan result (3.4)', () => {
  it('codeNodesToNotes produces file-neuron HTML for every file node', () => {
    const nodes = [
      makeNode('src/auth/login.ts'),
      makeNode('src/auth/logout.ts'),
      makeNode('src/index.ts'),
    ];
    const result = makeResult(nodes);
    const fileNotes = codeNodesToNotes(result);
    expect(fileNotes).toHaveLength(3);
    for (const note of fileNotes) {
      expect(note).toContain('data-cerveau-type="file-neuron"');
    }
  });

  it('buildAggregateNeurons produces aggregate-neuron descriptors for same result', () => {
    const nodes = [
      makeNode('src/auth/login.ts'),
      makeNode('src/auth/logout.ts'),
      makeNode('src/index.ts'),
    ];
    const result = makeResult(nodes);
    const descriptors = buildAggregateNeurons(result);
    expect(descriptors.length).toBeGreaterThan(0);
  });

  it('composeAggregateNeuron on each descriptor yields aggregate-neuron HTML', () => {
    const nodes = [
      makeNode('src/auth/login.ts'),
      makeNode('src/auth/logout.ts'),
      makeNode('src/index.ts'),
    ];
    const result = makeResult(nodes);
    const descriptors = buildAggregateNeurons(result);
    for (const descriptor of descriptors) {
      const html = composeAggregateNeuron(descriptor);
      expect(html).toContain('data-cerveau-type="aggregate-neuron"');
    }
  });

  it('file-neurons and aggregate-neurons have distinct HTML types from the same scan result', () => {
    const nodes = [makeNode('src/a.ts'), makeNode('src/b.ts')];
    const result = makeResult(nodes);
    const fileNotes = codeNodesToNotes(result);
    const aggregateHtmlList = buildAggregateNeurons(result).map((d) => composeAggregateNeuron(d));
    // Every file note is file-neuron type
    for (const note of fileNotes) {
      expect(note).toContain('data-cerveau-type="file-neuron"');
      expect(note).not.toContain('data-cerveau-type="aggregate-neuron"');
    }
    // Every aggregate is aggregate-neuron type
    for (const html of aggregateHtmlList) {
      expect(html).toContain('data-cerveau-type="aggregate-neuron"');
      expect(html).not.toContain('data-cerveau-type="file-neuron"');
    }
  });

  it('total notes from wiring path = file count + aggregate count (both written)', () => {
    const nodes = [makeNode('src/a.ts'), makeNode('lib/b.ts')];
    const result = makeResult(nodes);
    const fileNotes = codeNodesToNotes(result);
    const aggregates = buildAggregateNeurons(result);
    const aggregateHtmlList = aggregates.map((d) => composeAggregateNeuron(d));
    // 2 files + at least 3 aggregates (src, lib, project root)
    expect(fileNotes.length).toBe(2);
    expect(aggregateHtmlList.length).toBeGreaterThanOrEqual(3);
    // All validate without errors
    for (const html of [...fileNotes, ...aggregateHtmlList]) {
      const validation = validateNote(html);
      const errors = validation.issues.filter((i) => i.level === 'error');
      expect(errors).toHaveLength(0);
    }
  });
});
