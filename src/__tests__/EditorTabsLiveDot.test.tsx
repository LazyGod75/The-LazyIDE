import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { EditorTabs } from '../components/editor/EditorTabs';
import type { OpenTab } from '../components/editor/editorStore';

vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  useI18nOptional: () => ({ t: (key: string) => key }),
}));

function tab(overrides: Partial<OpenTab> = {}): OpenTab {
  return {
    path: 'C:/repo/a.ts',
    filename: 'a.ts',
    content: 'x',
    savedContent: 'x',
    isDirty: false,
    pinned: false,
    ...overrides,
  };
}

describe('EditorTabs live activity cursor', () => {
  it('names the agent on a live tab and distinguishes a question from a run', () => {
    render(
      <EditorTabs
        tabs={[tab()]}
        activeTabPath={tab().path}
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        liveActivityForPath={() => ({ kind: 'question', label: 'Coder · Overwrite a.ts?' })}
      />,
    );
    const dot = screen.getByTestId('code-tab-activity-dot');
    expect(dot).toHaveAttribute('data-kind', 'question');
    expect(dot).toHaveAttribute('title', 'Coder · Overwrite a.ts?');
  });

  it('falls back to the boolean live flag as a run dot when no activity object is passed', () => {
    render(
      <EditorTabs
        tabs={[tab()]}
        activeTabPath={tab().path}
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        isLiveForPath={() => true}
      />,
    );
    expect(screen.getByTestId('code-tab-activity-dot')).toHaveAttribute('data-kind', 'run');
  });
});
