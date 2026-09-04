/* artifactProposal — UI-local type + pure helpers for the "visible design
   preview" surface (real founder feedback, verbatim: "comment tu me montres
   les designs proposes ?" — a proposed visual artifact, e.g. a template,
   used to render as a plain text card; the user would validate a design
   they had never actually seen).

   GENERIC BY CONSTRUCTION (non-negotiable per this task's own brief):
   nothing here names a content format, a network, or a use case — no
   "carousel", no "Instagram", no fixed view/variant count anywhere. Every
   label is either a fixed i18n string (this module has none of its own —
   ArtifactProposalCard.tsx owns all display copy) or a free-form value the
   agent supplied (artifact name, view/variant labels, the HTML itself). Any
   subject/format can walk this exact same path.

   WIRED (was an INTEGRATION GAP, now closed by a sibling task): a
   `propose_artifact` manager action and `ManagerMessage.artifactProposal`
   field both now exist (lib/agents/types.ts), and agentsStore.tsx's executor
   materializes the SAME variants/views onto a canvas surface
   (`SurfaceSpec.htmlViews`, canvasStore.ts's `upsertArtifactSurface`) while
   also attaching this module's shape verbatim to the assistant message for
   ArtifactProposalCard.tsx's chat card. `LazyManagerMessageList.tsx`'s
   `MessageWithArtifact` widening predates that landing and is now a no-op
   (the field is a real, always-present-when-relevant key on
   `ManagerMessage`) — left as is (out of this task's locked perimeter:
   src/components/lazyManager/**, src/components/agents/canvas/nodes/**,
   canvasStore.ts, canvasTypes.ts only) rather than narrowed, since removing
   it needs no correctness fix, only a tidy-up. */

/** One view (page/screen/slide — no fixed meaning assumed) of one variant of
 *  a proposed visual artifact. */
export interface ArtifactView {
  id: string;
  /** Plain-language, agent-supplied label (e.g. "Page 1", "Ecran d'accueil")
   *  — never assumed to be a slide/page number or a fixed sequence name. */
  label: string;
  /** Full standalone HTML document (or fragment) for this view — rendered
   *  verbatim inside a fully-locked-down sandboxed iframe by
   *  ArtifactProposalCard.tsx, never executed or interpreted by this app. */
  html: string;
  /** Optional intended pixel size — when present, the preview frame scales
   *  the rendered content down to fit its box instead of assuming any fixed
   *  aspect ratio. Absent when the artifact carries no fixed canvas size. */
  width?: number;
  height?: number;
}

/** One alternative design (spec: "plusieurs propositions, dont une avec
 *  notre DA") — a variant's own label is free-form/agent-supplied text, so
 *  "the one with our brand kit" is just a label, never a hardcoded concept
 *  this module knows about. */
export interface ArtifactVariant {
  id: string;
  /** Plain-language, agent-supplied label (e.g. "Option A", "Avec notre DA"). */
  label: string;
  /** At least one view — never assumed to be exactly one (spec: "ne suppose
   *  pas un nombre de vues fixe"). */
  views: ArtifactView[];
}

export interface ArtifactProposal {
  state: 'pending' | 'accepted' | 'rejected';
  artifactId?: string;
  /** Plain-language name of the artifact (e.g. "Gabarit visuel"),
   *  agent-supplied — never a hardcoded label. */
  name: string;
  /** Free-form version label (e.g. "v2"), agent-supplied — absent when the
   *  agent didn't name one. */
  version?: string;
  /** At least one variant — a single-variant proposal is still valid (the
   *  founder's "plusieurs propositions" ask is additive, not a hard minimum
   *  enforced by this type). */
  variants: ArtifactVariant[];
  /** Set once the user picks a variant — mirrors DecisionCard's own
   *  resolved-choice convention (a chosen id, restated here rather than
   *  re-askable). */
  selectedVariantId?: string;
}

/** Interim send-as-text wiring (same INTEGRATION GAP as missionCharter.ts's
 *  own formatCharterValidationMessage/formatCharterRejectMessage): until a
 *  dedicated store method exists for `artifactProposal`, selecting a variant
 *  or rejecting the whole proposal is restated as plain language and sent as
 *  the user's own turn via `store.send(text)` — see LazyManager.tsx's
 *  wiring site. */
type T = (key: string, params?: Record<string, string | number>) => string;

export function formatArtifactSelectionMessage(proposal: ArtifactProposal, variant: ArtifactVariant, t: T): string {
  return t('lazyManager.artifact.selectMessage', { name: proposal.name, variant: variant.label });
}

export function formatArtifactRejectMessage(proposal: ArtifactProposal, t: T): string {
  return t('lazyManager.artifact.rejectMessage', { name: proposal.name });
}
