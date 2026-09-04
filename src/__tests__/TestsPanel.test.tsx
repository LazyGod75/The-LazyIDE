import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { TestsPanel } from '../components/editor/TestsPanel';
import type { Platform, TestRunResult } from '../lib/platform/types';

// B20: the panel's summary must never claim success unless tests genuinely
// ran and passed — a config error (exit != 0, 0 tests parsed, no per-test
// failures reported) used to render a FAIL badge, "0 passed · 0 total", AND
// a simultaneous green "All tests passed" message.

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

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
}));

const setDiagnostics = vi.fn();
vi.mock('../components/editor/editorStore', () => ({
  useEditorStore: () => ({ setDiagnostics }),
}));

const toastSpy = vi.fn();
vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makePlatform(run: (repoPath: string) => Promise<TestRunResult>): Platform {
  return {
    name: 'tauri',
    tests: { run },
  } as unknown as Platform;
}

function baseResult(overrides: Partial<TestRunResult> = {}): TestRunResult {
  return {
    ok: true,
    tool: 'vitest',
    total: 3,
    passed: 3,
    failed: 0,
    durationMs: 120,
    failures: [],
    raw: '',
    ...overrides,
  };
}

describe('TestsPanel — B20 truthful summary', () => {
  it('shows PASS + "All tests passed" only for a genuine pass (ok, total > 0, no failures)', async () => {
    const platform = makePlatform(async () => baseResult());
    render(<TestsPanel platform={platform} projectRoot="/repo" />);

    fireEvent.click(screen.getByText('Run Tests'));

    await waitFor(() => expect(screen.getByText('PASS')).toBeInTheDocument());
    expect(screen.getByText(/tests\.allPassedInline/)).toBeInTheDocument();
    expect(toastSpy).toHaveBeenCalledWith(expect.stringMatching(/tests\.allPassed:/), 'success', 3000);
  });

  it('never shows a green "all passed" message for a 0-total vacuous run, even when ok=true', async () => {
    // Vacuous "success": exit code 0, but nothing actually ran (same class
    // of bug as B10's force-merge vacuous success).
    const platform = makePlatform(async () => baseResult({ ok: true, total: 0, passed: 0, failed: 0, raw: 'No test files found' }));
    render(<TestsPanel platform={platform} projectRoot="/repo" />);

    fireEvent.click(screen.getByText('Run Tests'));

    await waitFor(() => expect(screen.getByText('tests.badge.neutral')).toBeInTheDocument());
    expect(screen.queryByText(/tests\.allPassedInline/)).not.toBeInTheDocument();
    expect(screen.getByText('tests.noTestsRan')).toBeInTheDocument();
    expect(screen.getByText('No test files found')).toBeInTheDocument();
    expect(toastSpy).toHaveBeenCalledWith('tests.noTestsRan', 'warning', 4000);
  });

  it('never shows a green "all passed" message for a failed run with no per-test failures parsed (config error)', async () => {
    const platform = makePlatform(async () => baseResult({ ok: false, total: 0, passed: 0, failed: 0, raw: 'Error: could not resolve config' }));
    render(<TestsPanel platform={platform} projectRoot="/repo" />);

    fireEvent.click(screen.getByText('Run Tests'));

    await waitFor(() => expect(screen.getByText('tests.badge.neutral')).toBeInTheDocument());
    expect(screen.queryByText(/tests\.allPassedInline/)).not.toBeInTheDocument();
    expect(screen.getByText('Error: could not resolve config')).toBeInTheDocument();
  });

  it('shows FAIL badge with the real failures list when tests genuinely ran and some failed', async () => {
    const platform = makePlatform(async () => baseResult({
      ok: false,
      total: 3,
      passed: 2,
      failed: 1,
      failures: [{ name: 'adds numbers', message: 'expected 2 to be 3' }],
    }));
    render(<TestsPanel platform={platform} projectRoot="/repo" />);

    fireEvent.click(screen.getByText('Run Tests'));

    await waitFor(() => expect(screen.getByText('FAIL')).toBeInTheDocument());
    expect(screen.getByText('adds numbers')).toBeInTheDocument();
    expect(screen.queryByText(/tests\.allPassedInline/)).not.toBeInTheDocument();
  });
});
