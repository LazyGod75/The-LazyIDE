/**
 * mission-detail-harness.tsx — isolated screenshot harness for the D13
 * MissionDetail drawer (see design-cockpit.md §11.2 + MASTER-PLAN.md's D13).
 *
 * Why this harness exists: useFleetMissions (fleetMissions.ts) intentionally
 * returns an empty project list outside a real Tauri runtime (repo
 * convention — real data or honest empty, no mock fleet data), and
 * AppContext's openProjects/activeProjectId stay empty without Tauri too.
 * That means the Cockpit has no mission card to click under plain
 * `npm run dev` (no Tauri), so there is no way to reach the drawer through
 * the real click flow in a browser-only dev session. This harness mounts
 * MissionDetailDrawer directly with a synthetic Mission fixture — same
 * pattern as teams-harness.tsx — to verify the REAL component tree (styles,
 * i18n, store wiring) renders correctly end-to-end.
 *
 * URL param ?variant= controls which Mission fixture is shown:
 *   failed   (default) — failed mission, exercises all 3 D13 grafts at once
 *            (Avis du manager's failed branch, a flagged scope row, brain
 *            citations)
 *   question — running mission with a pending ask_user question (Avis du
 *            manager's "running + pending question" branch)
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
import { MissionDetailDrawer } from '../components/agents/MissionDetailDrawer';
import type { Mission } from '../lib/agents/types';

// ── Set locale to French before first render (matches the design's copy) ──
try {
  localStorage.setItem('lazy.locale', 'fr');
} catch { /* noop */ }

// ── Demo fixtures ───────────────────────────────────────────────────

const FAILED_MISSION: Mission = {
  id: 'M99',
  title: 'Corriger le total du panier (arrondi remise)',
  status: 'failed',
  statusReason: 'La mission a échoué : écriture refusée hors périmètre déclaré (src/components/pricing) — tests unitaires en échec dans src/lib/pricing/calc.ts',
  model: 'claude-sonnet-5',
  worktree: 'agent/M99-fix-pricing-total',
  agentTask: 'Corrige le calcul du total du panier quand une remise en pourcentage est appliquée.',
  progress: 62,
  filesCount: 3,
  planSteps: [
    { label: 'Explorer et analyser', state: 'done' },
    { label: 'Implémenter', state: 'done' },
    { label: 'Tests unitaires — 2 échecs (arrondi remise)', state: 'in_progress' },
    { label: 'Tests + revue + merge', state: 'todo' },
  ],
  actionTimeline: [
    { time: '13:54', text: '🧠 lit contexte brain du projet' },
    { time: '13:58', text: 'implémente PricingTable.tsx' },
    { time: '14:02', text: 'Résultat: 2 tests failing on discount rounding (calc.test.ts)' },
  ],
  contract: {
    objective: 'Corriger le total du panier avec remise',
    scopePaths: ['src/lib/pricing', 'src/components/pricing'],
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 5,
    proofs: [],
    gates: { evaluators: true, humanApprove: true },
    shareToTeam: false,
  },
  diffFiles: [
    { filename: 'src/lib/pricing/calc.ts', added: 18, removed: 6 },
    { filename: 'src/lib/pricing/calc.test.ts', added: 9, removed: 0 },
  ],
  brainCitations: [
    { id: 'n-pricing-1', label: 'Pattern arrondi remise (M14)' },
    { id: 'n-pricing-2', label: 'Convention centimes vs float' },
  ],
  tokensSaved: '~1.8k tokens économisés',
};

const QUESTION_MISSION: Mission = {
  id: 'M42',
  title: 'Ajouter le webhook Stripe pour les remboursements',
  status: 'running',
  model: 'claude-sonnet-5',
  worktree: 'agent/M42-stripe-refund-webhook',
  progress: 41,
  planSteps: [
    { label: 'Explorer et analyser', state: 'done' },
    { label: 'Implémenter', state: 'in_progress' },
    { label: 'Tests + revue + merge', state: 'todo' },
  ],
  actionTimeline: [
    { time: '10:12', text: 'implémente server/webhooks/stripe.ts' },
    { time: '10:20', text: 'Observation: Question for user: write server/webhooks/stripe.ts (nouvelle route) ?' },
  ],
  contract: {
    objective: 'Webhook remboursement Stripe',
    scopePaths: ['server/webhooks', 'src/lib/payments'],
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 5,
    proofs: [],
    gates: { evaluators: true, humanApprove: true },
    shareToTeam: false,
  },
};

function getVariant(): 'failed' | 'question' {
  const params = new URLSearchParams(window.location.search);
  return params.get('variant') === 'question' ? 'question' : 'failed';
}

function HarnessRoot() {
  const [ready, setReady] = useState(false);
  const variant = getVariant();
  const mission = variant === 'question' ? QUESTION_MISSION : FAILED_MISSION;

  useEffect(() => {
    const t = setTimeout(() => {
      setReady(true);
      document.body.setAttribute('data-harness-ready', 'true');
    }, 200);
    return () => clearTimeout(t);
  }, []);

  void ready; // used only via data-harness-ready

  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>
          <div style={{ position: 'relative', width: '100vw', height: '100vh', background: 'var(--color-bg)' }}>
            <MissionDetailDrawer mission={mission} onClose={() => {}} />
          </div>
        </AgentsStoreProvider>
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
