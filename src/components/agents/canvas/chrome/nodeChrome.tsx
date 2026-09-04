/* nodeChrome.tsx — shared card shell for every canvas node kind (W1b,
   spec §4.2/§4.4). Imports canvas.css exactly once (side-effect import)
   so every node file that needs the keyframes just imports from here
   instead of each declaring its own `import './canvas.css'`.

   Building blocks exported here are deliberately small and composable
   (glyph, halo style, chips, a card container) rather than one giant
   "MissionCard" component — MissionNode/LoopNode/ScheduleNode/DraftNode
   have different enough layouts that a single monolithic shell would just
   grow a pile of kind-specific branches. Visual language matches the
   existing cockpit cards (UrgentMissionCard.tsx/CompactMissionCard.tsx):
   `--color-panel-2` background, small mono badges, the same halo/pulse
   idiom — see those files' styles for the values mirrored below.
*/

import './canvas.css';
import type { CSSProperties, ReactNode } from 'react';
import { useI18n } from '../../../../i18n';
import type { FleetMission } from '../../../../lib/agents/fleetMissions';
import type { JudgeVerdict, PlanStep } from '../../../../lib/agents/types';
import { conversationAccentColor } from '../../../../lib/agents/conversationColor';
import { basename } from '../../../../lib/paths';
import { FULL_CARD_MAX_HEIGHT, FULL_CARD_WIDTH } from '../geometry';

// ── Shared card-size constants (W6b geometry fix wave, spec CRITICAL 2) ──
//
// Re-exported from geometry.ts (the canonical source — see that module's
// header) so every "full" zoom card (MissionNode/LoopNode/ScheduleNode/
// DraftNode) imports its fixed width/max-height from ONE place instead of
// each hand-picking its own `width: NNN` like before this fix (that's
// exactly how the reconciler's placement grid ended up too small for the
// real rendered card — see reconciler.ts's DEFAULT_NODE_SIZE comment).
export { FULL_CARD_MAX_HEIGHT, FULL_CARD_WIDTH };

/** "Fleet view" dot size (spec MEDIUM 5, zoom < ZOOM_DOT) — large enough
 *  that the type glyph inside stays legible at a glance across a whole
 *  fleet of dots, small enough to still read as "very zoomed out". */
export const DOT_SIZE = 20;
export const DOT_GLYPH_SIZE = 11;

// ── Liveness (spec §4.4) ────────────────────────────────────────────

/**
 * Canonical liveness bucket for a mission/loop node's status ring — a
 * coarser view than {@link FleetMission.status} that also folds in the
 * `paused` flag (a sub-state of 'running', see Mission.paused's doc
 * comment) and the terminal 'merged' look (status 'done', spec §4.4
 * "done/merged: green check").
 */
export type NodeLiveness = 'queued' | 'running' | 'paused' | 'review' | 'failed' | 'merged';

/**
 * Derives a {@link NodeLiveness} from a real {@link FleetMission} — never
 * fabricated, always a pure projection of real status fields. `cancelled`
 * has no dedicated visual in the spec; it is treated like `failed` (a
 * terminal non-success the human may want to inspect/retry) rather than
 * silently folded into a "calm" bucket.
 */
export function deriveMissionLiveness(mission: Pick<FleetMission, 'status' | 'paused'>): NodeLiveness {
  if (mission.paused) return 'paused';
  switch (mission.status) {
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
    case 'review':
      return 'review';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'done':
      return 'merged';
    default:
      return 'queued';
  }
}

/** Ring/accent color per liveness bucket — P2 node visual language
 *  (cockpit-redesign mockup v3): the `--canvas-state-*` tokens (chrome/
 *  canvas.css's `:root` block) are this task's exact validated palette
 *  (running=cyan, review=amber, failed=red, merged=green, queued=grey) — a
 *  dedicated STATE scale, deliberately separate from the TYPE-accent scale
 *  (`typeAccentColor` below) so a node's animated liveness and its static
 *  kind identity never compete as "the same signal" (chrome/canvas.css's
 *  own type-accent block header). Every consumer of this function
 *  (mission/loop chips and dots, the canvas minimap, zone aggregate
 *  summaries, iteration chips, the toolbar's status legend) inherits any
 *  palette change from this one place.
 *
 *  Visual sweep #11 — `paused` used to share `--canvas-state-idle` with
 *  `queued`, so the legend (and every dot/ring driven by this same
 *  function) showed the exact same grey for "waiting to start" and
 *  "stopped mid-run" — two states a user very much needs to tell apart at
 *  a glance. `paused` now gets its own `--canvas-state-paused` (the same
 *  violet already used for "awaiting you" elsewhere on this card, see
 *  `PendingQuestionBadge` below), distinct from every other bucket in this
 *  scale. */
export function statusAccentColor(liveness: NodeLiveness): string {
  switch (liveness) {
    case 'running':
      return 'var(--canvas-state-running)';
    case 'paused':
      return 'var(--canvas-state-paused)';
    case 'review':
      return 'var(--canvas-state-review)';
    case 'failed':
      return 'var(--canvas-state-failed)';
    case 'merged':
      return 'var(--canvas-state-merged)';
    case 'queued':
    default:
      return 'var(--canvas-state-idle)';
  }
}

/** CSS class applied to the card for its whole-silhouette ring (empty
 *  string = no animation at all). P2 node visual language — motion budget
 *  (mockup: "only running/review animate, every other state is static"):
 *  `running`/`review` get the rotating conic-gradient ring
 *  (chrome/canvas.css's `.canvas-node-ring-running`/`-review`, 1.5s/4.5s);
 *  `paused`/`failed`/`merged`/`queued` resolve to no ring class at all —
 *  their liveness already reads from `statusAccentColor`'s flat accent
 *  alone, no separate pulse (a failed/paused card is deliberately as
 *  still as a merged/queued one — the mockup's own legend shows the
 *  failed example with a plain static red-tinted border, no halo). */
export function statusHaloClassName(liveness: NodeLiveness): string {
  if (liveness === 'running') return 'canvas-node-ring-running';
  if (liveness === 'review') return 'canvas-node-ring-review';
  return '';
}

/**
 * R1b defect #13 — composes the "title — status — stage" hover-tooltip
 * text every card kind passes to {@link NodeCard}'s `tooltip` prop. Pure
 * (matches {@link formatCountdown}'s own convention below: callers resolve
 * their own `t()` labels and pass plain strings in, rather than this
 * module calling the i18n hook itself) so it stays callable from a plain
 * card component with no React-context requirement of its own.
 * `stageLabel` is optional — schedule/draft nodes have no pipeline stage.
 */
export function buildNodeTooltip(title: string, statusLabel: string, stageLabel?: string): string {
  return [title, statusLabel, stageLabel].filter(Boolean).join(' — ');
}

// ── Type glyphs (spec §4.2 "every node shows a type glyph") ─────────
//
// Inline SVG paths only — never an emoji in a JSX icon prop (footgun:
// some platform fonts render emoji as literal fallback glyphs/tofu, see
// the "Lazy concurrent Cursor hazard" note). Kept intentionally simple
// (single-color stroke/fill, currentColor) so callers tint via `color`.

export type CanvasGlyphKind = 'mission' | 'loop' | 'schedule' | 'draft' | 'note' | 'router' | 'join';

// ── Type-accent palette (R2b visual overhaul, nodeSpec) ────────────────
//
// One accent per node KIND — deliberately distinct from chrome/
// StageRail.tsx's STAGE_COLORS (a mission's pipeline STAGE), so a node's
// TYPE and its STAGE never collide as "the same signal" (spec's own
// instruction). Values are the CSS custom properties chrome/canvas.css's
// `:root` block defines (mapped 1:1 onto the brief's seed hexes) — never
// a raw hex literal here, so a future palette tweak is one CSS edit.
export const TYPE_ACCENT_COLORS: Record<CanvasGlyphKind, string> = {
  mission: 'var(--canvas-type-mission)',
  loop: 'var(--canvas-type-loop)',
  schedule: 'var(--canvas-type-schedule)',
  draft: 'var(--canvas-type-draft)',
  router: 'var(--canvas-type-router)',
  note: 'var(--canvas-type-note)',
  join: 'var(--canvas-type-join)',
};

/** Looks up a node kind's type-accent CSS var — the single call every
 *  node file should use instead of hardcoding one of the vars above
 *  directly, so a kind that's missing from the map degrades to the
 *  existing `--color-accent` rather than crashing on `undefined`. */
export function typeAccentColor(kind: CanvasGlyphKind): string {
  return TYPE_ACCENT_COLORS[kind] ?? 'var(--color-accent)';
}

interface TypeGlyphProps {
  kind: CanvasGlyphKind;
  size?: number;
  color?: string;
  title?: string;
}

/** Bolt / loop-arrows / clock / dashed-ghost / note — one SVG per node
 *  kind (spec §4.2). `title` sets an SVG `<title>` for a11y; the glyph is
 *  otherwise `aria-hidden` since it always sits next to a text label. */
export function TypeGlyph({ kind, size = 13, color = 'currentColor', title }: TypeGlyphProps) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': title ? undefined : true };
  switch (kind) {
    case 'mission':
      return (
        <svg {...common} data-testid="glyph-mission">
          {title && <title>{title}</title>}
          <path d="M9.2 1 3.5 9.2h3.3L6 15l6.5-8.6H9.1L9.2 1Z" fill={color} />
        </svg>
      );
    case 'loop':
      return (
        <svg {...common} data-testid="glyph-loop">
          {title && <title>{title}</title>}
          <path
            d="M3 8a5 5 0 0 1 8.6-3.5M13 8a5 5 0 0 1-8.6 3.5"
            stroke={color}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path d="M11.6 2.6v2.4H9.2M4.4 13.4V11H6.8" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'schedule':
      return (
        <svg {...common} data-testid="glyph-schedule">
          {title && <title>{title}</title>}
          <circle cx="8" cy="8" r="6.2" stroke={color} strokeWidth="1.5" />
          <path d="M8 4.6V8l2.6 1.6" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'draft':
      return (
        <svg {...common} data-testid="glyph-draft">
          {title && <title>{title}</title>}
          <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" stroke={color} strokeWidth="1.4" strokeDasharray="2.4 2.2" />
        </svg>
      );
    case 'note':
      return (
        <svg {...common} data-testid="glyph-note">
          {title && <title>{title}</title>}
          <path d="M3 2.6h10v7.4l-3 3.4H3V2.6Z" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M10 10v3l3-3.4h-3Z" fill={color} />
        </svg>
      );
    case 'router':
      // W8c — small diamond (spec: "small diamond node with N ordered
      // labeled outputs").
      return (
        <svg {...common} data-testid="glyph-router">
          {title && <title>{title}</title>}
          <path d="M8 1.6 14.4 8 8 14.4 1.6 8 8 1.6Z" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    case 'join':
      // W-JOIN — router's mirror image: N converging lines into one
      // (fan-IN, vs. router's fan-OUT diamond).
      return (
        <svg {...common} data-testid="glyph-join">
          {title && <title>{title}</title>}
          <path
            d="M2.4 3.6 8 8M2.4 12.4 8 8M8 8v6.4"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return null;
  }
}

// ── Status glyphs (fix/canvas-legibility — "icon redundant to color") ──
//
// A billboard chip/compact card must never rely on hue alone to convey
// liveness (the QA finding: "colors have no legend, no icons readable" —
// color-blind-safe redundant coding, same rationale as TypeGlyph existing
// at all). One inline SVG per NodeLiveness, same convention as TypeGlyph
// (never an emoji, currentColor/`color` prop tinted by the caller).

interface StatusGlyphProps {
  liveness: NodeLiveness;
  size?: number;
  color?: string;
}

/** Shape-per-status glyph: running = filled play triangle, queued = dashed
 *  ring, paused = two vertical bars, review = question mark, failed = cross
 *  in a circle, merged = check. Consumed by the mission billboard chip, the
 *  unified zone aggregate summary, and the canvas legend popover — one
 *  visual vocabulary shared everywhere a status needs to read without
 *  relying on color alone. */
export function StatusGlyph({ liveness, size = 10, color = 'currentColor' }: StatusGlyphProps) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true };
  switch (liveness) {
    case 'running':
      return (
        <svg {...common} data-testid="glyph-status-running">
          <path d="M4.5 2.5v11l9-5.5-9-5.5Z" fill={color} />
        </svg>
      );
    case 'queued':
      return (
        <svg {...common} data-testid="glyph-status-queued">
          <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.5" strokeDasharray="2.2 2.2" />
        </svg>
      );
    case 'paused':
      return (
        <svg {...common} data-testid="glyph-status-paused">
          <rect x="4.2" y="3" width="2.6" height="10" rx="0.8" fill={color} />
          <rect x="9.2" y="3" width="2.6" height="10" rx="0.8" fill={color} />
        </svg>
      );
    case 'review':
      return (
        <svg {...common} data-testid="glyph-status-review">
          <circle cx="8" cy="8" r="6.2" stroke={color} strokeWidth="1.4" />
          <text x="8" y="11" textAnchor="middle" fontSize="8.5" fontWeight="700" fill={color} stroke="none">
            ?
          </text>
        </svg>
      );
    case 'failed':
      return (
        <svg {...common} data-testid="glyph-status-failed">
          <circle cx="8" cy="8" r="6.2" stroke={color} strokeWidth="1.4" />
          <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'merged':
      return (
        <svg {...common} data-testid="glyph-status-merged">
          <path d="M3.5 8.4 6.6 11.5 12.5 5" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return null;
  }
}

/** W8c — pin glyph (deliverable #1 "Pin badge glyph on the edge label + on
 *  the source node's stage rail"). Plain inline SVG, same convention as
 *  {@link TypeGlyph} above — never an emoji. */
export function PinGlyph({ size = 10, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-testid="glyph-pin">
      <path
        d="M8 1.6c-2 0-3.6 1.6-3.6 3.6 0 2.1 2.4 4.4 3.1 6.9.1.3.5.9.5.9s.4-.6.5-.9c.7-2.5 3.1-4.8 3.1-6.9 0-2-1.6-3.6-3.6-3.6Z"
        stroke={color}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="5.2" r="1.3" fill={color} />
    </svg>
  );
}

// ── Badges / chips ────────────────────────────────────────────────────

/** fix/canvas-graph-legibility (founder, verbatim: "je vois juste des
 *  agents solo, aucun graph d'agent, on comprend rien" — screenshots
 *  qa-manager-2026-07-25/shots/039-etat-actuel-critique.png +
 *  040-graphe-gen-c-avec-m45.png): at deep dezoom a mission card had NO
 *  reliable own identity — only the urgent-rank N°N chip survived, which is
 *  absent on most cards, and the running mission referenced by id ("M45")
 *  in the FLUX bar had no matching visual anywhere on the card itself.
 *  `id` is `FleetMission.id` verbatim — already the short, human-legible
 *  "M<n>" form `agentsStore.ts`'s `nextMissionId` mints (never a UUID
 *  needing truncation, see that function's own doc comment), so this is a
 *  direct, honest passthrough, not a derived/abbreviated label.
 *
 *  Combines the id with a shape-coded {@link StatusGlyph} (color-blind-safe
 *  redundant coding, same rationale as every other StatusGlyph use in this
 *  file) tinted by the SAME `statusAccentColor` driving the card's left
 *  stripe — one compact, always-legible pill instead of two separate chips
 *  competing for the title band's limited width. Static content, scaled
 *  uniformly by React Flow's own viewport transform like the rest of the
 *  card — no semantic swap by zoom (W-CARDS). */
export function MissionIdBadge({ id, liveness, testId }: { id: string; liveness: NodeLiveness; testId?: string }) {
  const accent = statusAccentColor(liveness);
  return (
    <span
      data-testid={testId}
      title={id}
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        fontFamily: 'var(--font-mono)',
        fontSize: 22,
        fontWeight: 800,
        lineHeight: 1,
        letterSpacing: '-0.04em',
        color: 'var(--color-text)',
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      <StatusGlyph liveness={liveness} size={11} color={accent} />
      {id}
    </span>
  );
}

/** Fleet-wide urgent rank chip — same numbering as the cockpit's urgent
 *  cards (cockpitHelpers.rankUrgentMissions), just restyled as a small
 *  corner chip instead of a header-right badge (canvas cards are denser). */
export function UrgentRankChip({ rank }: { rank: number }) {
  return (
    <span
      data-testid="urgent-rank-chip"
      style={{
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 5px',
        borderRadius: 4,
        background: 'var(--color-danger)',
        color: '#14141C',
        flexShrink: 0,
        fontFamily: 'var(--font-mono)',
      }}
    >
      N°{rank}
    </span>
  );
}

/** Purple "?" badge for a mission with a real pending ask_user question
 *  (spec §4.4) — bounces once on mount via canvas.css's canvas-bounce-once,
 *  never an infinite animation (that's reserved for the running halo).
 *  `size` (fix/canvas-legibility) — the billboard chip reuses this exact
 *  badge at a reduced footprint rather than inventing a second glyph for
 *  the same "decision needed" signal. */
export function PendingQuestionBadge({ size = 16 }: { size?: number }) {
  return (
    <span
      data-testid="pending-question-badge"
      className="canvas-bounce-once"
      title="Question en attente"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: '#A855F7',
        color: '#14141C',
        fontSize: Math.round(size * 0.7),
        fontWeight: 800,
        flexShrink: 0,
      }}
    >
      ?
    </span>
  );
}

/** Chantier 3 (plan-first canvas) — small warm-accent "Proposé" badge for a
 *  node that is part of a still-pending plan proposal (see NodeCardProps'
 *  own `proposed` doc comment). `label` is passed in by the caller (reuses
 *  the existing `canvas.node.proposed` i18n key) — same convention as every
 *  other badge helper in this file (RetryHint, MetaChip). */
export function ProposedBadge({ label }: { label: string }) {
  return (
    <span
      data-testid="canvas-proposed-badge"
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 4,
        background: 'color-mix(in srgb, var(--color-warning, #f5b942) 20%, transparent)',
        color: 'var(--color-warning, #f5b942)',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

/**
 * Attribute-work-visibly wave 1 — a small colored dot answering "which
 * conversation launched this?" for a mission node, using the SAME
 * deterministic per-conversation accent (conversationColor.ts's
 * `conversationAccentColor`) already rendered on the LazyManager tab strip's
 * own pill dot (LazyManagerHeader.tsx) — so a user can visually match "this
 * dot in my open conversation tabs" to "this exact mission card on the
 * canvas" at a glance, without reading any id. `conversationId` is
 * `FleetMission.originConversationId` (fleetMissions.ts) verbatim — absent
 * for a mission launched outside the manager (canvas "new mission" flows,
 * loop iterations, chain-fired launches), in which case the caller simply
 * omits this component rather than rendering a fabricated/neutral dot.
 *
 * Deliberately minimal for this wave: a color-only dot, no human-readable
 * conversation title — `ManagerConversationState` (agentsStore.tsx) carries
 * no title/name field today, so there is nothing honest to label it with
 * yet (see this component's own module note in MissionNode.tsx's caller for
 * the full "what's deferred" reasoning).
 */
export function ConversationOriginDot({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  return (
    <span
      data-testid="mission-node-conversation-dot"
      title={t('canvas.node.conversationOrigin')}
      aria-label={t('canvas.node.conversationOrigin')}
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: conversationAccentColor(conversationId),
        flexShrink: 0,
      }}
    />
  );
}

/**
 * fix/canvas-verdict-contradiction (David's measured repro, 2026-08-14: a
 * card's own body text read "REVIEW / Verdict: rejected" while this exact
 * chip, right next to it, read "Verdict —") — the judge's own reason, when
 * cheaply available, so a user facing a rejection can actually act on it
 * instead of a bare word. Prefers the judge reviewer's own summary (the
 * role that actually decided `passed`); falls back to the first CONCLUSIVE
 * reviewer's summary (`!inconclusive` — an inconclusive entry is a
 * non-vote, ReviewerVerdict.inconclusive's own doc comment, never a real
 * reason). `undefined` when nothing conclusive said anything (an honest
 * absence, never a fabricated reason).
 */
function rejectionReason(verdict: JudgeVerdict): string | undefined {
  if (verdict.passed) return undefined;
  const judge = verdict.reviewers.find((r) => r.role === 'judge' && !r.inconclusive);
  if (judge) return judge.summary;
  return verdict.reviewers.find((r) => !r.inconclusive)?.summary;
}

/** Amber "Verdict" chip shown when a judge verdict has already been
 *  recorded (spec §4.4). */
export function VerdictChip({ verdict }: { verdict: JudgeVerdict }) {
  const { t } = useI18n();
  const reason = rejectionReason(verdict);
  const baseTitle = t(verdict.passed ? 'canvas.node.verdictApproved' : 'canvas.node.verdictRejected');
  return (
    <span
      data-testid="verdict-chip"
      title={reason ? `${baseTitle} — ${reason}` : baseTitle}
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 4,
        background: verdict.passed ? 'var(--color-success-soft)' : 'rgba(251,185,36,0.14)',
        color: verdict.passed ? 'var(--color-success-text)' : 'var(--color-warning-text)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      {/* fix/canvas-ux R4d (dogfood defect #2) — `verdict.score` is ALREADY
          on a 0-100 scale everywhere else in the app (evaluator.ts's own
          `score: ok ? 85 : ...`, managerAdvice.ts's "score X/100",
          history/DataInspector.tsx's `{verdict.score}/100`, every
          evaluator.test.ts assertion) — multiplying by 100 here was the
          "Verdict 3000%" bug (a real score of 30 rendered as 30*100=3000%).
          Round only (never rescale) and match the SAME "/100" convention
          the rest of the app already uses (canvas.node.verdictScore's
          locale strings updated alongside this fix).

          R11 (judge-score honesty) — `verdict.scoreUnavailable` means
          `verdict.score` above is a `0` PLACEHOLDER (evaluator.ts's
          aggregateVerdict/evaluateScripted/buildUnavailableVerdict: no
          judge or reviewer ever produced a real, parsable number) — the
          exact bug that used to show « Verdict 0/100 » on a mission the
          judge's own shaky text-heuristic had just called "approve". Render
          the honest absence instead of that fabricated number.

          Visual sweep #4b — a scoreUnavailable verdict that DID pass used to
          render the bare "Verdict —" here, sitting right next to this same
          card's own live-line text (deriveLiveLine, MissionNode.tsx) reading
          "Verdict : approuvé" — a self-contradicting pair on one card (dash
          = "no verdict", text = "approved"). Fixed for the passed case by
          the `verdictPassedNoScore` branch below.

          fix/canvas-verdict-contradiction — the SAME contradiction, missed
          for the mirror case: a scoreUnavailable verdict that did NOT pass
          used to fall through to the generic `verdictUnavailable` dash here
          (this comment's own prior claim that the dash was "only ever
          honest for the no-score-AND-not-passed case" turned out to be
          false in practice — `deriveLiveLine` (missionLiveLine.ts) renders
          "Verdict : rejeté" for that EXACT same state whenever the judge
          isn't itself flagged unavailable, `isJudgeVerdictUnavailable`).
          `verdictRejectedNoScore` closes it the same way
          `verdictPassedNoScore` already did for the passed side — both
          chip and live-line now agree the mission was judged and rejected,
          never "no verdict" next to "rejected". */}
      {verdict.scoreUnavailable
        ? verdict.passed
          ? t('canvas.node.verdictPassedNoScore')
          : t('canvas.node.verdictRejectedNoScore')
        : t('canvas.node.verdictScore', { score: Math.round(verdict.score) })}
    </span>
  );
}

interface RetryHintProps {
  reason?: string;
  onRetry?: () => void;
  retryLabel: string;
}

/** Failed-status reason line + retry affordance (spec §4.4 "failed: red
 *  ring + statusReason + Retry button"). `retryLabel` is passed in by the
 *  caller (reuses the existing `canvas.node.retry` i18n key). */
export function RetryHint({ reason, onRetry, retryLabel }: RetryHintProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {reason && (
        <span
          data-testid="status-reason"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 10.5,
            color: 'var(--color-danger-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {reason}
        </span>
      )}
      {onRetry && (
        <button
          type="button"
          data-testid="retry-button"
          className="nodrag"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
          style={{
            flexShrink: 0,
            fontSize: 10.5,
            fontWeight: 700,
            padding: '2px 7px',
            borderRadius: 5,
            border: '1px solid rgba(255,255,255,0.18)',
            background: 'transparent',
            color: 'var(--color-text)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/** Small mono meta chip (model/cost/cadence/…) — mirrors CompactMissionCard's
 *  trailing meta text but boxed, since canvas cards pack more chips in. */
export function MetaChip({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        color: 'var(--color-text-muted)',
        background: 'var(--color-panel-3)',
        border: '1px solid var(--color-border-3)',
        borderRadius: 5,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
        // R11 UI polish (b) — uniform 120ms with every other interactive/
        // chip surface (chrome/canvas.css), so a chip that reacts to a
        // parent's hover/selection state (see NodeCard's own transitions)
        // never pops instantly while everything around it eases.
        transition: 'background-color 120ms ease, border-color 120ms ease, color 120ms ease',
      }}
    >
      {children}
    </span>
  );
}

// ── Model-tier chip (P2 node visual language) ──────────────────────────

const MODEL_TIER_ACCENTS: ReadonlyArray<{ test: RegExp; color: string }> = [
  { test: /sonnet/i, color: 'var(--canvas-tier-sonnet)' },
  { test: /haiku/i, color: 'var(--canvas-tier-haiku)' },
  { test: /fable/i, color: 'var(--canvas-tier-fable)' },
];

/** Best-effort Claude tier accent for a mission/draft's `model` label — a
 *  case-insensitive substring match against the tier word (the real
 *  `model` field is sometimes a raw id like `claude-sonnet-5`, sometimes
 *  an already-formatted label like `Claude Sonnet 5` — both contain the
 *  tier word, see lib/models/registry.ts). `undefined` for a tier this
 *  palette doesn't cover (e.g. opus) — the caller falls back to a plain
 *  neutral chip rather than inventing an unvalidated color for it. */
function modelTierAccent(model: string): string | undefined {
  return MODEL_TIER_ACCENTS.find((entry) => entry.test.test(model))?.color;
}

/** Colored model-tier chip (cockpit-redesign mockup's `.tier.sonnet`/
 *  `.tier.haiku`) — same footprint as {@link MetaChip}, tinted by Claude
 *  tier when recognized (sonnet/haiku/fable) via `color-mix` off the same
 *  accent used for the tier's own text (matches NodeCard's selected-ring
 *  `color-mix` idiom above, never a hand-picked second tint). Falls back
 *  to MetaChip's plain neutral look for an unrecognized model string (e.g.
 *  opus) — an honest "no tier color for this one" rather than a guessed
 *  hue. */
export function ModelTierChip({ model, testId }: { model: string; testId?: string }) {
  const accent = modelTierAccent(model);
  return (
    <span
      data-testid={testId}
      data-model-tier={accent ? model.toLowerCase() : undefined}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        fontWeight: 600,
        color: accent ?? 'var(--color-text-muted)',
        background: accent ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'var(--color-panel-3)',
        border: `1px solid ${accent ? `color-mix(in srgb, ${accent} 32%, transparent)` : 'var(--color-border-3)'}`,
        borderRadius: 5,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      }}
    >
      {model}
    </span>
  );
}

// ── Live action line (P2 node visual language) ─────────────────────────

interface LiveActionLineProps {
  /** Short colored verb (e.g. "édite", "exécute", "itération 14") — the
   *  one word/phrase that answers "what is this agent doing right now". */
  verb: string;
  /** Optional muted detail rendered after the verb (a filename/command/
   *  query) — absent renders the verb alone. */
  detail?: string;
  /** The state accent this line's dot + verb are tinted with — always the
   *  caller's own `statusAccentColor(liveness)`, never a fresh color. */
  accentColor: string;
  testId?: string;
}

/** Monospace "verb + target" action line with a pulsing live dot
 *  (cockpit-redesign mockup's "VERB ACTION LINE") — a running node's one
 *  honest, always-present answer to "what is it doing right now".
 *  `canvas-blink` reuses the existing global `blinkDot` keyframe
 *  (design-system.css) rather than declaring a new one. */
export function LiveActionLine({ verb, detail, accentColor, testId }: LiveActionLineProps) {
  return (
    <div
      data-testid={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
      }}
    >
      <span
        className="canvas-blink"
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: accentColor, flexShrink: 0 }}
      />
      <span style={{ color: accentColor, fontWeight: 700, flexShrink: 0, whiteSpace: 'nowrap' }}>{verb}</span>
      {detail && (
        <span
          style={{ color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {' '}{detail}
        </span>
      )}
    </div>
  );
}

// ── Title band (dezoom-legibility UX pass) ─────────────────────────────

interface CardTitleBandProps {
  children: ReactNode;
  testId?: string;
}

/**
 * Fixed-height, solid-fill title band for a full card's header row (spec:
 * "a card must stay identifiable by its title even shrunk to a few px at
 * deep dezoom"). Bleeds edge-to-edge via a negative margin against the
 * card's own 12px side padding (`MissionNodeCard`/`DraftNodeCard`'s outer
 * `style.padding`) — the parent `NodeCard` already clips overflow with a
 * matching `borderRadius` (see `CARD_BASE_STYLE`), so this band's own top
 * corners read as naturally rounded with no extra radius math needed here.
 *
 * W-CARDS — this is a STATIC style (fixed height, solid background,
 * truncated single-line content via each caller's own title span): it never
 * changes shape by zoom, it is simply small like the rest of the card when
 * the card itself is small (React Flow's own viewport transform scales it
 * uniformly, same "no semantic content swap" rule every other node visual
 * follows). Same idiom `ProjectGroupNode.tsx`'s own floating zone-title band
 * already established one level up (a reserved, fixed-height identity row),
 * just inside a single card instead of above a whole zone.
 */
// fix/canvas-graph-legibility — band grown 30 -> 36px so the bolder id
// badge + raised title-band font-weight (MissionNode.tsx) have room to
// breathe. Verified against every geometry.ts constant that budgets for
// this band (`grep NODE_HEADER_HEIGHT`): that module already reserves 44px
// of card-chrome height for the header row (`NODE_HEADER_HEIGHT`, folded
// into `FULL_CARD_MAX_HEIGHT`/`GRID_CELL_HEIGHT`'s own math) — 36 stays
// comfortably inside that existing budget, so NO geometry.ts constant
// needs to change for this bump (see NODE_HEADER_HEIGHT's own doc comment).
const CARD_TITLE_BAND_HEIGHT = 36;

export function CardTitleBand({ children, testId }: CardTitleBandProps) {
  return (
    <div
      data-testid={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        minHeight: CARD_TITLE_BAND_HEIGHT,
        height: 'auto',
        flexShrink: 0,
        margin: '0',
        padding: '0',
        background: 'transparent',
        borderBottom: 'none',
      }}
    >
      {children}
    </div>
  );
}

// ── Red relic softening (presentation only) ─────────────────────────────
//
// Founder screenshot 040 (qa-manager-2026-07-25): "Mission interrompue au
// redémarrage" cards (a mission force-failed by `applyReplayRecovery` in
// agentsStore.tsx purely because the app restarted mid-run — never a real
// task failure) scream the same full red alarm forever, competing for
// attention with genuinely fresh failures and the one actually-running
// mission. `agentsStore.tsx` is owned by a concurrent wave this session
// (see this file's own task boundary) and carries no structured
// "restart-interrupted" reason CODE today — `statusReason` is the ALREADY-
// TRANSLATED string that recovery pass writes (`t('agents.recoveredOnRestart')`,
// baked in at recovery time in whatever locale was active then). Matching
// against that same key's CURRENT translation is a pragmatic v1 (works for
// the overwhelmingly common case: locale doesn't change mid-session) — a
// dedicated boolean/reason-code on Mission would be the more robust fix,
// flagged as a followup rather than expanding this wave's file boundary.
export const STALE_INTERRUPTED_RELIC_THRESHOLD_MS = 30 * 60_000;

/** True for a 'failed' card whose failure is SPECIFICALLY the restart-
 *  recovery relic (never a genuine task error) AND old enough
 *  ({@link STALE_INTERRUPTED_RELIC_THRESHOLD_MS}) that it has had its fair
 *  turn as an alarm — a FRESH restart-interruption (just happened, still
 *  actionable) keeps the full red treatment. Pure/testable: every input is
 *  a plain value, no Date.now() call hidden inside. */
export function isStaleInterruptedRelic(
  mission: { statusReason?: string; updatedMs: number },
  liveness: NodeLiveness,
  restartInterruptedReason: string,
  nowMs: number,
): boolean {
  if (liveness !== 'failed') return false;
  if (mission.statusReason !== restartInterruptedReason) return false;
  return nowMs - mission.updatedMs > STALE_INTERRUPTED_RELIC_THRESHOLD_MS;
}

/** Thin progress bar (0-100), used by MissionNode's full card. */
export function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      data-testid="progress-bar"
      style={{ height: 3, borderRadius: 2, background: 'var(--color-panel-3)', overflow: 'hidden' }}
    >
      <div
        style={{
          height: '100%',
          width: `${clamped}%`,
          background: 'var(--color-accent)',
          borderRadius: 2,
          transition: 'width 0.3s ease',
        }}
      />
    </div>
  );
}

// ── Card container ────────────────────────────────────────────────────

export const CARD_BASE_STYLE: CSSProperties = {
  background: 'var(--canvas-node-bg)',
  border: '1px solid var(--canvas-node-border-resting)',
  borderRadius: 10,
  // Night Signal — flat panel, one quiet lift. The old 3-layer aura made
  // every card glow the same grey blob at dezoom; a 4px status stripe +
  // ring already carry liveness.
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 8px 22px rgba(0,0,0,0.28)',
  minWidth: 168,
  fontFamily: 'var(--font-ui)',
  color: 'var(--color-text)',
};

interface NodeCardProps {
  liveness?: NodeLiveness;
  /** Left accent stripe color — e.g. the mission's current stage color or
   *  the owning project's color. Legacy/additive: still renders a left
   *  stripe where a caller passes it, alongside (not instead of) the new
   *  `typeAccent` top strip below — kept so no existing card needs to
   *  drop its stage-color cue to adopt the new type-accent system. */
  accentColor?: string;
  /**
   * R2b visual overhaul (nodeSpec) — the node KIND's own accent (see
   * chrome/nodeChrome.tsx's `TYPE_ACCENT_COLORS`/`typeAccentColor`).
   * Renders the 3px colored top-edge strip (the ONLY per-type background
   * signal per the brief), and doubles as the selected-ring color. Absent
   * falls back to `--color-accent` for the selected ring and renders no
   * top strip (e.g. NoteNode/RouterNode use their own custom shells, not
   * this component).
   */
  typeAccent?: string;
  /** Validation error (spec: "border stays neutral, ring instead" — never
   *  a border-color swap, so edge routing math never jumps). */
  error?: boolean;
  /** Running/active inner-border pulse (`canvas-node-inner-pulse`) — kept
   *  for a future caller that wants an EXTRA motion layer on top of the
   *  `liveness`-driven ring below; no current node kind passes this
   *  truthy (P2 node visual language consolidated running/review motion
   *  into the single rotating ring, statusHaloClassName, so a busy running
   *  card doesn't carry two competing animations at once). */
  running?: boolean;
  selected?: boolean;
  faded?: boolean;
  ghost?: boolean;
  /** Chantier 3 (plan-first canvas) — this node is one step of a still-
   *  pending manager plan proposal, not yet validated (canvasTypes.ts's
   *  `DraftSpec.proposedPlanId`/`Chain.proposedPlanId`/`JoinSpec.proposedPlanId`
   *  doc comments). Applies `.canvas-proposed-card` (chrome/canvas.css) —
   *  a strictly MORE tentative look than `ghost` alone, so a proposed step
   *  never reads as an already-armed, ready-to-launch draft. */
  proposed?: boolean;
  testId?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * R1b defect #13 — node hover tooltip (real-gesture triage: hovering a
   * node showed nothing). A cheap v1 (task's own call): the native HTML
   * `title` attribute, composed by each caller as "title — status — stage"
   * (see MissionNodeCard/LoopNodeCard/ScheduleNodeCard/DraftNodeCard's own
   * `buildNodeTooltip` calls) — the browser handles the hover-delay/
   * positioning/dismiss for free, no custom overlay/timer to maintain.
   * Absent renders no `title` attr at all (unaffected existing behavior).
   */
  tooltip?: string;
  /** W8a deliverable #1 — the hover quick-actions strip (see
   *  HoverActionStrip.tsx), rendered top-right, fading in on hover/focus
   *  (see canvas.css's `.canvas-hover-actions`). Absent/empty renders
   *  nothing — every existing card that doesn't pass this is unaffected. */
  hoverActions?: ReactNode;
  /** R2b connectionUx "search-light" — set by the node's own wrapper
   *  component (e.g. MissionNode) from `useConnectionDragHighlight(id)`
   *  while a connection drag is in progress canvas-wide. Absent/'idle'
   *  renders no extra class. */
  connectionHighlight?: 'compatible' | 'incompatible';
  /** R7 (additive) — MissionNode.tsx's "agrandir" live-panel expand gesture
   *  (spec: chevron AND double-click both trigger it). Absent for every
   *  other existing caller of this shell, unaffected. */
  onDoubleClick?: () => void;
  children: ReactNode;
}

/**
 * Shared outer card shell: base panel styling, left stage/project accent
 * stripe, status halo class, selection ring, and the merged-node fade
 * (spec §4.4). Kind-specific content (header/body/footer) is passed as
 * children — this component owns only the shell, never the layout inside.
 */
export function NodeCard({
  liveness,
  accentColor,
  typeAccent,
  error,
  running,
  selected,
  faded,
  ghost,
  proposed,
  testId,
  className,
  style,
  tooltip,
  hoverActions,
  connectionHighlight,
  onDoubleClick,
  children,
}: NodeCardProps) {
  const halo = liveness ? statusHaloClassName(liveness) : '';
  const accent = typeAccent ?? 'var(--color-accent)';
  const classes = [
    'canvas-node-card',
    halo,
    faded ? 'canvas-fade-merged' : '',
    // Chantier 3 — `proposed` wins over the plain `ghost` look (a proposed
    // step is never ALSO rendered as a normal armed draft at the same time).
    proposed ? 'canvas-proposed-card' : ghost ? 'canvas-ghost-card' : '',
    hoverActions ? 'canvas-node-hoverable' : '',
    running ? 'canvas-node-inner-pulse' : '',
    connectionHighlight === 'compatible' ? 'canvas-connect-compatible' : '',
    connectionHighlight === 'incompatible' ? 'canvas-connect-incompatible' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  // Selected takes over the WHOLE border (nodeSpec: "2px solid type-accent
  // + halo ring") — the top-strip/left-stripe accents below only apply at
  // rest/hover, never fighting the selected ring for the same pixels.
  // `border` (shorthand) is set BEFORE `borderTop`/`borderLeft` in this
  // object so those longhands, when present, override just their one side
  // of the resting border — standard CSS declaration-order behavior for
  // an inline `style` attribute.
  const border = selected ? `2px solid ${accent}` : `1px solid var(--canvas-node-border-resting)`;
  // W-BYO nit (b), Langflow "typed drop zones" parity — a compatible-target
  // glow used to be a plain white box-shadow declared in canvas.css
  // (`.canvas-connect-compatible`), but every caller of this component ALSO
  // sets an inline `boxShadow` unconditionally (this ternary), and an
  // element's inline `style` attribute always wins over an external
  // stylesheet rule regardless of selector specificity — so that CSS rule's
  // box-shadow was silently dead code, never actually visible during a real
  // drag. Folding the compatible case into THIS inline computation both
  // fixes that (the glow now really renders) and adds the per-target-KIND
  // color cue the task asked for: `accent` is already this card's own
  // type-accent color (mission/draft/router/loop/schedule each pass their
  // own via the `typeAccent` prop) — a green-tinted mission target vs. an
  // amber-tinted draft target lets the user pre-read what a drop will
  // connect to, exactly like Langflow's colored port types, without adding
  // a new prop or touching connectionDragStore.ts's data shape at all.
  const boxShadow = error
    ? '0 0 0 2px var(--canvas-node-error)'
    : selected
      ? `0 0 0 4px color-mix(in srgb, ${accent} 18%, transparent), ${CARD_BASE_STYLE.boxShadow}`
      : connectionHighlight === 'compatible'
        ? `0 0 0 2px color-mix(in srgb, ${accent} 55%, transparent), ${CARD_BASE_STYLE.boxShadow}`
        : accentColor
          ? // Visual redo — status aura: a faint glow in the card's own
            // status/stage color so fleet health stays readable by COLOR
            // alone at extreme dezoom (founder's real 16% screenshot: the
            // 7px left stripe was sub-pixel and every card read identical
            // gray). `color-mix` accepts var() references fine. Quiet by
            // design — 30% alpha, 8px reach: visible as a tint, never a
            // second "error ring" (the error branch above still wins).
            `0 0 8px color-mix(in srgb, ${accentColor} 30%, transparent), ${CARD_BASE_STYLE.boxShadow}`
          : CARD_BASE_STYLE.boxShadow;

  return (
    <div
      data-testid={testId}
      title={tooltip}
      className={classes || undefined}
      onDoubleClick={onDoubleClick}
      style={{
        ...CARD_BASE_STYLE,
        position: 'relative',
        border,
        // "Status owns the card" (visual redo pass 2, founder real-app
        // screenshots): when liveness DEMANDS attention (review gate waiting,
        // failed) the left status stripe + status aura already carry the
        // signal — the 3px type-accent top strip on top of them stacked THREE
        // competing color frames on one small card (real 47% screenshot of an
        // amber review gate: amber border + amber halo + pink REVIEW pill +
        // kind-colored top strip). Quieting the kind strip for exactly these
        // two states lets the status read as ONE deliberate frame; queued/
        // running/merged/paused keep their kind strip (no competition there).
        // Night Signal — no competing type-accent top strip. Status lives
        // on the 4px left stripe + ring, same as the demo cards.
        ...(!selected && accentColor ? { borderLeft: `4px solid ${accentColor}` } : {}),
        boxShadow,
        ...style,
      }}
    >
      {hoverActions && (
        <div style={{ position: 'absolute', top: 6, right: 6, zIndex: 2 }}>{hoverActions}</div>
      )}
      {children}
    </div>
  );
}

// ── Live countdown (LoopNode/ScheduleNode next-run) ────────────────────

/** Formats a millisecond duration into a short label — the translated
 *  `canvas.node.inProgress` for <=0, otherwise "42 s" / "5 min" / "2 h" /
 *  "3 j" (unit abbreviations are unmarked pre-existing shorthand, not part
 *  of this sweep). Pure — `t` is passed in explicitly (LoopNode/
 *  ScheduleNode's own `useI18n()`) rather than called internally, so this
 *  stays a plain function callable outside a React render pass (e.g. a
 *  future direct unit test), where a hook call would be illegal. */
export function formatCountdown(deltaMs: number, t: (key: string) => string): string {
  if (deltaMs <= 0) return t('canvas.node.inProgress');
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} j`;
}

// ── Agent Persona & Role Classification (LazyIDE glanceability) ──────────

export interface AgentRoleConfig {
  displayName: string;
  category: 'architect' | 'frontend' | 'backend' | 'tester' | 'reviewer' | 'security' | 'content' | 'general';
  accentColor: string;
  iconType: string;
}

function formatAgentDisplayName(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveAgentRole(agentName?: string): AgentRoleConfig {
  if (!agentName || agentName === 'claude' || agentName === 'agent') {
    return {
      displayName: 'Code Assistant',
      category: 'general',
      accentColor: '#818CF8',
      iconType: 'code',
    };
  }

  const nameLower = agentName.toLowerCase();

  if (nameLower.includes('architect')) {
    return {
      displayName: formatAgentDisplayName(agentName),
      category: 'architect',
      accentColor: '#A78BFA',
      iconType: 'layers',
    };
  }
  if (nameLower.includes('review') || nameLower.includes('judge') || nameLower.includes('evaluat')) {
    return {
      displayName: formatAgentDisplayName(agentName),
      category: 'reviewer',
      accentColor: '#F43F5E',
      iconType: 'shield',
    };
  }
  if (nameLower.includes('test') || nameLower.includes('e2e') || nameLower.includes('qa') || nameLower.includes('runner')) {
    return {
      displayName: formatAgentDisplayName(agentName),
      category: 'tester',
      accentColor: '#F59E0B',
      iconType: 'check-circle',
    };
  }
  if (nameLower.includes('security') || nameLower.includes('auth') || nameLower.includes('audit')) {
    return {
      displayName: formatAgentDisplayName(agentName),
      category: 'security',
      accentColor: '#EF4444',
      iconType: 'lock',
    };
  }
  if (
    nameLower.includes('ui') ||
    nameLower.includes('front') ||
    nameLower.includes('react') ||
    nameLower.includes('design') ||
    nameLower.includes('carousel') ||
    nameLower.includes('brand')
  ) {
    return {
      displayName: formatAgentDisplayName(agentName),
      category: 'frontend',
      accentColor: '#00D2FF',
      iconType: 'layout',
    };
  }
  if (nameLower.includes('doc') || nameLower.includes('copy') || nameLower.includes('content') || nameLower.includes('note')) {
    return {
      displayName: formatAgentDisplayName(agentName),
      category: 'content',
      accentColor: '#10B981',
      iconType: 'file-text',
    };
  }
  if (nameLower.includes('build') || nameLower.includes('error') || nameLower.includes('resolver') || nameLower.includes('fix') || nameLower.includes('simplifi')) {
    return {
      displayName: formatAgentDisplayName(agentName),
      category: 'backend',
      accentColor: '#38BDF8',
      iconType: 'wrench',
    };
  }

  return {
    displayName: formatAgentDisplayName(agentName),
    category: 'general',
    accentColor: '#818CF8',
    iconType: 'bot',
  };
}

export function AgentRoleIcon({ iconType, color = 'currentColor', size = 11 }: { iconType: string; color?: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true };
  switch (iconType) {
    case 'layers':
      return (
        <svg {...common}>
          <path d="M8 1.5 1.5 5.5 8 9.5l6.5-4L8 1.5Z" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M1.5 8.5 8 12.5l6.5-4" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    case 'shield':
      return (
        <svg {...common}>
          <path d="M8 1.5s5 1.5 5 5.5c0 4-5 7.5-5 7.5S3 11 3 7c0-4 5-5.5 5-5.5Z" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      );
    case 'check-circle':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" stroke={color} strokeWidth="1.4" />
          <path d="m5 8 2 2 4-4" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'lock':
      return (
        <svg {...common}>
          <rect x="3" y="6.5" width="10" height="8" rx="1.5" stroke={color} strokeWidth="1.4" />
          <path d="M5.5 6.5V4.5a2.5 2.5 0 0 1 5 0v2" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'layout':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="1.5" stroke={color} strokeWidth="1.4" />
          <path d="M2 6h12M6 6v8" stroke={color} strokeWidth="1.4" />
        </svg>
      );
    case 'file-text':
      return (
        <svg {...common}>
          <path d="M3.5 2h6l3.5 3.5v8.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" stroke={color} strokeWidth="1.4" />
          <path d="M6 7.5h4M6 10.5h4" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'wrench':
      return (
        <svg {...common}>
          <path d="M14 4.5a3.5 3.5 0 0 1-4.8 3.3L4 13l-1.5-.5L2 11l5.2-5.2A3.5 3.5 0 0 1 10.5 1l-2 2.5 1 1L14 4.5Z" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      );
    case 'bot':
      return (
        <svg {...common}>
          <rect x="2.5" y="4" width="11" height="9" rx="2" stroke={color} strokeWidth="1.4" />
          <path d="M8 1.5v2.5M5.5 8h.01M10.5 8h.01M5.5 10.5h5" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'code':
    default:
      return (
        <svg {...common}>
          <path d="m5 5-3.5 3 3.5 3M11 5l3.5 3-3.5 3M9.5 3.5l-3 9" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

export function AgentPersonaChip({ agentName, testId }: { agentName?: string; testId?: string }) {
  const role = resolveAgentRole(agentName);
  return (
    <span
      data-testid={testId}
      title={`Agent spécialisé: ${role.displayName}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 4,
        background: `color-mix(in srgb, ${role.accentColor} 16%, var(--color-panel-3))`,
        border: `1px solid color-mix(in srgb, ${role.accentColor} 38%, transparent)`,
        color: role.accentColor,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 160,
        flexShrink: 0,
      }}
    >
      <AgentRoleIcon iconType={role.iconType} color={role.accentColor} size={10} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{role.displayName}</span>
    </span>
  );
}

// ── Tool Activity Extraction & Display ───────────────────────────────────

export interface ToolActivityInfo {
  toolTag: string;
  tagColor: string;
  target?: string;
}

export function parseToolActivity(liveAction?: string, lastStep?: string): ToolActivityInfo | null {
  const raw = liveAction || lastStep;
  if (!raw) return null;
  const text = raw.trim();

  if (/^(?:édite|edit|modifie|écrit|write)\b/i.test(text)) {
    const target = text.replace(/^(?:édite|edit|modifie|écrit|write)[:\s]*/i, '').trim();
    return { toolTag: 'EDIT', tagColor: 'var(--canvas-state-running)', target };
  }
  if (/^(?:exécute|exec|commande|cmd|bash|run|lance)\b/i.test(text)) {
    const target = text.replace(/^(?:exécute|exec|commande|cmd|bash|run|lance)[:\s]*/i, '').trim();
    return { toolTag: 'EXEC', tagColor: 'var(--canvas-state-review)', target };
  }
  if (/^(?:cherche|search|grep|glob|trouve|lit|read)\b/i.test(text)) {
    const target = text.replace(/^(?:cherche|search|grep|glob|trouve|lit|read)[:\s]*/i, '').trim();
    return { toolTag: 'READ', tagColor: '#818CF8', target };
  }
  if (/^(?:brain|mémoire|recall)\b/i.test(text)) {
    const target = text.replace(/^(?:brain|mémoire|recall)[:\s]*/i, '').trim();
    return { toolTag: 'BRAIN', tagColor: '#A855F7', target };
  }
  if (/^mcp\b/i.test(text)) {
    const target = text.replace(/^mcp[:\s]*/i, '').trim();
    return { toolTag: 'MCP', tagColor: '#EC4899', target };
  }

  return { toolTag: 'TOOL', tagColor: 'var(--canvas-state-running)', target: text };
}

export function LiveToolActivityBlock({
  liveAction,
  lastStep,
  liveness,
  heartbeatElapsedMs,
  heartbeatStale,
  heartbeatSeconds,
  testId,
}: {
  liveAction?: string;
  lastStep?: string;
  liveness: NodeLiveness;
  heartbeatElapsedMs?: number;
  heartbeatStale?: boolean;
  heartbeatSeconds?: number;
  testId?: string;
}) {
  const tool = parseToolActivity(liveAction, lastStep);
  if (!tool) return null;

  return (
    <div
      data-testid={testId}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 6px',
        borderRadius: 4,
        background: 'rgba(0,0,0,0.3)',
        border: '1px solid var(--color-border-3)',
        minWidth: 0,
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span
        style={{
          fontSize: 8.5,
          fontWeight: 800,
          padding: '1px 4px',
          borderRadius: 3,
          background: `color-mix(in srgb, ${tool.tagColor} 22%, transparent)`,
          color: tool.tagColor,
          border: `1px solid color-mix(in srgb, ${tool.tagColor} 45%, transparent)`,
          flexShrink: 0,
          letterSpacing: '0.04em',
        }}
      >
        {tool.toolTag}
      </span>
      {tool.target && (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'var(--color-text)',
            fontWeight: 500,
          }}
          title={tool.target}
        >
          {tool.target}
        </span>
      )}
      {liveness === 'running' && heartbeatElapsedMs !== undefined && (
        <span
          style={{
            flexShrink: 0,
            fontSize: 9,
            color: heartbeatStale ? 'var(--color-warning-text)' : 'var(--color-text-disabled)',
            fontWeight: heartbeatStale ? 700 : 400,
          }}
          title="Heartbeat runner"
        >
          {heartbeatSeconds}s
        </span>
      )}
    </div>
  );
}

export function BrainMemoryBadge({ count, tokensSaved, adapted }: { count?: number; tokensSaved?: string; adapted?: boolean }) {
  if (!count && !tokensSaved && !adapted) return null;
  const label = count ? `${count} règle${count > 1 ? 's' : ''}` : tokensSaved ? tokensSaved : 'LazyBrain';
  return (
    <span
      data-testid="mission-brain-badge"
      title={`Guidé par la mémoire LazyBrain (${count ?? 1} contexte(s) injecté(s))`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 9.5,
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        padding: '1px 5px',
        borderRadius: 4,
        background: 'color-mix(in srgb, #A855F7 16%, var(--color-panel-3))',
        border: '1px solid color-mix(in srgb, #A855F7 35%, transparent)',
        color: '#C084FC',
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      <svg width={9} height={9} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M8 2a4 4 0 0 0-4 4c0 1.5.8 2.8 2 3.5V11a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V9.5c1.2-.7 2-2 2-3.5a4 4 0 0 0-4-4Z" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6.5 14h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      {label}
    </span>
  );
}

export function WorktreeBranchBadge({ worktree }: { worktree?: string }) {
  if (!worktree) return null;
  const shortName = worktree.replace(/^agent\//, '').replace(/^worktree-/, '');
  return (
    <span
      data-testid="mission-worktree-badge"
      title={`Branche Git isolée: ${worktree}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 9.5,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        padding: '1px 5px',
        borderRadius: 4,
        background: 'var(--color-panel-3)',
        border: '1px solid var(--color-border-3)',
        color: 'var(--color-text-secondary)',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 115,
      }}
    >
      <svg width={9} height={9} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
        <circle cx="5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="11" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5 10V6a2 2 0 0 1 2-2h2" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortName}</span>
    </span>
  );
}

/** Cross-project READ access transparency (see Mission.extraReadableRoots'
 *  doc comment, lib/agents/types.ts, for the full contract): renders ONLY
 *  when the mission actually declared extra readable roots — absent for
 *  the overwhelming common case (worktree-only scope), matching every
 *  other conditional badge on this card. The tooltip spells out that
 *  access is read-only, matching what run.rs actually enforces
 *  (--add-dir paired with a generated Edit/Write deny file). */
export function ExtraReadRootsBadge({ roots }: { roots?: string[] }) {
  if (!roots || roots.length === 0) return null;
  const label = roots.length === 1 ? basename(roots[0]) : `${roots.length} projets`;
  return (
    <span
      data-testid="mission-extra-read-roots-badge"
      title={`Lecture cross-projet autorisée (écriture bloquée hors worktree) :\n${roots.join('\n')}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 9.5,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        padding: '1px 5px',
        borderRadius: 4,
        background: 'var(--color-panel-3)',
        border: '1px solid var(--color-border-3)',
        color: 'var(--color-text-secondary)',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: 130,
      }}
    >
      <svg width={9} height={9} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M8 2 2 5v6l6 3 6-3V5L8 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M8 8v6M8 8 2 5M8 8l6-3" stroke="currentColor" strokeWidth="1" />
      </svg>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Lecture: {label}</span>
    </span>
  );
}

export function PlanStepProgressBadge({ planSteps }: { planSteps?: PlanStep[] }) {
  if (!planSteps || planSteps.length === 0) return null;
  const total = planSteps.length;
  const inProgressIndex = planSteps.findIndex((s) => s.state === 'in_progress');
  const doneCount = planSteps.filter((s) => s.state === 'done').length;
  const currentStep = inProgressIndex >= 0 ? planSteps[inProgressIndex] : planSteps[doneCount] ?? planSteps[total - 1];
  const stepNumber = (inProgressIndex >= 0 ? inProgressIndex : doneCount) + 1;

  return (
    <div
      data-testid="mission-plan-step-badge"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10,
        color: 'var(--color-text-secondary)',
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-accent)',
          flexShrink: 0,
        }}
      >
        Étape {Math.min(stepNumber, total)}/{total}
      </span>
      {currentStep?.label && (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'var(--color-text-muted)',
          }}
          title={currentStep.label}
        >
          {currentStep.label}
        </span>
      )}
    </div>
  );
}

export function AutonomyModeChip({ mode }: { mode?: 'plan' | 'acceptEdits' | 'full' }) {
  if (!mode || mode === 'acceptEdits') return null;
  const isPlan = mode === 'plan';
  const label = isPlan ? 'Plan Only' : 'Full Bypass';
  const color = isPlan ? '#60A5FA' : '#F59E0B';
  return (
    <span
      data-testid="mission-autonomy-badge"
      title={`Mode d'autonomie: ${mode}`}
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        fontWeight: 700,
        padding: '1px 4px',
        borderRadius: 3,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
        color,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

export function LiveOutputPeek({
  timeline,
  diffAdded,
  diffRemoved,
  liveness,
}: {
  timeline?: { time: string; text: string }[];
  diffAdded?: number;
  diffRemoved?: number;
  liveness: NodeLiveness;
}) {
  if (!timeline || timeline.length === 0) return null;
  const lastEvents = timeline.slice(-2);

  return (
    <div
      data-testid="mission-live-output-peek"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '3px 6px',
        borderRadius: 4,
        background: 'rgba(10, 10, 16, 0.65)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        color: 'var(--color-text-muted)',
      }}
    >
      {lastEvents.map((ev, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          <span style={{ color: 'var(--color-text-disabled)', flexShrink: 0 }}>{ev.time}</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color:
                i === lastEvents.length - 1 && liveness === 'running'
                  ? 'var(--canvas-state-running)'
                  : 'var(--color-text-secondary)',
            }}
          >
            {ev.text}
          </span>
        </div>
      ))}
      {(diffAdded !== undefined || diffRemoved !== undefined) && ((diffAdded ?? 0) > 0 || (diffRemoved ?? 0) > 0) && (
        <div style={{ display: 'flex', gap: 6, fontSize: 8.5, fontWeight: 700, marginTop: 1 }}>
          {diffAdded !== undefined && diffAdded > 0 && (
            <span style={{ color: 'var(--color-success)' }}>+{diffAdded}</span>
          )}
          {diffRemoved !== undefined && diffRemoved > 0 && (
            <span style={{ color: 'var(--color-danger)' }}>-{diffRemoved}</span>
          )}
        </div>
      )}
    </div>
  );
}


