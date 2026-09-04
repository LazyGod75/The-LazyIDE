import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CodeSidebarBrain } from '../components/editor/codespace/CodeSidebarBrain';
import type { Platform } from '../lib/platform/types';

// B24: the "no neuron linked" empty state used to be a dead end. It must now
// offer a REAL capture affordance — a genuine platform.brain.capture() call,
// not a fake/simulated success — with honest success/failure feedback.

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

const toastSpy = vi.fn();
vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    name: 'tauri',
    fs: { readFile: vi.fn().mockResolvedValue('const x = 1;\nconst y = 2;') },
    brain: {
      tree: vi.fn().mockResolvedValue({ projects: [] }), // no match -> noneLinked
      capture: vi.fn().mockResolvedValue({ id: 'note-1', path: '/brain/note-1', sizeBytes: 42, attrsCount: 3 }),
    },
    ...overrides,
  } as unknown as Platform;
}

describe('CodeSidebarBrain — B24 capture affordance', () => {
  it('shows the capture button in the "no neuron linked" empty state', async () => {
    const platform = makePlatform();
    render(
      <CodeSidebarBrain
        platform={platform}
        activeFilePath="/repo/src/cart.js"
        activeFileRoot="/repo"
        onOpenNeuron={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('codespace.brain.noneLinked')).toBeInTheDocument());
    expect(screen.getByText('codespace.brain.captureAffordance')).toBeInTheDocument();
  });

  it('does not show the capture button once a neuron is already linked', async () => {
    const platform = makePlatform({
      brain: {
        tree: vi.fn().mockResolvedValue({
          projects: [{ label: 'cart.js', type: 'code', noteId: 'n1', children: [] }],
        }),
        capture: vi.fn(),
      },
    } as never);
    render(
      <CodeSidebarBrain
        platform={platform}
        activeFilePath="/repo/cart.js"
        activeFileRoot="/repo"
        onOpenNeuron={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('cart.js')).toBeInTheDocument());
    expect(screen.queryByText('codespace.brain.captureAffordance')).not.toBeInTheDocument();
  });

  it('calls platform.brain.capture with real file context and toasts success', async () => {
    const platform = makePlatform();
    render(
      <CodeSidebarBrain
        platform={platform}
        activeFilePath="/repo/src/cart.js"
        activeFileRoot="/repo"
        onOpenNeuron={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('codespace.brain.captureAffordance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('codespace.brain.captureAffordance'));

    await waitFor(() => expect(platform.brain.capture).toHaveBeenCalledTimes(1));
    const event = (platform.brain.capture as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.files).toEqual(['/repo/src/cart.js']);
    expect(event.kind).toBe('edit');
    expect(event.text).toMatch(/const x = 1;/);

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('codespace.brain.captureSuccess', 'success', 2500));
  });

  it('toasts an honest failure message when capture rejects (never a fake success)', async () => {
    const platform = makePlatform({
      brain: {
        tree: vi.fn().mockResolvedValue({ projects: [] }),
        capture: vi.fn().mockRejectedValue(new Error('sidecar unreachable')),
      },
    } as never);
    render(
      <CodeSidebarBrain
        platform={platform}
        activeFilePath="/repo/src/cart.js"
        activeFileRoot="/repo"
        onOpenNeuron={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('codespace.brain.captureAffordance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('codespace.brain.captureAffordance'));

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(
      expect.stringMatching(/codespace\.brain\.captureFailed:.*sidecar unreachable/),
      'error',
    ));
    expect(screen.queryByText(/captureSuccess/)).not.toBeInTheDocument();
  });

  it('still proceeds with capture when reading the file for context fails (best-effort only)', async () => {
    const platform = makePlatform({
      fs: { readFile: vi.fn().mockRejectedValue(new Error('read error')) },
      brain: {
        tree: vi.fn().mockResolvedValue({ projects: [] }),
        capture: vi.fn().mockResolvedValue({ id: 'note-2', path: '/brain/note-2', sizeBytes: 10, attrsCount: 1 }),
      },
    } as never);
    render(
      <CodeSidebarBrain
        platform={platform}
        activeFilePath="/repo/src/cart.js"
        activeFileRoot="/repo"
        onOpenNeuron={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('codespace.brain.captureAffordance')).toBeInTheDocument());
    fireEvent.click(screen.getByText('codespace.brain.captureAffordance'));

    await waitFor(() => expect(platform.brain.capture).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('codespace.brain.captureSuccess', 'success', 2500));
  });
});
