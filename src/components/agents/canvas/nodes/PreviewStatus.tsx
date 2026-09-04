/* PreviewStatus.tsx — PreviewNode.tsx's shared empty/loading/starting/
   unreachable status body, extracted to its own file (same "many small
   files" split LivingPaneCompactCard.tsx already established in this
   directory) purely to keep PreviewNode.tsx itself under this codebase's
   file-size guideline once P59's live-when-attended logic grew that file —
   no behavior change from when this lived inline. */

export interface PreviewStatusProps {
  text: string;
  testId: string;
  /** R13 — a small spinner glyph for the 'checking'/'starting' in-progress
   *  states (never shown for a final 'unreachable'/empty state). */
  spinner?: boolean;
  /** W-PREVIEWFIX — small secondary line under the main status text (the
   *  next-retry countdown while backing off). Absent outside backoff. */
  subtext?: string;
  /** R13 — the manual-refresh affordance surfaced directly in the
   *  'unreachable' status body (in addition to the always-available header
   *  button) — the most discoverable place to offer it once polling has
   *  actually given up. */
  action?: { label: string; onClick: () => void };
}

export function PreviewStatus({ text, testId, spinner, subtext, action }: PreviewStatusProps) {
  return (
    <div
      data-testid={testId}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 12,
        textAlign: 'center',
        fontSize: 11.5,
        color: 'var(--color-text-disabled)',
      }}
    >
      {spinner && (
        <span
          className="agent-live-dot"
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)' }}
        />
      )}
      <span>{text}</span>
      {subtext && (
        <span data-testid={`${testId}-countdown`} style={{ fontSize: 10, opacity: 0.75 }}>
          {subtext}
        </span>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            fontSize: 11,
            color: 'var(--color-accent)',
            background: 'transparent',
            border: '1px solid var(--color-border-3)',
            borderRadius: 5,
            padding: '3px 10px',
            cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
