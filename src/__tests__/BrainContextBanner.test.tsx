import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { BrainContextBanner } from '../components/assistant/BrainContextBanner';

// Mock the event bus so emit() does not trigger Tauri
vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(),
}));

// BrainContextBanner now calls useI18n() unconditionally too (for the FIX 1b
// toast copy). Mocked with a minimal passthrough `t()` that still
// interpolates params into the returned string, so assertions on the toast
// message text (e.g. the note title) keep working without a real I18nProvider.
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

// BrainContextBanner now calls useToast() unconditionally (FIX 1b — surfaces
// capture-retry give-up notices). Mocked here rather than wrapping every
// render() call in <ToastProvider>, matching MissionDetail.test.tsx's
// existing convention for components that need useToast() in tests.
const toastSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Captures the onCaptureGiveUp callback so tests can simulate a give-up
// event directly, decoupled from captureQueue's actual retry/backoff
// timing — that logic has its own dedicated coverage in
// captureQueue.test.ts.
let giveUpCallback: ((event: { title: string }) => void) | null = null;
vi.mock('../lib/brain/captureQueue', () => ({
  onCaptureGiveUp: vi.fn((cb: (event: { title: string }) => void) => {
    giveUpCallback = cb;
    return () => { giveUpCallback = null; };
  }),
}));

import { getPlatform } from '../lib/platform';
import { emit } from '../lib/bus';

const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;
const mockEmit = emit as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
});

function makeWebPlatform() {
  return { name: 'web' };
}

function makeTauriPlatform() {
  return { name: 'tauri' };
}

/** Tauri platform whose brain.info() resolves with a given resolution
    source — used by the ENV-OVERRIDE TRANSPARENCY tests below. */
function makeTauriPlatformWithInfo(source: 'env_override' | 'project' | 'home_fallback') {
  return {
    name: 'tauri',
    brain: {
      info: vi.fn().mockResolvedValue({ path: '/mock/brain', source, noteCount: 4, isEmpty: false }),
    },
  };
}

const REAL_RECALL = {
  nodes: [
    { id: 'real-node', title: 'Real Neuron', snippet: 'Real snippet', score: 0.9, cluster: 'editor' },
  ],
  tokensSaved: 1000,
  tokensInjected: 3,
  injectedContext: '1 decision',
};

describe('BrainContextBanner — platform branching', () => {
  describe('web platform + null recall (no brain available)', () => {
    it('does NOT show mock "auth-oauth" node', () => {
      mockGetPlatform.mockReturnValue(makeWebPlatform());
      render(<BrainContextBanner recall={null} />);
      expect(screen.queryByText(/#auth-oauth/)).toBeNull();
    });

    it('does NOT show "demo data" badge', () => {
      mockGetPlatform.mockReturnValue(makeWebPlatform());
      render(<BrainContextBanner recall={null} />);
      expect(screen.queryByText(/demo data/i)).toBeNull();
    });

    it('shows empty neurons message', () => {
      mockGetPlatform.mockReturnValue(makeWebPlatform());
      render(<BrainContextBanner recall={null} />);
      expect(screen.getByText('assistant.brainContext.empty')).toBeInTheDocument();
    });
  });

  describe('web platform + real recall', () => {
    it('shows the real node id', () => {
      mockGetPlatform.mockReturnValue(makeWebPlatform());
      render(<BrainContextBanner recall={REAL_RECALL} />);
      expect(screen.getByText(/#real-node/)).toBeInTheDocument();
    });

    it('does NOT show "demo data" badge when real recall is present', () => {
      mockGetPlatform.mockReturnValue(makeWebPlatform());
      render(<BrainContextBanner recall={REAL_RECALL} />);
      expect(screen.queryByText(/demo data/i)).toBeNull();
    });
  });

  describe('tauri platform + null recall (desktop empty state)', () => {
    it('does NOT render the fake "auth-oauth" node', () => {
      mockGetPlatform.mockReturnValue(makeTauriPlatform());
      render(<BrainContextBanner recall={null} />);
      expect(screen.queryByText(/#auth-oauth/)).toBeNull();
    });

    it('does NOT show "demo data" badge', () => {
      mockGetPlatform.mockReturnValue(makeTauriPlatform());
      render(<BrainContextBanner recall={null} />);
      expect(screen.queryByText(/demo data/i)).toBeNull();
    });

    it('shows the empty neurons message', () => {
      mockGetPlatform.mockReturnValue(makeTauriPlatform());
      render(<BrainContextBanner recall={null} />);
      expect(screen.getByText('assistant.brainContext.empty')).toBeInTheDocument();
    });
  });

  describe('tauri platform + real recall', () => {
    it('shows the real node id', () => {
      mockGetPlatform.mockReturnValue(makeTauriPlatform());
      render(<BrainContextBanner recall={REAL_RECALL} />);
      expect(screen.getByText(/#real-node/)).toBeInTheDocument();
    });

    it('does NOT show "demo data" badge', () => {
      mockGetPlatform.mockReturnValue(makeTauriPlatform());
      render(<BrainContextBanner recall={REAL_RECALL} />);
      expect(screen.queryByText(/demo data/i)).toBeNull();
    });
  });

  describe('error banner text (QA bug #2 — doubled brain-context label prefix)', () => {
    it('renders the brain-context label exactly once when brainError is set', () => {
      mockGetPlatform.mockReturnValue(makeWebPlatform());
      const { container } = render(
        <BrainContextBanner
          recall={null}
          brainError="Mémoire indisponible: brain command timed out after 30s"
        />
      );
      const fullText = container.textContent ?? '';
      const occurrences = fullText.match(/assistant\.brainContext\.label/g) ?? [];
      expect(occurrences).toHaveLength(1);
      expect(fullText).toContain('assistant.brainContext.label');
      expect(fullText).toContain('erreur');
      expect(fullText).not.toMatch(/assistant\.brainContext\.label\s*assistant\.brainContext\.label/);
    });

    it('still shows the detailed error message below the summary label', () => {
      mockGetPlatform.mockReturnValue(makeWebPlatform());
      render(
        <BrainContextBanner
          recall={null}
          brainError="Mémoire indisponible: brain command timed out after 30s"
        />
      );
      expect(screen.getByText(/Mémoire indisponible: brain command timed out after 30s/)).toBeInTheDocument();
    });
  });
});

describe('BrainContextBanner — capture give-up toast (FIX 1b)', () => {
  it('subscribes to onCaptureGiveUp on mount', () => {
    mockGetPlatform.mockReturnValue(makeWebPlatform());
    render(<BrainContextBanner recall={null} />);
    expect(giveUpCallback).not.toBeNull();
  });

  it('shows a warning toast with the note title when captureQueue reports a give-up', () => {
    mockGetPlatform.mockReturnValue(makeWebPlatform());
    render(<BrainContextBanner recall={null} />);

    giveUpCallback?.({ title: 'Edit: foo.ts' });

    expect(toastSpy).toHaveBeenCalledTimes(1);
    const [message, type, duration] = toastSpy.mock.calls[0];
    expect(message).toContain('Edit: foo.ts');
    expect(type).toBe('warning');
    expect(duration).toBe(6000);
  });

  it('still fires the toast even while the banner itself is hidden (brainEnabled=false)', () => {
    // Regression guard: the onCaptureGiveUp subscription lives in a hook
    // called BEFORE the brainEnabled early return, precisely so this keeps
    // working — capture failures are unrelated to whether the recall UI is
    // currently shown.
    mockGetPlatform.mockReturnValue(makeWebPlatform());
    const { container } = render(<BrainContextBanner recall={null} brainEnabled={false} />);
    expect(container.firstChild).toBeNull();

    giveUpCallback?.({ title: 'Edit: bar.ts' });

    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][0]).toContain('Edit: bar.ts');
  });

  it('unsubscribes on unmount', () => {
    mockGetPlatform.mockReturnValue(makeWebPlatform());
    const { unmount } = render(<BrainContextBanner recall={null} />);
    expect(giveUpCallback).not.toBeNull();
    unmount();
    expect(giveUpCallback).toBeNull();
  });
});

// ── BRAIN DISCOVERABILITY — empty-brain actionable state (P1) ────────

describe('BrainContextBanner — empty-brain CTA', () => {
  it('shows the actionable empty-brain notice + CTA instead of "no relevant neurons found" when recall.emptyBrain is true', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<BrainContextBanner recall={{ nodes: [], tokensSaved: 0, tokensInjected: 0, injectedContext: '', emptyBrain: true }} />);

    expect(screen.getByText('brain.emptyBrainNotice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'brain.emptyBrainCta' })).toBeInTheDocument();
    expect(screen.queryByText('assistant.brainContext.empty')).toBeNull();
  });

  it('still shows the generic "no relevant neurons" message when emptyBrain is false/absent (normal empty-query case)', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<BrainContextBanner recall={{ nodes: [], tokensSaved: 0, tokensInjected: 0, injectedContext: '' }} />);

    expect(screen.getByText('assistant.brainContext.empty')).toBeInTheDocument();
    expect(screen.queryByText('brain.emptyBrainNotice')).toBeNull();
  });

  it('clicking the CTA button navigates to the Settings space via the bus (nav:navigateSpace)', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<BrainContextBanner recall={{ nodes: [], tokensSaved: 0, tokensInjected: 0, injectedContext: '', emptyBrain: true }} />);

    fireEvent.click(screen.getByRole('button', { name: 'brain.emptyBrainCta' }));

    expect(mockEmit).toHaveBeenCalledWith('nav:navigateSpace', 'settings');
  });

  it('does not show the empty-brain CTA when there is a brainError (error takes precedence)', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(
      <BrainContextBanner
        recall={{ nodes: [], tokensSaved: 0, tokensInjected: 0, injectedContext: '', emptyBrain: true }}
        brainError="brain command timed out after 30s"
      />
    );

    expect(screen.queryByText('brain.emptyBrainNotice')).toBeNull();
  });
});

// ── RECALL LEVEL HONESTY (P2) ─────────────────────────────────────────

describe('BrainContextBanner — recall level honesty', () => {
  it('shows the semantic-recall label when recall.level is "semantic"', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<BrainContextBanner recall={{ ...REAL_RECALL, level: 'semantic' }} />);

    expect(screen.getByText(/brain\.level\.semantic/)).toBeInTheDocument();
  });

  it('shows the hybrid-recall label when recall.level is "hybrid"', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<BrainContextBanner recall={{ ...REAL_RECALL, level: 'hybrid' }} />);

    expect(screen.getByText(/brain\.level\.hybrid/)).toBeInTheDocument();
  });

  it('shows the keyword-only label when recall.level is "keyword"', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<BrainContextBanner recall={{ ...REAL_RECALL, level: 'keyword' }} />);

    expect(screen.getByText(/brain\.level\.keyword/)).toBeInTheDocument();
  });

  it('shows no level label at all when recall.level is undefined (unknown — never guessed)', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    render(<BrainContextBanner recall={REAL_RECALL} />);

    expect(screen.queryByText(/brain\.level\./)).toBeNull();
  });
});

// ── ENV-OVERRIDE TRANSPARENCY (ambient, chat-side) ───────────────────
//
// LAZYBRAIN_BRAIN_PATH silently outranks the opened project's own brain
// everywhere path resolution happens. Settings > Memory already surfaces
// this (envOverrideWarning callout), but a user who only ever uses the
// chat panel would otherwise see zero signal that recall is answering from
// a shared/global brain, not this project's. These tests lock the new
// ambient note in this banner, reusing that exact same i18n key.

describe('BrainContextBanner — env-override transparency (ambient chat note)', () => {
  it('shows the env-override note when brain.info() resolves source: env_override', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatformWithInfo('env_override'));
    render(<BrainContextBanner recall={REAL_RECALL} />);

    expect(await screen.findByText('settings.memory.brainPath.envOverrideWarning')).toBeInTheDocument();
  });

  it('does NOT show the env-override note when the brain source is project', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatformWithInfo('project'));
    render(<BrainContextBanner recall={REAL_RECALL} />);

    // Let the brain.info() microtask settle before asserting absence.
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText('settings.memory.brainPath.envOverrideWarning')).toBeNull();
  });

  it('does NOT show the env-override note on the web platform (no brain.info() to check)', async () => {
    mockGetPlatform.mockReturnValue(makeWebPlatform());
    render(<BrainContextBanner recall={REAL_RECALL} />);

    await Promise.resolve();
    expect(screen.queryByText('settings.memory.brainPath.envOverrideWarning')).toBeNull();
  });

  it('does NOT crash on a tauri platform whose brain double has no info() (existing test doubles in this file)', () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatform());
    expect(() => render(<BrainContextBanner recall={REAL_RECALL} />)).not.toThrow();
  });
});

// ── ENV-OVERRIDE NOTICE — dismissible ─────────────────────────────────
//
// The ambient env-override notice previously rendered on every single chat
// turn with no way to dismiss it. It must now offer a close (✕) button and
// remember the dismissal in localStorage (key
// 'lazy.brain.envOverrideNoticeDismissed') so it stays hidden across
// sessions — Settings > Memory keeps its own copy of the same warning
// permanently, unaffected by this dismissal.

describe('BrainContextBanner — env-override notice dismissal', () => {
  const DISMISS_KEY = 'lazy.brain.envOverrideNoticeDismissed';

  beforeEach(() => {
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* localStorage unavailable */ }
  });

  afterEach(() => {
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* localStorage unavailable */ }
  });

  it('shows a dismiss button alongside the env-override notice', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatformWithInfo('env_override'));
    render(<BrainContextBanner recall={REAL_RECALL} />);

    await screen.findByText('settings.memory.brainPath.envOverrideWarning');
    expect(screen.getByRole('button', { name: 'common.close' })).toBeInTheDocument();
  });

  it('hides the notice and persists the dismissal to localStorage when the dismiss button is clicked', async () => {
    mockGetPlatform.mockReturnValue(makeTauriPlatformWithInfo('env_override'));
    render(<BrainContextBanner recall={REAL_RECALL} />);

    await screen.findByText('settings.memory.brainPath.envOverrideWarning');
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }));

    expect(screen.queryByText('settings.memory.brainPath.envOverrideWarning')).toBeNull();
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1');
  });

  it('stays hidden on a later mount once previously dismissed', async () => {
    localStorage.setItem(DISMISS_KEY, '1');
    mockGetPlatform.mockReturnValue(makeTauriPlatformWithInfo('env_override'));
    render(<BrainContextBanner recall={REAL_RECALL} />);

    // Let the brain.info() microtask (and its setEnvOverrideActive(true) —
    // unlike the sibling 'project'-source test above, this one is a real
    // false->true change, so it must be flushed inside act()) settle before
    // asserting absence.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('settings.memory.brainPath.envOverrideWarning')).toBeNull();
  });
});
