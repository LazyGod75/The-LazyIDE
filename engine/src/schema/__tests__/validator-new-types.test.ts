import { describe, expect, it } from 'vitest';
import { composeBrainIndex } from '../../annotator/blocks/composers/brain-index.js';
import { composeProjectSummary } from '../../annotator/blocks/composers/project-summary.js';
import { composeTopicOverview } from '../../annotator/blocks/composers/topic-overview.js';
import { validateNote } from '../validator.js';

describe('validator accepts new page types', () => {
  it('accepts topic-overview type', () => {
    const html = composeTopicOverview({
      id: 'test-topic-overview',
      title: 'Test Topic',
      created: '2026-05-26T00:00:00Z',
      leadText: 'Test description.',
      sections: '<section><h2 id="general">General</h2>\n<p>Test section content.</p></section>',
      stats: {
        noteCount: 5,
        typeBreakdown: { decision: 2, semantic: 3 },
        dateRange: ['2025-01-01', '2026-05-26'],
        avgImportance: 0.8,
      },
      relatedTopics: [],
      tags: ['test'],
    });
    const result = validateNote(html);
    expect(result.ok).toBe(true);
  });

  it('accepts brain-index type', () => {
    const html = composeBrainIndex({
      id: 'test-brain-index',
      title: 'Test Brain',
      created: '2026-05-26T00:00:00Z',
      leadText: 'Test brain with 10 notes.',
      stats: { totalNotes: 10, totalTopics: 2, dateRange: ['2025-01-01', '2026-05-26'] },
      topics: [
        {
          name: 'Test',
          id: 'topic-overview-test',
          noteCount: 10,
          lastActivity: '2026-05-26',
          description: 'A test topic.',
        },
      ],
      tags: ['test'],
    });
    const result = validateNote(html);
    expect(result.ok).toBe(true);
  });

  it('accepts project-summary type', () => {
    const html = composeProjectSummary({
      id: 'test-project-summary',
      title: 'Test Project',
      created: '2026-05-26T00:00:00Z',
      leadText: 'Test project summary.',
      stack: 'TypeScript, React',
      status: 'Active',
      stats: {
        noteCount: 10,
        typeBreakdown: { feature: 5, task: 5 },
        dateRange: ['2025-01-01', '2026-05-26'],
        avgImportance: 0.8,
      },
      notes: [{ title: 'Note 1', date: '2026-01-01', type: 'feature', importance: '0.8' }],
      relatedTopics: [],
      tags: ['test'],
    });
    const result = validateNote(html);
    expect(result.ok).toBe(true);
  });
});
