/* modelVariants — id decomposition + family grouping for the picker.
 * Fixture ids mirror the live Devin ACP catalog captured 2026-09-11. */

import { describe, it, expect } from 'vitest';
import {
  decomposeModelId,
  recombineModelId,
  groupModelFamilies,
  memberForEffort,
  locateInFamily,
  familyLabel,
} from '../lib/models/modelVariants';

const M = (id: string, label = id) => ({ id, label });

describe('decomposeModelId', () => {
  it('parses a bare id as its own base with no modifiers', () => {
    expect(decomposeModelId('swe-1-6')).toEqual({
      base: 'swe-1-6', effort: undefined, fast: false, priority: false, thinking: false, longCtx: false,
    });
  });

  it('extracts the effort suffix', () => {
    expect(decomposeModelId('claude-opus-5-high')).toMatchObject({ base: 'claude-opus-5', effort: 'high' });
    expect(decomposeModelId('claude-opus-5-max')).toMatchObject({ base: 'claude-opus-5', effort: 'max' });
    expect(decomposeModelId('gpt-5-6-sol-none')).toMatchObject({ base: 'gpt-5-6-sol', effort: 'none' });
  });

  it('stacks modifiers right-to-left', () => {
    expect(decomposeModelId('claude-opus-5-high-fast'))
      .toMatchObject({ base: 'claude-opus-5', effort: 'high', fast: true });
    expect(decomposeModelId('gpt-5-6-sol-low-priority'))
      .toMatchObject({ base: 'gpt-5-6-sol', effort: 'low', priority: true });
    expect(decomposeModelId('glm-5-2-max-1m'))
      .toMatchObject({ base: 'glm-5-2', effort: 'max', longCtx: true });
    expect(decomposeModelId('claude-opus-4-6-thinking-1m'))
      .toMatchObject({ base: 'claude-opus-4-6', thinking: true, longCtx: true });
  });

  it('does not eat name parts that only look like modifiers (flash stays in the base)', () => {
    expect(decomposeModelId('deepseek-v4-flash-max'))
      .toMatchObject({ base: 'deepseek-v4-flash', effort: 'max' });
    expect(decomposeModelId('gemini-3-8-flash-medium'))
      .toMatchObject({ base: 'gemini-3-8-flash', effort: 'medium' });
  });

  it('handles the uppercase MODEL_* ids', () => {
    expect(decomposeModelId('MODEL_GPT_5_2_XHIGH'))
      .toMatchObject({ base: 'MODEL_GPT_5_2', effort: 'xhigh' });
  });

  it('leaves opaque ids untouched', () => {
    expect(decomposeModelId('adaptive').base).toBe('adaptive');
    expect(decomposeModelId('MODEL_PRIVATE_11').base).toBe('MODEL_PRIVATE_11');
  });
});

describe('recombineModelId', () => {
  it('is the inverse of decomposeModelId for canonical ids', () => {
    for (const id of [
      'claude-opus-5-high', 'claude-opus-5-high-fast', 'gpt-5-6-sol-low-priority',
      'glm-5-2-max-1m', 'claude-opus-4-6-thinking-1m', 'swe-2-max',
    ]) {
      const d = decomposeModelId(id);
      expect(recombineModelId(d.base, d.effort, d)).toBe(id);
    }
  });
});

describe('groupModelFamilies', () => {
  const catalog = [
    M('claude-opus-5-medium', 'Claude Opus 5 Medium'),
    M('claude-opus-5-low', 'Claude Opus 5 Low'),
    M('claude-opus-5-high', 'Claude Opus 5 High'),
    M('claude-opus-5-xhigh', 'Claude Opus 5 XHigh'),
    M('claude-opus-5-max', 'Claude Opus 5 Max'),
    M('claude-opus-5-low-fast', 'Claude Opus 5 Low Fast'),
    M('claude-opus-5-high-fast', 'Claude Opus 5 High Fast'),
    M('swe-1-6', 'SWE-1.6'),
    M('swe-1-6-fast', 'SWE-1.6 Fast'),
    M('swe-2-medium', 'SWE-2 Medium'),
    M('swe-2-high', 'SWE-2 High'),
    M('swe-2-max', 'SWE-2 Max'),
    M('adaptive', 'Adaptive'),
  ];

  it('collapses effort permutations into one family per base model', () => {
    const fams = groupModelFamilies(catalog);
    expect(fams.map((f) => f.base)).toEqual([
      'claude-opus-5', 'swe-1-6', 'swe-2', 'adaptive',
    ]);
    const opus = fams[0];
    expect(opus.members).toHaveLength(7);
    expect(opus.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(opus.hasFast).toBe(true);
    expect(opus.label).toBe('Claude Opus 5');
  });

  it('defaults a family click to the medium member, else the bare one', () => {
    const fams = groupModelFamilies(catalog);
    expect(fams[0].defaultMember.id).toBe('claude-opus-5-medium');
    expect(fams[1].defaultMember.id).toBe('swe-1-6');
    expect(fams[2].defaultMember.id).toBe('swe-2-medium');
  });

  it('keeps single-member families renderable as plain rows', () => {
    const fams = groupModelFamilies(catalog);
    const adaptive = fams.find((f) => f.base === 'adaptive')!;
    expect(adaptive.members).toHaveLength(1);
    expect(adaptive.efforts).toEqual([]);
    expect(adaptive.defaultMember.id).toBe('adaptive');
  });
});

describe('memberForEffort', () => {
  const fam = groupModelFamilies([
    M('claude-opus-5-medium'), M('claude-opus-5-high'), M('claude-opus-5-high-fast'),
  ])[0];

  it('keeps the current modifiers when the effort exists at the same dial set', () => {
    // Currently on high-fast, switch effort to medium: no medium-fast
    // member exists, so fall back to plain medium.
    expect(memberForEffort(fam, 'claude-opus-5-high-fast', 'medium')).toBe('claude-opus-5-medium');
    expect(memberForEffort(fam, 'claude-opus-5-medium', 'high')).toBe('claude-opus-5-high');
  });

  it('returns undefined for an effort the family lacks', () => {
    expect(memberForEffort(fam, 'claude-opus-5-medium', 'minimal')).toBeUndefined();
  });
});

describe('locateInFamily + familyLabel', () => {
  it('finds the member and its decomposition', () => {
    const fam = groupModelFamilies([M('swe-1-6'), M('swe-1-6-fast')])[0];
    const hit = locateInFamily(fam, 'swe-1-6-fast')!;
    expect(hit.deco.fast).toBe(true);
    expect(locateInFamily(fam, 'nope')).toBeUndefined();
  });

  it('strips dial words from the family label only', () => {
    expect(familyLabel('Claude Opus 5 Medium')).toBe('Claude Opus 5');
    expect(familyLabel('Gemini 3.8 Flash Medium')).toBe('Gemini 3.8 Flash');
    expect(familyLabel('SWE-2 Max')).toBe('SWE-2');
  });
});
