/* replayTicker.ts — Agent Canvas W8d: pure display-copy composition for
   ReplayBar's one-line event ticker ("14:32 — M12 → TEST"). Kept OUT of
   ReplayBar.tsx so that file only exports a component
   (react-refresh/only-export-components) and so these helpers stay
   unit-testable without mounting the Panel/SVG tree — the same
   key-composition seam ChainEdge.tsx's `conditionLabelKey` documents.

   Every user-facing string comes from the caller-supplied `t()` (never
   hardcoded here); this module only decides WHICH key + params to use for
   a given keyframe kind.
*/

import { STAGE_LABEL_KEYS } from '../../cockpit/ProjectRow';
import type { TimelineKeyframe } from './replayModel';

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** Locale-aware HH:MM for the playhead clock + ticker prefix. */
export function formatClock(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Composes the ticker line for the last keyframe crossed, or the honest
 * empty-window copy when there is none (`canvas.replay.empty`).
 */
export function tickerText(t: TranslateFn, keyframe: TimelineKeyframe | undefined): string {
  if (!keyframe) return t('canvas.replay.empty');
  const time = formatClock(keyframe.tsMs);
  const title = keyframe.title ?? keyframe.missionId ?? '';
  if (keyframe.kind === 'created') {
    return `${time} — ${t('canvas.replay.ticker.created', { title })}`;
  }
  if (keyframe.kind === 'stage' && keyframe.stage) {
    return `${time} — ${t('canvas.replay.ticker.stage', { title, stage: t(STAGE_LABEL_KEYS[keyframe.stage]) })}`;
  }
  if (keyframe.kind === 'status' && keyframe.status) {
    return `${time} — ${t('canvas.replay.ticker.status', { title, status: t(`agents.status.${keyframe.status}`) })}`;
  }
  if (keyframe.kind === 'chain_fired') {
    return `${time} — ${t('canvas.replay.ticker.chainFired', { chainId: keyframe.chainId ?? '' })}`;
  }
  // Defect #8 fix — a non-mission row (project.registered/opened/closed,
  // ...) is now a real keyframe (see replayModel.ts's buildFleetTimeline);
  // shows its raw journal event type verbatim, same "never fabricate a
  // display label we don't actually have" honesty as every branch above.
  if (keyframe.kind === 'system' && keyframe.eventType) {
    return `${time} — ${t('canvas.replay.ticker.system', { type: keyframe.eventType })}`;
  }
  // Brain-integration wave: brain.* rows get their own line, built from the
  // REAL payload facts replayModel.ts's parseBrainKeyframeFacts already
  // extracted (never composed/guessed here) — brain.recalled shows a real
  // node count, every other brain.* type shows its own short real detail
  // (captured's kind, promoted's scope, decision_created/hit's question).
  // Falls back to the raw event type when the payload carried neither (same
  // honesty convention as the 'system' branch above).
  if (keyframe.kind === 'brain' && keyframe.eventType) {
    if (keyframe.eventType === 'brain.recalled' && keyframe.brainCount !== undefined) {
      return `${time} — ${t('canvas.replay.ticker.brainRecalled', { count: keyframe.brainCount })}`;
    }
    if (keyframe.brainDetail) {
      return `${time} — ${t('canvas.replay.ticker.brain', { type: keyframe.eventType, detail: keyframe.brainDetail })}`;
    }
    return `${time} — ${t('canvas.replay.ticker.system', { type: keyframe.eventType })}`;
  }
  return t('canvas.replay.empty');
}
