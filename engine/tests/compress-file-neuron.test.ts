/**
 * Tests for compressFileNeuron (Task 6.2):
 *   - Output contains signatures (names + params + lines) and NOT function bodies
 *   - skeletonOnly is strictly shorter and omits params
 *   - Deterministic output
 *
 * Also tests the shared file-neuron-parse module (Task 6.1):
 *   - parseFileNeuronHtml round-trips correctly
 */

import { describe, expect, it } from 'vitest';
import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import {
  parseAstClassesFromHtml,
  parseAstFunctionsFromHtml,
  parseExportsFromHtml,
  parseFileNeuronHtml,
  parseImportsFromHtml,
} from '../src/graph/file-neuron-parse.js';
import { compressFileNeuron } from '../src/retrieval/compress-file-neuron.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_NODE: CodeNode = {
  id: 'file:src/api/router.ts',
  title: 'src/api/router.ts',
  type: 'file',
  filePath: 'src/api/router.ts',
  projectRoot: '/project',
  language: 'typescript',
  lineCount: 250,
  imports: ['express', './middleware', './handlers'],
  exports: ['createRouter', 'RouterConfig'],
  astFunctions: [
    {
      name: 'createRouter',
      startLine: 12,
      endLine: 45,
      params: ['config', 'middlewares'],
      isExported: true,
    },
    {
      name: 'applyMiddleware',
      startLine: 50,
      endLine: 80,
      params: ['app', 'middleware'],
      isExported: false,
    },
    {
      name: 'handleError',
      startLine: 85,
      endLine: 100,
      params: ['err', 'req', 'res'],
      isExported: false,
    },
  ],
  astClasses: [
    {
      name: 'RouterConfig',
      methods: ['validate', 'toJson'],
      isExported: true,
      extends: 'BaseConfig',
    },
    { name: 'RouteCache', methods: ['get', 'set', 'clear'], isExported: false },
  ],
};

const MINIMAL_NODE: CodeNode = {
  id: 'file:src/index.ts',
  title: 'src/index.ts',
  type: 'file',
  filePath: 'src/index.ts',
  projectRoot: '/project',
  language: 'typescript',
  lineCount: 20,
  imports: ['./app'],
  exports: ['main'],
};

// ---------------------------------------------------------------------------
// compressFileNeuron — default mode
// ---------------------------------------------------------------------------

describe('compressFileNeuron — default mode', () => {
  it('includes file path in header', () => {
    const out = compressFileNeuron(FULL_NODE);
    expect(out).toContain('src/api/router.ts');
  });

  it('includes line count and language in header', () => {
    const out = compressFileNeuron(FULL_NODE);
    expect(out).toContain('250L');
    expect(out).toContain('typescript');
  });

  it('includes imports', () => {
    const out = compressFileNeuron(FULL_NODE);
    expect(out).toContain('express');
    expect(out).toContain('./middleware');
    expect(out).toContain('./handlers');
  });

  it('includes exports', () => {
    const out = compressFileNeuron(FULL_NODE);
    expect(out).toContain('createRouter');
    expect(out).toContain('RouterConfig');
  });

  it('includes function names and params', () => {
    const out = compressFileNeuron(FULL_NODE);
    expect(out).toContain('createRouter');
    expect(out).toContain('config');
    expect(out).toContain('middlewares');
    expect(out).toContain('applyMiddleware');
    expect(out).toContain('handleError');
  });

  it('includes function startLine references', () => {
    const out = compressFileNeuron(FULL_NODE);
    expect(out).toContain(':12');
    expect(out).toContain(':50');
    expect(out).toContain(':85');
  });

  it('includes class names and methods', () => {
    const out = compressFileNeuron(FULL_NODE);
    expect(out).toContain('RouterConfig');
    expect(out).toContain('validate');
    expect(out).toContain('toJson');
    expect(out).toContain('RouteCache');
    expect(out).toContain('get');
    expect(out).toContain('set');
  });

  it('includes class extends info', () => {
    const out = compressFileNeuron(FULL_NODE);
    expect(out).toContain('extends BaseConfig');
  });

  it('does NOT contain function body text', () => {
    // Realistic body text that would appear if we included bodies
    const out = compressFileNeuron(FULL_NODE);
    expect(out).not.toContain('const router = express.Router()');
    expect(out).not.toContain('return router');
    expect(out).not.toContain('try {');
    expect(out).not.toContain('catch (');
  });

  it('is deterministic (same input → same output)', () => {
    const out1 = compressFileNeuron(FULL_NODE);
    const out2 = compressFileNeuron(FULL_NODE);
    expect(out1).toBe(out2);
  });

  it('handles node with no AST (minimal node)', () => {
    const out = compressFileNeuron(MINIMAL_NODE);
    expect(out).toContain('src/index.ts');
    expect(out).toContain('main');
    expect(out).not.toContain('functions:');
    expect(out).not.toContain('classes:');
  });
});

// ---------------------------------------------------------------------------
// compressFileNeuron — skeletonOnly mode
// ---------------------------------------------------------------------------

describe('compressFileNeuron — skeletonOnly mode', () => {
  it('skeletonOnly output is strictly shorter than default', () => {
    const full = compressFileNeuron(FULL_NODE);
    const skeleton = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    expect(skeleton.length).toBeLessThan(full.length);
  });

  it('skeletonOnly omits function params', () => {
    const skeleton = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    // params: 'config', 'middlewares' should not appear
    expect(skeleton).not.toContain('config');
    expect(skeleton).not.toContain('middlewares');
  });

  it('skeletonOnly omits imports', () => {
    const skeleton = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    expect(skeleton).not.toContain('express');
    expect(skeleton).not.toContain('./middleware');
  });

  it('skeletonOnly omits startLine references', () => {
    const skeleton = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    expect(skeleton).not.toContain(':12');
    expect(skeleton).not.toContain(':50');
  });

  it('skeletonOnly still includes function names', () => {
    const skeleton = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    expect(skeleton).toContain('createRouter');
    expect(skeleton).toContain('applyMiddleware');
    expect(skeleton).toContain('handleError');
  });

  it('skeletonOnly still includes class names', () => {
    const skeleton = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    expect(skeleton).toContain('RouterConfig');
    expect(skeleton).toContain('RouteCache');
  });

  it('skeletonOnly still includes exports', () => {
    const skeleton = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    expect(skeleton).toContain('createRouter');
    expect(skeleton).toContain('RouterConfig');
  });

  it('skeletonOnly is deterministic', () => {
    const s1 = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    const s2 = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    expect(s1).toBe(s2);
  });

  it('skeletonOnly includes file header', () => {
    const skeleton = compressFileNeuron(FULL_NODE, { skeletonOnly: true });
    expect(skeleton).toContain('src/api/router.ts');
    expect(skeleton).toContain('250L');
  });
});

// ---------------------------------------------------------------------------
// parseFileNeuronHtml (Task 6.1) — shared module
// ---------------------------------------------------------------------------

describe('parseFileNeuronHtml — shared file-neuron-parse module', () => {
  it('returns null for non-file-neuron HTML', () => {
    const result = parseFileNeuronHtml(
      '<article data-cerveau-type="decision"><p>text</p></article>',
    );
    expect(result).toBeNull();
  });

  it('returns null for HTML missing data-code-file', () => {
    const html =
      '<article data-cerveau-type="file-neuron" data-cerveau-source="code-scanner:/root"><p>x</p></article>';
    expect(parseFileNeuronHtml(html)).toBeNull();
  });

  it('round-trips through composeFileNeuron', () => {
    const node: CodeNode = {
      id: 'file:src/auth.ts',
      title: 'src/auth.ts',
      type: 'file',
      filePath: 'src/auth.ts',
      projectRoot: '/project',
      language: 'typescript',
      lineCount: 80,
      imports: ['./session'],
      exports: ['login', 'logout'],
      astFunctions: [
        {
          name: 'login',
          startLine: 5,
          endLine: 20,
          params: ['email', 'password'],
          isExported: true,
        },
      ],
    };

    const html = composeFileNeuron(node, 0);
    const parsed = parseFileNeuronHtml(html);

    expect(parsed).not.toBeNull();
    expect(parsed!.filePath).toBe('src/auth.ts');
    expect(parsed!.language).toBe('typescript');
    expect(parsed!.lineCount).toBe(80);
    expect(parsed!.imports).toContain('./session');
    expect(parsed!.exports).toContain('login');
    expect(parsed!.exports).toContain('logout');
    expect(parsed!.astFunctions).toBeDefined();
    expect(parsed!.astFunctions!.map((f) => f.name)).toContain('login');
    expect(parsed!.astFunctions!.find((f) => f.name === 'login')!.params).toContain('email');
  });

  it('parseImportsFromHtml extracts imports from architecture section', () => {
    const node: CodeNode = {
      id: 'file:x.ts',
      title: 'x.ts',
      type: 'file',
      filePath: 'x.ts',
      projectRoot: '/p',
      language: 'typescript',
      lineCount: 10,
      imports: ['./a', './b'],
      exports: [],
    };
    const html = composeFileNeuron(node, 0);
    const imports = parseImportsFromHtml(html);
    expect(imports).toContain('./a');
    expect(imports).toContain('./b');
  });

  it('parseExportsFromHtml extracts exports from architecture section', () => {
    const node: CodeNode = {
      id: 'file:x.ts',
      title: 'x.ts',
      type: 'file',
      filePath: 'x.ts',
      projectRoot: '/p',
      language: 'typescript',
      lineCount: 10,
      imports: [],
      exports: ['Alpha', 'Beta'],
    };
    const html = composeFileNeuron(node, 0);
    const exports = parseExportsFromHtml(html);
    expect(exports).toContain('Alpha');
    expect(exports).toContain('Beta');
  });

  it('parseAstFunctionsFromHtml extracts functions with params', () => {
    const node: CodeNode = {
      id: 'file:x.ts',
      title: 'x.ts',
      type: 'file',
      filePath: 'x.ts',
      projectRoot: '/p',
      language: 'typescript',
      lineCount: 50,
      imports: [],
      exports: ['run'],
      astFunctions: [
        { name: 'run', startLine: 1, endLine: 10, params: ['x', 'y'], isExported: true },
      ],
    };
    const html = composeFileNeuron(node, 0);
    const fns = parseAstFunctionsFromHtml(html);
    expect(fns.map((f) => f.name)).toContain('run');
    const fn = fns.find((f) => f.name === 'run');
    expect(fn!.params).toContain('x');
    expect(fn!.params).toContain('y');
  });

  it('parseAstClassesFromHtml extracts classes with methods', () => {
    const node: CodeNode = {
      id: 'file:x.ts',
      title: 'x.ts',
      type: 'file',
      filePath: 'x.ts',
      projectRoot: '/p',
      language: 'typescript',
      lineCount: 50,
      imports: [],
      exports: ['MyClass'],
      astClasses: [{ name: 'MyClass', methods: ['alpha', 'beta'], isExported: true }],
    };
    const html = composeFileNeuron(node, 0);
    const classes = parseAstClassesFromHtml(html);
    expect(classes.map((c) => c.name)).toContain('MyClass');
    const cls = classes.find((c) => c.name === 'MyClass');
    expect(cls!.methods).toContain('alpha');
    expect(cls!.methods).toContain('beta');
  });
});
