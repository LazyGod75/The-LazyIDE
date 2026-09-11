/**
 * P0-2 — carry the conv→file-neuron enrichment through to recall.
 *
 * Proves the round trip that makes incremental enrichment (enrich.ts's
 * runIncrementalEnrich) safe: a CodeNode with decisions/bugs/ideas/rules/qa/
 * activities is rendered by composeFileNeuron, then parsed back by
 * parseFileNeuronHtml / extractFileNeuronStubsFromHtml, and the recovered
 * CodeNode must carry the same enrichment — including superseded/validUntil
 * flags and the source conversation link — byte-for-byte on the text.
 */

import { describe, expect, it } from 'vitest';
import type {
  EnrichmentItem,
  FileNeuronEnrichment,
} from '../../annotator/blocks/composers/file-neuron.js';
import { composeFileNeuron } from '../../annotator/blocks/composers/file-neuron.js';
import type { CodeNode } from '../code-scanner.js';
import { extractFileNeuronStubsFromHtml, parseFileNeuronHtml } from '../file-neuron-parse.js';

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

const DECISION: EnrichmentItem = {
  text: 'Decided to use Canvas2D for the hero because Three.js was too heavy.',
  confidence: 0.9,
  date: '2026-07-02',
  sourceConvLink: '#conv-abc123',
};

const BUG: EnrichmentItem = {
  text: 'Bug: the minimap was crushing the editor layout.',
  confidence: 0.75,
  date: '2026-07-01',
  sourceConvLink: '#conv-xyz789',
};

const SUPERSEDED_IDEA: EnrichmentItem = {
  text: 'Idea: maybe use WebGL for particle effects.',
  confidence: 0.5,
  date: '2026-06-01',
  sourceConvLink: '#conv-old111',
  superseded: true,
  validUntil: '2026-07-02',
};

describe('P0-2 — CodeNode carries enrichment (code-scanner.ts type)', () => {
  it('accepts decisions/bugs/ideas/rules/qa/activities as optional fields', () => {
    const node = makeNode({ decisions: [DECISION], bugs: [BUG] });
    expect(node.decisions).toHaveLength(1);
    expect(node.bugs).toHaveLength(1);
    expect(node.ideas).toBeUndefined();
  });
});

describe('P0-2 — parseFileNeuronHtml round-trips enrichment', () => {
  it('recovers a single decision with confidence/date/source link', () => {
    const node = makeNode();
    const enrichment: FileNeuronEnrichment = { decisions: [DECISION] };
    const html = composeFileNeuron(node, 3, enrichment);

    const parsed = parseFileNeuronHtml(html);
    expect(parsed).not.toBeNull();
    expect(parsed?.decisions).toHaveLength(1);
    expect(parsed?.decisions?.[0].text).toBe(DECISION.text);
    expect(parsed?.decisions?.[0].confidence).toBeCloseTo(DECISION.confidence);
    expect(parsed?.decisions?.[0].date).toBe(DECISION.date);
    expect(parsed?.decisions?.[0].sourceConvLink).toBe(DECISION.sourceConvLink);
    expect(parsed?.decisions?.[0].superseded).toBeUndefined();
  });

  it('recovers a bug alongside a decision (both sections present)', () => {
    const node = makeNode();
    const enrichment: FileNeuronEnrichment = { decisions: [DECISION], bugs: [BUG] };
    const html = composeFileNeuron(node, 0, enrichment);

    const parsed = parseFileNeuronHtml(html);
    expect(parsed?.decisions?.[0].text).toBe(DECISION.text);
    expect(parsed?.bugs?.[0].text).toBe(BUG.text);
    expect(parsed?.ideas).toBeUndefined();
    expect(parsed?.rules).toBeUndefined();
    expect(parsed?.qa).toBeUndefined();
  });

  it('recovers superseded/validUntil flags', () => {
    const node = makeNode();
    const enrichment: FileNeuronEnrichment = { ideas: [SUPERSEDED_IDEA] };
    const html = composeFileNeuron(node, 0, enrichment);

    const parsed = parseFileNeuronHtml(html);
    expect(parsed?.ideas?.[0].superseded).toBe(true);
    expect(parsed?.ideas?.[0].validUntil).toBe('2026-07-02');
  });

  it('recovers the "activities" field from the singular "activity" section id', () => {
    const activity: EnrichmentItem = {
      text: 'This file was touched in a conversation about hero rendering.',
      confidence: 0.5,
      date: '2026-07-02',
      sourceConvLink: '#conv-touch1',
    };
    const node = makeNode();
    const html = composeFileNeuron(node, 0, { activities: [activity] });

    const parsed = parseFileNeuronHtml(html);
    expect(parsed?.activities).toHaveLength(1);
    expect(parsed?.activities?.[0].text).toBe(activity.text);
  });

  it('round-trips text containing HTML-sensitive characters (&, <, >, quotes)', () => {
    const tricky: EnrichmentItem = {
      text: 'Bug: `a < b && c > d` throws when input contains a "quote" and an apostrophe\'s edge case.',
      confidence: 0.6,
      date: '2026-07-02',
      sourceConvLink: '#conv-tricky',
    };
    const node = makeNode();
    const html = composeFileNeuron(node, 0, { bugs: [tricky] });

    const parsed = parseFileNeuronHtml(html);
    expect(parsed?.bugs?.[0].text).toBe(tricky.text);
  });

  it('returns undefined enrichment fields when the file-neuron has none', () => {
    const node = makeNode();
    const html = composeFileNeuron(node, 0);
    const parsed = parseFileNeuronHtml(html);
    expect(parsed?.decisions).toBeUndefined();
    expect(parsed?.bugs).toBeUndefined();
    expect(parsed?.ideas).toBeUndefined();
    expect(parsed?.rules).toBeUndefined();
    expect(parsed?.qa).toBeUndefined();
    expect(parsed?.activities).toBeUndefined();
  });

  it('still recovers imports/exports/astFunctions alongside enrichment (no regression)', () => {
    const node = makeNode({
      astFunctions: [
        { name: 'renderHero', startLine: 10, endLine: 20, params: ['ctx'], isExported: true },
      ],
    });
    const html = composeFileNeuron(node, 2, { decisions: [DECISION] });
    const parsed = parseFileNeuronHtml(html);
    expect(parsed?.imports).toEqual(['./scene.js']);
    expect(parsed?.exports).toEqual(['renderHero']);
    expect(parsed?.astFunctions?.[0].name).toBe('renderHero');
    expect(parsed?.decisions?.[0].text).toBe(DECISION.text);
  });
});

describe('P0-2 — extractFileNeuronStubsFromHtml round-trips enrichment (multi-note)', () => {
  it('carries enrichment through the multi-note stub extractor used by enrich.ts', () => {
    const node = makeNode();
    const html = composeFileNeuron(node, 1, { decisions: [DECISION], bugs: [BUG] });
    const notes = [{ id: node.id, path: 'fake.html', html, sizeBytes: html.length, mtimeMs: 0 }];

    const stubs = extractFileNeuronStubsFromHtml(notes);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].decisions?.[0].text).toBe(DECISION.text);
    expect(stubs[0].bugs?.[0].text).toBe(BUG.text);
  });

  it('skips non-file-neuron notes without throwing', () => {
    const notes = [
      {
        id: 'conv-1',
        path: 'fake.html',
        html: '<article data-cerveau-type="episodic">not a file neuron</article>',
        sizeBytes: 10,
        mtimeMs: 0,
      },
    ];
    expect(extractFileNeuronStubsFromHtml(notes)).toEqual([]);
  });
});
