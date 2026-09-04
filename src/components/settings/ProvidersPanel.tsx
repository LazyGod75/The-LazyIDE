/* ProvidersPanel — per-backend readiness status + active indicator.

   Renders one card per backend (Claude CLI, Codex CLI, BYOK Anthropic, Pro managed)
   showing:
   - ready / not-ready indicator (green dot / red dot)
   - reason text when not ready
   - actionable "how to enable" instruction when not ready
   - "ACTIF" badge on the currently active backend

   NOTE: readiness data depends on module-level state populated by
   initProviderMode() (CLI detection) and setManagedAvailability() (billing).
   This panel reads that state synchronously; a page-reload re-checks CLIs.
*/

import { getAllBackendsReadiness, activeBackendId } from '../../lib/models/readiness';
import { getProviderMode } from '../../lib/models';
import type { BackendReadiness } from '../../lib/models/readiness';
import { ModelPicker } from './ModelPicker';
import { useI18n } from '../../i18n';

// ── Dot indicator ─────────────────────────────────────────────────

function ReadyDot({ ready }: { ready: boolean }) {
  const { t } = useI18n();
  const color = ready ? '#4ADE80' : '#F87171';
  const label = ready ? t('settings.providers.ready') : t('settings.providers.notAvailable');
  return (
    <span
      aria-label={label}
      title={label}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        boxShadow: ready ? `0 0 6px ${color}66` : 'none',
      }}
    />
  );
}

// ── Active badge ──────────────────────────────────────────────────

function ActiveBadge() {
  const { t } = useI18n();
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        color: '#4ADE80',
        background: 'rgba(74,222,128,0.12)',
        border: '1px solid rgba(74,222,128,0.28)',
        borderRadius: 3,
        padding: '1px 6px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
    >
      {t('settings.providers.activeBadge')}
    </span>
  );
}

// ── Single backend card ───────────────────────────────────────────

interface BackendCardProps {
  descriptor: BackendReadiness;
  isActive: boolean;
}

function BackendCard({ descriptor, isActive }: BackendCardProps) {
  const { label, ready, reason, howToEnable } = descriptor;

  return (
    <div
      style={{
        padding: '10px 14px',
        background: isActive
          ? 'rgba(74,222,128,0.05)'
          : ready
            ? 'var(--color-panel-2)'
            : 'rgba(248,113,113,0.04)',
        border: `1px solid ${
          isActive
            ? 'rgba(74,222,128,0.22)'
            : ready
              ? 'var(--color-border)'
              : 'rgba(248,113,113,0.18)'
        }`,
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      {/* Header row: dot + label + active badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ReadyDot ready={ready} />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: ready ? 'var(--color-text)' : 'var(--color-text-muted)',
            flex: 1,
          }}
        >
          {label}
        </span>
        {isActive && <ActiveBadge />}
      </div>

      {/* Not-ready reason */}
      {!ready && reason && (
        <p
          style={{
            margin: 0,
            fontSize: 11,
            color: 'rgba(248,113,113,0.75)',
            lineHeight: 1.5,
            paddingLeft: 16,
          }}
        >
          {reason}
        </p>
      )}

      {/* How-to-enable instruction */}
      {!ready && howToEnable && (
        <p
          style={{
            margin: 0,
            fontSize: 11,
            color: 'var(--color-accent-pale)',
            lineHeight: 1.5,
            paddingLeft: 16,
          }}
        >
          {howToEnable}
        </p>
      )}
    </div>
  );
}

// ── ProvidersPanel ────────────────────────────────────────────────

export function ProvidersPanel() {
  const { t } = useI18n();
  const backends = getAllBackendsReadiness(t);
  const mode = getProviderMode();
  const activeId = activeBackendId(mode);
  const isProMode = mode === 'pro' || mode === 'managed';

  return (
    <div
      data-testid="providers-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 2,
        }}
      >
        {t('settings.providers.title')}
      </div>

      {backends.map(backend => (
        <BackendCard
          key={backend.id}
          descriptor={backend}
          isActive={backend.id === activeId}
        />
      ))}

      <p
        style={{
          margin: '4px 0 0',
          fontSize: 10,
          color: 'var(--color-text-muted)',
          lineHeight: 1.5,
        }}
      >
        {t('settings.providers.cliDetectionNote')}
      </p>

      {/* Model picker: only shown in Pro / Managed mode */}
      {isProMode && <ModelPicker />}
    </div>
  );
}
