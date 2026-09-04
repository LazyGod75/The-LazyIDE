/* types.ts — shared render-time types for the Brain Canvas engine.

   RenderNode/RenderEdge/Scene are hot-path caches rebuilt once per data
   change and then mutated in place every animation frame (sx/sy/fade/fire
   etc.) — this is the one deliberate, documented exception to the app's
   general immutable-data convention (see the task's own engineering bar:
   "immutable patterns outside the render hot path"). Nothing outside this
   module and the render loop should ever hold onto or mutate these objects.
*/

import type { AdaptedNode } from '../../../lib/brain/brainAdapter';
import type { Mote } from './ambientField';
import type { PulseState } from './pulses';

export interface RenderNode {
  id: string;
  title: string;
  cluster: string;
  importance: number;
  dateIdx: number;
  /** Resolved from the active palette; updated in place on palette change (no scene rebuild). */
  color: string;
  x: number;
  y: number;
  z: number;

  /** True for the top-N nodes by importance — the only ones that get full bloom rendering (see MAX_HERO_NODES in draw.ts). Long-tail nodes beyond the cap still render (cheap dot) and stay clickable. */
  isHero: boolean;
  /** Stable per-node phase offset (derived from a hash of `id`) driving the idle "breathing" scale animation. */
  breathePhase: number;

  /** The original adapted node — passed back verbatim to onSelectNode so callers see the exact same shape as before. */
  source: AdaptedNode;

  // ── per-frame mutable projection state (written by projectInto) ──
  sx: number;
  sy: number;
  z2: number;
  persp: number;
  fade: number;
  /** On-screen disc radius this frame (importance-scaled, perspective-adjusted). */
  r: number;
  /** True when within the active type/cluster filters (already applied upstream) AND dateIdx <= timeIdx. */
  visible: boolean;
  /**
   * 0..1 time-travel reveal progress, eased toward `visible ? 1 : 0` every
   * frame (see BrainGraph3D's render loop) — drives the fade-in/grow
   * transition when scrubbing so a note's appearance/disappearance reads as
   * a smooth change instead of an instant pop. Snaps straight to the
   * target (no easing) when prefers-reduced-motion is set. Defaults to 1
   * (matches the `visible: true` default below — the common case is
   * mounting at the newest position, "Tout", where everything is already
   * revealed).
   */
  reveal: number;
  /** 0..1 decaying "just fired" intensity, set to 1 on pulse arrival, decays ~*0.92/frame. */
  fire: number;
}

export interface RenderEdge {
  a: RenderNode;
  b: RenderNode;
}

/** Running accumulator for one cluster's on-screen label placement, reset and refilled every frame (no per-frame allocation). */
export interface ClusterAggregate {
  clusterId: string;
  color: string;
  sumX: number;
  count: number;
  topY: number;
}

export interface Scene {
  nodes: RenderNode[];
  /** Same elements as `nodes`, re-sorted by depth (z2) in place every frame for far->near draw order. */
  order: RenderNode[];
  edges: RenderEdge[];
  nodeById: Map<string, RenderNode>;
  pulses: PulseState[];
  motes: Mote[];
  clusterAggregates: Map<string, ClusterAggregate>;
}

/* Note: the ambient cortex field is deliberately NOT part of Scene. It is
   built once per component mount (after first paint, see BrainGraph3D's
   requestIdleCallback usage) and must survive scene rebuilds triggered by
   data/filter changes, so BrainGraph3D owns it in its own ref instead. */
