import { describe, it, expect } from 'vitest';
import { draftIdsFromAliasMap, rootDraftIdsToLaunch } from '../components/agents/canvas/yoloLaunchRootDrafts';
import { makeRef } from '../components/agents/canvas/canvasTypes';

describe('rootDraftIdsToLaunch', () => {
  it('launches every unchained draft', () => {
    expect(rootDraftIdsToLaunch(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('launches only the chain root (A→B launches A, not B)', () => {
    expect(
      rootDraftIdsToLaunch(
        ['a', 'b'],
        [{ sourceRef: makeRef('draft', 'a'), targetRef: makeRef('draft', 'b') }],
      ),
    ).toEqual(['a']);
  });

  it('ignores chains that target drafts not in this turn', () => {
    expect(
      rootDraftIdsToLaunch(
        ['a'],
        [{ sourceRef: makeRef('draft', 'a'), targetRef: makeRef('draft', 'other') }],
      ),
    ).toEqual(['a']);
  });
});

describe('draftIdsFromAliasMap', () => {
  it('collects draft refs only', () => {
    const map = new Map([
      ['impl', makeRef('draft', 'd1')],
      ['mission', makeRef('mission', 'M1')],
    ]);
    expect(draftIdsFromAliasMap(map)).toEqual(['d1']);
  });
});
