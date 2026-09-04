import { describe, it, expect } from 'vitest';
import { hasReActMarker, salvageReAct } from '../lib/bots/salvageReAct';

describe('salvageReAct', () => {
  it('strips a prose preamble and keeps the THOUGHT/ACTION block', () => {
    const raw = 'Sure, I will help.\n\nTHOUGHT: open a browser\nACTION: cloud_browser_open';
    expect(salvageReAct(raw)).toBe('THOUGHT: open a browser\nACTION: cloud_browser_open');
  });

  it('promotes a bare FINAL into ACTION: FINAL so the report is not lost', () => {
    const raw = 'Here is the answer.\nFINAL: Title: Example Domain';
    expect(salvageReAct(raw)).toMatch(/^ACTION: FINAL/);
    expect(salvageReAct(raw)).toContain('Title: Example Domain');
  });

  it('returns the original text when there is no ReAct marker', () => {
    expect(salvageReAct('hello')).toBe('hello');
    expect(hasReActMarker('hello')).toBe(false);
    expect(hasReActMarker('ACTION: write_file')).toBe(true);
  });
});
