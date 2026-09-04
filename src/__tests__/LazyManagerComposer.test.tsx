/**
 * LazyManagerComposer — orchestrator input field (bug fix: was a single-line
 * <input>, replaced with an auto-growing <textarea rows={1}> matching
 * Composer.tsx's own pattern — Enter sends, Shift+Enter inserts a newline).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React, { createRef, useState } from 'react';
import { I18nProvider } from '../i18n';
import { LazyManagerComposer } from '../components/lazyManager/LazyManagerComposer';
import type { LazyAgent } from '../lib/agents/agentDef';
import type { StoredAgent } from '../lib/agents/agentsStorage';

// Composer.tsx (coder-mode delegate) needs a full AssistantStoreProvider tree
// and has its own dedicated test coverage (composerPreflight.test.tsx etc.) —
// stub it here so these tests stay focused on LazyManagerComposer's own
// orchestrator-mode textarea and mode-branching logic.
vi.mock('../components/assistant/Composer', () => ({
  Composer: () => <div data-testid="mock-composer" />,
}));

// Deterministic, name-collision-free fixture for the @-mention popup tests
// below — mocked instead of relying on the real ECC_AGENTS list so these
// tests stay stable regardless of the built-in library's exact contents/
// order (the popup's own dedup-with-ECC behavior is a separate concern, not
// under test here).
function fixtureAgent(overrides: Partial<LazyAgent>): StoredAgent {
  const agent: LazyAgent = {
    id: overrides.id ?? 'fixture-id',
    name: overrides.name ?? 'demo-agent',
    displayName: overrides.displayName ?? 'Demo Agent',
    description: 'Fixture agent for tests',
    color: overrides.color ?? 'violet',
    tags: [],
    systemPrompt: '',
    modelTier: overrides.modelTier ?? 'sonnet',
    triggers: { manual: true },
    scope: 'user',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  return { agent, scope: 'user' };
}

const MOCK_AGENTS: StoredAgent[] = [
  fixtureAgent({ id: 'a1', name: 'demo-code-reviewer', displayName: 'Demo Code Reviewer', color: 'cyan' }),
  fixtureAgent({ id: 'a2', name: 'demo-code-explorer', displayName: 'Demo Code Explorer', color: 'green' }),
  fixtureAgent({ id: 'a3', name: 'demo-architect', displayName: 'Demo Architect', color: 'amber' }),
];

vi.mock('../lib/agents/agentsStorage', () => ({
  listAgents: vi.fn(() => Promise.resolve(MOCK_AGENTS)),
}));

function renderComposer(props: Partial<React.ComponentProps<typeof LazyManagerComposer>> = {}) {
  const inputRef = createRef<HTMLTextAreaElement>();
  const onSend = vi.fn();
  const setInputSpy = vi.fn();
  // `input` and `setInput` come from a small stateful wrapper, not a plain
  // spy prop: the real LazyManager.tsx parent feeds the textarea's typed
  // value straight back in as a controlled prop on every keystroke, and the
  // mention popup's own insertion logic (selectMentionAgent) reads that
  // `input` prop to compute the text before/after the caret. A non-stateful
  // mock `setInput` would leave `input` frozen at its initial value, so
  // typing a mention query would never actually reach the popup's insertion
  // logic — this wrapper reproduces the parent's real behavior while still
  // exposing a spy for assertions.
  const { input: initialInput = '', ...rest } = props;

  function Harness() {
    const [value, setValue] = useState(initialInput);
    return (
      <I18nProvider>
        <LazyManagerComposer
          mode="orchestrator"
          input={value}
          setInput={(v: string) => { setInputSpy(v); setValue(v); }}
          onSend={onSend}
          onStop={vi.fn()}
          busy={false}
          inputRef={inputRef}
          onKeyDown={() => {}}
          onLaunchAgent={vi.fn()}
          {...rest}
        />
      </I18nProvider>
    );
  }

  render(<Harness />);
  return { onSend, setInput: setInputSpy, inputRef };
}

// Flushes the microtask queue once — every render mounts the mention
// popup's own agent-list-loading effect (a resolved listAgents() promise),
// which settles just after the synchronous test body returns. Awaiting this
// keeps that state update inside `act(...)` instead of leaking an
// "update not wrapped in act" warning into unrelated tests below.
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('LazyManagerComposer — auto-growing textarea', () => {
  it('renders a <textarea> (not an <input>) for the manager input', async () => {
    renderComposer();
    const el = screen.getByTestId('manager-input');
    expect(el.tagName).toBe('TEXTAREA');
    expect(el).toHaveAttribute('rows', '1');
    await flushMicrotasks();
  });

  it('Enter (no shift) sends and prevents the default newline insertion', async () => {
    const { onSend } = renderComposer({ input: 'do the thing' });
    const el = screen.getByTestId('manager-input');
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
  });

  it('Shift+Enter does not send (lets the newline through)', async () => {
    const { onSend } = renderComposer({ input: 'do the thing' });
    const el = screen.getByTestId('manager-input');
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await flushMicrotasks();
  });

  it('is disabled while busy, and the send/stop testid flips accordingly', async () => {
    renderComposer({ busy: true, input: 'x' });
    expect(screen.getByTestId('manager-input')).toBeDisabled();
    expect(screen.getByTestId('manager-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('manager-send')).not.toBeInTheDocument();
    await flushMicrotasks();
  });

  it('send button is disabled when input is empty and not busy', async () => {
    renderComposer({ busy: false, input: '' });
    expect(screen.getByTestId('manager-send')).toBeDisabled();
    await flushMicrotasks();
  });

  it('typing calls setInput with the new value', async () => {
    const { setInput } = renderComposer();
    fireEvent.change(screen.getByTestId('manager-input'), { target: { value: 'hey' } });
    expect(setInput).toHaveBeenCalledWith('hey');
    await flushMicrotasks();
  });

  it('coder mode delegates to the existing Composer instead of rendering its own textarea', async () => {
    renderComposer({ mode: 'coder' });
    expect(screen.queryByTestId('manager-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-composer')).toBeInTheDocument();
    await flushMicrotasks();
  });
});

describe('LazyManagerComposer — @-agent-mention popup', () => {
  it('opens the popup on a bare "@" and filters live as the query narrows', async () => {
    renderComposer({ input: '' });
    const el = screen.getByTestId('manager-input');

    fireEvent.change(el, { target: { value: '@' } });
    expect(await screen.findByTestId('manager-mention-popup')).toBeInTheDocument();
    expect(await screen.findByTestId('manager-mention-item-demo-code-reviewer')).toBeInTheDocument();
    expect(screen.getByTestId('manager-mention-item-demo-code-explorer')).toBeInTheDocument();
    expect(screen.getByTestId('manager-mention-item-demo-architect')).toBeInTheDocument();

    // Narrow the query — only the two "*code*" entries should remain.
    fireEvent.change(el, { target: { value: '@code' } });
    await waitFor(() => {
      expect(screen.queryByTestId('manager-mention-item-demo-architect')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('manager-mention-item-demo-code-reviewer')).toBeInTheDocument();
    expect(screen.getByTestId('manager-mention-item-demo-code-explorer')).toBeInTheDocument();
  });

  it('keeps the popup open for a hyphenated in-progress name (regression: \\w* would close it mid-name)', async () => {
    renderComposer({ input: '' });
    const el = screen.getByTestId('manager-input');

    // Everything after the last hyphen alone ("rev") would never match
    // /@(\w*)$/ against this full string — only the [\w-]* fix keeps the
    // popup open while a kebab-case name is still being typed.
    fireEvent.change(el, { target: { value: '@demo-code-rev' } });
    expect(await screen.findByTestId('manager-mention-popup')).toBeInTheDocument();
    // findByTestId (async), not getByTestId: the popup div itself renders
    // synchronously off local state, but its items only appear once the
    // mocked listAgents() promise resolves and React commits that update —
    // a real render cycle, not a microtask the initial popup-appears await
    // above already waited out. A synchronous getByTestId here raced that
    // commit and intermittently failed under full-suite CPU load, exactly
    // like the sibling "opens the popup on a bare @" test above already
    // awaits both queries for this same reason.
    expect(await screen.findByTestId('manager-mention-item-demo-code-reviewer')).toBeInTheDocument();
    expect(screen.queryByTestId('manager-mention-item-demo-code-explorer')).not.toBeInTheDocument();
  });

  it('ArrowDown then Enter selects the highlighted agent, inserts "@<name> ", and does not send', async () => {
    const { onSend, setInput } = renderComposer({ input: '' });
    const el = screen.getByTestId('manager-input');

    fireEvent.change(el, { target: { value: '@code' } });
    await screen.findByTestId('manager-mention-popup');
    // Wait for the filtered agent list itself (listAgents() resolves
    // asynchronously) — the popup container can mount a render tick before
    // its items do, which raced ArrowDown against an empty list under load
    // and left activeIndex stuck at 0 (flaky in the full suite).
    // Filtered order: demo-code-reviewer (0), demo-code-explorer (1).
    await screen.findByTestId('manager-mention-item-demo-code-explorer');
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    fireEvent.keyDown(el, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(setInput).toHaveBeenCalledWith('@demo-code-explorer ');
  });

  it('Tab selects the highlighted agent, same as Enter', async () => {
    const { onSend, setInput } = renderComposer({ input: '' });
    const el = screen.getByTestId('manager-input');

    fireEvent.change(el, { target: { value: '@code' } });
    await screen.findByTestId('manager-mention-popup');
    // See the ArrowDown test above: wait for the actual list item so the
    // agent list has finished loading before selecting by index.
    await screen.findByTestId('manager-mention-item-demo-code-reviewer');
    fireEvent.keyDown(el, { key: 'Tab' });

    expect(onSend).not.toHaveBeenCalled();
    expect(setInput).toHaveBeenCalledWith('@demo-code-reviewer ');
  });

  it('Escape closes the popup', async () => {
    renderComposer({ input: '' });
    const el = screen.getByTestId('manager-input');

    fireEvent.change(el, { target: { value: '@' } });
    await screen.findByTestId('manager-mention-popup');
    fireEvent.keyDown(el, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('manager-mention-popup')).not.toBeInTheDocument();
    });
  });

  it('closes once the regex no longer matches (space typed after the token)', async () => {
    renderComposer({ input: '' });
    const el = screen.getByTestId('manager-input');

    fireEvent.change(el, { target: { value: '@demo' } });
    await screen.findByTestId('manager-mention-popup');

    fireEvent.change(el, { target: { value: '@demo ' } });
    await waitFor(() => {
      expect(screen.queryByTestId('manager-mention-popup')).not.toBeInTheDocument();
    });
  });
});
