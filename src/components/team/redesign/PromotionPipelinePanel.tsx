/* PromotionPipelinePanel — manual trigger for the curated brain promotion
   pipeline (spec §11/T3.3/T4.4, lib/teams/promotionPipeline.ts).

   Deliberately a MANUAL, explicit action rather than an automatic daemon
   trigger: unlike consolidation.ts's automatic root-trunk promotion, the
   curated pipeline scores/dedups/promotes candidates from every project
   brain in one shot, which is reversible-in-spirit (nothing is deleted)
   but visible enough that a lead should choose when it runs, not have it
   fire silently on some sync cadence.

   Org-admin only (LeadView gates rendering) — runPromotionPipeline() itself
   also gates on the canUseRootTrunk (Pro+) entitlement and returns an
   honest error result rather than throwing when it isn't active.
*/

import { useState } from 'react';
import { runPromotionPipeline, type PromotionPipelineResult } from '../../../lib/teams/promotionPipeline';
import { SectionLabel, Card } from './shared';
import { useToast } from '../../ui/Toast';
import { useI18n } from '../../../i18n';

export function PromotionPipelinePanel() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PromotionPipelineResult | null>(null);

  async function handleRun() {
    if (running) return;
    setRunning(true);
    try {
      const outcome = await runPromotionPipeline();
      setResult(outcome);
      if (outcome.errors.length > 0) {
        toast(outcome.errors[0], 'error');
      } else {
        toast(
          t('team.redesign.lead.promotion.doneToast', {
            promoted: String(outcome.promoted),
            rejected: String(outcome.rejected),
          }),
          'success',
        );
      }
    } catch (err) {
      toast(t('team.redesign.lead.promotion.error', { msg: String(err).slice(0, 80) }), 'error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionLabel color="var(--color-accent-pale)">{t('team.redesign.lead.promotion.title')}</SectionLabel>
      <Card style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {t('team.redesign.lead.promotion.description')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => void handleRun()}
            disabled={running}
            data-testid="run-promotion-pipeline-btn"
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid rgba(124,92,255,0.4)',
              background: running ? 'rgba(124,92,255,0.06)' : 'rgba(124,92,255,0.12)',
              color: 'var(--color-accent-pale)',
              fontSize: 12.5,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {running ? t('team.redesign.lead.promotion.running') : t('team.redesign.lead.promotion.cta')}
          </button>
          {result && (
            <span data-testid="promotion-pipeline-result" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {t('team.redesign.lead.promotion.summary', {
                candidates: String(result.candidates.length),
                promoted: String(result.promoted),
                rejected: String(result.rejected),
              })}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
