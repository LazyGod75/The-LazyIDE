/**
 * ArtifactProposalCard — the "visible design preview" card (real founder
 * feedback: "comment tu me montres les designs proposes ?"). Covers isolated
 * artifact rendering (sandbox posture), view navigation within a variant,
 * variant selection transmitted as a choice, and the reject path.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import {
  ArtifactProposalCard,
  computeContainedLayout,
} from '../components/lazyManager/ArtifactProposalCard';
import type { ArtifactProposal, ArtifactVariant } from '../components/lazyManager/artifactProposal';

/** Test-only stand-in for a sandboxed artifact iframe's own rendered
 *  document — real DOM inspection repro (see ArtifactProposalCard.tsx's own
 *  AUTO-SCALE FIX module note): a 1080x1080 srcDoc rendered inside a small
 *  frame with NO scaling because the old code only ever scaled off declared
 *  `view.width`/`height` metadata, never the real rendered content. jsdom
 *  has no real layout engine (scrollWidth/scrollHeight are always 0 by
 *  default), so this stubs `contentDocument` on a live iframe element to
 *  report a specific intrinsic size, then fires `load` — exactly the signal
 *  `measureSandboxedContentSize`'s own `onLoad` handler reacts to. */
function stubIframeContentSize(iframe: HTMLIFrameElement, width: number, height: number): void {
  Object.defineProperty(iframe, 'contentDocument', {
    configurable: true,
    get: () => ({
      documentElement: { scrollWidth: width, scrollHeight: height },
      body: { scrollWidth: width, scrollHeight: height },
    }),
  });
  fireEvent.load(iframe);
}

function makeVariant(overrides: Partial<ArtifactVariant> = {}): ArtifactVariant {
  return {
    id: 'variant-a',
    label: 'Option A',
    views: [{ id: 'view-1', label: 'Page 1', html: '<html><body>Hello</body></html>' }],
    ...overrides,
  };
}

function makeProposal(overrides: Partial<ArtifactProposal> = {}): ArtifactProposal {
  return {
    state: 'pending',
    artifactId: 'artifact-1',
    name: 'Visual template',
    variants: [makeVariant()],
    ...overrides,
  };
}

function renderCard(proposal: ArtifactProposal, overrides: Partial<React.ComponentProps<typeof ArtifactProposalCard>> = {}) {
  const onSelectVariant = vi.fn();
  const onReject = vi.fn();
  const utils = render(
    <I18nProvider>
      <ArtifactProposalCard proposal={proposal} onSelectVariant={onSelectVariant} onReject={onReject} {...overrides} />
    </I18nProvider>,
  );
  return { onSelectVariant, onReject, rerender: utils.rerender };
}

describe('ArtifactProposalCard', () => {
  it('renders the card with the artifact name and pending state', () => {
    renderCard(makeProposal());
    expect(screen.getByTestId('artifact-proposal-card')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-proposal-state')).toHaveTextContent('Pending validation');
    expect(screen.getByText('Visual template')).toBeInTheDocument();
  });

  // SECURITY — this task's own explicit "ne prends pas ce point a la
  // legere": the rendered artifact is untrusted agent output, isolated via
  // `sandbox="allow-same-origin"` and NOTHING else (no scripts, no forms, no
  // popups, no top navigation) and `srcDoc` (never `src` pointing at a real
  // origin, which would leak referrer/network access). `allow-same-origin`
  // alone (the AUTO-SCALE FIX's own "belt", see ArtifactProposalCard.tsx's
  // module note) never re-admits `allow-scripts` — asserted explicitly below
  // so a future accidental loosening of the sandbox string fails this test.
  it('renders each view in a fully-locked-down sandboxed iframe (isolated rendering, no script escape, real-size readable only)', () => {
    renderCard(makeProposal());
    const iframe = screen.getByTestId('artifact-frame-view-1');
    expect(iframe.tagName).toBe('IFRAME');
    expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-forms|allow-popups|allow-top-navigation/);
    expect(iframe).toHaveAttribute('srcdoc', '<html><body>Hello</body></html>');
    expect(iframe).not.toHaveAttribute('src');
  });

  it('does not assume a fixed view count — no nav controls for a single-view variant', () => {
    renderCard(makeProposal());
    expect(screen.queryByTestId('artifact-proposal-next-variant-a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('artifact-proposal-prev-variant-a')).not.toBeInTheDocument();
  });

  it('navigates between views within a variant (page/screen navigation)', () => {
    const proposal = makeProposal({
      variants: [
        makeVariant({
          views: [
            { id: 'view-1', label: 'Cover', html: '<p>cover</p>' },
            { id: 'view-2', label: 'Detail', html: '<p>detail</p>' },
            { id: 'view-3', label: 'Footer', html: '<p>footer</p>' },
          ],
        }),
      ],
    });
    renderCard(proposal);

    expect(screen.getByTestId('artifact-proposal-view-label-variant-a')).toHaveTextContent('1/3 — Cover');
    expect(screen.getByTestId('artifact-frame-view-1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('artifact-proposal-next-variant-a'));
    expect(screen.getByTestId('artifact-proposal-view-label-variant-a')).toHaveTextContent('2/3 — Detail');
    expect(screen.getByTestId('artifact-frame-view-2')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('artifact-proposal-next-variant-a'));
    expect(screen.getByTestId('artifact-proposal-view-label-variant-a')).toHaveTextContent('3/3 — Footer');

    // Wraps around past the last view rather than getting stuck.
    fireEvent.click(screen.getByTestId('artifact-proposal-next-variant-a'));
    expect(screen.getByTestId('artifact-proposal-view-label-variant-a')).toHaveTextContent('1/3 — Cover');

    fireEvent.click(screen.getByTestId('artifact-proposal-prev-variant-a'));
    expect(screen.getByTestId('artifact-proposal-view-label-variant-a')).toHaveTextContent('3/3 — Footer');
  });

  it('renders N variants side by side (no fixed count) — "plusieurs propositions, dont une avec notre DA"', () => {
    const proposal = makeProposal({
      variants: [
        makeVariant({ id: 'v1', label: 'Option A' }),
        makeVariant({ id: 'v2', label: 'Option B — avec notre DA' }),
        makeVariant({ id: 'v3', label: 'Option C' }),
      ],
    });
    renderCard(proposal);

    expect(screen.getByTestId('artifact-proposal-variant-v1')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-proposal-variant-v2')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-proposal-variant-v3')).toBeInTheDocument();
    expect(screen.getByText('Option B — avec notre DA')).toBeInTheDocument();
  });

  it('selecting a variant transmits it as a choice via onSelectVariant', () => {
    const variantB = makeVariant({ id: 'v2', label: 'Option B' });
    const proposal = makeProposal({ variants: [makeVariant({ id: 'v1', label: 'Option A' }), variantB] });
    const { onSelectVariant } = renderCard(proposal);

    fireEvent.click(screen.getByTestId('artifact-proposal-select-v2'));

    expect(onSelectVariant).toHaveBeenCalledTimes(1);
    expect(onSelectVariant).toHaveBeenCalledWith(variantB);
  });

  it('marks the chosen variant "✓ Selected" and dims the others, same convention as an existing decision choice', () => {
    const proposal = makeProposal({ variants: [makeVariant({ id: 'v1', label: 'Option A' }), makeVariant({ id: 'v2', label: 'Option B' })] });
    renderCard(proposal);

    fireEvent.click(screen.getByTestId('artifact-proposal-select-v2'));

    expect(screen.getByTestId('artifact-proposal-selected-v2')).toHaveTextContent('✓ Selected');
    // The other variant is still visible (audit trail) but no longer
    // actionable, and the state pill moves off "pending".
    expect(screen.getByTestId('artifact-proposal-variant-v1')).toBeInTheDocument();
    expect(screen.queryByTestId('artifact-proposal-select-v1')).not.toBeInTheDocument();
    expect(screen.getByTestId('artifact-proposal-state')).toHaveTextContent('Accepted');
  });

  it('does not stay actionable after selection (bug-class fix, same as the mission-charter stuck-pending bug)', () => {
    const proposal = makeProposal({ variants: [makeVariant({ id: 'v1' })] });
    const { onSelectVariant } = renderCard(proposal);

    fireEvent.click(screen.getByTestId('artifact-proposal-select-v1'));
    expect(onSelectVariant).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('artifact-proposal-select-v1')).not.toBeInTheDocument();
  });

  it('calls onReject and resolves locally when rejected', () => {
    const { onReject } = renderCard(makeProposal());
    fireEvent.click(screen.getByTestId('artifact-proposal-reject'));

    expect(onReject).toHaveBeenCalledOnce();
    expect(screen.getByTestId('artifact-proposal-state')).toHaveTextContent('Rejected');
    expect(screen.queryByTestId('artifact-proposal-reject')).not.toBeInTheDocument();
  });

  it('scales a view down to fit the frame when an intended size is given, without assuming any fixed aspect ratio otherwise', () => {
    const withSize = makeProposal({
      variants: [makeVariant({ views: [{ id: 'sized', label: 'Sized', html: '<p>x</p>', width: 1080, height: 1350 }] })],
    });
    renderCard(withSize);
    const iframe = screen.getByTestId('artifact-frame-sized');
    expect(iframe).toHaveStyle({ width: '1080px', height: '1350px' });
    expect(iframe.style.transform).toMatch(/scale\(/);
  });

  // AUTO-SCALE FIX — this bug's own real repro: a 1080x1080 srcDoc rendered
  // 1:1 inside a small frame showed only its own top-left corner because the
  // old scaling only ever triggered off DECLARED metadata, never the real
  // rendered content. The fix measures the sandboxed document's own actual
  // size on `onLoad` and scales from THAT — proven here with NO declared
  // width/height on the view at all (the exact repro shape), so this can
  // only pass via real measurement, never the old declared-metadata path.
  describe('real-measurement auto-scale (bug fix: no declared metadata required)', () => {
    it('scales a measured 1080x1080 view so it fits entirely inside its frame, aspect ratio preserved', () => {
      const proposal = makeProposal({
        variants: [makeVariant({ views: [{ id: 'square', label: 'Square', html: '<p>x</p>' }] })],
      });
      renderCard(proposal);
      const iframe = screen.getByTestId('artifact-frame-square') as HTMLIFrameElement;

      // Before measurement: no declared size either — fills its box
      // unscaled (same posture as before this fix for the pre-load instant).
      expect(iframe.style.transform).toBe('');

      stubIframeContentSize(iframe, 1080, 1080);

      // Real measurement now drives the scale — iframe keeps its NATIVE
      // (1080x1080) size, shrunk via transform, never assumed from metadata.
      expect(iframe).toHaveStyle({ width: '1080px', height: '1080px' });
      expect(iframe.style.transform).toMatch(/scale\(/);
      const scaleMatch = iframe.style.transform.match(/scale\(([^)]+)\)/);
      expect(scaleMatch).not.toBeNull();
      const scale = Number(scaleMatch![1]);
      // Fits entirely inside its own frame in BOTH dimensions — never clipped.
      expect(1080 * scale).toBeLessThanOrEqual(220 + 0.5);
      expect(1080 * scale).toBeLessThanOrEqual(260 + 0.5);
    });

    it('scales a portrait view with no declared metadata identically via measurement', () => {
      const proposal = makeProposal({
        variants: [makeVariant({ views: [{ id: 'tall', label: 'Tall', html: '<p>x</p>' }] })],
      });
      renderCard(proposal);
      const iframe = screen.getByTestId('artifact-frame-tall') as HTMLIFrameElement;
      stubIframeContentSize(iframe, 800, 2000);

      expect(iframe).toHaveStyle({ width: '800px', height: '2000px' });
      const scaleMatch = iframe.style.transform.match(/scale\(([^)]+)\)/);
      expect(scaleMatch).not.toBeNull();
      const scale = Number(scaleMatch![1]);
      expect(800 * scale).toBeLessThanOrEqual(220 + 0.5);
      expect(2000 * scale).toBeLessThanOrEqual(260 + 0.5);
    });
  });

  describe('computeContainedLayout (pure scale-to-fit math)', () => {
    it('fits a 1080x1080 view inside a measured 218x258 frame, aspect ratio preserved, no overflow', () => {
      const layout = computeContainedLayout(1080, 1080, 218, 258);
      expect(layout.boxWidth).toBeLessThanOrEqual(218);
      expect(layout.boxHeight).toBeLessThanOrEqual(258);
      // Square content stays square after a single uniform scale.
      expect(layout.boxWidth).toBe(layout.boxHeight);
      expect(layout.scale).toBeCloseTo(218 / 1080, 5);
    });

    it('never scales up past the content\'s own natural size', () => {
      const layout = computeContainedLayout(100, 100, 220, 260);
      expect(layout.scale).toBe(1);
      expect(layout.boxWidth).toBe(100);
      expect(layout.boxHeight).toBe(100);
    });

    it('degrades to filling the available box when the intrinsic size is unknown (0)', () => {
      const layout = computeContainedLayout(0, 0, 220, 260);
      expect(layout).toEqual({ boxWidth: 220, boxHeight: 260, scale: 1 });
    });
  });

  describe('expand affordance (AGRANDIR une vue for real legibility)', () => {
    it('opens a full-panel overlay rendering the same sandboxed content, and closes on demand', () => {
      const proposal = makeProposal({
        variants: [makeVariant({ views: [{ id: 'v1', label: 'Page 1', html: '<p>hello</p>' }] })],
      });
      renderCard(proposal);

      expect(screen.queryByTestId('artifact-frame-expanded-v1')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('artifact-frame-expand-v1'));

      const overlayIframe = screen.getByTestId('artifact-frame-expanded-iframe-v1');
      expect(overlayIframe).toHaveAttribute('sandbox', 'allow-same-origin');
      expect(overlayIframe).toHaveAttribute('srcdoc', '<p>hello</p>');

      fireEvent.click(screen.getByTestId('artifact-frame-expanded-close-v1'));
      expect(screen.queryByTestId('artifact-frame-expanded-v1')).not.toBeInTheDocument();
    });
  });

  // NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — same bug-class fix
  // as MissionCharterCard.test.tsx's own "queue-aware resolution" describe
  // block: a selection/rejection made while the manager is busy is QUEUED,
  // not sent — the card must show that explicitly, never a false "Accepted"/
  // "Rejected", and must stay actionable if it could not be taken in charge.
  describe('queue-aware resolution (bug fix: false final state while merely queued)', () => {
    it('shows an explicit "Queued" state — not "Accepted" — when selecting a variant returns \'queued\'', () => {
      const onSelectVariant = vi.fn().mockReturnValue('queued');
      const proposal = makeProposal({ variants: [makeVariant({ id: 'v1' })] });
      renderCard(proposal, { onSelectVariant, isActionQueued: true });

      fireEvent.click(screen.getByTestId('artifact-proposal-select-v1'));

      expect(onSelectVariant).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('artifact-proposal-state')).toHaveTextContent('Queued');
      expect(screen.getByTestId('artifact-proposal-state')).not.toHaveTextContent('Accepted');
      expect(screen.queryByTestId('artifact-proposal-select-v1')).not.toBeInTheDocument();
    });

    it('promotes "Queued" to "Accepted" on its own the instant the queue actually flushes', () => {
      const onSelectVariant = vi.fn().mockReturnValue('queued');
      const proposal = makeProposal({ variants: [makeVariant({ id: 'v1' })] });
      const { rerender } = renderCard(proposal, { onSelectVariant, isActionQueued: true });

      fireEvent.click(screen.getByTestId('artifact-proposal-select-v1'));
      expect(screen.getByTestId('artifact-proposal-state')).toHaveTextContent('Queued');

      rerender(
        <I18nProvider>
          <ArtifactProposalCard proposal={proposal} onSelectVariant={onSelectVariant} onReject={vi.fn()} isActionQueued={false} />
        </I18nProvider>,
      );

      expect(screen.getByTestId('artifact-proposal-state')).toHaveTextContent('Accepted');
      expect(onSelectVariant).toHaveBeenCalledTimes(1);
    });

    it('stays fully actionable when selection returns \'idle\' (could not be taken in charge)', () => {
      const onSelectVariant = vi.fn().mockReturnValue('idle');
      const proposal = makeProposal({ variants: [makeVariant({ id: 'v1' })] });
      renderCard(proposal, { onSelectVariant });

      fireEvent.click(screen.getByTestId('artifact-proposal-select-v1'));

      expect(screen.getByTestId('artifact-proposal-state')).toHaveTextContent('Pending validation');
      expect(screen.getByTestId('artifact-proposal-select-v1')).toBeInTheDocument();
    });
  });
});
