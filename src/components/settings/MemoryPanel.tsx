/* MemoryPanel — brain path display, scopes toggle, rebuild + audit actions,
   brain projects editor, embeddings toggle, memory health section, brain
   setup UI (scope choice + GitHub import).
   All state is derived from the LazyBrain sidecar path stored by the platform.

   platform methods used:
   - health()             — sidecar/service health (HealthReport.brain: ok/down/unknown)
   - brain.health()       — brain quality metrics (BrainHealth | null)
   - brain.rebuildGraph() — rebuild brain index
   - brain.getProjects()  — list registered project root paths
   - brain.setProjects()  — persist project root paths
   - brain.info()         — resolved brain path + resolution source (BrainInfo;
                            see tauri.ts's BRAIN-PATH TRANSPARENCY note) —
                            BRAIN-PATH TRANSPARENCY: real path/source instead
                            of the old static placeholder.
   - brain.setConfig()    — natural, UI-driven brain SCOPE choice (project /
                            global / custom folder) — no environment variable
                            required. Narrow addition, see BrainWithSetup cast
                            near BrainConfigSection below.
   - brain.importFromGithub() — clone a shared/published brain repo and set
                            it active. Same narrow-cast convention.

   Consolidate now (handleConsolidateNow, below) is the one exception to the
   "go through platform.brain.*" convention above: it calls
   `@tauri-apps/api/core`'s invoke('brain_consolidate_now') directly via a
   dynamic import (same pattern already used for `@tauri-apps/api/event`
   just below) because src/lib/platform is a different work-stream's
   ownership boundary on this codebase, not because direct invoke is
   preferred in general — prefer adding a platform.brain method for any
   FUTURE brain command instead of repeating this bypass.

   Sidecar independence: BrainPathSection's brain.info() fetch is entirely
   decoupled from MemoryHealthSection's health()/brain.health() fetch — each
   owns its own loading state, so the sidecar being down/slow/unreachable
   never blocks the brain-path label or the env-override callout from
   rendering. Both fetches race against a timeout (see "Timeout helpers"
   below) instead of spinning on "Chargement..." forever.

   Health/live consistency: MemoryHealthSection's "Sidecar: ..." status must
   never disagree with BrainSpace's "live" badge for the same brain. Both
   now fall back to the SAME reachability probe (brain.graph(), which
   resolves the dynamic sidecar port on the Rust side — see lib.rs's
   brain_fetch_graph/get_brain_port) before declaring the sidecar down, so a
   slower/unrelated health-specific command can no longer make Settings say
   "indisponible" while BrainSpace shows a live graph for the exact same
   brain.

   Cross-section refresh: BrainConfigSection/BrainImportSection bump a
   `brainVersion` counter (owned by MemoryPanel) whenever they successfully
   change which brain is active. BrainPathSection/BrainPublishSection/
   MemoryHealthSection take that counter as a `refreshKey` prop and include
   it in their fetch effect's dependency array, so the rest of the panel
   reflects a scope change or a GitHub import without needing to remount.
*/

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getPlatform } from '../../lib/platform';
import type { Brain, BrainHealth, HealthDetailCategory, HealthDetailResult, HealthStatus, HistorySource, Platform, SeedEstimate, SeedProgressEvent } from '../../lib/platform/types';
// BrainInfo (path + resolution source) is intentionally not part of the
// shared Brain interface above — see tauri.ts's "BRAIN-PATH TRANSPARENCY"
// note. Imported here only for the local `Brain & { info(): ... }` narrow
// cast used by BrainPathSection below.
import type { BrainInfo, BrainPublishOptions, BrainPublishResult } from '../../lib/platform/tauri';
import { useI18n } from '../../i18n';
import { pluralKey } from '../../i18n/plural';
import { SeedProgress } from '../brain/SeedProgress';

// ── localStorage keys (public contract for other modules) ──────────
// lazy.memory.scopesEnabled  — boolean (default: true)
//
// NOTE: lazy.brain.embeddings (a semantic-recall on/off toggle) used to live
// here and has been REMOVED — it was never read by any Rust command or the
// sidecar spawn path (LAZYBRAIN_EMBEDDINGS=1 is hardcoded at every spawn
// site regardless of this key), so the toggle controlled nothing real. See
// the "Semantic recall status" block in MemoryPanel below, which replaces
// it with an honest read-only status instead of a misleading control.

const LS_SCOPES_KEY = 'lazy.memory.scopesEnabled';

function loadScopesEnabled(): boolean {
  try {
    const raw = localStorage.getItem(LS_SCOPES_KEY);
    if (raw !== null) return raw === 'true';
  } catch {
    // localStorage unavailable
  }
  return true;
}

function saveScopesEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LS_SCOPES_KEY, String(enabled));
  } catch {
    // localStorage unavailable
  }
}

// ── Timeout helpers (BRAIN-PATH TRANSPARENCY hardening) ─────────────
//
// brain.info() (get_brain_info) is documented as a fast, Rust-only path
// computation that does NOT depend on the LazyBrain sidecar being up — but
// the underlying Tauri invoke() call has no built-in timeout, so a stalled
// IPC bridge must not leave BrainPathSection spinning on "Chargement..."
// forever (see BrainPathSection/BrainPublishSection below). Sidecar-backed
// calls (health(), brain.health()) get a longer timeout since they cross an
// HTTP boundary to the sidecar and may legitimately take longer to settle —
// but they must not spin forever either, and their failure/slowness must
// never block the (independent) brain-path display or its badges.
//
// Exported so both this module's own behavior and the timeout mechanism
// itself can be asserted directly from MemoryPanel.test.tsx.

export const BRAIN_INFO_TIMEOUT_MS = 5_000;
export const SIDECAR_TIMEOUT_MS = 9_000;

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Races `promise` against a timer; rejects with a TimeoutError if `ms`
    elapses first. Never cancels the underlying `promise` — a late result is
    simply ignored by callers via their own `cancelled` guard. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Shared brain.info() fetch with a timeout guard — used by both
    BrainPathSection and BrainPublishSection below. Each keeps its own
    component-local state (see BrainPublishSection's comment for why they
    aren't lifted to one shared parent state); only the fetch itself is
    shared here. */
function fetchBrainInfo(platform: Platform): Promise<BrainInfo> {
  return withTimeout(
    (platform.brain as Brain & { info(): Promise<BrainInfo> }).info(),
    BRAIN_INFO_TIMEOUT_MS,
    'brain.info()',
  );
}

// ── MemoryHealthSection ────────────────────────────────────────────
//
// TASK 3 (legibility): formatProportion turns a bare integer ("3047") into
// an interpretable proportion ("3047 / 53268 (5.7%)") given its real
// denominator. Exported for direct unit testing (MemoryPanel.test.tsx).

/**
 * Formats `count` against `total` as "count / total (pct%)". Degrades
 * gracefully to a bare count (no fabricated denominator) when `total` is
 * undefined or 0 — matches BrainHealth.totalNotes/totalLinks being optional
 * (absent on an older cached _index.html that predates these fields).
 * Percentages under 10% keep one decimal place (matches the observed
 * "5.7%" example); 10% and over round to a whole number to stay compact.
 */
export function formatProportion(count: number, total: number | undefined): string {
  if (total === undefined || total <= 0) return String(count);
  const pct = (count / total) * 100;
  const pctText = pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
  return `${count} / ${total} (${pctText}%)`;
}

function statusColor(status: HealthStatus): string {
  if (status === 'ok') return '#4ADE80';
  if (status === 'down') return '#F87171';
  return 'rgba(255,255,255,0.35)';
}

function statusLabelKey(status: HealthStatus): string {
  if (status === 'ok') return 'settings.memory.status.active';
  if (status === 'down') return 'settings.memory.status.down';
  return 'settings.memory.status.unknown';
}

function HealthDot({ status }: { status: HealthStatus }) {
  const { t } = useI18n();
  return (
    <span
      aria-label={t('settings.memory.sidecarAria', { status: t(statusLabelKey(status)) })}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: statusColor(status),
        flexShrink: 0,
      }}
    />
  );
}

function MemoryHealthSection({ refreshKey }: { refreshKey: number }) {
  const { t } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [sidecarStatus, setSidecarStatus] = useState<HealthStatus>('unknown');
  // Start loading only when on Tauri — web has no async health to fetch.
  const [loadingSidecar, setLoadingSidecar] = useState(isTauri);
  // True once health() has rejected OR timed out (and the graph() fallback
  // below also failed) — an honest "couldn't reach it" signal distinct from
  // sidecarStatus === 'down' (which can also mean "checked successfully,
  // and it happens to report down"), so we can replace an infinite
  // common.loading spinner with a clear message instead.
  const [sidecarUnavailable, setSidecarUnavailable] = useState(false);

  const [brainHealth, setBrainHealth] = useState<BrainHealth | null>(null);
  const [loadingBrainHealth, setLoadingBrainHealth] = useState(isTauri);
  // True once brain.health() has rejected, timed out, or resolved to null
  // (no metrics computed yet) — mirrors sidecarUnavailable's honesty
  // convention for this independent sub-fetch.
  const [brainHealthUnavailable, setBrainHealthUnavailable] = useState(false);

  // TASK 2 (remediation UI): read-only "view details" dry-run for one
  // actionable metric (orphans / brokenLinks / dupes) — see DetailPanel
  // below. `detailCategory === null` means the panel is closed; opening a
  // different category while one is already open replaces it (only one
  // dry-run shown at a time).
  const [detailCategory, setDetailCategory] = useState<HealthDetailCategory | null>(null);
  const [detailResult, setDetailResult] = useState<HealthDetailResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const handleViewDetail = useCallback(async (category: HealthDetailCategory) => {
    setDetailCategory(category);
    setDetailResult(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const result = await (platform.brain as Brain & { healthDetail(c: HealthDetailCategory): Promise<HealthDetailResult> })
        .healthDetail(category);
      setDetailResult(result);
    } catch (err: unknown) {
      setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  }, [platform]);

  const handleCloseDetail = useCallback(() => {
    setDetailCategory(null);
    setDetailResult(null);
    setDetailError(null);
  }, []);

  // HEALTH PANEL METRICS (decoupled sub-fetches): health() and
  // brain.health() are fetched INDEPENDENTLY — each has its own
  // loading/unavailable state and renders as soon as ITS OWN data is ready.
  // Previously both were awaited together via Promise.all, so a slow/failed
  // health() hid brain.health()'s metrics grid even when brain.health()
  // itself had already resolved successfully (QA: "Santé de la mémoire"
  // grid vanishes). Bundled in one effect (not two) only because they share
  // the same [isTauri, refreshKey] trigger — each fetch function below is
  // still fully independent and sets only its own state.
  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;

    async function fetchSidecarStatus() {
      try {
        const report = await withTimeout(platform.health(), SIDECAR_TIMEOUT_MS, 'sidecar health');
        if (!cancelled) {
          setSidecarStatus(report.brain);
          setSidecarUnavailable(false);
        }
      } catch {
        // health() rejected or timed out — before declaring the sidecar
        // down, cross-check with the SAME reachability signal BrainSpace's
        // graph load treats as proof of a live brain: brain.graph(), which
        // resolves through Rust's dynamic sidecar-port tracking (see
        // lib.rs's brain_fetch_graph/get_brain_port). Without this
        // fallback, Settings could say "indisponible" for the exact brain
        // BrainSpace is showing as live, because health() and graph() are
        // backed by different Rust commands that can drift out of sync
        // (e.g. one reads a static index.html meta tag, the other hits the
        // sidecar HTTP port directly).
        // Declared without an initializer: both the try and catch arms below
        // assign it before it's read, so a `= false` default here was never
        // actually read (no-useless-assignment lint violation).
        let reachable: boolean;
        try {
          await withTimeout(platform.brain.graph(), SIDECAR_TIMEOUT_MS, 'brain.graph() (health fallback)');
          reachable = true;
        } catch {
          reachable = false;
        }
        if (!cancelled) {
          setSidecarStatus(reachable ? 'ok' : 'down');
          setSidecarUnavailable(!reachable);
        }
      } finally {
        if (!cancelled) setLoadingSidecar(false);
      }
    }

    async function fetchBrainHealth() {
      try {
        const bHealth = await withTimeout(platform.brain.health(), SIDECAR_TIMEOUT_MS, 'brain.health()');
        if (!cancelled) {
          setBrainHealth(bHealth);
          setBrainHealthUnavailable(bHealth === null);
        }
      } catch {
        if (!cancelled) {
          setBrainHealth(null);
          setBrainHealthUnavailable(true);
        }
      } finally {
        if (!cancelled) setLoadingBrainHealth(false);
      }
    }

    fetchSidecarStatus();
    fetchBrainHealth();
    return () => { cancelled = true; };
  }, [isTauri, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isTauri) {
    return (
      <div style={{
        padding: 14,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 2 }}>
          {t('settings.memory.health.title')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('settings.memory.health.webSim')}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: 14,
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 2 }}>
        {t('settings.memory.health.title')}
      </div>

      {/* Sidecar status — independent of the metrics grid below. */}
      {loadingSidecar ? (
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('common.loading')}</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <HealthDot status={sidecarStatus} />
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              {t('settings.memory.sidecar')}:{' '}
              <span style={{ color: statusColor(sidecarStatus), fontWeight: 500 }}>
                {t(statusLabelKey(sidecarStatus))}
              </span>
            </span>
          </div>

          {/* Honest error state — sidecar unreachable (rejected or timed
              out after SIDECAR_TIMEOUT_MS) instead of an infinite spinner. */}
          {sidecarUnavailable && (
            <div style={{ fontSize: 10, color: 'rgba(255,199,107,0.8)', lineHeight: 1.5 }}>
              {t('settings.memory.health.sidecarUnavailable')}
            </div>
          )}
        </>
      )}

      {/* BrainHealth metrics list — independent of the sidecar-status fetch
          above: a slow/failed health() no longer hides these numbers, and a
          slow/failed brain.health() no longer hides the sidecar status.
          TASK 3 (legibility/layout): a single-column list, not a 2-column
          grid — the old grid's per-cell `justify-content: space-between`
          pushed the RIGHT column's values against the card's far edge while
          the LEFT column's values stopped at the grid's own midpoint,
          reading as broken alignment. A single column gives every row the
          SAME right edge, so each label/value pair (and its optional
          "view details" action) stays visually grouped as one unit. */}
      {loadingBrainHealth ? (
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('common.loading')}</div>
      ) : brainHealth !== null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
          <MetricRow label={t('settings.memory.metric.score')} value={`${Math.round(brainHealth.score)} / 100`} />
          <MetricRow
            label={t('settings.memory.metric.orphans')}
            value={formatProportion(brainHealth.orphans, brainHealth.totalNotes)}
            warn={brainHealth.orphans > 0}
            onViewDetails={brainHealth.orphans > 0 ? () => handleViewDetail('orphans') : undefined}
            viewDetailsLabel={t('settings.memory.detail.viewButton')}
          />
          <MetricRow
            label={t('settings.memory.metric.brokenLinks')}
            value={formatProportion(brainHealth.brokenLinks, brainHealth.totalLinks)}
            warn={brainHealth.brokenLinks > 0}
            onViewDetails={brainHealth.brokenLinks > 0 ? () => handleViewDetail('brokenLinks') : undefined}
            viewDetailsLabel={t('settings.memory.detail.viewButton')}
          />
          <MetricRow label={t('settings.memory.metric.stale')} value={formatProportion(brainHealth.stale, brainHealth.totalNotes)} warn={brainHealth.stale > 0} />
          <MetricRow
            label={t('settings.memory.metric.dupes')}
            value={formatProportion(brainHealth.dupes, brainHealth.totalNotes)}
            warn={brainHealth.dupes > 0}
            onViewDetails={brainHealth.dupes > 0 ? () => handleViewDetail('duplicates') : undefined}
            viewDetailsLabel={t('settings.memory.detail.viewButton')}
          />
        </div>
      ) : brainHealthUnavailable ? (
        <div style={{ fontSize: 10, color: 'rgba(255,199,107,0.8)', lineHeight: 1.5 }}>
          {t('settings.memory.health.metricsUnavailable')}
        </div>
      ) : null}

      {/* TASK 2 (remediation UI): read-only dry-run breakdown, opened by the
          "view details" button on an actionable metric row above. */}
      {detailCategory && (
        <DetailPanel
          category={detailCategory}
          result={detailResult}
          loading={detailLoading}
          error={detailError}
          onClose={handleCloseDetail}
        />
      )}
    </div>
  );
}

function MetricRow({
  label,
  value,
  warn = false,
  muted = false,
  onViewDetails,
  viewDetailsLabel,
}: {
  label: string;
  value: string;
  warn?: boolean;
  muted?: boolean;
  /** Present only for actionable metrics (orphans/brokenLinks/dupes) with a
   *  non-zero count — opens the read-only dry-run breakdown (DetailPanel). */
  onViewDetails?: () => void;
  viewDetailsLabel?: string;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '3px 0',
    }}>
      {/* Label + value grouped tightly together (Task 3's "visually
          associated" fix) instead of being pushed to opposite ends of the
          row by justify-content: space-between. */}
      <span style={{ fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: 11,
        fontWeight: 500,
        color: warn ? '#FBBF24' : muted ? 'var(--color-text-muted)' : 'var(--color-text)',
        fontStyle: muted ? 'italic' : 'normal',
        fontFamily: 'var(--font-mono, monospace)',
      }}>
        {value}
      </span>
      {onViewDetails && (
        <button
          onClick={onViewDetails}
          style={{
            marginLeft: 'auto',
            padding: '2px 8px',
            background: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: 5,
            color: 'var(--color-accent-light)',
            fontSize: 10,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
            flexShrink: 0,
          }}
        >
          {viewDetailsLabel}
        </button>
      )}
    </div>
  );
}

// ── DetailPanel (TASK 2 — read-only dry-run breakdown) ──────────────
//
// Shows EXACTLY what a metric counts — never mutates the brain. This is
// deliberately the "report" half of remediation only: "Give each actionable
// metric an action that fixes it" is satisfied here by a truthful preview
// (what/how many), not a button that silently merges/deletes content in an
// irreplaceable ~7500-note personal brain. The apply/repair step (actually
// merging duplicates, pruning dangling links, removing orphan notes) is a
// separate, larger, destructive change intentionally left as a follow-up —
// see this component's use of applyFollowUp copy below.

const DETAIL_CATEGORY_TITLE_KEY: Record<HealthDetailCategory, string> = {
  orphans: 'settings.memory.detail.title.orphans',
  brokenLinks: 'settings.memory.detail.title.brokenLinks',
  duplicates: 'settings.memory.detail.title.duplicates',
};

function DetailPanel({
  category,
  result,
  loading,
  error,
  onClose,
}: {
  category: HealthDetailCategory;
  result: HealthDetailResult | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();

  return (
    <div style={{
      marginTop: 6,
      padding: 10,
      background: 'var(--color-panel)',
      border: '1px solid var(--color-border)',
      borderRadius: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>
          {t(DETAIL_CATEGORY_TITLE_KEY[category])}
        </span>
        <button
          onClick={onClose}
          style={{
            padding: '2px 8px',
            background: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: 5,
            color: 'var(--color-text-muted)',
            fontSize: 10,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {t('common.close')}
        </button>
      </div>

      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
        {t('settings.memory.detail.readOnlyNote')}
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('common.loading')}</div>
      ) : error ? (
        <div style={{ fontSize: 11, color: '#F87171' }}>{t('settings.memory.detail.error', { msg: error })}</div>
      ) : result ? (
        <DetailPanelBody result={result} />
      ) : null}

      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', fontStyle: 'italic', lineHeight: 1.5 }}>
        {t('settings.memory.detail.applyFollowUp')}
      </div>
    </div>
  );
}

function DetailPanelBody({ result }: { result: HealthDetailResult }) {
  const { t } = useI18n();

  const items: string[] = [];
  if (result.category === 'orphans' && result.orphans) {
    for (const o of result.orphans) items.push(`${o.title} (#${o.id})`);
  } else if (result.category === 'brokenLinks' && result.brokenLinks) {
    for (const l of result.brokenLinks) items.push(`${l.fromTitle} (#${l.fromId}) → ${l.toId}`);
  } else if (result.category === 'duplicates' && result.duplicates) {
    for (const d of result.duplicates) items.push(`${d.title} — ${d.noteIds.map((id) => `#${id}`).join(', ')}`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--color-text)', fontWeight: 500 }}>
        {t('settings.memory.detail.count', { count: result.total })}
      </div>
      {items.length > 0 ? (
        <div style={{
          maxHeight: 180,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          padding: '6px 8px',
          background: 'var(--color-panel-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
        }}>
          {items.map((line, i) => (
            <div key={i} style={{ fontSize: 10.5, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}>
              {line}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('settings.memory.detail.empty')}
        </div>
      )}
      {result.truncated && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
          {t('settings.memory.detail.truncated', { shown: result.shown, total: result.total })}
        </div>
      )}
    </div>
  );
}

// ── BrainStatsSection (diagnostics: routing / latency / injected tokens) ─
//
// Surfaces the bundled engine `stats` command (Rust: brain_stats, which spawns
// `lazybrain stats` with the brain path pinned) — totals, L1-L4 router
// distribution, p50 latencies and avg injected tokens. Compact dark card next
// to the health badge. Calls invoke('brain_stats') directly via a dynamic
// import for the SAME reason handleConsolidateNow does (src/lib/platform is a
// different work-stream's ownership boundary — see this file's top doc
// comment). FAIL-SOFT: any error/timeout, or a fresh brain with no telemetry,
// degrades to a muted dash — it never throws out of the panel.

/** Shape of engine/src/commands/stats.ts `runStats` output. All fields
    optional here: this crosses an IPC boundary, so it is validated/guarded
    rather than trusted. */
interface BrainStatsData {
  window_hours?: number;
  totals?: { notes_total?: number; notes_active?: number; notes_invalidated?: number };
  by_type?: Array<{ type?: string; n?: number }>;
  queries_total?: number;
  routing_distribution_pct?: Record<string, string>;
  l1_routing_rate_pct?: string;
  latency_p50_ms_by_level?: Record<string, number>;
  captures_count?: number;
  avg_inject_tokens?: number;
}

/** Narrow an untrusted invoke() result to BrainStatsData — the router
    distribution is the one field runStats always emits, so its presence is a
    sufficient, cheap shape check. */
function isBrainStatsData(v: unknown): v is BrainStatsData {
  return typeof v === 'object' && v !== null && 'routing_distribution_pct' in v;
}

const ROUTER_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const;

function BrainStatsSection({ refreshKey }: { refreshKey: number }) {
  const { t } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [stats, setStats] = useState<BrainStatsData | null>(null);
  const [loading, setLoading] = useState(isTauri);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    // `loading` starts true (initial state = isTauri) and is only ever
    // cleared here — on a refreshKey bump the previous stats stay visible
    // until the new fetch resolves, matching BrainPathSection's convention
    // (avoids a synchronous setState-in-effect flash).
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const raw = await invoke<unknown>('brain_stats');
        if (!cancelled) setStats(isBrainStatsData(raw) ? raw : null);
      } catch {
        // Missing engine / spawn / parse failure — degrade to a dash, never
        // crash the panel (matches brain_stats' fail-soft Rust contract).
        if (!cancelled) setStats(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isTauri, refreshKey]);

  if (!isTauri) return null;

  const cardStyle: React.CSSProperties = {
    padding: 14,
    background: 'var(--color-panel-2)',
    border: '1px solid var(--color-border)',
    borderRadius: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  };

  // A fresh brain that has served no queries yet has 0.0% across every router
  // level, no latency samples and 0 avg-injected tokens — all real, but they
  // read as "broken" in the UI. When there are no queries, show a muted
  // "awaiting queries" placeholder for those query-derived rows instead of a
  // wall of zeros. Notes totals are independent of query traffic, so they keep
  // showing their real count.
  const hasQueries = (stats?.queries_total ?? 0) > 0;
  const awaitingPlaceholder = t('settings.memory.stats.awaitingQueries');
  const routing = stats
    ? ROUTER_LEVELS.map((l) => `${l} ${stats.routing_distribution_pct?.[l] ?? '0.0'}%`).join('   ·   ')
    : '';
  const latencyEntries = stats ? Object.entries(stats.latency_p50_ms_by_level ?? {}) : [];
  const latency = latencyEntries.length
    ? latencyEntries.map(([l, ms]) => `${l} ${ms}ms`).join('   ·   ')
    : '—';
  const notesActive = stats?.totals?.notes_active ?? 0;
  const notesTotal = stats?.totals?.notes_total ?? 0;

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text)', marginBottom: 2 }}>
        {t('settings.memory.stats.title')}
      </div>

      {loading ? (
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('common.loading')}</div>
      ) : stats ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.stats.window', { hours: stats.window_hours ?? 24 })}
          </div>
          <MetricRow label={t('settings.memory.stats.routing')} value={hasQueries ? (routing || '—') : awaitingPlaceholder} muted={!hasQueries} />
          <MetricRow label={t('settings.memory.stats.latency')} value={hasQueries ? latency : awaitingPlaceholder} muted={!hasQueries} />
          <MetricRow label={t('settings.memory.stats.avgInject')} value={hasQueries ? String(stats.avg_inject_tokens ?? 0) : awaitingPlaceholder} muted={!hasQueries} />
          <MetricRow label={t('settings.memory.stats.queries')} value={String(stats.queries_total ?? 0)} />
          <MetricRow label={t('settings.memory.stats.notes')} value={`${notesActive} / ${notesTotal}`} />
        </div>
      ) : (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('settings.memory.stats.unavailable')}
        </div>
      )}
    </div>
  );
}

// ── BrainPathSection (BRAIN-PATH TRANSPARENCY) ──────────────────────
//
// Shows the REAL resolved brain path plus which resolution branch produced
// it, via platform.brain.info() (Rust: get_brain_info / resolve_unified_
// brain_path). Replaces the old static placeholder that always said
// "Configuré via le sidecar LazyBrain..." regardless of what brain was
// actually in use — in particular it never revealed that LAZYBRAIN_BRAIN_PATH
// can silently override every project's brain with one shared global brain.

/** Human-readable "<label>: <path>" for a resolved BrainInfo, per source. */
function describeBrainInfo(
  info: BrainInfo,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (info.source === 'env_override') {
    return t('settings.memory.brainPath.sourceEnvOverride', { path: info.path });
  }
  if (info.source === 'project') {
    return t('settings.memory.brainPath.sourceProject', { path: info.path });
  }
  return t('settings.memory.brainPath.sourceDefault', { path: info.path });
}

function BrainPathSection({ refreshKey }: { refreshKey: number }) {
  const { t } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [info, setInfo] = useState<BrainInfo | null>(null);
  const [loading, setLoading] = useState(isTauri);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    // BRAIN-PATH TRANSPARENCY hardening: fetchBrainInfo races get_brain_info
    // against BRAIN_INFO_TIMEOUT_MS so a stalled IPC bridge can't leave this
    // section on "Chargement..." forever — this loading state is scoped to
    // brain.info() ONLY and never waits on health()/graph()/search().
    fetchBrainInfo(platform)
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch(() => {
        // Covers both a real rejection and a timeout — either way, fall
        // back to the static placeholder below instead of spinning forever.
        if (!cancelled) setInfo(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [isTauri, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  let displayText: string;
  if (!isTauri) {
    displayText = t('settings.memory.brainPath.web');
  } else if (loading) {
    displayText = t('common.loading');
  } else if (info) {
    displayText = describeBrainInfo(info, t);
  } else {
    displayText = t('settings.memory.brainPath.tauri');
  }

  return (
    <div style={{
      padding: 16,
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
        {t('settings.memory.brainPath')}
      </div>
      <div style={{
        padding: '7px 10px',
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        fontSize: 12,
        color: 'var(--color-text-muted)',
        fontFamily: 'var(--font-mono, monospace)',
        wordBreak: 'break-all',
      }}>
        {displayText}
      </div>

      {/* Global-override callout — same visual treatment as the embeddings
          warning below, so a shared/global brain is never mistaken for a
          brain private to this project. */}
      {isTauri && info?.source === 'env_override' && (
        <div style={{
          marginTop: 8,
          padding: '6px 10px',
          background: 'rgba(255,199,107,0.07)',
          border: '1px solid rgba(255,199,107,0.2)',
          borderRadius: 5,
          fontSize: 10,
          color: 'rgba(255,199,107,0.8)',
          lineHeight: 1.5,
        }}>
          {t('settings.memory.brainPath.envOverrideWarning')}
        </div>
      )}
    </div>
  );
}

// ── BrainPublishSection ("Publier le brain sur GitHub") ──────────────
//
// Restores the old solo-brain convention (the brain is its own git repo you
// can push to GitHub and share/publish) from inside the IDE. Uses
// platform.brain.info() (same as BrainPathSection above — fetched
// independently here rather than lifted to a shared parent state, to avoid
// touching BrainPathSection's existing behavior/tests) plus the new
// platform.brain.publishGithub() stub (see tauri.ts — Rust command
// brain_publish_github). Copy is routed through the i18n locale files
// (settings.memory.publish.*), matching the env_override warning callout
// above for the same brain-path-transparency feature family.

function BrainPublishSection({ refreshKey }: { refreshKey: number }) {
  const { t } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [info, setInfo] = useState<BrainInfo | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<BrainPublishResult | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    fetchBrainInfo(platform)
      .then((i) => { if (!cancelled) setInfo(i); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [isTauri, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const isPersonalBrain = info?.source === 'env_override';

  async function handlePublish() {
    setPublishing(true);
    setResult(null);
    try {
      const res = await (
        platform.brain as Brain & { publishGithub(opts?: BrainPublishOptions): Promise<BrainPublishResult> }
      ).publishGithub({ remoteUrl: remoteUrl.trim() || undefined });
      setResult(res);
    } catch (err: unknown) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPublishing(false);
    }
  }

  if (!isTauri) {
    return (
      <div style={{
        padding: 16,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
          {t('settings.memory.publish.titleShort')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('settings.memory.webUnavailableNative')}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: 16,
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
            {t('settings.memory.publish.title')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.publish.description')}
          </div>
        </div>
        {!expanded && (
          <button
            onClick={() => setExpanded(true)}
            style={{
              padding: '8px 14px',
              background: 'var(--color-accent-soft)',
              border: '1px solid var(--color-accent-border)',
              borderRadius: 7,
              color: 'var(--color-accent-light)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {t('settings.memory.publish.titleShort')}
          </button>
        )}
      </div>

      {expanded && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          paddingTop: 8,
          borderTop: '1px solid var(--color-border)',
        }}>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.publish.brainToPublishLabel')}{' '}
            <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text)', wordBreak: 'break-all' }}>
              {info?.path ?? '…'}
            </span>
          </div>

          {isPersonalBrain && (
            <div style={{
              padding: '8px 10px',
              background: 'rgba(255,199,107,0.08)',
              border: '1px solid rgba(255,199,107,0.3)',
              borderRadius: 6,
              fontSize: 11,
              color: 'rgba(255,199,107,0.9)',
              lineHeight: 1.5,
            }}>
              {t('settings.memory.publish.personalBrainWarning')}
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, color: 'var(--color-text-muted)' }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              {t('settings.memory.publish.confirmLabel')}{isPersonalBrain ? t('settings.memory.publish.confirmPersonalSuffix') : ''}.
            </span>
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{
              fontSize: 10,
              color: 'var(--color-text-muted)',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
              {t('settings.memory.githubUrlLabel')}
            </label>
            <input
              type="text"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder={t('settings.memory.publish.urlPlaceholder')}
              style={{
                background: 'var(--color-panel)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                padding: '7px 10px',
                fontSize: 11,
                color: 'var(--color-text)',
                fontFamily: 'var(--font-mono, monospace)',
                outline: 'none',
              }}
            />
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              {t('settings.memory.publish.cliHint')}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handlePublish}
              disabled={publishing || !confirmed}
              style={{
                padding: '8px 14px',
                background: publishing || !confirmed ? 'rgba(124,92,255,0.3)' : 'var(--color-accent-soft)',
                border: '1px solid var(--color-accent-border)',
                borderRadius: 7,
                color: 'var(--color-accent-light)',
                fontSize: 12,
                fontWeight: 500,
                cursor: publishing || !confirmed ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {publishing ? t('settings.memory.publish.publishingButton') : t('settings.memory.publish.publishButton')}
            </button>
            <button
              onClick={() => { setExpanded(false); setResult(null); }}
              disabled={publishing}
              style={{
                padding: '8px 14px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 7,
                color: 'var(--color-text-muted)',
                fontSize: 12,
                fontWeight: 500,
                cursor: publishing ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('common.cancel')}
            </button>
          </div>

          {result && (
            <div style={{
              fontSize: 11,
              lineHeight: 1.5,
              padding: '8px 10px',
              borderRadius: 6,
              background: result.ok ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
              border: `1px solid ${result.ok ? '#4ADE80' : '#F87171'}44`,
              color: result.ok ? '#4ADE80' : '#F87171',
            }}>
              {result.ok && result.url ? (
                <>
                  {t('settings.memory.publish.successPrefix')}{' '}
                  <a href={result.url} target="_blank" rel="noreferrer" style={{ color: '#4ADE80' }}>
                    {result.url}
                  </a>
                </>
              ) : (
                result.message
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Brain setup UI (natural, UI-driven brain configuration) ─────────
//
// platform.brain.setConfig()/importFromGithub() are narrow additions on top
// of the native/web Brain impls (see tauri.ts — added concurrently by a
// backend change alongside this UI), not part of the shared Brain interface
// in ./types. Same convention as info()/publishGithub() above: accessed via
// a local widened cast instead of editing tauri.ts/web.ts/types.ts.
//
// BrainInfo.source also gains a 4th value here, 'ui_config' (set once the
// user has made an explicit scope choice below) — widened locally
// (BrainInfoSource/BrainInfoW) for the same out-of-scope-file reason. The
// widening is a strict superset of BrainInfo['source'], so it type-checks
// whether or not tauri.ts's BrainInfo has already been updated to include
// 'ui_config' by the time this file is compiled.

type BrainScopeMode = 'project' | 'global' | 'custom';

interface BrainSetConfigOptions {
  mode: BrainScopeMode;
  path?: string;
}

interface BrainImportFromGithubOptions {
  url: string;
  dest: string;
}

type BrainInfoSource = BrainInfo['source'] | 'ui_config';
type BrainInfoW = Omit<BrainInfo, 'source'> & { source: BrainInfoSource };

type BrainWithSetup = Brain & {
  info(): Promise<BrainInfo>;
  setConfig(opts: BrainSetConfigOptions): Promise<BrainInfo>;
  importFromGithub(opts: BrainImportFromGithubOptions): Promise<BrainInfo>;
};

/** fetchBrainInfo (see above) widened to BrainInfoW so callers here can
    honestly branch on source === 'ui_config' without editing tauri.ts. */
function fetchBrainInfoW(platform: Platform): Promise<BrainInfoW> {
  return fetchBrainInfo(platform);
}

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--color-text-muted)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const pathInputStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--color-panel)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  padding: '7px 10px',
  fontSize: 11,
  color: 'var(--color-text)',
  fontFamily: 'var(--font-mono, monospace)',
  outline: 'none',
};

const browseButtonStyle: React.CSSProperties = {
  padding: '7px 10px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text-muted)',
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

/** Text input + "Choisir un dossier…" button — reuses the app's native
    folder-open dialog (openFolder(), same helper AppContext.tsx's
    openProject() uses) when reachable under Tauri, with the input itself
    as an always-available manual fallback (per this feature's spec: "a
    path input if a dialog isn't reachable from here"). */
function FolderPathField({
  path,
  onPathChange,
  onBrowse,
  placeholder,
}: {
  path: string;
  onPathChange: (v: string) => void;
  onBrowse: () => void;
  placeholder: string;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input
        type="text"
        value={path}
        onChange={(e) => onPathChange(e.target.value)}
        placeholder={placeholder}
        style={pathInputStyle}
      />
      <button onClick={onBrowse} style={browseButtonStyle}>
        {t('settings.memory.chooseFolderButton')}
      </button>
    </div>
  );
}

// ── BrainConfigSection ("Configurer votre brain") ────────────────────
//
// Natural, UI-driven brain SCOPE choice — project-local, one shared global
// folder, or a custom folder — without ever touching an environment
// variable. Calls platform.brain.setConfig(), which persists the choice and
// restarts the brain sidecar (per the BACKEND CONTRACT), and reflects the
// BrainInfo it returns immediately instead of waiting for a re-fetch.

interface BrainConfigSectionProps {
  refreshKey: number;
  onChanged: () => void;
}

function optionButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    padding: '10px 12px',
    background: active ? 'rgba(124,92,255,0.10)' : 'var(--color-panel)',
    border: `1px solid ${active ? 'var(--color-accent-border)' : 'var(--color-border)'}`,
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
    width: '100%',
  };
}

function BrainConfigSection({ refreshKey, onChanged }: BrainConfigSectionProps) {
  const { t } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [info, setInfo] = useState<BrainInfoW | null>(null);
  const [selectedMode, setSelectedMode] = useState<BrainScopeMode | null>(null);
  const [globalPath, setGlobalPath] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    fetchBrainInfoW(platform)
      .then((i) => { if (!cancelled) setInfo(i); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [isTauri, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleBrowse(target: 'global' | 'custom') {
    if (platform.name !== 'tauri') return;
    const { openFolder } = await import('../../lib/platform/tauri');
    const picked = await openFolder();
    if (!picked) return;
    if (target === 'global') setGlobalPath(picked);
    else setCustomPath(picked);
  }

  async function applyMode(mode: BrainScopeMode) {
    const path = mode === 'global' ? globalPath.trim() : mode === 'custom' ? customPath.trim() : undefined;
    if (mode !== 'project' && !path) {
      setResult({ type: 'error', text: t('settings.memory.brainConfig.validationError') });
      return;
    }
    setApplying(true);
    setResult(null);
    try {
      const updated = await (platform.brain as BrainWithSetup).setConfig({ mode, path });
      setInfo(updated);
      setResult({ type: 'success', text: t('settings.memory.brainConfig.activeSuccess', { path: updated.path }) });
      onChanged();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult({ type: 'error', text: t('settings.memory.brainConfig.configError', { msg }) });
    } finally {
      setApplying(false);
    }
  }

  function handleSelect(mode: BrainScopeMode) {
    setResult(null);
    setSelectedMode(mode);
    if (mode === 'project') {
      applyMode('project');
    }
  }

  if (!isTauri) {
    return (
      <div style={{
        padding: 16,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
          {t('settings.memory.brainConfig.title')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('settings.memory.webUnavailableNative')}
        </div>
      </div>
    );
  }

  const resultColor = result?.type === 'success' ? '#4ADE80' : '#F87171';

  return (
    <div style={{
      padding: 16,
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div>
        <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
          {t('settings.memory.brainConfig.title')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
          {t('settings.memory.brainConfig.description')}
        </div>
      </div>

      {/* Precedence note — an env override always wins, so a UI choice made
          here would otherwise silently appear to do nothing. Distinct from
          BrainPathSection's own env_override callout above (that one
          explains the override itself; this one explains why picking a
          scope below may have no visible effect while it's set). */}
      {info?.source === 'env_override' && (
        <div style={{
          padding: '8px 10px',
          background: 'rgba(255,199,107,0.07)',
          border: '1px solid rgba(255,199,107,0.2)',
          borderRadius: 5,
          fontSize: 10,
          color: 'rgba(255,199,107,0.8)',
          lineHeight: 1.5,
        }}>
          {t('settings.memory.brainConfig.envOverrideNote')}
        </div>
      )}

      {/* BRAIN DISCOVERABILITY: the resolved brain has 0 notes (see
          BrainInfo.isEmpty / count_brain_notes) — point the user at the
          global/custom options right below instead of leaving recall
          silently empty everywhere in the app. Generic by design: never
          assumes or hardcodes a specific user's path, just prompts them to
          pick one of the existing mechanisms below. */}
      {info?.isEmpty === true && (
        <div style={{
          padding: '8px 10px',
          background: 'rgba(255,199,107,0.07)',
          border: '1px solid rgba(255,199,107,0.2)',
          borderRadius: 5,
          fontSize: 10,
          color: 'rgba(255,199,107,0.8)',
          lineHeight: 1.5,
        }}>
          {t('settings.memory.brainConfig.emptyBrainNotice')}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Project scope — no path needed, applies immediately. */}
        <button onClick={() => handleSelect('project')} disabled={applying} style={optionButtonStyle(selectedMode === 'project')}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>{t('settings.memory.brainConfig.projectTitle')}</span>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('settings.memory.brainConfig.projectDesc')}</span>
        </button>

        {/* Global scope — shared across all projects, needs a folder. */}
        <button onClick={() => handleSelect('global')} disabled={applying} style={optionButtonStyle(selectedMode === 'global')}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>{t('settings.memory.brainConfig.globalTitle')}</span>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('settings.memory.brainConfig.globalDesc')}</span>
        </button>
        {selectedMode === 'global' && (
          <div style={{ paddingLeft: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <FolderPathField
              path={globalPath}
              onPathChange={setGlobalPath}
              onBrowse={() => handleBrowse('global')}
              placeholder={t('settings.memory.brainConfig.globalPlaceholder')}
            />
            <button
              onClick={() => applyMode('global')}
              disabled={applying || !globalPath.trim()}
              style={{
                alignSelf: 'flex-start',
                padding: '7px 14px',
                background: applying || !globalPath.trim() ? 'rgba(124,92,255,0.3)' : 'var(--color-accent-soft)',
                border: '1px solid var(--color-accent-border)',
                borderRadius: 7,
                color: 'var(--color-accent-light)',
                fontSize: 12,
                fontWeight: 500,
                cursor: applying || !globalPath.trim() ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {applying ? t('settings.memory.brainConfig.applyingButton') : t('settings.memory.brainConfig.useThisBrainButton')}
            </button>
          </div>
        )}

        {/* Custom scope — one specific folder, needs a folder. */}
        <button onClick={() => handleSelect('custom')} disabled={applying} style={optionButtonStyle(selectedMode === 'custom')}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>{t('settings.memory.brainConfig.customTitle')}</span>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('settings.memory.brainConfig.customDesc')}</span>
        </button>
        {selectedMode === 'custom' && (
          <div style={{ paddingLeft: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <FolderPathField
              path={customPath}
              onPathChange={setCustomPath}
              onBrowse={() => handleBrowse('custom')}
              placeholder={t('settings.memory.brainConfig.customPlaceholder')}
            />
            <button
              onClick={() => applyMode('custom')}
              disabled={applying || !customPath.trim()}
              style={{
                alignSelf: 'flex-start',
                padding: '7px 14px',
                background: applying || !customPath.trim() ? 'rgba(124,92,255,0.3)' : 'var(--color-accent-soft)',
                border: '1px solid var(--color-accent-border)',
                borderRadius: 7,
                color: 'var(--color-accent-light)',
                fontSize: 12,
                fontWeight: 500,
                cursor: applying || !customPath.trim() ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {applying ? t('settings.memory.brainConfig.applyingButton') : t('settings.memory.brainConfig.useThisBrainButton')}
            </button>
          </div>
        )}
      </div>

      {result && (
        <div style={{
          padding: '8px 12px',
          background: result.type === 'success' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
          border: `1px solid ${resultColor}44`,
          borderRadius: 6,
          fontSize: 12,
          color: resultColor,
        }}>
          {result.text}
        </div>
      )}
    </div>
  );
}

// ── BrainImportSection ("Importer un brain depuis GitHub") ───────────
//
// The inverse of BrainPublishSection above: clones a shared/published brain
// repo and makes it the active brain, via platform.brain.importFromGithub()
// (see BrainWithSetup cast above). Same collapsed-by-default + confirm
// checkbox layout convention as BrainPublishSection, for visual/UX
// consistency with the rest of this file.

interface BrainImportSectionProps {
  onChanged: () => void;
}

function BrainImportSection({ onChanged }: BrainImportSectionProps) {
  const { t } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState('');
  const [dest, setDest] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleBrowseDest() {
    if (platform.name !== 'tauri') return;
    const { openFolder } = await import('../../lib/platform/tauri');
    const picked = await openFolder();
    if (picked) setDest(picked);
  }

  async function handleImport() {
    setImporting(true);
    setResult(null);
    try {
      const updated = await (platform.brain as BrainWithSetup).importFromGithub({
        url: url.trim(),
        dest: dest.trim(),
      });
      setResult({ ok: true, message: t('settings.memory.import.successMessage', { path: updated.path }) });
      onChanged();
    } catch (err: unknown) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setImporting(false);
    }
  }

  if (!isTauri) {
    return (
      <div style={{
        padding: 16,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
          {t('settings.memory.import.title')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('settings.memory.webUnavailableNative')}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: 16,
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
            {t('settings.memory.import.title')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.import.description')}
          </div>
        </div>
        {!expanded && (
          <button
            onClick={() => setExpanded(true)}
            style={{
              padding: '8px 14px',
              background: 'var(--color-accent-soft)',
              border: '1px solid var(--color-accent-border)',
              borderRadius: 7,
              color: 'var(--color-accent-light)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {t('settings.memory.import.button')}
          </button>
        )}
      </div>

      {expanded && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          paddingTop: 8,
          borderTop: '1px solid var(--color-border)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabelStyle}>{t('settings.memory.githubUrlLabel')}</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('settings.memory.import.urlPlaceholder')}
              style={pathInputStyle}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabelStyle}>{t('settings.memory.import.destLabel')}</label>
            <FolderPathField
              path={dest}
              onPathChange={setDest}
              onBrowse={handleBrowseDest}
              placeholder={t('settings.memory.import.destPlaceholder')}
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, color: 'var(--color-text-muted)' }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>{t('settings.memory.import.confirmLabel')}</span>
          </label>

          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            {t('settings.memory.import.infoText')}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleImport}
              disabled={importing || !confirmed || !url.trim() || !dest.trim()}
              style={{
                padding: '8px 14px',
                background: importing || !confirmed || !url.trim() || !dest.trim() ? 'rgba(124,92,255,0.3)' : 'var(--color-accent-soft)',
                border: '1px solid var(--color-accent-border)',
                borderRadius: 7,
                color: 'var(--color-accent-light)',
                fontSize: 12,
                fontWeight: 500,
                cursor: importing || !confirmed || !url.trim() || !dest.trim() ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {importing ? t('settings.memory.import.importingButton') : t('settings.memory.import.importButton')}
            </button>
            <button
              onClick={() => { setExpanded(false); setResult(null); }}
              disabled={importing}
              style={{
                padding: '8px 14px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 7,
                color: 'var(--color-text-muted)',
                fontSize: 12,
                fontWeight: 500,
                cursor: importing ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('common.cancel')}
            </button>
          </div>

          {result && (
            <div style={{
              fontSize: 11,
              lineHeight: 1.5,
              padding: '8px 10px',
              borderRadius: 6,
              background: result.ok ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
              border: `1px solid ${result.ok ? '#4ADE80' : '#F87171'}44`,
              color: result.ok ? '#4ADE80' : '#F87171',
            }}>
              {result.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Toggle ─────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!value)}
      role="switch"
      tabIndex={0}
      aria-checked={value}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onChange(!value);
        }
      }}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: value ? 'var(--color-accent)' : 'rgba(255,255,255,0.12)',
        flexShrink: 0,
        position: 'relative',
        cursor: 'pointer',
        transition: 'background 0.15s',
      }}
    >
      <div style={{
        position: 'absolute',
        top: 3,
        left: value ? 19 : 3,
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.15s',
      }} />
    </div>
  );
}

// ── BrainProjectsEditor ────────────────────────────────────────────

function BrainProjectsEditor() {
  const { t } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [projects, setProjects] = useState<string[]>([]);
  const [newPath, setNewPath] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Load project list on mount (Tauri only)
  useEffect(() => {
    if (!isTauri) return;
    platform.brain.getProjects().then((paths) => {
      setProjects(paths);
    }).catch(() => {
      setProjects([]);
    });
  }, [isTauri]); // eslint-disable-line react-hooks/exhaustive-deps

  const persistProjects = useCallback(async (updated: string[]) => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await platform.brain.setProjects(updated);
      setProjects(updated);
      setSaveMsg({ type: 'success', text: t('settings.memory.projects.saved') });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveMsg({ type: 'error', text: t('settings.memory.projects.error', { msg }) });
    } finally {
      setSaving(false);
    }
  }, [platform, t]);

  function handleAdd() {
    const trimmed = newPath.trim();
    if (!trimmed || projects.includes(trimmed)) return;
    const updated = [...projects, trimmed];
    setNewPath('');
    persistProjects(updated);
  }

  function handleRemove(path: string) {
    const updated = projects.filter((p) => p !== path);
    persistProjects(updated);
  }

  const saveMsgColor = saveMsg?.type === 'success' ? '#4ADE80' : '#F87171';

  if (!isTauri) {
    return (
      <div style={{
        padding: 16,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
          {t('settings.memory.projects.titlePlain')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('settings.memory.projects.webUnavailable')}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: 16,
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 2 }}>
        {t('settings.memory.projects.titlePrefix')}{' '}
        <span style={{ color: 'var(--color-text)' }}>{t('brain.allBrains')}</span>{' '}
        {t('settings.memory.projects.titleSuffix')}
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
        {t('settings.memory.projects.desc')}
      </div>

      {/* Project list */}
      {projects.length === 0 ? (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', fontStyle: 'italic' }}>
          {t('settings.memory.projects.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {projects.map((p) => (
            <div
              key={p}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 8px',
                background: 'var(--color-panel)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontSize: 11,
                  color: 'var(--color-text)',
                  fontFamily: 'var(--font-mono, monospace)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {p}
              </span>
              <button
                onClick={() => handleRemove(p)}
                disabled={saving}
                style={{
                  padding: '2px 7px',
                  background: 'transparent',
                  border: '1px solid rgba(248,113,113,0.3)',
                  borderRadius: 4,
                  color: '#F87171',
                  fontSize: 10,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  flexShrink: 0,
                }}
              >
                {t('settings.memory.projects.remove')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add path */}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          placeholder={t('settings.memory.projects.pathPlaceholder')}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          style={{
            flex: 1,
            background: 'var(--color-panel)',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            padding: '7px 10px',
            fontSize: 11,
            color: 'var(--color-text)',
            fontFamily: 'var(--font-mono, monospace)',
            outline: 'none',
          }}
        />
        <button
          onClick={handleAdd}
          disabled={saving || !newPath.trim()}
          style={{
            padding: '7px 12px',
            background: newPath.trim() ? 'var(--color-accent-soft)' : 'transparent',
            border: '1px solid var(--color-accent-border)',
            borderRadius: 6,
            color: 'var(--color-accent-light)',
            fontSize: 11,
            fontWeight: 600,
            cursor: saving || !newPath.trim() ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: !newPath.trim() ? 0.5 : 1,
            flexShrink: 0,
          }}
        >
          {t('settings.memory.projects.add')}
        </button>
      </div>

      {saveMsg && (
        <div style={{
          padding: '6px 10px',
          background: saveMsg.type === 'success' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
          border: `1px solid ${saveMsgColor}44`,
          borderRadius: 5,
          fontSize: 11,
          color: saveMsgColor,
        }}>
          {saveMsg.text}
        </div>
      )}
    </div>
  );
}

// ── DangerZoneSection ("Reset brain" — destructive) ─────────────────
//
// Surfaces the bundled engine `wipe` command (Rust: brain_wipe, which stops
// the sidecar, runs `lazybrain wipe --yes` on the CURRENT PROJECT brain with
// the path pinned, restarts the sidecar, and emits brain://updated). Deletes
// ALL notes/artifacts/cache for this brain — irreversible — so it is gated
// behind a TWO-STEP, TYPE-TO-CONFIRM dialog that shows the exact resolved
// path before anything is deleted, and an extra warning when that path is the
// shared global/personal brain (source === 'env_override'), mirroring
// BrainPublishSection's personal-brain caution. Calls invoke('brain_wipe')
// directly (same platform-ownership rationale as handleConsolidateNow).

/** Literal token the user must type to arm the reset. Passed to i18n as a
    param (not baked into each locale) so the type-match stays deterministic
    and locale-independent while the surrounding copy is translated. */
const RESET_CONFIRM_TOKEN = 'RESET';

function DangerZoneSection({ refreshKey, onWiped }: { refreshKey: number; onWiped: () => void }) {
  const { t, locale } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [info, setInfo] = useState<BrainInfoW | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [wiping, setWiping] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    fetchBrainInfoW(platform)
      .then((i) => { if (!cancelled) setInfo(i); })
      .catch(() => { if (!cancelled) setInfo(null); });
    return () => { cancelled = true; };
  }, [isTauri, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const isPersonalBrain = info?.source === 'env_override';
  const canConfirm = confirmText.trim() === RESET_CONFIRM_TOKEN && !wiping;

  function collapse() {
    setExpanded(false);
    setConfirmText('');
    setResult(null);
  }

  async function handleWipe() {
    setWiping(true);
    setResult(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ path?: string; report?: { notesDeleted?: number } }>('brain_wipe');
      const deleted = res?.report?.notesDeleted ?? 0;
      setResult({ type: 'success', text: t(pluralKey('settings.memory.reset.success', deleted, locale), { count: deleted }) });
      setConfirmText('');
      setExpanded(false);
      // Rust also emits brain://updated; bumping here refreshes immediately.
      onWiped();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult({ type: 'error', text: t('settings.memory.reset.error', { msg }) });
    } finally {
      setWiping(false);
    }
  }

  if (!isTauri) {
    return (
      <div style={{
        padding: 16,
        background: 'var(--color-panel-2)',
        border: '1px solid rgba(248,113,113,0.3)',
        borderRadius: 10,
      }}>
        <div style={{ fontSize: 12, color: '#F87171', fontWeight: 500, marginBottom: 6 }}>
          {t('settings.memory.reset.title')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('settings.memory.webUnavailableNative')}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: 16,
      background: 'rgba(248,113,113,0.04)',
      border: '1px solid rgba(248,113,113,0.3)',
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: '#F87171', fontWeight: 600, marginBottom: 2 }}>
            {t('settings.memory.reset.title')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.reset.description')}
          </div>
        </div>
        {!expanded && (
          <button
            onClick={() => { setExpanded(true); setResult(null); }}
            style={{
              padding: '8px 14px',
              background: 'transparent',
              border: '1px solid rgba(248,113,113,0.5)',
              borderRadius: 7,
              color: '#F87171',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {t('settings.memory.reset.button')}
          </button>
        )}
      </div>

      {expanded && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          paddingTop: 8,
          borderTop: '1px solid rgba(248,113,113,0.25)',
        }}>
          {/* The EXACT brain path that will be wiped — shown before anything
              is deleted so the user confirms against the real target. */}
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.reset.pathLabel')}{' '}
            <span style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--color-text)', wordBreak: 'break-all' }}>
              {info?.path ?? '…'}
            </span>
          </div>

          {isPersonalBrain && (
            <div style={{
              padding: '8px 10px',
              background: 'rgba(255,199,107,0.08)',
              border: '1px solid rgba(255,199,107,0.3)',
              borderRadius: 6,
              fontSize: 11,
              color: 'rgba(255,199,107,0.9)',
              lineHeight: 1.5,
            }}>
              {t('settings.memory.reset.personalBrainWarning')}
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            {t('settings.memory.reset.confirmInstruction', { token: RESET_CONFIRM_TOKEN })}
          </div>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={RESET_CONFIRM_TOKEN}
            aria-label={t('settings.memory.reset.confirmInstruction', { token: RESET_CONFIRM_TOKEN })}
            style={{
              background: 'var(--color-panel)',
              border: '1px solid rgba(248,113,113,0.4)',
              borderRadius: 6,
              padding: '7px 10px',
              fontSize: 12,
              color: 'var(--color-text)',
              fontFamily: 'var(--font-mono, monospace)',
              outline: 'none',
            }}
          />

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleWipe}
              disabled={!canConfirm}
              style={{
                padding: '8px 14px',
                background: canConfirm ? '#F87171' : 'rgba(248,113,113,0.25)',
                border: '1px solid rgba(248,113,113,0.5)',
                borderRadius: 7,
                color: canConfirm ? '#1a0d0d' : 'rgba(255,255,255,0.5)',
                fontSize: 12,
                fontWeight: 600,
                cursor: canConfirm ? 'pointer' : 'not-allowed',
                fontFamily: 'inherit',
              }}
            >
              {wiping ? t('settings.memory.reset.inProgress') : t('settings.memory.reset.confirmButton')}
            </button>
            <button
              onClick={collapse}
              disabled={wiping}
              style={{
                padding: '8px 14px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 7,
                color: 'var(--color-text-muted)',
                fontSize: 12,
                fontWeight: 500,
                cursor: wiping ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div style={{
          padding: '8px 12px',
          background: result.type === 'success' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
          border: `1px solid ${result.type === 'success' ? '#4ADE80' : '#F87171'}44`,
          borderRadius: 6,
          fontSize: 12,
          color: result.type === 'success' ? '#4ADE80' : '#F87171',
        }}>
          {result.text}
        </div>
      )}
    </div>
  );
}

// ── HistoryReimportSection ("Rebuild brain from history") ────────────
//
// Settings-level equivalent of onboarding's BrainSetupStep "Seed from
// history" flow (src/components/onboarding/steps/BrainSetupStep.tsx) —
// previously the ONLY way to (re)build the brain from AI conversation
// history was during first-run onboarding, with no way to run it again
// later or on a machine where onboarding was skipped. Reuses the exact same
// platform methods (detectHistorySources/seedEstimate/seedBrain/
// onSeedProgress) — no new platform surface added.
//
// Import semantics (verified in engine/src/commands/import.ts's dedup store
// — content-hash fingerprint per conversation, persisted alongside the
// brain cache): every run is idempotent. Already-imported conversations are
// detected by fingerprint and SKIPPED, never duplicated or overwritten —
// this action only ever ADDS/refreshes notes, it does not wipe the brain
// (that is DangerZoneSection's "Reset brain" below, a distinct and
// explicitly separate destructive action). The confirm step's warning text
// states this plainly instead of leaving it ambiguous.

type ReimportPhase = 'idle' | 'detecting' | 'ready' | 'estimating' | 'confirm' | 'seeding' | 'done' | 'error';

function HistoryReimportSection() {
  const { t, locale } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<ReimportPhase>('idle');
  const [sources, setSources] = useState<HistorySource[]>([]);
  const [estimate, setEstimate] = useState<SeedEstimate | null>(null);
  const [progress, setProgress] = useState<SeedProgressEvent | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => () => { unsubRef.current?.(); }, []);

  const availableSources = sources.filter(s => s.available && s.itemCount > 0);

  async function handleExpand() {
    setExpanded(true);
    setPhase('detecting');
    setErrorMsg(null);
    try {
      const detected = await platform.brain.detectHistorySources();
      setSources(detected);
      setPhase('ready');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  async function handleEstimate() {
    const selected = availableSources.map(s => s.source);
    if (selected.length === 0) return;
    setPhase('estimating');
    setErrorMsg(null);
    try {
      const est = await platform.brain.seedEstimate(selected);
      setEstimate(est);
      setPhase('confirm');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  async function handleConfirm() {
    const selected = availableSources.map(s => s.source);
    setPhase('seeding');
    // Seed a synthetic starting event immediately (same convention as
    // BrainSetupStep's handleSeed) so the animated progress view renders
    // fully populated the instant "Lancer l'import" is clicked, instead of
    // an empty shell waiting for the first real backend event. total =
    // number of sources, matching what brain_seed itself reports.
    setProgress({ done: 0, total: selected.length, phase: 'starting' });
    setResult(null);
    const unsub = platform.brain.onSeedProgress(setProgress);
    unsubRef.current = unsub;
    try {
      const res = await platform.brain.seedBrain({ sources: selected, useLlm: estimate?.llmAvailable ?? false });
      unsub();
      unsubRef.current = null;
      setResult(res);
      setPhase('done');
    } catch (err: unknown) {
      unsub();
      unsubRef.current = null;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  function handleReset() {
    unsubRef.current?.();
    unsubRef.current = null;
    setExpanded(false);
    setPhase('idle');
    setSources([]);
    setEstimate(null);
    setProgress(null);
    setResult(null);
    setErrorMsg(null);
  }

  // History import needs filesystem access to ~/.claude/projects etc. —
  // same desktop-only gate detectHistorySources() itself already documents
  // (its web stub resolves to []).
  if (!isTauri) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
      {!expanded && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={handleExpand} style={reimportButtonStyle(false)}>
            {t('settings.memory.reimport.button')}
          </button>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.reimport.desc')}
          </span>
        </div>
      )}

      {expanded && (
        <div style={{
          padding: '10px 12px',
          background: 'var(--color-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}>
          {phase === 'detecting' && (
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t('onboarding.brain.scanning')}</div>
          )}

          {phase === 'ready' && (
            <>
              <div style={{ fontSize: 12, color: 'var(--color-text)' }}>
                {availableSources.length > 0
                  ? t('settings.memory.reimport.sourcesFound', {
                      list: availableSources.map(s => `${s.label} (${s.itemCount})`).join(', '),
                    })
                  : t('onboarding.brain.noSources')}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handleEstimate}
                  disabled={availableSources.length === 0}
                  style={reimportButtonStyle(availableSources.length === 0)}
                >
                  {t('onboarding.brain.estimateCost')}
                </button>
                <button onClick={handleReset} style={reimportGhostButtonStyle}>{t('common.cancel')}</button>
              </div>
            </>
          )}

          {phase === 'estimating' && (
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t('onboarding.brain.estimating')}</div>
          )}

          {phase === 'confirm' && estimate && (
            <>
              <div style={{ fontSize: 12, color: 'var(--color-text)' }}>
                {t(pluralKey('settings.memory.reimport.estimateLine', estimate.items, locale), { items: estimate.items, minutes: estimate.estMinutes })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                {estimate.llmAvailable
                  ? t('onboarding.brain.backendDetected', { backend: estimate.backend ?? '' })
                  : t('onboarding.brain.backendNone')}
              </div>
              <div style={{
                padding: '8px 10px',
                background: 'rgba(255,199,107,0.07)',
                border: '1px solid rgba(255,199,107,0.2)',
                borderRadius: 6,
                fontSize: 11,
                color: 'rgba(255,199,107,0.9)',
                lineHeight: 1.5,
              }}>
                {t('settings.memory.reimport.confirmWarning')}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handleConfirm}
                  disabled={estimate.items === 0}
                  style={reimportButtonStyle(estimate.items === 0)}
                >
                  {t('onboarding.brain.startImport')}
                </button>
                <button onClick={handleReset} style={reimportGhostButtonStyle}>{t('common.cancel')}</button>
              </div>
            </>
          )}

          {/* Seeding in progress — same animated shared component as
              onboarding's BrainSetupStep (spinner + determinate bar +
              phase label), switched to instantly since handleConfirm sets
              a synthetic starting progress event synchronously above. */}
          {phase === 'seeding' && (
            <SeedProgress status="running" progress={progress} />
          )}

          {/* Done — success check + result + Close, same shared visual
              language as onboarding's done state. */}
          {phase === 'done' && result && (
            <SeedProgress
              status="done"
              progress={progress}
              result={result}
              onDone={handleReset}
              doneLabel={t('common.close')}
            />
          )}

          {/* Error — previously a bare line of red text with no way to
              retry short of collapsing and re-expanding by hand. Now offers
              an explicit Retry (re-runs detection) alongside Close. */}
          {phase === 'error' && (
            <SeedProgress
              status="error"
              progress={progress}
              errorMessage={errorMsg}
              onRetry={handleExpand}
              onDone={handleReset}
              doneLabel={t('common.close')}
            />
          )}
        </div>
      )}
    </div>
  );
}

function reimportButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 14px',
    background: disabled ? 'rgba(124,92,255,0.3)' : 'var(--color-accent-soft)',
    border: '1px solid var(--color-accent-border)',
    borderRadius: 7,
    color: 'var(--color-accent-light)',
    fontSize: 12,
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.12s',
  };
}

const reimportGhostButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 7,
  color: 'var(--color-text-muted)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

// ── MemoryPanel ────────────────────────────────────────────────────

export function MemoryPanel() {
  const { t } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';
  const [scopesEnabled, setScopesEnabled] = useState(loadScopesEnabled);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Bumped whenever BrainConfigSection/BrainImportSection successfully
  // change which brain is active — passed to the other brain.info()/health()
  // -backed sections below as `refreshKey` so they refetch and reflect the
  // change instead of staying on whatever they showed at mount time.
  const [brainVersion, setBrainVersion] = useState(0);
  const bumpBrainVersion = useCallback(() => setBrainVersion((v) => v + 1), []);

  // Persist scopes toggle
  useEffect(() => {
    saveScopesEnabled(scopesEnabled);
  }, [scopesEnabled]);

  // STALE HEALTH BADGE FIX: brain_rebuild_graph (Rust, capture.rs) resolves
  // the `rebuildGraph()` Tauri call almost IMMEDIATELY — it schedules the
  // real index-rebuild + graph + build-index + health-score pipeline on a
  // background `tokio::task::spawn_blocking` and returns `Ok(())` without
  // awaiting it (fire-and-forget; only `brain://updated` / rebuild-failed`
  // signal real completion). handleRebuildIndex's bumpBrainVersion() below
  // therefore used to fire the health refetch WHILE health-score was still
  // running in the background, catching the stale (or 0, on a first-ever
  // computation) score — the real value only appeared later if something
  // ELSE happened to remount/refetch this panel (~20s later per QA, an
  // incidental trigger, not a real one). Listening for the SAME
  // `brain://updated` event BrainSpace already uses to know the pipeline
  // genuinely finished (see BrainSpace.tsx's "Live refresh" section) and
  // bumping again then closes that gap: the badge now refreshes right after
  // the rebuild ACTUALLY completes, not only right after the IPC call
  // returns. No Rust changes needed — `brain://updated` is already emitted.
  useEffect(() => {
    if (!isTauri) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('brain://updated', () => {
        if (cancelled) return;
        bumpBrainVersion();
      }).then((fn) => {
        if (cancelled) { fn(); return; }
        unlisten = fn;
      }).catch((err: unknown) => {
        console.warn('[MemoryPanel] listen brain://updated failed:', err);
      });
    }).catch((err: unknown) => {
      console.warn('[MemoryPanel] @tauri-apps/api/event import failed:', err);
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isTauri, bumpBrainVersion]);

  async function handleRebuildIndex() {
    setRebuilding(true);
    setRebuildMsg(null);
    try {
      await platform.brain.rebuildGraph();
      setRebuildMsg({ type: 'success', text: t('settings.memory.rebuild.success') });
      // Optimistic immediate refresh — re-run every refreshKey-gated fetch
      // below (MemoryHealthSection/BrainPathSection/BrainPublishSection/
      // BrainConfigSection) right away for responsiveness. This alone can
      // still catch health-score mid-flight and show a stale/0 score (see
      // the brain://updated listener above for why) — the LATER, correct
      // bump from that listener is what makes the real score appear
      // promptly once the background pipeline actually finishes, rather
      // than relying on this optimistic one alone.
      bumpBrainVersion();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setRebuildMsg({ type: 'error', text: t('settings.memory.rebuild.error', { msg }) });
    } finally {
      setRebuilding(false);
    }
  }

  // Consolidate now — runs the real 5-step maintenance sequence (dream,
  // prune, compress, interlink, profile-update; see maintenance.rs's module
  // doc in src-tauri/src/commands/brain/) via brain_consolidate_now
  // (already registered as a Tauri command; this wires the first UI for it).
  //
  // Deliberately calls `invoke` directly via a dynamic import instead of
  // going through `platform.brain.*` (unlike handleRebuildIndex above):
  // brain_consolidate_now has no platform-layer wrapper, and src/lib/platform
  // is owned by a parallel work-stream on this codebase, so adding one there
  // is out of scope here. Mirrors the SAME dynamic-import pattern this file
  // already uses for `@tauri-apps/api/event` above (see the brain://updated
  // listener), just for `@tauri-apps/api/core`'s `invoke` instead. In the web
  // preview (isTauri === false) this no-ops with a success message, matching
  // rebuildGraph()'s no-op behavior in lib/platform/web.ts.
  async function handleConsolidateNow() {
    setConsolidating(true);
    setConsolidateMsg(null);
    try {
      if (!isTauri) {
        console.debug('[MemoryPanel] brain_consolidate_now (no-op in browser)');
        setConsolidateMsg({ type: 'success', text: t('settings.memory.consolidate.success') });
        return;
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const summary = await invoke<string>('brain_consolidate_now');
      setConsolidateMsg({ type: 'success', text: summary || t('settings.memory.consolidate.success') });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setConsolidateMsg({ type: 'error', text: t('settings.memory.consolidate.error', { msg }) });
    } finally {
      setConsolidating(false);
    }
  }

  const msgColor = rebuildMsg?.type === 'success' ? '#4ADE80' : '#F87171';
  const consolidateMsgColor = consolidateMsg?.type === 'success' ? '#4ADE80' : '#F87171';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Memory health — live signals from platform.health() + brain.health(),
          cross-checked against brain.graph() so it never disagrees with
          BrainSpace's live badge for the same brain. */}
      <MemoryHealthSection refreshKey={brainVersion} />

      {/* Diagnostics — engine `stats`: router L1-L4 distribution, p50
          latencies, avg injected tokens (fail-soft, hidden on hard error). */}
      <BrainStatsSection refreshKey={brainVersion} />

      {/* Brain path display — BRAIN-PATH TRANSPARENCY: real resolved path +
          resolution source (env override / project / home fallback) from
          platform.brain.info(), instead of a static placeholder. */}
      <BrainPathSection refreshKey={brainVersion} />

      {/* Publish to GitHub — restores the old solo-brain "push to share" flow. */}
      <BrainPublishSection refreshKey={brainVersion} />

      {/* Configure your brain — natural, UI-driven scope choice (project /
          global / custom folder), no environment variable required. */}
      <BrainConfigSection refreshKey={brainVersion} onChanged={bumpBrainVersion} />

      {/* Import a brain from GitHub — the inverse of Publish above. */}
      <BrainImportSection onChanged={bumpBrainVersion} />

      {/* Scopes toggle */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 16px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500, marginBottom: 2 }}>
            {t('settings.memory.scopes.label')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.scopes.sub')}
          </div>
        </div>
        <Toggle value={scopesEnabled} onChange={setScopesEnabled} />
      </div>

      {/* Brain projects editor */}
      <BrainProjectsEditor />

      {/* Semantic recall status — READ-ONLY (P3 DEAD EMBEDDINGS TOGGLE fix).
          This used to be a Toggle that persisted lazy.brain.embeddings to
          localStorage, but nothing ever read that key: the Rust sidecar
          spawn path hardcodes LAZYBRAIN_EMBEDDINGS=1 at every call site
          (sidecar.rs, config.rs, search.rs, capture.rs, history_import.rs),
          so semantic recall has always been on regardless of this control.
          Replaced with an honest read-only status instead of a misleading
          toggle — see the delivery report for the wire-vs-remove rationale. */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        padding: '14px 16px',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
            <span
              aria-hidden="true"
              style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#4ADE80', flexShrink: 0 }}
            />
            <span style={{ fontSize: 13, color: 'var(--color-text)', fontWeight: 500 }}>
              {t('settings.memory.embeddings.label')}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.55 }}>
            {t('settings.memory.embeddings.sub')}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div style={{
        padding: 16,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>{t('settings.memory.actions')}</div>

        {/* Rebuild index */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleRebuildIndex}
            disabled={rebuilding}
            style={{
              padding: '8px 14px',
              background: rebuilding ? 'rgba(124,92,255,0.3)' : 'var(--color-accent-soft)',
              border: '1px solid var(--color-accent-border)',
              borderRadius: 7,
              color: 'var(--color-accent-light)',
              fontSize: 12,
              fontWeight: 500,
              cursor: rebuilding ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.12s',
            }}
          >
            {rebuilding ? t('settings.memory.rebuild.inProgress') : t('settings.memory.rebuild.button')}
          </button>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.rebuild.desc')}
          </span>
        </div>

        {/* Consolidate now */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleConsolidateNow}
            disabled={consolidating}
            style={{
              padding: '8px 14px',
              background: consolidating ? 'rgba(124,92,255,0.3)' : 'var(--color-accent-soft)',
              border: '1px solid var(--color-accent-border)',
              borderRadius: 7,
              color: 'var(--color-accent-light)',
              fontSize: 12,
              fontWeight: 500,
              cursor: consolidating ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.12s',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {consolidating && (
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  border: '2px solid var(--color-accent-light)',
                  borderTopColor: 'transparent',
                  display: 'inline-block',
                  animation: 'spin 0.7s linear infinite',
                }}
              />
            )}
            {consolidating ? t('settings.memory.consolidate.inProgress') : t('settings.memory.consolidate.button')}
          </button>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('settings.memory.consolidate.desc')}
          </span>
        </div>

        {/* Rebuild brain from history — Settings-level entry point for the
            same seed-from-history flow onboarding offers (previously only
            reachable during first-run setup). See HistoryReimportSection
            above for the full detect -> estimate -> confirm -> progress ->
            result flow and its idempotency/no-wipe guarantees. */}
        <HistoryReimportSection />

        {/* Audit memory — coming soon */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            disabled
            title={t('settings.memory.audit.tooltip')}
            style={{
              padding: '8px 14px',
              background: 'transparent',
              border: '1px solid var(--color-border)',
              borderRadius: 7,
              color: 'var(--color-text-muted)',
              fontSize: 12,
              fontWeight: 500,
              cursor: 'not-allowed',
              fontFamily: 'inherit',
              opacity: 0.6,
            }}
          >
            {t('settings.memory.audit.button')}
          </button>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
            {t('settings.memory.audit.desc')}
          </span>
        </div>

        {/* Rebuild feedback */}
        {rebuildMsg && (
          <div style={{
            padding: '8px 12px',
            background: rebuildMsg.type === 'success' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
            border: `1px solid ${msgColor}44`,
            borderRadius: 6,
            fontSize: 12,
            color: msgColor,
          }}>
            {rebuildMsg.text}
          </div>
        )}

        {/* Consolidate feedback */}
        {consolidateMsg && (
          <div style={{
            padding: '8px 12px',
            background: consolidateMsg.type === 'success' ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
            border: `1px solid ${consolidateMsgColor}44`,
            borderRadius: 6,
            fontSize: 12,
            color: consolidateMsgColor,
          }}>
            {consolidateMsg.text}
          </div>
        )}
      </div>

      {/* Danger zone — destructive "Reset brain" (engine wipe), gated behind
          a two-step type-to-confirm dialog showing the exact brain path. */}
      <DangerZoneSection refreshKey={brainVersion} onWiped={bumpBrainVersion} />
    </div>
  );
}
