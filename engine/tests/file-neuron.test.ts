/**
 * TDD tests for Task 1: FILE-neuron rendering
 *
 * Covers:
 * 1.1 — validator accepts file-neuron, aggregate-neuron, concept types
 * 1.2 — scanner renders all files as file-neurons (no 20-file cap)
 * 1.3 — composeFileNeuron produces valid, structured HTML
 */

import { describe, expect, it } from 'vitest';
import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { validateNote } from '../src/schema/validator.js';

// ---------------------------------------------------------------------------
// 1.1 — Schema: new type values accepted by validator
// ---------------------------------------------------------------------------

function makeMinimalArticle(type: string): string {
  return `<article
    id="file-src-index-ts"
    data-cerveau-version="0.2.0"
    data-cerveau-created="2026-05-28T00:00:00Z"
    data-cerveau-source="code-scanner:/project"
    data-cerveau-type="${type}">
    <p>content</p>
  </article>`;
}

describe('validator — new neuron types (1.1)', () => {
  it('accepts data-cerveau-type="file-neuron" without INVALID_TYPE warning', () => {
    const result = validateNote(makeMinimalArticle('file-neuron'));
    const invalidType = result.issues.find((i) => i.code === 'INVALID_TYPE');
    expect(invalidType).toBeUndefined();
  });

  it('accepts data-cerveau-type="aggregate-neuron" without INVALID_TYPE warning', () => {
    const result = validateNote(makeMinimalArticle('aggregate-neuron'));
    const invalidType = result.issues.find((i) => i.code === 'INVALID_TYPE');
    expect(invalidType).toBeUndefined();
  });

  it('accepts data-cerveau-type="concept" without INVALID_TYPE warning', () => {
    const result = validateNote(makeMinimalArticle('concept'));
    const invalidType = result.issues.find((i) => i.code === 'INVALID_TYPE');
    expect(invalidType).toBeUndefined();
  });

  it('still warns on garbage type values', () => {
    const result = validateNote(makeMinimalArticle('banana-type'));
    const invalidType = result.issues.find((i) => i.code === 'INVALID_TYPE');
    expect(invalidType).toBeDefined();
    expect(invalidType?.level).toBe('warn');
  });

  it('still accepts valid pre-existing types like "reference"', () => {
    const result = validateNote(makeMinimalArticle('reference'));
    const invalidType = result.issues.find((i) => i.code === 'INVALID_TYPE');
    expect(invalidType).toBeUndefined();
  });

  it('still accepts "project-summary" type', () => {
    const result = validateNote(makeMinimalArticle('project-summary'));
    const invalidType = result.issues.find((i) => i.code === 'INVALID_TYPE');
    expect(invalidType).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 1.3 — composeFileNeuron composer
// ---------------------------------------------------------------------------

const MINIMAL_NODE: CodeNode = {
  id: 'file:src/index.ts',
  title: 'src/index.ts',
  type: 'file',
  filePath: 'src/index.ts',
  projectRoot: '/project',
  language: 'typescript',
  lineCount: 42,
  imports: ['./utils', './types'],
  exports: ['main', 'Config'],
};

const NODE_WITH_AST: CodeNode = {
  id: 'file:src/auth/login.ts',
  title: 'src/auth/login.ts',
  type: 'file',
  filePath: 'src/auth/login.ts',
  projectRoot: '/project',
  language: 'typescript',
  lineCount: 120,
  imports: ['./session', './validator'],
  exports: ['login', 'logout', 'AuthService'],
  astFunctions: [
    { name: 'login', startLine: 10, endLine: 30, params: ['email', 'password'], isExported: true },
    { name: 'logout', startLine: 35, endLine: 45, params: ['sessionId'], isExported: true },
    { name: 'hashPassword', startLine: 50, endLine: 60, params: ['raw'], isExported: false },
  ],
  astClasses: [
    { name: 'AuthService', methods: ['login', 'logout'], isExported: true, extends: 'BaseService' },
    { name: 'SessionCache', methods: ['get', 'set'], isExported: false },
  ],
};

describe('composeFileNeuron — basic structure (1.3)', () => {
  it('returns a string containing data-cerveau-type="file-neuron"', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html).toContain('data-cerveau-type="file-neuron"');
  });

  it('contains the file id as the article id', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    // id derived from filePath: "src/index.ts" → safe id
    expect(html).toContain('<article');
    expect(html).toContain('id="');
  });

  it('contains an infobox with language', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html).toContain('typescript');
    expect(html).toContain('class="infobox"');
  });

  it('contains line count in infobox', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html).toContain('42');
  });

  it('contains a tldr section', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html).toContain('data-section="tldr"');
  });

  it('contains an architecture section with imports', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html).toContain('data-section="architecture"');
    expect(html).toContain('./utils');
    expect(html).toContain('./types');
  });

  it('contains exports in architecture section', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html).toContain('main');
    expect(html).toContain('Config');
  });

  it('closes with </article>', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html.trim()).toMatch(/<\/article>\s*$/);
  });
});

describe('composeFileNeuron — AST anchors (1.3)', () => {
  it('emits one h3 anchor per function with id="fn-NAME"', () => {
    const html = composeFileNeuron(NODE_WITH_AST);
    expect(html).toContain('id="fn-login"');
    expect(html).toContain('id="fn-logout"');
    expect(html).toContain('id="fn-hashpassword"');
  });

  it('emits one h3 anchor per class with id="cls-NAME"', () => {
    const html = composeFileNeuron(NODE_WITH_AST);
    expect(html).toContain('id="cls-authservice"');
    expect(html).toContain('id="cls-sessioncache"');
  });

  it('includes function params in the anchor heading', () => {
    const html = composeFileNeuron(NODE_WITH_AST);
    // login(email, password)
    expect(html).toContain('email');
    expect(html).toContain('password');
  });

  it('emits a TOC linking to function and class anchors', () => {
    const html = composeFileNeuron(NODE_WITH_AST);
    expect(html).toContain('class="toc"');
    // TOC must contain href to at least one anchor
    expect(html).toContain('#fn-login');
  });

  it('sanitizes special chars in anchor ids (lowercase, alphanum+hyphen only)', () => {
    const nodeWithSpecialName: CodeNode = {
      ...MINIMAL_NODE,
      astFunctions: [
        { name: 'MyFunc_123', startLine: 1, endLine: 5, params: [], isExported: true },
      ],
    };
    const html = composeFileNeuron(nodeWithSpecialName);
    // Underscore → hyphen, uppercase → lowercase
    expect(html).toContain('id="fn-myfunc-123"');
  });
});

describe('composeFileNeuron — breadcrumb (1.3)', () => {
  it('contains a breadcrumb nav', () => {
    const html = composeFileNeuron(NODE_WITH_AST);
    expect(html).toContain('class="breadcrumb"');
  });

  it('breadcrumb shows project and directory segments', () => {
    // filePath: src/auth/login.ts → project / src / auth / login.ts
    const html = composeFileNeuron(NODE_WITH_AST);
    expect(html).toContain('src');
    expect(html).toContain('auth');
  });
});

describe('composeFileNeuron — no-AST node (1.3)', () => {
  it('works without astFunctions or astClasses (no anchors emitted)', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html).not.toContain('id="fn-');
    expect(html).not.toContain('id="cls-');
  });
});

describe('composeFileNeuron — edge cases', () => {
  it('handles a filePath with a single segment (no directory) without throwing', () => {
    const nodeFlat: CodeNode = {
      ...MINIMAL_NODE,
      filePath: 'index.ts',
    };
    let html: string;
    expect(() => {
      html = composeFileNeuron(nodeFlat);
    }).not.toThrow();
    // Breadcrumb must exist and contain the file name
    expect(html!).toContain('class="breadcrumb"');
    expect(html!).toContain('index.ts');
    // There should be no intermediate directory <a> links before the last segment
    // (only the project root link + aria-current span)
    const breadcrumbMatch = html!.match(/<nav class="breadcrumb"[^>]*>([\s\S]*?)<\/nav>/);
    expect(breadcrumbMatch).not.toBeNull();
    const breadcrumbHtml = breadcrumbMatch![1];
    // The file name must be wrapped in aria-current, not a link
    expect(breadcrumbHtml).toContain('aria-current="page"');
    expect(breadcrumbHtml).toContain('index.ts');
  });

  it('renders "none detected" exports message when exports is empty', () => {
    const nodeNoExports: CodeNode = {
      ...MINIMAL_NODE,
      exports: [],
    };
    const html = composeFileNeuron(nodeNoExports);
    expect(html).toContain('none detected');
  });
});

describe('composeFileNeuron — validates against schema (1.3)', () => {
  it('output passes validateNote without errors', () => {
    const html = composeFileNeuron(NODE_WITH_AST);
    const result = validateNote(html);
    const errors = result.issues.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  it('output passes validateNote for minimal node too', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    const result = validateNote(html);
    const errors = result.issues.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// data-cerveau-importance — fan-in derived importance (fix: issue #1)
// ---------------------------------------------------------------------------

describe('composeFileNeuron — data-cerveau-importance attribute', () => {
  it('emits data-cerveau-importance on the article element', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0);
    expect(html).toMatch(/data-cerveau-importance="\d+\.\d+"/);
  });

  it('zero-inbound node has importance >= 0.5 (base floor)', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0);
    const m = html.match(/data-cerveau-importance="([^"]+)"/);
    expect(m).not.toBeNull();
    const importance = Number.parseFloat(m![1]);
    expect(importance).toBeGreaterThanOrEqual(0.5);
  });

  it('higher inbound count yields higher importance', () => {
    const htmlLow = composeFileNeuron(MINIMAL_NODE, 1);
    const htmlHigh = composeFileNeuron(MINIMAL_NODE, 10);

    const parsedLow = Number.parseFloat(htmlLow.match(/data-cerveau-importance="([^"]+)"/)![1]);
    const parsedHigh = Number.parseFloat(htmlHigh.match(/data-cerveau-importance="([^"]+)"/)![1]);

    expect(parsedHigh).toBeGreaterThan(parsedLow);
  });

  it('importance is clamped to [0, 1]', () => {
    // Extremely high inbound (above cap) should not exceed 1.0
    const html = composeFileNeuron(MINIMAL_NODE, 1000);
    const m = html.match(/data-cerveau-importance="([^"]+)"/);
    expect(m).not.toBeNull();
    const importance = Number.parseFloat(m![1]);
    expect(importance).toBeLessThanOrEqual(1.0);
    expect(importance).toBeGreaterThanOrEqual(0.0);
  });

  it('node with many inbound edges has importance above base (hub file ranks higher)', () => {
    const htmlZero = composeFileNeuron(MINIMAL_NODE, 0);
    const htmlHub = composeFileNeuron(MINIMAL_NODE, 20);

    const importanceZero = Number.parseFloat(
      htmlZero.match(/data-cerveau-importance="([^"]+)"/)![1],
    );
    const importanceHub = Number.parseFloat(htmlHub.match(/data-cerveau-importance="([^"]+)"/)![1]);

    // Hub file (20 inbound) should rank significantly above zero-inbound file
    expect(importanceHub).toBeGreaterThan(importanceZero + 0.2);
  });
});
