/* BrainFilters.test.tsx — Rules tab Kind/Project/Author filter bar.

   Regression coverage for the project-alias query fix: when the selected
   project is a merge of several raw slugs (see listProjects.ts's
   mergeAliases — a project tagged both under its short name and under a
   full-path-derived slug), BrainFilters must query EVERY alias and union
   the results, instead of only querying the displayed/canonical slug and
   silently dropping notes tagged under the other one. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { BrainFilters } from '../components/brain/BrainFilters';

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, getPlatform: vi.fn(), isTauri: vi.fn(() => true) };
});
vi.mock('../lib/brain/listProjects', () => ({
  listBrainProjects: vi.fn(),
}));

import { getPlatform } from '../lib/platform';
import { listBrainProjects } from '../lib/brain/listProjects';

const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;
const mockListBrainProjects = listBrainProjects as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
});

function renderFilters(onFilterIds = vi.fn()) {
  render(
    <I18nProvider>
      <BrainFilters onFilterIds={onFilterIds} />
    </I18nProvider>,
  );
  return onFilterIds;
}

describe('BrainFilters — project alias query union', () => {
  it('queries every raw alias of the selected project and unions the results', async () => {
    mockListBrainProjects.mockResolvedValue([
      {
        project: 'lazy-backoffice',
        noteCount: 2,
        rawValues: ['lazy-backoffice', 'c-users-david-documents-cerveau-lazy-backoffice'],
      },
    ]);
    const queryCss = vi.fn().mockImplementation((selector: string) => {
      if (selector.includes('"lazy-backoffice"')) return Promise.resolve('#note-a some text\n');
      if (selector.includes('"c-users-david-documents-cerveau-lazy-backoffice"')) {
        return Promise.resolve('#note-b some text\n');
      }
      return Promise.resolve('');
    });
    mockGetPlatform.mockReturnValue({
      brain: {
        queryCss,
        noteHtml: vi.fn().mockResolvedValue(null),
      },
    });

    const onFilterIds = renderFilters();

    // Wait for the project dropdown to populate (Kind, Project, Author — in
    // that order), then select the merged project entry.
    await waitFor(() => {
      expect(screen.getByText('lazy-backoffice')).toBeInTheDocument();
    });
    const projectSelect = screen.getAllByRole('combobox')[1];
    fireEvent.change(projectSelect, { target: { value: 'lazy-backoffice' } });

    // Both raw aliases must be queried — not just the displayed/canonical one.
    await waitFor(() => {
      expect(queryCss).toHaveBeenCalledWith('article[data-cerveau-project="lazy-backoffice"]');
      expect(queryCss).toHaveBeenCalledWith(
        'article[data-cerveau-project="c-users-david-documents-cerveau-lazy-backoffice"]',
      );
    });

    // And the results from both queries are unioned into one filter set —
    // notes tagged under either alias stay visible, none silently dropped.
    await waitFor(() => {
      const lastCall = onFilterIds.mock.calls[onFilterIds.mock.calls.length - 1][0] as Set<string>;
      expect(lastCall).toEqual(new Set(['note-a', 'note-b']));
    });
  });
});
