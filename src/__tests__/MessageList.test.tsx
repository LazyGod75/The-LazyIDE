import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MessageList, canOfferApply, trimLeadingNarration } from '../components/assistant/MessageList';
import type { ChatMessage, StreamPart } from '../lib/models';
import { I18nProvider } from '../i18n';
import { emit } from '../lib/bus';

// Mock the event bus so emit() does not trigger Tauri
vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

// jsdom does not implement scrollIntoView
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'test-id',
    role: 'assistant',
    content: '',
    isStreaming: false,
    ...overrides,
  };
}

/** MessageList and its children (ErrorLabel/AssistantMessage) consume
 *  useI18n() — same wrapping convention as MemoryPanel.test.tsx's
 *  renderPanel(). */
function renderMessageList(messages: ChatMessage[]) {
  return render(
    <I18nProvider>
      <MessageList messages={messages} />
    </I18nProvider>,
  );
}

describe('MessageList — error state rendering', () => {
  it('renders data-testid="assistant-error" and message text when error=true', () => {
    const errorMsg = makeMessage({
      id: 'err-1',
      role: 'assistant',
      content: 'Aucun moteur détecté.',
      error: true,
    });

    renderMessageList([errorMsg]);

    expect(screen.queryByTestId('assistant-error')).not.toBeNull();
    expect(screen.getByText('Aucun moteur détecté.')).toBeInTheDocument();
  });

  it('does NOT render data-testid="assistant-error" for a normal assistant message', () => {
    const normalMsg = makeMessage({
      id: 'ok-1',
      role: 'assistant',
      content: 'Hello world',
    });

    renderMessageList([normalMsg]);

    expect(screen.queryByTestId('assistant-error')).toBeNull();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('shows error label for error message and no label for normal message in the same list', () => {
    const errorMsg = makeMessage({
      id: 'err-2',
      role: 'user',
      content: 'trigger error',
    });
    const assistantError = makeMessage({
      id: 'err-3',
      role: 'assistant',
      content: 'Le délai imparti est dépassé.',
      error: true,
    });

    renderMessageList([errorMsg, assistantError]);

    expect(screen.queryByTestId('assistant-error')).not.toBeNull();
    expect(screen.getByText('Le délai imparti est dépassé.')).toBeInTheDocument();
  });
});

// ── MessageList — thinking / tool-call steps / final answer (chat UX fix) ──
//
// The owner's complaint: "in the same message you see what it thinks, the
// tools, and the response all mixed together." These tests cover the new
// StreamPart-driven rendering: a collapsible reasoning block, distinct
// tool-call steps with live status, and a clean final answer — plus the
// hard regression guard that a plain non-agentic message (no parts) still
// renders EXACTLY as before (no "0 steps" chrome).
//
// Locale is pinned to 'fr' so assertions can match real, known copy rather
// than depending on jsdom's default navigator.language resolution (which
// is 'en-US', not the app's DEFAULT_LOCALE — see i18nLazyLoad.test.tsx).

describe('MessageList — thinking / tool-call steps / final answer', () => {
  beforeEach(() => {
    localStorage.setItem('lazy.locale', 'fr');
  });

  afterEach(() => {
    localStorage.removeItem('lazy.locale');
  });

  function thinkingPart(text: string): StreamPart {
    return { type: 'thinking', id: 'thinking', text };
  }

  function toolPart(overrides: Partial<Extract<StreamPart, { type: 'tool' }>> = {}): StreamPart {
    return {
      type: 'tool',
      id: 't1',
      name: 'brain_search',
      input: { query: 'auth flow' },
      status: 'done',
      ...overrides,
    };
  }

  it('collapses the reasoning block by default once done, and expands its text on click', () => {
    const msg = makeMessage({
      content: 'Final answer.',
      isStreaming: false,
      parts: [thinkingPart('Some reasoning text.')],
    });
    renderMessageList([msg]);

    expect(screen.getByTestId('assistant-thinking')).toBeInTheDocument();
    expect(screen.getByText('Raisonnement')).toBeInTheDocument();
    // Collapsed by default — the reasoning text itself is not in the DOM yet.
    expect(screen.queryByTestId('assistant-thinking-text')).toBeNull();

    fireEvent.click(screen.getByTestId('assistant-thinking-toggle'));

    expect(screen.getByTestId('assistant-thinking-text')).toHaveTextContent('Some reasoning text.');
  });

  it('shows the streaming label and auto-expands the reasoning block while still streaming', () => {
    const msg = makeMessage({
      content: '',
      isStreaming: true,
      parts: [thinkingPart('Partial reasoning...')],
    });
    renderMessageList([msg]);

    expect(screen.getByText('Réflexion…')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-thinking-text')).toHaveTextContent('Partial reasoning...');
  });

  it('renders a single tool-call step inline with its label and status, no group header', () => {
    const msg = makeMessage({
      content: 'Answer.',
      isStreaming: false,
      parts: [toolPart({ status: 'done', input: { query: 'auth flow' } })],
    });
    renderMessageList([msg]);

    expect(screen.getAllByTestId('assistant-tool-step')).toHaveLength(1);
    expect(screen.getByText('Recherche mémoire : «auth flow»')).toBeInTheDocument();
    // No collapsible group chrome for a single step.
    expect(screen.queryByTestId('assistant-tool-steps-toggle')).toBeNull();
  });

  it('groups 2+ tool-call steps under a collapsible "{n} étapes" header, expanded while streaming', () => {
    const msg = makeMessage({
      content: '',
      isStreaming: true,
      parts: [
        toolPart({ id: 't1', status: 'done', input: { query: 'auth flow' } }),
        toolPart({ id: 't2', status: 'running', input: { query: 'billing' } }),
      ],
    });
    renderMessageList([msg]);

    expect(screen.getByText('2 étapes')).toBeInTheDocument();
    expect(screen.getAllByTestId('assistant-tool-step')).toHaveLength(2);
    expect(screen.getByText('Recherche mémoire : «auth flow»')).toBeInTheDocument();
    expect(screen.getByText('Recherche mémoire : «billing»')).toBeInTheDocument();
  });

  it('auto-collapses the tool-steps group once streaming completes (no manual click)', () => {
    const parts: StreamPart[] = [
      toolPart({ id: 't1', status: 'done', input: { query: 'auth flow' } }),
      toolPart({ id: 't2', status: 'done', input: { query: 'billing' } }),
    ];
    const { rerender } = renderMessageList([
      makeMessage({ id: 'a1', content: '', isStreaming: true, parts }),
    ]);
    expect(screen.getAllByTestId('assistant-tool-step')).toHaveLength(2);

    rerender(
      <I18nProvider>
        <MessageList messages={[makeMessage({ id: 'a1', content: 'Done.', isStreaming: false, parts })]} />
      </I18nProvider>,
    );

    // Collapsed now — the group header remains, but the individual rows do not.
    expect(screen.getByText('2 étapes')).toBeInTheDocument();
    expect(screen.queryAllByTestId('assistant-tool-step')).toHaveLength(0);
  });

  it('renders the final answer (with inline citations) unaffected by the presence of parts', () => {
    const msg = makeMessage({
      content: 'See #auth-oauth for details.',
      isStreaming: false,
      parts: [thinkingPart('Reasoning...'), toolPart()],
    });
    renderMessageList([msg]);

    expect(screen.getByText('#auth-oauth')).toBeInTheDocument();
  });

  it('renders a simple non-agentic message (no parts) exactly as before — no steps chrome at all', () => {
    const msg = makeMessage({ content: 'Simple answer, no tools involved.', isStreaming: false });
    renderMessageList([msg]);

    expect(screen.getByText('Simple answer, no tools involved.')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thinking')).toBeNull();
    expect(screen.queryByTestId('assistant-tool-steps')).toBeNull();
  });

  it('renders a simple message with an explicit empty parts array exactly as before too', () => {
    const msg = makeMessage({ content: 'Still simple.', isStreaming: false, parts: [] });
    renderMessageList([msg]);

    expect(screen.getByText('Still simple.')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thinking')).toBeNull();
    expect(screen.queryByTestId('assistant-tool-steps')).toBeNull();
  });

  it('still shows the typing-dots placeholder while streaming with no content and no parts yet', () => {
    const msg = makeMessage({ content: '', isStreaming: true });
    renderMessageList([msg]);

    expect(screen.getByText('Travail en cours…')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thinking')).toBeNull();
    expect(screen.queryByTestId('assistant-tool-steps')).toBeNull();
  });
});

// ── MessageList — markdown rendering (DEFECT 1: readable answer, not a ──
// raw "##"/"|" wall). Deep parser/renderer coverage lives in
// parseMarkdown.test.ts and MarkdownRenderer.test.tsx — these lock the
// actual wiring inside AssistantMessage.

describe('MessageList — markdown rendering (DEFECT 1)', () => {
  it('renders a heading, a GFM table, and a list as real elements — no literal "##"/"|" leftover', () => {
    const content = [
      '## Summary',
      '',
      '| Col A | Col B |',
      '|-------|-------|',
      '| 1     | 2     |',
      '',
      '- point one',
      '- point two',
    ].join('\n');
    const { container } = renderMessageList([makeMessage({ content })]);

    expect(container.querySelector('h2')?.textContent).toBe('Summary');
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('td')).toHaveLength(2);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).not.toContain('##');
    expect(container.textContent).not.toMatch(/\|\s*Col A/);
  });

  it('still renders inline citations as clickable chips inside the rendered markdown (incl. inside a heading)', () => {
    renderMessageList([makeMessage({ content: '## Result\n\nSee #auth-oauth for details.' })]);
    expect(screen.getByText('#auth-oauth')).toBeInTheDocument();
  });

  it('renders bold/inline-code as real elements, not literal "**"/backticks', () => {
    const { container } = renderMessageList([makeMessage({ content: 'Run `npm test` and **watch it pass**.' })]);
    expect(container.querySelector('code')?.textContent).toBe('npm test');
    expect(container.querySelector('strong')?.textContent).toBe('watch it pass');
    expect(container.textContent).not.toContain('**');
  });

  it('never throws while streaming partial markdown (unterminated heading/bold)', () => {
    const msg = makeMessage({ content: '## Partial heading and a **bold that never clos', isStreaming: true });
    expect(() => renderMessageList([msg])).not.toThrow();
  });

  it('never throws while streaming a partial GFM table', () => {
    const msg = makeMessage({ content: '| a | b |\n|---|---', isStreaming: true });
    expect(() => renderMessageList([msg])).not.toThrow();
  });

  it('trims a single leading narration line from the FINAL answer', () => {
    const { container } = renderMessageList([
      makeMessage({ content: 'Let me check that for you.\n\nThe answer is 42.', isStreaming: false }),
    ]);
    expect(container.textContent).not.toContain('Let me check that for you.');
    expect(container.textContent).toContain('The answer is 42.');
  });

  it('does NOT trim a leading narration-like line while still streaming', () => {
    const { container } = renderMessageList([
      makeMessage({ content: 'Let me check that for you.\n\nThe answer is 4', isStreaming: true }),
    ]);
    expect(container.textContent).toContain('Let me check that for you.');
  });
});

// ── MessageList — Apply-gating (DEFECT 2) ──────────────────────────────
//
// Owner-verified defect: every assistant code block offered a one-click
// Apply that could send a PARTIAL/ILLUSTRATIVE snippet to a GUESSED file.
// Rule under test (see canOfferApply's doc comment in MessageList.tsx):
// Apply/Reject show ONLY when mode !== 'ask' AND the block carries an
// EXPLICIT target (from the fence's own info string — never prose-guessed).

describe('MessageList — Apply-gating (DEFECT 2)', () => {
  // Pin locale to 'fr' (the app's actual default) so button-label assertions
  // match known copy instead of jsdom's navigator.language fallback ('en')
  // — same convention as the "thinking / tool-call steps" suite above.
  beforeEach(() => {
    localStorage.setItem('lazy.locale', 'fr');
    vi.mocked(emit).mockClear();
  });

  afterEach(() => {
    localStorage.removeItem('lazy.locale');
  });

  it('Ask-mode code block shows Copy but NOT Apply/Reject, even with an explicit fence target', () => {
    const msg = makeMessage({
      content: 'Here is an illustrative example:',
      mode: 'ask',
      codeBlock: { language: 'ts', code: 'const x = 1;', targetPath: 'src/example.ts' },
    });
    renderMessageList([msg]);

    expect(screen.getByTitle('Copier')).toBeInTheDocument();
    expect(screen.queryByText('Appliquer')).toBeNull();
    expect(screen.queryByText('Rejeter')).toBeNull();
  });

  it('a block with an explicit filename target in a non-ask mode offers Apply, and clicking it emits editor:applyEdit with that exact target (the ApplyEditModal diff flow)', () => {
    const msg = makeMessage({
      content: 'Applying this change:',
      mode: 'edit',
      codeBlock: { language: 'ts', code: 'const x = 1;', targetPath: 'src/example.ts' },
    });
    renderMessageList([msg]);

    const applyButton = screen.getByText('Appliquer');
    expect(applyButton).toBeInTheDocument();
    expect(screen.getByText('Rejeter')).toBeInTheDocument();

    fireEvent.click(applyButton);

    // Same 'editor:applyEdit' bus event CodeSpace.tsx already listens on to
    // open ApplyEditModal — this test does not change/bypass that flow, it
    // only proves the button now only fires with a REAL, explicit target.
    expect(emit).toHaveBeenCalledWith('editor:applyEdit', {
      proposedContent: 'const x = 1;',
      language: 'ts',
      path: 'src/example.ts',
    });
  });

  it('plan mode with an explicit target also offers Apply — the gate is mode !== "ask", not an allowlist of specific modes', () => {
    const msg = makeMessage({
      content: 'Proposed plan change:',
      mode: 'plan',
      codeBlock: { language: 'ts', code: 'const x = 1;', targetPath: 'src/example.ts' },
    });
    renderMessageList([msg]);
    expect(screen.getByText('Appliquer')).toBeInTheDocument();
  });

  it('a non-ask mode block with NO explicit fence target stays Copy-only (no guessing)', () => {
    const msg = makeMessage({
      content: 'Mentions src/somewhere/else.ts in prose, but the fence names nothing.',
      mode: 'edit',
      codeBlock: { language: 'ts', code: 'const x = 1;' },
    });
    renderMessageList([msg]);

    expect(screen.getByTitle('Copier')).toBeInTheDocument();
    expect(screen.queryByText('Appliquer')).toBeNull();
  });

  it('never derives a target by scanning prose for a path-looking string (extractTargetPath is gone)', () => {
    const msg = makeMessage({
      content: 'You should edit src/components/Foo.tsx to fix this, for example:',
      mode: 'edit',
      codeBlock: { language: 'ts', code: 'const x = 1;' },
    });
    renderMessageList([msg]);
    expect(screen.queryByText('Appliquer')).toBeNull();
  });

  it('a message with no recorded mode (e.g. reloaded history) defaults to the safe Copy-only behavior', () => {
    const msg = makeMessage({
      content: 'Some historical answer.',
      codeBlock: { language: 'ts', code: 'const x = 1;', targetPath: 'src/example.ts' },
    });
    renderMessageList([msg]);
    expect(screen.queryByText('Appliquer')).toBeNull();
  });

  it('gates the same way for a SECOND code fence embedded directly in the markdown body (not just the extracted codeBlock)', () => {
    const msg = makeMessage({
      content: 'Ask-mode text.\n\n```ts src/second.ts\nconst y = 2;\n```',
      mode: 'ask',
    });
    renderMessageList([msg]);
    expect(screen.queryByText('Appliquer')).toBeNull();
    expect(screen.getByTitle('Copier')).toBeInTheDocument();
  });

  it('an embedded code fence WITH an explicit target in edit mode offers Apply too', () => {
    const msg = makeMessage({
      content: 'Edit-mode text.\n\n```ts src/second.ts\nconst y = 2;\n```',
      mode: 'edit',
    });
    renderMessageList([msg]);
    expect(screen.getByText('Appliquer')).toBeInTheDocument();
  });
});

describe('canOfferApply (pure gating predicate)', () => {
  it('is false for ask mode regardless of target', () => {
    expect(canOfferApply('ask', 'src/foo.ts')).toBe(false);
    expect(canOfferApply('ask', undefined)).toBe(false);
  });

  it('is false for non-ask modes without a target', () => {
    expect(canOfferApply('edit', undefined)).toBe(false);
    expect(canOfferApply('plan', undefined)).toBe(false);
    expect(canOfferApply('transform', undefined)).toBe(false);
  });

  it('is true for any non-ask mode WITH a target', () => {
    expect(canOfferApply('edit', 'src/foo.ts')).toBe(true);
    expect(canOfferApply('plan', 'src/foo.ts')).toBe(true);
    expect(canOfferApply('transform', 'src/foo.ts')).toBe(true);
  });
});

describe('trimLeadingNarration (pure, DEFECT 3)', () => {
  it('trims "Je vais ..." when followed by a blank line', () => {
    expect(trimLeadingNarration('Je vais analyser le code.\n\nVoici le résultat.')).toBe('Voici le résultat.');
  });

  it('trims "Let me ..." when followed by a blank line', () => {
    expect(trimLeadingNarration('Let me check that.\n\nHere is the answer.')).toBe('Here is the answer.');
  });

  it('leaves content unchanged when there is no blank line after the first line', () => {
    const content = 'Let me walk you through this step by step:\nFirst, we open the file.';
    expect(trimLeadingNarration(content)).toBe(content);
  });

  it('leaves a long first line unchanged even if it starts with "Let me" — avoids cutting real content', () => {
    const longFirstLine = `Let me ${'x'.repeat(120)}`;
    const content = `${longFirstLine}\n\nSecond paragraph.`;
    expect(trimLeadingNarration(content)).toBe(content);
  });

  it('leaves single-line content unchanged (nothing to trim into)', () => {
    expect(trimLeadingNarration('Let me help.')).toBe('Let me help.');
  });

  it('leaves content unchanged when the first line is not a recognized narration opener', () => {
    const content = 'Here is the answer.\n\nMore detail follows.';
    expect(trimLeadingNarration(content)).toBe(content);
  });
});
