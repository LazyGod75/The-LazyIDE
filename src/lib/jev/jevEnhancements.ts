/* jevEnhancements.ts — the optional, Jev-mode-gated enhancements.

   Every function here is ADDITIVE: it is called only when isJevModeOn()
   is true (checked again inside each function — call sites should not
   rely on the outer gate alone) and EVERY failure path returns
   `undefined`/the original input so the caller falls back to the exact
   deterministic behavior that exists without a TypeSafe key.

   Thresholds are deliberately conservative first passes — Jev answers
   carry calibrated probabilities, but they still need real-world tuning
   (per the TypeSafe docs' own guidance). Tune the constants below, never
   spread magic numbers across call sites.
*/

import { jevAsk, JevError } from './jevClient.js';
import { isJevModeOn } from './jevMode.js';
import { emitJevJudgment } from './jevJournal.js';
import type { JevQuestion } from './jevTypes.js';
import type { LazyBotSummary } from '../bots/botManagerContext.js';
import type { WakeupCandidate, WakeupEventKind } from '../agents/managerWakeup.js';
import type { FederatedRecallHit } from '../brain/federatedRecall.js';

// ── Shared thresholds (first pass — calibrate on real usage) ────────

/** P(yes) under which a noul judgment is treated as "no". */
const NOUL_YES_THRESHOLD = 0.6;
/** Minimum choice probability to trust a disambiguation pick. */
const CHOICE_MIN_PROBABILITY = 0.5;
/** Per-item noul cutoff for wakeup keep-lists. */
const WAKEUP_KEEP_THRESHOLD = 0.5;
/** Per-hit noul cutoff for recall rerank (a hit below it is dropped). */
const RECALL_KEEP_THRESHOLD = 0.4;
/** Per-call question-count safety cap for batch judgments. */
const MAX_BATCH_ITEMS = 10;

const TIMEOUT_INTERACTIVE_MS = 2_500;
// Background paths (wakeup consult, batched questions) get a wider budget —
// a multi-question batch measured live takes ~1.5-3s, and the wakeup path is
// already debounced by seconds, so latency here is invisible to the user.
const TIMEOUT_BACKGROUND_MS = 4_000;
// Rerank sits on the manager-turn path so it can't take the full background
// budget — but a ≤10-question batch still needs ~1.5-2s (measured live; the
// API runs same-state questions in parallel). The old 450ms made the rerank
// time out almost always → dead feature. Still fail-open on timeout.
const TIMEOUT_RERANK_MS = 2_000;

// ── 1. LazyBot intent disambiguation (manager fallback) ─────────────

export interface JevLazyBotIntent {
  botId: string;
  task: string;
}

const MAX_JEV_LAZYBOT_TASK_CHARS = 4_000;

/**
 * The model emitted no executable action and the deterministic LAYER-3
 * regexes found nothing. Ask Jev whether the user actually wants a bot
 * run, and if so which bot. Returns undefined on any doubt — a missed
 * fallback is cheap, a wrong auto-launched bot is not.
 */
export async function jevResolveLazyBotIntent(
  userText: string,
  bots: readonly LazyBotSummary[],
): Promise<JevLazyBotIntent | undefined> {
  if (!isJevModeOn() || bots.length === 0) return undefined;
  const user = userText.trim();
  if (!user) return undefined;

  const questions: Record<string, JevQuestion> = {
    wants_run: {
      type: 'noul',
      instructions:
        'The user wrote the request below to an IDE orchestrator. ' +
        'Is the user asking to RUN/LAUNCH/START a bot or agent to perform a task right now ' +
        '(rather than asking a question, requesting configuration, or chatting)?',
      criteria: {
        true: 'The request asks for a bot/agent to be launched now',
        false: 'A question, a configuration request, or casual chat — nothing to launch',
      },
    },
  };
  const botIds = bots.map((b) => b.id);
  if (botIds.length > 1) {
    questions.which_bot = {
      type: 'choice',
      instructions:
        'If the user wants to run a bot, which of the available bots is the best match ' +
        'for what they described? Choose "none" if no bot clearly matches.',
      criteria: Object.fromEntries([
        ...bots.map((b) => [b.id, b.name]),
        ['none', 'none of the bots clearly matches'],
      ]),
    };
  }

  const state = {
    user_request: user.slice(0, 1_500),
    available_bots: bots.map((b) => ({ id: b.id, name: b.name, enabled: b.enabled })),
  };

  try {
    const t0 = Date.now();
    const res = await jevAsk(state, questions, { timeoutMs: TIMEOUT_INTERACTIVE_MS });
    const latencyMs = Date.now() - t0;

    const wantsRun = res.answers.wants_run;
    if (wantsRun?.type !== 'noul' || wantsRun.noul < NOUL_YES_THRESHOLD) {
      emitJevJudgment(res, latencyMs, { subject: 'lazybot_fallback', applied: false });
      return undefined;
    }

    let botId: string | undefined;
    if (botIds.length === 1) {
      botId = botIds[0];
    } else {
      const which = res.answers.which_bot;
      if (which?.type === 'choice' && which.choice !== 'none') {
        const prob = which.probabilities?.[which.choice] ?? 0;
        if (prob >= CHOICE_MIN_PROBABILITY && botIds.includes(which.choice)) {
          botId = which.choice;
        }
      }
    }
    if (!botId) {
      emitJevJudgment(res, latencyMs, { subject: 'lazybot_fallback', applied: false });
      return undefined;
    }

    emitJevJudgment(res, latencyMs, {
      subject: 'lazybot_fallback',
      applied: true,
      note: `picked ${botId}`,
    });
    return { botId, task: user.slice(0, MAX_JEV_LAZYBOT_TASK_CHARS) };
  } catch (err) {
    if (!(err instanceof JevError)) console.warn('[jev] lazybot fallback failed:', err);
    return undefined;
  }
}

// ── 2. Wakeup batch triage ───────────────────────────────────────────

export interface JevWakeupVerdict {
  /** Whether this batch is worth spending a manager turn on at all. */
  proceed: boolean;
  /** Kinds worth relaying — absent means "keep the whole batch". */
  keep?: readonly WakeupEventKind[];
}

/**
 * Second opinion on a debounced wakeup batch, right before it burns a
 * manager turn (a full LLM call). A low-worth batch is dropped; a mixed
 * batch is filtered to the events worth relaying. Returns undefined on
 * any failure — the caller must then proceed exactly as it does today.
 */
export async function jevJudgeWakeupBatch(
  batch: readonly WakeupCandidate[],
  projectId: string,
): Promise<JevWakeupVerdict | undefined> {
  if (!isJevModeOn() || batch.length === 0) return undefined;

  const items = batch.slice(0, MAX_BATCH_ITEMS);
  const questions: Record<string, JevQuestion> = {
    worth_a_turn: {
      type: 'noul',
      instructions:
        'These background events just fired in an IDE. Waking the orchestrator costs a ' +
        'full LLM turn — is anything here genuinely worth interrupting to inform the user ' +
        'about or act on (a real failure needing attention, a finished deliverable, a ' +
        'blocked approval), as opposed to routine noise?',
      criteria: {
        true: 'At least one event needs user attention or action (failure, blocked approval, finished deliverable)',
        false: 'Only routine noise — nothing the user would want to be interrupted for',
      },
    },
  };
  if (items.length > 1) {
    for (let i = 0; i < items.length; i++) {
      questions[`keep_${i}`] = {
        type: 'noul',
        instructions: `Is the event at \`events[${i}]\` individually worth relaying to the user?`,
      };
    }
  }

  const state = {
    events: items.map((c) => ({
      kind: c.kind,
      missionId: c.missionId,
      reason: c.reason?.slice(0, 200),
      role: c.role,
      targetRef: c.targetRef,
      botName: c.botName,
      report: c.report?.slice(0, 300),
      hygieneTotal: c.hygieneTotal,
      opsStep: c.opsStep,
      opsDetail: c.opsDetail?.slice(0, 200),
    })),
  };

  try {
    const t0 = Date.now();
    const res = await jevAsk(state, questions, { timeoutMs: TIMEOUT_BACKGROUND_MS });
    const latencyMs = Date.now() - t0;

    const worth = res.answers.worth_a_turn;
    const proceed = worth?.type === 'noul' ? worth.noul >= WAKEUP_KEEP_THRESHOLD : true;

    let keep: WakeupEventKind[] | undefined;
    if (items.length > 1) {
      const kept = items.filter((_, i) => {
        const a = res.answers[`keep_${i}`];
        return a?.type === 'noul' ? a.noul >= WAKEUP_KEEP_THRESHOLD : true;
      });
      keep = [...new Set(kept.map((c) => c.kind))];
    }

    emitJevJudgment(res, latencyMs, {
      subject: 'wakeup',
      projectId,
      applied: !proceed || (keep !== undefined && keep.length < items.length),
      note: proceed ? `proceed${keep ? ` keep=${keep.join(',')}` : ''}` : 'dropped batch',
    });
    return { proceed, keep };
  } catch (err) {
    if (!(err instanceof JevError)) console.warn('[jev] wakeup judge failed:', err);
    return undefined;
  }
}

// ── 3. Mission review second opinion ─────────────────────────────────

export interface JevReviewJudgment {
  /** P(the diff satisfies the mission's task). */
  satisfies: number;
  /** 0=routine, 1=worth a look, 2=needs careful review. */
  urgency: number;
  confidence?: number;
  model?: string;
  atMs: number;
}

/**
 * Fire-and-forget second opinion on a mission entering review. The
 * caller patches the result onto the mission (displayed as a hint chip);
 * it NEVER auto-approves or auto-rejects — a human decision stays human.
 */
export async function jevScoreMissionReview(input: {
  missionTitle: string;
  missionTask?: string;
  diffFiles?: ReadonlyArray<{ filename: string }>;
  diffSnippet?: readonly string[];
  diffAdded?: number;
  diffRemoved?: number;
  emptyDeliverable?: boolean;
  projectId: string;
  missionId: string;
}): Promise<JevReviewJudgment | undefined> {
  if (!isJevModeOn()) return undefined;

  const questions: Record<string, JevQuestion> = {
    satisfies_task: {
      type: 'noul',
      instructions:
        'A mission was given a task and produced a code diff. Based on the file list ' +
        'and diff excerpt, does the change appear to accomplish what the task asked? ' +
        '(You only see a summary — answer for whether it plausibly satisfies the task.)',
    },
    review_urgency: {
      type: 'score',
      instructions:
        'How much human attention does this review deserve?',
      criteria: [
        'routine — small, clearly-scoped change',
        'worth a look — moderate scope or unclear coverage',
        'needs careful review — large, risky-looking, or possibly off-task',
      ],
    },
  };

  const state = {
    task: (input.missionTask ?? input.missionTitle).slice(0, 1_000),
    files_changed: input.diffFiles?.slice(0, 30).map((f) => f.filename),
    diff_excerpt: input.diffSnippet?.join('\n').slice(0, 2_000),
    lines_added: input.diffAdded,
    lines_removed: input.diffRemoved,
    empty_deliverable: input.emptyDeliverable === true,
  };

  try {
    const t0 = Date.now();
    const res = await jevAsk(state, questions, { timeoutMs: 4_000 });
    const latencyMs = Date.now() - t0;
    const sat = res.answers.satisfies_task;
    const urg = res.answers.review_urgency;
    if (sat?.type !== 'noul') return undefined;

    // Live-observed: the API may return a CONTINUOUS score in [0,1] rather
    // than a level index (e.g. 0.41 for a 3-level question). Normalize to a
    // 0..2 integer — <=1 is scaled up, anything else is clamped.
    const rawScore = urg?.type === 'score' ? urg.score : 0.5;
    const urgency = Math.max(0, Math.min(2, Math.round(rawScore <= 1 ? rawScore * 2 : rawScore)));

    const judgment: JevReviewJudgment = {
      satisfies: sat.noul,
      urgency,
      confidence: urg?.type === 'score' ? urg.confidence : undefined,
      model: res.model,
      atMs: Date.now(),
    };
    emitJevJudgment(res, latencyMs, {
      subject: 'review',
      projectId: input.projectId,
      missionId: input.missionId,
      applied: true,
      note: `satisfies=${sat.noul.toFixed(2)} urgency=${judgment.urgency}`,
    });
    return judgment;
  } catch (err) {
    if (!(err instanceof JevError)) console.warn('[jev] review scoring failed:', err);
    return undefined;
  }
}

// ── 4. Cross-project recall rerank ───────────────────────────────────

/**
 * Rerank/drop federated-recall hits by per-hit relevance to the manager
 * query. Returns the hits reordered (possibly fewer); returns the
 * ORIGINAL array unchanged on any failure or when every hit is dropped
 * (fail-open — an empty context block is worse than a mediocre one).
 */
export async function jevRerankRecallHits(
  query: string,
  hits: readonly FederatedRecallHit[],
  projectId: string,
): Promise<readonly FederatedRecallHit[]> {
  if (!isJevModeOn() || hits.length < 2) return hits;

  const items = hits.slice(0, MAX_BATCH_ITEMS);
  const questions: Record<string, JevQuestion> = Object.fromEntries(
    items.map((_, i) => [
      `rel_${i}`,
      {
        type: 'noul' as const,
        instructions:
          'Is this memory entry relevant to the user request being handled? ' +
          `The entry to judge is \`memories[${i}]\`.`,
      },
    ]),
  );

  const state = {
    request: query.slice(0, 800),
    memories: items.map((h) => ({ id: h.id, title: h.title, snippet: h.snippet?.slice(0, 300) })),
  };

  try {
    const t0 = Date.now();
    const res = await jevAsk(state, questions, { timeoutMs: TIMEOUT_RERANK_MS });
    const latencyMs = Date.now() - t0;

    const scored = items
      .map((h, i) => {
        const a = res.answers[`rel_${i}`];
        return { h, noul: a?.type === 'noul' ? a.noul : 1 };
      })
      .filter((s) => s.noul >= RECALL_KEEP_THRESHOLD)
      .sort((a, b) => b.noul - a.noul);

    if (scored.length === 0) {
      emitJevJudgment(res, latencyMs, {
        subject: 'recall_rerank',
        projectId,
        applied: false,
        note: 'all hits below threshold — kept original order',
      });
      return hits;
    }
    emitJevJudgment(res, latencyMs, {
      subject: 'recall_rerank',
      projectId,
      applied: true,
      note: `kept ${scored.length}/${items.length}`,
    });
    return scored.map((s) => s.h);
  } catch (err) {
    if (!(err instanceof JevError)) console.warn('[jev] recall rerank failed:', err);
    return hits;
  }
}
