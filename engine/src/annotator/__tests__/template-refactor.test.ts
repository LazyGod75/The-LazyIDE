import { describe, expect, it } from 'vitest';
import { emitWikipediaNote } from '../template.js';

const sampleInput = {
  id: 'test-regression-001',
  title: 'Regression Test Note',
  type: 'decision',
  created: '2026-01-15T10:00:00Z',
  source: 'claude-code',
  tier: 'working' as const,
  importance: 0.85,
  tags: ['tradelab', 'risk'],
  facts: [
    { text: 'The system uses a 2% max drawdown limit.', confidence: 0.9, kind: 'assertion' },
    { text: 'Q: What is the max position size? A: 0.1 lots.', confidence: 0.85, kind: 'qa' },
    { text: 'Error: connection timeout after 30s', confidence: 0.7, kind: 'error' },
  ],
  relations: {
    replaces: ['old-note-001'],
    entities: ['Tradebot: tradelab bot', 'SENTINEL: backtest framework'],
  },
  toolMeta: { tool: 'Bash', filesModified: ['/src/risk.ts'], filesRead: ['/src/config.ts'] },
  aliases: ['risk-note'],
  tldr: 'Max drawdown is 2%, position size capped at 0.1 lots.',
  topic: 'tradelab/risk',
};

describe('emitWikipediaNote regression', () => {
  it('produces valid HTML with all expected sections', () => {
    const html = emitWikipediaNote(sampleInput);
    expect(html).toContain('<article id="test-regression-001"');
    expect(html).toContain('data-cerveau-type="decision"');
    expect(html).toContain('data-cerveau-importance="0.85"');
    expect(html).toContain('class="infobox"');
    expect(html).toContain('class="glossary"');
    expect(html).toContain('data-section="qa"');
    expect(html).toContain('data-section="tldr"');
    expect(html).toContain('data-section="summary"');
    expect(html).toContain('data-section="errors"');
    expect(html).toContain('data-section="outcome"');
    expect(html).toContain('data-section="references"');
    expect(html).toContain('class="categories"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('</article>');
  });

  it('snapshot matches', () => {
    const html = emitWikipediaNote(sampleInput);
    expect(html).toMatchSnapshot();
  });

  it('emits <meta charset="utf-8"> as the first element of the document', () => {
    // Notes are written as standalone .html files with no <!DOCTYPE>/<head>
    // wrapper (store/writer.ts writes emitWikipediaNote's output verbatim).
    // Opening one directly in a browser without an explicit, early charset
    // declaration can mis-detect the encoding and mojibake accented text
    // even though the file on disk is clean UTF-8. Must be first so it is
    // well within the first 1024 bytes browsers scan for charset detection.
    const html = emitWikipediaNote(sampleInput);
    expect(html.startsWith('<meta charset="utf-8">')).toBe(true);
  });

  it('replaces links use routable "#/note/<id>" format', () => {
    const html = emitWikipediaNote(sampleInput);
    // Must NOT contain bare "#old-note-001" (SPA router cannot resolve bare anchors)
    expect(html).not.toContain('href="#old-note-001"');
    // Must contain the routable SPA path
    expect(html).toContain('href="#/note/old-note-001"');
  });
});
