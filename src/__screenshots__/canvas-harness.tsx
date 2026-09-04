/**
 * canvas-harness.tsx — isolated screenshot harness for the Agent Canvas
 * (W6a, docs/superpowers/specs/2026-07-14-agent-canvas-design.md). Sibling
 * to cockpit-harness.tsx, same rationale, same pattern — read that file's
 * header first, this one only documents what's DIFFERENT.
 *
 * Why this harness exists: exactly cockpit-harness.tsx's reasons, PLUS two
 * canvas-specific data sources that are equally empty outside a real
 * project/Tauri runtime:
 *   - `scheduled` (CanvasView's useCanvasHydration → listAgents(), Tauri-only)
 *   - `missionLoopMeta` (CanvasView's own useMemo over agentsStore's live
 *     Mission[] — empty because AppContext.openProjects/activeProjectId
 *     never populate on web, see AppContext.tsx's registerProject/
 *     switchProject, both gated `platform.name !== 'tauri'`)
 * Both get the exact same fix fleetOverride already established one layer
 * up: a tiny, optional, screenshot/test-only override prop
 * (CanvasView.tsx's `scheduledOverride`/`missionLoopMetaOverride`,
 * threaded through Cockpit.tsx verbatim) — never a mock branch in app code,
 * the fixture VALUES live only here.
 *
 * ── Why pre-seeding canvasStoreVanilla (drafts/chains/notes/positions/
 *    prefs) directly at module load, before first render, is SAFE ────────
 * canvasStore.hydrate() is the only thing that would overwrite this seed —
 * it runs inside useCanvasHydration's one-shot mount effect, but ONLY when
 * `activeRoot` is non-null (see that hook: `if (!repoPath) { setViewportInit
 * ({fit:true}); return; }` — hydrate() is never even called on that path).
 * `activeRoot` comes from `AppContext.openProjects`/`activeProjectId`,
 * which — as above — never populate outside Tauri. So on this harness,
 * hydrate() never fires, and a synchronous pre-render seed is never raced
 * or clobbered. (`activeProjectRootOverride` below only affects Cockpit's
 * OWN `isActiveProject` gate for click wiring — it does not feed
 * AppContext, so it does not change this.)
 *
 * ── ?view= mode switch ────────────────────────────────────────────────
 *   (default)     — nothing forced, prefs at their defaults.
 *   lanes         — prefs.laneMode seeded true BEFORE render; useCanvasLayout's
 *                   own "boot gap fix" (see that hook's header) applies lane
 *                   layout on mount exactly as if restored from a persisted
 *                   session — no extra harness plumbing needed.
 *   zoomed-out    — post-mount, repeatedly clicks the REAL toolbar zoom-out
 *                   button (data-testid canvas-toolbar-zoom-out) until the
 *                   displayed zoom%% is comfortably below ZOOM_DOT (0.45) —
 *                   dot/fleet view. Seeding canvasStore.viewport directly
 *                   does NOT work here: `viewportInit.fit` is unconditionally
 *                   true (no active project → no persisted viewport branch),
 *                   so React Flow's own `fitView` always overrides whatever
 *                   viewport the store holds at mount.
 *   zoomed-in     — same technique, clicks zoom-in until comfortably above
 *                   ZOOM_COMPACT (0.85) — full-card detail view.
 *   search        — post-mount, sets the REAL search input's (data-testid
 *                   canvas-toolbar-search) value via the native value setter
 *                   + a real `input` event (same technique React Testing
 *                   Library's fireEvent uses) so useCanvasFilter's own
 *                   onChange handler fires — no app-code seam needed since
 *                   the box is a plain controlled `<input>` already reachable
 *                   from the DOM; filter state genuinely is local/transient
 *                   (useCanvasFilter.ts's own header) so this is the honest
 *                   way to exercise it from outside, not a shortcut around it.
 *   merged-hidden — prefs.hideMerged seeded true BEFORE render; the
 *                   reconciler already reads `prefs.hideMerged` synchronously
 *                   on the very first reconcile(), no boot-gap concern.
 */

import { Component, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider, useAgentsStore, Cockpit, MissionDetailDrawer } from '../components/agents';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import { canvasStoreVanilla } from '../components/agents/canvas/canvasStore';
import {
  makeRef,
  type Chain,
  type DraftSpec,
  type FrameSpec,
  type NoteData,
  type RouterSpec,
  type ScheduleNodeData,
  type SurfaceSpec,
} from '../components/agents/canvas/canvasTypes';
import { LIVE_PANEL_SIZE, type MissionLoopMeta } from '../components/agents/canvas/reconciler';
import { formatCron } from '../lib/agents/scheduleUtils';
import type { FleetMission, FleetProject, UseFleetMissionsResult } from '../lib/agents/fleetMissions';
import type { Mission, ReviewerVerdict, RiskLevel } from '../lib/agents/types';

// ── Set locale to French before first render (matches every other harness) ──
try {
  localStorage.setItem('lazy.locale', 'fr');
} catch { /* noop */ }

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;

/** Read directly (not via the validated `getViewMode()` below, which is
 *  declared later in the file) — only the DENSE_* fixture consts right
 *  below need to branch on the mode this early, before `ViewMode`/
 *  `VIEW_MODES` even exist yet. */
const VIEW_MODE_RAW = new URLSearchParams(window.location.search).get('view');

// ── Mission fixtures — FleetMission-shaped directly (this harness feeds
//    Cockpit's `fleetOverride`, which is UseFleetMissionsResult — the SAME
//    shape production's useFleetMissions()/toFleetMission() produce, so
//    authoring FleetMission fixtures verbatim here, rather than a full
//    `Mission` converted through toFleetMission, is the honest match for
//    what this seam actually accepts). `stage` and `urgent` are set
//    EXPLICITLY per fixture (not derived) — FleetMission carries no
//    `planSteps` to derive `stage` FROM (see fleetStage.ts's own input
//    type; that derivation only exists upstream, in toFleetMission, before
//    the richer `Mission` is flattened) — this mirrors production exactly:
//    by the time a mission is FleetMission-shaped, `stage` is already a
//    plain fact, not a computation. ───────────────────────────────────────

interface MissionFixture extends FleetMission {
  projectId: string;
}

function fm(
  projectId: string,
  base: Pick<FleetMission, 'id' | 'title' | 'status' | 'stage' | 'model'> & Partial<FleetMission>,
  updatedMs: number = NOW,
): MissionFixture {
  return {
    urgent: base.status === 'failed' || base.status === 'review',
    updatedMs,
    ...base,
    projectId,
  };
}

function reviewer(role: ReviewerVerdict['role'], verdict: ReviewerVerdict['verdict'], summary: string, score: number): ReviewerVerdict {
  return { role, verdict, summary, score };
}

// fix/canvas-ux R4d (dogfood defect #2) — `score`/reviewer `score` are on a
// 0-100 scale everywhere in the real app (evaluator.ts, managerAdvice.ts,
// history/DataInspector.tsx's `{verdict.score}/100`, every
// evaluator.test.ts assertion) — these fixtures used to author a 0-1
// FRACTION (0.86/0.42/…), which only "looked right" because
// chrome/nodeChrome.tsx's VerdictChip used to also (wrongly) multiply by
// 100 before display. Now that that bug is fixed (VerdictChip rounds the
// real 0-100 score verbatim), a 0-1 fixture would render as "Verdict
// 1/100"/"Verdict 0/100" — rescaled to the real 0-100 convention so the
// harness screenshot shows realistic, correct values.
const PASSED_VERDICT = {
  score: 86,
  passed: true,
  risk: 'low' as RiskLevel,
  reviewers: [
    reviewer('tester', 'approve', 'Suite complète, 0 échec.', 90),
    reviewer('reviewer', 'approve', 'Diff propre, conventions respectées.', 82),
  ],
  createdAt: new Date(NOW - 12 * MIN).toISOString(),
};

const REJECTED_VERDICT = {
  score: 42,
  passed: false,
  risk: 'high' as RiskLevel,
  reviewers: [
    reviewer('security', 'reject', 'Deep link non validé — injection possible via le paramètre `ref`.', 30),
    reviewer('reviewer', 'request_changes', 'Gestion d’erreur réseau manquante.', 55),
  ],
  createdAt: new Date(NOW - 18 * MIN).toISOString(),
};

// ── gameon-mobile (active project) — the richest zone: every stage, every
//    status, the permission/failed/review urgent kinds, an orchestrator +
//    2 sub-missions, and a 3-iteration loop. ──────────────────────────────

const GAMEON_MISSIONS: MissionFixture[] = [
  fm('gameon-mobile', { id: 'gm-plan-onboarding', title: 'onboarding-flow-v2', status: 'queued', stage: 'plan', model: 'haiku 4.5', liveAction: 'en file…' }),
  fm('gameon-mobile', { id: 'gm-code-payment', title: 'payment-flow-stripe', status: 'running', stage: 'code', model: 'sonnet 4.6', liveAction: '▊ écrit PaymentSheet.tsx…', progress: 55 }),
  fm('gameon-mobile', { id: 'gm-test-anticheat', title: 'anti-cheat-server-auth', status: 'running', stage: 'test', model: 'sonnet 4.6', liveAction: 'suite de tests en cours…', progress: 88, judgeVerdict: PASSED_VERDICT }),
  fm(
    'gameon-mobile',
    {
      id: 'gm-review-friend-invites',
      title: 'friend-invites-deeplink',
      status: 'review',
      stage: 'review',
      model: 'sonnet 4.6',
      liveAction: '+164 −38 · jugé ✗ risque élevé',
      diffAdded: 164,
      diffRemoved: 38,
      judgeVerdict: REJECTED_VERDICT,
    },
    NOW - 26 * MIN,
  ),
  fm('gameon-mobile', { id: 'gm-merged-avatar-upload', title: 'avatar-upload-s3', status: 'done', stage: 'merged', model: 'haiku 4.5', liveAction: 'mergé il y a 1 h' }, NOW - HOUR),
  fm('gameon-mobile', { id: 'gm-done-changelog', title: 'changelog-v1.4', status: 'done', stage: 'merged', model: 'haiku 4.5', liveAction: 'terminé' }, NOW - 8 * MIN),
  fm(
    'gameon-mobile',
    { id: 'gm-failed-push-notifs', title: 'push-notifs-fcm', status: 'failed', stage: 'code', model: 'sonnet 4.6', liveAction: 'échec build', statusReason: 'FCM token invalide — 3 tentatives épuisées' },
    NOW - 34 * MIN,
  ),
  fm(
    'gameon-mobile',
    {
      id: 'gm-permission-anticheat-auth',
      title: 'anti-cheat-server-auth-migration',
      status: 'running',
      stage: 'code',
      model: 'sonnet 4.6',
      liveAction: '▊ écrit server/auth.rs…',
      pendingQuestion: 'write server/auth.rs (nouvelle route) ?',
    },
    NOW - 2 * MIN,
  ),
  fm('gameon-mobile', { id: 'gm-paused-sync-engine', title: 'offline-sync-engine', status: 'running', stage: 'code', model: 'sonnet 4.6', liveAction: '⏸ pausé — reprise manuelle', progress: 33, paused: true }),
  // Orchestrator + 2 sub-missions (parentMissionId, spec §7.2).
  fm('gameon-mobile', { id: 'gm-orch-release-prep', title: 'release-prep-v1.4', status: 'running', stage: 'code', model: 'opus 4.5', liveAction: 'coordonne 2 sous-missions…' }),
  fm('gameon-mobile', { id: 'gm-orch-release-prep-sub1', title: 'release-prep-v1.4 · changelog', status: 'running', stage: 'code', model: 'haiku 4.5', liveAction: 'rédige changelog…', parentMissionId: 'gm-orch-release-prep' }),
  fm('gameon-mobile', { id: 'gm-orch-release-prep-sub2', title: 'release-prep-v1.4 · store-listing', status: 'queued', stage: 'plan', model: 'haiku 4.5', parentMissionId: 'gm-orch-release-prep' }),
  // Loop (cadence '1h') + 3 iterations, folded into the loop node's chip
  // stack by the reconciler (missionToChildCandidate: a loopParentId child
  // whose parent is present in the same zone renders NOTHING of its own).
  fm('gameon-mobile', {
    id: 'gm-loop-nightly-tests',
    title: 'nightly-regression-suite',
    status: 'running',
    stage: 'code',
    model: 'sonnet 4.6',
    liveAction: 'itération 3/∞…',
    loopConfig: {
      cadence: '1h',
      stopCondition: { kind: 'manual' },
      enabled: true,
      lastRunAt: new Date(NOW - 6 * MIN).toISOString(),
      nextRunAt: new Date(NOW + 54 * MIN).toISOString(),
      iterationCount: 3,
      iterationMissionIds: ['gm-loop-nightly-tests-i1', 'gm-loop-nightly-tests-i2', 'gm-loop-nightly-tests-i3'],
    },
  }),
  fm('gameon-mobile', { id: 'gm-loop-nightly-tests-i1', title: 'nightly-regression-suite · #1', status: 'done', stage: 'merged', model: 'sonnet 4.6', loopParentId: 'gm-loop-nightly-tests', loopIteration: 1 }, NOW - 2 * HOUR),
  fm('gameon-mobile', { id: 'gm-loop-nightly-tests-i2', title: 'nightly-regression-suite · #2', status: 'done', stage: 'merged', model: 'sonnet 4.6', loopParentId: 'gm-loop-nightly-tests', loopIteration: 2 }, NOW - HOUR),
  fm('gameon-mobile', { id: 'gm-loop-nightly-tests-i3', title: 'nightly-regression-suite · #3', status: 'running', stage: 'test', model: 'sonnet 4.6', liveAction: 'tests en cours…', loopParentId: 'gm-loop-nightly-tests', loopIteration: 3 }, NOW - 6 * MIN),
];

// ── site-web — a second, smaller zone (a non-active project — proves the
//    canvas renders several projects side by side, and that hierarchy/loop
//    metadata degrade honestly for missions with none). ───────────────────

const SITE_WEB_MISSIONS: MissionFixture[] = [
  fm('site-web', { id: 'sw-plan-seo', title: 'seo-plan-metadonnees', status: 'queued', stage: 'plan', model: 'haiku 4.5' }),
  fm('site-web', { id: 'sw-code-pricing', title: 'pricing-table-v3', status: 'running', stage: 'code', model: 'sonnet 4.6', liveAction: '▊ PricingTable.tsx…', progress: 62 }),
  fm('site-web', { id: 'sw-test-i18n', title: 'i18n-de-fr-parity', status: 'running', stage: 'test', model: 'sonnet 4.6', liveAction: 'suite i18n…', progress: 91, judgeVerdict: PASSED_VERDICT }),
  fm(
    'site-web',
    { id: 'sw-review-checkout', title: 'checkout-stripe-webhooks', status: 'review', stage: 'review', model: 'sonnet 4.6', liveAction: '+214 −89 · jugé ✓ risque faible', diffAdded: 214, diffRemoved: 89, judgeVerdict: PASSED_VERDICT },
    NOW - 40 * MIN,
  ),
  fm('site-web', { id: 'sw-merged-newsletter', title: 'newsletter-embed', status: 'done', stage: 'merged', model: 'sonnet 4.6', liveAction: 'mergé il y a 2 h' }, NOW - 2 * HOUR),
];

// ── training-api — a third zone (queued/code/failed only — keeps the
//    fixture set from ballooning while still proving a 3rd project renders). ──

const TRAINING_API_MISSIONS: MissionFixture[] = [
  fm('training-api', { id: 'ta-plan-eval-harness', title: 'eval-harness-v2', status: 'queued', stage: 'plan', model: 'opus 4.5' }),
  fm('training-api', { id: 'ta-code-batching', title: 'batch-generation-endpoint', status: 'running', stage: 'code', model: 'sonnet 4.6', liveAction: '▊ batching.py…', progress: 44 }),
  fm(
    'training-api',
    { id: 'ta-failed-deploy', title: 'render-deploy-config', status: 'failed', stage: 'code', model: 'haiku 4.5', liveAction: 'échec build', statusReason: 'Build Render échoué — requirements.txt incompatible' },
    NOW - 51 * MIN,
  ),
];

// ── Dense zone (?view=dense ONLY — see VIEW_MODE guard below every DENSE_*
//    const) — fix/canvas-ux R4a adversarial stress fixture for the
//    no-overlap placement invariant: ~14 mixed nodes packed into ONE zone
//    (GRID_MAX_COLS=4 means this wraps across several rows), including an
//    EXPANDED loop (whose 3 iteration minis hang below it, deep enough to
//    reach into the row below in a dense grid — the exact W8a "iterations
//    overlap the row below" defect) AND 2 PINNED nodes placed EXACTLY where
//    the naive incremental grid-slot formula would ALSO place a still-auto
//    sibling (the exact W10 "grid doesn't reserve space around arbitrary
//    pinned coordinates" defect — see PINNED_POSITIONS' own
//    `gm-merged-avatar-upload` comment below for this project's prior
//    workaround for that same bug). Proves reconcilerZones.ts's
//    collision-resolution pass under BOTH known defect shapes at once, in
//    one screenshot. Only materializes for ?view=dense — every other
//    mode's fixture/screenshot is completely unaffected.
const DENSE_ZONE_MISSIONS: MissionFixture[] = VIEW_MODE_RAW === 'dense' ? [
  fm('dense-zone', { id: 'dz-m0', title: 'dense-task-0', status: 'queued', stage: 'plan', model: 'haiku 4.5' }),
  fm('dense-zone', { id: 'dz-m1', title: 'dense-task-1', status: 'running', stage: 'code', model: 'sonnet 4.6' }),
  fm('dense-zone', { id: 'dz-m2', title: 'dense-task-2', status: 'running', stage: 'test', model: 'sonnet 4.6' }),
  fm('dense-zone', { id: 'dz-m3', title: 'dense-task-3', status: 'review', stage: 'review', model: 'sonnet 4.6' }),
  fm('dense-zone', { id: 'dz-m4', title: 'dense-task-4', status: 'done', stage: 'merged', model: 'haiku 4.5' }),
  fm('dense-zone', { id: 'dz-m5', title: 'dense-task-5', status: 'failed', stage: 'code', model: 'sonnet 4.6' }),
  fm('dense-zone', { id: 'dz-m6', title: 'dense-task-6', status: 'running', stage: 'code', model: 'sonnet 4.6' }),
  fm('dense-zone', {
    id: 'dz-loop',
    title: 'dense-loop',
    status: 'running',
    stage: 'code',
    model: 'sonnet 4.6',
    loopConfig: {
      cadence: '1h',
      stopCondition: { kind: 'manual' },
      enabled: true,
      iterationCount: 3,
      iterationMissionIds: ['dz-loop-i1', 'dz-loop-i2', 'dz-loop-i3'],
    },
  }),
  fm('dense-zone', { id: 'dz-loop-i1', title: 'dense-loop · #1', status: 'done', stage: 'merged', model: 'sonnet 4.6', loopParentId: 'dz-loop', loopIteration: 1 }, NOW - 2 * HOUR),
  fm('dense-zone', { id: 'dz-loop-i2', title: 'dense-loop · #2', status: 'done', stage: 'merged', model: 'sonnet 4.6', loopParentId: 'dz-loop', loopIteration: 2 }, NOW - HOUR),
  fm('dense-zone', { id: 'dz-loop-i3', title: 'dense-loop · #3', status: 'running', stage: 'test', model: 'sonnet 4.6', liveAction: 'tests en cours…', loopParentId: 'dz-loop', loopIteration: 3 }, NOW - 6 * MIN),
] : [];

const DENSE_DRAFTS: DraftSpec[] = VIEW_MODE_RAW === 'dense' ? [
  { id: 'dz-draft1', title: 'Dense draft 1', task: 'x', model: 'sonnet 4.6', projectId: 'dense-zone', createdBy: 'user' },
  { id: 'dz-draft2', title: 'Dense draft 2', task: 'x', model: 'haiku 4.5', projectId: 'dense-zone', createdBy: 'user' },
] : [];

const DENSE_ROUTER_ID = 'dz-router';
const DENSE_ROUTER: RouterSpec | null = VIEW_MODE_RAW === 'dense'
  ? {
      id: DENSE_ROUTER_ID,
      projectId: 'dense-zone',
      branches: [
        { id: 'dz-b1', label: 'Succès', condition: { kind: 'outcome', value: 'success' } },
        { id: 'dz-b2', label: 'Sinon', condition: { kind: 'default' } },
      ],
    }
  : null;

const DENSE_NOTE: NoteData | null = VIEW_MODE_RAW === 'dense' ? { id: 'dz-note', text: 'Dense zone note', projectId: 'dense-zone' } : null;

// 2 pinned nodes, EACH placed exactly on the pixel `assignChildPositions`'
// counter-only grid-slot formula would ALSO hand to a still-auto sibling —
// deliberately reproducing the W10 defect shape (see reconcilerZones.ts's
// `resolveCollisions` fix): with dz-m3/dz-loop pinned, the counter-only
// formula would place dz-m0 at (612,36) [== dz-m3's pin] and dz-m4 at
// (322,302) [== dz-loop's pin] pre-fix.
const DENSE_PINNED_POSITIONS: Record<string, { x: number; y: number }> = VIEW_MODE_RAW === 'dense'
  ? {
      [makeRef('mission', 'dz-m3')]: { x: 612, y: 36 },
      [makeRef('loop', 'dz-loop')]: { x: 322, y: 302 },
    }
  : {};

const ALL_MISSIONS: MissionFixture[] = [...GAMEON_MISSIONS, ...SITE_WEB_MISSIONS, ...TRAINING_API_MISSIONS, ...DENSE_ZONE_MISSIONS];

// fix/canvas-legibility — `idle-zone` is seeded UNCONDITIONALLY (every
// view mode, not gated behind a dedicated `?view=`): the fleet-10pct
// aggregate-tier screenshot needs at least one genuinely idle zone
// alongside the busy ones to visually PROVE the unified chrome fix (every
// zone — idle or busy — now shares the same bordered card, never a
// near-invisible ghost label). Zero missions, deliberately.
const PROJECT_ORDER =
  VIEW_MODE_RAW === 'dense'
    ? ['gameon-mobile', 'site-web', 'training-api', 'dense-zone', 'idle-zone']
    : ['gameon-mobile', 'site-web', 'training-api', 'idle-zone'];
const PROJECT_NAMES: Record<string, string> = {
  'gameon-mobile': 'gameon-mobile',
  'site-web': 'site-web',
  'training-api': 'training-api',
  'dense-zone': 'dense-zone',
  'idle-zone': 'idle-zone-nothing-running',
};
const PROJECT_ROOTS: Record<string, string> = {
  'gameon-mobile': '/fixtures/gameon-mobile',
  'site-web': '/fixtures/site-web',
  'training-api': '/fixtures/training-api',
  'dense-zone': '/fixtures/dense-zone',
  'idle-zone': '/fixtures/idle-zone',
};

/** Pretend "gameon-mobile" is the active project (see Cockpit.tsx's
 *  activeProjectRootOverride doc comment) — proves real card-click/urgent-
 *  action wiring for that one zone without a live Tauri backend. */
const ACTIVE_ROOT = PROJECT_ROOTS['gameon-mobile'];

// ── R7 living surfaces (?view=living ONLY) — one expanded mission live
// panel, one REAL terminal node, one preview node pointed at the harness's
// OWN vite dev server (a genuine living preview, not a screenshot-of-a-
// screenshot — see the `living` ViewModeEffects branch below, which fetches
// it for real through PreviewNode's own reachability probe). Terminal cwd is
// the same project root every other gameon-mobile fixture uses; its
// PTY is the app's REAL platform abstraction (getPlatform().terminal.spawn) —
// under Tauri a real portable-pty, in this browser harness WebPlatform's
// existing in-memory mock shell (the same one TerminalsSpace.tsx/
// TerminalStrip.tsx already rely on for their own web-preview story — not a
// fake stream invented for this feature).
const LIVING_MISSION_ID = 'gm-code-payment'; // real GAMEON fixture: running, liveAction, progress, diff — see GAMEON_MISSIONS above
const LIVING_TERMINAL_ID = 'living-terminal';
const LIVING_PREVIEW_ID = 'living-preview';

const LIVING_SURFACES: SurfaceSpec[] = VIEW_MODE_RAW === 'living'
  ? [
      {
        id: LIVING_TERMINAL_ID,
        kind: 'terminal',
        projectId: 'gameon-mobile',
        cwd: PROJECT_ROOTS['gameon-mobile'],
        ownerRef: makeRef('mission', LIVING_MISSION_ID),
      },
      {
        id: LIVING_PREVIEW_ID,
        kind: 'preview',
        projectId: 'gameon-mobile',
        // The harness page itself IS a vite dev server response — previewing
        // its own origin is a real, reachable http://localhost:* URL, no
        // guessing at a port.
        url: typeof window !== 'undefined' ? window.location.origin : undefined,
      },
    ]
  : [];

// Positioned well clear of PINNED_POSITIONS' own gameon-mobile cluster below
// (which already occupies x:32-1160 across several y-bands) — two pinned
// siblings landing on the same pixel is only "allowed" by the no-overlap
// invariant (both user-pinned), never something this fixture wants to
// actually LOOK like in a screenshot.
const LIVING_PINNED_POSITIONS: Record<string, { x: number; y: number }> = VIEW_MODE_RAW === 'living'
  ? {
      // Expanded live panel (520x420) — see LIVE_PANEL_SIZE seeded below.
      [makeRef('mission', LIVING_MISSION_ID)]: { x: 1600, y: 56 },
      // To its right — default terminal footprint (560x360).
      [makeRef('terminal', LIVING_TERMINAL_ID)]: { x: 2160, y: 56 },
      // Below the terminal — default preview footprint (520x400).
      [makeRef('preview', LIVING_PREVIEW_ID)]: { x: 2160, y: 456 },
    }
  : {};

/**
 * Best-effort REAL timeline/plan data for the living-panel demo: seeds
 * `platform.missions.load()`'s OWN storage key (localStorage 'lazy:missions'
 * in web mode — see src/lib/platform/web.ts's `webMissions`) with a real
 * `Mission` the agentsStore.tsx boot effect loads through its normal
 * (unmodified) persistence path — never a mock branch added to app code, and
 * never editing agentsStore.tsx itself. If this seam ever changes upstream,
 * MissionNode.tsx's own honest "fullMission" degradation (see
 * LiveMissionPanel.tsx's header) still applies: the panel simply shows its
 * standard "no plan/timeline available here" fallback instead of erroring.
 * A non-running status (avoids the boot effect's own stale-running-mission
 * recovery rewrite, keeping this fixture's authored content verbatim).
 */
function seedLivingMissionLocalStorage(): void {
  if (typeof localStorage === 'undefined') return;
  const livingMission: Partial<Mission> = {
    id: LIVING_MISSION_ID,
    title: 'payment-flow-stripe',
    status: 'review',
    model: 'sonnet 4.6',
    planSteps: [
      { label: 'Concevoir PaymentSheet', state: 'done' },
      { label: 'Brancher Stripe Elements', state: 'done' },
      { label: 'Écrire les tests de paiement', state: 'in_progress' },
      { label: 'Revue de sécurité', state: 'todo' },
    ],
    actionTimeline: Array.from({ length: 14 }, (_, i) => ({
      time: `12:${String(i).padStart(2, '0')}`,
      text: i === 13 ? 'Observation: 12 tests passés, 0 échec' : `[${i + 1}] write_file: {"path":"src/PaymentSheet.tsx"}`,
    })),
  };
  try {
    localStorage.setItem('lazy:missions', JSON.stringify([livingMission]));
  } catch {
    // best-effort only — see this function's doc comment
  }
}

// W-MODES-ui self-audit fixture — one project per approval mode (spec
// deliverable #5: "one project auto_green, one full_auto, one manual"),
// seeded directly onto the FleetProject fixture (this harness feeds
// Cockpit's `fleetOverride` prop verbatim, bypassing useFleetMissions'
// real approvalMode.ts lookup entirely — the honest match for what this
// seam actually accepts, same rationale as every other fixture in this
// file). Assigned unconditionally (every view mode, not gated behind a
// dedicated ?view=) since the badge is purely additive chrome — proves the
// three modes are simultaneously distinguishable in the default fit-all
// screenshot AND at the pre-existing `fleet-10pct` aggregate-zoom mode.
const PROJECT_APPROVAL_MODES: Record<string, 'manual' | 'auto_green' | 'full_auto'> = {
  'gameon-mobile': 'auto_green',
  'site-web': 'full_auto',
  'training-api': 'manual',
};

const FIXTURE_PROJECTS: FleetProject[] = PROJECT_ORDER.map((projectId) => ({
  projectId,
  root: PROJECT_ROOTS[projectId]!,
  name: PROJECT_NAMES[projectId]!,
  missions: ALL_MISSIONS.filter((m) => m.projectId === projectId),
  approvalMode: PROJECT_APPROVAL_MODES[projectId],
}));

const FLEET_OVERRIDE: UseFleetMissionsResult = { projects: FIXTURE_PROJECTS, loading: false, error: null };

const MISSION_BY_ID = new Map<string, Mission>(
  ALL_MISSIONS.map((m) => [
    m.id,
    { id: m.id, title: m.title, status: m.status, model: m.model, liveAction: m.liveAction, progress: m.progress, statusReason: m.statusReason, judgeVerdict: m.judgeVerdict } as Mission,
  ]),
);

/** Mirrors CanvasView.tsx's own `computedMissionLoopMeta` useMemo exactly
 *  (same 4-field emptiness check, same shape) — see canvas-harness.tsx's
 *  module header for why this needs to be an override at all. */
function buildMissionLoopMeta(missions: readonly FleetMission[]): ReadonlyMap<string, MissionLoopMeta> {
  const map = new Map<string, MissionLoopMeta>();
  for (const m of missions) {
    if (m.loopConfig === undefined && m.loopParentId === undefined && m.parentMissionId === undefined && m.loopIteration === undefined) continue;
    map.set(m.id, { loopConfig: m.loopConfig, loopParentId: m.loopParentId, loopIteration: m.loopIteration, parentMissionId: m.parentMissionId });
  }
  return map;
}

const MISSION_LOOP_META_OVERRIDE = buildMissionLoopMeta(ALL_MISSIONS);

// ── Scheduled agent fixture (spec §4.2 ScheduleNodeData) — the ONLY way to
//    get a schedule node onto a fixture-driven render, see module header. ──

const SCHEDULED_OVERRIDE: ScheduleNodeData[] = [
  {
    scheduleId: 'sched-nightly-lint',
    agentName: 'Nightly Lint',
    cron: '0 3 * * *',
    cronLabel: formatCron('0 3 * * *'),
    enabled: true,
    projectId: 'gameon-mobile',
  },
];

// ── Canvas-owned fixtures (drafts/chains/notes) — seeded straight into
//    canvasStoreVanilla BEFORE first render, see module header for why
//    that's safe on this harness (hydrate() never fires). ─────────────────

const DRAFTS: DraftSpec[] = [
  { id: 'draft-e2e-tester', title: 'Testeur e2e', task: 'Écrit et exécute une suite Playwright pour le flux onboarding.', model: 'sonnet 4.6', projectId: 'gameon-mobile', createdBy: 'user' },
  { id: 'draft-pricing-refonte', title: 'Refonte pricing', task: 'Repense la page pricing (3 paliers, essai gratuit).', model: 'haiku 4.5', projectId: 'site-web', createdBy: 'manager' },
  // W10 — router branch targets (see ROUTER_SPEC below): two drafts, kept
  // separate from the two drafts above so the router's 3 labeled outgoing
  // edges each land on a visually distinct destination (spec: "wired
  // mission→router→2 drafts + 1 mission").
  { id: 'draft-router-release-notify', title: 'Notifier succès release', task: 'Poste un message #releases avec le changelog et le lien store.', model: 'haiku 4.5', projectId: 'gameon-mobile', createdBy: 'manager' },
  { id: 'draft-router-incident', title: 'Ouvrir ticket incident', task: "Crée un ticket incident avec le message d'erreur et les logs joints.", model: 'sonnet 4.6', projectId: 'gameon-mobile', createdBy: 'manager' },
  // W-CLOSE row 6 (single-node re-run in isolation) — a real isolated draft,
  // visually distinguished by its "Isolé :" title prefix (CanvasContextMenu
  // .tsx's duplicateAsDraft), proving the feature renders cleanly in every
  // view mode (this array is seeded unconditionally, not behind a ?view=).
  { id: 'draft-isolated-demo', title: 'Isolé : Vérifier le flux paiement', task: 'Relance le flux paiement seul, sans déclencher les chaînes en aval.', model: 'sonnet 4.6', projectId: 'gameon-mobile', createdBy: 'user', isolated: true },
];

// W-CLOSE row 2 (Canvas Groups / frames, n8n parity) — a real frame fixture,
// seeded unconditionally (every view mode) alongside the drafts above.
// Deliberately NOT given a pinned position — canvasStore/reconcilerZones'
// honest v1 fallback ({x: ZONE_PADDING, y: ZONE_HEADER_HEIGHT}) is exactly
// what a hand-edited/legacy layout.json would also resolve to, and doubles
// as a visual proof that a frame renders BEHIND whatever real node happens
// to share that corner (its negative zIndex), never reflowing it.
const FRAME_SPEC: FrameSpec = { id: 'frame-site-web-demo', projectId: 'site-web', title: 'Refonte pricing', width: 420, height: 260 };

// W10 — N-way router fixture (spec W8c deliverable #3): a chain feeds INTO
// the router from a real mission, then 3 ordered branches (outcome-success /
// contains / default) each fan out to their own target — 2 drafts + 1 queued
// mission, proving the full "wired mission→router→2 drafts+1 mission" shape
// AND that branch labels render on their own edges (ChainEdge.tsx's
// `data.branchLabel`). Positions are PINNED (see PINNED_POSITIONS below)
// into one tight cluster, independent of the router's/targets' natural
// auto-layout slot, purely so a fixture-driven multi-select + "zoom to
// selection" screenshot (see the `router` ?view= mode) can frame all 5
// nodes + their labeled edges together at a legible zoom — same rationale
// as the OTHER pre-existing pinned nodes (module header: "a stable,
// readable composition").
const ROUTER_ID = 'router-release-gate';

const ROUTER_SPEC: RouterSpec = {
  id: ROUTER_ID,
  projectId: 'gameon-mobile',
  branches: [
    { id: 'branch-success', label: 'Succès', condition: { kind: 'outcome', value: 'success' } },
    { id: 'branch-contains', label: 'Contient « erreur »', condition: { kind: 'contains', value: 'erreur' } },
    { id: 'branch-default', label: 'Sinon', condition: { kind: 'default' } },
  ],
};

const CHAINS: Chain[] = [
  // mission -> draft, condition success, ALSO the "firing" demo (lastFiredAtMs
  // 1s ago — well inside reconciler.ts's FIRING_WINDOW_MS 4s window).
  {
    id: 'chain-code-payment-to-draft',
    sourceRef: makeRef('mission', 'gm-code-payment'),
    targetRef: makeRef('draft', 'draft-e2e-tester'),
    condition: 'success',
    createdBy: 'user',
    lastFiredAtMs: NOW - 1_000,
  },
  // loop -> draft, condition always.
  {
    id: 'chain-loop-to-draft',
    sourceRef: makeRef('loop', 'gm-loop-nightly-tests'),
    targetRef: makeRef('draft', 'draft-pricing-refonte'),
    condition: 'always',
    createdBy: 'manager',
  },
  // Tombstone: sourceRef points at a mission id that was never rendered
  // (deleted/never existed) — reconciler.ts's buildChainEdges flags this
  // `tombstone: true` automatically from `renderedIds`, no seam needed.
  {
    id: 'chain-tombstone',
    sourceRef: makeRef('mission', 'ghost-mission-deleted'),
    targetRef: makeRef('draft', 'draft-e2e-tester'),
    condition: 'always',
    createdBy: 'user',
  },
  // W10 — pinned-output demo (spec W8c deliverable #1): a mission-sourced
  // chain whose `pinnedContext` is frozen — drives ChainEdge's pin badge
  // (`chain-edge-pin-<id>`) on this edge's label AND MissionNode/StageRail's
  // pin dot (`stage-rail-pin-dot`) on the SOURCE mission's rail. Source is a
  // already-`done`/merged mission (avatar-upload-s3) — the honest state a
  // real pin is captured from (canvasTypes.ts's `pinnedContext` doc comment:
  // "captured once the source reaches a terminal-success state").
  {
    id: 'chain-avatar-pinned',
    sourceRef: makeRef('mission', 'gm-merged-avatar-upload'),
    targetRef: makeRef('draft', 'draft-e2e-tester'),
    condition: 'success',
    createdBy: 'user',
    pinnedContext: {
      text: 'Upload avatar S3 terminé — clé s3://gameon-assets/avatars/{userId}.png, 2 Mo max validés, thumbnail générée.',
      pinnedAtMs: NOW - 5 * MIN,
      sourceTitle: 'avatar-upload-s3',
    },
  },
  // W10 — router wiring: mission -> router (incoming), then each of the 3
  // branches -> its own target (2 drafts + 1 queued mission).
  {
    id: 'chain-anticheat-to-router',
    sourceRef: makeRef('mission', 'gm-test-anticheat'),
    targetRef: makeRef('router', ROUTER_ID),
    condition: 'success',
    createdBy: 'user',
  },
  {
    id: 'chain-router-success',
    sourceRef: makeRef('router', `${ROUTER_ID}:branch-success`),
    targetRef: makeRef('draft', 'draft-router-release-notify'),
    condition: 'always',
    createdBy: 'manager',
  },
  {
    id: 'chain-router-contains',
    sourceRef: makeRef('router', `${ROUTER_ID}:branch-contains`),
    targetRef: makeRef('draft', 'draft-router-incident'),
    condition: 'always',
    createdBy: 'manager',
  },
  {
    id: 'chain-router-default',
    sourceRef: makeRef('router', `${ROUTER_ID}:branch-default`),
    targetRef: makeRef('mission', 'gm-plan-onboarding'),
    condition: 'always',
    createdBy: 'manager',
  },
];

// W-BYO nit (a) — text carries real Markdown constructs (bold/italic/list/
// link) so the harness screenshot actually exercises noteMarkdown.tsx's
// renderer, not just plain text that happens to render the same either way.
const NOTE: NoteData = {
  id: 'note-budget-reminder',
  text: '**Rappel** : *vérifier* le budget avant la prochaine vague.\n- relire le [dashboard coûts](https://example.com/costs)\n- valider avec l’équipe',
  projectId: 'gameon-mobile',
};

// A few pinned positions for a stable, readable composition — every other
// node is left to the reconciler's auto-placement (spec §6: "an existing
// entry in `positions` is NEVER changed").
const PINNED_POSITIONS: Record<string, { x: number; y: number }> = {
  [makeRef('mission', 'gm-permission-anticheat-auth')]: { x: 32, y: 56 },
  [makeRef('loop', 'gm-loop-nightly-tests')]: { x: 292, y: 56 },
  [makeRef('mission', 'gm-orch-release-prep')]: { x: 552, y: 56 },
  [makeRef('draft', 'draft-e2e-tester')]: { x: 32, y: 212 },
  // W10 — router cluster (see ROUTER_SPEC/CHAINS above): 5 nodes pinned
  // tightly together so the `router` ?view= mode's multi-select + "zoom to
  // selection" frames the whole wiring (mission -> router -> 3 branches) at
  // a legible zoom, independent of where auto-layout would otherwise
  // scatter them across the zone's stage-ordered grid.
  [makeRef('mission', 'gm-test-anticheat')]: { x: 32, y: 480 },
  [makeRef('router', ROUTER_ID)]: { x: 372, y: 480 },
  [makeRef('draft', 'draft-router-release-notify')]: { x: 560, y: 420 },
  [makeRef('draft', 'draft-router-incident')]: { x: 560, y: 590 },
  [makeRef('mission', 'gm-plan-onboarding')]: { x: 900, y: 480 },
  // W10 — pinned-output demo (see CHAINS' `chain-avatar-pinned`): placed far
  // right of the router cluster and every auto-placed grid cell, to avoid
  // the reconciler's own auto-layout grid (which does not reserve cells
  // around arbitrary pinned coordinates — observed directly: y:840 still
  // collided with an auto-placed sibling in an earlier `pinned-output`
  // screenshot).
  [makeRef('mission', 'gm-merged-avatar-upload')]: { x: 1400, y: 900 },
  ...DENSE_PINNED_POSITIONS,
  ...LIVING_PINNED_POSITIONS,
};

// ── ?view= mode switch ────────────────────────────────────────────────

type ViewMode =
  | 'default'
  | 'lanes'
  | 'zoomed-out'
  | 'fleet-10pct'
  | 'zoomed-in'
  | 'compact-zoom'
  | 'search'
  | 'merged-hidden'
  | 'folded'
  | 'loop-expanded'
  | 'dryrun'
  | 'review-gate'
  | 'router'
  | 'pinned-output'
  | 'dense'
  | 'living'
  | 'macros'
  | 'approval-badges';

const VIEW_MODES: readonly ViewMode[] = [
  'lanes',
  'zoomed-out',
  'fleet-10pct',
  'zoomed-in',
  'compact-zoom',
  'search',
  'merged-hidden',
  'folded',
  'loop-expanded',
  'dryrun',
  'review-gate',
  'router',
  'pinned-output',
  'dense',
  'living',
  'macros',
  // W-PROVE — deferred UI proof for the approval-mode zone-header badge
  // (3b9fb3a's ApprovalModeBadge.tsx): the fit-all default mount (~34%,
  // see this file's own header) is too small to read the badge's 10px
  // text. See this mode's own ViewModeEffects branch below for how it gets
  // both PROJECT_APPROVAL_MODES zones AND a readable zoom in one shot.
  'approval-badges',
];

function getViewMode(): ViewMode {
  const v = new URLSearchParams(window.location.search).get('view');
  return (VIEW_MODES as readonly string[]).includes(v ?? '') ? (v as ViewMode) : 'default';
}

const VIEW_MODE = getViewMode();

// ── Seed canvasStoreVanilla (module load, before first render) ──────────

canvasStoreVanilla.getState().setPositions(PINNED_POSITIONS);
for (const draft of DRAFTS) canvasStoreVanilla.getState().addDraft(draft);
for (const chain of CHAINS) canvasStoreVanilla.getState().addChain(chain);
canvasStoreVanilla.getState().addNote(NOTE);
canvasStoreVanilla.getState().addRouter(ROUTER_SPEC);
// W-CLOSE row 2 (Canvas Groups / frames) — see FRAME_SPEC's own doc comment.
canvasStoreVanilla.getState().addFrame(FRAME_SPEC);
// canvas-parity-close — group macros + draft version history fixtures.
// One saved macro (visible in the palette's "Macros" section) + one draft
// edited 3 times through the REAL `updateDraft` store action (its own
// auto-versioning, not a hand-crafted history shape) so its « Versions »
// dropdown shows 3 real snapshots.
const MACRO_VERSIONS_DRAFT_ID = 'draft-macro-versions-demo';
canvasStoreVanilla.getState().addDraft({
  id: MACRO_VERSIONS_DRAFT_ID,
  title: 'Stabiliser le test checkout',
  task: 'Le test e2e checkout est flaky en CI.',
  model: 'sonnet 4.6',
  projectId: 'gameon-mobile',
  createdBy: 'user',
});
canvasStoreVanilla.getState().updateDraft(MACRO_VERSIONS_DRAFT_ID, {
  title: 'Stabiliser le test checkout (retry)',
  task: 'Ajoute un retry sur le clic paiement avant de conclure à un échec.',
});
canvasStoreVanilla.getState().updateDraft(MACRO_VERSIONS_DRAFT_ID, {
  title: 'Stabiliser le test checkout (wait explicite)',
  task: "Ajoute un wait explicite sur le spinner de confirmation avant l'assertion.",
});
canvasStoreVanilla.getState().updateDraft(MACRO_VERSIONS_DRAFT_ID, {
  title: 'Stabiliser le test checkout (waitFor natif)',
  task: 'Remplace le retry manuel par un waitFor natif Playwright sur le récépissé.',
});
canvasStoreVanilla.getState().addMacro({
  id: 'macro-tester-reviewer-demo',
  name: 'Testeur + reviewer',
  description: 'Chaîne un testeur puis un reviewer après une mission.',
  drafts: [
    { id: 'macro-demo-tester', title: 'Testeur', task: 'Lance la suite de tests.', createdBy: 'user' },
    { id: 'macro-demo-reviewer', title: 'Reviewer', task: 'Relit le diff produit.', createdBy: 'user' },
  ],
  routers: [],
  notes: [],
  chains: [
    {
      id: 'macro-demo-chain',
      sourceRef: makeRef('draft', 'macro-demo-tester'),
      targetRef: makeRef('draft', 'macro-demo-reviewer'),
      condition: 'success',
      createdBy: 'user',
    },
  ],
  positions: {
    [makeRef('draft', 'macro-demo-tester')]: { x: 0, y: 0 },
    [makeRef('draft', 'macro-demo-reviewer')]: { x: 260, y: 0 },
  },
  createdAtMs: NOW - 2 * HOUR,
});
if (VIEW_MODE === 'lanes') canvasStoreVanilla.getState().setPrefs({ laneMode: true });
if (VIEW_MODE === 'merged-hidden') canvasStoreVanilla.getState().setPrefs({ hideMerged: true });
// W10 — orchestrator subtree fold (spec W8a deliverable #2): folds
// gm-orch-release-prep's 2 sub-missions into its own chip-stack badge.
if (VIEW_MODE === 'folded') canvasStoreVanilla.getState().setPrefs({ foldedOrchestrators: { 'gm-orch-release-prep': true } });
// W10 — loop expand-in-place (spec W8a deliverable #2): projects
// gm-loop-nightly-tests' last-3 iterations as real IterationNode children.
if (VIEW_MODE === 'loop-expanded') canvasStoreVanilla.getState().setPrefs({ expandedLoops: { 'gm-loop-nightly-tests': true } });
// fix/canvas-ux R4a — dense-zone stress fixture (see DENSE_* consts above):
// 2 drafts + 1 note + 1 router seeded into canvasStoreVanilla exactly like
// every other fixture draft/note/router, PLUS dz-loop expanded in-place —
// the harness-side half of the adversarial no-overlap proof.
if (VIEW_MODE === 'dense') {
  for (const draft of DENSE_DRAFTS) canvasStoreVanilla.getState().addDraft(draft);
  if (DENSE_NOTE) canvasStoreVanilla.getState().addNote(DENSE_NOTE);
  if (DENSE_ROUTER) canvasStoreVanilla.getState().addRouter(DENSE_ROUTER);
  canvasStoreVanilla.getState().setPrefs({ expandedLoops: { 'dz-loop': true } });
}
// fix/canvas-ux R7 — living surfaces (see LIVING_* consts above): expands
// LIVING_MISSION_ID's live panel, seeds the terminal/preview surfaces (both
// already positioned via LIVING_PINNED_POSITIONS, merged into
// PINNED_POSITIONS above), and best-effort seeds real actionTimeline/
// planSteps data through the app's OWN missions-persistence seam.
if (VIEW_MODE === 'living') {
  canvasStoreVanilla.getState().setExpandedPanel(makeRef('mission', LIVING_MISSION_ID), LIVE_PANEL_SIZE);
  for (const surface of LIVING_SURFACES) canvasStoreVanilla.getState().addSurface(surface);
  seedLivingMissionLocalStorage();
}
// W-PROVE — approval-badges: collapse all 3 real project zones (each keeps
// EXACTLY the same `project-node-approval-mode-badge` testid its expanded
// header uses — ProjectGroupNode.tsx's collapsed-pill branch renders the
// identical <ApprovalModeBadge>, only the surrounding chrome differs) so
// their combined footprint shrinks from "3 full zones of mission cards"
// down to 3 small pills. Fitting the WHOLE expanded zones into one frame at
// ~1.0 zoom is not achievable (gameon-mobile alone has ~15 mission cards —
// its own bounding box is roughly what fit-all already had to accommodate);
// collapsing first is what actually gets a "zone header with its badge" to
// a legible, comparable size — see the `approval-badges` ViewModeEffects
// branch below for the post-mount select+zoom that completes this.
if (VIEW_MODE === 'approval-badges') {
  for (const projectId of ['gameon-mobile', 'site-web', 'training-api']) {
    canvasStoreVanilla.getState().toggleCollapsed(projectId);
  }
}

// ── Post-mount DOM interactions for zoomed-out/zoomed-in/search — see
//    module header for why these can't just be a pre-render store seed. ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentZoomPct(): number | null {
  const el = document.querySelector('[data-testid="canvas-toolbar-zoom-pct"]');
  const match = el?.textContent ? /(\d+)%/.exec(el.textContent) : null;
  return match ? Number(match[1]) : null;
}

/**
 * W6b geometry fix wave note: this used to return the INSTANT the target
 * was first reached — harmless before that wave's geometry fix, but not
 * after: bigger real card/zone footprints (spec CRITICAL 2/3) mean
 * CanvasView's own delayed effects (e.g. a Focus-pannes fitView firing
 * once its `matched` node set settles) can land AFTER this loop's early
 * return and silently re-fit the viewport back toward its ORIGINAL zoom —
 * observed directly: zoom would reach the target within ~5 clicks, then
 * jump back up ~600-900ms later with nothing left to correct it. Fixed by
 * requiring the target to hold for several consecutive checks (not just
 * one instant) before declaring success, re-clicking if it ever drifts
 * back out of range in the meantime — rides out exactly that kind of
 * one-shot delayed re-fit instead of racing it.
 */
async function clickZoomUntil(direction: 'in' | 'out', targetPct: number, maxClicks = 40): Promise<void> {
  const testId = direction === 'in' ? 'canvas-toolbar-zoom-in' : 'canvas-toolbar-zoom-out';
  const SETTLE_CHECKS = 5;
  let settledCount = 0;
  for (let i = 0; i < maxClicks; i += 1) {
    const pct = currentZoomPct();
    const reached = pct !== null && (direction === 'out' ? pct <= targetPct : pct >= targetPct);
    if (reached) {
      settledCount += 1;
      if (settledCount >= SETTLE_CHECKS) return;
    } else {
      settledCount = 0;
      document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
    }
    await sleep(120);
  }
}

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function typeSearch(term: string, maxTries = 30): Promise<void> {
  for (let i = 0; i < maxTries; i += 1) {
    const input = document.querySelector<HTMLInputElement>('[data-testid="canvas-toolbar-search"]');
    if (input) {
      setNativeInputValue(input, term);
      return;
    }
    await sleep(80);
  }
}

/**
 * A node's data-testid depends on the LIVE semantic zoom bucket
 * (useZoomLevel.ts): at the fit-all mount zoom (observed ~34%, below
 * ZOOM_DOT's 0.45) every node kind renders its terse `<kind>-node-dot-<id>`
 * variant instead of `<kind>-node-<id>` (see e.g. MissionNode.tsx's
 * `zoomLevel === 'dot'` early return). Both variants are plain, unblocked
 * divs (no `nodrag`, no stopPropagation) so clicking EITHER one selects the
 * underlying React Flow node identically — selection is a property of the
 * node, not of which visual bucket happens to be mounted. This tries the
 * dot id first (the id that's actually present at mount, so no wasted
 * retry budget), falling back to the full id for a node that's already
 * past the threshold (e.g. re-clicked after a prior zoom-in).
 */
type NodeKind = 'mission' | 'draft' | 'router' | 'loop';

function candidateTestIds(kind: NodeKind, id: string): readonly string[] {
  return [`${kind}-node-dot-${id}`, `${kind}-node-${id}`];
}

/**
 * W10 — clicks a React Flow node card by its `data-testid` (trying the dot
 * variant first — see `candidateTestIds`), waiting for it to exist first
 * (pinned nodes only appear once the reconciler's first pass has run).
 * `ctrl: true` extends the selection rather than replacing it — but NOT via
 * the click event's own `ctrlKey` property: React Flow reads
 * `multiSelectionActive` from its OWN internal `useKeyPress(multiSelection
 * KeyCode)` hook, a stateful window-level keydown/keyup tracker completely
 * independent of any single click event's modifier flags (confirmed by
 * reading @xyflow/react's own source — `FlowRenderer`'s
 * `multiSelectionKeyPressed` -> `store.setState({ multiSelectionActive })`).
 * So this dispatches a REAL `keydown`/`keyup` pair around the click (default
 * `multiSelectionKeyCode` is `'Control'` on non-macOS, which is what a
 * headless-Chromium `navigator.platform` reports) — the same technique
 * `clickZoomUntil`/`typeSearch` already use elsewhere in this file: drive
 * the REAL control surface, never a mock branch. Never throws — a missing
 * node just no-ops, same "best-effort DOM interaction" convention as
 * `clickZoomUntil`.
 */
async function clickNode(candidates: readonly string[], opts: { ctrl?: boolean } = {}, maxTries = 30): Promise<boolean> {
  for (let i = 0; i < maxTries; i += 1) {
    for (const testId of candidates) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (el) {
        if (opts.ctrl) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }));
          await sleep(60); // let React commit useKeyPress's state -> FlowRenderer's multiSelectionActive effect before the click
        }
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: !!opts.ctrl, view: window }));
        if (opts.ctrl) {
          await sleep(30);
          window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
        }
        return true;
      }
    }
    await sleep(80);
  }
  return false;
}

/** W10 — selects one or more nodes (first plain-clicked, the rest
 *  ctrl-clicked to extend the selection — see `clickNode`), then clicks the
 *  real "zoom to selection" toolbar button (CanvasView.tsx's
 *  `handleZoomToSelection` -> `fitView({ nodes: selected })`) so the
 *  screenshot frames exactly that node set at a legible zoom, independent
 *  of where the overall fit-all viewport happens to center (observed
 *  directly: fit-all's centroid across 3 project zones does NOT reliably
 *  land on any one curated node — see this file's `router`/`review-gate`
 *  mode doc comments below for the concrete cases this fixes). */
async function selectAndZoom(nodes: ReadonlyArray<{ kind: NodeKind; id: string }>): Promise<void> {
  for (let i = 0; i < nodes.length; i += 1) {
    await clickNode(candidateTestIds(nodes[i].kind, nodes[i].id), { ctrl: i > 0 });
    await sleep(150);
  }
  await sleep(200);
  document.querySelector<HTMLButtonElement>('[data-testid="canvas-toolbar-zoom-to-selection"]')?.click();
}


function ViewModeEffects({ mode }: { mode: ViewMode }) {
  useEffect(() => {
    if (mode === 'zoomed-out') void clickZoomUntil('out', 35);
    // W-UX3 three-tier fleet view — the AGGREGATE tier at David's own 10%
    // repro zoom (below ZOOM_AGGREGATE 0.18): dots hidden, per-zone
    // constant-size summary chips (name + status counts + equalizer). The
    // mute-screenshot acceptance shot.
    if (mode === 'fleet-10pct') void clickZoomUntil('out', 10);
    if (mode === 'zoomed-in') void clickZoomUntil('in', 118);
    // fix/canvas-ux R6a BLOQUANT #1 — the exact bucket the real dogfood
    // repro landed in (ZOOM_COMPACT=0.85, ZOOM_DOT=0.45; default post-arrange
    // zoom measured ~74-91% in the friction log, this fixture's own fit-all
    // mount is ~34%). Proves the launch affordance survives at BOTH 70% (mid
    // compact bucket) — the ticket's own "0.5 and 0.7 zoom fixtures" ask, 0.5
    // being close enough to 0.45's ZOOM_DOT boundary that 0.7 is the more
    // representative mid-bucket shot.
    if (mode === 'compact-zoom') void clickZoomUntil('in', 70);
    if (mode === 'search') void typeSearch('nightly'); // matches "nightly-regression-suite" + the "Nightly Lint" schedule
    // W10 — orchestrator fold badge at legible zoom: the "N sous-missions"
    // fold badge (MissionNodeCard's `isOrchestrator && folded` branch) only
    // renders inside the `zoomLevel === 'full'`-gated card body — invisible
    // at the fit-all mount zoom (~34%, dot bucket). Zoom to just this one
    // mission so the badge is actually provable, same rationale as
    // `review-gate` below.
    if (mode === 'folded') void selectAndZoom([{ kind: 'mission', id: 'gm-orch-release-prep' }]);
    // W10 — loop expand-in-place at legible zoom: same rationale — the 3
    // real IterationNode mini-cards render regardless of zoom (they're their
    // own node kind, never semantic-zoom-gated — IterationNode.tsx's own
    // header: "always the same small size"), but are illegible as ~4px dots
    // at fit-all. IterationNode's onClick calls `e.stopPropagation()` (it
    // opens the iteration's MissionDetail instead — see that file's header),
    // so it can never be added to a `selectAndZoom` selection the way a
    // mission/draft/router/loop card can. Instead: zoom-to-selection on the
    // LOOP card alone (tight, ~200%), then zoom back OUT a bit while staying
    // centered on that same spot — reveals the iteration stack positioned
    // directly below the loop (reconcilerFold.ts's `iterationExtrasFor`)
    // without losing the loop itself out of frame.
    if (mode === 'loop-expanded') {
      void (async () => {
        await selectAndZoom([{ kind: 'loop', id: 'gm-loop-nightly-tests' }]);
        await sleep(400);
        await clickZoomUntil('out', 100);
      })();
    }
    // W10 — dry-run preview: clicks the real toolbar « Simuler » button
    // (CanvasToolbar.tsx's `data-testid="canvas-toolbar-dry-run"` ->
    // useDryRunPreview's `start()`), which reads the CURRENT React Flow
    // nodes/edges straight from `useReactFlow()` — cheap, no extra fixture
    // seam needed (same rationale as clicking the real zoom/search controls
    // above rather than a mock branch). Also zooms in afterward — the pulse
    // rings/traveling dots (DryRunOverlay.tsx) track LIVE node geometry
    // reactively, so they render correctly at ANY zoom, but are illegible at
    // the fit-all mount zoom (~34%, same dot-bucket legibility problem as
    // `folded`/`loop-expanded` above).
    if (mode === 'dryrun') {
      void (async () => {
        await sleep(300); // let the first reconcile pass settle before reading nodes/edges
        document.querySelector<HTMLButtonElement>('[data-testid="canvas-toolbar-dry-run"]')?.click();
        await sleep(300);
        await clickZoomUntil('in', 90);
      })();
    }
    // W10 — review gate at full zoom: the gm-review-friend-invites rejected-
    // verdict mission (MissionNode.tsx's `mission.status === 'review' &&
    // agentsStore` gate, only rendered at zoomLevel 'full') is NOT guaranteed
    // to fall inside the fit-all viewport at any particular zoom (it has no
    // pinned position, and fit-all's centroid depends on ALL ~22 fixture
    // nodes across 3 project zones). Selecting it alone + "zoom to
    // selection" fits tightly to just that one ~300x210 card, comfortably
    // clearing ZOOM_COMPACT (0.85) regardless of where auto-layout placed it.
    if (mode === 'review-gate') void selectAndZoom([{ kind: 'mission', id: 'gm-review-friend-invites' }]);
    // W10 — router wiring: frames the whole pinned cluster (incoming
    // mission -> router -> 3 labeled branch chains -> 2 drafts + 1 mission,
    // see PINNED_POSITIONS above) together so the branch edge labels
    // (ChainEdge.tsx's `data.branchLabel`) are legible in one shot.
    if (mode === 'router') {
      void selectAndZoom([
        { kind: 'mission', id: 'gm-test-anticheat' },
        { kind: 'router', id: ROUTER_ID },
        { kind: 'draft', id: 'draft-router-release-notify' },
        { kind: 'draft', id: 'draft-router-incident' },
        { kind: 'mission', id: 'gm-plan-onboarding' },
      ]);
    }
    // W10 — pinned output at legible zoom: frames `chain-avatar-pinned`'s
    // source (gm-merged-avatar-upload) + target (draft-e2e-tester) together
    // so the pin badge (ChainEdge.tsx's `chain-edge-pin-<id>` on the edge
    // label) AND the pin dot (StageRail.tsx's `stage-rail-pin-dot` on the
    // SOURCE mission's rail) are both legible in one shot.
    if (mode === 'pinned-output') {
      void selectAndZoom([
        { kind: 'mission', id: 'gm-merged-avatar-upload' },
        { kind: 'draft', id: 'draft-e2e-tester' },
      ]);
    }
    // fix/canvas-ux R4a — dense-zone no-overlap proof: frames the WHOLE
    // dense-zone (corners + the pinned/expanded-loop cluster) at a legible
    // zoom, independent of the 4-project fit-all centroid.
    if (mode === 'dense') {
      void selectAndZoom([
        { kind: 'mission', id: 'dz-m0' },
        { kind: 'mission', id: 'dz-m6' },
        { kind: 'mission', id: 'dz-m3' },
        { kind: 'loop', id: 'dz-loop' },
        { kind: 'router', id: 'dz-router' },
      ]);
    }
    // fix/canvas-ux R7 — frames the expanded live panel + terminal + preview
    // cluster together at a legible zoom. Doesn't go through `selectAndZoom`
    // (that helper's `candidateTestIds`/`NodeKind` only know about
    // mission/draft/router/loop — extending them for 2 new kinds used by
    // exactly one ?view= mode isn't worth widening a shared helper for): the
    // expanded mission's own testid is `live-mission-panel-<id>` (its normal
    // `mission-node-<id>` card is gone while expanded), and the surface
    // nodes' testids (`terminal-node-<id>`/`preview-node-<id>`) are never
    // zoom-gated (see TerminalNode.tsx/PreviewNode.tsx's own headers) — so a
    // bespoke, self-contained click sequence using the SAME real `clickNode`
    // primitive is simpler and safer than growing the shared one.
    if (mode === 'living') {
      void (async () => {
        await clickNode([`live-mission-panel-${LIVING_MISSION_ID}`]);
        await sleep(150);
        await clickNode([`terminal-node-${LIVING_TERMINAL_ID}`], { ctrl: true });
        await sleep(150);
        await clickNode([`preview-node-${LIVING_PREVIEW_ID}`], { ctrl: true });
        await sleep(200);
        document.querySelector<HTMLButtonElement>('[data-testid="canvas-toolbar-zoom-to-selection"]')?.click();
      })();
    }
    // canvas-parity-close — group macros: opens the REAL palette (toolbar
    // toggle, same primitive a human uses) so the "Macros" section's saved
    // demo macro is visible. (The sibling draft-version-history feature's
    // « Versions » dropdown is a full-screen modal overlay that would hide
    // this same palette in one shot — that feature has its own dedicated
    // coverage instead: CanvasDraftVersionsPanel.test.tsx + canvasStore
    // .test.ts's restore-as-new/cap suite.)
    if (mode === 'macros') {
      void (async () => {
        await sleep(300);
        document.querySelector<HTMLButtonElement>('[data-testid="canvas-toolbar-palette-toggle"]')?.click();
      })();
    }
    // W-PROVE — approval-badges: the 3 real zones were already collapsed at
    // module load (see the seed above) — a COLLAPSED zone's children are
    // never emitted by the reconciler, so the mount's own `fitView` (always
    // fires, see this file's own header: "viewportInit.fit is unconditionally
    // true") now fits to 3 tiny fixed-content pills instead of the full
    // mission-card-heavy layout, landing at a MUCH higher natural zoom than
    // the ~34% default fit-all. Deliberately does NOT try to click-select
    // the pills themselves first (unlike every other selectAndZoom-based
    // mode below): a collapsed pill's own onClick IS "re-expand" (Project
    // GroupNode.tsx's collapsed branch binds it to the exact same element
    // clickNode would dispatch on), so clicking it here would silently
    // undo the seed instead of selecting it. clickZoomUntil('in', 100) is
    // a no-op settle-and-confirm once fitView's own zoom already clears
    // 100%, or nudges further in via the same real toolbar button every
    // other zoom-based mode uses if it doesn't. Proves the 3 approval-mode
    // badges (PROJECT_APPROVAL_MODES: gameon-mobile=auto_green, site-
    // web=full_auto, training-api=manual) are simultaneously legible and
    // distinguishable at a readable zoom.
    if (mode === 'approval-badges') {
      void (async () => {
        await sleep(300); // let the first reconcile + fitView settle with all 3 zones collapsed
        await clickZoomUntil('in', 100);
      })();
    }
  }, [mode]);
  return null;
}

// ── Error boundary — surfaces render crashes as visible text (mirrors
//    cockpit-harness.tsx's identical HarnessErrorBoundary). ──────────────

class HarnessErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <pre style={{ color: '#FCA5A5', background: '#1A1A24', padding: 16, whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {this.state.error.stack ?? String(this.state.error)}
        </pre>
      );
    }
    return this.props.children;
  }
}

// ── Harness body — mirrors AgentsSpace.tsx's real Cockpit+drawer glue,
//    same as cockpit-harness.tsx's HarnessBody. ──────────────────────────

function HarnessBody() {
  const { selectedMissionId, setSelectedMissionId } = useAgentsStore();
  const selectedMission = selectedMissionId ? MISSION_BY_ID.get(selectedMissionId) ?? null : null;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', overflow: 'hidden' }}>
      {/* Cockpit's ManagerOverlay registers into managerHostRegistry instead
          of instantiating <LazyManager> directly — see
          managerHostRegistry.tsx. Reproduced here (normally provided once
          by AppShell.tsx) so this harness's Cockpit tree still renders a
          real LazyManager for the screenshot. */}
      <ManagerHostRegistryProvider>
        <Cockpit
          onOpenLibrary={() => { /* no-op — Bibliothèque tab is outside this harness's scope */ }}
          onOpenReport={() => { /* no-op — Rapport overlay is outside this harness's scope */ }}
          fleetOverride={FLEET_OVERRIDE}
          activeProjectRootOverride={ACTIVE_ROOT}
          scheduledOverride={SCHEDULED_OVERRIDE}
          missionLoopMetaOverride={MISSION_LOOP_META_OVERRIDE}
        />
        <ManagerHost activeHostId="cockpit" />
      </ManagerHostRegistryProvider>
      {selectedMission && <MissionDetailDrawer mission={selectedMission} onClose={() => setSelectedMissionId(null)} />}
      <ViewModeEffects mode={VIEW_MODE} />
    </div>
  );
}

function HarnessRoot() {
  const [, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setReady(true);
      document.body.setAttribute('data-harness-ready', 'true');
    }, 400);
    return () => clearTimeout(t);
  }, []);

  return (
    <I18nProvider>
      <ToastProvider>
        <AppProvider>
          <AgentsStoreProvider>
            <HarnessErrorBoundary>
              <HarnessBody />
            </HarnessErrorBoundary>
          </AgentsStoreProvider>
        </AppProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

// ── Bootstrap ─────────────────────────────────────────────────────

import '../index.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<HarnessRoot />);
}
