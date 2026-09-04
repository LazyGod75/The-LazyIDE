/* managedAgentFinal.ts — ACTION: FINAL handler extracted from planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 107
   (ESLint ceiling 12). This module owns the V6 proof-of-work completion
   gate and the non-blocking end-of-mission capture (brain summary, traces,
   cross-harness session resume). Behavior is copied, not redesigned.
   Does not import managedAgent.ts (cycle). */

import type { ActionEvent, PlanStep, ProofArtifact, ProofRequirement } from './types.js';
import type { TFunc } from './runtime.js';
import { getPlatform } from '../platform/index.js';
import { isConflictError } from '../brain/captureQueue.js';

export function missingRequiredProofKinds(
  requirements: ProofRequirement[] | undefined,
  attached: ReadonlyArray<Pick<ProofArtifact, 'kind'>>,
): string[] {
  if (!requirements || requirements.length === 0) return [];
  const requiredKinds = Array.from(new Set(requirements.map((r) => r.kind)));
  const attachedKinds = new Set(attached.map((p) => p.kind));
  return requiredKinds.filter((k) => !attachedKinds.has(k));
}

/** V6 — bounce FINAL while required proof kinds are missing, bounded by
 *  maxProofNudges so a genuinely proof-incapable mission can still terminate
 *  (checkApproveGate's "Merger quand même" remains the final hatch). */
export function shouldBounceFinal(opts: {
  proofRequirements?: ProofRequirement[];
  attachedProofs: ReadonlyArray<Pick<ProofArtifact, 'kind'>>;
  proofNudges: number;
  maxProofNudges: number;
}): string[] | null {
  if (!opts.proofRequirements?.length || opts.proofNudges >= opts.maxProofNudges) return null;
  const missing = missingRequiredProofKinds(opts.proofRequirements, opts.attachedProofs);
  return missing.length > 0 ? missing : null;
}

export function missingProofNudgeContent(kindsList: string): string {
  return `ERROR: cannot finish yet — this mission's contract still requires proof of kind(s): ${kindsList}, and none has been attached yet. Call ACTION: attach_proof for each missing kind (reflecting work you actually did — never fabricate a result) before calling FINAL again.`;
}

/**
 * Auto-capture mission summary to brain (Brain Synergy). Bypasses
 * capture.ts's dispatch() — must apply isConflictError itself (BUG 3,
 * e7835e9). A "Note already exists" rejection (same slug+day) is swallowed.
 * MUST be awaited so a rejection cannot escape as an unhandled promise
 * (qa-run7 `[pageerror] store exited`).
 */
export async function captureManagedMissionEnd(opts: {
  missionId: string;
  missionTitle: string;
  coreTask: string;
  model: string;
  summary: string;
  messages: Array<{ role: string; content: string }>;
  processTraces: () => Promise<void>;
}): Promise<void> {
  try {
    await getPlatform().brain.capture({
      kind: 'agent',
      title: `[mission] ${opts.missionTitle}`,
      text: `Task: ${opts.coreTask}\nSummary: ${opts.summary}\nModel: ${opts.model}`,
      tags: ['agent', 'mission', 'auto-capture'],
      source: 'lazy-ide:managed-agent',
      space: 'code',
    });
  } catch (err) {
    if (!isConflictError(err)) {
      console.warn('[managedAgent] mission summary capture failed:', err);
    }
  }
  try {
    await opts.processTraces();
  } catch { /* non-blocking */ }
  try {
    const { captureSession } = await import('./sessionResume.js');
    await captureSession({
      missionId: opts.missionId,
      task: opts.coreTask,
      harness: 'managed',
      conversationHistory: opts.messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
      filesChanged: [],
      keyDecisions: [],
      timestamp: Date.now(),
    });
  } catch { /* non-blocking */ }
}

export async function finishManagedFinal(opts: {
  proofRequirements?: ProofRequirement[];
  attachedProofs: ReadonlyArray<Pick<ProofArtifact, 'kind'>>;
  proofNudges: number;
  maxProofNudges: number;
  args: Record<string, unknown>;
  t?: TFunc;
  nowTime: () => string;
  onAction: (event: ActionEvent) => void;
  onStep: (stepIdx: number, state: PlanStep['state'], meta?: string) => void;
  onProgress: (pct: number) => void;
  emitMetrics: (outcome: { type: 'completed' }) => void;
  capture: (summary: string) => Promise<void>;
}): Promise<{ flow: 'continue'; proofNudges: number; bounceContent: string } | { flow: 'done' }> {
  const missingKinds = shouldBounceFinal({
    proofRequirements: opts.proofRequirements,
    attachedProofs: opts.attachedProofs,
    proofNudges: opts.proofNudges,
    maxProofNudges: opts.maxProofNudges,
  });
  if (missingKinds) {
    const kindsList = missingKinds.join(', ');
    opts.onAction({
      time: opts.nowTime(),
      text: opts.t
        ? opts.t('agents.managedAgent.missingProofBeforeFinal', { kinds: kindsList })
        : `Preuve manquante avant de terminer (${kindsList}) — relance de l'agent pour l'attacher`,
      isLive: false,
    });
    return {
      flow: 'continue',
      proofNudges: opts.proofNudges + 1,
      bounceContent: missingProofNudgeContent(kindsList),
    };
  }
  const summary = String(opts.args.summary ?? 'Task completed');
  await opts.capture(summary);
  const done = `done · ${opts.nowTime()}`;
  opts.onStep(1, 'done', done);
  opts.onStep(2, 'done', done);
  opts.onStep(3, 'done', done);
  opts.onStep(4, 'done', done);
  opts.onProgress(100);
  opts.onAction({ time: opts.nowTime(), text: `Agent done: ${summary}`, isLive: false });
  opts.emitMetrics({ type: 'completed' });
  return { flow: 'done' };
}
