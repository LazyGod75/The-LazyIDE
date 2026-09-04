/**
 * promotionPipelinePanel.test.tsx — the manual trigger wired into LeadView
 * for the curated brain promotion pipeline (runPromotionPipeline(),
 * lib/teams/promotionPipeline.ts). The pipeline itself had zero test
 * coverage and zero entry point before this branch.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
}));

const toastSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockRunPromotionPipeline = vi.fn();
vi.mock('../lib/teams/promotionPipeline', () => ({
  runPromotionPipeline: () => mockRunPromotionPipeline(),
}));

import { PromotionPipelinePanel } from '../components/team/redesign/PromotionPipelinePanel';

describe('PromotionPipelinePanel', () => {
  it('calls runPromotionPipeline() and shows a success toast + summary on click', async () => {
    mockRunPromotionPipeline.mockResolvedValue({
      candidates: [{}, {}, {}],
      promoted: 2,
      rejected: 1,
      errors: [],
    });

    render(<PromotionPipelinePanel />);
    fireEvent.click(screen.getByTestId('run-promotion-pipeline-btn'));

    await waitFor(() => expect(mockRunPromotionPipeline).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('promotion-pipeline-result')).toBeInTheDocument());
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('doneToast'), 'success');
  });

  it('shows an error toast when the pipeline reports errors instead of throwing', async () => {
    mockRunPromotionPipeline.mockResolvedValue({
      candidates: [],
      promoted: 0,
      rejected: 0,
      errors: ['Promotion pipeline requires a Pro+ plan'],
    });

    render(<PromotionPipelinePanel />);
    fireEvent.click(screen.getByTestId('run-promotion-pipeline-btn'));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith('Promotion pipeline requires a Pro+ plan', 'error'),
    );
  });

  it('disables the button while the pipeline is running', async () => {
    let resolvePipeline: (v: unknown) => void = () => {};
    mockRunPromotionPipeline.mockReturnValue(
      new Promise((resolve) => {
        resolvePipeline = resolve;
      }),
    );

    render(<PromotionPipelinePanel />);
    const btn = screen.getByTestId('run-promotion-pipeline-btn');
    fireEvent.click(btn);

    await waitFor(() => expect(btn).toBeDisabled());

    resolvePipeline({ candidates: [], promoted: 0, rejected: 0, errors: [] });
    await waitFor(() => expect(btn).not.toBeDisabled());
  });
});
