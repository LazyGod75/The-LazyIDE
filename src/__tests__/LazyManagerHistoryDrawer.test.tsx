/**
 * LazyManagerHistoryDrawer — backdrop + Escape close (bug fix: the drawer's
 * own header toggle could not close it and its overlay ate clicks on the
 * header buttons underneath — see the component's module doc comment for
 * the fragile "mousedown outside" listener this replaces).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { LazyManagerHistoryDrawer } from '../components/lazyManager/LazyManagerHistoryDrawer';
import type { UnifiedSession } from '../components/lazyManager/lazyManagerStore';

function session(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: 's1',
    source: 'orchestrator',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 3,
    preview: 'Fix the auth bug',
    ...overrides,
  };
}

function renderDrawer(props: Partial<React.ComponentProps<typeof LazyManagerHistoryDrawer>> = {}) {
  const onClose = vi.fn();
  const onOpenSession = vi.fn();
  const onDeleteSession = vi.fn();
  render(
    <I18nProvider>
      <LazyManagerHistoryDrawer
        sessions={[session()]}
        onOpenSession={onOpenSession}
        onDeleteSession={onDeleteSession}
        onClose={onClose}
        disabled={false}
        {...props}
      />
    </I18nProvider>,
  );
  return { onClose, onOpenSession, onDeleteSession };
}

describe('LazyManagerHistoryDrawer — close affordances', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clicking the backdrop closes the drawer', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByTestId('lazy-manager-history-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the drawer panel does NOT close it', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByTestId('lazy-manager-history-drawer'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking a session row does not close via the backdrop path (it closes explicitly, and opens the session)', () => {
    const { onClose, onOpenSession } = renderDrawer();
    fireEvent.click(screen.getByTestId('lazy-manager-history-row'));
    expect(onOpenSession).toHaveBeenCalledWith('s1', 'orchestrator');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape closes the drawer', () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('other keys do not close the drawer', () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the header close (X) button still closes the drawer', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('deleting a session stops propagation — it does not also close the drawer', () => {
    const { onClose, onDeleteSession } = renderDrawer();
    fireEvent.click(screen.getByTestId('lazy-manager-history-delete'));
    expect(onDeleteSession).toHaveBeenCalledWith('s1', 'orchestrator');
    expect(onClose).not.toHaveBeenCalled();
  });
});
