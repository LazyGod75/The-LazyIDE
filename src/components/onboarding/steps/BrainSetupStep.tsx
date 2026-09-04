/* BrainSetupStep — step 3 of 4. The heart of onboarding.
   Two choices:
     A) Start empty (default, recommended, zero cost)
     B) Seed from conversation history (detect sources, pick, estimate, run with progress)

   CONTRACT-G2: calls platform.brain.detectHistorySources(), seedEstimate(), seedBrain(),
   onSeedProgress() exclusively via the Brain interface. Never touches platform internals.
*/

import React, { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../../i18n';
import { pluralKey } from '../../../i18n/plural';
import { getPlatform } from '../../../lib/platform';
import type { HistorySource, SeedEstimate } from '../../../lib/platform';
import { SeedProgress } from '../../brain/SeedProgress';
import {
  getSeedProgressState,
  subscribeSeedProgress,
  startSeed,
  seedProgressStateToEvent,
  type SeedProgressState,
} from '../../../lib/brain/seedProgressStore';

// ── Types ──────────────────────────────────────────────────────────

type BrainChoice = 'empty' | 'seed';

// NOTE: no 'done' state here — once seeding starts, `phase` stays 'seeding'
// for the rest of this step's life. The done/active/error distinction is
// owned by the shared seedProgressStore (see `seedState` below), all
// rendered within the single `phase === 'seeding'` block, since the seed
// itself is no longer awaited to completion by this component (see
// handleSeed's doc comment).
type SeedPhase =
  | 'idle'
  | 'detecting'
  | 'picking'
  | 'estimating'
  | 'estimated'
  | 'seeding'
  | 'error'
  | 'cancelled';

interface BrainSetupStepProps {
  onNext: () => void;
  onBack: () => void;
}

// ── BrainSetupStep ────────────────────────────────────────────────

export function BrainSetupStep({ onNext, onBack }: BrainSetupStepProps) {
  const { t } = useI18n();
  const [choice, setChoice] = useState<BrainChoice>('empty');
  const [phase, setPhase] = useState<SeedPhase>('idle');
  const [sources, setSources] = useState<HistorySource[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<SeedEstimate | null>(null);
  // Tracks whether "seed" was pre-selected BY auto-detect (vs. the user
  // manually clicking the "Seed from history" card) — gates the transparency
  // note below the choice cards so it only explains the one moment that's
  // actually confusing: auto-detect can silently switch the active choice
  // to "seed" while "Start empty" isn't selected. The "Start empty" card's
  // badge reads "Zero-cost default" (not "Recommended") specifically so it
  // never contradicts a pre-selected "seed" choice — it's a factual claim
  // about the option itself, true regardless of which card is active. Once
  // true it stays true, so the note keeps explaining that context even if
  // the user toggles back and forth.
  const [autoSelectedSeed, setAutoSelectedSeed] = useState(false);
  // Real user-facing toggle (was hardcoded `false` at seedBrain() call time).
  // Defaulted once the estimate resolves — see handleEstimate below — to ON
  // when a backend was actually detected, OFF otherwise, so it never claims
  // an AI-assisted import is happening when none is available.
  const [useLlm, setUseLlm] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Global, app-lifetime seed state (src/lib/brain/seedProgressStore.ts) —
  // NOT a local subscription to platform.brain.onSeedProgress() anymore.
  // The seed itself is started via startSeed() below, which owns the
  // platform.brain.seedBrain() call and keeps updating this shared store
  // regardless of whether this component is still mounted — this is what
  // lets the user leave/close this step (or the whole onboarding wizard)
  // the instant they click "Lancer l'import" without abandoning progress
  // tracking or losing the eventual result. Read here purely for THIS
  // step's own live progress card while the user is still looking at it.
  const [seedState, setSeedState] = useState<SeedProgressState>(getSeedProgressState);
  useEffect(() => subscribeSeedProgress(setSeedState), []);

  // Auto-detect on mount: when this machine actually has importable history,
  // preselect "Seed from history" instead of defaulting every user to
  // "Start empty" regardless of what's available. Still fully overridable —
  // handleChooseEmpty below works exactly as it did before. Best-effort:
  // a detection failure here just leaves the default ("empty") choice in
  // place; the user can still explicitly click "Seed from history" (which
  // retries detection via handleChooseSeed).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detected = await getPlatform().brain.detectHistorySources();
        if (cancelled) return;
        const hasHistory = detected.some(s => s.available && s.itemCount > 0);
        if (!hasHistory) return;
        setSources(detected);
        setSelected(detected.filter(s => s.available).map(s => s.source));
        setChoice('seed');
        setPhase('picking');
        setAutoSelectedSeed(true);
      } catch {
        // Non-fatal — "Start empty" stays the default choice.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Choice: empty brain ──────────────────────────────────────────

  const handleChooseEmpty = useCallback(() => {
    setChoice('empty');
    setPhase('idle');
  }, []);

  // ── Choice: seed from history ────────────────────────────────────

  const handleChooseSeed = useCallback(async () => {
    setChoice('seed');
    setPhase('detecting');
    setErrorMsg(null);
    setSources([]);
    setSelected([]);
    setEstimate(null);

    try {
      const detected = await getPlatform().brain.detectHistorySources();
      setSources(detected);
      // Pre-select all available sources.
      setSelected(detected.filter(s => s.available).map(s => s.source));
      setPhase('picking');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Detection failed: ${msg}`);
      setPhase('error');
    }
  }, []);

  // ── Toggle source selection ──────────────────────────────────────

  const toggleSource = useCallback((source: string) => {
    setSelected(prev =>
      prev.includes(source)
        ? prev.filter(s => s !== source)
        : [...prev, source]
    );
  }, []);

  // ── Estimate ─────────────────────────────────────────────────────

  const handleEstimate = useCallback(async () => {
    if (selected.length === 0) return;
    setPhase('estimating');
    setErrorMsg(null);

    try {
      const est = await getPlatform().brain.seedEstimate(selected);
      setEstimate(est);
      // Default ON only when a real backend was detected — never claims an
      // AI-assisted import is about to happen when none is available.
      setUseLlm(est.llmAvailable ?? false);
      setPhase('estimated');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`Estimate failed: ${msg}`);
      setPhase('error');
    }
  }, [selected]);

  // ── Start seed ────────────────────────────────────────────────────
  //
  // NON-BLOCKING BY DESIGN (owner directive): startSeed() is deliberately
  // NOT awaited here. It kicks off platform.brain.seedBrain() and updates
  // the shared seedProgressStore as events arrive; this handler returns
  // immediately so the user can click "Continuer" (see the nav button
  // below, no longer disabled during seeding) right away and keep using
  // the rest of the app while the import/index/synthesize/serve pipeline
  // runs in the background. Progress for THIS step's own card comes from
  // `seedState` (subscribed above) and survives this component unmounting.

  const handleSeed = useCallback(() => {
    setPhase('seeding');
    setErrorMsg(null);
    void startSeed({ sources: selected, useLlm });
  }, [selected, useLlm]);

  // ── Cancel seed ───────────────────────────────────────────────────
  //
  // Dismisses THIS step's own progress card only — it never has (before or
  // after this change) actually aborted the backend pipeline; brain_seed
  // has no cancellation hook. The shared store keeps tracking the real
  // backend state regardless, so the Brain page still reflects the true
  // outcome even after the user "cancels" the view here.

  const handleCancel = useCallback(() => {
    setPhase('cancelled');
  }, []);

  // ── Retry ─────────────────────────────────────────────────────────

  const handleRetryDetect = useCallback(() => {
    handleChooseSeed();
  }, [handleChooseSeed]);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-text)', marginBottom: 6 }}>
          {t('onboarding.brain.title')}
        </div>
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {t('onboarding.brain.description')}
        </div>
      </div>

      {/* Choice cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ChoiceCard
          selected={choice === 'empty'}
          onClick={handleChooseEmpty}
          title={t('onboarding.brain.startEmpty')}
          badge={t('onboarding.brain.zeroCostDefault')}
          badgeColor="var(--color-success)"
          description={t('onboarding.brain.startEmpty.desc')}
        />
        <ChoiceCard
          selected={choice === 'seed'}
          onClick={handleChooseSeed}
          title={t('onboarding.brain.seedFromHistory')}
          description={t('onboarding.brain.seedFromHistory.desc')}
        />
      </div>

      {/* Transparency note: explains why "Seed from history" can already be
          the active choice on load. The "Start empty" card's badge is a
          factual "Zero-cost default" claim, not a "Recommended" one, so it
          no longer contradicts the pre-selection -- this note just adds the
          missing context (why seed got picked automatically). Only shown
          when auto-detect (not a manual click) made that switch. */}
      {autoSelectedSeed && choice === 'seed' && (
        <InfoCard>{t('onboarding.brain.autoDetectedNote')}</InfoCard>
      )}

      {/* Seed flow */}
      {choice === 'seed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Detecting */}
          {phase === 'detecting' && (
            <InfoCard>{t('onboarding.brain.scanning')}</InfoCard>
          )}

          {/* Picking sources */}
          {phase === 'picking' && (
            <SourcePicker
              sources={sources}
              selected={selected}
              onToggle={toggleSource}
              onEstimate={handleEstimate}
            />
          )}

          {/* Estimating */}
          {phase === 'estimating' && (
            <InfoCard>{t('onboarding.brain.estimating')}</InfoCard>
          )}

          {/* Estimated — show cost and confirm */}
          {phase === 'estimated' && estimate && (
            <EstimateCard
              estimate={estimate}
              useLlm={useLlm}
              onToggleUseLlm={setUseLlm}
              onConfirm={handleSeed}
              onBack={() => setPhase('picking')}
            />
          )}

          {/* Seeding — status is driven by the SHARED seed store, not a
              local phase transition (this component no longer awaits the
              seed to completion — see handleSeed above), so it stays
              accurate however long the import takes and even if the user
              navigates back to this step later. While active: animated
              spinner + the real, whole-pipeline percent (never a bare line
              of text) plus an explicit note that the build continues in
              the background. Once settled: success (done, with the step's
              own Continue button alongside the persistent nav button
              below), or — in the rare case seedBrain() itself rejected
              outright — an error card with retry. See
              seedProgressStore.ts's `error` field doc comment for exactly
              when that fires: NOT on a benign per-source hiccup, which the
              backend continues past (SeedProgress already renders that as
              an inline warning within the running view). */}
          {phase === 'seeding' && (
            <>
              <SeedProgress
                status={seedState.error ? 'error' : (seedState.active ? 'running' : 'done')}
                progress={seedProgressStateToEvent(seedState)}
                result={seedState.result}
                errorMessage={seedState.error}
                onCancel={seedState.active ? handleCancel : undefined}
                onRetry={seedState.error ? handleSeed : undefined}
                onDone={!seedState.active ? onNext : undefined}
                doneLabel={t('onboarding.model.continue')}
              />
              {seedState.active && (
                <InfoCard>{t('onboarding.brain.backgroundNote')}</InfoCard>
              )}
            </>
          )}

          {/* Cancelled */}
          {phase === 'cancelled' && (
            <WarnCard>
              {t('onboarding.brain.importCancelled')}
            </WarnCard>
          )}

          {/* Error */}
          {phase === 'error' && (
            <ErrorCard message={errorMsg ?? t('onboarding.brain.unknownError')} onRetry={handleRetryDetect} />
          )}

          {/* Web mode: no sources found */}
          {phase === 'picking' && sources.length === 0 && (
            <WarnCard>
              {t('onboarding.brain.noSourcesDetected')}
            </WarnCard>
          )}
        </div>
      )}

      {/* Navigation — sticky within the modal's scrollable body (see
          OnboardingModal.tsx's bodyStyle) so Back/Continue stay reachable
          without extra scrolling once this step's content grows past the
          window height, instead of rendering past the bottom edge. */}
      <div style={navFooterStyle}>
        <button onClick={onBack} style={ghostButtonStyle}>
          {t('onboarding.model.back')}
        </button>
        {/* Always enabled, including while a seed is actively running in
            the background (owner directive — NON-BLOCKING onboarding): the
            build continues regardless of which step/screen the user is on;
            see backgroundNote above and seedProgressStore.ts. */}
        <button onClick={onNext} style={primaryButtonStyle}>
          {t('onboarding.model.continue')}
        </button>
      </div>
    </div>
  );
}

// ── ChoiceCard ────────────────────────────────────────────────────

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
      {/* Radio dot */}
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
              // No forced text-transform here -- the onboarding.model step's
              // equivalent badge (ModeRow, ModelCheckStep.tsx) renders its
              // translated string as-is. Uppercasing only this one made the
              // same "Recommended" copy read as two different badges
              // ("Recommended" vs "RECOMMENDED") across adjacent steps.
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

// ── SourcePicker ─────────────────────────────────────────────────

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
  const { t, locale } = useI18n();
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
          {t(pluralKey('onboarding.brain.items', source.itemCount, locale), { count: source.itemCount.toLocaleString() })}
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

// ── EstimateCard ─────────────────────────────────────────────────

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
  const tokenCostCredits = Math.round((estimate.estTokens / 1_000_000) * 3 * 100); // ~3 credits per 1M input tokens (Sonnet ballpark)

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

      {/* useLlm toggle — disabled (and forced off) when no backend was
          detected, so it can never claim an AI-assisted import that isn't
          actually possible. */}
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

// ── Utility cards ─────────────────────────────────────────────────

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

// ── Styles ────────────────────────────────────────────────────────

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

// Pins the nav row to the bottom of the nearest scrolling ancestor (the
// modal's body — see OnboardingModal.tsx) once the step's content is taller
// than the available height, instead of requiring the user to scroll all
// the way past a long source list/estimate card to find Back/Continue.
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
