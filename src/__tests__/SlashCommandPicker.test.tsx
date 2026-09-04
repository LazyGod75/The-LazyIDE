import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { SlashCommandPicker } from '../components/assistant/SlashCommandPicker';

// Pin the locale deterministically (same convention as approvalModeUi.test.tsx)
// instead of relying on the jsdom-default navigator.language guess — the
// empty-state assertion below checks literal English copy.
beforeEach(() => {
  localStorage.setItem('lazy.locale', 'en');
});
afterEach(() => {
  localStorage.removeItem('lazy.locale');
});

function renderPicker(query: string) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <I18nProvider>
      <SlashCommandPicker query={query} onSelect={onSelect} onClose={onClose} />
    </I18nProvider>,
  );
  return { onSelect, onClose };
}

describe('SlashCommandPicker — filtering on "/"', () => {
  it('shows every declared command for a bare "/"', () => {
    renderPicker('/');
    expect(screen.getByTestId('slash-command-item-clear')).toBeInTheDocument();
    expect(screen.getByTestId('slash-command-item-docs')).toBeInTheDocument();
    expect(screen.getByTestId('slash-command-item-docs-add')).toBeInTheDocument();
    expect(screen.getByTestId('slash-command-item-help')).toBeInTheDocument();
  });

  it('narrows to matching commands as the query narrows', () => {
    renderPicker('/doc');
    expect(screen.getByTestId('slash-command-item-docs')).toBeInTheDocument();
    expect(screen.getByTestId('slash-command-item-docs-add')).toBeInTheDocument();
    expect(screen.queryByTestId('slash-command-item-clear')).not.toBeInTheDocument();
    expect(screen.queryByTestId('slash-command-item-help')).not.toBeInTheDocument();
  });

  it('matches an alias (e.g. "bs" for /brain-search)', () => {
    renderPicker('/bs');
    expect(screen.getByTestId('slash-command-item-brain-search')).toBeInTheDocument();
    expect(screen.queryByTestId('slash-command-item-clear')).not.toBeInTheDocument();
  });

  it('shows an empty-state message when nothing matches', () => {
    renderPicker('/zzz');
    expect(screen.getByTestId('slash-command-picker')).toHaveTextContent('No matching commands');
  });
});

describe('SlashCommandPicker — keyboard navigation and selection', () => {
  it('Enter selects the first (highlighted) match', () => {
    const { onSelect } = renderPicker('/doc');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'docs' }));
  });

  it('ArrowDown then Enter selects the second match', () => {
    const { onSelect } = renderPicker('/doc');
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'docs-add' }));
  });

  it('Escape closes the picker', () => {
    const { onClose } = renderPicker('/doc');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking an item selects it', () => {
    const { onSelect } = renderPicker('/clear');
    fireEvent.click(screen.getByTestId('slash-command-item-clear'));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'clear' }));
  });
});
