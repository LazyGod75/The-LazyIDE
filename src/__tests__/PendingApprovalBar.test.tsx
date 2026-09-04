/**
 * PendingApprovalBar.test.tsx — direct, isolated unit tests for
 * components/lazyManager/PendingApprovalBar.tsx (props in, DOM out — same
 * convention PendingApprovalCard.test.tsx already establishes for the
 * in-transcript card).
 *
 * SAFETY DEFECT (real user report, 2026-08-14): the persistent approval bar
 * pinned above the LazyManager composer rendered ONLY "N action(s) awaiting
 * approval" plus bulk Approve all / Reject all buttons — no tool name, no
 * argument, and the count text was not actually interactive despite reading
 * as if it might be. The user could not tell what a pending action would
 * actually do (a shell command? a file write? which file?) before approving
 * it. Covered here:
 *   1. each pending action renders its tool/action name and its label
 *      (the "argument" summary), plus an expandable full-detail row.
 *   2. singular vs plural count wording (CLDR pluralKey, not "action(s)").
 *   3. a single pending action shows per-item Approve/Reject and NO bulk
 *      "all" buttons; more than one shows both.
 *
 * HONESTY + BOUNDED-RETRY DEFECT (real user report, 2026-08-14 — "M4/M5
 * zombie approval loop" incident): onApprove/onApproveAll used to be
 * fire-and-forget, so a blocked approve_mission (e.g. a real merge refusal)
 * rendered NO reason anywhere on this bar and repeated "Tout approuver"
 * clicks silently did nothing observable. Also covered here:
 *   4. a failed approval shows the system's own reason, and a Force button
 *      when the outcome says a retry might resolve it.
 *   5. "Approve all" resolves EVERY distinct turn represented in `pending`,
 *      not just the first item's turnId.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import {
  PendingApprovalBar,
  type PendingApprovalBarItem,
  type PendingApprovalBarOutcome,
  type PendingApprovalBarProps,
} from '../components/lazyManager/PendingApprovalBar';

function item(overrides: Partial<PendingApprovalBarItem> = {}): PendingApprovalBarItem {
  return {
    id: 'p1',
    actionType: 'retry_mission',
    label: 'Relancer la mission M45',
    detail: 'Relancer la mission M45',
    turnId: 't1',
    ...overrides,
  };
}

const okOutcome: PendingApprovalBarOutcome = { ok: true };

function renderBar(overrides: Partial<PendingApprovalBarProps> = {}) {
  const props: PendingApprovalBarProps = {
    pending: [item()],
    onApprove: vi.fn().mockResolvedValue(okOutcome),
    onReject: vi.fn(),
    onApproveAll: vi.fn().mockResolvedValue([]),
    onRejectAll: vi.fn(),
    ...overrides,
  };
  return { ...render(
    <I18nProvider>
      <PendingApprovalBar {...props} />
    </I18nProvider>,
  ), props };
}

beforeEach(() => localStorage.setItem('lazy.locale', 'en'));
afterEach(() => localStorage.removeItem('lazy.locale'));

describe('PendingApprovalBar — renders no blind approvals (2026-08-14 safety defect)', () => {
  it('renders nothing when there is nothing pending', () => {
    renderBar({ pending: [] });
    expect(screen.queryByTestId('pending-approval-bar')).not.toBeInTheDocument();
  });

  it('shows the tool/action name and the label for a pending action', () => {
    renderBar({ pending: [item({ id: 'p1', actionType: 'open_project', label: 'Ouvrir le projet : C:\\repo\\lazy' })] });
    expect(screen.getByTestId('pending-approval-bar-type-p1')).toHaveTextContent('open_project');
    expect(screen.getByTestId('pending-approval-bar-expand-p1')).toHaveTextContent('Ouvrir le projet : C:\\repo\\lazy');
  });

  it('exposes the full untruncated detail on the row (title attribute) even before expanding', () => {
    const detail = 'Lancer la mission : ' + 'x'.repeat(120);
    renderBar({ pending: [item({ id: 'p1', label: 'Lancer la mission : ' + 'x'.repeat(120), detail })] });
    const row = screen.getByTestId('pending-approval-bar-expand-p1');
    expect(row.getAttribute('title')).toBe(detail);
  });

  it('middle-truncates a long label visibly (never silently shows a shorter, different-looking string)', () => {
    const longLabel = 'Ouvrir le projet : C:\\Users\\user\\Documents\\cerveau\\scratchpad\\uc-smoke-2026-08-12-long-name';
    renderBar({ pending: [item({ id: 'p1', label: longLabel, detail: longLabel })] });
    const rendered = screen.getByTestId('pending-approval-bar-expand-p1').textContent ?? '';
    expect(rendered.length).toBeLessThan(longLabel.length);
    expect(rendered).toContain('\u2026'); // middle ellipsis marker
  });

  it('expand affordance reveals the full detail text on click, and hides it again on a second click', () => {
    const detail = 'Full untruncated detail text for this action, longer than the compact label.';
    renderBar({ pending: [item({ id: 'p1', label: 'Compact label', detail })] });
    expect(screen.queryByTestId('pending-approval-bar-detail-p1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pending-approval-bar-expand-p1'));
    expect(screen.getByTestId('pending-approval-bar-detail-p1')).toHaveTextContent(detail);
    fireEvent.click(screen.getByTestId('pending-approval-bar-expand-p1'));
    expect(screen.queryByTestId('pending-approval-bar-detail-p1')).not.toBeInTheDocument();
  });

  it('is not expandable when detail carries nothing beyond the already-short label (no dead click target)', () => {
    renderBar({ pending: [item({ id: 'p1', label: 'Short', detail: 'Short' })] });
    expect(screen.getByTestId('pending-approval-bar-expand-p1')).toBeDisabled();
  });
});

describe('PendingApprovalBar — singular vs plural wording (CLDR pluralKey, not "action(s)")', () => {
  it('one pending action: singular English count text, never "action(s)"', () => {
    renderBar({ pending: [item({ id: 'p1' })] });
    const text = screen.getByText(/action/i).textContent ?? '';
    expect(text).toBe('1 action awaiting approval');
    expect(text).not.toContain('(s)');
  });

  it('three pending actions: plural English count text', () => {
    renderBar({ pending: [item({ id: 'p1' }), item({ id: 'p2' }), item({ id: 'p3' })] });
    expect(screen.getByText('3 actions awaiting approval')).toBeInTheDocument();
  });

  it('fr locale renders correct singular/plural grammar for 1 vs 2 (not the "action(s)" cop-out)', () => {
    localStorage.setItem('lazy.locale', 'fr');
    const { unmount } = renderBar({ pending: [item({ id: 'p1' })] });
    expect(screen.getByText('1 action en attente d\'approbation')).toBeInTheDocument();
    unmount();
    renderBar({ pending: [item({ id: 'p1' }), item({ id: 'p2' })] });
    expect(screen.getByText('2 actions en attente d\'approbation')).toBeInTheDocument();
  });
});

describe('PendingApprovalBar — bulk vs single-action buttons', () => {
  it('a single pending action shows per-item Approve/Reject and NO bulk "all" buttons', () => {
    renderBar({ pending: [item({ id: 'p1' })] });
    expect(screen.queryByTestId('pending-approval-bar-accept-all')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-approval-bar-reject-all')).not.toBeInTheDocument();
    expect(screen.getByTestId('pending-approval-bar-approve-p1')).toHaveTextContent('Approve');
    expect(screen.getByTestId('pending-approval-bar-reject-p1')).toHaveTextContent('Reject');
  });

  it('more than one pending action shows bulk "all" buttons in addition to each row\'s own Approve/Reject', () => {
    renderBar({ pending: [item({ id: 'p1' }), item({ id: 'p2' })] });
    expect(screen.getByTestId('pending-approval-bar-accept-all')).toHaveTextContent('Approve all');
    expect(screen.getByTestId('pending-approval-bar-reject-all')).toHaveTextContent('Reject all');
    expect(screen.getByTestId('pending-approval-bar-approve-p1')).toBeInTheDocument();
    expect(screen.getByTestId('pending-approval-bar-approve-p2')).toBeInTheDocument();
  });

  it('clicking a single row\'s Approve calls onApprove with that item id only', async () => {
    const onApprove = vi.fn().mockResolvedValue(okOutcome);
    renderBar({ pending: [item({ id: 'p1' })], onApprove });
    fireEvent.click(screen.getByTestId('pending-approval-bar-approve-p1'));
    expect(onApprove).toHaveBeenCalledWith('p1');
    expect(onApprove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onApprove).toHaveResolved());
  });

  it('clicking a single row\'s Reject calls onReject with that item id only', () => {
    const onReject = vi.fn();
    renderBar({ pending: [item({ id: 'p1' })], onReject });
    fireEvent.click(screen.getByTestId('pending-approval-bar-reject-p1'));
    expect(onReject).toHaveBeenCalledWith('p1');
  });

  it('clicking "Approve all" calls onApproveAll with the batch turnId', async () => {
    const onApproveAll = vi.fn().mockResolvedValue([]);
    renderBar({ pending: [item({ id: 'p1', turnId: 't9' }), item({ id: 'p2', turnId: 't9' })], onApproveAll });
    fireEvent.click(screen.getByTestId('pending-approval-bar-accept-all'));
    await waitFor(() => expect(onApproveAll).toHaveBeenCalledWith('t9'));
  });
});

describe('PendingApprovalBar — honesty fix (real user report, 2026-08-14: "M4/M5 zombie approval loop")', () => {
  it('a blocked approval shows the system\'s own reason, verbatim, and hides the plain Approve/Reject row', async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: false, reason: 'MERGE_CONFLICT: real git conflict' } satisfies PendingApprovalBarOutcome);
    renderBar({ pending: [item({ id: 'p1' })], onApprove });
    fireEvent.click(screen.getByTestId('pending-approval-bar-approve-p1'));
    await waitFor(() => expect(screen.getByTestId('pending-approval-bar-reason-p1')).toHaveTextContent('MERGE_CONFLICT: real git conflict'));
    expect(screen.queryByTestId('pending-approval-bar-approve-p1')).not.toBeInTheDocument();
  });

  it('shows a Force button only when the outcome says canForce, and clicking it calls onForce with the item id', async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: false, reason: 'judge rejected', canForce: true } satisfies PendingApprovalBarOutcome);
    const onForce = vi.fn().mockResolvedValue(okOutcome);
    renderBar({ pending: [item({ id: 'p1' })], onApprove, onForce });
    fireEvent.click(screen.getByTestId('pending-approval-bar-approve-p1'));
    const forceBtn = await screen.findByTestId('pending-approval-bar-force-p1');
    fireEvent.click(forceBtn);
    await waitFor(() => expect(onForce).toHaveBeenCalledWith('p1'));
  });

  it('does not show a Force button when the outcome says canForce is not set', async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: false, reason: 'worktree missing' } satisfies PendingApprovalBarOutcome);
    renderBar({ pending: [item({ id: 'p1' })], onApprove, onForce: vi.fn() });
    fireEvent.click(screen.getByTestId('pending-approval-bar-approve-p1'));
    await waitFor(() => expect(screen.getByTestId('pending-approval-bar-reason-p1')).toBeInTheDocument());
    expect(screen.queryByTestId('pending-approval-bar-force-p1')).not.toBeInTheDocument();
  });

  it('reflects a failure the store already recorded (lastFailure) even before this bar triggers anything itself', () => {
    renderBar({ pending: [item({ id: 'p1', lastFailure: { reason: 'access denied: outside every registered project root', canForce: false } })] });
    expect(screen.getByTestId('pending-approval-bar-reason-p1')).toHaveTextContent('access denied: outside every registered project root');
    expect(screen.queryByTestId('pending-approval-bar-approve-p1')).not.toBeInTheDocument();
  });

  it('a successful approval clears the row (no lingering "resolving"/"failed" residue) once the item leaves `pending`', async () => {
    const onApprove = vi.fn().mockResolvedValue(okOutcome);
    const { rerender, props } = renderBar({ pending: [item({ id: 'p1' })], onApprove });
    fireEvent.click(screen.getByTestId('pending-approval-bar-approve-p1'));
    await waitFor(() => expect(onApprove).toHaveResolved());
    // Simulates the store removing the now-successfully-resolved item —
    // exactly what a real re-render after approvePendingAction succeeds
    // looks like.
    rerender(
      <I18nProvider>
        <PendingApprovalBar {...props} pending={[]} />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('pending-approval-bar')).not.toBeInTheDocument();
  });
});

describe('PendingApprovalBar — cross-turn bulk fix (real user report, 2026-08-14)', () => {
  it('"Approve all" resolves every DISTINCT turn represented in `pending`, not just the first item\'s turnId', async () => {
    const onApproveAll = vi.fn().mockResolvedValue([]);
    renderBar({
      pending: [
        item({ id: 'p1', turnId: 't1' }),
        item({ id: 'p2', turnId: 't2', lastFailure: { reason: 'merge bloqué', canForce: true } }),
      ],
      onApproveAll,
    });
    fireEvent.click(screen.getByTestId('pending-approval-bar-accept-all'));
    await waitFor(() => {
      expect(onApproveAll).toHaveBeenCalledWith('t1');
      expect(onApproveAll).toHaveBeenCalledWith('t2');
    });
    expect(onApproveAll).toHaveBeenCalledTimes(2);
  });

  it('"Reject all" rejects every DISTINCT turn represented in `pending`', () => {
    const onRejectAll = vi.fn();
    renderBar({
      pending: [item({ id: 'p1', turnId: 't1' }), item({ id: 'p2', turnId: 't2' })],
      onRejectAll,
    });
    fireEvent.click(screen.getByTestId('pending-approval-bar-reject-all'));
    expect(onRejectAll).toHaveBeenCalledWith('t1');
    expect(onRejectAll).toHaveBeenCalledWith('t2');
    expect(onRejectAll).toHaveBeenCalledTimes(2);
  });
});
