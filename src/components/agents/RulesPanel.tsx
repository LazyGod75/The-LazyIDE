/* RulesPanel.tsx — Harness Rules management panel (brain-as-harness, G2/G5).
   Lists the project's harness rules stored as brain neurons
   (data-cerveau-type="rule"), lets the user add a manual rule, and
   triggers the brain → AGENTS.md projection.

   Design notes:
   - Read path uses harnessRules.listRules (structural CSS query over the
     brain); the brain is the single source of truth.
   - Write path uses harnessRules.captureRule (fire-and-forget; a brain
     failure is surfaced as a non-blocking note, never a crash).
   - The trial → proven → evicted lifecycle is driven by the learning
     loop (harnessLearning.ts); this panel only DISPLAYS status.
   - The panel is deliberately standalone (no store dependency) so it can
     be mounted anywhere in the Brain space or Settings.
*/

import { useEffect, useState, useCallback } from 'react';
import type { HarnessRule, RuleScope, RuleStatus } from '../../lib/agents/harnessRules';
import {
  listRules,
  captureRule,
  importProjectOnboardingFile,
  writeAgentsMdProjection,
} from '../../lib/agents/harnessRules';
import { useI18n } from '../../i18n';

const STATUS_COLORS: Record<RuleStatus, string> = {
  trial: '#FBB924',
  proven: '#4ADE80',
  evicted: '#6B7280',
};

export function RulesPanel({ projectRoot, project }: { projectRoot?: string | null; project?: string }) {
  const { t } = useI18n();

  const SCOPE_LABELS: Record<RuleScope, string> = {
    general: t('rulesPanel.scopeGeneral'),
    project: t('rulesPanel.scopeProject'),
    module: t('rulesPanel.scopeModule'),
    agent: t('rulesPanel.scopeAgent'),
    mode: t('rulesPanel.scopeMode'),
  };
  const [rules, setRules] = useState<HarnessRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<RuleScope>('project');
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const found = await listRules({ limit: 200 });
    setRules(found);
    setLoading(false);
  }, []);

  useEffect(() => {
    listRules({ limit: 200 }).then((found) => {
      setRules(found);
      setLoading(false);
    });
  }, []);

  const handleAdd = async (): Promise<void> => {
    const body = draft.trim();
    if (!body) return;
    await captureRule({
      id: `manual-${Date.now().toString(36)}`,
      title: `[rule] ${body.slice(0, 100)}`,
      body,
      scope,
      project,
      priority: 90,
      source: 'manual',
      status: 'proven',
      tags: ['manual'],
    });
    setDraft('');
    setNote(t('rulesPanel.ruleAdded'));
    await refresh();
  };

  const handleImport = async (): Promise<void> => {
    if (!projectRoot) {
      setNote(t('rulesPanel.openProjectToImport'));
      return;
    }
    const count = await importProjectOnboardingFile(projectRoot, project);
    setNote(count > 0 ? t('rulesPanel.importedCount', { count }) : t('rulesPanel.noNewRules'));
    await refresh();
  };

  const handleProjection = async (): Promise<void> => {
    if (!projectRoot) {
      setNote(t('rulesPanel.openProjectToGenerate'));
      return;
    }
    const result = await writeAgentsMdProjection(projectRoot, { project });
    setNote(result.written ? t('rulesPanel.projectionDone') : t('rulesPanel.projectionFailed', { reason: result.reason }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{t('rulesPanel.header')}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={handleImport} style={buttonStyle} disabled={!projectRoot}>
            {t('rulesPanel.importButton')}
          </button>
          <button onClick={handleProjection} style={buttonStyle} disabled={!projectRoot}>
            {t('rulesPanel.generateButton')}
          </button>
          <button onClick={refresh} style={buttonStyle} aria-label={t('common.refresh')}>↻</button>
        </div>
      </div>

      {note && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', background: 'rgba(124,92,255,0.08)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 6, padding: '6px 10px' }}>
          {note}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <select value={scope} onChange={(e) => setScope(e.target.value as RuleScope)} style={{ ...inputStyle, width: 120 }}>
          {Object.entries(SCOPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          placeholder={t('rulesPanel.newRulePlaceholder')}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button onClick={handleAdd} style={buttonStyle}>{t('rulesPanel.addButton')}</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {loading ? (
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{t('rulesPanel.loading')}</div>
        ) : rules.length === 0 ? (
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
            {t('rulesPanel.empty')}
          </div>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6,
                padding: '8px 10px',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  marginTop: 4,
                  flexShrink: 0,
                  background: STATUS_COLORS[rule.status] ?? '#6B7280',
                }}
                title={t('rulesPanel.statusTitle', { status: rule.status })}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', lineHeight: 1.4 }}>
                  {rule.body}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
                  {SCOPE_LABELS[rule.scope] ?? rule.scope} · {rule.status} · {t('rulesPanel.metaSource')}: {rule.source}
                  {rule.project ? ` · ${t('rulesPanel.metaProject')}: ${rule.project}` : ''}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: 'rgba(124,92,255,0.15)',
  color: '#C4B5FD',
  border: '1px solid rgba(124,92,255,0.35)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.9)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  outline: 'none',
};
