import { describe, it, expect } from 'vitest';
import {
  parseAuthorsFromHtml,
  parseCreatedFromHtml,
  parseNoteIdentity,
} from '../lib/brain/queryCssParse';

describe('parseAuthorsFromHtml', () => {
  it('pairs author-id with author name', () => {
    const html =
      '<p data-cerveau-author-id="maya" data-cerveau-author="Maya Chen">fact</p>';
    expect(parseAuthorsFromHtml(html)).toEqual([{ authorId: 'maya', author: 'Maya Chen' }]);
  });

  it('falls back to names when author-id attributes are missing', () => {
    const html = '<p data-cerveau-author="Alex Ruiz">fact</p>';
    expect(parseAuthorsFromHtml(html)).toEqual([{ authorId: 'Alex Ruiz', author: 'Alex Ruiz' }]);
  });
});

describe('parseNoteIdentity', () => {
  it('extracts author and YYYY-MM-DD when from article attributes', () => {
    const html =
      '<article data-cerveau-author="Priya Shah" data-cerveau-created="2026-03-14T09:00:00Z"><p>hi</p></article>';
    expect(parseNoteIdentity(html)).toEqual({ author: 'Priya Shah', when: '2026-03-14' });
  });

  it('omits missing fields rather than fabricating them', () => {
    expect(parseNoteIdentity('<article><p>empty</p></article>')).toEqual({});
    expect(parseCreatedFromHtml('<article></article>')).toBeNull();
  });
});
