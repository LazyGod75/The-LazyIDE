import React, { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../i18n';
import { getPlatform } from '../../lib/platform';
import type { HistorySource, SeedEstimate } from '../../lib/platform';
import { SeedProgress } from './SeedProgress';
import {
  getSeedProgressState,
  subscribeSeedProgress,
  startSeed,
  seedProgressStateToEvent,
  type SeedProgressState,
} from '../../lib/brain/seedProgressStore';

type WizardChoice = 'scan-only' | 'scan-import';

type WizardPhase =
  | 'idle'
  | 'detecting'
  | 'picking'
  | 'estimating'
  | 'estimated'
  | 'seeding'
  | 'error'
  | 'cancelled';

interface AddProjectToBrainWizardProps {
  projectRoot: string;
  projectSlug: string;
  onDone: () => void;
  onCancel: () => void;
}

export function AddProjectToBrainWizard({
  projectRoot,
  projectSlug,
  onDone,
  onCancel,
}: AddProjectToBrainWizardProps) {
  const { t } = useI18n();
  const [choice, setChoice] = useState<WizardChoice>('scan-only');
  const [phase, setPhase] = useState<WizardPhase>('idle');
  const [sources, setSources] = useState<HistorySource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<SeedEstimate | null>(null);
  const [useLlm, setUseLlm] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [seedState, setSeedState] = useState<SeedProgressState>(getSeedProgressState);
  useEffect(() => subscribeSeedProgress(setSeedState), []);

  const handleScanOnly = useCallback(() => {
    setChoice('scan-only');
    setPhase('idle');
  }, []);

  const handleScanImport = useCallback(async () => {
    setChoice('scan-import');
    setPhase('detecting');
    setErrorMsg(null);
    setSources([]);
    setSelected([]);
    setEstimate(null);

    try {
      const detected = await getPlatform().brain.detectHistorySources();
      setSources(detected);
      setSelected(detected.filter(s => s.available).map(s => s.source));
      setPhase('picking');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Detection failed: ${msg}`);
      setPhase('error');
    }
  }, []);

  const toggleSource = useCallback((source: string) => {
    setSelected(prev =>
      prev.includes(source)
        ? prev.filter(s => s !== source)
        : [...prev, source]
    );
  }, []);

  const handleEstimate = useCallback(async () => {
    if (selected.length === 0) return;
    setPhase('estimating');
    setErrorMsg(null);

    try {
      const est = await getPlatform().brain.seedEstimate(selected);
      setEstimate(est);
      setUseLlm(est.llmAvailable ?? false);
      setPhase('estimated');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Estimate failed: ${msg}`);
      setPhase('error');
    }
  }, [selected]);

  const handleSeed = useCallback(() => {
    setPhase('seeding');
    setErrorMsg(null);
    void startSeed({ sources: selected, useLlm, projectRoot });
  }, [selected, useLlm, projectRoot]);

  const handleCancelSeed = useCallback(() => {
    setPhase('cancelled');
  }, []);

  const handleRetryDetect = useCallback(() => {
    handleScanImport();
  }, [handleScanImport]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-text)', marginBottom: 6 }}>
          {t('onboarding.brain.title')}
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {projectSlug}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ChoiceCard
          selected={choice === 'scan-only'}
          onClick={handleScanOnly}
          title={t('onboarding.brain.startEmpty')}
          badge={t('onboarding.brain.zeroCostDefault')}
          badgeColor="var(--color-success)"
          description={t('onboarding.brain.startEmpty.desc')}
        />
        <ChoiceCard
          selected={choice === 'scan-import'}
          onClick={handleScanImport}
          title={t('onboarding.brain.seedFromHistory')}
          description={t('onboarding.brain.seedFromHistory.desc')}
        />
      </div>

      {choice === 'scan-import' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {phase === 'detecting' && (
            <InfoCard>{t('onboarding.brain.scanning')}</InfoCard>
          )}

          {phase === 'picking' && (
            <SourcePicker
              sources={sources}
              selected={selected}
              onToggle={toggleSource}
              onEstimate={handleEstimate}
            />
          )}

          {phase === 'estimating' && (
            <InfoCard>{t('onboarding.brain.estimating')}</InfoCard>
          )}

          {phase === 'estimated' && estimate && (
            <EstimateCard
              estimate={estimate}
              useLlm={useLlm}
              onToggleUseLlm={setUseLlm}
              onConfirm={handleSeed}
              onBack={() => setPhase('picking')}
            />
          )}

          {phase === 'seeding' && (
            <>
              <SeedProgress
                status={seedState.error ? 'error' : (seedState.active ? 'running' : 'done')}
                progress={seedProgressStateToEvent(seedState)}
                result={seedState.result}
                errorMessage={seedState.error}
                onCancel={seedState.active ? handleCancelSeed : undefined}
                onRetry={seedState.error ? handleSeed : undefined}
                onDone={!seedState.active ? onDone : undefined}
                doneLabel={t('onboarding.model.continue')}
              />
              {seedState.active && (
                <InfoCard>{t('onboarding.brain.backgroundNote')}</InfoCard>
              )}
            </>
          )}

          {phase === 'cancelled' && (
            <WarnCard>
              {t('onboarding.brain.importCancelled')}
            </WarnCard>
          )}

          {phase === 'error' && (
            <ErrorCard message={errorMsg ?? t('onboarding.brain.unknownError')} onRetry={handleRetryDetect} />
          )}

          {phase === 'picking' && sources.length === 0 && (
            <WarnCard>
              {t('onboarding.brain.noSourcesDetected')}
            </WarnCard>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <button onClick={onCancel} style={ghostButtonStyle}>
          {t('onboarding.model.back')}
        </button>
        {choice === 'scan-only' && (
          <button onClick={onDone} style={primaryButtonStyle}>
            {t('onboarding.model.continue')}
          </button>
        )}
      </div>
    </div>
  );
}

interface ChoiceCardProps {
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
  badge?: string;
  badgeColor?: string;
}

function ChoiceCard({ selected, onClick, title, description, badge, badgeColor }: ChoiceCardProps) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        padding: '14px 16px',
        background: selected ? 'rgba(124,92,255,0.10)' : 'var(--color-panel-2)',
        border: `1.5px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 10,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        transition: 'border-color 0.12s, background 0.12s',
        width: '100%',
      }}
    >
      <div style={{
        width: 18,
        height: 18,
        borderRadius: '50%',
        border: `2px solid ${selected ? 'var(--color-accent)' : 'rgba(255,255,255,0.2)'}`,
        background: selected ? 'var(--color-accent)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        marginTop: 2,
      }}>
        {selected && (
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff' }} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)' }}>
            {title}
          </span>
          {badge && (
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              color: badgeColor ?? 'var(--color-accent)',
              background: `${badgeColor ?? 'var(--color-accent)'}18`,
              border: `1px solid ${badgeColor ?? 'var(--color-accent)'}44`,
              borderRadius: 4,
              padding: '1px 6px',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              {badge}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {description}
        </div>
      </div>
    </button>
  );
}

interface SourcePickerProps {
  sources: HistorySource[];
  selected: string[];
  onToggle: (source: string) => void;
  onEstimate: () => void;
}

function SourcePicker({ sources, selected, onToggle, onEstimate }: SourcePickerProps) {
  const { t } = useI18n();
  const available = sources.filter(s => s.available);
  const unavailable = sources.filter(s => !s.available);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {t('onboarding.brain.detectedSources')}
      </div>

      {available.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('onboarding.brain.noSources')}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {available.map(s => (
          <SourceRow
            key={s.source}
            source={s}
            checked={selected.includes(s.source)}
            onToggle={() => onToggle(s.source)}
          />
        ))}
        {unavailable.map(s => (
          <SourceRow
            key={s.source}
            source={s}
            checked={false}
            onToggle={() => {}}
            disabled
          />
        ))}
      </div>

      <button
        onClick={onEstimate}
        disabled={selected.length === 0}
        style={{
          ...primaryButtonStyle,
          opacity: selected.length === 0 ? 0.4 : 1,
          cursor: selected.length === 0 ? 'not-allowed' : 'pointer',
          alignSelf: 'flex-start',
          marginTop: 4,
        }}
      >
        {t('onboarding.brain.estimateCost')}
      </button>
    </div>
  );
}

interface SourceRowProps {
  source: HistorySource;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

function SourceRow({ source, checked, onToggle, disabled }: SourceRowProps) {
  const { t } = useI18n();
  return (
    <label style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 14px',
      background: 'var(--color-panel-2)',
      border: `1px solid ${checked ? 'var(--color-accent-border)' : 'var(--color-border)'}`,
      borderRadius: 8,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      transition: 'border-color 0.1s',
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        style={{ accentColor: 'var(--color-accent)', width: 14, height: 14, cursor: 'inherit' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text)' }}>
          {source.label}
        </div>
        {source.path && (
          <div style={{
            fontSize: 11,
            color: 'var(--color-text-muted)',
            marginTop: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {source.path}
          </div>
        )}
      </div>
      {source.available && source.itemCount > 0 && (
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}>
          {t('onboarding.brain.items', { count: source.itemCount.toLocaleString() })}
        </span>
      )}
      {!source.available && (
        <span style={{
          fontSize: 10,
          color: 'var(--color-text-ghost)',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--color-border)',
          borderRadius: 4,
          padding: '1px 6px',
          flexShrink: 0,
        }}>
          {t('onboarding.brain.notFound')}
        </span>
      )}
    </label>
  );
}

interface EstimateCardProps {
  estimate: SeedEstimate;
  useLlm: boolean;
  onToggleUseLlm: (v: boolean) => void;
  onConfirm: () => void;
  onBack: () => void;
}

function EstimateCard({ estimate, useLlm, onToggleUseLlm, onConfirm, onBack }: EstimateCardProps) {
  const { t } = useI18n();
  const llmAvailable = estimate.llmAvailable ?? false;
  const tokenCostCredits = Math.round((estimate.estTokens / 1_000_000) * 3 * 100);

  return (
    <div style={{
      padding: '16px 18px',
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', marginBottom: 2 }}>
        {t('onboarding.brain.importEstimate')}
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <EstimateStat
          label={t('onboarding.brain.conversations')}
          value={estimate.items > 0 ? estimate.items.toLocaleString() : '—'}
        />
        <EstimateStat
          label={t('onboarding.brain.estTime')}
          value={estimate.estMinutes > 0 ? `~${estimate.estMinutes} min` : '—'}
        />
        <EstimateStat
          label={t('onboarding.brain.tokensApprox')}
          value={estimate.estTokens > 0 ? (estimate.estTokens / 1000).toFixed(0) + 'K' : '—'}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: 'var(--color-text)',
          cursor: llmAvailable ? 'pointer' : 'not-allowed',
          opacity: llmAvailable ? 1 : 0.5,
        }}>
          <input
            type="checkbox"
            checked={useLlm && llmAvailable}
            disabled={!llmAvailable}
            onChange={(e) => onToggleUseLlm(e.target.checked)}
            style={{ accentColor: 'var(--color-accent)', width: 14, height: 14 }}
          />
          {t('onboarding.brain.useLlmToggle')}
        </label>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {llmAvailable
            ? t('onboarding.brain.backendDetected', { backend: estimate.backend ?? '' })
            : t('onboarding.brain.backendNone')}
        </div>
      </div>

      {useLlm && llmAvailable && estimate.estTokens > 0 && (
        <div style={{
          padding: '10px 12px',
          background: 'rgba(251,191,36,0.06)',
          border: '1px solid rgba(251,191,36,0.2)',
          borderRadius: 7,
          fontSize: 12,
          color: '#FCD34D',
          lineHeight: 1.5,
        }}>
          <strong>{t('onboarding.brain.costEstimate', { amount: tokenCostCredits.toLocaleString('fr-FR') })}</strong> {t('onboarding.brain.costNote')}
        </div>
      )}

      {estimate.items === 0 && (
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
          {t('onboarding.brain.nothingToImport')}
        </div>
      )}

      <div style={{
        fontSize: 12,
        color: 'var(--color-text-muted)',
        lineHeight: 1.5,
        borderTop: '1px solid var(--color-border)',
        paddingTop: 12,
      }}>
        {t('onboarding.brain.importBgNote')}
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onBack} style={ghostButtonStyle}>
          {t('onboarding.brain.changeSelection')}
        </button>
        <button
          onClick={onConfirm}
          disabled={estimate.items === 0}
          style={{
            ...primaryButtonStyle,
            opacity: estimate.items === 0 ? 0.4 : 1,
            cursor: estimate.items === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {t('onboarding.brain.startImport')}
        </button>
      </div>
    </div>
  );
}

function EstimateStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}>
        {value}
      </div>
    </div>
  );
}

function InfoCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '12px 16px',
      background: 'var(--color-panel-2)',
      border: '1px solid var(--color-border)',
      borderRadius: 8,
      fontSize: 13,
      color: 'var(--color-text-muted)',
      lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

function WarnCard({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '12px 16px',
      background: 'rgba(251,191,36,0.06)',
      border: '1px solid rgba(251,191,36,0.2)',
      borderRadius: 8,
      fontSize: 12,
      color: '#FCD34D',
      lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div style={{
      padding: '14px 16px',
      background: 'rgba(248,113,113,0.07)',
      border: '1px solid rgba(248,113,113,0.25)',
      borderRadius: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{ fontSize: 13, color: '#F87171', lineHeight: 1.5 }}>
        {message}
      </div>
      <button onClick={onRetry} style={{ ...ghostButtonStyle, alignSelf: 'flex-start', fontSize: 12 }}>
        {t('onboarding.brain.tryAgain')}
      </button>
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
  padding: '7px 12px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 7,
  color: 'var(--color-text-muted)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
