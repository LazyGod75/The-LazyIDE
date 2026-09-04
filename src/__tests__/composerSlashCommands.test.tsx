/**
 * composerSlashCommands.test.tsx
 *
 * Branches slashCommands.ts (SLASH_COMMANDS registry) into the assistant
 * Composer: typing "/" at the start of the message opens a filterable
 * command picker, and sending a recognized command dispatches it locally
 * (via slashCommandExecutor.ts) instead of reaching the model.
 *
 * Same store-double harness as composerPreflight.test.tsx (mocks
 * useAssistantStore/useAppContext/lib.bus as plain objects rather than a
 * real AssistantStoreProvider tree) — extended with the store fields the
 * slash dispatcher needs (clearConversation, chatSessions, loadChatSession).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { Composer } from '../components/assistant/Composer';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui';
import { fr } from '../i18n/locales/fr';
import { getEngineReadiness } from '../lib/models/entitlement';

const mockSend = vi.fn();
const mockClearConversation = vi.fn();
const mockLoadChatSession = vi.fn();

function makeDefaultStoreState() {
  return {
    send: mockSend,
    isStreaming: false,
    abortStream: vi.fn(),
    selectedMode: 'ask',
    selectedModel: { id: 'claude-haiku-4-5', label: 'Haiku 4.5', provider: 'anthropic' },
    setMode: vi.fn(),
    setModel: vi.fn(),
    brainEnabled: false,
    toggleBrain: vi.fn(),
    selectedScope: 'current',
    setScope: vi.fn(),
    clearConversation: mockClearConversation,
    compactConversation: vi.fn(() => ({ foldedTurns: 0 })),
    chatSessions: [] as Array<{ id: string }>,
    loadChatSession: mockLoadChatSession,
  };
}

let mockStoreState = makeDefaultStoreState();

vi.mock('../lib/models/entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/entitlement')>();
  return { ...actual, getEngineReadiness: vi.fn() };
});

vi.mock('../components/assistant/assistantStore', () => ({
  useAssistantStore: () => mockStoreState,
  useAssistantStoreOptional: () => mockStoreState,
}));

vi.mock('../app/AppContext', () => ({
  useAppContext: () => ({ platform: { name: 'web', brain: { search: vi.fn(async () => []) } }, projectRoot: '' }),
}));

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
}));

const mockedReadiness = vi.mocked(getEngineReadiness);

function renderComposer() {
  render(
    <I18nProvider>
      <ToastProvider>
        <Composer onLaunchAgent={() => {}} />
      </ToastProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
  mockedReadiness.mockReturnValue({ mode: 'cli', ready: true });
  mockStoreState = makeDefaultStoreState();
});

function getTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(fr['assistant.composerPlaceholder']) as HTMLTextAreaElement;
}

describe('Composer — slash command picker', () => {
  it('opens the picker on a bare "/" and lists the declared commands', () => {
    renderComposer();
    fireEvent.change(getTextarea(), { target: { value: '/' } });

    expect(screen.getByTestId('slash-command-picker')).toBeInTheDocument();
    expect(screen.getByTestId('slash-command-item-clear')).toBeInTheDocument();
    expect(screen.getByTestId('slash-command-item-docs')).toBeInTheDocument();
  });

  it('filters live as the command name narrows', () => {
    renderComposer();
    fireEvent.change(getTextarea(), { target: { value: '/doc' } });

    expect(screen.getByTestId('slash-command-item-docs')).toBeInTheDocument();
    expect(screen.queryByTestId('slash-command-item-clear')).not.toBeInTheDocument();
  });

  it('closes once a space is typed after the command token', () => {
    renderComposer();
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: '/clear' } });
    expect(screen.getByTestId('slash-command-picker')).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: '/clear ' } });
    expect(screen.queryByTestId('slash-command-picker')).not.toBeInTheDocument();
  });

  it('clicking a suggestion inserts "/name " and keeps focus, without sending', () => {
    renderComposer();
    fireEvent.change(getTextarea(), { target: { value: '/doc' } });
    fireEvent.click(screen.getByTestId('slash-command-item-docs-add'));

    expect(getTextarea().value).toBe('/docs-add ');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Escape closes the picker without touching the draft', () => {
    renderComposer();
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: '/cle' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(screen.queryByTestId('slash-command-picker')).not.toBeInTheDocument();
    expect(textarea.value).toBe('/cle');
  });
});

describe('Composer — sending a slash command', () => {
  // "/clear" alone still has exactly one filter match ("clear" itself) while
  // it has no trailing space, so the FIRST Enter is consumed by the picker
  // (completes it to "/clear ", same as picking it by mouse — see the
  // "Composer — slash command picker" describe block above); the picker
  // then closes (trailing space), and a SECOND Enter actually sends/
  // executes it. Mirrors this composer's own @-mention convention (see
  // LazyManagerComposer.test.tsx's "ArrowDown then Enter selects... does
  // not send").
  it('/clear calls clearConversation, never reaches send(), and clears the draft', async () => {
    renderComposer();
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: '/clear' } });
    fireEvent.keyDown(textarea, { key: 'Enter' }); // picker: completes to "/clear "
    expect(textarea.value).toBe('/clear ');
    expect(screen.queryByTestId('slash-command-picker')).not.toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'Enter' }); // now actually sends/executes
    await waitFor(() => expect(mockClearConversation).toHaveBeenCalledOnce());
    expect(mockSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('');
  });

  it('/clear works even when the engine is not ready (slash commands bypass the preflight)', async () => {
    mockedReadiness.mockReturnValue({ mode: 'cli', ready: false, reason: 'cli-not-found' });
    renderComposer();
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: '/clear' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(mockClearConversation).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('composer-preflight-notice')).not.toBeInTheDocument();
  });

  it('/compact runs locally and shows the compact-nothing toast when there is no history', async () => {
    renderComposer();
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: '/compact' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(fr['assistant.slashCommands.compactNothing'])).toBeInTheDocument();
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an unrecognized command has NO picker match, so a single Enter sends it straight through and shows the unknown-command toast', async () => {
    renderComposer();
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: '/nope' } });
    expect(screen.getByTestId('slash-command-picker')).toHaveTextContent(fr['assistant.slashPicker.noMatches']);

    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(fr['assistant.slashCommands.unknown'])).toBeInTheDocument();
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('');
  });

  it('a normal (non-slash) message still sends to the model as before', () => {
    renderComposer();
    const textarea = getTextarea();
    fireEvent.change(textarea, { target: { value: 'Bonjour Lazy' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(mockSend).toHaveBeenCalledWith('Bonjour Lazy');
    expect(mockClearConversation).not.toHaveBeenCalled();
  });
});
