import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useShortcut } from '../lib/shortcuts/useShortcut';

function dispatchKeyDown(init: Partial<KeyboardEventInit> & { key: string }): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

interface ProbeProps {
  id?: string;
  combo?: string;
  enabled?: boolean;
  onFire: () => void;
}

// Minimal component exercising useShortcut() through its real React
// lifecycle (mount/unmount/rerender), same as production call sites in
// AppShell.tsx and EditorPane.tsx.
function ShortcutProbe({ id = 'test.probe', combo = 'Mod+K', enabled = true, onFire }: ProbeProps) {
  useShortcut({ id, combo, enabled }, onFire);
  return null;
}

describe('useShortcut', () => {
  it('registers on mount and fires on a matching keydown', () => {
    const onFire = vi.fn();
    render(<ShortcutProbe id="mount.fire" combo="Mod+K" onFire={onFire} />);

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('unregisters on unmount — the handler no longer fires afterwards', () => {
    const onFire = vi.fn();
    const { unmount } = render(<ShortcutProbe id="unmount.fire" combo="Mod+U" onFire={onFire} />);
    unmount();

    dispatchKeyDown({ key: 'u', ctrlKey: true });

    expect(onFire).not.toHaveBeenCalled();
  });

  it('does not register while enabled=false', () => {
    const onFire = vi.fn();
    render(<ShortcutProbe id="disabled.probe" combo="Mod+J" enabled={false} onFire={onFire} />);

    dispatchKeyDown({ key: 'j', ctrlKey: true });

    expect(onFire).not.toHaveBeenCalled();
  });

  it('registers once enabled flips back to true', () => {
    const onFire = vi.fn();
    const { rerender } = render(<ShortcutProbe id="toggle.enabled" combo="Mod+I" enabled={false} onFire={onFire} />);
    dispatchKeyDown({ key: 'i', ctrlKey: true });
    expect(onFire).not.toHaveBeenCalled();

    rerender(<ShortcutProbe id="toggle.enabled" combo="Mod+I" enabled onFire={onFire} />);
    dispatchKeyDown({ key: 'i', ctrlKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('always invokes the latest handler without needing an explicit re-registration', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<ShortcutProbe id="latest.handler" combo="Mod+L" onFire={first} />);

    rerender(<ShortcutProbe id="latest.handler" combo="Mod+L" onFire={second} />);
    dispatchKeyDown({ key: 'l', ctrlKey: true });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('re-registers under the new combo when combo changes', () => {
    const onFire = vi.fn();
    const { rerender } = render(<ShortcutProbe id="combo.change" combo="Mod+M" onFire={onFire} />);

    rerender(<ShortcutProbe id="combo.change" combo="Mod+N" onFire={onFire} />);

    dispatchKeyDown({ key: 'm', ctrlKey: true }); // old combo — should no longer fire
    dispatchKeyDown({ key: 'n', ctrlKey: true }); // new combo — should fire

    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
