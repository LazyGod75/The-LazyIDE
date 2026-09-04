import React, { useState, useEffect, useCallback } from 'react';
import { useI18n } from '../../i18n';
import { useAppContext } from '../../app/AppContext';
import { getPlatform } from '../../lib/platform';
import type { HistorySource, SeedEstimate } from '../../lib/platform';
import { SeedProgress } from '../brain/SeedProgress';
import {
  getSeedProgressState,
  subscribeSeedProgress,
  startSeed,
  seedProgressStateToEvent,
  type SeedProgressState,
} from '../../lib/brain/seedProgressStore';
import { listBrainProjects } from '../../lib/brain/listProjects';
import { findDuplicates, type DedupCandidate } from '../../lib/brain/dedup';
import { resolveCaptureIdentity } from '../../lib/brain/captureAuthor';

type WizardStep = 'match' | 'kinds' | 'estimate' | 'preview' | 'seed' | 'dedup' | 'done';

const KINDS = ['decision', 'bug', 'rule', 'warning'] as const;
type Kind = (typeof KINDS)[number];

interface ProjectMatch {
  root: string;
  name: string;
  teamCluster: string | null;
  selected: boolean;
}

interface ContributeHistoryWizardProps {
  orgId: string;
  onDone: () => void;
  onCancel: () => void;
}

const primaryBtn: React.CSSProperties = {
  padding: '9px 18px', background: 'var(--color-accent)', border: 'none',
  borderRadius: 7, color: '#fff', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', fontFamily: 'inherit',
};
const ghostBtn: React.CSSProperties = {
  padding: '7px 12px', background: 'transparent', border: '1px solid var(--color-border)',
  borderRadius: 7, color: 'var(--color-text-muted)', fontSize: 12, fontWeight: 500,
  cursor: 'pointer', fontFamily: 'inherit',
};
const cardStyle: React.CSSProperties = {
  padding: '14px 16px', background: 'var(--color-panel-2)',
  border: '1px solid var(--color-border)', borderRadius: 10,
};

function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function ContributeHistoryWizard({ orgId, onDone, onCancel }: ContributeHistoryWizardProps) {
  const { t } = useI18n();
  const { openProjects } = useAppContext();
  const [step, setStep] = useState<WizardStep>('match');
  const [matches, setMatches] = useState<ProjectMatch[]>([]);
  const [selectedKinds, setSelectedKinds] = useState<Set<Kind>>(new Set(KINDS));
  const [sources, setSources] = useState<HistorySource[]>([]);
  const [estimate, setEstimate] = useState<SeedEstimate | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [seedState, setSeedState] = useState<SeedProgressState>(getSeedProgressState);
  const [dupes, setDupes] = useState<DedupCandidate[]>([]);
  const [dupeResolutions, setDupeResolutions] = useState<Record<string, 'merge' | 'keep' | 'discard'>>({});

  useEffect(() => subscribeSeedProgress(setSeedState), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const projects = await listBrainProjects();
      if (cancelled) return;
      const teamSlugs = new Set(projects.map((p) => p.project));
      const initial = openProjects.map((p) => {
        const name = basename(p.root);
        const slug = slugify(name);
        const cluster = teamSlugs.has(slug) ? slug : null;
        return { root: p.root, name, teamCluster: cluster, selected: cluster !== null };
      });
      setMatches(initial);
    })();
    return () => { cancelled = true; };
  }, [openProjects]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detected = await getPlatform().brain.detectHistorySources();
        if (cancelled) return;
        setSources(detected.filter((s) => s.available));
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleProject = useCallback((root: string) => {
    setMatches((prev) => prev.map((m) => m.root === root ? { ...m, selected: !m.selected } : m));
  }, []);

  const toggleKind = useCallback((kind: Kind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  }, []);

  const handleEstimate = useCallback(async () => {
    setStep('estimate');
    setErrorMsg(null);
    try {
      const sourceKeys = sources.map((s) => s.source);
      const est = await getPlatform().brain.seedEstimate(sourceKeys);
      setEstimate(est);
      setStep('estimate');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [sources]);

  const handleSeed = useCallback(async () => {
    setStep('seed');
    setErrorMsg(null);
    const sourceKeys = sources.map((s) => s.source);
    await resolveCaptureIdentity();
    void startSeed({ sources: sourceKeys, useLlm: false });
  }, [sources]);

  const handleDedup = useCallback(async () => {
    setStep('dedup');
    const selectedMatches = matches.filter((m) => m.selected);
    const probeItems = selectedMatches.flatMap((m) =>
      Array.from(selectedKinds).map((kind) => ({
        kind, about: m.teamCluster ?? slugify(m.name),
        text: `${kind} ${m.name}`, title: `${kind} — ${m.name}`,
      })),
    );
    const candidates = await findDuplicates(probeItems);
    setDupes(candidates);
    const initial: Record<string, 'merge' | 'keep' | 'discard'> = {};
    for (const c of candidates) {
      const key = c.existingNoteId;
      if (!(key in initial)) initial[key] = c.similarity > 0.85 ? 'merge' : 'keep';
    }
    setDupeResolutions(initial);
  }, [matches, selectedKinds]);

  useEffect(() => {
    if (step === 'seed' && !seedState.active && seedState.result) {
      void handleDedup();
    }
  }, [step, seedState.active, seedState.result, handleDedup]);

  const resolveDupe = useCallback((id: string, action: 'merge' | 'keep' | 'discard') => {
    setDupeResolutions((prev) => ({ ...prev, [id]: action }));
  }, []);

  const selectedCount = matches.filter((m) => m.selected).length;
  const canProceedMatch = selectedCount > 0;
  const canProceedKinds = selectedKinds.size > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 560 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--color-text)' }}>
          {t('contribute.title')}
        </h3>
        <button onClick={onCancel} style={ghostBtn}>{t('contribute.cancel')}</button>
      </div>

      <StepIndicator current={step} />

      {errorMsg && (
        <div style={{ ...cardStyle, borderColor: 'rgba(248,113,113,0.3)', color: '#F87171', fontSize: 13 }}>
          {errorMsg}
        </div>
      )}

      {step === 'match' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            {t('contribute.selectProjects')}
          </div>
          {matches.length === 0 && (
            <div style={{ ...cardStyle, fontSize: 13, color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
              {t('contribute.noProjects')}
            </div>
          )}
          {matches.map((m) => (
            <label key={m.root} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
              background: 'var(--color-panel-2)',
              border: `1px solid ${m.selected ? 'var(--color-accent-border)' : 'var(--color-border)'}`,
              borderRadius: 8, cursor: 'pointer',
            }}>
              <input type="checkbox" checked={m.selected} onChange={() => toggleProject(m.root)}
                style={{ accentColor: 'var(--color-accent)', width: 14, height: 14 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text)' }}>{m.name}</div>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.root}
                </div>
              </div>
              {m.teamCluster ? (
                <span style={{ fontSize: 10, color: 'var(--color-accent)', background: 'rgba(124,92,255,0.12)', border: '1px solid rgba(124,92,255,0.3)', borderRadius: 4, padding: '2px 7px' }}>
                  {m.teamCluster}
                </span>
              ) : (
                <span style={{ fontSize: 10, color: 'var(--color-text-ghost)', border: '1px solid var(--color-border)', borderRadius: 4, padding: '2px 7px' }}>
                  {t('contribute.notLinked')}
                </span>
              )}
            </label>
          ))}
          {canProceedMatch && (
            <button onClick={() => setStep('kinds')} style={{ ...primaryBtn, alignSelf: 'flex-start', marginTop: 4 }}>
              {t('contribute.continue')}
            </button>
          )}
        </div>
      )}

      {step === 'kinds' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            {t('contribute.kindsDesc')}
          </div>
          {KINDS.map((kind) => (
            <label key={kind} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
              background: 'var(--color-panel-2)',
              border: `1px solid ${selectedKinds.has(kind) ? 'var(--color-accent-border)' : 'var(--color-border)'}`,
              borderRadius: 8, cursor: 'pointer',
            }}>
              <input type="checkbox" checked={selectedKinds.has(kind)} onChange={() => toggleKind(kind)}
                style={{ accentColor: 'var(--color-accent)', width: 14, height: 14 }} />
              <span style={{ fontSize: 13, color: 'var(--color-text)', textTransform: 'capitalize' }}>{kind}</span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button onClick={() => setStep('match')} style={ghostBtn}>{t('contribute.back')}</button>
            <button onClick={handleEstimate} disabled={!canProceedKinds}
              style={{ ...primaryBtn, opacity: canProceedKinds ? 1 : 0.4, cursor: canProceedKinds ? 'pointer' : 'not-allowed' }}>
              {t('contribute.estimate')}
            </button>
          </div>
        </div>
      )}

      {step === 'estimate' && estimate && (
        <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>{t('contribute.estimateTitle')}</div>
          <div style={{ display: 'flex', gap: 16 }}>
            <Stat label={t('contribute.elements')} value={estimate.items > 0 ? estimate.items.toLocaleString() : '—'} />
            <Stat label={t('contribute.estTime')} value={estimate.estMinutes > 0 ? `~${estimate.estMinutes} min` : '—'} />
            <Stat label={t('contribute.tokens')} value={estimate.estTokens > 0 ? `${(estimate.estTokens / 1000).toFixed(0)}K` : '—'} />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={() => setStep('kinds')} style={ghostBtn}>{t('contribute.back')}</button>
            <button onClick={() => setStep('preview')} disabled={estimate.items === 0}
              style={{ ...primaryBtn, opacity: estimate.items === 0 ? 0.4 : 1, cursor: estimate.items === 0 ? 'not-allowed' : 'pointer' }}>
              {t('contribute.preview')}
            </button>
          </div>
        </div>
      )}

      {step === 'preview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ ...cardStyle, fontSize: 13, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
            {t('contribute.previewDesc', { count: estimate?.items ?? 0, kinds: selectedKinds.size, projects: selectedCount })}
          </div>
          <div style={{ ...cardStyle, borderColor: 'rgba(56,189,248,0.25)', fontSize: 12, color: '#7DD3FC', lineHeight: 1.5 }}>
            {t('contribute.secretsNote')}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setStep('estimate')} style={ghostBtn}>{t('contribute.back')}</button>
            <button onClick={handleSeed} style={primaryBtn}>{t('contribute.launch')}</button>
          </div>
        </div>
      )}

      {step === 'seed' && (
        <>
          <SeedProgress
            status={seedState.error ? 'error' : (seedState.active ? 'running' : 'done')}
            progress={seedProgressStateToEvent(seedState)}
            result={seedState.result}
            errorMessage={seedState.error}
            onCancel={undefined}
            onRetry={seedState.error ? handleSeed : undefined}
            onDone={undefined}
          />
          {seedState.active && (
            <div style={{ ...cardStyle, fontSize: 12, color: 'var(--color-text-muted)' }}>
              {t('contribute.bgNote')}
            </div>
          )}
        </>
      )}

      {step === 'dedup' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
            {t('contribute.dedupTitle')}
          </div>
          {dupes.length === 0 ? (
            <div style={{ ...cardStyle, fontSize: 13, color: 'var(--color-text-muted)' }}>
              {t('contribute.noDupes')}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {t('contribute.dupesFound', { count: dupes.length })}
              </div>
              {dupes.slice(0, 10).map((d) => (
                <div key={d.existingNoteId} style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--color-text)' }}>
                    {d.newItem.title} <span style={{ color: 'var(--color-text-muted)' }}>vs #{d.existingNoteId}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                    Simillarite: {Math.round(d.similarity * 100)}% — {d.reason}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {(['merge', 'keep', 'discard'] as const).map((action) => (
                      <button key={action} onClick={() => resolveDupe(d.existingNoteId, action)}
                        style={{
                          padding: '4px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
                          border: `1px solid ${dupeResolutions[d.existingNoteId] === action ? 'var(--color-accent)' : 'var(--color-border)'}`,
                          background: dupeResolutions[d.existingNoteId] === action ? 'rgba(124,92,255,0.12)' : 'transparent',
                          color: dupeResolutions[d.existingNoteId] === action ? 'var(--color-accent)' : 'var(--color-text-muted)',
                        }}>
                        {action === 'merge' ? t('contribute.merge') : action === 'keep' ? t('contribute.keep') : t('contribute.discard')}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button onClick={() => setStep('done')} style={primaryBtn}>{t('contribute.finish')}</button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', textAlign: 'center', padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)' }}>
            {t('contribute.done')}
          </div>
          <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
            {t('contribute.doneDesc', { orgId })}
          </div>
          <button onClick={onDone} style={primaryBtn}>{t('contribute.close')}</button>
        </div>
      )}
    </div>
  );
}

function StepIndicator({ current }: { current: WizardStep }) {
  const { t } = useI18n();
  const steps: WizardStep[] = ['match', 'kinds', 'estimate', 'preview', 'seed', 'dedup'];
  const labels: Record<string, string> = {
    match: t('contribute.step.projects'),
    kinds: t('contribute.step.kinds'),
    estimate: t('contribute.step.estimate'),
    preview: t('contribute.step.preview'),
    seed: t('contribute.step.seed'),
    dedup: t('contribute.step.dedup'),
  };
  const idx = steps.indexOf(current);
  return (
    <div style={{ display: 'flex', gap: 4, fontSize: 10, color: 'var(--color-text-muted)' }}>
      {steps.map((s, i) => (
        <React.Fragment key={s}>
          <span style={{ fontWeight: i === idx ? 700 : 400, color: i <= idx ? 'var(--color-accent)' : 'var(--color-text-ghost)' }}>
            {labels[s]}
          </span>
          {i < steps.length - 1 && <span style={{ color: 'var(--color-text-ghost)' }}>→</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
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
