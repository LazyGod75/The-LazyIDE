/* PreviewGlyph.tsx — PreviewNode.tsx's header type-glyph, extracted to its
   own file (same "many small files" split LivingPaneCompactCard.tsx already
   established in this directory) purely to keep PreviewNode.tsx itself
   under this codebase's file-size guideline once P59's live-when-attended
   logic grew that file — no behavior change from when this lived inline. */

export function PreviewGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-testid="glyph-preview">
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="var(--color-text-muted)" strokeWidth="1.3" />
      <path d="M1.5 5.6h13" stroke="var(--color-text-muted)" strokeWidth="1.3" />
      <circle cx="3.4" cy="4.3" r="0.55" fill="var(--color-text-muted)" />
    </svg>
  );
}
