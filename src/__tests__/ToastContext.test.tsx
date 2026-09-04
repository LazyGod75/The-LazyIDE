/**
 * ToastContext.test.tsx
 *
 * Regression coverage for the "useToast must be used inside ToastProvider"
 * crash that reliably fired during Vite dev HMR (see ToastContext.ts's file
 * header for the full root-cause writeup: Toast.tsx used to mix a component
 * export (ToastProvider) with plain-function exports (useToast,
 * useToastSafe) in the same file as `createContext()`, which breaks React
 * Fast Refresh's "component-only file" assumption and let a stale/fresh
 * context-object mismatch reach a mounted consumer).
 *
 * Fix: the context object + hooks now live in ToastContext.ts, a
 * hooks-only module that Toast.tsx merely imports and re-exports. These
 * tests cover:
 *  - useToast() throwing when rendered outside ToastProvider (the exact
 *    consumer-outside-provider case from the crash report).
 *  - useToast() resolving correctly inside ToastProvider.
 *  - useToastSafe() degrading to a no-op instead of throwing outside a
 *    provider (existing documented convention, still must hold).
 *  - Toast.tsx's re-exported ToastProvider/useToast/useToastSafe are the
 *    SAME bindings as ToastContext.ts's — i.e. there is exactly one
 *    ToastContext object in the module graph, not two. This is the
 *    structural property that keeps the context identity stable across an
 *    HMR update to Toast.tsx's render code.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as ToastModule from '../components/ui/Toast';
import * as ToastContextModule from '../components/ui/ToastContext';
import { ToastProvider, useToast, useToastSafe } from '../components/ui/Toast';
import { I18nProvider } from '../i18n';

function ThrowingConsumer() {
  useToast();
  return <div data-testid="ok">should not render</div>;
}

function SafeConsumer() {
  const toast = useToastSafe();
  return (
    <button onClick={() => toast('hello')} data-testid="safe-btn">
      safe
    </button>
  );
}

function ToastFirer() {
  const { toast } = useToast();
  return (
    <button onClick={() => toast('it worked', 'success')} data-testid="fire-btn">
      fire
    </button>
  );
}

describe('useToast / ToastProvider', () => {
  it('throws when a consumer renders outside ToastProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<ThrowingConsumer />)).toThrow(
      'useToast must be used inside ToastProvider',
    );
  });

  it('resolves and can fire a toast when rendered inside ToastProvider', () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <ToastFirer />
        </ToastProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('fire-btn'));
    expect(screen.getByText('it worked')).toBeInTheDocument();
  });

  it('useToastSafe degrades to a silent no-op outside ToastProvider instead of throwing', () => {
    expect(() => render(<SafeConsumer />)).not.toThrow();

    fireEvent.click(screen.getByTestId('safe-btn'));
    // No provider mounted -> nothing rendered, no throw, no toast surfaced.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('useToastSafe fires a real toast when a ToastProvider ancestor exists', () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <SafeConsumer />
        </ToastProvider>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('safe-btn'));
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('re-exports from Toast.tsx are the exact same bindings as ToastContext.ts (single context instance)', () => {
    // Guards the structural fix: if Toast.tsx ever went back to defining its
    // own createContext()/useToast() instead of re-exporting ToastContext.ts's,
    // this would fail because the two modules would hold different function
    // identities (and, in the real HMR bug, different context objects).
    expect(ToastModule.useToast).toBe(ToastContextModule.useToast);
    expect(ToastModule.useToastSafe).toBe(ToastContextModule.useToastSafe);
    expect(useToast).toBe(ToastContextModule.useToast);
    expect(useToastSafe).toBe(ToastContextModule.useToastSafe);
  });
});
