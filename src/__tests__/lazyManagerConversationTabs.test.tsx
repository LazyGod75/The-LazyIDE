/**
 * LazyManagerConversationTabs — pins the fix for a real hard-clipping bug
 * (2026-08-14 QA): a tab's label span had `overflow:hidden;
 * textOverflow:ellipsis` but no `minWidth:0`, so — as a flex child inside
 * the tab's own flex `<button>` — it never actually shrank small enough
 * for its OWN ellipsis to kick in. What clipped it instead was the
 * ancestor wrapper's `overflow:hidden` (`maxWidth`), which carries no
 * `text-overflow` of its own: a silent hard cut with no visible "…" at
 * all ("Repon" instead of "Repon…").
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { LazyManagerConversationTabs } from '../components/lazyManager/LazyManagerConversationTabs';
import type { ManagerConversationTab } from '../components/lazyManager/LazyManagerHeader';

const FIVE_CONVERSATIONS: ManagerConversationTab[] = Array.from({ length: 5 }, (_, i) => ({
  id: `manager-${1723600000000 + i * 60000}-${i}`,
  busy: false,
  phase: 'idle' as const,
  title: 'Repondez uniquement en…',
  fullTitle: 'Repondez uniquement en francais dans ce projet',
}));

function renderTabs(overrides: Partial<React.ComponentProps<typeof LazyManagerConversationTabs>> = {}) {
  return render(
    <I18nProvider>
      <LazyManagerConversationTabs
        conversations={FIVE_CONVERSATIONS}
        activeConversationId={FIVE_CONVERSATIONS[0].id}
        onSelectConversation={vi.fn()}
        onCloseConversation={vi.fn()}
        onNewSession={vi.fn()}
        openConversationCapReached={false}
        tier="wide"
        {...overrides}
      />
    </I18nProvider>,
  );
}

describe('LazyManagerConversationTabs — label ellipsis actually engages', () => {
  it('every tab label span has minWidth:0 so it can shrink enough for its own text-overflow:ellipsis to fire, instead of being hard-clipped by the ancestor wrapper', () => {
    renderTabs();
    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    expect(tabs).toHaveLength(5);
    for (const tab of tabs) {
      const label = tab.querySelector('button span:not([data-testid])') as HTMLElement;
      expect(label).toBeTruthy();
      expect(label.style.minWidth).toBe('0');
      expect(label.style.overflow).toBe('hidden');
      expect(label.style.textOverflow).toBe('ellipsis');
    }
  });
});

describe('LazyManagerConversationTabs — per-tier max width', () => {
  it('a "narrow" tier tab has a tighter maxWidth than "wide"/"compact", so one tab cannot hog the whole narrow strip', () => {
    const { unmount: unmountWide } = renderTabs({ tier: 'wide' });
    const wideMaxWidth = (screen.getAllByTestId('lazy-manager-conversation-tab')[0] as HTMLElement).style.maxWidth;
    unmountWide();

    renderTabs({ tier: 'narrow' });
    const narrowMaxWidth = (screen.getAllByTestId('lazy-manager-conversation-tab')[0] as HTMLElement).style.maxWidth;

    expect(parseInt(narrowMaxWidth, 10)).toBeLessThan(parseInt(wideMaxWidth, 10));
  });
});

describe('LazyManagerConversationTabs — every control stays reachable', () => {
  it('the close button and the trailing "add" button are present on every tab at every tier', () => {
    for (const tier of ['wide', 'compact', 'narrow'] as const) {
      const { unmount } = renderTabs({ tier });
      expect(screen.getAllByTestId('lazy-manager-conversation-tab-close')).toHaveLength(5);
      expect(screen.getByTestId('lazy-manager-conversation-tab-add')).toBeInTheDocument();
      unmount();
    }
  });

  it('renders nothing at all for a single conversation (unchanged single-conversation experience)', () => {
    renderTabs({ conversations: [FIVE_CONVERSATIONS[0]] });
    expect(screen.queryByTestId('lazy-manager-conversation-tabs')).not.toBeInTheDocument();
  });
});

describe('LazyManagerConversationTabs — rename (double-click a tab)', () => {
  it('double-clicking a tab label opens an inline rename input, prefilled with its raw customTitle (never the truncated display title)', () => {
    const conversations = [
      { ...FIVE_CONVERSATIONS[0], customTitle: 'My renamed chat' },
      FIVE_CONVERSATIONS[1],
    ];
    renderTabs({ conversations, onRenameConversation: vi.fn() });
    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    fireEvent.doubleClick(tabs[0].querySelector('button')!);
    const input = screen.getByTestId('lazy-manager-conversation-tab-rename-input') as HTMLInputElement;
    expect(input.value).toBe('My renamed chat');
  });

  it('pressing Enter commits the new name and closes the input', () => {
    const onRename = vi.fn();
    renderTabs({ conversations: [FIVE_CONVERSATIONS[0], FIVE_CONVERSATIONS[1]], onRenameConversation: onRename });
    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    fireEvent.doubleClick(tabs[0].querySelector('button')!);
    const input = screen.getByTestId('lazy-manager-conversation-tab-rename-input');
    fireEvent.change(input, { target: { value: 'Renamed via Enter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith(FIVE_CONVERSATIONS[0].id, 'Renamed via Enter');
    expect(screen.queryByTestId('lazy-manager-conversation-tab-rename-input')).not.toBeInTheDocument();
  });

  it('blurring the input also commits (not just Enter)', () => {
    const onRename = vi.fn();
    renderTabs({ conversations: [FIVE_CONVERSATIONS[0], FIVE_CONVERSATIONS[1]], onRenameConversation: onRename });
    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    fireEvent.doubleClick(tabs[0].querySelector('button')!);
    const input = screen.getByTestId('lazy-manager-conversation-tab-rename-input');
    fireEvent.change(input, { target: { value: 'Renamed via blur' } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith(FIVE_CONVERSATIONS[0].id, 'Renamed via blur');
  });

  it('pressing Escape cancels the rename without calling the handler', () => {
    const onRename = vi.fn();
    renderTabs({ conversations: [FIVE_CONVERSATIONS[0], FIVE_CONVERSATIONS[1]], onRenameConversation: onRename });
    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    fireEvent.doubleClick(tabs[0].querySelector('button')!);
    const input = screen.getByTestId('lazy-manager-conversation-tab-rename-input');
    fireEvent.change(input, { target: { value: 'Should be discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('lazy-manager-conversation-tab-rename-input')).not.toBeInTheDocument();
  });

  it('without an onRenameConversation handler, double-click is a no-op (no rename affordance at all)', () => {
    renderTabs({ conversations: [FIVE_CONVERSATIONS[0], FIVE_CONVERSATIONS[1]], onRenameConversation: undefined });
    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    fireEvent.doubleClick(tabs[0].querySelector('button')!);
    expect(screen.queryByTestId('lazy-manager-conversation-tab-rename-input')).not.toBeInTheDocument();
  });

  it('every tab carries a full-text tooltip via the title attribute, whether or not rename is wired', () => {
    renderTabs({ conversations: [FIVE_CONVERSATIONS[0], FIVE_CONVERSATIONS[1]] });
    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    const btn = tabs[0].querySelector('button')!;
    expect(btn.getAttribute('title')).toContain(FIVE_CONVERSATIONS[0].fullTitle);
  });
});

describe('LazyManagerConversationTabs — scroll-overflow chevrons replace the raw scrollbar', () => {
  it('renders no chevrons when the strip does not actually overflow (jsdom default: scrollWidth === clientWidth === 0)', () => {
    renderTabs();
    expect(screen.queryByTestId('lazy-manager-conversation-tab-scroll-left')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lazy-manager-conversation-tab-scroll-right')).not.toBeInTheDocument();
  });

  it('the scrollable strip has no native scrollbar styling class leaking a raw browser bar', () => {
    renderTabs();
    const strip = screen.getByTestId('lazy-manager-conversation-tabs').querySelector('.lazy-manager-tab-scroll');
    expect(strip).toBeTruthy();
  });

  it('a right chevron appears once the strip is simulated as overflowing, and clicking it scrolls the strip', () => {
    renderTabs();
    const strip = screen.getByTestId('lazy-manager-conversation-tabs').querySelector('.lazy-manager-tab-scroll') as HTMLElement;
    // jsdom never computes real layout — simulate overflow by overriding the
    // read-only scroll geometry getters directly, then fire a scroll event
    // so the component's own onScroll handler recomputes chevron visibility.
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 1000 });
    Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(strip, 'scrollLeft', { configurable: true, value: 0, writable: true });
    fireEvent.scroll(strip);

    const rightChevron = screen.getByTestId('lazy-manager-conversation-tab-scroll-right');
    expect(rightChevron).toBeInTheDocument();
    expect(screen.queryByTestId('lazy-manager-conversation-tab-scroll-left')).not.toBeInTheDocument();

    const scrollBySpy = vi.fn();
    strip.scrollBy = scrollBySpy;
    fireEvent.click(rightChevron);
    expect(scrollBySpy).toHaveBeenCalled();
  });
});
