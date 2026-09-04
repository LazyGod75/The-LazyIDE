/* BrainSpace — 3D neural graph + wiki + controls.
   Under Tauri: loads real graph from brain sidecar via HTTP client.
   Under Web: same sidecar over the Vite /_api proxy; empty vault if
   unreachable — never a canned demo graph.
   Layout: BrainControls (left) | BrainGraph3D (center, with the
   TimelineScrubber time-travel overlay floating over its bottom edge) |
   BrainWiki (right).
   Live refresh: listens for brain://updated Tauri event to refetch graph.
   Background auto-index progress (brain://indexing) is owned by the
   isolated IndexingBanner component — see handleIndexingDone below, which
   only wires its "done" callback into the same graph-refresh path.

   Bus events consumed: nav:focusBrainNode
   Bus events emitted (via children): editor:openFile, nav:focusBrainNode,
   nav:navigateSpace (BrainSetupCard's "Ouvrir Reglages > Memoire" link)

   platform.brain methods used:
   - graph()      — single-project graph (This project scope)
   - graphAll()   — merged multi-brain graph (All brains scope)
   - health()     — brain health score badge
   - capture()    — add neuron
   - note()       — wiki panel note meta
   - rebuildGraph() — rebuild index
   - setConfig()  — BrainSetupCard's "Utiliser un brain de projet" quick
                    action. Narrow addition, see BrainWithSetup cast below.
   - importFromGithub() — ImportBrainDialog. Same narrow-cast convention.

   Sidecar independence: brainInfo (path/source, powering
   GlobalBrainOverrideBadge) is fetched independently of graph()/graphAll()/
   health() and never gated behind their loading state — see the "Timeout
   helpers" section below. All sidecar-backed fetches race a timeout instead
   of spinning forever; on failure/timeout the graph pane shows an honest
   "sidecar unavailable" message rather than an infinite "Connexion au
   brain..." spinner.

   Empty-brain onboarding: when a load settles successfully (not loading,
   sidecar reachable) but resolves to zero neurons, BrainSetupCard replaces
   the bare empty 3D canvas with a friendly setup prompt instead — see
   showSetupCard below. It never shows once the brain has any neurons, nor
   while still loading/genuinely unreachable (those already have their own
   distinct overlays).
*/

import { useState, useEffect, useCallback, useRef, useId, useMemo, lazy, Suspense } from 'react';
import { useI18n } from '../i18n';
import { BrainControls, BrainWiki, IndexingBanner, TimelineScrubber, WikiTab } from '../components/brain';
import { BrainFilters } from '../components/brain/BrainFilters';
import { SyncStatusBanner } from '../components/brain/SyncStatusBanner';
import { BrainTimeline } from '../components/brain/BrainTimeline';
import { LateJoinerTour } from '../components/brain/LateJoinerTour';
import { getPlatform } from '../lib/platform';
// Harness Rules/Skills panels (RulesPanel/SkillsPanel) — mounted here as two
// more Brain space tabs, same full-body-swap pattern as the Wiki tab below.
// Imported directly (not via the components/agents barrel) to avoid pulling
// that barrel's much heavier agentsStore.tsx re-export chain into this
// space's bundle for two small, standalone panels.
import { RulesPanel } from '../components/agents/RulesPanel';
import { SkillsPanel } from '../components/agents/SkillsPanel';
// useAppContextOptional (not useAppContext): BrainSpace must keep rendering
// standalone in tests/tools that mount it without an AppProvider ancestor
// (see BrainSpace.test.tsx, which never wraps it in one) — same "safe no-op
// default" convention agentsStore.tsx already uses for this exact situation.
import { useAppContextOptional } from '../app/AppContext';
import { projectIdFromRoot } from '../lib/journal/projectId';
import { basename } from '../lib/paths';

// Three.js is heavy (~600 KB) — lazy-load it only when BrainSpace mounts.
const BrainGraph3D = lazy(() =>
  import('../components/brain/BrainGraph3D').then((m) => ({ default: m.BrainGraph3D }))
);
import { on, emit } from '../lib/bus';
import { Spinner } from '../components/ui';
import type { AdaptedBrainData, AdaptedNode, PaletteId } from '../lib/brain/brainAdapter';
import type { WikiPayload } from '../lib/mock/brain';
import type { NodeType } from '../lib/mock/brain';
import type { Brain, BrainHealth, Platform } from '../lib/platform/types';
import { SeedProgress } from '../components/brain/SeedProgress';
import { AddProjectToBrainWizard } from '../components/brain/AddProjectToBrainWizard';
import {
  getSeedProgressState,
  subscribeSeedProgress,
  seedProgressStateToEvent,
  type SeedProgressState,
} from '../lib/brain/seedProgressStore';
import { DEFAULT_PALETTE } from '../components/brain/canvas/palettes';
import { TIME_BUCKET_COUNT } from '../components/brain/canvas/dateBucketing';
import { clampZoom } from '../components/brain/canvas/projection';
import { DEFAULT_BRAIN_ZOOM } from '../components/brain/mapBrainForceGraph';
import { BrainGraphHud } from '../components/brain/BrainGraphHud';
// BrainInfo (path + resolution source) is intentionally not part of the
// shared Brain interface above — see tauri.ts's "BRAIN-PATH TRANSPARENCY"
// note. Imported here only for the local `Brain & { info(): ... }` narrow
// cast used below.
import type { BrainInfo } from '../lib/platform/tauri';
import type { BrainWithSetup } from '../lib/brain/brainWithSetup';
import { PublishBrainDialog } from '../components/brain/PublishBrainDialog';
import { ImportBrainDialog } from '../components/brain/ImportBrainDialog';
import {
  emptyAdaptedBrain,
  loadAdaptedBrainGraph,
} from '../lib/brain/brainGraphLoad';
import { brainOverlayFlags } from '../lib/brain/brainOverlayFlags';
import { loadWikiNote } from '../lib/brain/brainNoteLoad';
import { TimeoutError, withTimeout } from '../lib/brain/withTimeout';

export { TimeoutError, withTimeout };

// ── Timeout helpers (BRAIN-PATH TRANSPARENCY hardening) ─────────────
//
// brain.info() (get_brain_info) is documented as a fast, Rust-only path
// computation that does NOT depend on the LazyBrain sidecar being up — but
// the underlying Tauri invoke() call has no built-in timeout, so a stalled
// IPC bridge must not leave the "Path override" badge (GlobalBrainOverrideBadge
// below) waiting forever. Sidecar-backed calls (graph()/graphAll()/health())
// get a longer timeout since they cross an HTTP boundary to the sidecar and
// may legitimately take longer to settle — but they must not spin on
// "Connexion au brain..." forever either, and their failure/slowness must
// never block the (independent) brainInfo state or its badge from rendering.
//
// Mirrors the identical helper in MemoryPanel.tsx (kept local to each file
// per this change's file-scope constraints). Exported so the timeout
// mechanism itself can be asserted directly from BrainSpace.test.tsx.

export const BRAIN_INFO_TIMEOUT_MS = 5_000;
export const SIDECAR_TIMEOUT_MS = 9_000;

/** brain.info() fetch with a timeout guard — used by the brainInfo effect
    in BrainSpace below (powers both GlobalBrainOverrideBadge and
    PublishBrainDialog). */
function fetchBrainInfo(platform: Platform): Promise<BrainInfo> {
  return withTimeout(
    (platform.brain as Brain & { info(): Promise<BrainInfo> }).info(),
    BRAIN_INFO_TIMEOUT_MS,
    'brain.info()',
  );
}

// ── Brain setup UI (natural, UI-driven brain configuration) ─────────
//
// platform.brain.setConfig()/importFromGithub() are narrow additions on top
// of the native/web Brain impls (see tauri.ts — added concurrently by a
// backend change alongside this UI), not part of the shared Brain interface
// in ./types. Same convention as info()/publishGithub() above: accessed via
// a local widened cast instead of editing tauri.ts/web.ts/types.ts. Mirrors
// the identical block in MemoryPanel.tsx (kept local to each file per this
// change's file-scope constraints).


// ── AddNeuronDialog ───────────────────────────────────────────────

interface AddNeuronDialogProps {
  onClose: () => void;
  onSubmit: (title: string, text: string, kind: string) => Promise<void>;
}

function AddNeuronDialog({ onClose, onSubmit }: AddNeuronDialogProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState('decision');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const handleSubmit = async () => {
    if (!title.trim()) {
      setError(t('brain.titleRequired'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await onSubmit(title.trim(), text.trim(), kind);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('brain.createFailed'));
    } finally {
      setLoading(false);
    }
  };

  // Focus trap: keep Tab within the dialog panel, move focus in on mount.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    function getFocusable(): HTMLElement[] {
      return Array.from(
        panel!.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    panel.addEventListener('keydown', handleKeyDown);
    const first = getFocusable()[0];
    if (first) first.focus();

    return () => panel.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          background: '#18181E',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          padding: '24px',
          width: 400,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <div id={titleId} style={{ fontSize: 14, fontWeight: 700, color: '#E8E3FF' }}>{t('brain.addNeuron')}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            {t('brain.titleLabel')}
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('brain.titlePlaceholder')}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              padding: '8px 10px',
              color: '#E8E3FF',
              fontSize: 12,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            {t('brain.typeLabel')}
          </label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              padding: '7px 10px',
              color: '#E8E3FF',
              fontSize: 12,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          >
            <option value="decision">{t('brain.type.decision')}</option>
            <option value="episodic">{t('brain.type.episodic')}</option>
            <option value="agent">{t('brain.type.agent')}</option>
            <option value="edit">{t('brain.type.edit')}</option>
            <option value="commit">{t('brain.type.commit')}</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            {t('brain.contentLabel')}
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('brain.contentPlaceholder')}
            rows={4}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              padding: '8px 10px',
              color: '#E8E3FF',
              fontSize: 12,
              outline: 'none',
              fontFamily: 'inherit',
              resize: 'vertical',
            }}
          />
        </div>

        {error && (
          <div style={{ fontSize: 11, color: '#FCA5A5', background: 'rgba(239,68,68,0.1)', padding: '6px 10px', borderRadius: 5 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.6)',
              fontFamily: 'inherit',
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            style={{
              padding: '7px 16px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              border: 'none',
              background: loading ? 'rgba(124,92,255,0.4)' : '#7C5CFF',
              color: '#fff',
              fontFamily: 'inherit',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? t('brain.adding') : t('brain.addNeuron')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── BrainSetupCard (empty-brain onboarding) ──────────────────────────
//
// Replaces the bare empty 3D canvas with a friendly setup prompt when the
// brain resolves successfully but has zero neurons (see showSetupCard in
// BrainSpace below). Never shown once the brain has any neurons, nor while
// still loading or genuinely unreachable (those already have their own
// distinct overlays).

interface BrainSetupCardProps {
  onUseProjectBrain: () => Promise<void>;
  onOpenImport: () => void;
  onOpenSettings: () => void;
  projectRoot: string;
  onReloadGraph: () => void;
}

function BrainSetupCard({ onUseProjectBrain, onOpenImport, onOpenSettings, projectRoot, onReloadGraph }: BrainSetupCardProps) {
  const { t } = useI18n();
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddProjectWizard, setShowAddProjectWizard] = useState(false);

  async function handleUseProjectBrain() {
    setApplying(true);
    setError(null);
    try {
      await onUseProjectBrain();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div
      data-testid="brain-setup-card"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: 'rgba(4,4,10,0.55)',
        zIndex: 5,
        padding: '0 32px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'rgba(124,92,255,0.10)',
          border: '1px solid rgba(124,92,255,0.25)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 22,
          flexShrink: 0,
        }}
      >
        🧠
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 380 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#E8E3FF' }}>
          Configurez votre brain
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', lineHeight: 1.55 }}>
          Ce brain est vide pour l&apos;instant. Choisissez comment le remplir pour que Lazy retienne vos décisions, bugs et contexte au fil du temps.
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={handleUseProjectBrain}
          disabled={applying}
          style={{
            padding: '8px 16px',
            background: applying ? 'rgba(124,92,255,0.4)' : '#7C5CFF',
            border: 'none',
            borderRadius: 7,
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            cursor: applying ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: applying ? 0.7 : 1,
          }}
        >
          {applying ? 'Configuration…' : 'Utiliser un brain de projet'}
        </button>
        <button
          onClick={onOpenImport}
          disabled={applying}
          style={{
            padding: '8px 16px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 7,
            color: 'rgba(255,255,255,0.75)',
            fontSize: 12,
            fontWeight: 500,
            cursor: applying ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Importer depuis GitHub
        </button>
        <button
          onClick={() => setShowAddProjectWizard(true)}
          disabled={applying || !projectRoot}
          style={{
            padding: '8px 16px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 7,
            color: 'rgba(255,255,255,0.75)',
            fontSize: 12,
            fontWeight: 500,
            cursor: applying || !projectRoot ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {t('brain.setup.addProject')}
        </button>
      </div>

      {showAddProjectWizard && projectRoot && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(4,4,10,0.85)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            overflow: 'auto',
          }}
        >
          <div style={{ maxWidth: 520, width: '100%' }}>
            <AddProjectToBrainWizard
              projectRoot={projectRoot}
              projectSlug={basename(projectRoot)}
              onDone={() => { setShowAddProjectWizard(false); onReloadGraph(); }}
              onCancel={() => setShowAddProjectWizard(false)}
            />
          </div>
        </div>
      )}

      <button
        onClick={onOpenSettings}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#A78BFF',
          fontSize: 11,
          fontWeight: 500,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textDecoration: 'underline',
          padding: 0,
        }}
      >
        Ouvrir Réglages &gt; Mémoire
      </button>

      {error && (
        <div style={{ fontSize: 11, color: '#F87171', maxWidth: 380, lineHeight: 1.5 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ── SeedBuildBanner (non-blocking background build progress) ─────────
//
// While a history-import seed (onboarding's BrainSetupStep, or Settings'
// HistoryReimportSection — both funnel through the SAME shared
// seedProgressStore, see its module doc comment) is actively building a
// brain that currently shows zero neurons, this replaces BrainSetupCard's
// "Configurez votre brain" empty-state prompt with a live progress view
// instead — the whole point of the non-blocking build: the user can be
// looking at the Brain page WHILE it fills up and see a real percentage,
// not a static "this brain is empty" prompt that doesn't explain why. Once
// the seed finishes, `brain://updated` (emitted by brain_seed,
// history_import.rs) refreshes the graph and seedState.active flips false
// — see BrainSpace's own "Live refresh" effect below, unchanged — so this
// banner naturally gives way to the now-populated graph with no extra
// wiring needed here.
//
// Takes precedence over the "Connexion au brain..." connecting spinner AND
// the sidecar-unavailable error overlay (see showSeedBanner's doc comment
// at its declaration below) — the lazybrain sidecar only comes up near the
// very end of a build (its own 'serving' phase, see history_import.rs's
// run_post_seed_pipeline), so for nearly the whole build — which can run
// 40+ minutes on a large history — loading/sidecarUnavailable would
// otherwise be true and hide this banner behind a generic "still
// connecting" or "unavailable" message that never explains a build is
// actually in progress.
//
// Reuses SeedProgress.tsx (the same animated spinner/bar/phase-label
// component onboarding and Settings already use) for the actual progress
// chrome, wrapped in a page-level headline with the percentage prominent —
// distinct copy from SeedProgress's own generic "Import en cours…" header,
// since this is framed for someone looking at the Brain page itself, not
// mid-onboarding-wizard.

function SeedBuildBanner({ seedState }: { seedState: SeedProgressState }) {
  const { t } = useI18n();
  const progressEvent = seedProgressStateToEvent(seedState);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: 'rgba(4,4,10,0.55)',
        zIndex: 5,
        padding: '0 32px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, color: '#E8E3FF' }}>
        {t('brain.buildBanner.title', { percent: seedState.percent })}
      </div>
      <div style={{ maxWidth: 420, width: '100%', textAlign: 'left' }}>
        <SeedProgress status="running" progress={progressEvent} />
      </div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', maxWidth: 380, lineHeight: 1.5 }}>
        {t('brain.buildBanner.note')}
      </div>
    </div>
  );
}

// ── View tabs (graph scope + Wiki) ────────────────────────────────

type BrainScope = 'project' | 'all';
// The scope toggle doubles as the view switcher: 'project'/'all' drive the 3D
// graph scope, 'wiki' swaps the whole body for the Wikipedia-style reader,
// and 'rules'/'skills' swap it for the harness Rules/Skills panels
// (RulesPanel/SkillsPanel — same full-body-swap pattern as 'wiki').
type BrainTab = BrainScope | 'wiki' | 'rules' | 'skills';

// Brain status badge (W3.1): 'checking' is the honest initial state before
// the first load settles, 'live' is real graph data (Tauri invoke/HTTP or web
// /_api/graph), 'demo' is ONLY the non-Tauri/web mock fallback. Replaces the
// old isLive boolean, which could flash a false "mock/dev" signal during the
// checking window.
type BrainStatus = 'checking' | 'live' | 'demo';

const BRAIN_STATUS_DOT: Record<BrainStatus, string> = {
  checking: '#8B93A8',
  live: '#22C55E',
  demo: '#FFC76B',
};

const BRAIN_STATUS_LABEL_KEY: Record<BrainStatus, string> = {
  checking: 'brain.connecting',
  live: 'brain.liveBadge',
  demo: 'brain.mockBadge',
};

const BRAIN_TAB_LABEL_KEY: Record<BrainTab, string> = {
  project: 'brain.thisProject',
  all: 'brain.allBrains',
  wiki: 'brain.wikiTab',
  rules: 'brain.rulesTab',
  skills: 'brain.skillsTab',
};

function BrainTabs({ active, onChange }: { active: BrainTab; onChange: (t: BrainTab) => void }) {
  const { t } = useI18n();
  const tabs: BrainTab[] = ['project', 'all', 'wiki', 'rules', 'skills'];
  const labelFor = (tab: BrainTab): string => t(BRAIN_TAB_LABEL_KEY[tab]);
  return (
    <div
      style={{
        display: 'flex',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.09)',
        borderRadius: 7,
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {tabs.map((tab, i) => {
        const isActive = active === tab;
        return (
          <button
            key={tab}
            data-testid={`brain-tab-${tab}`}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onChange(tab)}
            style={{
              padding: '5px 12px',
              background: isActive ? 'rgba(124,92,255,0.25)' : 'transparent',
              border: 'none',
              borderRight: i < tabs.length - 1 ? '1px solid rgba(255,255,255,0.09)' : 'none',
              color: isActive ? '#C4B5FD' : 'rgba(255,255,255,0.45)',
              fontSize: 11,
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {labelFor(tab)}
          </button>
        );
      })}
    </div>
  );
}

// ── Health badge ──────────────────────────────────────────────────

function HealthBadge({ health }: { health: BrainHealth | null | undefined }) {
  const { t } = useI18n();
  if (health === undefined) return null; // loading
  if (health === null) return null;       // web mock — honest empty state

  const score = health.score;
  const color = score >= 80 ? '#4ADE80' : score >= 50 ? '#FFC76B' : '#F87171';

  return (
    <div
      title={`Brain health: ${score}/100 — orphans: ${health.orphans}, broken links: ${health.brokenLinks}, stale: ${health.stale}, dupes: ${health.dupes}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${color}33`,
        borderRadius: 7,
        padding: '5px 10px',
        cursor: 'default',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 4px ${color}`,
        }}
      />
      {/* Previously just "{score}%" with nothing but a hover tooltip to say
          what it measured — a lone percentage top-right with no visible
          label. The tooltip still carries the orphans/broken-links/stale/
          dupes breakdown on hover; this adds the always-visible word so the
          badge is legible without hovering at all. */}
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' }}>
        {t('brain.health.label')}
      </span>
      <span style={{ fontSize: 11, color, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {score}%
      </span>
    </div>
  );
}

// ── Brain path-override badge ────────────────────────────────────
//
// BRAIN-PATH TRANSPARENCY: resolve_unified_brain_path (src-tauri/src/lib.rs)
// lets LAZYBRAIN_BRAIN_PATH override the per-project brain by design — but
// that means "This project" can silently point at a brain shared across
// every project on the machine. This badge makes that fact visible instead
// of hiding it, without changing the resolution priority itself.
//
// AXIS DISAMBIGUATION: this badge and the BrainTabs scope toggle
// (project/all, just to its left) answer two unrelated questions and must
// never be read as contradicting each other:
//   - BrainTabs / BrainScope ('project' | 'all') — how much of the
//     currently-loaded brain FILE to query: this project's own graph, or
//     every local brain merged.
//   - This badge / BrainInfo.source ('env_override' | ...) — WHICH brain
//     FILE got loaded in the first place, resolved once at startup,
//     independent of the scope tabs. It renders only when that resolution
//     picked the env-var override, so it is a status readout, not a
//     control — it has no onClick and never changes the scope.
// Previously labelled "Brain global", which read as a third scope value
// competing with "This project"/"All brains" (its old id="brain-tab-…"
// sibling elements). Renamed + given an explicit status role so it reads
// as "which file", not "how much of it".

function GlobalBrainOverrideBadge({ path }: { path: string }) {
  const { t } = useI18n();
  const label = t('brain.pathOverride.label');
  return (
    <div
      role="status"
      aria-label={`${label}: ${path}`}
      title={t('brain.pathOverride.tooltip', { path })}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        background: 'rgba(255,199,107,0.08)',
        border: '1px solid rgba(255,199,107,0.3)',
        borderRadius: 7,
        padding: '5px 10px',
        cursor: 'default',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: '#FFC76B',
          boxShadow: '0 0 4px #FFC76B',
        }}
      />
      <span style={{ fontSize: 11, color: '#FFC76B', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </div>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────

function BrainSubHeader({
  nodeCount,
  linkCount,
  scope,
  brainStatus,
  activeTab,
  onTabChange,
  health,
  brainInfo,
  onAddNeuron,
  onPublish,
}: {
  nodeCount: number;
  linkCount: number;
  /** Graph scope the counts below were loaded for — 'project' vs 'all'
      brains merged. Shown next to the counts so they read as scoped graph
      totals, not the brain's total note count (see the Wiki index, which
      counts every stored note and can legitimately show a different
      number — brain.neuronsLinksScopeHint explains why in the tooltip). */
  scope: BrainScope;
  brainStatus: BrainStatus;
  activeTab: BrainTab;
  onTabChange: (t: BrainTab) => void;
  health: BrainHealth | null | undefined;
  brainInfo: BrainInfo | null;
  onAddNeuron: () => void;
  onPublish: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        height: 52,
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        gap: 12,
        flexShrink: 0,
        background: '#0E0E12',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1, flexShrink: 0 }}>
        <span
          style={{ fontSize: 14, fontWeight: 700, color: '#E8E3FF', letterSpacing: '-0.01em' }}
        >
          {t('brain.title')}
        </span>
        <span
          title={t('brain.neuronsLinksScopeHint')}
          style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}
        >
          {t('brain.neuronsLinks', { nodes: nodeCount, links: linkCount })}
          {' · '}
          {t(scope === 'all' ? 'brain.allBrains' : 'brain.thisProject')}
        </span>
      </div>

      {/* View tabs: graph scope (project/all) + Wiki */}
      <BrainTabs active={activeTab} onChange={onTabChange} />

      {/* Brain path-override status badge — only when LAZYBRAIN_BRAIN_PATH is
          overriding the per-project brain (see BrainInfo.source). A status
          readout on the WHICH-FILE axis, unrelated to the BrainTabs
          scope toggle just above it on the HOW-MUCH axis — see
          GlobalBrainOverrideBadge's own comment for the full breakdown. */}
      {brainInfo?.source === 'env_override' && (
        <GlobalBrainOverrideBadge path={brainInfo.path} />
      )}

      <div style={{ flex: 1 }} />

      {/* Health badge */}
      <HealthBadge health={health} />

      {/* Live / Mock badge */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.09)',
          borderRadius: 7,
          padding: '5px 12px',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: BRAIN_STATUS_DOT[brainStatus],
            boxShadow: `0 0 4px ${BRAIN_STATUS_DOT[brainStatus]}`,
          }}
        />
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap' }}>
          {t(BRAIN_STATUS_LABEL_KEY[brainStatus])}
        </span>
      </div>

      {/* Publish to GitHub — see PublishBrainDialog for the confirm flow. */}
      <button
        onClick={onPublish}
        title={t('brain.publishTooltip')}
        style={{
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 7,
          padding: '6px 12px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          color: 'rgba(255,255,255,0.65)',
          fontSize: 12,
          fontWeight: 500,
          whiteSpace: 'nowrap',
          fontFamily: 'inherit',
        }}
      >
        {t('settings.memory.publish.titleShort')}
      </button>

      {/* Add neuron button */}
      <button
        onClick={onAddNeuron}
        style={{
          background: '#7C5CFF',
          borderRadius: 7,
          padding: '6px 14px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          boxShadow: '0 2px 12px rgba(124,92,255,0.4)',
          border: 'none',
          color: '#fff',
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          fontFamily: 'inherit',
        }}
      >
        <span style={{ fontSize: 14, lineHeight: 1, marginTop: -1 }}>+</span>
        {t('brain.addNeuron')}
      </button>
    </div>
  );
}

// ── BrainSpace ────────────────────────────────────────────────────

export function BrainSpace() {
  const { t } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  // Current project root, for the Rules tab's import/AGENTS.md-projection
  // actions (RulesPanel disables those when there is no open project).
  // Optional context lookup (see useAppContextOptional import above) — falls
  // back to '' when BrainSpace renders without an AppProvider ancestor.
  const appContext = useAppContextOptional();
  const projectRoot = appContext?.projectRoot ?? '';
  // Same projectIdFromRoot(projectRoot) convention AgentsSpace.tsx already
  // uses to tag rules/missions with the current project — NOT AppContext's
  // own `activeProjectId` (a different id space: the T0.7 registry id).
  const activeProjectId = useMemo(() => projectIdFromRoot(projectRoot), [projectRoot]);

  const [brainData, setBrainData] = useState<AdaptedBrainData>(emptyAdaptedBrain);
  const [brainStatus, setBrainStatus] = useState<BrainStatus>('checking');
  const [loading, setLoading] = useState(isTauri);
  // Once a vault has painted, later reloads (scope flip, brain://updated,
  // auto-retry) must not blank the canvas behind a full-screen spinner or
  // wipe nodes on a transient sidecar blip.
  const paintedGraphRef = useRef(false);
  // True when every graph-loading path (invoke + HTTP fallback) has failed
  // or timed out — an honest end state instead of a spinner that never
  // resolves. Reset at the start of each load attempt and on any success.
  const [sidecarUnavailable, setSidecarUnavailable] = useState(false);
  // Keep a ref so the brain://updated listener (defined once) and the
  // auto-retry loop below always see the LATEST sidecarUnavailable value
  // without needing to be redeclared on every change — same pattern as
  // scopeRef just below.
  const sidecarUnavailableRef = useRef(false);
  useEffect(() => { sidecarUnavailableRef.current = sidecarUnavailable; }, [sidecarUnavailable]);
  // True while a sidecar-restart attempt (manual "Réessayer" click or the
  // bounded auto-retry loop) is in flight — drives the "reconnecting…" copy
  // so the honest end-state error never looks like a dead end.
  const [retrying, setRetrying] = useState(false);
  // True once the bounded auto-retry loop has exhausted every attempt
  // without the sidecar coming back healthy — swaps the perpetual
  // "reconnecting…" copy for an honest terminal message ("could not
  // restart, see logs") instead of leaving the user staring at a spinner
  // that will never resolve on its own. Cleared the moment ANY retry
  // (auto or manual "Réessayer" click) succeeds, or a fresh load attempt
  // starts, so a later successful reconnect never leaves a stale terminal
  // message lingering underneath.
  // Reset at the top of every retry ATTEMPT (see retryConnection below) —
  // covers every real recovery entry point (auto-retry tick, manual
  // "Réessayer" click, and the brain://updated listener's own retryConnection
  // call when previously unavailable), so a later "sidecar died again"
  // episode never opens on a stale terminal message left over from a
  // previous, since-recovered episode. Not reset elsewhere: the overlay this
  // drives is only rendered while `sidecarUnavailable` is true anyway (see
  // the render block below), so there is no separate "on recovery" effect
  // needed here — that would only add a cascading extra render for no
  // observable benefit.
  const [retriesExhausted, setRetriesExhausted] = useState(false);
  const [selectedNode, setSelectedNode] = useState<AdaptedNode | null>(null);
  const [wikiPayload, setWikiPayload] = useState<WikiPayload | null>(null);
  const [clusterStats, setClusterStats] = useState<Record<string, string>>({});

  // Scope toggle: 'project' = current project only, 'all' = merged multi-brain
  const [scope, setScope] = useState<BrainScope>('project');
  // Keep a ref so loadGraphData closure always sees the latest scope
  const scopeRef = useRef<BrainScope>('project');
  useEffect(() => { scopeRef.current = scope; }, [scope]);

  // View toggle: 'wiki'/'rules'/'skills' each swap the whole graph body for
  // a different full-body panel (WikiTab / RulesPanel / SkillsPanel). Kept
  // separate from `scope` so switching away and back preserves the last
  // graph scope without triggering a graph reload.
  const [view, setView] = useState<'graph' | 'wiki' | 'rules' | 'skills'>('graph');
  const activeTab: BrainTab = view === 'graph' ? scope : view;
  const handleTabChange = useCallback((tab: BrainTab) => {
    if (tab === 'project' || tab === 'all') {
      setView('graph');
      setScope(tab);
    } else {
      setView(tab);
    }
  }, []);

  // Health score from platform.brain.health() — undefined while loading, null on web
  // Lazy initializer avoids a synchronous setState in useEffect for the non-Tauri path
  const [health, setHealth] = useState<BrainHealth | null | undefined>(() => isTauri ? undefined : null);
  const healthRef = useRef(health);
  healthRef.current = health;

  // Brain path + resolution source from platform.brain.info() — powers the
  // "Path override" status badge (BRAIN-PATH TRANSPARENCY). null while
  // loading or unavailable; the badge simply stays hidden in that case.
  const [brainInfo, setBrainInfo] = useState<BrainInfo | null>(null);

  // Filter state managed here, controlled by BrainControls
  const [activeTypes, setActiveTypes] = useState<Set<NodeType>>(
    new Set<NodeType>(['decision', 'bug', 'file', 'concept', 'module']),
  );
  const [activeClusters, setActiveClusters] = useState<Set<string>>(new Set<string>());

  // Focused node id from bus (nav:focusBrainNode)
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  // Brain Canvas view controls (palette / 3D-2D / time-travel / zoom) —
  // lifted here so BrainControls (which owns the HUD inputs) and
  // BrainGraph3D (which renders them) always agree on the same values.
  const [paletteId, setPaletteId] = useState<PaletteId>(DEFAULT_PALETTE);
  const [is3D, setIs3D] = useState(true);
  const [timeIdx, setTimeIdx] = useState(TIME_BUCKET_COUNT - 1);
  const [zoom, setZoomRaw] = useState(DEFAULT_BRAIN_ZOOM);
  const setZoom = useCallback((next: number) => setZoomRaw(clampZoom(next)), []);

  // Add neuron dialog
  const [showAddDialog, setShowAddDialog] = useState(false);

  // Brain filters (Kind / Project / Author) — null = no filter (show all)
  const [filterIds, setFilterIds] = useState<Set<string> | null>(null);

  // Publish-to-GitHub dialog
  const [showPublishDialog, setShowPublishDialog] = useState(false);

  // Import-from-GitHub dialog (empty-brain onboarding)
  const [showImportDialog, setShowImportDialog] = useState(false);

  // Global brain seed-progress state (src/lib/brain/seedProgressStore.ts) —
  // the SAME store AppShell.tsx subscribes to once at app level. Read here
  // (independently, own local mirror via subscribeSeedProgress) so the
  // Brain page can show a live, non-blocking build banner — see
  // SeedBuildBanner below and showSeedBanner/showSetupCard further down.
  const [seedState, setSeedState] = useState<SeedProgressState>(getSeedProgressState);
  useEffect(() => subscribeSeedProgress(setSeedState), []);

  // ── loadGraphData — shared loader used on mount + live-refresh ──

  const loadGraphData = useCallback(async (cancelled: { v: boolean }, useScope?: BrainScope) => {
    const activeScope = useScope ?? scopeRef.current;
    const commitSuccess = (adapted: AdaptedBrainData, status: BrainStatus) => {
      paintedGraphRef.current = adapted.nodes.length > 0;
      setBrainData(adapted);
      setClusterStats(adapted.clusterStats);
      setActiveClusters(new Set(Object.keys(adapted.clusterStats)));
      setBrainStatus(status);
      if (adapted.nodes.length > 0) setSelectedNode(adapted.nodes[0]);
      setSidecarUnavailable(false);
      setLoading(false);
    };
    const commitFailure = () => {
      setLoading(false);
      if (paintedGraphRef.current) return;
      setBrainData(emptyAdaptedBrain());
      setClusterStats({});
      setActiveClusters(new Set());
      // Graph invoke/HTTP can time out while health() already proved the
      // sidecar is up (measured: Health 74%, 0 neurons). That is an empty
      // vault, not an unavailable sidecar.
      if (healthRef.current != null) {
        setSidecarUnavailable(false);
        setBrainStatus('live');
      } else {
        setSidecarUnavailable(true);
      }
    };
    if (isTauri) {
      if (!paintedGraphRef.current) setLoading(true);
      setSidecarUnavailable(false);
    }
    const outcome = await loadAdaptedBrainGraph({
      isTauri,
      scope: activeScope,
      platform,
      t,
      sidecarTimeoutMs: SIDECAR_TIMEOUT_MS,
    });
    if (cancelled.v) return;
    if (outcome.ok) commitSuccess(outcome.adapted, outcome.status);
    else commitFailure();
  }, [isTauri, platform, t]);

  // ── Sidecar recovery: manual "Réessayer" button + auto-retry target ──
  //
  // Explicitly restarts the brain sidecar (Tauri: clears any cached
  // .lazybrain-init-failed marker and re-runs stop/ensure_brain_init/start —
  // see brain_retry_sidecar in config.rs) instead of just re-fetching the
  // graph: if the sidecar process itself never came up (the actual failure
  // mode QA found — a large history-import's post-import `interlink`
  // maintenance pass racing the sidecar's own startup), re-running
  // loadGraphData alone would just fail the exact same way forever. Only on
  // a healthy restart does it reload the graph; a still-down sidecar leaves
  // sidecarUnavailable as-is so the error state (and the next auto-retry
  // tick) stays accurate.
  const retryConnection = useCallback(async () => {
    // Any fresh attempt (auto-retry tick or a manual "Réessayer" click)
    // hides a stale terminal message for the duration of the attempt —
    // it is re-set by the auto-retry loop itself if this was its final
    // bounded attempt, and never re-set here on a plain failure, so a
    // manual click after the auto-retry loop gave up does not immediately
    // re-show "could not restart" on every single failed click.
    setRetriesExhausted(false);
    if (!isTauri) {
      const cancelled = { v: false };
      await loadGraphData(cancelled);
      return;
    }
    setRetrying(true);
    try {
      const healthy = await platform.brain.retrySidecar();
      if (healthy) {
        const cancelled = { v: false };
        await loadGraphData(cancelled);
      }
    } catch (err) {
      console.warn('[BrainSpace] retrySidecar failed:', err);
    } finally {
      setRetrying(false);
    }
  }, [isTauri, platform, loadGraphData, setRetriesExhausted]);

  // Bounded auto-retry while the sidecar is reported unavailable: the
  // backend may simply have lost a one-shot race against a concurrent brain
  // maintenance pass (dream/prune/compress/interlink/profile-update — see
  // maintenance.rs) that has since finished, in which case a fresh restart
  // attempt self-heals the view with no user action. Exponential backoff
  // (4s, 8s, 16s, 32s, 60s, 60s — capped at AUTO_RETRY_MAX_DELAY_MS) instead
  // of a fixed interval: a truly dead process (killed sidecar, OOM, crashed
  // binary) is never worth hammering with a full respawn attempt every few
  // seconds, while a merely-slow one still gets checked quickly. Capped at
  // MAX_AUTO_RETRIES total attempts so a genuinely broken sidecar (missing
  // binary, etc.) doesn't retry forever — once exhausted, `retriesExhausted`
  // flips the overlay from the perpetual "reconnecting…" copy to an honest
  // terminal message; the "Réessayer" button keeps working (a fresh manual
  // click calls the exact same respawn path and, on failure, simply leaves
  // the terminal message in place — see retryConnection below).
  useEffect(() => {
    if (!isTauri || !sidecarUnavailable) return;
    const AUTO_RETRY_BASE_DELAY_MS = 4_000;
    const AUTO_RETRY_MAX_DELAY_MS = 60_000;
    const MAX_AUTO_RETRIES = 6;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const scheduleNext = () => {
      if (stopped) return;
      const delay = Math.min(
        AUTO_RETRY_BASE_DELAY_MS * 2 ** attempts,
        AUTO_RETRY_MAX_DELAY_MS,
      );
      timer = setTimeout(async () => {
        if (stopped) return;
        attempts += 1;
        await retryConnection();
        if (stopped) return;
        if (attempts >= MAX_AUTO_RETRIES) {
          setRetriesExhausted(true);
          return;
        }
        scheduleNext();
      }, delay);
    };
    scheduleNext();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [isTauri, sidecarUnavailable, retryConnection]);

  // Load graph once on mount; reload when Tauri scope flips. A previous
  // pair of effects both fired on Tauri mount (double graph fetch).
  useEffect(() => {
    const cancelled = { v: false };
    loadGraphData(cancelled, isTauri ? scope : undefined); // eslint-disable-line react-hooks/set-state-in-effect
    return () => { cancelled.v = true; };
  }, [loadGraphData, isTauri, scope]);

  // Prefetch the WebGL vault chunk while the sidecar graph fetch is in
  // flight so the first 3D frame is not gated on a second dynamic import.
  useEffect(() => {
    void import('../components/brain/BrainGraphWebGL');
  }, []);

  // Load brain health on mount (Tauri only)
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    withTimeout(platform.brain.health(), SIDECAR_TIMEOUT_MS, 'brain.health()').then((h) => {
      if (!cancelled) setHealth(h);
    }).catch(() => {
      if (!cancelled) setHealth(null);
    });
    return () => { cancelled = true; };
  }, [isTauri]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load brain path + resolution source on mount (Tauri only) — BRAIN-PATH
  // TRANSPARENCY. `info()` is a narrow addition on top of the native/web
  // Brain impls (see tauri.ts) rather than the shared Brain interface, so
  // it is accessed here via a local widened cast.
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    // BRAIN-PATH TRANSPARENCY hardening: fetchBrainInfo races get_brain_info
    // against BRAIN_INFO_TIMEOUT_MS so a stalled IPC bridge can't leave
    // brainInfo (and therefore GlobalBrainOverrideBadge) unresolved forever —
    // this effect never waits on graph()/graphAll()/health().
    fetchBrainInfo(platform).then((i) => {
      if (!cancelled) setBrainInfo(i);
    }).catch(() => {
      if (!cancelled) setBrainInfo(null);
    });
    return () => { cancelled = true; };
  }, [isTauri]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live refresh: listen for brain://updated + project://changed (Tauri only) ───
  useEffect(() => {
    if (!isTauri) return;

    const unlisteners: Array<() => void> = [];
    // STALE HEALTH BADGE FIX: health (like graph) was previously fetched
    // ONCE on mount and never again — after a later seed/rebuild actually
    // finishes, HealthBadge kept showing whatever (possibly 0/stale) score
    // it captured at that first fetch. Mirrors MemoryPanel.tsx's own
    // brain://updated listener (same fix, same event) and the mount health
    // effect above (same withTimeout/setHealth/cancelled-guard pattern).
    let healthCancelled = false;

    import('@tauri-apps/api/event').then(({ listen }) => {
      // Refresh graph when lazybrain rebuilds its index. If the sidecar was
      // last known unavailable, a plain graph re-fetch would just fail the
      // same way again when the sidecar process itself never came up — retry
      // starting the sidecar first (retryConnection reloads the graph itself
      // once healthy) instead. See sidecarUnavailableRef's doc comment.
      listen('brain://updated', () => {
        withTimeout(platform.brain.health(), SIDECAR_TIMEOUT_MS, 'brain.health()').then((h) => {
          if (!healthCancelled) setHealth(h);
        }).catch(() => {
          if (!healthCancelled) setHealth(null);
        });

        if (sidecarUnavailableRef.current) {
          retryConnection();
          return;
        }
        const cancelled = { v: false };
        loadGraphData(cancelled);
      }).then((fn) => {
        unlisteners.push(fn);
      }).catch((err: unknown) => {
        console.warn('[BrainSpace] listen brain://updated failed:', err);
      });

      // Refresh graph when the user switches to a different project
      listen('project://changed', () => {
        const cancelled = { v: false };
        // Small delay so the new sidecar has time to start
        setTimeout(() => loadGraphData(cancelled), 800);
      }).then((fn) => {
        unlisteners.push(fn);
      }).catch((err: unknown) => {
        console.warn('[BrainSpace] listen project://changed failed:', err);
      });
    }).catch((err: unknown) => {
      console.warn('[BrainSpace] @tauri-apps/api/event import failed:', err);
    });

    return () => {
      healthCancelled = true;
      unlisteners.forEach(fn => fn());
    };
  }, [isTauri, loadGraphData, retryConnection]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Subscribe to nav:focusBrainNode bus event ──────────────────
  useEffect(() => {
    const unsub = on('nav:focusBrainNode', (nodeId: string) => {
      // Try to find node by id first, then by name (wiki links emit target name)
      const byId = brainData.nodes.find((n) => n.id === nodeId);
      const byName = brainData.nodes.find((n) => n.name === nodeId);
      const target = byId ?? byName;
      if (target) {
        setSelectedNode(target);
        setFocusedNodeId(target.id);
      }
    });
    return unsub;
  }, [brainData.nodes]);

  // Build a Map for O(1) node lookups during link filtering instead of O(N) .find().
  // Declared before the effects/derived data that read it so the React Compiler
  // can preserve the memoization (no use-before-declare across a hook closure).
  const nodeMap = useMemo(
    () => new Map<string, AdaptedNode>(brainData.nodes.map((n) => [n.id, n])),
    [brainData.nodes],
  );

  // Load wiki payload when selected node changes
  useEffect(() => {
    if (!selectedNode) {
      setWikiPayload(null); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }
    const node = selectedNode;
    let cancelled = false;
    void loadWikiNote({
      nodeId: node.id,
      isTauri,
      t,
      links: brainData.links,
      nodes: brainData.nodes.map((n) => ({ id: n.id, name: n.name })),
      note: (id) => platform.brain.note(id),
      noteHtml: async (id) => (await platform.brain.noteHtml(id)) ?? '',
    }).then((payload) => {
      if (!cancelled) setWikiPayload(payload);
    });
    return () => { cancelled = true; };
  }, [selectedNode?.id, isTauri]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filter change handler from BrainControls ───────────────────
  const handleFilterChange = useCallback(
    (types: Set<NodeType>, clusters: Set<string>) => {
      setActiveTypes(new Set(types));
      setActiveClusters(new Set(clusters));
    },
    [],
  );

  // ── Search select handler from BrainControls ───────────────────
  const handleSearchSelect = useCallback((nodeId: string) => {
    emit('nav:focusBrainNode', nodeId);
  }, []);

  // ── Refresh the graph once background auto-indexing completes ──
  // Same reload-on-change pattern as the brain://updated listener above
  // (IndexingBanner owns the brain://indexing subscription itself; this is
  // just its "something changed, refetch" callback).
  const handleIndexingDone = useCallback(() => {
    const cancelled = { v: false };
    loadGraphData(cancelled);
  }, [loadGraphData]);

  // ── Filtered data for BrainGraph3D ─────────────────────────────
  const filteredNodes = brainData.nodes.filter(
    (n) => activeTypes.has(n.type) && activeClusters.has(n.cluster)
      && (filterIds === null || filterIds.has(n.id)),
  );
  const filteredData: AdaptedBrainData = {
    ...brainData,
    nodes: filteredNodes,
    links: brainData.links.filter((l) => {
      const src = nodeMap.get(l.source);
      const tgt = nodeMap.get(l.target);
      if (!src || !tgt) return false;
      return activeTypes.has(src.type) && activeClusters.has(src.cluster)
        && activeTypes.has(tgt.type) && activeClusters.has(tgt.cluster);
    }),
  };

  // ── Add neuron handler ─────────────────────────────────────────
  const handleAddNeuron = useCallback(
    async (title: string, text: string, kind: string) => {
      type CaptureKind = 'edit' | 'decision' | 'episodic' | 'agent' | 'commit';
      const validKinds: CaptureKind[] = ['edit', 'decision', 'episodic', 'agent', 'commit'];
      const safeKind: CaptureKind = validKinds.includes(kind as CaptureKind)
        ? (kind as CaptureKind)
        : 'decision';
      await platform.brain.capture({ kind: safeKind, title, text });
      // Trigger a graph refresh after capture
      const cancelled = { v: false };
      await loadGraphData(cancelled);
    },
    [platform, loadGraphData],
  );

  // ── BrainSetupCard handlers (empty-brain onboarding) ────────────
  //
  // "Utiliser un brain de projet" quick action: setConfig() persists the
  // choice + restarts the sidecar and returns the new resolved BrainInfo —
  // reflected immediately instead of waiting for a re-fetch, matching the
  // fetchBrainInfo effect's own honest-on-failure convention. The graph is
  // then reloaded so the card naturally disappears once the (re)configured
  // brain reports any neurons.
  const handleUseProjectBrain = useCallback(async () => {
    const updated = await (platform.brain as BrainWithSetup).setConfig({ mode: 'project' });
    setBrainInfo(updated);
    const cancelled = { v: false };
    await loadGraphData(cancelled);
  }, [platform, loadGraphData]);

  // Deliberately does NOT close the dialog — ImportBrainDialog shows its own
  // "Brain importé et activé : ..." success message (same convention as
  // PublishBrainDialog, which also stays open after a successful publish so
  // the user can read the result and dismiss it themselves via "Annuler").
  const handleImported = useCallback(() => {
    const cancelled = { v: false };
    loadGraphData(cancelled);
    fetchBrainInfo(platform).then((i) => setBrainInfo(i)).catch(() => {});
  }, [platform, loadGraphData]);

  const handleOpenSettings = useCallback(() => {
    emit('nav:navigateSpace', 'settings');
  }, []);

  // Seed-build banner: takes precedence over the connecting spinner /
  // sidecar-unavailable error / empty-brain setup card overlays below — see
  // the render branches further down, which now check showSeedBanner FIRST.
  // While a seed is actively building a currently-empty brain, the user
  // must see "Construction du Brain — X%" for the WHOLE build, not the
  // generic "Connexion au brain..." spinner or a false "sidecar
  // unavailable" error — the lazybrain sidecar legitimately only comes up
  // near the very end of the build (its own 'serving' phase, see
  // history_import.rs's run_post_seed_pipeline), so gating this banner
  // behind "sidecar reachable" (the old `!loading && !sidecarUnavailable`
  // condition here) hid it for nearly the whole build. Still scoped to the
  // empty-brain case (nodes.length === 0): a Settings-triggered reimport
  // into an ALREADY-populated brain never hits this condition
  // (brainData.nodes.length > 0 already), so it never hijacks the graph
  // view — HistoryReimportSection's own in-place Settings UI stays the
  // right place to watch that particular run. The reconnection machinery
  // (loading/sidecarUnavailable state, retryConnection, the bounded
  // auto-retry effect above) keeps running unchanged underneath this
  // banner regardless — it becomes visually relevant again the moment the
  // seed reaches 'serving' and seedState.active flips false.
  const sidecarHealthy = health != null;
  const overlay = brainOverlayFlags({
    seedActive: seedState.active,
    nodeCount: brainData.nodes.length,
    loading,
    sidecarHealthy,
    sidecarUnavailable,
  });
  const showSeedBanner = overlay.showSeedBanner;
  const showConnectingOverlay = overlay.showConnectingOverlay;
  const showSetupCard = overlay.showSetupCard;

  useEffect(() => {
    if (health == null) return;
    if (brainStatus === 'checking') setBrainStatus('live');
    if (sidecarUnavailable && !paintedGraphRef.current) setSidecarUnavailable(false);
  }, [health, brainStatus, sidecarUnavailable]);

  const clusters = Object.keys(brainData.clusterStats);
  const defaultNode = brainData.nodes[0] ?? null;
  const activeNode = selectedNode ?? defaultNode;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0,
        background: '#0E0E12',
      }}
    >
      <BrainSubHeader
        nodeCount={brainData.nodes.length}
        linkCount={brainData.links.length}
        scope={scope}
        brainStatus={brainStatus}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        health={health}
        brainInfo={brainInfo}
        onAddNeuron={() => setShowAddDialog(true)}
        onPublish={() => setShowPublishDialog(true)}
      />

      <SyncStatusBanner />
      <BrainTimeline nodes={brainData.nodes} />

      {/* Filter bar — Kind / Project / Author */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 20px', gap: 12, borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <BrainFilters onFilterIds={setFilterIds} />
      </div>

      {/* Body: Wikipedia-style reader (Wiki tab), the harness Rules/Skills
          panels, or the 3-column graph view. Rules/Skills are wrapped in a
          scrollable flex:1 shell (they don't set their own sizing, unlike
          WikiTab which owns its full-height layout internally). */}
      {view === 'wiki' ? (
        <WikiTab />
      ) : view === 'rules' ? (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <RulesPanel projectRoot={projectRoot || null} project={activeProjectId || undefined} />
        </div>
      ) : view === 'skills' ? (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <SkillsPanel />
        </div>
      ) : (
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <BrainControls
          clusters={clusters}
          onFilterChange={handleFilterChange}
          onSearchSelect={handleSearchSelect}
          paletteId={paletteId}
          onPaletteChange={setPaletteId}
          is3D={is3D}
          onIs3DChange={setIs3D}
          zoom={zoom}
          onZoomChange={setZoom}
        />
        {/* Brain graph with loading overlay — Three.js loaded lazily */}
        <div className="brain-stage" style={{ flex: 1, position: 'relative', display: 'flex', overflow: 'hidden' }}>
          <Suspense
            fallback={
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#04040A',
                  color: 'rgba(255,255,255,0.3)',
                  fontSize: 12,
                }}
              >
                <Spinner size={22} color="#7C5CFF" />
              </div>
            }
          >
            <BrainGraph3D
              data={filteredData}
              onSelectNode={setSelectedNode}
              focusedNodeId={focusedNodeId}
              paletteId={paletteId}
              is3D={is3D}
              timeIdx={timeIdx}
              zoom={zoom}
              onZoomChange={setZoom}
            />
          </Suspense>
          <BrainGraphHud />
          {/* Background auto-index progress — floats top-right, never
              blocks the canvas or competes with the setup card / overlays
              below for the same space. See index_project.rs on the Rust
              side for what emits brain://indexing. */}
          <IndexingBanner onIndexed={handleIndexingDone} />
          {/* Time-travel scrubber — floats bottom-center over the canvas
              only (not the filters/wiki columns), see TimelineScrubber.tsx.
              Reads the FULL (unfiltered) brainData.dateAxis: "how far back
              does this brain go" is a property of the whole brain, not of
              the currently active type/cluster filters. */}
          {overlay.showTimeline && (
            <TimelineScrubber dateAxis={brainData.dateAxis} timeIdx={timeIdx} onTimeIdxChange={setTimeIdx} />
          )}
          {/* Seed-build banner checked FIRST among the overlay branches
              below — see showSeedBanner's doc comment above: an active seed
              must win over the connecting spinner / sidecar-unavailable
              error / empty-brain setup card, regardless of sidecar
              connection state (loading/sidecarUnavailable keep updating
              underneath via the unchanged reconnection effects above; they
              only become visually relevant again once the seed finishes). */}
          {showSeedBanner && <SeedBuildBanner seedState={seedState} />}
          {showConnectingOverlay && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 12,
                background: 'rgba(4,4,10,0.7)',
                backdropFilter: 'blur(4px)',
                zIndex: 10,
              }}
            >
              <Spinner size={28} color="#7C5CFF" />
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
                {t('brain.connecting')}
              </span>
            </div>
          )}
          {overlay.showUnavailableOverlay && (
            <div
              data-testid="brain-sidecar-unavailable-overlay"
              style={{
                position: 'absolute',
                // Explicit top/right/bottom/left ALONGSIDE the `inset`
                // shorthand: belt-and-suspenders against this overlay ever
                // resolving to a zero-size layout box in the WebView2 host
                // (this is the exact overlay a QA pass found unmeasurable —
                // getBoundingClientRect() returning {width:0, height:0} —
                // even though it was plainly visible on screen). Both forms
                // compute to the same box in every Chromium-family engine,
                // so this changes nothing visually; it only removes any
                // reliance on `inset` alone being resolved.
                inset: 0,
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
                width: '100%',
                height: '100%',
                minWidth: 240,
                minHeight: 160,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                background: 'rgba(4,4,10,0.55)',
                zIndex: 10,
                padding: '0 32px',
                textAlign: 'center',
              }}
            >
              {retrying && <Spinner size={20} color="#FFC76B" />}
              <span style={{ fontSize: 12, color: '#FFC76B' }}>
                {t('settings.memory.health.sidecarUnavailable')}
              </span>
              {retrying && (
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
                  {t('brain.sidecar.reconnecting')}
                </span>
              )}
              {!retrying && retriesExhausted && (
                <span
                  data-testid="brain-sidecar-retries-exhausted"
                  style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}
                >
                  {t('brain.sidecar.retriesExhausted')}
                </span>
              )}
              <button
                data-testid="brain-sidecar-retry-btn"
                onClick={() => { void retryConnection(); }}
                disabled={retrying}
                style={{
                  padding: '6px 16px',
                  minWidth: 96,
                  minHeight: 32,
                  background: retrying ? 'rgba(124,92,255,0.4)' : '#7C5CFF',
                  border: 'none',
                  borderRadius: 7,
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: retrying ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: retrying ? 0.7 : 1,
                }}
              >
                {t('common.retry')}
              </button>
            </div>
          )}
          {showSetupCard && (
            <BrainSetupCard
              onUseProjectBrain={handleUseProjectBrain}
              onOpenImport={() => setShowImportDialog(true)}
              onOpenSettings={handleOpenSettings}
              projectRoot={projectRoot}
              onReloadGraph={() => { const c = { v: false }; loadGraphData(c); }}
            />
          )}
        </div>
        <BrainWiki
          node={activeNode}
          wikiPayload={wikiPayload}
          clusterStats={clusterStats}
        />
      </div>
      )}

      {showAddDialog && (
        <AddNeuronDialog
          onClose={() => setShowAddDialog(false)}
          onSubmit={handleAddNeuron}
        />
      )}

      {showPublishDialog && (
        <PublishBrainDialog
          brainInfo={brainInfo}
          onClose={() => setShowPublishDialog(false)}
        />
      )}

      {showImportDialog && (
        <ImportBrainDialog
          onClose={() => setShowImportDialog(false)}
          onImported={handleImported}
        />
      )}

      <LateJoinerTour />
    </div>
  );
}
