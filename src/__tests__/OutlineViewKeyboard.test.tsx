/**
 * OutlineViewKeyboard.test.tsx
 *
 * Keyboard-accessibility regression guard for the Code zone (audit:
 * "clickable divs without role/tabIndex/onKeyDown"). Each outline row was a
 * plain <div onClick> with no role/tabIndex/onKeyDown — unreachable and
 * inert for keyboard/screen-reader users. Asserts a row is now:
 *   1. reachable via getByRole('button'),
 *   2. activated by Enter (same effect as a mouse click: onJump(line)).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: () => {},
    LOCALES: [],
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: () => {},
    LOCALES: [],
  }),
}));

import { OutlineView } from '../components/editor/OutlineView';
import type { LspClientHandle } from '../components/editor/lspClient';

function fakeLspHandle(): LspClientHandle {
  return {
    documentSymbols: async () => [
      {
        name: 'handleSubmit',
        kind: 12,
        selectionRange: { start: { line: 41 } },
      },
    ],
  } as unknown as LspClientHandle;
}

describe('OutlineView — symbol row keyboard access', () => {
  it('is reachable via role=button and activates onJump on Enter', async () => {
    const onJump = vi.fn();
    render(<OutlineView lspHandle={fakeLspHandle()} onJump={onJump} />);

    const row = await waitFor(() => screen.getByRole('button', { name: /handleSubmit/ }));
    expect(row).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(row, { key: 'Enter' });

    expect(onJump).toHaveBeenCalledWith(42);
  });
});
