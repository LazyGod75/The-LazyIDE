/**
 * P0-2c — compressFileNeuron must surface the attached conv→file-neuron
 * enrichment (decisions/bugs/…) in the compressed context that the recall
 * path (session-inject.ts's tryCompressFileNeuron) injects, not just the code
 * structure. Compact, ranked, token-budgeted, superseded items excluded.
 */

import { describe, expect, it } from 'vitest';
import type { EnrichmentItem } from '../../annotator/blocks/composers/file-neuron.js';
import type { CodeNode } from '../../graph/code-scanner.js';
import { compressFileNeuron } from '../compress-file-neuron.js';

function makeNode(overrides: Partial<CodeNode> = {}): CodeNode {
  return {
    id: 'file:src/hero/canvas-renderer.ts',
    title: 'src/hero/canvas-renderer.ts',
    type: 'file',
    filePath: 'src/hero/canvas-renderer.ts',
    projectRoot: 'C:/fake/project',
    language: 'typescript',
    lineCount: 120,
    imports: ['./scene.js'],
    exports: ['renderHero'],
    ...overrides,
  };
}

function item(text: string, overrides: Partial<EnrichmentItem> = {}): EnrichmentItem {
  return { text, confidence: 0.8, date: '2026-07-02', sourceConvLink: '#conv-1', ...overrides };
}

describe('compressFileNeuron — surfaces decisions/bugs alongside code structure', () => {
  it('includes a "knowledge:" block with the decision and the bug (default mode)', () => {
    const node = makeNode({
      decisions: [item('Decided to use Canvas2D for the hero because Three.js was too heavy.')],
      bugs: [item('Bug: the minimap was crushing the editor layout.')],
    });
    const out = compressFileNeuron(node);
    expect(out).toContain('knowledge:');
    expect(out).toContain('Decision: Decided to use Canvas2D for the hero');
    expect(out).toContain('Bug: Bug: the minimap was crushing the editor layout');
  });

  it('also includes the knowledge block in skeletonOnly mode', () => {
    const node = makeNode({ decisions: [item('Decided to use Canvas2D for the hero.')] });
    const out = compressFileNeuron(node, { skeletonOnly: true });
    expect(out).toContain('knowledge:');
    expect(out).toContain('Decision: Decided to use Canvas2D for the hero.');
  });

  it('omits the knowledge block entirely when the node has no enrichment', () => {
    const node = makeNode();
    const out = compressFileNeuron(node);
    expect(out).not.toContain('knowledge:');
  });

  it('excludes superseded items from the summary', () => {
    const node = makeNode({
      decisions: [
        item('Old decision that was superseded.', { superseded: true, validUntil: '2026-07-01' }),
        item('Current decision that replaced it.', { date: '2026-07-01' }),
      ],
    });
    const out = compressFileNeuron(node);
    expect(out).toContain('Current decision that replaced it');
    expect(out).not.toContain('Old decision that was superseded');
  });

  it('ranks by confidence desc, then date desc', () => {
    const node = makeNode({
      decisions: [item('Low confidence older', { confidence: 0.3, date: '2026-06-01' })],
      bugs: [item('High confidence newer', { confidence: 0.95, date: '2026-07-02' })],
      rules: [item('Mid confidence', { confidence: 0.6, date: '2026-06-15' })],
    });
    const out = compressFileNeuron(node);
    const knowledgeBlock = out.slice(out.indexOf('knowledge:'));
    const highIdx = knowledgeBlock.indexOf('High confidence newer');
    const midIdx = knowledgeBlock.indexOf('Mid confidence');
    const lowIdx = knowledgeBlock.indexOf('Low confidence older');
    expect(highIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it('is token-budgeted: a tiny budget keeps only the top item, not all of them', () => {
    const node = makeNode({
      decisions: [
        item('A'.repeat(120), { confidence: 0.9 }),
        item('B'.repeat(120), { confidence: 0.8 }),
        item('C'.repeat(120), { confidence: 0.7 }),
      ],
    });
    const full = compressFileNeuron(node, { enrichmentTokenBudget: 200 });
    const tiny = compressFileNeuron(node, { enrichmentTokenBudget: 10 });
    expect(full).toContain('A'.repeat(120));
    expect(full).toContain('B'.repeat(120));
    expect(tiny).toContain('A'.repeat(120)); // at least one line always kept
    expect(tiny).not.toContain('C'.repeat(120));
    expect(tiny.length).toBeLessThan(full.length);
  });

  it('omits the summary entirely when enrichmentTokenBudget is 0', () => {
    const node = makeNode({ decisions: [item('Some decision')] });
    const out = compressFileNeuron(node, { enrichmentTokenBudget: 0 });
    expect(out).not.toContain('knowledge:');
  });

  it('does not regress the existing code-structure output (imports/exports/functions)', () => {
    const node = makeNode({
      astFunctions: [{ name: 'renderHero', startLine: 10, endLine: 20, params: ['ctx'], isExported: true }],
    });
    const out = compressFileNeuron(node);
    expect(out).toContain('imports: ./scene.js');
    expect(out).toContain('exports: renderHero');
    expect(out).toContain('renderHero(ctx) :10');
  });
});
