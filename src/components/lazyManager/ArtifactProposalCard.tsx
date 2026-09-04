/* ArtifactProposalCard — the "visible design preview" card (real founder
   feedback, verbatim: "comment tu me montres les designs proposes ?" — a
   proposed visual artifact used to render as a plain text card only; the
   user would validate a design they had never actually seen).

   Same visual family as GraphProposalCard.tsx/MissionCharterCard.tsx (this
   folder): bordered card, plain-language labels, real buttons, "✓ Choix
   retenu" convention for a resolved choice (DecisionCard.tsx's own
   convention, reused verbatim rather than inventing a second one).

   GENERIC BY CONSTRUCTION: nothing here names a content format, a network,
   or a use case — see artifactProposal.ts's own module header. A variant's
   number of views is never assumed (0, 1, or N — each variant navigates its
   own views independently), and the number of variants is never assumed
   either (1..N, rendered side by side, spec: "plusieurs propositions, dont
   une avec notre DA").

   SECURITY (this task's own explicit "ne prends pas ce point a la legere"):
   every rendered view is an UNTRUSTED, agent-generated artifact — the
   iframe's `sandbox` attribute is `"allow-same-origin"` and NOTHING else
   (no scripts, no forms, no popups, no top navigation), the same posture
   PreviewNode.tsx's own ArtifactSurfaceCard uses for the canvas-side render
   of this same kind of content. `srcDoc` renders the HTML/CSS fully
   regardless (sandbox restricts capabilities, not markup parsing) while
   giving the content zero way to touch the rest of the app or the user's
   session — `allow-same-origin` alone grants no such way in either
   direction: WITHOUT `allow-scripts` the document can never execute any
   code, so it can neither reach into the app NOR make any use of being
   nominally "same-origin" itself; the only thing that capability actually
   enables is this app's OWN trusted code reading the sandboxed document's
   real rendered size back out — see the AUTO-SCALE FIX note below for why
   that reintroduced token exists at all.

   LOCAL OPTIMISTIC RESOLUTION (same convention as DecisionCard.tsx's
   `resolved`/MissionCharterCard.tsx's fix — see that file's own doc comment
   for the real repro this closes): picking a variant or rejecting flips this
   card's own local state immediately, independent of whether a future
   backend round-trip ever updates `proposal.state`/`selectedVariantId` —
   the card must never stay actionable after the user has already acted.

   AUTO-SCALE FIX (real DOM inspection, verbatim repro: a proposed 1080x1080
   slide rendered 1:1 inside a 218x258 frame showed only its own top-left
   80px margin — "un rectangle vide"). The OLD scaling only ever triggered
   off `view.width`/`view.height`, which the model never actually declares
   (the real size lived only inside the srcDoc's own inline CSS) — so the
   frame silently fell back to an unscaled 100%/100% fill. The fix measures
   the SANDBOXED document's own real rendered size on `onLoad`
   (`measureSandboxedContentSize` below) and scales-to-fit from THAT,
   independent of any declared metadata; `view.width`/`view.height` (when the
   model does declare them — see managerEngine.ts's propose_artifact prompt)
   are used only as an instant pre-load hint so the very first paint isn't a
   guess, immediately superseded by the real measurement. This requires
   `sandbox="allow-same-origin"` instead of the previous empty string — see
   that constant's own doc comment for why this stays exactly as isolated as
   before (no script execution is possible either way; only the trusted
   PARENT gains read access to the child's own rendered layout, never the
   reverse). `ExpandedArtifactOverlay` (further down) gives the same content
   a full-panel enlarge affordance — a scaled-down 64px title is illegible at
   thumbnail size, and the user must be able to actually judge a design, not
   guess its silhouette. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ArtifactProposal, ArtifactVariant, ArtifactView } from './artifactProposal';
import type { ActionDispatchOutcome } from './useManagerActionQueue';

export interface ArtifactProposalCardProps {
  proposal: ArtifactProposal;
  onSelectVariant: (variant: ArtifactVariant) => ActionDispatchOutcome | void;
  onReject: () => ActionDispatchOutcome | void;
  /** NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — true while this
   *  card's own select/reject click has been queued (manager busy at click
   *  time) but not yet actually sent. Never shows a final "Accepted"/
   *  "Rejected" state while this holds. Optional, defaulting to false so
   *  every pre-existing caller/test keeps behaving exactly as before. */
  isActionQueued?: boolean;
}

type T = (key: string, params?: Record<string, string | number>) => string;

const cardStyle: React.CSSProperties = {
  marginTop: 10,
  borderRadius: 10,
  border: '1px solid var(--color-border-2)',
  background: 'rgba(124,92,255,0.06)',
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const ghostNavButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text-disabled)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 4px',
  fontFamily: 'inherit',
};

const selectButtonStyle: React.CSSProperties = {
  padding: '5px 11px',
  fontSize: 11.5,
  fontWeight: 700,
  borderRadius: 7,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px solid var(--color-accent-border, rgba(124,92,255,0.4))',
  background: 'rgba(124,92,255,0.18)',
  color: 'var(--color-accent-pale)',
};

const rejectButtonStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 700,
  borderRadius: 8,
  border: '1px solid var(--color-border-2)',
  background: 'transparent',
  color: 'var(--color-text-muted)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

/** Fixed available box for the chat-card thumbnail — deliberately NEVER
 *  grows/shrinks with content (unlike the old design, which let the box's
 *  own height float to match a declared aspect ratio with only the width
 *  capped — an undeclared-but-plausible extreme portrait could have blown
 *  the card out to any height). A fixed box lets `computeContainedLayout`
 *  below letterbox ANY aspect ratio (square, portrait, landscape, free)
 *  inside it, centered, never deformed, never overflowing — see this file's
 *  own AUTO-SCALE FIX module note. */
const FRAME_MAX_WIDTH = 220;
const FRAME_DEFAULT_HEIGHT = 260;

/** Computes a scale-to-fit-and-center layout for arbitrary intrinsic content
 *  dimensions inside an arbitrary available box. Exported for direct unit
 *  testing against this bug's own real repro numbers (a 1080x1080 view
 *  inside a measured 218x258 frame). PreviewNode.tsx's canvas-node
 *  ArtifactSurfaceCard duplicates this exact function verbatim — the two
 *  files sit in separately-scoped areas of the app with no shared util
 *  module between them, kept in sync by hand.
 *
 *  Never scales UP past the content's own natural size (same "thumbnail
 *  scale, never blown up" convention this module already used when only
 *  DECLARED metadata drove the scale) — content smaller than its frame is
 *  simply centered at its real size rather than blurrily magnified. Aspect
 *  ratio is always preserved (one uniform `scale` on both axes), so the
 *  result never deforms the content and always fits entirely inside the
 *  available box in both dimensions at once. */
export function computeContainedLayout(
  intrinsicWidth: number,
  intrinsicHeight: number,
  availableWidth: number,
  availableHeight: number,
): { boxWidth: number; boxHeight: number; scale: number } {
  if (intrinsicWidth <= 0 || intrinsicHeight <= 0 || availableWidth <= 0 || availableHeight <= 0) {
    return { boxWidth: Math.max(0, availableWidth), boxHeight: Math.max(0, availableHeight), scale: 1 };
  }
  const scale = Math.min(availableWidth / intrinsicWidth, availableHeight / intrinsicHeight, 1);
  return {
    boxWidth: Math.max(1, Math.round(intrinsicWidth * scale)),
    boxHeight: Math.max(1, Math.round(intrinsicHeight * scale)),
    scale,
  };
}

/** Reads the REAL rendered size of a sandboxed artifact iframe's own content
 *  — the actual fix for this module's core bug (real DOM inspection,
 *  verbatim: a 1080x1080 srcDoc rendered 1:1 inside a 218x258 frame showed
 *  only its own top-left corner). Never trusts `view.width`/`height` alone
 *  (the model can forget to declare them, and did in the exact repro this
 *  fixes) — this measures the CSS-laid-out document itself, after it has
 *  actually finished loading.
 *
 *  Requires `sandbox` to include `allow-same-origin` (see the iframe below)
 *  — WITHOUT `allow-scripts`, which is the actual capability gate: a
 *  document that cannot execute any script has no way to exploit being
 *  readable by its parent, so this one-directional PARENT-reads-CHILD access
 *  adds no new capability to the untrusted content itself, only to this
 *  trusted app's own measurement code. Returns null when the document isn't
 *  accessible yet or reports no real size (nothing to scale to — callers
 *  fall back to filling their box unscaled, same posture as before this fix
 *  for the brief pre-measurement instant). */
export function measureSandboxedContentSize(
  iframe: HTMLIFrameElement | null,
): { width: number; height: number } | null {
  if (!iframe) return null;
  try {
    const doc = iframe.contentDocument;
    const root = doc?.documentElement;
    if (!doc || !root) return null;
    const width = Math.max(root.scrollWidth, doc.body?.scrollWidth ?? 0);
    const height = Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    // Defense-in-depth — should never actually throw given
    // allow-same-origin above, but a future sandbox-attribute change here
    // must degrade to "no measurement", never crash the whole card.
    return null;
  }
}

const expandButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  width: 20,
  height: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 5,
  border: 'none',
  background: 'rgba(0,0,0,0.55)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: 1,
  padding: 0,
};

const expandedCloseButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: -14,
  right: -14,
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: 'none',
  background: '#fff',
  color: '#111',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 700,
};

/** "Cadre a l'echelle": the iframe always renders at the content's own
 *  intrinsic size, then a CSS `transform: scale()` shrinks (never grows)
 *  the whole thing down to fit inside the fixed `FRAME_MAX_WIDTH` x
 *  `FRAME_DEFAULT_HEIGHT` box, letterboxed and centered by the box's own
 *  `display: flex` — see `computeContainedLayout`'s own doc comment. The
 *  intrinsic size itself comes from the REAL measurement on `onLoad`
 *  (`measureSandboxedContentSize`), with any model-declared
 *  `view.width`/`height` used only as an instant pre-load hint — see this
 *  file's own AUTO-SCALE FIX module note for why. */
function ArtifactFrame({ view }: { view: ArtifactView }) {
  const { t } = useI18n();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number } | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  // A fresh view (nav to a different page/screen, or a different variant's
  // own view) invalidates any prior measurement — this component instance
  // is REUSED across view navigation (only the iframe itself remounts via
  // `key={view.id}` below), so without this reset a stale measured size
  // from the PREVIOUS view would keep driving the scale for one render.
  useEffect(() => {
    setMeasuredSize(null);
    setIsExpanded(false);
  }, [view.id]);

  const handleLoad = useCallback(() => {
    const measured = measureSandboxedContentSize(iframeRef.current);
    if (measured) setMeasuredSize(measured);
  }, []);

  const declaredSize =
    view.width !== undefined && view.height !== undefined ? { width: view.width, height: view.height } : null;
  const effectiveSize = measuredSize ?? declaredSize;
  const layout = effectiveSize
    ? computeContainedLayout(effectiveSize.width, effectiveSize.height, FRAME_MAX_WIDTH, FRAME_DEFAULT_HEIGHT)
    : null;

  return (
    <div
      style={{
        width: FRAME_MAX_WIDTH,
        height: FRAME_DEFAULT_HEIGHT,
        overflow: 'hidden',
        borderRadius: 8,
        border: '1px solid var(--color-border-2)',
        background: '#fff',
        position: 'relative',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={
          layout
            ? { width: layout.boxWidth, height: layout.boxHeight, overflow: 'hidden', flexShrink: 0 }
            : { width: '100%', height: '100%' }
        }
      >
        {/* key={view.id} forces a fresh iframe per view — srcDoc has no
            natural "content changed" signal, so without this a view switch
            could leave stale rendered content on screen. */}
        <iframe
          key={view.id}
          ref={iframeRef}
          data-testid={`artifact-frame-${view.id}`}
          title={view.label}
          srcDoc={view.html}
          onLoad={handleLoad}
          // SECURITY — allow-same-origin WITHOUT allow-scripts: see
          // measureSandboxedContentSize's own doc comment above for why
          // this stays exactly as isolated as the previous empty sandbox
          // (no script execution is possible either way).
          sandbox="allow-same-origin"
          style={
            layout
              ? {
                  width: effectiveSize!.width,
                  height: effectiveSize!.height,
                  border: 'none',
                  transform: `scale(${layout.scale})`,
                  transformOrigin: 'top left',
                }
              : { width: '100%', height: '100%', border: 'none' }
          }
        />
      </div>
      <button
        type="button"
        data-testid={`artifact-frame-expand-${view.id}`}
        aria-label={t('canvas.preview.artifactExpand')}
        title={t('canvas.preview.artifactExpand')}
        onClick={() => setIsExpanded(true)}
        style={expandButtonStyle}
      >
        {'⤢'}
      </button>
      {isExpanded && (
        <ExpandedArtifactOverlay view={view} initialSize={effectiveSize} onClose={() => setIsExpanded(false)} t={t} />
      )}
    </div>
  );
}

interface ExpandedArtifactOverlayProps {
  view: ArtifactView;
  /** Best-known size at the instant the overlay opened (already-measured
   *  thumbnail size, or a declared hint) — used only as the FIRST paint;
   *  this overlay re-measures its own, separately-loaded iframe on its own
   *  `onLoad` exactly like the thumbnail does. */
  initialSize: { width: number; height: number } | null;
  onClose: () => void;
  t: T;
}

/** Full-panel "judge the design for real" view (this task's own explicit
 *  ask: a scaled-down thumbnail can shrink a 64px title into unreadable
 *  text — the user must be able to enlarge a view to actually read it, not
 *  just guess its silhouette). Same sandbox posture as the thumbnail
 *  (`allow-same-origin` only — still no scripts/forms/popups/top
 *  navigation): enlarging never loosens isolation. */
function ExpandedArtifactOverlay({ view, initialSize, onClose, t }: ExpandedArtifactOverlayProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number } | null>(initialSize);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));

  useEffect(() => {
    function onResize(): void {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleLoad = useCallback(() => {
    const measured = measureSandboxedContentSize(iframeRef.current);
    if (measured) setMeasuredSize(measured);
  }, []);

  const availableWidth = Math.max(1, Math.min(viewport.width * 0.9, 1400));
  const availableHeight = Math.max(1, Math.min(viewport.height * 0.9, 1000));
  const layout = measuredSize
    ? computeContainedLayout(measuredSize.width, measuredSize.height, availableWidth, availableHeight)
    : null;

  return (
    <div
      data-testid={`artifact-frame-expanded-${view.id}`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
        <div
          style={{
            width: layout ? layout.boxWidth : availableWidth,
            height: layout ? layout.boxHeight : availableHeight,
            overflow: 'hidden',
            background: '#fff',
            borderRadius: 8,
          }}
        >
          <iframe
            ref={iframeRef}
            data-testid={`artifact-frame-expanded-iframe-${view.id}`}
            title={view.label}
            srcDoc={view.html}
            onLoad={handleLoad}
            sandbox="allow-same-origin"
            style={
              layout
                ? {
                    width: measuredSize!.width,
                    height: measuredSize!.height,
                    border: 'none',
                    transform: `scale(${layout.scale})`,
                    transformOrigin: 'top left',
                  }
                : { width: '100%', height: '100%', border: 'none' }
            }
          />
        </div>
        <button
          type="button"
          data-testid={`artifact-frame-expanded-close-${view.id}`}
          aria-label={t('canvas.preview.artifactCollapse')}
          title={t('canvas.preview.artifactCollapse')}
          onClick={onClose}
          style={expandedCloseButtonStyle}
        >
          {'✕'}
        </button>
      </div>
    </div>
  );
}

interface VariantCardProps {
  variant: ArtifactVariant;
  isChosen: boolean;
  isDimmed: boolean;
  isPending: boolean;
  onSelect: () => void;
  t: T;
}

function VariantCard({ variant, isChosen, isDimmed, isPending, onSelect, t }: VariantCardProps) {
  const [viewIndex, setViewIndex] = useState(0);
  const view = variant.views[viewIndex];
  const hasMultipleViews = variant.views.length > 1;

  function goTo(index: number): void {
    if (variant.views.length === 0) return;
    setViewIndex(((index % variant.views.length) + variant.views.length) % variant.views.length);
  }

  if (!view) return null;

  return (
    <div
      data-testid={`artifact-proposal-variant-${variant.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        alignItems: 'center',
        opacity: isDimmed ? 0.5 : 1,
        border: isChosen ? '1px solid var(--color-success, #22c55e)' : '1px solid transparent',
        borderRadius: 10,
        padding: 6,
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: isChosen ? 'var(--color-success, #22c55e)' : 'var(--color-text-secondary)',
        }}
      >
        {variant.label}
        {isChosen ? ` ${t('lazyManager.artifact.selectedMark')}` : ''}
      </span>
      <ArtifactFrame view={view} />
      {hasMultipleViews && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            data-testid={`artifact-proposal-prev-${variant.id}`}
            aria-label={t('canvas.preview.artifactPrevView')}
            onClick={() => goTo(viewIndex - 1)}
            style={ghostNavButtonStyle}
          >
            ◂
          </button>
          <span data-testid={`artifact-proposal-view-label-${variant.id}`} style={{ fontSize: 10.5, color: 'var(--color-text-disabled)' }}>
            {viewIndex + 1}/{variant.views.length} — {view.label}
          </span>
          <button
            type="button"
            data-testid={`artifact-proposal-next-${variant.id}`}
            aria-label={t('canvas.preview.artifactNextView')}
            onClick={() => goTo(viewIndex + 1)}
            style={ghostNavButtonStyle}
          >
            ▸
          </button>
        </div>
      )}
      {isPending && !isChosen && (
        <button type="button" data-testid={`artifact-proposal-select-${variant.id}`} onClick={onSelect} style={selectButtonStyle}>
          {t('lazyManager.artifact.select')}
        </button>
      )}
      {isChosen && (
        <span data-testid={`artifact-proposal-selected-${variant.id}`} style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--color-success, #22c55e)' }}>
          {t('lazyManager.artifact.selectedMark')}
        </span>
      )}
    </div>
  );
}

export function ArtifactProposalCard({ proposal, onSelectVariant, onReject, isActionQueued = false }: ArtifactProposalCardProps) {
  const { t } = useI18n();
  // Local optimistic resolution — see this file's own module header. `null`
  // means "no local decision yet, defer to `proposal.state`" (lets a future
  // backend-driven state still take effect if this card mounts already
  // resolved, e.g. reloaded from history).
  //
  // NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — `localResolution`
  // records WHAT the user chose, but `effectiveState` only shows it once
  // `isActionQueued` confirms the send actually went out; while queued it
  // shows an explicit "queued" state instead of a false "Accepted".
  const [localResolution, setLocalResolution] = useState<'accepted' | 'rejected' | null>(null);
  const [localChosenId, setLocalChosenId] = useState<string | null>(null);

  const effectiveState: ArtifactProposal['state'] | 'queued' = localResolution
    ? (isActionQueued ? 'queued' : localResolution)
    : proposal.state;
  const isPending = effectiveState === 'pending';
  const chosenId = localChosenId ?? proposal.selectedVariantId ?? null;

  const stateLabel =
    effectiveState === 'pending'
      ? t('lazyManager.artifact.pending')
      : effectiveState === 'queued'
        ? t('lazyManager.artifact.queued')
        : effectiveState === 'accepted'
          ? t('lazyManager.artifact.accepted')
          : t('lazyManager.artifact.rejected');
  const stateColor =
    effectiveState === 'pending'
      ? 'var(--color-warning)'
      : effectiveState === 'queued'
        ? 'var(--color-warning)'
        : effectiveState === 'accepted'
          ? 'var(--color-success, #22c55e)'
          : 'var(--color-danger, #dc2626)';

  // NEVER DEGRADE IN SILENCE — 'idle' means the selection/rejection could
  // not be taken in charge at all, so the card must stay actionable instead
  // of falsely marking itself resolved.
  function handleSelect(variant: ArtifactVariant): void {
    const outcome = onSelectVariant(variant);
    if (outcome === 'idle') return;
    setLocalChosenId(variant.id);
    setLocalResolution('accepted');
  }

  function handleReject(): void {
    const outcome = onReject();
    if (outcome === 'idle') return;
    setLocalResolution('rejected');
  }

  return (
    <div data-testid="artifact-proposal-card" style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
          {t('lazyManager.artifact.title')}
          {proposal.version ? ` · ${proposal.version}` : ''}
        </span>
        <span
          data-testid="artifact-proposal-state"
          style={{ fontSize: 10, fontWeight: 600, color: stateColor, textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          {stateLabel}
        </span>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>{proposal.name}</div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {proposal.variants.map((variant) => (
          <VariantCard
            key={variant.id}
            variant={variant}
            isChosen={chosenId === variant.id}
            isDimmed={chosenId !== null && chosenId !== variant.id}
            isPending={isPending}
            onSelect={() => handleSelect(variant)}
            t={t}
          />
        ))}
      </div>

      {isPending && (
        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          <button type="button" data-testid="artifact-proposal-reject" onClick={handleReject} style={rejectButtonStyle}>
            {t('lazyManager.artifact.reject')}
          </button>
        </div>
      )}
    </div>
  );
}
