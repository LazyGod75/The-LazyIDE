/* PreviewLiveBadgeButton.tsx — P48's LIVE/OFFLINE status badge: an
   always-visible, at-a-glance signal distinct from the detailed status body
   (hidden once the iframe itself renders, or — since P59 — the paused
   overlay). Doubles as the "Réessayer" affordance while offline — clicking
   it re-arms the probe immediately, same action as the refresh button, just
   discoverable right where the status itself is shown. A no-op (not
   clickable) while already live — nothing to retry.

   Extracted to its own file (same "many small files" split
   LivingPaneCompactCard.tsx already established in this directory) to keep
   PreviewNode.tsx itself under this codebase's file-size guideline once
   P59's live-when-attended logic grew that file — no behavior change from
   when this lived inline. */

export interface PreviewLiveBadgeButtonProps {
  testId: string;
  reachable: boolean;
  liveLabel: string;
  offlineLabel: string;
  retryLabel: string;
  onRetry: () => void;
}

export function PreviewLiveBadgeButton({
  testId,
  reachable,
  liveLabel,
  offlineLabel,
  retryLabel,
  onRetry,
}: PreviewLiveBadgeButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={reachable ? liveLabel : retryLabel}
      title={reachable ? liveLabel : retryLabel}
      onClick={(e) => {
        e.stopPropagation();
        if (!reachable) onRetry();
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: 0.3,
        padding: '2px 7px',
        borderRadius: 999,
        border: 'none',
        flexShrink: 0,
        cursor: reachable ? 'default' : 'pointer',
        color: reachable ? 'var(--color-success-text)' : 'var(--color-text-disabled)',
        background: reachable ? 'var(--color-success-soft)' : 'transparent',
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}
      />
      {reachable ? liveLabel : offlineLabel}
    </button>
  );
}
