/**
 * lazyManagerStoreContext.test.tsx
 *
 * Same structural guard as ToastContext.test.tsx: createContext() + hooks
 * live in a hooks-only module so Fast Refresh of the Provider file cannot
 * mint a second context object (the crash that took down RootErrorBoundary
 * with "useLazyManagerStore must be inside LazyManagerStoreProvider").
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { LazyManagerStoreProvider, useLazyManagerStore, useLazyManagerStoreOptional } from '../components/lazyManager/lazyManagerStore';
import * as StoreModule from '../components/lazyManager/lazyManagerStore';
import * as ContextModule from '../components/lazyManager/lazyManagerStoreContext';

vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStoreOptional: () => null,
}));
vi.mock('../components/assistant/assistantStore', () => ({
  useAssistantStoreOptional: () => null,
}));

function ThrowingConsumer() {
  useLazyManagerStore();
  return <div data-testid="ok">should not render</div>;
}

function OptionalConsumer() {
  const store = useLazyManagerStoreOptional();
  return <div data-testid="opt">{store ? 'inside' : 'outside'}</div>;
}

function InsideConsumer() {
  const store = useLazyManagerStore();
  return <div data-testid="inside">{store.mode}</div>;
}

describe('lazyManagerStoreContext', () => {
  it('throws when a consumer renders outside LazyManagerStoreProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ThrowingConsumer />)).toThrow(
      'useLazyManagerStore must be inside LazyManagerStoreProvider',
    );
  });

  it('optional hook degrades to null outside the provider', () => {
    expect(() => render(<OptionalConsumer />)).not.toThrow();
    expect(screen.getByTestId('opt')).toHaveTextContent('outside');
  });

  it('resolves inside LazyManagerStoreProvider', () => {
    render(
      <LazyManagerStoreProvider>
        <InsideConsumer />
      </LazyManagerStoreProvider>,
    );
    expect(screen.getByTestId('inside')).toHaveTextContent('orchestrator');
  });

  it('re-exports the same hook bindings as the context module (single context object)', () => {
    expect(StoreModule.useLazyManagerStore).toBe(ContextModule.useLazyManagerStore);
    expect(StoreModule.useLazyManagerStoreOptional).toBe(ContextModule.useLazyManagerStoreOptional);
  });
});
