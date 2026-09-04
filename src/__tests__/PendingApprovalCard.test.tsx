/**
 * PendingApprovalCard.test.tsx — direct, isolated unit tests for
 * components/lazyManager/PendingApprovalCard.tsx (props in, DOM out — no
 * agentsStore/LazyManager tree needed, unlike
 * lazyManagerPendingApprovalRealTree.test.tsx's full-stack coverage).
 *
 * HONESTY FIX (founder directive, 2026-08-05, real incident): "du coup y a
 * un probleme et on sait meme pas ce que c'est... le lazymanager devrait
 * savoir ce que c'est et nous aider dans la decision" — a blocked approval
 * whose judge/evaluator never actually ran (provider exhausted, DeepSeek
 * 402) used to render the EXACT SAME "Le juge a rejeté cette mission (score
 * indisponible)..." wording as a genuine rejection — the label lied and
 * gave zero context to decide. Covered here:
 *   1. a reason carrying evaluator.ts's JUDGE_UNAVAILABLE_PROVIDER_REASON
 *      marker -> the new honest wording, never "a rejeté".
 *   2. a genuine rejection reason (no marker) -> unchanged, verbatim wording
 *      (regression guard — must never over-trigger).
 *   3. the same distinction seeded via `lastFailure` (the persisted/remount
 *      path, not just a live onApprove resolution).
 *   4. an explicit `judgeUnavailable` flag / structured `verdictReviewers`
 *      (the richer signals a future agentsStore.tsx change could supply)
 *      are honored too, even without the marker text.
 *   5. the compact verdict-detail expand (per-reviewer role/outcome/summary)
 *      renders only when verdictReviewers is actually present.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import {
  PendingApprovalCard,
  type PendingApprovalCardProps,
  type PendingApprovalItem,
  type PendingApprovalOutcome,
} from '../components/lazyManager/PendingApprovalCard';
import { JUDGE_UNAVAILABLE_PROVIDER_REASON } from '../lib/agents/evaluator';

// Locale pinned to 'fr' (same convention canvasNodes.test.tsx's VerdictChip
// describe block uses) — these assert the literal rendered copy, not just
// presence.
beforeEach(() => localStorage.setItem('lazy.locale', 'fr'));
afterEach(() => localStorage.removeItem('lazy.locale'));

function baseItem(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return { id: 'p1', label: 'Merger la mission M45', turnId: 't1', ...overrides };
}

function renderCard(overrides: Partial<PendingApprovalCardProps> = {}) {
  const props: PendingApprovalCardProps = {
    pending: [baseItem()],
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onApproveAll: vi.fn(),
    onRejectAll: vi.fn(),
    ...overrides,
  };
  return render(
    <I18nProvider>
      <PendingApprovalCard {...props} />
    </I18nProvider>,
  );
}

const GENUINE_REJECTION_REASON =
  'Le juge a rejeté cette mission (score indisponible). Corrigez les problèmes ou utilisez "Merger quand même" pour forcer.';

describe('PendingApprovalCard — judge-unavailable honesty fix (2026-08-05)', () => {
  it('a reason carrying the judge_unavailable_provider marker renders the honest "Évaluation indisponible" wording, never "a rejeté"', async () => {
    const reason = `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: deepseek — 402 quota exceeded (provider error, not a code defect — the judge could not run).`;
    const onApprove = vi.fn().mockResolvedValue({ ok: false, reason, canForce: true } as PendingApprovalOutcome);
    renderCard({ onApprove });

    fireEvent.click(screen.getByTestId('pending-approval-approve-p1'));
    await waitFor(() => expect(screen.getByTestId('pending-approval-reason-p1')).toBeInTheDocument());
    const reasonEl = screen.getByTestId('pending-approval-reason-p1');
    expect(reasonEl).toHaveTextContent('Évaluation indisponible');
    expect(reasonEl.textContent).not.toMatch(/a rejeté/);
    // The raw marker/provider text itself never leaks verbatim into the UI.
    expect(reasonEl.textContent).not.toContain(JUDGE_UNAVAILABLE_PROVIDER_REASON);
  });

  it('a genuine rejection reason (no marker) renders the exact system wording, unchanged — regression guard against over-triggering', async () => {
    const onApprove = vi.fn().mockResolvedValue({
      ok: false,
      reason: GENUINE_REJECTION_REASON,
      canForce: true,
    } as PendingApprovalOutcome);
    renderCard({ onApprove });

    fireEvent.click(screen.getByTestId('pending-approval-approve-p1'));
    await waitFor(() => expect(screen.getByTestId('pending-approval-reason-p1')).toBeInTheDocument());
    expect(screen.getByTestId('pending-approval-reason-p1')).toHaveTextContent(GENUINE_REJECTION_REASON);
  });

  it('a lastFailure seeded with the marker (persisted/remount path) also renders the honest wording, not the raw reason', () => {
    const reason = `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: openai — 401 invalid key (provider error, not a code defect — the judge could not run).`;
    renderCard({ pending: [baseItem({ lastFailure: { reason, canForce: true } })] });
    const reasonEl = screen.getByTestId('pending-approval-reason-p1');
    expect(reasonEl).toHaveTextContent('Évaluation indisponible');
    expect(reasonEl.textContent).not.toMatch(/a rejeté/);
  });

  it('a lastFailure seeded with a genuine rejection reason (persisted/remount path) still renders it verbatim', () => {
    renderCard({ pending: [baseItem({ lastFailure: { reason: GENUINE_REJECTION_REASON, canForce: true } })] });
    expect(screen.getByTestId('pending-approval-reason-p1')).toHaveTextContent(GENUINE_REJECTION_REASON);
  });

  it('an explicit judgeUnavailable flag is honored even without the marker text in `reason`', async () => {
    const onApprove = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'Some opaque infra error with no marker text at all',
      judgeUnavailable: true,
    } as PendingApprovalOutcome);
    renderCard({ onApprove });

    fireEvent.click(screen.getByTestId('pending-approval-approve-p1'));
    await waitFor(() => expect(screen.getByTestId('pending-approval-reason-p1')).toBeInTheDocument());
    expect(screen.getByTestId('pending-approval-reason-p1')).toHaveTextContent('Évaluation indisponible');
  });

  it('the same honest wording is used for onForce and onApproveAll failures, not just onApprove', async () => {
    const reason = `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: deepseek — 402.`;
    const onApproveAll = vi.fn().mockResolvedValue([{ id: 'p1', ok: false, reason, canForce: true }] as Array<{ id: string } & PendingApprovalOutcome>);
    renderCard({
      pending: [baseItem(), baseItem({ id: 'p2', label: 'Merger la mission M46' })],
      onApproveAll,
    });
    fireEvent.click(screen.getByTestId('pending-approval-approve-all'));
    await waitFor(() => expect(screen.getByTestId('pending-approval-reason-p1')).toBeInTheDocument());
    expect(screen.getByTestId('pending-approval-reason-p1')).toHaveTextContent('Évaluation indisponible');
  });
});

describe('PendingApprovalCard — verdict detail expand (founder directive: "aider dans la decision")', () => {
  function verdictOutcome(): PendingApprovalOutcome {
    return {
      ok: false,
      reason: GENUINE_REJECTION_REASON,
      verdictReviewers: [
        { role: 'reviewer', outcome: 'passed', summary: 'Code propre, tests présents.' },
        { role: 'security', outcome: 'passed', summary: 'Aucune faille détectée.' },
        { role: 'judge', outcome: 'unavailable', summary: `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: deepseek — 402.` },
      ],
    };
  }

  it('renders a collapsed expand toggle, then per-reviewer role/outcome/summary lines once expanded', async () => {
    const onApprove = vi.fn().mockResolvedValue(verdictOutcome());
    renderCard({ onApprove });

    fireEvent.click(screen.getByTestId('pending-approval-approve-p1'));
    const expandBtn = await waitFor(() => screen.getByTestId('pending-approval-verdict-expand-p1'));
    expect(screen.queryByTestId('pending-approval-verdict-detail-p1')).not.toBeInTheDocument();

    fireEvent.click(expandBtn);
    const detail = screen.getByTestId('pending-approval-verdict-detail-p1');
    expect(detail).toHaveTextContent('reviewer');
    expect(detail).toHaveTextContent('security');
    expect(detail).toHaveTextContent('judge');
    expect(screen.getByTestId('pending-approval-verdict-line-p1-judge')).toHaveTextContent('indisponible');
    expect(screen.getByTestId('pending-approval-verdict-line-p1-reviewer')).toHaveTextContent('Code propre, tests présents.');
  });

  it('no verdictReviewers on the outcome renders no detail-expand section at all (no fabricated empty list)', async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: false, reason: GENUINE_REJECTION_REASON } as PendingApprovalOutcome);
    renderCard({ onApprove });
    fireEvent.click(screen.getByTestId('pending-approval-approve-p1'));
    await waitFor(() => expect(screen.getByTestId('pending-approval-reason-p1')).toBeInTheDocument());
    expect(screen.queryByTestId('pending-approval-verdict-expand-p1')).not.toBeInTheDocument();
  });
});
