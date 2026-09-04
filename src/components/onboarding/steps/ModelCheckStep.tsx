/* ModelCheckStep — step 2 of 4.
   Presents the 3 real access modes (cli/byok/pro) with LIVE detection via
   getEngineReadiness() — the same single source of truth every other
   preflight surface uses (mission modal, assistant composer, locked managed
   models). CLI is marked "recommended" once detected ready. Picking a mode
   writes accessMode through the same saveAccessSettings() path Settings
   uses. Never hard-blocks — the user can always continue and configure
   later from Settings.
*/

import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { getEngineReadiness, engineReasonKey, type EngineReadiness } from '../../../lib/models/entitlement';
import { detectAllCliBackends } from '../../../lib/models/cliBackendProvider';
import { loadAccessSettings, saveAccessSettings, type AccessMode } from '../../../lib/models/accessSettings';

interface ModelCheckStepProps {
  onNext: () => void;
  onBack: () => void;
}

const MODES: AccessMode[] = ['cli', 'byok', 'pro'];

const MODE_LABEL_KEYS: Record<AccessMode, string> = {
  cli: 'onboarding.model.mode.cli',
  byok: 'onboarding.model.mode.byok',
  pro: 'onboarding.model.mode.pro',
  local: 'onboarding.model.mode.local',
};

export function ModelCheckStep({ onNext, onBack }: ModelCheckStepProps) {
  const { t } = useI18n();
  const [detecting, setDetecting] = useState(true);
  const [detectionTick, setDetectionTick] = useState(0);
  const [selected, setSelected] = useState<AccessMode>(() => loadAccessSettings().accessMode ?? 'cli');

  // Actively (re-)probe CLI backends rather than trusting a possibly-stale
  // startup cache — onboarding can show before initProviderMode() finishes.
  // getEngineReadiness() stays the single source of truth for interpreting
  // the result; this just makes sure it reads fresh data.
  useEffect(() => {
    let cancelled = false;
    detectAllCliBackends().finally(() => {
      if (!cancelled) {
        setDetecting(false);
        setDetectionTick((n) => n + 1);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const readiness = useMemo<Record<AccessMode, EngineReadiness>>(() => ({
    cli: getEngineReadiness('cli'),
    byok: getEngineReadiness('byok'),
    pro: getEngineReadiness('pro'),
    local: getEngineReadiness('local'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [detectionTick]);

  const recommended: AccessMode | null = readiness.cli.ready ? 'cli' : null;

  function selectMode(mode: AccessMode): void {
    setSelected(mode);
    saveAccessSettings({ ...loadAccessSettings(), accessMode: mode });
  }

  function statusText(mode: AccessMode): string {
    if (detecting && mode === 'cli') return t('onboarding.model.checking');
    const r = readiness[mode];
    if (r.ready) return t('onboarding.model.ready');
    return r.reason ? t(engineReasonKey(r.reason)) : t('onboarding.model.checking');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-text)', marginBottom: 6 }}>
          {t('onboarding.model.title')}
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {t('onboarding.model.description')}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {MODES.map((mode) => (
          <ModeRow
            key={mode}
            label={t(MODE_LABEL_KEYS[mode])}
            recommendedLabel={t('onboarding.model.recommended')}
            statusText={statusText(mode)}
            ready={readiness[mode].ready}
            recommended={recommended === mode}
            selected={selected === mode}
            onSelect={() => selectMode(mode)}
          />
        ))}
      </div>

      <div style={{
        padding: '8px 12px',
        background: 'rgba(124,92,255,0.08)',
        border: '1px solid var(--color-accent-border)',
        borderRadius: 6,
        fontSize: 12,
        color: 'var(--color-accent-light)',
        lineHeight: 1.5,
      }}>
        {t('onboarding.model.skipNote')}{' '}
        <strong style={{ color: 'var(--color-accent-pale)' }}>{t('onboarding.model.settingsModels')}</strong>.{' '}
        {t('onboarding.model.brainWorksNoModel')}
      </div>

      {/* Sticky within the modal's scrollable body (see OnboardingModal.tsx's
          bodyStyle) so Back/Continue stay reachable without extra scrolling
          at short window heights. */}
      <div style={navFooterStyle}>
        <button onClick={onBack} style={ghostButtonStyle}>
          {t('onboarding.model.back')}
        </button>
        <button onClick={onNext} style={primaryButtonStyle}>
          {t('onboarding.model.continue')}
        </button>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

interface ModeRowProps {
  label: string;
  recommendedLabel: string;
  statusText: string;
  ready: boolean;
  recommended: boolean;
  selected: boolean;
  onSelect: () => void;
}

function ModeRow({ label, recommendedLabel, statusText, ready, recommended, selected, onSelect }: ModeRowProps) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '10px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        background: selected ? 'var(--color-accent-soft)' : 'var(--color-panel-2)',
        border: `1px solid ${selected ? 'var(--color-accent-border)' : 'var(--color-border)'}`,
        transition: 'background 0.12s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="radio"
          name="onboarding-access-mode"
          checked={selected}
          onChange={onSelect}
          style={{ accentColor: 'var(--color-accent)', cursor: 'pointer' }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>{label}</span>
        {recommended && (
          <span style={{
            marginLeft: 'auto',
            fontSize: 10,
            fontWeight: 600,
            color: '#4ADE80',
            background: 'rgba(74,222,128,0.1)',
            border: '1px solid rgba(74,222,128,0.25)',
            borderRadius: 4,
            padding: '1px 7px',
            whiteSpace: 'nowrap',
          }}>
            {recommendedLabel}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: ready ? '#66E27A' : 'var(--color-text-muted)', paddingLeft: 24, lineHeight: 1.4 }}>
        {statusText}
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '9px 18px',
  background: 'var(--color-accent)',
  border: 'none',
  borderRadius: 7,
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'background 0.12s',
};

const ghostButtonStyle: React.CSSProperties = {
  padding: '9px 14px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 7,
  color: 'var(--color-text-muted)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const navFooterStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  position: 'sticky',
  bottom: 0,
  marginTop: 8,
  paddingTop: 12,
  paddingBottom: 4,
  background: 'var(--color-panel)',
};
