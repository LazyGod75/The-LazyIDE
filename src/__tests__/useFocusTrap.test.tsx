/**
 * useFocusTrap.test.tsx
 *
 * hooks/useFocusTrap.ts — the shared focus-trap used by modal components.
 * Verifies: focus moves into the dialog on mount, Tab cycles within it
 * (forward and Shift+Tab backward), Escape calls onClose, and focus is
 * restored to the trigger element on unmount.
 */

import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { useFocusTrap } from '../hooks/useFocusTrap';

function TestDialog({ onClose }: { onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onClose });
  return (
    <div ref={ref} role="dialog" aria-modal="true">
      <button data-testid="first">First</button>
      <button data-testid="middle">Middle</button>
      <button data-testid="last">Last</button>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('focuses the first focusable element on mount', () => {
    const { getByTestId } = render(<TestDialog />);
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('wraps Tab from the last element back to the first', () => {
    const { getByTestId } = render(<TestDialog />);
    getByTestId('last').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('wraps Shift+Tab from the first element back to the last', () => {
    const { getByTestId } = render(<TestDialog />);
    getByTestId('first').focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('last'));
  });

  it('calls onClose on Escape when provided', () => {
    const onClose = vi.fn();
    render(<TestDialog onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the trigger element on unmount', () => {
    const trigger = document.createElement('button');
    trigger.setAttribute('data-testid', 'trigger');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(<TestDialog />);
    expect(document.activeElement).not.toBe(trigger);

    unmount();
    expect(document.activeElement).toBe(trigger);

    document.body.removeChild(trigger);
  });
});
