import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiReview } from '../components/git/AiReview';
import { saveAccessSettings } from '../lib/models/accessSettings';
import { DEFAULT_MODEL, findModelById } from '../lib/models/registry';
import type { StreamChatRequest } from '../lib/models';
import { I18nProvider } from '../i18n';

// AiReview now calls useI18n() (2026-08 i18n wave — threads `t` into
// describeProviderReadiness/getProvider so their fallback copy translates
// instead of always rendering French), so it needs an I18nProvider
// ancestor to render at all.
function renderAiReview(diff: string) {
  return render(<I18nProvider><AiReview diff={diff} /></I18nProvider>);
}

// getActiveModel() (DEFECT #1's fix) is left REAL via importOriginal — only
// provider selection is mocked, so these tests prove genuine dynamic
// resolution instead of a mocked pass-through.
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProvider: vi.fn(),
    describeProviderReadiness: vi.fn(() => ({ ready: true })),
  };
});

import { getProvider } from '../lib/models/index';

function mockStreamChat(capture: { request: StreamChatRequest | null }) {
  vi.mocked(getProvider).mockReturnValue({
    id: 'mock',
    label: 'Mock',
    listModels: () => [],
    streamChat: (req: StreamChatRequest) => {
      capture.request = req;
      return (async function* () {
        yield '{"summary":"looks fine","issues":[],"suggestions":[]}';
      })();
    },
  });
}

beforeEach(() => {
  localStorage.clear();
});

// AiReview.tsx is the same latent bug as InlineEditBar.tsx (DEFECT #1's
// "sibling hardcode") — it hardcoded the same stale 'claude-sonnet-4-20250514'
// literal at AiReview.tsx:45, breaking AI code review identically under
// Claude Code CLI.

describe('AiReview — model resolution (DEFECT #1, sibling hardcode)', () => {
  it('sends the resolved active model to streamChat, not the stale hardcoded literal', async () => {
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    renderAiReview("diff --git a/foo.ts b/foo.ts");

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(capture.request).not.toBeNull());
    expect(capture.request?.model).toEqual(DEFAULT_MODEL);
    expect(capture.request?.model.id).not.toBe('claude-sonnet-4-20250514');
  });

  it('honors a persisted model override instead of a hardcoded literal', async () => {
    saveAccessSettings({ model: 'claude-opus-5' });
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    renderAiReview("diff --git a/foo.ts b/foo.ts");

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(capture.request).not.toBeNull());
    expect(capture.request?.model).toEqual(findModelById('claude-opus-5'));
  });

  it('renders the parsed review summary once the (mocked) stream completes', async () => {
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    renderAiReview("diff --git a/foo.ts b/foo.ts");

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByText('looks fine')).toBeInTheDocument());
  });
});
