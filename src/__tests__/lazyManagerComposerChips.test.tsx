/**
 * LazyManagerComposer — quick-reply preset chips (Standup/Recap/Stop
 * everything/Clean up) at a narrow panel width (real QA repro, 2026-08-14):
 * "Recap" rendered as "Reca" / "p" on two lines — a WORD split mid-render,
 * not merely wrapped. Root cause: design-system.css's global `button {
 * overflow-wrap: break-word; word-break: break-word; }` safety net removes
 * a flex child's normal "never shrink narrower than an unbreakable run of
 * text" floor, so the row's default (shrinkable, non-wrapping) flex layout
 * could squeeze a pill narrower than a single word and the word itself
 * split across lines.
 *
 * Coder mode delegates the whole composer to Composer.tsx (its own,
 * separately-tested surface) — mocked out here so this file stays focused
 * on the orchestrator-mode preset row.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React, { createRef } from 'react';
import { I18nProvider } from '../i18n';
import { LazyManagerComposer } from '../components/lazyManager/LazyManagerComposer';

vi.mock('../components/assistant/Composer', () => ({
  Composer: () => <div data-testid="mock-composer" />,
}));

// Deterministic fixture, same rationale as LazyManagerComposer.test.tsx's
// own mock: the mention popup's agent-list effect resolves listAgents()
// just after mount regardless of what this file actually exercises.
vi.mock('../lib/agents/agentsStorage', () => ({
  listAgents: vi.fn(() => Promise.resolve([])),
}));

function renderComposer() {
  const inputRef = createRef<HTMLTextAreaElement>();
  render(
    <I18nProvider>
      <LazyManagerComposer
        mode="orchestrator"
        input=""
        setInput={() => {}}
        onSend={vi.fn()}
        onStop={vi.fn()}
        busy={false}
        inputRef={inputRef}
        onKeyDown={() => {}}
        onLaunchAgent={vi.fn()}
      />
    </I18nProvider>,
  );
}

// Flushes the mention popup's agent-list-loading microtask (see the mock
// above) so its resolution never lands OUTSIDE an act() boundary — same
// convention as LazyManagerComposer.test.tsx's own flushMicrotasks.
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const PRESET_TESTIDS = [
  'manager-preset-standup',
  'manager-preset-recap',
  'manager-preset-stopall',
  'manager-preset-cleanup',
];

describe('LazyManagerComposer — preset chips never split a word across lines', () => {
  it('every preset pill is structurally unable to shrink below its own content width (flexShrink:0) and cannot line-break inside a word (whiteSpace:nowrap, wordBreak:keep-all, overflowWrap:normal)', async () => {
    renderComposer();
    for (const testid of PRESET_TESTIDS) {
      const el = screen.getByTestId(testid);
      expect(el.style.flexShrink).toBe('0');
      expect(el.style.whiteSpace).toBe('nowrap');
      expect(el.style.wordBreak).toBe('keep-all');
      expect(el.style.overflowWrap).toBe('normal');
    }
    await flushMicrotasks();
  });

  it('the preset row wraps WHOLE pills onto additional lines when the panel is too narrow for all four, rather than overflowing or shrinking them (flexWrap:wrap on the row)', async () => {
    renderComposer();
    const row = screen.getByTestId('manager-preset-standup').parentElement as HTMLElement;
    expect(row.style.display).toBe('flex');
    expect(row.style.flexWrap).toBe('wrap');
    // All four pills are direct, unwrapped siblings of that same row — the
    // row itself is the ONLY thing that reflows, never a pill's own text.
    for (const testid of PRESET_TESTIDS) {
      expect(screen.getByTestId(testid).parentElement).toBe(row);
    }
    await flushMicrotasks();
  });
});
