/**
 * cockpit-harness.tsx — isolated screenshot harness for the Cockpit
 * pixel-fidelity pass (see design-cockpit.md, the fleet cockpit spec).
 *
 * Why this harness exists: useFleetMissions (fleetMissions.ts) always
 * returns an empty project list outside a real Tauri runtime (repo
 * convention — real data or an honest empty state, no mock fleet data in
 * app code), and objectivesStore / agentsStore's manager chat degrade to
 * empty the same way. That means the Cockpit has nothing to render under
 * plain `npm run dev` (no Tauri) — no project rows, no urgent cards, no
 * objectives, no manager chat — so there is no way to visually verify
 * scale/density/zoom against the design's populated prototype.
 *
 * This harness mounts the REAL <Cockpit/> component tree (same styles, i18n,
 * store wiring as production) and feeds it fixture data through the
 * screenshot/test-only override props added to Cockpit.tsx, CapObjectives.tsx
 * and LazyManagerRail.tsx for exactly this purpose — the fixture VALUES live
 * only here, never in app code. Mission-click -> drawer wiring mirrors
 * AgentsSpace.tsx's real glue (agentsStore's selectedMissionId + a lookup),
 * just sourced from the fixture missions instead of agentsStore's own
 * (empty, outside Tauri) mission list.
 */

import { Component, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../app/AppContext';
import { AgentsStoreProvider, useAgentsStore, Cockpit, MissionDetailDrawer } from '../components/agents';
import { ManagerHost } from '../components/lazyManager/ManagerHost';
import { ManagerHostRegistryProvider } from '../components/lazyManager/managerHostRegistry';
import { deriveFleetStage, isUrgentMission } from '../lib/agents/fleetStage';
import { extractPendingQuestionText } from '../lib/agents/missionQuestion';
import type { FleetMission, FleetProject, UseFleetMissionsResult } from '../lib/agents/fleetMissions';
import type { ActionEvent, Mission, ManagerMessage, PlanStep } from '../lib/agents/types';
import type { Objective } from '../lib/objectives/objectivesStore';

// ── Set locale to French before first render (matches the design's copy) ──
try {
  localStorage.setItem('lazy.locale', 'fr');
} catch { /* noop */ }

// ── Mission fixtures — 20 missions across 5 projects, mirrors the design's
//    mock dataset 1:1 in content/spirit (design-cockpit.md §14), translated
//    onto this codebase's REAL Mission/MissionStatus vocabulary (no
//    'blocked'/'run-slow'/'overdue' statuses exist here — a permission-
//    blocked mission is a RUNNING mission with a genuine pending ask_user
//    question, and "overdue" is just an older 'review' mission — see
//    cockpitHelpers.ts's classifyUrgent). ─────────────────────────────────

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const DEFAULT_PLAN: PlanStep[] = [
  { label: 'Explorer et analyser', state: 'done' },
  { label: 'Implémenter', state: 'in_progress' },
  { label: 'Tests + revue + merge', state: 'todo' },
];

interface MissionFixture extends Mission {
  projectId: string;
  updatedMs: number;
}

function fixture(
  projectId: string,
  base: Pick<Mission, 'id' | 'title' | 'status' | 'model'> & Partial<Mission>,
  updatedMs: number = NOW,
): MissionFixture {
  return {
    planSteps: DEFAULT_PLAN,
    actionTimeline: [
      { time: '13:54', text: '🧠 lit contexte brain du projet' },
      { time: '13:58', text: `implémente ${base.title}` },
    ] as ActionEvent[],
    contract: {
      objective: base.title,
      scopePaths: ['src/**'],
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      budgetCapUsd: 5,
      proofs: [],
      gates: { evaluators: true, humanApprove: true },
      shareToTeam: false,
    },
    ...base,
    projectId,
    updatedMs,
  };
}

const MISSION_FIXTURES: MissionFixture[] = [
  // lazysite (10) — the "active" fixture project (see ACTIVE_ROOT below)
  fixture('lazysite', { id: 'seo', title: 'seo-plan-metadonnees', status: 'running', model: 'haiku 4.5', liveAction: 'plan 2/6…', planSteps: [] }),
  fixture('lazysite', { id: 'dark', title: 'dark-mode-tokens', status: 'running', model: 'haiku 4.5', liveAction: 'explore tokens…', planSteps: [] }),
  fixture('lazysite', { id: 'pricing', title: 'pricing-table-v2', status: 'running', model: 'sonnet 4.6', liveAction: '▊ PricingTable.tsx…', progress: 62 }),
  fixture('lazysite', { id: 'checkout', title: 'checkout-stripe-webhooks', status: 'running', model: 'sonnet 4.6', liveAction: '▊ stripe webhooks…', progress: 48 }),
  fixture('lazysite', { id: 'i18n', title: 'i18n-de', status: 'running', model: 'sonnet 4.6', liveAction: '▊ home.json… ~2 min', progress: 71 }),
  fixture('lazysite', { id: 'blog', title: 'blog-cms', status: 'queued', model: 'haiku 4.5', liveAction: 'en file (conflit évité)', planSteps: [] }),
  fixture('lazysite', { id: 'perf', title: 'perf-images', status: 'failed', model: 'sonnet 4.6', liveAction: 'lighthouse 82 < 90', statusReason: 'lighthouse 82 < 90 · retry épuisé', planSteps: DEFAULT_PLAN }, NOW - 41 * MIN),
  fixture('lazysite', { id: 'a11y', title: 'fix-a11y', status: 'running', model: 'sonnet 4.6', liveAction: '12/14 verts…', progress: 84 }),
  fixture('lazysite', { id: 'copy', title: 'copy-marketing', status: 'review', model: 'haiku 4.5', liveAction: '+214 −89 · jugé ✓ risque faible', diffAdded: 214, diffRemoved: 89 }, NOW - 18 * MIN),
  fixture('lazysite', { id: 'news', title: 'newsletter-embed', status: 'done', model: 'sonnet 4.6', liveAction: 'mergé il y a 1 h', merged: true }, NOW - HOUR),

  // gameon (3) — includes the 'permission' urgent kind (running + pending question)
  fixture('gameon', { id: 'tuto', title: 'tuto-onboarding', status: 'running', model: 'haiku 4.5', liveAction: 'plan 3/8…', planSteps: [] }),
  fixture('gameon', {
    id: 'anticheat',
    title: 'anti-cheat-server-auth',
    status: 'running',
    model: 'sonnet 4.6',
    liveAction: '▊ écrit server/auth.rs…',
    actionTimeline: [
      { time: '13:54', text: '🧠 lit contexte brain du projet' },
      { time: '14:01', text: 'Observation: Question for user: write server/auth.rs (nouvelle route) ?' },
    ] as ActionEvent[],
  }, NOW - 2 * MIN),
  fixture('gameon', { id: 'netcode', title: 'netcode-prediction', status: 'running', model: 'sonnet 4.6', liveAction: '▊ prediction.rs… 🧠', progress: 34 }),

  // mobile-app (3) — includes an aged 'review' (design's "overdue" flavor)
  fixture('mobile-app', { id: 'push', title: 'push-notifications-apns', status: 'running', model: 'haiku 4.5', liveAction: 'explore APNs…', planSteps: [] }),
  fixture('mobile-app', { id: 'offline', title: 'offline-sync-queue', status: 'running', model: 'sonnet 4.6', liveAction: '▊ sync queue…', progress: 55 }),
  fixture('mobile-app', { id: 'paiement', title: 'paiement-in-app', status: 'review', model: 'sonnet 4.6', liveAction: '+486 −102 · jugé ✓ risque moyen', diffAdded: 486, diffRemoved: 102 }, NOW - 2 * HOUR),

  // trading-bot (3)
  fixture('trading-bot', { id: 'risk', title: 'risk-engine-rewrite', status: 'queued', model: 'opus 4.5', liveAction: 'en file · opus', planSteps: [] }),
  fixture('trading-bot', { id: 'signal', title: 'signal-backfill-ohlc', status: 'running', model: 'sonnet 4.6', liveAction: '▊ backfill OHLC…', progress: 40 }),
  fixture('trading-bot', { id: 'alert', title: 'alert-webhooks', status: 'done', model: 'sonnet 4.6', liveAction: 'M20 · mergé', merged: true }, NOW - 41 * MIN),

  // docs-site (1)
  fixture('docs-site', { id: 'docs1', title: 'docs-search-index', status: 'done', model: 'haiku 4.5', liveAction: 'mergé il y a 2 j', merged: true }, NOW - 2 * DAY),
];

const PROJECT_ORDER = ['lazysite', 'gameon', 'mobile-app', 'trading-bot', 'docs-site'];
const PROJECT_ROOTS: Record<string, string> = {
  lazysite: '/fixtures/lazysite',
  gameon: '/fixtures/gameon',
  'mobile-app': '/fixtures/mobile-app',
  'trading-bot': '/fixtures/trading-bot',
  'docs-site': '/fixtures/docs-site',
};

/** Pretend "lazysite" is the currently active project (see Cockpit.tsx's
 *  activeProjectRootOverride) — lets the harness prove real card-click and
 *  urgent-action wiring for at least one fixture project without a live
 *  Tauri backend (see that prop's doc comment for why every OTHER project's
 *  actions still swallow into a no-op "switch project first" path). */
const ACTIVE_ROOT = PROJECT_ROOTS.lazysite;

function toFleetMission(m: MissionFixture): FleetMission {
  return {
    id: m.id,
    title: m.title,
    status: m.status,
    stage: deriveFleetStage(m),
    liveAction: m.liveAction,
    model: m.model,
    progress: m.progress,
    worktree: m.worktree,
    diffAdded: m.diffAdded,
    diffRemoved: m.diffRemoved,
    updatedMs: m.updatedMs,
    urgent: isUrgentMission(m),
    diffFiles: m.diffFiles,
    statusReason: m.statusReason,
    pendingQuestion: m.status === 'running' ? extractPendingQuestionText(m) ?? undefined : undefined,
    contractScopePaths: m.contract?.scopePaths,
  };
}

const FIXTURE_PROJECTS: FleetProject[] = PROJECT_ORDER.map((projectId) => ({
  projectId,
  root: PROJECT_ROOTS[projectId],
  name: projectId,
  missions: MISSION_FIXTURES.filter((m) => m.projectId === projectId).map(toFleetMission),
}));

const FLEET_OVERRIDE: UseFleetMissionsResult = { projects: FIXTURE_PROJECTS, loading: false, error: null };

const MISSION_BY_ID = new Map<string, Mission>(MISSION_FIXTURES.map((m) => [m.id, m]));

// ── Objective fixtures — 3 objectives matching design-cockpit.md §6's mock
//    (on-track / late / no-deadline, derived the same way the real
//    deriveObjectiveStatus pacing logic would from these dates/counts). ──

const OBJECTIVE_FIXTURES: Objective[] = [
  {
    id: 'obj-v2-lazysite',
    title: 'v2 lazysite en prod',
    createdAtMs: NOW - 7 * DAY,
    deadlineMs: NOW + 1 * DAY,
    targetCount: 9,
    currentCount: 7,
    projectId: 'lazysite',
  },
  {
    id: 'obj-beta-gameon',
    title: 'beta gameon jouable',
    createdAtMs: NOW - 10 * DAY,
    deadlineMs: NOW + 8 * DAY,
    targetCount: 6,
    currentCount: 2,
    projectId: 'gameon',
  },
  {
    id: 'obj-main-verte',
    title: 'garder main toujours verte',
    createdAtMs: NOW - 30 * DAY,
    deadlineMs: null,
    targetCount: null,
    currentCount: 0,
    projectId: null,
  },
];

// ── Manager chat fixture — 1 initial message with an inline action pill
//    (design-cockpit.md §10.3's "Prépare le résumé" scenario). The action's
//    literal button COPY can't be reproduced through this codebase's real
//    ManagerAction taxonomy (LazyManagerRail.tsx's actionSummary renders a
//    fixed, per-type label — there's no free-text action label in the real
//    data model), so this picks the closest real action type for correct
//    pill STYLING; see the pixel-fidelity report for this documented gap. ──

const MANAGER_MESSAGES_FIXTURE: ManagerMessage[] = [
  {
    id: 'm-1',
    role: 'assistant',
    content: "La revue paiement in-app attend depuis 2 h — remontée en N°2. Si tu es pressé, un haiku peut te résumer le diff en 5 lignes.",
    timestamp: new Date(NOW - 2 * HOUR).toISOString(),
    actions: [{ type: 'answer_question', missionId: 'paiement', answer: 'Prépare le résumé' }],
  },
];

// ── Error boundary — surfaces render crashes as visible text in the
//    screenshot instead of a silent blank page (mirrors AppShell's real
//    SpaceErrorBoundary, which wraps every space in production). ─────────

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

// ── Harness body — mirrors AgentsSpace.tsx's real Cockpit+drawer glue ────

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
          objectivesOverride={OBJECTIVE_FIXTURES}
          managerMessagesOverride={MANAGER_MESSAGES_FIXTURE}
          activeProjectRootOverride={ACTIVE_ROOT}
        />
        <ManagerHost activeHostId="cockpit" />
      </ManagerHostRegistryProvider>
      {selectedMission && (
        <MissionDetailDrawer mission={selectedMission} onClose={() => setSelectedMissionId(null)} />
      )}
    </div>
  );
}

function HarnessRoot() {
  const [, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setReady(true);
      document.body.setAttribute('data-harness-ready', 'true');
    }, 200);
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
