/* GraphProposalCard — rendered inside ManagerBubble when a manager message
   carries a `proposal` field. Shows the plan objective, steps, estimated
   cost/duration, and Validate/Modify/Reject buttons.

   On pending state, emits 'manager:expandOverlay' so the overlay widens to
   give room for the proposal. On accept/reject, emits 'manager:shrinkOverlay'.

   Accept calls agentsStore.executePlan(planId).
   Reject clears the proposal and allows the user to modify their request.

   2026-08 legibility rewrite (founder, verbatim: the in-chat graph "ne
   fonctionne pas du tout" on a complex plan) — six fixes, all confined to
   this file plus graphProposalGraph.ts (the graph data pipeline itself —
   compileOrchestrator.ts/graphIr.ts/irToCanvas.ts — is untouched), plus the
   `lazyManager.proposal.*` i18n keys the new strings below need (added to
   all six locales in the same change: a missing key falls back to the raw
   key string in the UI — itself a broken-looking symptom this rewrite
   exists to eliminate):
     1. Node visuals now reuse the REAL canvas's own palette (nodeChrome.tsx's
        `typeAccentColor`/`TypeGlyph`) and the real join diamond geometry
        (JoinNode.tsx's rotate(45)/0.6-scale recipe), instead of a flat
        hand-rolled amber SVG. The contest ("best-of-N") node gets a real
        double-outline + pill instead of a small "N" badge.
     2. NEVER DEGRADE IN SILENCE — the old `buildFallbackLayout` used to be
        PAINTED FIRST, then silently swapped for the real elkjs layout a
        moment later (a visible jump — the exact "double layout" bug the
        design review flagged). It is now only ever used as a real, honest
        degraded view if elkjs genuinely fails; while elkjs is resolving,
        `ProposalGraphPreview` renders a `Skeleton` placeholder instead — so
        there is exactly ONE visible transition (skeleton -> real graph),
        never two different "real-looking" graphs shown back to back. A
        bounded watchdog (`LAYOUT_RESOLUTION_TIMEOUT_MS`) hardens this:
        even a pathological elkjs stall (a never-settling promise) lands on
        the honest degraded view + banner, never a perpetual skeleton.
     3. Labels are single-line + CSS ellipsis (via a `foreignObject`, the
        standard way to get real text-overflow inside SVG) with a rich
        multi-line tooltip (role/model/dependencies) instead of the old
        `labelLines()` hard-wrap that mangled real step titles.
     4. Broken-dependency warning — partial approval (unchecking a step) can
        silently leave a still-checked step depending on an unchecked one;
        `computeDependencyWarnings` (graphProposalGraph.ts, pure) flags this
        and a banner renders right above the action buttons, visible before
        the user clicks Validate.
     5. `proposal.steps.length === 0` now renders an explicit, honest empty
        state instead of just omitting the graph/step-list block — a
        disappearing section reads as "broken", not "there is nothing here".
     6. Nodes sharing a `joinGroup` (2+, matching compileOrchestrator.ts's
        own threshold for actually synthesizing a join) get a translucent
        backing behind them, so parallel fan-out is visible at a glance.

   Deliberately OUT of scope (left as a TODO, not half-built — see
   ProposalGraphPreview's own comment): a "see full graph" escape hatch to
   the real canvas. A pending proposal has no materialized canvas nodes yet
   (materialization only happens on Validate), so there is nothing real to
   route to before that point; the real canvas's own minimap/pan/zoom
   (CanvasView.tsx) is a separate, larger task. No bespoke pan/zoom is built
   here either way (standing instruction) — the existing scroll container is
   plain native overflow, not a new zoom widget. Also standing: no semantic
   zoom / adaptive hiding by zoom level anywhere in this card.

   2026-08 off-main-thread follow-up wave (founder's #1 complaint, live-
   diagnosed via this card's OWN diagnostics: "layout timed out after
   4000ms" while the app logged `system pressure changed: Normal ->
   Elevated`) — the six fixes above were correct but incomplete: elkjs was
   never slow, it was STARVED on the main thread. layout.ts's
   `layoutPreviewGraph` now runs off-thread (see that file's header); this
   file's own share of the fix is threefold: (a) fix #2 no longer latches
   `failedGraph` permanently — the real layout SWAPS IN and the banner
   disappears the moment a delayed result actually lands (see the effect's
   `.then` handler below); (b) `LAYOUT_RESOLUTION_TIMEOUT_MS` is raised
   4000ms -> 8000ms now that it only guards a genuinely pathological/never-
   settling case, not a busy machine; (c) the honest degraded fallback
   (and its loading-skeleton foreshadow) now scale-to-fit the chat panel
   instead of forcing a huge fixed-pixel canvas that read as clipped/
   broken — this fit mechanism (originally the fallback-only `fitContainer`
   prop) was later generalized to the SUCCESSFUL graph too; see the "third
   verification pass" entry below and `GRAPH_HEIGHT_BUDGET`'s own comment
   for the current (unconditional, no `fitContainer` boolean) shape of it.

   2026-08 second verification pass — the founder's own CDP probe showed
   `layoutPreviewGraph` resolving in ~20ms for the SAME proposal a live card
   was permanently stuck on ("layout timed out after 8000ms", never
   recovering for minutes). The `.then`/`.catch` handlers below used to gate
   their ENTIRE body (including the un-latch/recovery logic) behind a
   per-effect-invocation `cancelled` boolean — correct for "should I React
   to a result for a graph that is no longer relevant", but a strictly
   PER-INVOCATION flag has a real gap: it cannot distinguish "this exact
   invocation was cleaned up because a DIFFERENT invocation for the SAME
   still-current graph is now handling it" (harmless — StrictMode's dev-only
   double effect invoke does exactly this) from "this graph is genuinely
   stale". `currentGraphRef` below replaces it with a check against the
   ACTUAL latest rendered graph (updated on every render, not tied to any
   one effect invocation): a settling promise is applied whenever its own
   `graph` is STILL the current one, regardless of which invocation started
   it — and a `console.debug` trail (previewLayoutWorkerClient.ts's own
   `debugLog`, shared `window.__lazyLayoutDebugLog` ring buffer) now marks
   every settle as "applied" or "stale (superseded)" so this is verifiable
   live, not just reasoned about — see that module's own header for the CDP
   read command.

   2026-08 third verification pass — CONFIRMED FIXED live: the watchdog fix
   above works, the graph renders. But the founder measured the SUCCESSFUL
   graph's own SVG at 916x236 inside a docked panel column ~300px wide —
   one node visible, the rest reachable only by scrolling. "A 12-node plan
   that shows one node at a time is still a failure" for a feature whose
   whole point is grasping a plan's SHAPE at a glance before approving it.
   Fix #4/#7's scale-to-fit treatment (GRAPH_HEIGHT_BUDGET/
   DOCKED_PANEL_WIDTH_FLOOR/MIN_READABLE_SCALE, all just above) was real but
   had only ever been wired to the DEGRADED fallback view
   (`fitContainer={isFailed}`) — the successful graph, the actual point of
   this feature, still rendered at a fixed large pixel size. Both paths now
   go through the identical fit logic unconditionally, responsive to this
   card's REAL measured width (a ResizeObserver, not a hardcoded pixel
   constant) so the manager overlay's expanded state genuinely gets more
   room instead of staying capped at the docked width, with a legibility
   floor (`MIN_READABLE_SCALE`) below which free-text labels are omitted in
   favor of the existing numbered badge/type glyph — full detail always one
   hover away via the unchanged `<title>` tooltip. This is a one-time,
   non-interactive density choice from (content size, real container size)
   at render time, not the canvas's own rejected "semantic zoom" (no zoom
   control exists on this card, nothing changes as anyone interacts with
   anything) — see `MIN_READABLE_SCALE`'s own comment for the full
   reasoning on why these are different mechanisms, not a case of quietly
   ignoring that standing rule.

   2026-08 fourth verification pass — the founder manually expanded the
   panel to 769px (well past the docked 244px floor the third pass fixed)
   and STILL saw every node as a bare numbered badge + glyph, no text at
   all: "there is plainly room for step titles at that width". Root cause
   (live-verified against elkjs, not assumed): `MIN_READABLE_SCALE` gated
   on the WHOLE graph's fit scale, `Math.min(width ratio, height ratio, 1)`
   — but `GRAPH_HEIGHT_BUDGET` is a fixed 216px regardless of panel width,
   so any plan with real fan-out is HEIGHT-bound, not width-bound (the
   founder's own described shape — 2 sequential -> 4-way parallel -> join
   -> 3-chain — lays out via elkjs to 1494x460, whose fit scale caps at
   216/460=0.47 no matter how wide the container gets; widening the panel
   could never cross the old 0.6 floor for this shape). `MIN_READABLE_SCALE`
   is replaced by `MIN_LEGIBLE_LABEL_BOX_PX`, gating on the label's actual
   RENDERED (post-scale) on-screen pixel width instead of the abstract
   scale fraction — see that constant's own comment just above
   `computeGraphFit` for the full formula. The other half of the same bug:
   text used to shrink 1:1 with the ambient scale (an 11px font at
   scale=0.47 rendered as an illegible 5.2px), which would have made even a
   correctly-widened box useless — every text element in `RealGraphSvg` now
   counter-scales its own font-size (`<CONST>_PX / scale`) to a constant
   on-screen size, so node geometry still shrinks with the graph but text
   never does.

   2026-08 "giant empty rectangle" fix (David, verbatim: "pourquoi la j'ai
   un agent géant dans le canva ??") — investigated fresh against this
   exact file's own git history before touching anything. The empty boxes
   are NOT a bug: dcd708a ("readable plan proposal — empty graph boxes")
   deliberately removed free-text titles from inside these nodes after
   David called the earlier labeled version illisible even WITH the
   legibility-floor machinery above (MIN_LEGIBLE_LABEL_BOX_PX/counter-scaled
   fonts) already in place — and GraphProposalCardFit.test.tsx locks that
   decision in explicitly ("boxes are never labeled at any width... by
   design"). So the fix here is deliberately NOT "add a truncated title via
   `truncateMiddle`" — that reopens a question this same user already
   answered once, in this same file, with a test suite guarding the answer.
   What WAS still a real, undecided bug: `TASK_NODE_SIZE` stayed 180x84 —
   the actual content (a 21x21 badge + a 16x16 glyph/pill) only ever
   occupied a ~30px-tall strip, so 64% of every box's height was bare
   background fill. That disproportion, not a missing label, is what reads
   as "a giant agent [box] with nothing in it". `TASK_NODE_SIZE` (see its
   own comment in graphProposalGraph.ts) is now 120x40 — sized to its real
   content, not shrunk to nothing (still room for the contest pill without
   forcing dense mode) — and every node below now vertically CENTERS its
   badge/glyph/pill in the box instead of pinning them to a fixed top-left/
   top-right offset that assumed a much taller box. The branching structure
   (joins, contest fan-out, joinGroup backing, dashed dependency edges) is
   the graph's real value over the flat ÉTAPES list underneath it and stays
   untouched — this pass only fixes the box-to-content ratio, never the
   free-text question already settled above.
*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { SafeResizeObserver } from '../../lib/safeResizeObserver';
import { useI18n } from '../../i18n';
import { emit, _debugLogOverlayWidth } from '../../lib/bus';
import { Skeleton } from '../ui';
import { getProviderMode } from '../../lib/models';
import {
  detectModelEntitlements,
  buildModelPickerOptions,
  type ModelOptionGroup,
} from '../../lib/models/modelPickerOptions';
import { ENGINE_I18N_KEY, CREDIT_METERED_ENGINES, type EngineKey } from './LazyManagerHeader';
import { typeAccentColor, TypeGlyph } from '../agents/canvas/chrome/nodeChrome';
import { ModelPickerDropdown } from '../common/ModelPickerDropdown';
import { useDismissable } from '../common/useDismissable';
import { layoutPreviewGraph, type PreviewGraphLayout } from '../agents/canvas/layout';
import { computePreviewGraphSignature, _debugLogPreviewLayout } from '../agents/canvas/previewLayoutWorkerClient';
import {
  buildProposalGraph,
  buildFallbackLayout,
  buildStepTooltip,
  buildJoinTooltip,
  computeDependencyWarnings,
  computeOutOfScopeStepWarnings,
  computeJoinGroupBackings,
  type Proposal,
  type ProposalGraph,
  type ProposalGraphNode,
  type ProposalGraphNodeKind,
} from './graphProposalGraph';
import type { ManagerMessage } from '../../lib/agents/types';
import { describePendingAction } from '../agents/agentsStore';
import { useAppContextOptional } from '../../app/AppContext';

export interface GraphProposalCardProps {
  msg: ManagerMessage;
  onAccept: (planId: string, opts?: { stepIds?: string[] }) => void;
  onModify?: (planId: string) => void;
  onReject: () => void;
  /** Feature E — per-step model chip: called when the user picks a launch
   *  model for one step of a still-pending plan. Optional so every
   *  pre-existing caller/test keeps compiling exactly as before (the chips
   *  simply render read-only without it). */
  onStepModelChange?: (planId: string, stepId: string, modelId: string) => void;
  /** NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — true while a
   *  click on Validate/Modify/Reject has been queued (manager busy at click
   *  time) but not yet actually sent. This card has no local optimistic
   *  resolution of its own (it reflects the real `proposal.state`), so the
   *  fix here is simpler than MissionCharterCard's: just never silently
   *  drop the click, and show the user why the buttons are disabled.
   *  Optional, defaulting to false so every pre-existing caller/test keeps
   *  behaving exactly as before. */
  isActionQueued?: boolean;
}

// Same gold used by chrome/contestChrome.tsx's ContestWinnerChip — a
// contest node in this still-pending preview and a materialized winner
// chip on the real canvas are two moments of the SAME "best-of-N" concept,
// so they share the one accent instead of each inventing their own. Not in
// nodeChrome.tsx's TYPE_ACCENT_COLORS map (that map is keyed by canvas node
// KIND, and "contest" only ever exists pre-materialization — it explodes
// into N real `mission` nodes + a join once accepted).
const CONTEST_ACCENT = '#FACC15';

// Bounded wait for elkjs (fix #2 hardening; RAISED 4000ms -> 8000ms in the
// 2026-08 off-main-thread rewrite, see layout.ts's own header for the full
// diagnosis). This number is no longer defending against a starved main
// thread — layout.ts's `layoutPreviewGraph` now runs the actual elkjs call
// in a dedicated Worker (previewLayoutWorkerClient.ts), which cannot be
// blocked BY, and cannot block, React's render/commit work, no matter how
// busy the main thread gets. What this watchdog still exists for is a
// GENUINELY pathological plan (or a worker crash — see that module's
// `onerror` handling) that never settles at all; it is not there to punish
// a busy machine anymore, so it can afford to be generous. 8000ms is 2x the
// old value: a real worker computation on a large plan under real system
// load (the founder's own repro logged `cpu=81%` at the moment of failure)
// still needs genuine wall-clock time even off the main thread, and the
// user-visible cost of waiting slightly longer is small — the skeleton
// placeholder is a reasonable loading state, and per fix #2 below (NEVER
// DEGRADE PERMANENTLY) even a timeout past this deadline is no longer a
// dead end: the real layout still SWAPS IN the moment it actually lands.
const LAYOUT_RESOLUTION_TIMEOUT_MS = 8000;

// Diagnosability fix (founder's #1 complaint, layer 3) — the old
// `.catch(() => setFailedGraph(graph))` swallowed the error object
// entirely, so nobody could tell an elkjs exception apart from a
// degenerate (0x0) result or the watchdog timeout below — three very
// different failure modes with the SAME user-facing banner. Same stable
// log-prefix convention as layout.ts's own `LAYOUT_LOG_PREFIX` (a
// developer greps for either).
const LAYOUT_FAILURE_LOG_PREFIX = '[GraphProposalCard]';

type LayoutFailureReason =
  | { kind: 'error'; message: string }
  | { kind: 'degenerate' }
  | { kind: 'timeout' };

/** Short, dev-facing one-liner for the banner's title/tooltip — the raw
 *  `Error.message` (never `.stack`: this can render as a hover tooltip a
 *  non-technical user could see, so it must stay a plain sentence, not a
 *  dump of internals). */
function describeLayoutFailure(reason: LayoutFailureReason): string {
  switch (reason.kind) {
    case 'timeout':
      return `layout timed out after ${LAYOUT_RESOLUTION_TIMEOUT_MS}ms`;
    case 'degenerate':
      return 'layout resolved but produced an empty (0x0) result';
    case 'error':
      return `layout failed: ${reason.message.slice(0, 200)}`;
    default:
      return 'layout failed';
  }
}

// fix #4 (2026-08 legibility follow-up, founder's own photograph: "half the
// card empty, nodes pushed off the right edge and clipped, edges running
// off into nothing") — the preview container is a fixed 244px-tall panel
// inside the docked manager panel (ManagerOverlay.tsx's OVERLAY_WIDTH_NORMAL,
// 360px, minus this card's own border/padding). The REAL elkjs layout
// (PREVIEW_LAYERED_OPTIONS's tight spacing) is normally close to this size
// already; the honest DEGRADED fallback (buildFallbackLayout's plain BFS
// layering) is not — a 15-node plan easily lays out to 1000+px wide, and
// the old rendering forced the SVG's own pixel width/height to match that
// large content 1:1 (`Math.max(viewWidth, 420)`), which only ever GROWS the
// rendered box to fit the content, never shrinks the content to fit the
// box — so most of a wide/deep fallback graph rendered outside the visible
// area, reachable only by a scrollbar easy to miss in a small chat panel
// (functionally "clipped" to the user, whatever the DOM technically
// allowed).
//
// fix #7 (2026-08 third verification pass, founder: "the graph does not
// fit the panel... a 12-node plan that shows one node at a time is still a
// failure") — this fit treatment used to be wired ONLY to the degraded
// fallback (`RealGraphSvg`'s old `fitContainer` prop, `fitContainer={isFailed}`
// at this file's one call site). The SUCCESSFUL graph — the actual point
// of this whole feature — still rendered at a fixed large pixel size
// (`Math.max(viewWidth, 420)`), requiring horizontal scroll for anything
// past a couple of nodes. Both paths now go through the SAME fit logic
// unconditionally (`RealGraphSvg` no longer takes a `fitContainer` boolean
// at all): `GRAPH_HEIGHT_BUDGET` bounds height, and width is always
// responsive (`width="100%"`) to `containerWidth` — the card's OWN real
// measured width (via `ResizeObserver` in `ProposalGraphPreview`, the same
// ad-hoc-per-component pattern already used by TerminalView.tsx/
// BrainGraph3D.tsx — no shared hook exists in this codebase yet worth
// adding for a single caller), so the graph automatically uses the extra
// room when the manager overlay is expanded (ManagerOverlay.tsx:
// EXPANDED_MIN_WIDTH_FLOOR..EXPANDED_MAX_WIDTH_CAP, 480-920px) instead of
// staying capped at the docked width. `DOCKED_PANEL_WIDTH_FLOOR` is the
// conservative default assumed ONLY before the observer's first report
// (the very first paint) — the narrowest real panel state, so nothing
// overflows even on that first frame.
//
// 2026-08 "giant empty rectangle" fix — `TASK_NODE_SIZE` shrank from
// 180x84 to 120x40 (graphProposalGraph.ts's own comment on that constant),
// which retired the "label area left over after reserving a badge and a
// glyph" derivation this constant used to use (`TASK_NODE_SIZE.width - 38 -
// 26`) — that math assumed a box wide enough to hold BOTH a badge on the
// left AND either a glyph or a free-text title on the right, a layout task
// nodes no longer have (badge + glyph/pill only, no title, see this file's
// top header). The only free text left anywhere in this SVG is the contest
// "best of N" pill and the joinGroup caption — both still gated by `dense`
// below — so this constant now directly represents THEIR representative
// on-screen box width (the pill's own 56px minus its ~8px of internal
// padding) instead of a task-node label area that no longer exists.
const REPRESENTATIVE_LABEL_BOX_USER_PX = 48;
const MIN_LEGIBLE_LABEL_BOX_PX = 32; // ~5 chars + ellipsis at PILL_FONT_PX below — the shortest run that still reads as a word, not noise

// `preserveAspectRatio="xMidYMid meet"` does the actual fitting with zero
// JS math: the browser scales the WHOLE viewBox down to whatever width the
// container really has, so every node stays visible without scrolling —
// but that same scaling can push text below legibility for a big/dense
// plan squeezed into the docked width. `MIN_READABLE_SCALE` is the
// legibility floor for exactly that case: below it, `RealGraphSvg` switches
// to a denser representation (per-node free-text labels/detail/group
// captions omitted; the numbered badge, type glyph, and join/contest
// shapes — none of them arbitrary-length text — stay) instead of silently
// shipping illegible micro-text. This is NOT the canvas's rejected
// "semantic zoom" pattern (no zoom control exists here, nothing changes as
// anyone interacts with anything): it is a one-time, non-interactive
// density choice made once at render time from (content size, real
// container size), exactly like a CSS responsive breakpoint. Every node's
// full title/role/dependencies stays reachable via its own `<title>`
// tooltip regardless of density (fix #3, unaffected by this).
const GRAPH_HEIGHT_BUDGET = 216;
const DOCKED_PANEL_WIDTH_FLOOR = 300;

// 2026-08 fourth verification pass (founder, live-measured: the panel
// manually expanded to 769px — well past the docked 244px floor — and the
// SVG STILL rendered every node as a bare numbered badge + glyph, no text
// anywhere). The old `MIN_READABLE_SCALE=0.6` gated density on the WHOLE
// graph's fit scale (`Math.min(width ratio, height ratio, 1)`) — "is the
// overall zoom-out factor above X". That conflates two different
// questions: GRAPH_HEIGHT_BUDGET is a FIXED 216px regardless of how wide
// the panel gets, so a plan with any real fan-out is HEIGHT-bound, not
// width-bound — verified live via elkjs against the founder's own
// described shape (2 sequential -> 4-way parallel -> join -> 3-chain):
// that lays out to 1494x460, whose fit scale caps at 216/460=0.47 NO
// MATTER how wide the container gets. Panel-width expansion could never
// cross the old 0.6 floor for this exact shape — the founder's "there is
// plainly room at this width" was right about the WIDTH, wrong only in
// assuming width was the binding dimension.
//
// The fix asked for directly: stop asking "is the overall scale above X"
// and ask "does a legible number of characters fit inside THIS node at
// this scale" — gate on the label's actual RENDERED (post-scale) on-
// screen pixel width, not the abstract scale fraction. (At the time this
// was a task node's own foreignObject label area; the 2026-08 "giant empty
// rectangle" fix above moved `REPRESENTATIVE_LABEL_BOX_USER_PX`'s
// declaration next to `DOCKED_PANEL_WIDTH_FLOOR` and re-anchored the SAME
// mechanism to the contest pill/joinGroup caption, since task nodes carry
// no free text at all anymore — the underlying "gate on rendered pixels,
// not raw scale" fix described in this paragraph is otherwise unchanged.)

// Text must stay legible at ANY graph scale — a font size that shrinks
// 1:1 with the ambient SVG scale (the old behavior: `fontSize: 11` inside
// a viewBox scaled down to 0.47 rendered as an 11*0.47=5.2px font,
// illegible regardless of whether the box was wide enough) is the OTHER
// half of this same bug — a wide-enough box with an unreadable font is no
// more useful than the old glyph-only view. Every text element gated by
// `dense` in `RealGraphSvg` below sets its CSS font-size to
// `<CONST>_PX / scale` (user-space units) so the ambient scale brings it
// back down to a CONSTANT on-screen size, independent of how zoomed-out
// the overall graph is — node geometry (rects/diamonds/edges) still
// scales normally, only text is counter-scaled, so "shape at a glance,
// content on demand" no longer trades one off against the other.
// 2026-08-06: after the "rectangles vides" change the only remaining
// free-text in the SVG is the contest pill — hence a single PILL_FONT_PX.
const PILL_FONT_PX = 9;
const GROUP_CAPTION_FONT_PX = 9;

/** Pure — the scale `preserveAspectRatio="xMidYMid meet"` will actually
 *  apply for a `viewWidth`x`viewHeight` viewBox inside `availableWidth`x
 *  `GRAPH_HEIGHT_BUDGET`, and whether a node's label area, AT THAT SCALE,
 *  is wide enough on screen to be worth rendering text into at all (see
 *  this file's own header comment above for why this replaced a flat
 *  scale threshold). Shared by `RealGraphSvg` and `GraphSkeleton` so the
 *  loading placeholder's footprint never visibly "jumps" once the real
 *  graph lands. */
function computeGraphFit(viewWidth: number, viewHeight: number, availableWidth: number): { scale: number; dense: boolean } {
  const scale = Math.min(availableWidth / viewWidth, GRAPH_HEIGHT_BUDGET / viewHeight, 1);
  const labelBoxOnScreenPx = REPRESENTATIVE_LABEL_BOX_USER_PX * scale;
  return { scale, dense: labelBoxOnScreenPx < MIN_LEGIBLE_LABEL_BOX_PX };
}

function nodeAccent(kind: ProposalGraphNodeKind): string {
  if (kind === 'join') return typeAccentColor('join');
  if (kind === 'contest') return CONTEST_ACCENT;
  return typeAccentColor('mission');
}

function isNodeActive(node: ProposalGraphNode | undefined, selectedSteps: ReadonlySet<number>): boolean {
  return node?.stepIndex === undefined || selectedSteps.has(node.stepIndex);
}

// ── Loading skeleton (fix #2) ───────────────────────────────────────────

/** Shimmering placeholder shown while elkjs is resolving the real layout —
 *  positions come from the BFS fallback layout, but ONLY for rough sizing
 *  (so the skeleton roughly foreshadows the graph's real footprint); no
 *  label, color, or edge is drawn, so there is nothing here that could read
 *  as a specific (possibly wrong) graph shape once the real one lands. */
function GraphSkeleton({
  graph,
  fallbackLayout,
  containerWidth,
}: {
  graph: ProposalGraph;
  fallbackLayout: PreviewGraphLayout;
  containerWidth: number | undefined;
}) {
  const { t } = useI18n();
  const rawWidth = Math.max(fallbackLayout.width, 280);
  const rawHeight = Math.max(fallbackLayout.height, 150);
  // fix #4/#7 — same fit treatment as RealGraphSvg (see this file's
  // GRAPH_HEIGHT_BUDGET/DOCKED_PANEL_WIDTH_FLOOR comment): a shimmering
  // skeleton for a big fallback footprint should foreshadow the real
  // graph's SHAPE at the SAME scale the real graph will land at, not a
  // canvas the user has to scroll to even see, and not a visibly
  // different size that "jumps" once the real graph swaps in.
  const { scale } = computeGraphFit(rawWidth, rawHeight, containerWidth ?? DOCKED_PANEL_WIDTH_FLOOR);
  return (
    <div
      data-testid="graph-proposal-skeleton"
      role="status"
      aria-label={t('lazyManager.proposal.layoutLoading')}
      style={{ position: 'relative', width: rawWidth * scale, height: rawHeight * scale, overflow: 'hidden' }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, width: rawWidth, height: rawHeight, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        {graph.nodes.map((node) => {
          const position = fallbackLayout.positions[node.id];
          if (!position) return null;
          return (
            <Skeleton
              key={node.id}
              width={node.width}
              height={node.height}
              borderRadius={node.kind === 'join' ? 999 : 11}
              style={{ position: 'absolute', left: position.x, top: position.y }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Real graph SVG (success path AND honest degraded-fallback path) ─────

interface RealGraphSvgProps {
  graph: ProposalGraph;
  layout: PreviewGraphLayout;
  selectedSteps: ReadonlySet<number>;
  /** fix #7 — the card's own real measured width (ResizeObserver, see
   *  ProposalGraphPreview) used to decide the legibility floor below;
   *  `undefined` only before the observer's first report, in which case
   *  DOCKED_PANEL_WIDTH_FLOOR is assumed. The VISUAL fit itself (never
   *  requiring horizontal scroll) needs no JS math at all — `width="100%"`
   *  plus `preserveAspectRatio="xMidYMid meet"` below does that
   *  unconditionally, for both the successful graph and the honest
   *  degraded fallback alike (no more `fitContainer` boolean). */
  containerWidth: number | undefined;
}

function RealGraphSvg({ graph, layout, selectedSteps, containerWidth }: RealGraphSvgProps) {
  const { t } = useI18n();
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const isSelected = (node: ProposalGraphNode | undefined): boolean => isNodeActive(node, selectedSteps);
  const viewWidth = Math.max(layout.width, 280);
  const viewHeight = Math.max(layout.height, 150);
  const backings = computeJoinGroupBackings(graph, layout);
  // fix #7 (legibility floor, this file's own header comment on
  // GRAPH_HEIGHT_BUDGET/MIN_LEGIBLE_LABEL_BOX_PX) — a fixed-length dense-
  // mode representation this SAME node loop below reads per node, never a
  // second layout pass: positions/edges are always the real elkjs ones.
  // `scale` is also read directly below (not just `dense`) to counter-
  // scale every text element's font-size back to a constant on-screen
  // size — see PILL_FONT_PX/GROUP_CAPTION_FONT_PX's own comment for why.
  const { scale, dense } = computeGraphFit(viewWidth, viewHeight, containerWidth ?? DOCKED_PANEL_WIDTH_FLOOR);

  return (
    <svg
      data-testid="graph-proposal-minigraph"
      data-dense={dense ? 'true' : undefined}
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      width="100%"
      height={GRAPH_HEIGHT_BUDGET}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', minWidth: '100%' }}
    >
      <defs>
        <marker id="graph-proposal-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-warning, #f5b942)" />
        </marker>
      </defs>

      {/* fix #6 — translucent backing behind every joinGroup's members, so
          parallel fan-out reads at a glance instead of being invisible
          structure only the edges hint at. Drawn first (behind edges/nodes). */}
      {backings.map((backing) => (
        <g key={`backing-${backing.joinGroup}`} data-testid={`graph-proposal-group-${backing.joinGroup}`}>
          <rect
            x={backing.x}
            y={backing.y}
            width={backing.width}
            height={backing.height}
            rx={16}
            fill="color-mix(in srgb, var(--color-accent) 8%, transparent)"
            stroke="color-mix(in srgb, var(--color-accent) 32%, transparent)"
            strokeWidth={1.2}
            strokeDasharray="4 4"
          />
          {/* fix #7 — a free-text group caption is exactly the kind of
              arbitrary-length text the legibility floor exists to hide;
              the backing rect itself (parallel fan-out's shape) stays. */}
          {!dense && (
            <text x={backing.x + 10} y={backing.y + 14} fontSize={GROUP_CAPTION_FONT_PX / scale} fontWeight="700" fill="var(--color-accent)" fontFamily="var(--font-mono)">
              {t('lazyManager.proposal.parallelGroupLabel', { group: backing.joinGroup })}
            </text>
          )}
        </g>
      ))}

      {graph.edges.map((edge) => {
        const source = nodesById.get(edge.from);
        const target = nodesById.get(edge.to);
        const sourcePosition = layout.positions[edge.from];
        const targetPosition = layout.positions[edge.to];
        if (!source || !target || !sourcePosition || !targetPosition) return null;
        const active = isSelected(source) && isSelected(target);
        const sourceX = sourcePosition.x + source.width;
        const sourceY = sourcePosition.y + source.height / 2;
        const targetX = targetPosition.x;
        const targetY = targetPosition.y + target.height / 2;
        const curve = Math.max(20, (targetX - sourceX) * 0.42);
        return (
          <path
            key={edge.id}
            data-testid={`graph-proposal-edge-${edge.id}`}
            d={`M ${sourceX} ${sourceY} C ${sourceX + curve} ${sourceY}, ${targetX - curve} ${targetY}, ${targetX} ${targetY}`}
            fill="none"
            stroke="var(--color-warning, #f5b942)"
            strokeWidth={active ? 2 : 1.4}
            strokeDasharray="5 4"
            opacity={active ? 0.82 : 0.24}
            markerEnd="url(#graph-proposal-arrow)"
          />
        );
      })}

      {graph.nodes.map((node) => {
        const position = layout.positions[node.id];
        if (!position) return null;
        const active = isSelected(node);
        const accent = nodeAccent(node.kind);

        // fix #1 — real diamond geometry (JoinNode.tsx: rotate(45deg) square
        // at 0.6 the box scale, rounded corners) + the canvas's own join
        // type-accent/glyph, instead of the old hand-rolled diamond path.
        if (node.kind === 'join') {
          const cx = position.x + node.width / 2;
          const cy = position.y + node.height / 2;
          const diamondSide = node.width * 0.6;
          const half = diamondSide / 2;
          return (
            <g key={node.id} data-testid={`graph-proposal-join-${node.id}`} opacity={active ? 1 : 0.5}>
              <title>{buildJoinTooltip(node, t)}</title>
              <rect
                x={cx - half}
                y={cy - half}
                width={diamondSide}
                height={diamondSide}
                rx="8"
                transform={`rotate(45 ${cx} ${cy})`}
                fill={active ? `color-mix(in srgb, ${accent} 16%, var(--canvas-node-bg, var(--color-panel-2)))` : 'var(--canvas-node-bg, var(--color-panel-3))'}
                stroke={accent}
                strokeWidth={active ? '1.8' : '1.2'}
                strokeDasharray={active ? undefined : '4 3'}
              />
              <svg x={cx - 9} y={cy - 9} width={18} height={18}>
                <TypeGlyph kind="join" size={18} color={accent} />
              </svg>
            </g>
          );
        }

        const tooltip = buildStepTooltip(node, t);
        const isContest = node.kind === 'contest';
        // 2026-08 "giant empty rectangle" fix — TASK_NODE_SIZE dropped from
        // 180x84 to 120x40 (see that constant's own comment), so the badge/
        // glyph/pill can no longer be pinned to a fixed top-left/top-right
        // offset tuned for a much taller box (that fixed offset is exactly
        // what used to leave the bottom ~64% of every box empty). All three
        // are now vertically centered against the node's OWN height, so a
        // future size tweak here never needs a matching offset hunt below.
        const badgeSize = 21;
        const badgeX = position.x + 8;
        const badgeY = position.y + (node.height - badgeSize) / 2;
        const glyphSize = 16;
        const glyphX = position.x + node.width - 8 - glyphSize;
        const glyphY = position.y + (node.height - glyphSize) / 2;
        const pillWidth = 56;
        const pillHeight = 16;
        const pillX = position.x + node.width - 8 - pillWidth;
        const pillY = position.y + (node.height - pillHeight) / 2;
        return (
          <g key={node.id} data-testid={`graph-proposal-node-${node.id}`} opacity={active ? 1 : 0.45}>
            <title>{tooltip}</title>
            {/* fix #1 — contest gets a real double-outline instead of a
                small "N" badge (the outer dashed ring below), plus a pill
                (further down) instead of the old bare "N" text. */}
            {isContest && (
              <rect
                data-testid={`graph-proposal-contest-ring-${node.id}`}
                x={position.x - 5}
                y={position.y - 5}
                width={node.width + 10}
                height={node.height + 10}
                rx={16}
                fill="none"
                stroke={CONTEST_ACCENT}
                strokeWidth={1.4}
                strokeDasharray="3 3"
                opacity={active ? 0.55 : 0.3}
              />
            )}
            <rect
              x={position.x}
              y={position.y}
              width={node.width}
              height={node.height}
              rx="11"
              fill={active ? `color-mix(in srgb, ${accent} 14%, var(--canvas-node-bg, var(--color-panel-2)))` : 'var(--canvas-node-bg, var(--color-panel-3))'}
              stroke={accent}
              strokeWidth={active ? '1.8' : '1'}
              strokeDasharray={active ? undefined : '5 4'}
            />
            <rect x={badgeX} y={badgeY} width={badgeSize} height={badgeSize} rx="6" fill={`color-mix(in srgb, ${accent} 22%, transparent)`} />
            <text x={badgeX + badgeSize / 2} y={badgeY + badgeSize / 2} textAnchor="middle" dominantBaseline="central" fill={accent} fontSize="10" fontWeight="800" fontFamily="var(--font-mono)">
              {node.stepIndex === undefined ? '•' : node.stepIndex + 1}
            </text>

            {/* 2026-08-06 (founder, verbatim: "tu pouvais pas ecrire dedans
                sinon c'etait illisible ... tu laisses le graph avec les
                rectangles vides") — NO free-text inside the SVG boxes. The
                node boxes are structurally informative (numbered badge,
                type glyph, join/contest shapes, colour, dashed outline for
                unselected) but every attempt to render real plan titles
                inside them (single-line ellipsis, then multi-line wrap)
                stayed unreadable at the fit scale. The full text
                (title/role/model/dependencies) lives in the <title>
                tooltip on hover AND in the step list right below the graph
                — the boxes themselves stay clean, so the topology reads at
                a glance at ANY scale. STILL TRUE after the 2026-08 sizing
                fix above — only the box shrank to match this content, the
                content itself (and the reasoning for keeping it free-
                text-free) is unchanged. */}
            {isContest && !dense ? (
              <foreignObject x={pillX} y={pillY} width={pillWidth} height={pillHeight}>
                <div
                  title={tooltip}
                  style={{
                    display: 'inline-flex',
                    fontSize: PILL_FONT_PX / scale,
                    fontWeight: 700,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'rgba(250,204,21,0.16)',
                    color: CONTEST_ACCENT,
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('lazyManager.proposal.contestBestOf', { n: node.contestN ?? 0 })}
                </div>
              </foreignObject>
            ) : (
              // fix #7 — the "best of N" pill is free text too (a count
              // that varies per proposal); role icons instead of names
              // below the legibility floor, matching the founder's own
              // suggestion, applies here identically — the mission glyph
              // already covers the non-contest case unconditionally.
              <svg x={glyphX} y={glyphY} width={glyphSize} height={glyphSize}>
                <TypeGlyph kind="mission" size={16} color={accent} />
              </svg>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Preview container — loading / real / honest-degraded states ─────────

function ProposalGraphPreview({
  proposal,
  selectedSteps,
}: {
  proposal: Proposal;
  selectedSteps: ReadonlySet<number>;
}) {
  const { t } = useI18n();
  const graph = useMemo(() => buildProposalGraph(proposal), [proposal]);
  const fallbackLayout = useMemo(() => buildFallbackLayout(graph), [graph]);
  const [resolved, setResolved] = useState<{ graph: ProposalGraph; layout: PreviewGraphLayout } | null>(null);
  const [failedGraph, setFailedGraph] = useState<ProposalGraph | null>(null);

  // fix #7 (2026-08 third verification pass, GRAPH_HEIGHT_BUDGET/
  // DOCKED_PANEL_WIDTH_FLOOR's own comment) — this card's REAL rendered
  // width, tracked live so the graph automatically uses the extra room the
  // moment the manager overlay expands (ManagerOverlay.tsx's
  // 'manager:expandOverlay'/'manager:shrinkOverlay', an animated CSS width
  // transition — ResizeObserver fires as it animates, not just once) rather
  // than staying frozen at the docked width. Same ad-hoc-per-component
  // ResizeObserver pattern already used by TerminalView.tsx/
  // BrainGraph3D.tsx (no shared hook exists yet in this codebase worth
  // adding for this one additional caller).
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = previewContainerRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new SafeResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Layer 3 (diagnosability) — WHY the layout failed, kept separate from
  // `failedGraph` (which only gates which view renders): an elkjs
  // exception, a degenerate result, and the watchdog timeout are three
  // different failure modes that used to be indistinguishable once
  // `.catch(() => setFailedGraph(graph))` swallowed the error object.
  const [failureReason, setFailureReason] = useState<LayoutFailureReason | null>(null);

  // 2026-08 second verification pass (this file's own top header) — tracks
  // the ACTUAL latest rendered `graph`, updated unconditionally on every
  // render (not inside an effect, so it is never one render "behind"). A
  // settling promise from ANY effect invocation is applied whenever its own
  // closed-over `graph` still matches THIS — never gated by whether that
  // SPECIFIC invocation's own cleanup already ran, which is what let
  // React StrictMode's dev-only double effect invoke (mount -> cleanup ->
  // mount again, synchronously, same `graph`) discard a still-relevant
  // result via the old per-invocation `cancelled` flag.
  const currentGraphRef = useRef(graph);
  currentGraphRef.current = graph;
  // THIRD root cause behind this same user-visible symptom (see this
  // file's own top header for the full chain: a dangling-edge crash, then
  // main-thread starvation, now this) — live-diagnosed via the debug trace
  // below: a real proposal resolved in 411ms and was correctly applied
  // (TWICE, once per StrictMode invocation), then the FIRST invocation's
  // watchdog fired anyway 8 seconds later and re-latched `failedGraph`,
  // silently demoting an already-successful, already-rendered graph to the
  // degraded banner. The watchdog was only ever cleared on the effect's
  // OWN cleanup (unmount/re-run), never on the promise it exists to guard
  // actually settling — a completely separate, always-armed 8-second bomb
  // sitting alongside the success path rather than being disarmed by it.
  // `resolvedGraphRef` is the defense-in-depth half of the fix: even if a
  // FUTURE change somehow reintroduces a path where a watchdog's own
  // `clearTimeout` gets skipped, this makes it impossible BY CONSTRUCTION
  // for a stale timer to act on a graph this ref says already has an
  // applied, successful layout — not merely unlikely.
  const resolvedGraphRef = useRef<ProposalGraph | null>(null);

  // fix #2 (NEVER DEGRADE IN SILENCE) — elkjs is the only source of a real
  // layout; a genuine failure sets `failedGraph` (rendered below with the
  // REAL fallback graph + a visible notice), it is never swallowed into
  // silently staying on the loading skeleton forever.
  useEffect(() => {
    const nodes = graph.nodes.map((node) => ({ id: node.id, width: node.width, height: node.height }));
    const edges = graph.edges.map((edge) => ({ id: edge.id, source: edge.from, target: edge.to }));
    // Debug-only correlation key (2026-08 second verification pass) — the
    // SAME structural signature previewLayoutWorkerClient.ts's cache logs
    // under, so a developer can trace one attempt end to end through
    // `window.__lazyLayoutDebugLog` (see that module's header for the CDP
    // read command) purely by grepping for this value. Gated on
    // `import.meta.env.DEV` (dead-code-eliminated in a production build,
    // per Vite's docs — see previewLayoutWorkerClient.ts's `DEBUG_ENABLED`
    // for the full rationale) so this card never pays for computing a
    // signature a SECOND time (layout.ts's own `layoutPreviewGraph`
    // already computes the real one for caching) purely for a log line
    // nobody in production will ever read.
    const debugSignature = import.meta.env.DEV ? computePreviewGraphSignature(nodes, edges) : '';
    const debugStartedAt = Date.now();
    _debugLogPreviewLayout('card effect started', { signature: debugSignature, nodeCount: graph.nodes.length });

    // fix #2 hardening — the bounded watchdog (see LAYOUT_RESOLUTION_TIMEOUT_MS
    // above): a plan that pushes elkjs past its practical limits must degrade
    // honestly (fallback + banner) instead of spinning a skeleton forever.
    // Deliberately does NOT cancel the `layoutPreviewGraph` call below — it
    // only stops the UI from waiting on it further. The call keeps running
    // in the background (worker or sync fallback), and its `.then` handler
    // below still runs when it eventually settles, un-latching this exact
    // state and swapping in the real layout (fix #2, STOP DEGRADING
    // PERMANENTLY) instead of leaving the honest-but-simplified fallback up
    // forever once a real result did arrive.
    const watchdog = setTimeout(() => {
      // Defense in depth (this effect's own header, THIRD root cause) — a
      // watchdog that fires must still refuse to act on a graph that
      // already has an applied, successful layout, even though the
      // primary fix below (clearing this timer the instant the promise
      // settles, in .then/.catch) should make reaching this branch at all
      // impossible for a graph that already resolved.
      if (currentGraphRef.current === graph && resolvedGraphRef.current !== graph) {
        console.warn(LAYOUT_FAILURE_LOG_PREFIX, `layout watchdog fired after ${LAYOUT_RESOLUTION_TIMEOUT_MS}ms — elkjs never settled`);
        _debugLogPreviewLayout('card watchdog fired', { signature: debugSignature, elapsedMs: Date.now() - debugStartedAt });
        setFailureReason({ kind: 'timeout' });
        setFailedGraph(graph);
      }
    }, LAYOUT_RESOLUTION_TIMEOUT_MS);
    void layoutPreviewGraph(nodes, edges)
      .then((next) => {
        // PRIMARY fix (THIRD root cause, this effect's own header) — the
        // watchdog above exists ONLY to guard a promise that has not yet
        // settled; the instant it settles (right here), that guard is no
        // longer needed and MUST be disarmed, not left ticking for the
        // full LAYOUT_RESOLUTION_TIMEOUT_MS regardless of outcome. Cleared
        // unconditionally, before even checking staleness — a stale
        // invocation's own watchdog is just as pointless to leave armed as
        // a fresh one's.
        clearTimeout(watchdog);
        // Applied whenever `graph` (closed over at THIS effect invocation)
        // is STILL the current one — see currentGraphRef's own comment for
        // why this replaces a per-invocation `cancelled` flag. A stale
        // result (an OLDER, superseded graph's own promise settling late)
        // is logged and dropped; it must never overwrite a newer,
        // already-correct `resolved`/`failedGraph` value.
        const stale = currentGraphRef.current !== graph;
        _debugLogPreviewLayout('card layout promise resolved', {
          signature: debugSignature,
          elapsedMs: Date.now() - debugStartedAt,
          applied: !stale,
          width: next.width,
          height: next.height,
        });
        if (stale) return;
        if (next.width > 0 && next.height > 0) {
          resolvedGraphRef.current = graph;
          setFailureReason(null);
          setResolved({ graph, layout: next });
          // fix #2 (STOP DEGRADING PERMANENTLY) — the watchdog above may
          // already have latched `failedGraph` for this exact graph object
          // (a timeout does NOT cancel the underlying layoutPreviewGraph
          // call, it only stops WAITING for it — see the watchdog's own
          // comment). If the real layout lands after that, it must
          // un-latch the failed state so the render below swaps the honest
          // fallback + banner for the real graph, instead of `isFailed`
          // staying true forever and permanently hiding a real result that
          // did, in fact, arrive. A no-op when nothing was ever latched
          // (the overwhelmingly common on-time path).
          setFailedGraph((prev) => (prev === graph ? null : prev));
        } else {
          // elkjs resolved but produced a degenerate (empty) layout — treat
          // exactly like a failure rather than rendering a 0x0 graph.
          console.warn(LAYOUT_FAILURE_LOG_PREFIX, `elkjs resolved a degenerate (0x0) layout for ${graph.nodes.length} node(s)`);
          setFailureReason({ kind: 'degenerate' });
          setFailedGraph(graph);
        }
      })
      .catch((err: unknown) => {
        // Same primary fix as the .then() branch above — a rejection is
        // also a settle, and must disarm the watchdog just as much as a
        // success does (an error banner set here must never be silently
        // overwritten by a LATER-firing "timed out" banner for the exact
        // same graph, which would be actively misleading about why it
        // actually failed).
        clearTimeout(watchdog);
        const message = err instanceof Error ? err.message : String(err);
        const stale = currentGraphRef.current !== graph;
        _debugLogPreviewLayout('card layout promise rejected', {
          signature: debugSignature,
          elapsedMs: Date.now() - debugStartedAt,
          applied: !stale,
          error: message,
        });
        if (stale) return;
        console.warn(LAYOUT_FAILURE_LOG_PREFIX, 'layoutPreviewGraph threw:', message);
        setFailureReason({ kind: 'error', message });
        setFailedGraph(graph);
      });
    // No `cancelled` flag to reset here (see currentGraphRef's own comment)
    // — clearing the watchdog on unmount/re-run is still worthwhile so a
    // superseded, still-PENDING effect's timer doesn't fire pointlessly
    // later, but (per the primary fix above) it is no longer the only
    // thing standing between a late-firing timer and a stale UI update.
    return () => {
      clearTimeout(watchdog);
    };
  }, [graph]);

  // TODO(scope): a "see full graph on canvas" escape hatch would ideally
  // route here to the real canvas's own production minimap/pan/zoom
  // (CanvasView.tsx) — deliberately not wired: a pending proposal has no
  // materialized canvas nodes yet (materialization only happens on
  // Validate), so there is nothing real to focus before that point, and
  // routing/pan/zoom for this card is explicitly out of scope for this
  // rewrite. Left as this comment rather than a half-built button.

  const isResolved = resolved?.graph === graph;
  const isFailed = failedGraph === graph;
  const isLoading = !isResolved && !isFailed;

  return (
    <div
      ref={previewContainerRef}
      style={{
        height: 244,
        border: '1px solid color-mix(in srgb, var(--color-warning, #f5b942) 32%, transparent)',
        borderRadius: 8,
        // fix #7 — the graph now ALWAYS fits (RealGraphSvg's width="100%" +
        // meet scaling, unconditional), so this scroll container should
        // never actually need to scroll on the FIT axis anymore; kept as
        // `auto` (not removed) purely as a last-resort safety net, never
        // the primary mechanism for seeing the rest of the plan.
        overflow: 'auto',
        background: 'linear-gradient(135deg, rgba(245,185,66,0.08), rgba(124,92,255,0.05))',
      }}
    >
      {isLoading && <GraphSkeleton graph={graph} fallbackLayout={fallbackLayout} containerWidth={containerWidth} />}
      {!isLoading && (
        <>
          {isFailed && (
            <div
              data-testid="graph-proposal-layout-degraded"
              // Layer 3 (diagnosability) — the user-facing text stays the
              // same honest, jargon-free banner; the WHY (elkjs message /
              // degenerate / timeout) rides along in `title` for a
              // developer to hover, never a raw stack.
              title={failureReason ? describeLayoutFailure(failureReason) : undefined}
              style={{
                fontSize: 10.5,
                color: 'var(--color-warning-text, #b45309)',
                background: 'rgba(245,185,66,0.14)',
                padding: '4px 8px',
                borderBottom: '1px solid color-mix(in srgb, var(--color-warning, #f5b942) 32%, transparent)',
              }}
            >
              {t('lazyManager.proposal.layoutFailed')}
            </div>
          )}
          <RealGraphSvg
            graph={graph}
            layout={isFailed ? fallbackLayout : resolved!.layout}
            selectedSteps={selectedSteps}
            containerWidth={containerWidth}
          />
        </>
      )}
    </div>
  );
}

/** Feature E — resolves which model id a step's chip should show as
 *  currently selected. Priority: the user's own not-yet-persisted pick
 *  (override, set immediately on click, before the store's async mirror
 *  lands) > the step's own explicit modelId (an exact catalog id —
 *  inherited FROM THE PLAN, e.g. stamped by generate_plan or a previous
 *  setStepModel call) > a best-effort id lookup by the step's human-
 *  readable `model` label (older/hand-written steps may carry only a
 *  label, never an id) > the picker's own defaultModelId (inherited FROM
 *  THE SETTING — the same "best default for these entitlements"
 *  buildModelPickerOptions already computes for the header's own picker).
 *  Never returns '' while at least one option exists, so the native
 *  <select> below always shows a real, meaningful choice instead of a
 *  blank control matching no <option> (the bug this replaces: the old
 *  `step.modelId ?? step.model ?? ''` fell straight through to an empty
 *  string, and a bare label like "Claude Sonnet" was never a valid option
 *  VALUE anyway, since every <option value> here is an id, not a label).
 *  Exported for direct unit testing — pure, no React/DOM involved. */
export function resolveStepModelId(
  step: { modelId?: string; model?: string },
  override: string | undefined,
  fallback: { allModels: { id: string; label: string }[]; defaultModelId: string },
): string {
  if (override) return override;
  if (step.modelId) return step.modelId;
  if (step.model) {
    const byLabel = fallback.allModels.find((m) => m.label === step.model);
    if (byLabel) return byLabel.id;
  }
  return fallback.defaultModelId;
}

/** Per-step model chip — the shared searchable picker (ModelPickerDropdown)
 *  replaces the native <select> this used to render (a ~200-row optgroup
 *  list is unusable once the Devin catalog is in the group set). Keeps the
 *  same chip look and the same data-testid per step; onPick receives the
 *  chosen model id exactly like the old select's onChange. */
function StepModelChip({
  testId,
  ariaLabel,
  currentId,
  unknownCurrent,
  groups,
  lockedGroup,
  title,
  t,
  onPick,
}: {
  testId: string;
  ariaLabel: string;
  currentId: string;
  unknownCurrent?: { id: string; label: string };
  groups: ModelOptionGroup[];
  lockedGroup?: ModelOptionGroup;
  title: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useDismissable<HTMLDivElement>({
    open,
    onClose: () => setOpen(false),
    ignoreRefs: [triggerRef],
  });
  const currentLabel =
    [...groups, ...(lockedGroup ? [lockedGroup] : [])]
      .flatMap((g) => g.models)
      .find((m) => m.id === currentId)?.label ?? currentId;
  return (
    <span style={{ position: 'relative', alignSelf: 'flex-start', flexShrink: 0 }}>
      <button
        type="button"
        ref={triggerRef}
        data-testid={testId}
        aria-label={ariaLabel}
        title={title}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={{
          width: 150,
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          fontWeight: 600,
          background: 'rgba(124,92,255,0.22)',
          color: '#EDE7FF',
          border: '1px solid rgba(124,92,255,0.6)',
          borderRadius: 5,
          padding: '3px 6px',
          outline: 'none',
          cursor: 'pointer',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'left',
        }}
      >
        {currentLabel} ▾
      </button>
      {open && (
        <div ref={popRef}>
          <ModelPickerDropdown
            groups={groups}
            lockedGroup={lockedGroup}
            currentId={currentId}
            unknownCurrent={unknownCurrent}
            direction="down"
            onSelect={onPick}
            onClose={() => setOpen(false)}
            t={t}
            optionTestId="graph-proposal-step-model-option"
            lockedOptionTestId="graph-proposal-step-model-option-locked"
          />
        </div>
      )}
    </span>
  );
}

export function GraphProposalCard({ msg, onAccept, onModify, onReject, onStepModelChange, isActionQueued = false }: GraphProposalCardProps) {
  const { t } = useI18n();
  // OUT-OF-SCOPE-AT-PROPOSAL-TIME FIX — the SAFE optional variant (see
  // useAppContextOptional's own doc comment, AppContext.tsx): this card's
  // own test suite renders it standalone, with no AppProvider ancestor —
  // `null` here just means "no open-projects registry known yet", which
  // degrades the check below to "still flags an out-of-scope mention, just
  // never names the specific owning project" rather than crashing.
  const appContext = useAppContextOptional();
  const openProjects = appContext?.openProjects ?? [];
  const proposal = msg.proposal;
  const [selectedSteps, setSelectedSteps] = useState<Set<number>>(
    () => new Set(msg.proposal?.state === 'pending' ? msg.proposal.steps.map((_, index) => index) : []),
  );
  // Feature E — per-step model chips: local overrides so the card reflects
  // the user's pick IMMEDIATELY, before the store's async mirror lands.
  const [stepModelOverrides, setStepModelOverrides] = useState<Record<string, string>>({});
  // 2026-08 rail-grouping follow-up (founder, verbatim: "une chip avec le
  // modèle... pour choisir le LLM de chaque agent avant de lancer le
  // graphe" — the chip must list options BY RAIL with locked/Pro info, not
  // a flat list). Same picker DATA LazyManagerHeader's own
  // "manager-model-select" renders from (buildModelPickerOptions/
  // detectModelEntitlements) — computed INDEPENDENTLY of whichever engine
  // the manager itself currently happens to be on (see that module's own
  // header comment), so a manager running on DeepSeek/BYOK still sees the
  // Claude-sub and Pro groups here exactly like the header does: a step
  // CAN be launched on a different rail than the manager's own, which is
  // the whole point of this feature. Kept as the full grouped shape
  // (never flattened) so the select below can render one optgroup per
  // rail, mirroring LazyManagerHeader.tsx's own optgroup + disabled-
  // locked-group treatment line for line rather than inventing a second
  // picker layout.
  // 2026-08-06 (founder, second pass: "je devrais juste voir les options
  // quand elles sont selectionnable, exemple claude cli seulement si je
  // suis connecte") — the plan-step chip lists ONLY the rails that are
  // actually available right now: Claude CLI natives when a Claude
  // subscription is detected, the BYOK provider when its key is set, the
  // LazyPro catalog when the Pro plan is active. A rail that cannot run is
  // not shown at all (and never shown as a disabled/locked group) — the
  // chip never offers a model the runtime would have to refuse.
  const pickerOptions = useMemo(() => {
    const active = buildModelPickerOptions(detectModelEntitlements(), t);
    return { ...active, lockedProGroup: undefined as ModelOptionGroup | undefined };
  }, [t]);
  const allModelOptions = useMemo(() => pickerOptions.groups.flatMap((g) => g.models), [pickerOptions]);
  const modelLabelFor = (modelId: string | undefined, label: string | undefined): string => {
    if (!modelId) return label ?? '';
    const found = allModelOptions.find((m) => m.id === modelId)
      ?? pickerOptions.lockedProGroup?.models.find((m) => m.id === modelId);
    return found?.label ?? label ?? modelId;
  };

  const proposalState = proposal?.state;
  const isPending = proposalState === 'pending';

  // Expand overlay when proposal becomes visible, shrink when resolved.
  //
  // 2026-08 fifth verification pass (founder: auto-expand still did not
  // fire for a real proposal tonight, despite ManagerOverlay.tsx's own
  // widthStateRef fix — verified by test — being in) — this effect used to
  // fire unconditionally on every mount, including a card mounting FRESH
  // for an ALREADY-RESOLVED proposal. That happens for real: multi-
  // conversation (shipped the same night) means `agents.managerMessages`
  // (LazyManagerMessageList's source) is scoped to whichever conversation
  // is currently ACTIVE — switching conversations swaps the WHOLE message
  // array, so React unmounts every card for the old conversation and mounts
  // fresh ones for the new one, including any OLDER, already-accepted/
  // rejected proposal sitting earlier in that conversation's own history. A
  // proposal is always CREATED 'pending' and only ever transitions to a
  // resolved state LATER on an ALREADY-MOUNTED instance — so a resolved
  // state present on this component's OWN very first render can only mean
  // "old news being redisplayed", never a live transition happening right
  // now. If that stale mount-time shrink lands in the same batch as (or
  // shortly after) a genuinely NEW pending proposal's mount-time expand —
  // e.g. two conversations' histories both containing a proposal card,
  // rendered in the same pass — the shrink could win last and leave the
  // panel docked next to a plan the user cannot read, exactly the reported
  // symptom. `hasEmittedOnceRef` distinguishes "this instance's own first
  // render" from a real subsequent transition; only a first-render shrink
  // is skipped — a first-render EXPAND (a still-pending proposal revealed
  // by switching back to its conversation) is left alone, since surfacing
  // an outstanding decision again is the correct, wanted behavior.
  //
  // `_debugLogOverlayWidth` traces every WOULD-emit decision (including a
  // skipped one) with the message/planId/state that drove it, dev-only, so
  // a live repro can be correlated against ManagerOverlay.tsx's own
  // receipt-side trace — see bus.ts's own `window.__lazyBusDebugLog` for
  // the CDP read command.
  const hasEmittedOnceRef = useRef(false);
  useEffect(() => {
    if (!proposalState) return;
    const isFirstRenderOfThisInstance = !hasEmittedOnceRef.current;
    hasEmittedOnceRef.current = true;
    const skippedAsStale = isFirstRenderOfThisInstance && proposalState !== 'pending';
    _debugLogOverlayWidth('GraphProposalCard emit', {
      msgId: msg.id,
      planId: proposal?.planId,
      proposalState,
      isFirstRenderOfThisInstance,
      skippedAsStale,
      event: proposalState === 'pending' ? 'manager:expandOverlay' : 'manager:shrinkOverlay',
    });
    if (skippedAsStale) return;
    emit(proposalState === 'pending' ? 'manager:expandOverlay' : 'manager:shrinkOverlay', undefined);
  }, [proposalState, msg.id, proposal?.planId]);

  // fix #4 — computed unconditionally (never inside the `if (!proposal)`
  // early return below) so hook order stays stable across renders; reads
  // `[]` when there is no proposal or it is not pending (unchecking a step
  // is only possible while pending, so there is nothing to warn about
  // otherwise).
  const dependencyWarnings = useMemo(
    () => (isPending && proposal ? computeDependencyWarnings(proposal.steps, selectedSteps) : []),
    [isPending, proposal, selectedSteps],
  );

  // OUT-OF-SCOPE-AT-PROPOSAL-TIME FIX (2026-08-19) — moves a launch-time-only
  // failure (missionScopeGuard.ts's findOutOfScopeTaskPath, run one mission
  // at a time by addMission — see that file's own header) earlier, to
  // proposal time: a step whose task text names an absolute path outside
  // `proposal.targetProjectRoot` and declares no covering
  // `extraReadableProjectIds` is now flagged HERE, before "Valider &
  // lancer" is even clicked, reusing the EXACT SAME guard rather than a
  // second heuristic (see computeOutOfScopeStepWarnings's own doc comment,
  // graphProposalGraph.ts). `[]` while `targetProjectRoot` is not yet known
  // (a brief window right after the proposal first appears, or a proposal
  // predating this fix) — see that field's own doc comment, types.ts.
  const outOfScopeWarnings = useMemo(
    () => (isPending && proposal ? computeOutOfScopeStepWarnings(proposal.steps, proposal.targetProjectRoot, openProjects) : []),
    [isPending, proposal, openProjects],
  );
  const outOfScopeWarningByStepIndex = useMemo(
    () => new Map(outOfScopeWarnings.map((w) => [w.stepIndex, w])),
    [outOfScopeWarnings],
  );

  if (!proposal) return null;

  // Map selected step indices → step ids for partial execution
  const getSelectedStepIds = (): string[] => {
    const ids: string[] = [];
    selectedSteps.forEach((i) => {
      const step = proposal.steps[i];
      if (step?.id) ids.push(step.id);
    });
    return ids;
  };

  // B2 fix — 'launching' is a real, distinct in-flight state (agentsStore.tsx's
  // executePlan): the card must never read 'accepted' before materialization
  // AND execution have actually confirmed a real effect happened.
  const stateLabel = isPending
    ? t('lazyManager.proposal.pending')
    : proposal.state === 'launching'
      ? t('lazyManager.proposal.launching')
      : proposal.state === 'accepted'
        ? t('lazyManager.proposal.accepted')
        : t('lazyManager.proposal.rejected');

  const stateColor = isPending || proposal.state === 'launching'
    ? 'var(--color-warning)'
    : proposal.state === 'accepted'
      ? 'var(--color-success)'
      : 'var(--color-danger, #dc2626)';

  // NO-PLANID PROPOSAL FIX (A2) — see the Validate button's own doc comment
  // just below for the full defect. `proposal.planId` is the ONLY thing
  // that makes a pending proposal launchable at all (onAccept/onModify are
  // both already guarded on it) — deriving `canValidate` from exactly that
  // same field, once, here, means the button's disabled state and its own
  // click guard can never disagree.
  //
  // Deliberately NOT also gated on `outOfScopeWarnings.length === 0` (see
  // that warning's own render-site comment for the full reasoning) —
  // `canValidate` stays reserved for a STRUCTURAL impossibility (no plan to
  // launch at all), never a per-step semantic risk that partial approval
  // already lets the user route around.
  const canValidate = !!proposal.planId;

  const toggleStep = (i: number) => {
    setSelectedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div
      data-testid="graph-proposal-card"
      style={{
        marginTop: 10,
        borderRadius: 10,
        border: '1px solid var(--color-border-2)',
        background: 'rgba(124,92,255,0.06)',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
          {t('lazyManager.proposal.title')}
        </span>
        <span
          data-testid="graph-proposal-state"
          style={{ fontSize: 10, fontWeight: 600, color: stateColor, textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          {stateLabel}
        </span>
      </div>

      {/* B3 fix — a real, persistent error banner (agentsStore.tsx's
          executePlan sets `errorMessage` alongside reverting to 'pending'
          on any launch failure) — never just a toast the user can miss.
          Rendered whenever set, regardless of state, and cleared the
          instant a fresh "Valider & lancer" attempt starts. */}
      {proposal.errorMessage && (
        <div
          data-testid="graph-proposal-error"
          style={{
            fontSize: 11.5, color: 'var(--color-danger, #dc2626)',
            background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.3)',
            borderRadius: 6, padding: '6px 8px', lineHeight: 1.4,
          }}
        >
          {proposal.errorMessage}
        </div>
      )}

      {/* Objective */}
      <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
        {proposal.objective}
      </div>

      {/* fix #5 — an honest, explicit empty state instead of this whole
          section just vanishing when the manager returned zero steps (a
          disappearing card is indistinguishable from a broken feature). */}
      {proposal.steps.length === 0 ? (
        <div
          data-testid="graph-proposal-empty"
          style={{
            fontSize: 12,
            color: 'var(--color-text-muted)',
            border: '1px dashed var(--color-border-2)',
            borderRadius: 8,
            padding: '14px 12px',
            textAlign: 'center',
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
            {t('lazyManager.proposal.emptyTitle')}
          </div>
          <div>{t('lazyManager.proposal.emptyDetail')}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ProposalGraphPreview proposal={proposal} selectedSteps={selectedSteps} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 6 }}>
            <span style={{ gridColumn: '1 / -1', fontSize: 10.5, fontWeight: 600, color: 'var(--color-text-disabled)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {t('lazyManager.proposal.steps')} ({proposal.steps.length})
            </span>
            {proposal.steps.map((step, i) => {
              // Resolved once per step/render so the <select>'s value and
              // the "is this id actually in a rendered <option>" check
              // below always agree on the exact same id (see
              // resolveStepModelId's own doc comment for the fallback
              // chain: local override > step.modelId > label lookup >
              // picker default).
              const resolvedModelId = step.id
                ? resolveStepModelId(step, stepModelOverrides[step.id], {
                    allModels: allModelOptions,
                    defaultModelId: pickerOptions.defaultModelId,
                  })
                : undefined;
              const isKnownModelId = resolvedModelId !== undefined && (
                allModelOptions.some((m) => m.id === resolvedModelId)
                || (pickerOptions.lockedProGroup?.models.some((m) => m.id === resolvedModelId) ?? false)
              );
              return (
                <label
                  key={step.id ?? i}
                  style={{
                    display: 'flex', flexDirection: 'column', gap: 6,
                    padding: '6px 8px', borderRadius: 6,
                    border: `1px solid ${selectedSteps.has(i) ? 'color-mix(in srgb, var(--color-warning, #f5b942) 45%, transparent)' : 'var(--color-border-2)'}`,
                    background: selectedSteps.has(i) ? 'rgba(245,185,66,0.06)' : 'transparent',
                    fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.45,
                    cursor: isPending ? 'pointer' : 'default',
                    opacity: isPending && !selectedSteps.has(i) ? 0.5 : 1,
                  }}
                >
                  {/* 2026-08-06 (founder: "met la [chip] en bas du rectangle
                      etape ... tu peux pas juste les mettre cote a cote texte
                      et chips") — the step row is now a column: text line on
                      top, model chip on its OWN line below. Side-by-side with
                      real step titles, the chip squeezed the text and read
                      badly. */}
                  <span style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    {isPending && (
                      <input
                        type="checkbox"
                        checked={selectedSteps.has(i)}
                        onChange={() => toggleStep(i)}
                        style={{ marginTop: 2, flexShrink: 0 }}
                      />
                    )}
                    <span>
                      <span style={{ color: 'var(--color-warning, #f5b942)', fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 700 }}>
                        {i + 1}.
                      </span>{' '}
                      {step.description}
                      {step.agentName && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-text-disabled)' }}>
                          @{step.agentName}
                        </span>
                      )}
                    </span>
                  </span>
                  {/* Feature E — per-step model chip: pick the launch model of
                      this step BEFORE validating, so each agent runs on the
                      model the user chose for it (a graph can freely mix
                      rails — this picker never filters by the manager's own
                      engine, see pickerOptions' own comment above). Only
                      while pending, and only when a handler is wired (tests/
                      snapshots without one render the step read-only, exactly
                      as before). Grouped by rail (one <optgroup> per
                      buildModelPickerOptions group — Claude subscription /
                      BYOK / Lazy Pro) plus a disabled locked-Pro group when
                      Pro isn't active, mirroring LazyManagerHeader.tsx's own
                      "manager-model-select" treatment line for line rather
                      than a second, drifting picker layout. */}
                  {isPending && onStepModelChange && step.id && resolvedModelId !== undefined && (
                    <StepModelChip
                      testId={`graph-proposal-step-model-${step.id}`}
                      ariaLabel={t('lazyManager.proposal.stepModel')}
                      currentId={resolvedModelId}
                      unknownCurrent={
                        !isKnownModelId
                          ? { id: resolvedModelId, label: modelLabelFor(resolvedModelId, step.model) || resolvedModelId }
                          : undefined
                      }
                      groups={pickerOptions.groups}
                      lockedGroup={pickerOptions.lockedProGroup}
                      title={modelLabelFor(resolvedModelId, step.model) || t('lazyManager.proposal.stepModel')}
                      t={t}
                      onPick={(value) => {
                        setStepModelOverrides((prev) => ({ ...prev, [step.id as string]: value }));
                        if (proposal.planId) onStepModelChange(proposal.planId, step.id as string, value);
                      }}
                    />
                  )}
                  {/* Fix E (2026-08-19 incident) — warn BEFORE launch, not
                      after: a plan step whose own estimate already exceeds
                      the cap that will be applied to it (the manager
                      prompt's own JSON example shows "budgetCapUsd": 5.0,
                      which the model routinely copies verbatim regardless
                      of the step's actual tier/effort — the real incident
                      this fixes had all 6 steps carrying that literal $5,
                      five of which then ran 100%-274% over it). Both values
                      are precomputed once at proposal-construction time
                      (agentsStore.tsx, from the SAME estimatePlanStepCostUsd
                      the aggregate estimate above already uses) — never
                      recomputed here. */}
                  {step.budgetCapUsd !== undefined &&
                    step.estimatedCostUsd !== undefined &&
                    step.estimatedCostUsd > step.budgetCapUsd && (
                      <span
                        data-testid={`graph-proposal-step-budget-warning-${step.id ?? i}`}
                        style={{
                          alignSelf: 'flex-start',
                          fontSize: 10,
                          color: 'var(--color-danger-text, #dc2626)',
                          background: 'rgba(220,38,38,0.1)',
                          border: '1px solid rgba(220,38,38,0.3)',
                          borderRadius: 5,
                          padding: '3px 6px',
                          lineHeight: 1.35,
                        }}
                      >
                        {t('lazyManager.proposal.stepBudgetWarning', {
                          estimated: step.estimatedCostUsd.toFixed(2),
                          cap: step.budgetCapUsd.toFixed(2),
                        })}
                      </span>
                    )}
                  {/* OUT-OF-SCOPE-AT-PROPOSAL-TIME FIX (2026-08-19) — same
                      placement/styling as the budget-cap warning right
                      above (one coherent warning language on this card, not
                      two): a step whose task text names a path outside this
                      plan's own project, undeclared via
                      extraReadableProjectIds, is a GUARANTEED launch
                      failure for that step (missionScopeGuard.ts's
                      findOutOfScopeTaskPath — reused here verbatim, see
                      computeOutOfScopeStepWarnings, graphProposalGraph.ts).
                      Warns only — does NOT disable "Valider & lancer" (see
                      that button's own doc comment for the full reasoning):
                      the failure this predicts is loud and recoverable
                      (missionScopeGuard.ts's own header — the affected
                      mission is created, journaled, and marked 'failed'
                      with a clear reason, never silently misrouted), exactly
                      like the pre-existing dependencyWarning above it, which
                      warns about an equally "guaranteed to misbehave at
                      launch" condition without disabling anything either —
                      the user can uncheck just the affected step (partial
                      approval) or validate anyway with the visible risk. */}
                  {outOfScopeWarningByStepIndex.has(i) && (() => {
                    const warning = outOfScopeWarningByStepIndex.get(i)!;
                    return (
                      <span
                        data-testid={`graph-proposal-step-scope-warning-${step.id ?? i}`}
                        style={{
                          alignSelf: 'flex-start',
                          fontSize: 10,
                          color: 'var(--color-danger-text, #dc2626)',
                          background: 'rgba(220,38,38,0.1)',
                          border: '1px solid rgba(220,38,38,0.3)',
                          borderRadius: 5,
                          padding: '3px 6px',
                          lineHeight: 1.35,
                        }}
                      >
                        {warning.ownerProjectName
                          ? t('lazyManager.proposal.stepScopeWarningKnownProject', {
                              path: warning.mentionedPath,
                              project: warning.ownerProjectName,
                            })
                          : t('lazyManager.proposal.stepScopeWarningUnknownProject', {
                              path: warning.mentionedPath,
                              root: warning.targetProjectRoot,
                            })}
                      </span>
                    );
                  })()}
                </label>
              );
            })}
          </div>

          {/* fix #4 — NEVER DEGRADE IN SILENCE: a still-checked step that
              depends on a step the user just unchecked, called out before
              Validate is even clickable-with-consequence. */}
          {dependencyWarnings.length > 0 && (
            <div
              data-testid="graph-proposal-dependency-warning"
              style={{
                fontSize: 11,
                color: 'var(--color-warning-text, #b45309)',
                background: 'rgba(245,185,66,0.1)',
                border: '1px solid rgba(245,185,66,0.35)',
                borderRadius: 6,
                padding: '6px 8px',
                lineHeight: 1.4,
              }}
            >
              <strong style={{ display: 'block', marginBottom: 2 }}>{t('lazyManager.proposal.dependencyWarningTitle')}</strong>
              {dependencyWarnings.map((warning) => (
                <div key={warning.stepIndex}>
                  {warning.missingDependencyIndexes
                    .map((depIndex) => t('lazyManager.proposal.dependencyWarning', { step: warning.stepIndex + 1, dependency: depIndex + 1 }))
                    .join(' ')}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Cited lessons badge */}
      {proposal.citedLessonIds && proposal.citedLessonIds.length > 0 && (
        <div style={{
          fontSize: 10, color: 'var(--color-text-disabled)', display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span style={{ opacity: 0.7 }}>📚</span>
          <span>{proposal.citedLessonIds.length} lesson{proposal.citedLessonIds.length > 1 ? 's' : ''} cited</span>
        </div>
      )}

      {/* Estimates — item 7 fix (real user QA, 2026-08-01): this used to
          always show `~$${estimatedCostUsd}` regardless of engine, even
          while the header badge read "Claude · abonnement" (a CLI
          subscription turn that never spends a single Lazy-managed
          credit). The owner's standing rule: an estimate is credits per
          model, never a raw dollar figure, and a subscription-routed plan
          must say explicitly that it costs no credits. `engineMode` reuses
          the SAME classification LazyManagerHeader.tsx's own engine badge
          is built from (getProviderMode/CREDIT_METERED_ENGINES, exported
          from that file rather than re-derived here) — never a second,
          possibly-drifting notion of "which engine am I on". Credits come
          straight from `proposal.estimatedCreditsByModel`
          (agentsStore.tsx), itself derived from the SAME
          estimatePlanStepCostUsd this card's `estimatedCostUsd` fallback
          below is also built from — one estimator, two presentations,
          never two conversions. */}
      {(proposal.estimatedCostUsd !== undefined || proposal.estimatedDurationMs !== undefined) && (() => {
        const engineMode = getProviderMode() as EngineKey;
        const usesCredits = CREDIT_METERED_ENGINES.has(engineMode);
        const engineLabelKey = ENGINE_I18N_KEY[engineMode] ?? ENGINE_I18N_KEY.mock;
        const creditsByModel = proposal.estimatedCreditsByModel;
        const totalCredits = creditsByModel
          ? Object.values(creditsByModel).reduce((sum, c) => sum + c, 0)
          : proposal.estimatedCostUsd !== undefined
            ? Math.round(proposal.estimatedCostUsd * 100)
            : undefined;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10.5, color: 'var(--color-text-disabled)' }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {!usesCredits ? (
                <span data-testid="graph-proposal-no-credits">
                  {t('lazyManager.proposal.noCreditsSubscription', { engine: t(engineLabelKey) })}
                </span>
              ) : totalCredits !== undefined && (
                <span data-testid="graph-proposal-estimated-credits">
                  {t('lazyManager.proposal.estimatedCost')}: {t('lazyManager.proposal.estimatedCreditsValue', { credits: totalCredits })}
                </span>
              )}
              {proposal.estimatedDurationMs !== undefined && (
                <span>{t('lazyManager.proposal.estimatedDuration')}: ~{Math.round(proposal.estimatedDurationMs / 60000)}min</span>
              )}
            </div>
            {usesCredits && creditsByModel && Object.keys(creditsByModel).length > 1 && (
              <div data-testid="graph-proposal-estimated-credits-by-model" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {Object.entries(creditsByModel).map(([model, credits]) => (
                  <span key={model}>{t('lazyManager.proposal.estimatedCreditsByModel', { model, credits })}</span>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* CONSENT-BYPASS FIX, surfacing half: `proposal.deferredActions`
          (agentsStore.tsx's sendManagerMessage) are the OTHER mutative
          actions the manager emitted in this SAME turn as generate_plan —
          they never ran, and clicking "Valider & lancer" below replays them
          (gated for real, see executePlan's own doc comment) right along
          with the plan itself. Previously this card never mentioned them at
          all — the user had no way to see, before validating, that doing so
          would also run N other actions (one of which may itself still ask
          for a separate approval). Labeled with the EXACT SAME
          describePendingAction() strings the pending-approval card and the
          message's own action chips already use, so this list, the chip
          row above the card, and any approval prompt that follows can never
          disagree about what these actions are. */}
      {proposal.deferredActions && proposal.deferredActions.length > 0 && (
        <div
          data-testid="graph-proposal-deferred-actions"
          style={{
            display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11,
            color: 'var(--color-text-muted)', border: '1px dashed var(--color-border-2)',
            borderRadius: 8, padding: '7px 10px',
          }}
        >
          <span style={{ fontWeight: 700 }}>
            {t('lazyManager.proposal.deferredActions', { count: proposal.deferredActions.length })}
          </span>
          <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {proposal.deferredActions.map((action, i) => (
              <li key={i} data-testid={`graph-proposal-deferred-action-${i}`}>
                {describePendingAction(action, t)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      {isPending && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* NO-PLANID PROPOSAL FIX (A2, paired with agentsStore.tsx's own
              "NO-PLANID PROPOSAL FIX" comments) — a proposal can reach this
              component `pending` with NO `proposal.planId` at all (generate_plan
              denied/asked-for-approval/failed-without-throwing/thrown — see
              that fix's own doc comment for the full four-path trace). The
              click handler below was ALREADY correctly guarded
              (`if (proposal.planId)`), so the button never actually launched
              anything in that state — but it still rendered fully enabled
              (`disabled: false`, clickable, no toast/error/journal entry),
              which is indistinguishable from "broken" to whoever clicks it.
              `canValidate` makes that inertness a REAL, visible disabled
              state instead of a silent no-op, and the message right below
              (`graph-proposal-no-planid`) says why — reusing whatever
              specific reason agentsStore.tsx already attached to
              `proposal.errorMessage` (rendered above via the SAME banner
              the "N action(s)... still need your approval" message already
              uses) when one was recorded, and a generic fallback for the
              one narrow case that store-side fix deliberately leaves
              unexplained (a superseded generation — never mutates a stale
              message's state, same convention as every other generation
              guard in that function) — the button's own disabled state is
              never conditional on that reason existing, only on `planId`
              itself, so it can never lie regardless. */}
          <button
            type="button"
            data-testid="graph-proposal-validate"
            disabled={isActionQueued || !canValidate}
            onClick={() => {
              if (proposal.planId) {
                const stepIds = getSelectedStepIds();
                onAccept(proposal.planId, stepIds.length > 0 && stepIds.length < proposal.steps.length ? { stepIds } : undefined);
              }
            }}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8,
              border: '1px solid var(--color-accent-border, rgba(124,92,255,0.4))',
              background: 'rgba(124,92,255,0.18)', color: 'var(--color-accent-pale)',
              cursor: isActionQueued || !canValidate ? 'default' : 'pointer', fontFamily: 'inherit',
              opacity: isActionQueued || !canValidate ? 0.5 : 1,
            }}
          >
            {t('lazyManager.proposal.validate')}
          </button>
          <button
            type="button"
            data-testid="graph-proposal-modify"
            disabled={isActionQueued}
            onClick={() => {
              if (proposal.planId && onModify) {
                onModify(proposal.planId);
              } else {
                emit('manager:shrinkOverlay', undefined);
              }
            }}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8,
              border: '1px solid var(--color-border-2)',
              background: 'transparent', color: 'var(--color-text-muted)',
              cursor: isActionQueued ? 'default' : 'pointer', fontFamily: 'inherit',
              opacity: isActionQueued ? 0.5 : 1,
            }}
          >
            {t('lazyManager.proposal.modify')}
          </button>
          <button
            type="button"
            data-testid="graph-proposal-reject"
            disabled={isActionQueued}
            onClick={onReject}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 700, borderRadius: 8,
              border: '1px solid var(--color-border-2)',
              background: 'transparent', color: 'var(--color-text-muted)',
              cursor: isActionQueued ? 'default' : 'pointer', fontFamily: 'inherit',
              opacity: isActionQueued ? 0.5 : 1,
            }}
          >
            {t('lazyManager.proposal.reject')}
          </button>
          {isActionQueued && (
            <span data-testid="graph-proposal-queued" style={{ fontSize: 10.5, color: 'var(--color-warning)' }}>
              {t('lazyManager.actionQueued')}
            </span>
          )}
          {/* NO-PLANID PROPOSAL FIX (A2) — the specific root-cause reason
              (denied / needs approval / failed / thrown) is already shown
              above via the pre-existing `graph-proposal-error` banner
              whenever agentsStore.tsx managed to record one (proposal.errorMessage
              — same mechanism the "N action(s)... still need your approval"
              message already uses); this second, button-adjacent line is
              deliberately independent of whether that reason was recorded
              (falls back to a generic translated string) so the DISABLED
              button is never left unexplained even in the one edge case
              that store-side fix cannot cover (a superseded turn). */}
          {!canValidate && (
            <span data-testid="graph-proposal-no-planid" style={{ fontSize: 10.5, color: 'var(--color-danger, #dc2626)' }}>
              {proposal.errorMessage || t('lazyManager.proposal.cannotValidateNoPlanId')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
