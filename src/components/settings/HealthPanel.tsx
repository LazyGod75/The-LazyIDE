/* HealthPanel — displays platform component health from platform.health().
   Calls the CONTRACT-C platform.health() method and renders status chips
   for: brain, git, terminal, model, agentRunner.
   Falls back gracefully if the method is not yet implemented.
*/

import { useState, useCallback } from 'react';
import { getPlatform } from '../../lib/platform';
import { createEvalHarness, type EvalReport } from '../../lib/agents/evalHarness';
import { useI18n } from '../../i18n';
import type { Locale } from '../../i18n/types';

// ── Types ──────────────────────────────────────────────────────────

type HealthStatus = 'ok' | 'down' | 'unknown';

interface HealthReport {
  brain: HealthStatus;
  git: HealthStatus;
  terminal: HealthStatus;
  model: HealthStatus;
  agentRunner: HealthStatus;
  details?: Record<string, string>;
}

// CONTRACT-C: platform.health() may not be in the base Platform type yet.
// Cast through unknown to avoid TS errors until PLATFORM-C merges.
type PlatformWithHealth = {
  health?: () => Promise<HealthReport>;
};

// ── Chip colors ────────────────────────────────────────────────────

const STATUS_COLOR: Record<HealthStatus, string> = {
  ok:      '#4ADE80',
  down:    '#F87171',
  unknown: '#888',
};

const STATUS_LABEL_KEY: Record<HealthStatus, string> = {
  ok:      'settings.health.status.ok',
  down:    'settings.health.status.down',
  unknown: 'settings.health.status.unknown',
};

const COMPONENT_LABEL_KEY: Record<string, string> = {
  brain:       'settings.health.component.brain',
  git:         'settings.health.component.git',
  terminal:    'settings.health.component.terminal',
  model:       'settings.health.component.model',
  agentRunner: 'settings.health.component.agentRunner',
};

// Map the app's Locale codes to a BCP-47 tag for Date#toLocaleTimeString —
// this used to be hardcoded to 'fr-FR' regardless of the active UI
// language, so an English-language user still saw French time formatting.
const TIME_LOCALE: Record<Locale, string> = {
  fr: 'fr-FR',
  en: 'en-US',
  es: 'es-ES',
  de: 'de-DE',
  ja: 'ja-JP',
  zh: 'zh-CN',
};

// ── StatusChip ─────────────────────────────────────────────────────

function StatusChip({ status }: { status: HealthStatus }) {
  const { t } = useI18n();
  const color = STATUS_COLOR[status];
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '2px 8px',
      borderRadius: 12,
      background: `${color}18`,
      border: `1px solid ${color}44`,
      fontSize: 11,
      fontWeight: 600,
      color,
      fontFamily: 'var(--font-mono, monospace)',
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      {t(STATUS_LABEL_KEY[status])}
    </span>
  );
}

// Known root causes get a plain-language rewrite instead of surfacing the
// raw platform-layer error (dev-speak like "'.' is outside every
// registered project root (8 checked)" is not actionable for a user).
// Anything not covered here falls back to the raw detail string, unchanged.
const FRIENDLY_DETAIL_KEY: Partial<Record<string, Partial<Record<HealthStatus, string>>>> = {
  git: {
    unknown: 'settings.health.detail.git.noProject',
    down: 'settings.health.detail.git.down',
  },
};

// ── HealthRow ──────────────────────────────────────────────────────

function HealthRow({
  component,
  status,
  detail,
}: {
  component: string;
  status: HealthStatus;
  detail?: string;
}) {
  const { t } = useI18n();
  const labelKey = COMPONENT_LABEL_KEY[component];
  const friendlyKey = FRIENDLY_DETAIL_KEY[component]?.[status];
  const friendlyText = friendlyKey ? t(friendlyKey) : undefined;
  // The raw technical detail stays available (secondary, collapsed) only
  // when it says something the friendly text does not already cover.
  const technicalDetail = friendlyText && detail && detail !== friendlyText ? detail : undefined;
  const primaryDetail = friendlyText ?? detail;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 16px',
      borderBottom: '1px solid var(--color-border)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text)' }}>
          {labelKey ? t(labelKey) : component}
        </div>
        {primaryDetail && (
          <div style={{
            fontSize: 11,
            color: 'var(--color-text-muted)',
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {primaryDetail}
          </div>
        )}
        {technicalDetail && (
          <details style={{ marginTop: 2 }}>
            <summary style={{
              fontSize: 10,
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
            }}>
              {t('settings.health.technicalDetails')}
            </summary>
            <div style={{
              fontSize: 10,
              color: 'var(--color-text-muted)',
              marginTop: 2,
              fontFamily: 'var(--font-mono, monospace)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {technicalDetail}
            </div>
          </details>
        )}
      </div>
      <StatusChip status={status} />
    </div>
  );
}

// ── HealthPanel ────────────────────────────────────────────────────

const COMPONENTS: Array<keyof Omit<HealthReport, 'details'>> = [
  'brain', 'git', 'terminal', 'model', 'agentRunner',
];

const UNKNOWN_REPORT: HealthReport = {
  brain:       'unknown',
  git:         'unknown',
  terminal:    'unknown',
  model:       'unknown',
  agentRunner: 'unknown',
};

export function HealthPanel() {
  const { t, locale } = useI18n();
  const [report, setReport] = useState<HealthReport>(UNKNOWN_REPORT);
  const [loading, setLoading] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const platform = getPlatform() as unknown as PlatformWithHealth;
      if (typeof platform.health !== 'function') {
        setError(t('settings.health.errorNotAvailable'));
        setReport(UNKNOWN_REPORT);
        return;
      }
      const result = await platform.health();
      setReport(result);
      setLastChecked(new Date());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(t('settings.health.errorPrefix', { msg }));
      setReport(UNKNOWN_REPORT);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const allOk = COMPONENTS.every(c => report[c] === 'ok');
  const anyDown = COMPONENTS.some(c => report[c] === 'down');
  const summaryColor = anyDown ? '#F87171' : allOk ? '#4ADE80' : '#888';
  const summaryLabel = anyDown
    ? t('settings.health.status.problems')
    : allOk
      ? t('settings.health.status.allOk')
      : t('settings.health.status.waiting');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: summaryColor,
            flexShrink: 0,
          }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: summaryColor }}>
            {summaryLabel}
          </span>
          {lastChecked && (
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
              — {lastChecked.toLocaleTimeString(TIME_LOCALE[locale])}
            </span>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          style={{
            padding: '5px 12px',
            background: loading ? 'rgba(124,92,255,0.3)' : 'var(--color-accent-soft)',
            border: '1px solid var(--color-accent-border)',
            borderRadius: 6,
            color: 'var(--color-accent-light)',
            fontSize: 12,
            fontWeight: 500,
            cursor: loading ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.12s',
          }}
        >
          {loading ? t('settings.health.refreshing') : t('settings.health.refresh')}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          padding: '10px 14px',
          background: 'rgba(248,113,113,0.08)',
          border: '1px solid rgba(248,113,113,0.3)',
          borderRadius: 8,
          fontSize: 12,
          color: '#F87171',
        }}>
          {error}
        </div>
      )}

      {/* Component list */}
      <div style={{
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}>
        {COMPONENTS.map((component) => (
          <HealthRow
            key={component}
            component={component}
            status={report[component]}
            detail={report.details?.[component]}
          />
        ))}
      </div>

      {/* Hint — only relevant before the first check has run; once a
          result is showing, telling the user to click Refresh to "run a
          health check" alongside a report that already ran reads as
          stale/contradictory instructions. */}
      {!lastChecked && (
        <div style={{
          fontSize: 11,
          color: 'var(--color-text-muted)',
          fontStyle: 'italic',
        }}>
          {t('settings.health.hint')}
        </div>
      )}

      {/* P7.8 — Eval harness */}
      <EvalHarnessSection />
    </div>
  );
}

// ── Eval Harness Section ───────────────────────────────────────────

function EvalHarnessSection() {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<EvalReport | null>(null);
  const [reportText, setReportText] = useState('');

  const handleRun = useCallback(async () => {
    setRunning(true);
    try {
      const harness = createEvalHarness({
        suites: [],
        runCase: async () => ({ status: 'done' as const, output: '', durationMs: 0 }),
      });
      const r = await harness.run();
      setReport(r);
      setReportText(harness.formatReport(r));
    } catch {
      setReportText(t('settings.health.harness.error'));
    } finally {
      setRunning(false);
    }
  }, [t]);

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--color-text-muted)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        marginBottom: 10,
      }}>
        {t('settings.health.harness.title')}
      </div>
      <button
        onClick={() => void handleRun()}
        disabled={running}
        style={{
          padding: '6px 14px',
          fontSize: 12,
          borderRadius: 6,
          border: '1px solid var(--color-border)',
          background: running ? 'rgba(124,92,255,0.05)' : 'rgba(124,92,255,0.12)',
          color: '#C4B5FD',
          cursor: running ? 'default' : 'pointer',
          fontFamily: 'inherit',
          fontWeight: 500,
        }}
      >
        {running ? t('settings.health.harness.running') : t('settings.health.harness.run')}
      </button>
      {report && (
        <div style={{
          marginTop: 10,
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 12, color: 'var(--color-text)' }}>
            <span style={{ color: '#4ADE80', fontWeight: 600 }}>{report.passed}</span> / {report.totalCases} {t('settings.health.harness.passed')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {t('settings.health.harness.passRate')}: {(report.passRate * 100).toFixed(1)}%
          </div>
        </div>
      )}
      {reportText && (
        <pre style={{
          marginTop: 10,
          padding: '10px 12px',
          background: 'var(--color-bg-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          fontSize: 11,
          color: 'var(--color-text-muted)',
          overflowX: 'auto',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          whiteSpace: 'pre-wrap',
        }}>
          {reportText}
        </pre>
      )}
    </div>
  );
}
