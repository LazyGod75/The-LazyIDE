/**
 * AgentsPanelKeyboard.test.tsx
 *
 * Keyboard-accessibility regression guard for the Settings zone (audit:
 * "clickable divs without role/tabIndex/onKeyDown"). AgentsPanel's
 * auto-approve Toggle is a <div role="switch"> that previously had no
 * tabIndex and no keyboard handler — a keyboard/screen-reader user could
 * not reach or activate it. Asserts it now:
 *   1. exposes an accessible switch role reachable via getByRole (implies
 *      tabIndex is present — jsdom + testing-library only exposes it this
 *      way when the element is part of the accessibility tree),
 *   2. toggles on both Enter and Space, matching the mouse onClick behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

import { AgentsPanel } from '../components/settings/AgentsPanel';

describe('AgentsPanel — auto-approve Toggle keyboard access', () => {
  it('is reachable via role=switch and has a tabIndex', () => {
    render(<AgentsPanel />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('tabindex', '0');
  });

  it('toggles aria-checked on Enter, matching the click behavior', () => {
    render(<AgentsPanel />);
    const toggle = screen.getByRole('switch');
    const before = toggle.getAttribute('aria-checked');

    fireEvent.keyDown(toggle, { key: 'Enter' });

    expect(toggle.getAttribute('aria-checked')).not.toBe(before);
  });

  it('toggles aria-checked on Space as well', () => {
    render(<AgentsPanel />);
    const toggle = screen.getByRole('switch');
    const before = toggle.getAttribute('aria-checked');

    fireEvent.keyDown(toggle, { key: ' ' });

    expect(toggle.getAttribute('aria-checked')).not.toBe(before);
  });
});
