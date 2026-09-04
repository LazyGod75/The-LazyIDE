/* IndexingBanner — background auto-index progress indicator.
   Verifies the honest phase contract (started / done / failed, no fake
   percentages) driven by the `brain://indexing` Tauri event, the
   onIndexed() refresh callback firing only on success, manual dismiss, and
   listener cleanup on unmount.
*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { IndexingBanner } from '../components/brain/IndexingBanner';

interface IndexingEventPayload {
  status: 'started' | 'done' | 'failed';
  notes?: number;
}
type ListenHandler = (event: { payload: IndexingEventPayload }) => void;

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(),
}));

// Passthrough i18n mock — key + interpolated params, decoupled from actual
// locale copy (same convention as BrainContextBanner.test.tsx). `locale`
// is fixed to 'en' so pluralKey()'s One/Many key selection (see
// lib brain.indexing.done -> doneOne/doneMany) is deterministic here.
vi.mock('../i18n', () => {
  const context = {
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
    locale: 'en',
  };
  return {
    useI18n: () => context,
    // Spinner (components/ui/Skeleton.tsx, rendered while phase === 'started')
    // uses useI18nOptional, not useI18n — must be present here too.
    useI18nOptional: () => context,
  };
});

let capturedHandler: ListenHandler | null = null;
// A fresh spy per listen() call (not one shared const) — each test's
// render() gets its own unlisten function, so assertions on call count
// never leak across tests regardless of afterEach/cleanup ordering.
let capturedUnlisten: ReturnType<typeof vi.fn> | null = null;

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_eventName: string, handler: ListenHandler) => {
    capturedHandler = handler;
    capturedUnlisten = vi.fn();
    return Promise.resolve(capturedUnlisten);
  }),
}));

import { getPlatform } from '../lib/platform';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

function makeTauriPlatform() {
  return { name: 'tauri' };
}
function makeWebPlatform() {
  return { name: 'web' };
}

async function fireIndexingEvent(payload: IndexingEventPayload) {
  await waitFor(() => expect(capturedHandler).not.toBeNull());
  act(() => {
    capturedHandler?.({ payload });
  });
}

afterEach(() => {
  vi.clearAllMocks();
  capturedHandler = null;
  capturedUnlisten = null;
});

describe('IndexingBanner — platform gating', () => {
  it('renders nothing on the web platform (no Tauri event bridge)', () => {
    mockGetPlatform.mockReturnValue(makeWebPlatform());
    const { container } = render(<IndexingBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing before any brain://indexing event arrives', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    const { container } = render(<IndexingBanner />);
    expect(container.firstChild).toBeNull();
  });
});

describe('IndexingBanner — phase rendering (honest, no fake percentages)', () => {
  it('shows the started label on a "started" event', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<IndexingBanner />);

    await fireIndexingEvent({ status: 'started' });

    expect(screen.getByText('brain.indexing.started')).toBeInTheDocument();
  });

  it('shows the done label with the real note count on a "done" event', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<IndexingBanner />);

    await fireIndexingEvent({ status: 'done', notes: 7 });

    expect(screen.getByText('brain.indexing.doneMany:7')).toBeInTheDocument();
  });

  it('shows 0 notes when a "done" event omits the count rather than guessing', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<IndexingBanner />);

    await fireIndexingEvent({ status: 'done' });

    expect(screen.getByText('brain.indexing.doneMany:0')).toBeInTheDocument();
  });

  it('picks the SINGULAR key for exactly one indexed note (no "1 notes" agreement bug)', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<IndexingBanner />);

    await fireIndexingEvent({ status: 'done', notes: 1 });

    expect(screen.getByText('brain.indexing.doneOne:1')).toBeInTheDocument();
  });

  it('shows the failed label on a "failed" event', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<IndexingBanner />);

    await fireIndexingEvent({ status: 'failed' });

    expect(screen.getByText('brain.indexing.failed')).toBeInTheDocument();
  });

  it('transitions from started to done as real events arrive in sequence', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<IndexingBanner />);

    await fireIndexingEvent({ status: 'started' });
    expect(screen.getByText('brain.indexing.started')).toBeInTheDocument();

    await fireIndexingEvent({ status: 'done', notes: 3 });
    expect(screen.queryByText('brain.indexing.started')).toBeNull();
    expect(screen.getByText('brain.indexing.doneMany:3')).toBeInTheDocument();
  });
});

describe('IndexingBanner — onIndexed refresh callback', () => {
  it('calls onIndexed exactly once when a "done" event arrives', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    const onIndexed = vi.fn();
    render(<IndexingBanner onIndexed={onIndexed} />);

    await fireIndexingEvent({ status: 'done', notes: 5 });

    expect(onIndexed).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onIndexed on "started"', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    const onIndexed = vi.fn();
    render(<IndexingBanner onIndexed={onIndexed} />);

    await fireIndexingEvent({ status: 'started' });

    expect(onIndexed).not.toHaveBeenCalled();
  });

  it('does NOT call onIndexed on "failed" — nothing new to refresh', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    const onIndexed = vi.fn();
    render(<IndexingBanner onIndexed={onIndexed} />);

    await fireIndexingEvent({ status: 'failed' });

    expect(onIndexed).not.toHaveBeenCalled();
  });
});

describe('IndexingBanner — dismiss + cleanup', () => {
  it('clicking the close button hides the banner', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<IndexingBanner />);

    await fireIndexingEvent({ status: 'started' });
    expect(screen.getByText('brain.indexing.started')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button'));

    expect(screen.queryByText('brain.indexing.started')).toBeNull();
  });

  it('unsubscribes from the Tauri event on unmount', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    const { unmount } = render(<IndexingBanner />);

    await waitFor(() => expect(capturedHandler).not.toBeNull());
    const unlistenForThisRender = capturedUnlisten;
    unmount();

    expect(unlistenForThisRender).toHaveBeenCalledTimes(1);
  });
});
