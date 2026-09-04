/**
 * composerPreflight.test.tsx
 *
 * v0.1.5 W2.3 — engine preflight before sending from the assistant composer.
 * When the selected engine is not ready, sending is prevented (the draft text
 * stays), a single inline one-line notice appears above the composer with the
 * same reason copy as the mission preflight plus a "Configurer" link (same
 * navigation mechanism as W2.2). Never a toast, never stacked notices.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { Composer } from '../components/assistant/Composer';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui';
import { fr } from '../i18n/locales/fr';
import { getEngineReadiness } from '../lib/models/entitlement';
import { emit } from '../lib/bus';

const mockSend = vi.fn();
const mockAbortStream = vi.fn();

// Plain-object store double (not vi.fn()-based) so individual tests can swap
// `isStreaming` to exercise the composer-send/composer-stop swap — see the
// "inline send/stop anchor" describe block below. Fresh object per test via
// beforeEach so overrides never leak across tests.
function makeDefaultStoreState() {
  return {
    send: mockSend,
    isStreaming: false,
    abortStream: mockAbortStream,
    selectedMode: 'ask',
    selectedModel: { id: 'claude-haiku-4-5', label: 'Haiku 4.5', provider: 'anthropic' },
    setMode: vi.fn(),
    setModel: vi.fn(),
    brainEnabled: false,
    toggleBrain: vi.fn(),
    selectedScope: 'current',
    setScope: vi.fn(),
    compactConversation: vi.fn(() => ({ foldedTurns: 0 })),
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
  useAppContext: () => ({ platform: { name: 'web' }, projectRoot: '' }),
}));

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
}));

const mockedReadiness = vi.mocked(getEngineReadiness);
const mockedEmit = vi.mocked(emit);

function renderComposer() {
  render(
    <I18nProvider>
      <ToastProvider>
        <Composer onLaunchAgent={() => {}} />
      </ToastProvider>
    </I18nProvider>,
  );
}

function typeAndSend(message = 'Bonjour Lazy') {
  const textarea = screen.getByPlaceholderText(fr['assistant.composerPlaceholder']);
  fireEvent.change(textarea, { target: { value: message } });
  fireEvent.keyDown(textarea, { key: 'Enter' });
  return textarea as HTMLTextAreaElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
  mockedReadiness.mockReturnValue({ mode: 'cli', ready: true });
  mockStoreState = makeDefaultStoreState();
});

describe('Composer — engine preflight', () => {
  it('not ready: send is prevented, the draft stays, and the reason notice appears', () => {
    mockedReadiness.mockReturnValue({ mode: 'cli', ready: false, reason: 'cli-not-found' });
    renderComposer();

    const textarea = typeAndSend('Mon brouillon');

    expect(mockSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Mon brouillon');
    const notice = screen.getByTestId('composer-preflight-notice');
    expect(notice).toHaveTextContent(fr['engine.reason.cli-not-found']);
  });

  it('never stacks: two blocked attempts still render exactly one notice', () => {
    mockedReadiness.mockReturnValue({ mode: 'byok', ready: false, reason: 'byok-no-key' });
    renderComposer();

    typeAndSend('Premier essai');
    typeAndSend('Deuxième essai');

    expect(screen.getAllByTestId('composer-preflight-notice')).toHaveLength(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('"Configurer" navigates to Settings > Models for engine reasons', () => {
    mockedReadiness.mockReturnValue({ mode: 'cli', ready: false, reason: 'cli-not-found' });
    renderComposer();

    typeAndSend();
    fireEvent.click(screen.getByTestId('composer-preflight-configure'));

    expect(mockedEmit).toHaveBeenCalledWith('nav:navigateSpace', 'models');
  });

  it('"Configurer" navigates to Settings > Account for Pro entitlement reasons', () => {
    mockedReadiness.mockReturnValue({ mode: 'pro', ready: false, reason: 'pro-no-credits' });
    renderComposer();

    typeAndSend();
    fireEvent.click(screen.getByTestId('composer-preflight-configure'));

    expect(mockedEmit).toHaveBeenCalledWith('nav:navigateSpace', 'account');
  });

  it('ready: sending proceeds and the notice disappears after a previously blocked attempt', () => {
    mockedReadiness.mockReturnValueOnce({ mode: 'cli', ready: false, reason: 'cli-not-found' });
    renderComposer();

    typeAndSend('Message final');
    expect(screen.getByTestId('composer-preflight-notice')).toBeInTheDocument();

    mockedReadiness.mockReturnValue({ mode: 'cli', ready: true });
    const textarea = screen.getByPlaceholderText(fr['assistant.composerPlaceholder']);
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('composer-preflight-notice')).not.toBeInTheDocument();
  });
});

describe('Composer — inline send/stop anchor', () => {
  it('anchors the send button inside the textarea field, at the wrapper right edge', () => {
    renderComposer();

    const sendBtn = screen.getByTestId('composer-send');
    const wrapper = sendBtn.parentElement;

    expect(wrapper).not.toBeNull();
    expect(wrapper?.contains(sendBtn)).toBe(true);
    expect(wrapper?.querySelector('textarea')).not.toBeNull();
    expect(wrapper?.style.position).toBe('relative');
  });

  it('swaps to the stop button inside the same wrapper while streaming, and Stop aborts', () => {
    mockStoreState = { ...makeDefaultStoreState(), isStreaming: true };
    renderComposer();

    expect(screen.queryByTestId('composer-send')).not.toBeInTheDocument();
    const stopBtn = screen.getByTestId('composer-stop');
    const wrapper = stopBtn.parentElement;

    expect(wrapper?.contains(stopBtn)).toBe(true);
    expect(wrapper?.querySelector('textarea')).not.toBeNull();
    expect(wrapper?.style.position).toBe('relative');

    fireEvent.click(stopBtn);
    expect(mockAbortStream).toHaveBeenCalledTimes(1);
  });
});
