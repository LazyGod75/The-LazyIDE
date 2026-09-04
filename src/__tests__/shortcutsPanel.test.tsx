/**
 * shortcutsPanel.test.tsx — ShortcutsPanel.tsx renders the real shortcut
 * map (W2b, spec §5). `SHORTCUT_GROUPS` is exported specifically so this
 * test (and any future audit) can assert its entries correspond to actual
 * `useCanvasKeyboard.ts` branches — every key combo asserted below is
 * cross-checked against that hook's keydown handler.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { fr } from '../i18n/locales/fr';
import { ShortcutsPanel, SHORTCUT_GROUPS } from '../components/agents/canvas/ShortcutsPanel';

// i18n pass (2026-08): a handful of key-combo LABELS (mouse/trackpad gesture
// names, "Maj"/"Suppr"/"Échap") are now themselves translated via a
// `keysKey` i18n key rather than baked into `entry.keys` as French text —
// see ShortcutEntry's own doc comment. Resolving through the real `fr`
// dictionary (DEFAULT_LOCALE) below keeps this test's "matches
// useCanvasKeyboard.ts reality" contract intact without hardcoding the
// French copy a second time here.
function resolvedKeys(entries: readonly { keys: string; keysKey?: string }[]): string[] {
  return entries.map((e) => (e.keysKey ? fr[e.keysKey] : e.keys));
}

describe('SHORTCUT_GROUPS — matches useCanvasKeyboard.ts reality', () => {
  it('covers every real shortcut branch, grouped by Navigation/Inspection/Édition/Sélection/Modes (W5a: i18n KEYS, not text — see ShortcutsPanel.tsx)', () => {
    const titleKeys = SHORTCUT_GROUPS.map((g) => g.titleKey);
    expect(titleKeys).toEqual([
      'canvas.shortcuts.group.navigation',
      'canvas.shortcuts.group.inspection',
      'canvas.shortcuts.group.editing',
      'canvas.shortcuts.group.selection',
      'canvas.shortcuts.group.modes',
    ]);

    const allKeys = resolvedKeys(SHORTCUT_GROUPS.flatMap((g) => g.entries));
    for (const expectedKey of ['Ctrl+0', 'Maj+F', 'Ctrl+K', 'O', 'L', 'D', 'Tab', 'Ctrl+C', 'Ctrl+V', 'Ctrl+D', 'Ctrl+L', 'Échap', 'Ctrl+Z', '?']) {
      expect(allKeys).toContain(expectedKey);
    }
  });

  it('never lists an unimplemented shortcut (e.g. Ctrl+A in-zone select — not wired in the keyboard hook)', () => {
    const allKeys = resolvedKeys(SHORTCUT_GROUPS.flatMap((g) => g.entries));
    expect(allKeys).not.toContain('Ctrl+A');
  });
});

function renderPanel(open: boolean, onClose: () => void) {
  return render(
    <I18nProvider>
      <ShortcutsPanel open={open} onClose={onClose} />
    </I18nProvider>,
  );
}

describe('ShortcutsPanel', () => {
  it('renders nothing when closed', () => {
    renderPanel(false, () => {});
    expect(screen.queryByTestId('canvas-shortcuts-panel')).not.toBeInTheDocument();
  });

  it('renders every group and calls onClose from the close button', () => {
    const onClose = vi.fn();
    renderPanel(true, onClose);
    expect(screen.getByTestId('canvas-shortcuts-panel')).toBeInTheDocument();
    for (const group of SHORTCUT_GROUPS) {
      expect(screen.getByTestId(`canvas-shortcuts-group-${group.titleKey}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId('canvas-shortcuts-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes the panel (a11y sweep, W5a)', () => {
    const onClose = vi.fn();
    renderPanel(true, onClose);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
