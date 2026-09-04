/* useFocusTrap — shared focus-trap for modal/dialog components.

   The repo has ~13 components that render role="dialog" aria-modal="true"
   without actually retaining focus: Tab walks the user straight out of the
   dialog into the page underneath, contradicting the aria-modal announcement.
   This hook is the single place that fixes it:

   - Moves focus to the first focusable element inside the container on open.
   - Traps Tab / Shift+Tab so focus cycles within the container.
   - Calls onClose on Escape, when provided.
   - Restores focus to whatever triggered the dialog once it unmounts.

   Not for containers with their own keyboard-owning widget (CodeMirror,
   xterm) — Tab there must reach the editor/terminal, not get captured here.
   Skip those call sites and say so; do not wrap them.
*/

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

interface UseFocusTrapOptions {
  /** Called on Escape. Omit to leave Escape unhandled by this hook. */
  onClose?: () => void;
  /** Skip trapping entirely (e.g. while the dialog is still closed). */
  isDisabled?: boolean;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Traps Tab focus inside `containerRef`, focuses its first focusable child on
 * mount, and restores focus to the pre-open trigger element on unmount.
 *
 * Intended for components that are conditionally rendered while open
 * (`{isOpen && <MyModal ... />}`) — mount/unmount drives the effect.
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  options: UseFocusTrapOptions = {}
): void {
  const { onClose, isDisabled = false } = options;
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (isDisabled) return;
    const current = containerRef.current;
    if (!current) return;
    const container: HTMLElement = current;

    const trigger = document.activeElement as HTMLElement | null;

    if (!container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '-1');
    }

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (onCloseRef.current) {
          e.preventDefault();
          onCloseRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);

    const first = getFocusable(container)[0];
    (first ?? container).focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (trigger && document.body.contains(trigger)) {
        trigger.focus();
      }
    };
  }, [containerRef, isDisabled]);
}
