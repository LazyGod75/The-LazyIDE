/* PreviewPinLiveButton.tsx — P59's "expand to a live panel" attend trigger:
   an explicit, durable "keep THIS preview's iframe live" pin, independent
   of hover/selection (see PreviewNode.tsx's module header / previewAttendedState.ts
   for the full live-when-attended policy). Still loses
   previewLiveCoordinator.ts's single-live-slot race to a MORE recently
   attended node (hovering a different preview) — pinning is a standing
   preference, not an override of the canvas-wide hard cap.

   Extracted to its own file (same "many small files" split
   LivingPaneCompactCard.tsx already established in this directory) partly
   for that reason and partly to keep PreviewNode.tsx itself under this
   codebase's file-size guideline. Pre-translated `label` (rather than
   calling `useI18n` itself) keeps this a plain presentational component,
   same posture PreviewPausedOverlay.tsx's `liveLabel`/`hint` props take. */

export interface PreviewPinLiveButtonProps {
  testId: string;
  pinned: boolean;
  label: string;
  onToggle: () => void;
}

export function PreviewPinLiveButton({ testId, pinned, label, onToggle }: PreviewPinLiveButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-pressed={pinned}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        width: 18,
        height: 18,
        lineHeight: '16px',
        borderRadius: 4,
        border: 'none',
        background: 'transparent',
        color: pinned ? 'var(--color-accent)' : 'var(--color-text-disabled)',
        cursor: 'pointer',
        fontSize: 12,
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }}
      />
    </button>
  );
}
