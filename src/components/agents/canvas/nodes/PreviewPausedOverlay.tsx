/* PreviewPausedOverlay.tsx — P59 (founder directive: "ça peut pas freeze,
   c'est pas normal"): the node's "last-known visual" while its iframe is
   paused (see PreviewNode.tsx's own module header for the full fix). Shows
   the URL it's pointed at, an honest LIVE badge (the server IS up — only
   the RENDERING paused, see this component's own `liveLabel` prop doc), and
   a subtle hint for how to resume. Renders on TOP of the (still-mounted,
   just `display:none`) iframe, never in place of it — "chrome stays,
   content pauses" applies here too: this overlay IS the paused content's
   own honest chrome, not a hidden one.

   Extracted to its own file (same "many small files" split
   LivingPaneCompactCard.tsx already established in this directory) partly
   for that reason and partly to keep PreviewNode.tsx itself under this
   codebase's file-size guideline once this fix grew that file.

   fix/canvas-agents-visibility (deliverable 2c) — "l'état En ligne doit
   montrer l'URL cliquable-copiable": the url used to be inert text even
   though this overlay's whole point is telling the truth about a reachable
   server. `onOpenExternal`/`onCopyUrl` are both optional so this stays a
   plain presentational component (same "pre-translated strings, no owned
   side effect" posture PreviewPinLiveButton.tsx/PreviewLiveBadgeButton.tsx
   already take) — PreviewNode.tsx supplies the real implementations
   (openExternal/navigator.clipboard); every other caller/test that renders
   this overlay with no callbacks keeps the exact old plain-text behavior. */

import { useState } from 'react';
import { StatusGlyph } from '../chrome/nodeChrome';

export interface PreviewPausedOverlayProps {
  testId: string;
  url: string;
  /** Same wording the header's own LIVE/OFFLINE badge uses — this overlay
   *  only ever renders while `reach === 'reachable'` (the iframe's own
   *  render condition), so it always reads LIVE, never OFFLINE: the server
   *  really is reachable, only the rendering itself is paused for
   *  performance — pausing display must never contradict that badge's
   *  truthfulness. */
  liveLabel: string;
  hint: string;
  /** Opens the url in the system browser — absent renders a plain
   *  (non-interactive) url span, same as before this field existed. */
  onOpenExternal?: () => void;
  /** Copies the url to the clipboard — absent renders no copy button. */
  onCopyUrl?: () => void;
  copyLabel?: string;
  copiedLabel?: string;
}

export function PreviewPausedOverlay({
  testId,
  url,
  liveLabel,
  hint,
  onOpenExternal,
  onCopyUrl,
  copyLabel,
  copiedLabel,
}: PreviewPausedOverlayProps) {
  const [justCopied, setJustCopied] = useState(false);

  function handleCopy(): void {
    onCopyUrl?.();
    setJustCopied(true);
    window.setTimeout(() => setJustCopied(false), 1500);
  }

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
        gap: 6,
        padding: 12,
        textAlign: 'center',
        background: '#0E0E12',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: 0.3,
          padding: '2px 7px',
          borderRadius: 999,
          color: 'var(--color-success-text)',
          background: 'var(--color-success-soft)',
        }}
      >
        <span
          aria-hidden="true"
          style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}
        />
        {liveLabel}
      </span>
      <div className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
        {onOpenExternal ? (
          <button
            type="button"
            data-testid={`${testId}-url`}
            title={url}
            onClick={(e) => {
              e.stopPropagation();
              onOpenExternal();
            }}
            style={{
              fontSize: 10.5,
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-accent)',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: onCopyUrl ? 190 : 220,
              textDecoration: 'underline',
            }}
          >
            {url}
          </button>
        ) : (
          <span
            style={{
              fontSize: 10.5,
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-text-disabled)',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {url}
          </span>
        )}
        {onCopyUrl && (
          <button
            type="button"
            data-testid={`${testId}-copy`}
            title={justCopied ? copiedLabel : copyLabel}
            aria-label={justCopied ? copiedLabel : copyLabel}
            onClick={(e) => {
              e.stopPropagation();
              handleCopy();
            }}
            style={{
              fontSize: 10,
              lineHeight: '10px',
              color: justCopied ? 'var(--color-success-text)' : 'var(--color-text-disabled)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
            }}
          >
            {justCopied ? '✓' : '⧉'}
          </button>
        )}
      </div>
      {/* Design pass — "icone + phrase courte centrees" (founder): the
          existing pause `StatusGlyph` (same shape the mission billboard/
          legend already use for a paused liveness — reused, not a new
          glyph) reads the state at a glance even before the text below it
          does, matching every other status-communicating row in this
          app's chrome. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, opacity: 0.75 }}>
        <StatusGlyph liveness="paused" size={11} color="var(--color-text-disabled)" />
        <span style={{ fontSize: 10, color: 'var(--color-text-disabled)' }}>{hint}</span>
      </span>
    </div>
  );
}
