/**
 * Coverage-driven file-neuron excerpts: JSDoc + head/tail body must be
 * CSS-selectable via #fn-<slug> / #bind-<slug> so L1 query injects the
 * fact, not just the signature heading.
 *
 * Ceiling measured 2026-08-16: signature-only 17% → JSDoc+excerpt 58%
 * on the 24-question token-economy set. See bench/token-economy/results/
 * coverage-layers.json and coverage-proposed.json.
 */

import { describe, expect, it } from 'vitest';
import { composeFileNeuron } from '../src/annotator/blocks/composers/file-neuron.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { parseAstFunctionsFromHtml } from '../src/graph/file-neuron-parse.js';

const BASE: CodeNode = {
  id: 'file:src/graph/ast-parser.ts',
  title: 'src/graph/ast-parser.ts',
  type: 'file',
  filePath: 'src/graph/ast-parser.ts',
  projectRoot: '/project',
  language: 'typescript',
  lineCount: 200,
  imports: [],
  exports: ['parseFile'],
};

describe('composeFileNeuron — CSS-selectable symbol excerpts', () => {
  it('wraps a function that carries an excerpt in a #fn-<slug> section containing the body', () => {
    const html = composeFileNeuron({
      ...BASE,
      astFunctions: [
        {
          name: 'parseFile',
          startLine: 1,
          endLine: 20,
          params: ['filePath'],
          isExported: true,
          jsdoc: '/** Pair parse() with tree.delete() in a finally block. */',
          excerpt:
            'export async function parseFile(filePath: string) {\n  try {\n    return tree;\n  } finally {\n    tree.delete();\n  }\n}',
        },
      ],
    });
    expect(html).toContain('id="fn-parsefile"');
    expect(html).toContain('data-cerveau-symbol="parseFile"');
    expect(html).toContain('data-cerveau-symbol-kind="function"');
    expect(html).toContain('tree.delete()');
    expect(html).toContain('finally');
    expect(html).toContain('data-section="excerpt"');
    expect(html).toContain('data-section="jsdoc"');
  });

  it('does not emit excerpt/jsdoc wrappers when the function has neither', () => {
    const html = composeFileNeuron({
      ...BASE,
      astFunctions: [
        { name: 'parseFile', startLine: 1, endLine: 2, params: ['filePath'], isExported: true },
      ],
    });
    expect(html).toContain('id="fn-parsefile"');
    expect(html).not.toContain('data-section="excerpt"');
    expect(html).not.toContain('data-section="jsdoc"');
  });

  it('renders type/const bindings as #bind-<slug> with their excerpt', () => {
    const html = composeFileNeuron({
      ...BASE,
      astBindings: [
        {
          name: 'NudgeStyle',
          kind: 'type',
          startLine: 75,
          endLine: 75,
          isExported: true,
          excerpt: "export type NudgeStyle = 'skill' | 'tool' | 'none';",
        },
      ],
    });
    expect(html).toContain('id="bind-nudgestyle"');
    expect(html).toContain('data-cerveau-symbol="NudgeStyle"');
    expect(html).toContain('data-cerveau-symbol-kind="type"');
    expect(html).toContain('&#39;skill&#39; | &#39;tool&#39; | &#39;none&#39;');
  });

  it('round-trips function name/params from the new wrapper via parseAstFunctionsFromHtml', () => {
    const html = composeFileNeuron({
      ...BASE,
      astFunctions: [
        {
          name: 'parseFile',
          startLine: 1,
          endLine: 4,
          params: ['filePath'],
          isExported: true,
          excerpt: 'export async function parseFile(filePath: string) {\n  return null;\n}',
        },
      ],
    });
    const fns = parseAstFunctionsFromHtml(html);
    expect(fns.map((f) => f.name)).toContain('parseFile');
    expect(fns.find((f) => f.name === 'parseFile')?.params).toContain('filePath');
    expect(fns.find((f) => f.name === 'parseFile')?.isExported).toBe(true);
  });
});
