/* managedAgentPrepare.ts — launch prelude extracted from planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 107
   (ESLint ceiling 12). This module owns the pre-loop window: brain recall,
   federated recall, startup context, harness rules, skill injection, tool
   overlays, persona, lazy-tool preload, proof policy, prompt-budget
   telemetry, steering prompt-cache wrap. Behavior is copied, not redesigned.
   Does not import managedAgent.ts (cycle). */

import type { ProofRequirement } from './types.js';
import { getPlatform } from '../platform/index.js';
import { emitBuffered } from '../journal/journal.js';
import { buildPromptBrainContext, normalizeRecall } from '../brain/context.js';
import { recordRecallSaving } from '../models/costStore.js';
import { federatedRecall, buildCrossProjectContext } from '../brain/federatedRecall.js';
import { loadHarnessSessionBlock } from './harnessRules.js';
import { projectIdFromRoot } from '../journal/projectId.js';
import {
  buildEffectiveSystemPrompt,
  buildPolicyBlock,
  resolveAgentPersona,
  type ToolPolicy,
} from './managedAgentPolicy.js';
import { loadToolProfiles } from './learnedToolProfiles.js';
import { suggestTools, getToolPromptBudget } from './toolRegistryLazy.js';
import { SteeringPipeline, type TaskProfile } from './lazyReasoningBlocks/index.js';

export interface PrepareManagedMissionOpts {
  missionId: string;
  missionTitle: string;
  missionTask?: string;
  agentName?: string;
  agentDisplayName?: string;
  agentSystemPrompt?: string;
  worktreePath: string;
  projectId: string;
  model: string;
  policy: ToolPolicy;
  proofRequirements?: ProofRequirement[];
  /** See PlanAndActManagedOpts.prelude —
   *  - 'full' (default): repo/brain recall, harness, skills, tool overlays
   *  - 'lean': persona + policy + task only (no brain)
   *  - 'bot': like lean, but injects bot-scoped topical recall for botId (D93)
   */
  prelude?: 'full' | 'lean' | 'bot';
  /** Required when prelude === 'bot' — scopes topical recall to this LazyBot. */
  botId?: string;
}

export interface ManagedMissionPrep {
  coreTask: string;
  fullTaskPrompt: string;
  effectiveSystemPrompt: string;
  lrSystemPrompt: string;
  steeringPipeline: SteeringPipeline;
}

/** Proof-of-work policy block — colocated with the launch prompt, not the
 *  shared tool registry (attach_proof is mission-loop-only). Empty when
 *  there are no requirements. */
export function buildProofPolicyBlock(proofRequirements?: ProofRequirement[]): string {
  if (!proofRequirements || proofRequirements.length === 0) return '';
  const kinds = Array.from(new Set(proofRequirements.map((r) => r.kind))).join(', ');
  return `\n\nThis mission requires proof of work before it can be marked Done (kinds required: ${kinds}). Use ACTION: attach_proof to record evidence — ARGS shape per kind: screenshot {"kind":"screenshot","path":<path to an image file you already wrote to disk>,"label":<short label>}; test_run {"kind":"test_run","command":<command>,"exitCode":<int>,"content":<raw output>}; e2e_recording {"kind":"e2e_recording","path":<path to a recording file you already wrote to disk>}; command_output {"kind":"command_output","command":<command>,"content":<raw output>}; behavior_diff {"kind":"behavior_diff","before":<behavior before>,"after":<behavior after>}. Call it at least once per required kind, reflecting work you actually did — never fabricate a result you didn't produce. If a required kind is test_run, a test command that fails or errors (e.g. no test script configured) still satisfies it — attach it as test_run with the real command (best-effort exitCode if the exact value is unclear) rather than substituting a different kind.`;
}

export async function recallManagedBrainContext(coreTask: string, missionId: string): Promise<string> {
  let brainContext = '';
  try {
    const recall = normalizeRecall(await getPlatform().brain.recall(coreTask, missionId));
    brainContext = buildPromptBrainContext(recall);
    recordRecallSaving(recall, 'mission');
  } catch {
    // Brain recall unavailable — continue without context
  }
  try {
    const fedResult = await federatedRecall(coreTask);
    const crossCtx = buildCrossProjectContext(fedResult);
    if (crossCtx) brainContext = brainContext ? brainContext + '\n' + crossCtx : crossCtx;
  } catch {
    // Cross-project recall is optional
  }
  return brainContext;
}

export async function loadManagedStartupBlock(worktreePath: string): Promise<string> {
  let startupCtx = '';
  try {
    startupCtx = await getPlatform().brain.startupContext(worktreePath);
  } catch {
    // Startup context is optional — never block agent start
  }
  return startupCtx
    ? `<brain_startup_context>\n${startupCtx}\n</brain_startup_context>\n\n`
    : '';
}

export async function loadManagedHarnessSuffix(worktreePath: string, agentName?: string): Promise<string> {
  let harnessBlock = '';
  try {
    harnessBlock = await loadHarnessSessionBlock({
      project: projectIdFromRoot(worktreePath),
      agentName,
      mode: 'mission',
      activePaths: [worktreePath],
    }, { projectRoot: worktreePath });
  } catch {
    // Harness block is optional — never block mission start
  }
  return harnessBlock ? `${harnessBlock}\n\n` : '';
}

export async function injectManagedSkillContext(coreTask: string): Promise<string> {
  try {
    const { injectSkills } = await import('./skillInjection.js');
    const skillResult = await injectSkills(coreTask);
    return skillResult.text ? skillResult.text : '';
  } catch {
    return '';
  }
}

export function composeManagedTaskPrompt(opts: {
  harnessBlockSuffix: string;
  startupBlock: string;
  coreTask: string;
  worktreePath: string;
  brainContext: string;
  skillContext: string;
}): string {
  const taskPrompt = opts.brainContext
    ? `${opts.harnessBlockSuffix}${opts.startupBlock}Task: ${opts.coreTask}\nWorking directory: ${opts.worktreePath}\n\n${opts.brainContext}`
    : `${opts.harnessBlockSuffix}${opts.startupBlock}Task: ${opts.coreTask}\nWorking directory: ${opts.worktreePath}`;
  return opts.skillContext ? `${taskPrompt}\n\n${opts.skillContext}` : taskPrompt;
}

async function loadManagedToolOverlays(): Promise<Map<string, string> | undefined> {
  try {
    const toolOverlays = await loadToolProfiles();
    return toolOverlays.size === 0 ? undefined : toolOverlays;
  } catch {
    return undefined;
  }
}

function emitManagedToolBudget(opts: {
  projectId: string;
  missionId: string;
  toolOverlays?: Map<string, string>;
  preloadToolNames: string[];
}): void {
  try {
    const budget = getToolPromptBudget('mission', opts.toolOverlays, opts.preloadToolNames);
    emitBuffered({
      tsMs: Date.now(),
      projectId: opts.projectId,
      missionId: opts.missionId,
      actor: 'agent',
      type: 'tools.context',
      payload: {
        surface: 'mission',
        totalTools: budget.totalTools,
        coreCount: budget.coreCount,
        indexCount: budget.indexCount,
        tokensApproxFull: budget.tokensApproxFull,
        tokensApproxLazy: budget.tokensApproxLazy,
        savingsPct: budget.savingsPct,
      },
    });
  } catch {
    // Telemetry is best-effort — never blocks mission start
  }
}

async function resolveManagedLoopPrompt(opts: PrepareManagedMissionOpts, coreTask: string): Promise<{
  effectiveSystemPrompt: string;
  lrSystemPrompt: string;
  steeringPipeline: SteeringPipeline;
}> {
  const toolOverlays = opts.prelude === 'lean' || opts.prelude === 'bot' ? undefined : await loadManagedToolOverlays();
  const preloadToolNames = suggestTools(coreTask);
  const persona = await resolveAgentPersona({
    agentName: opts.agentName,
    agentDisplayName: opts.agentDisplayName,
    agentSystemPrompt: opts.agentSystemPrompt,
  });
  const effectiveSystemPrompt =
    buildEffectiveSystemPrompt(persona, toolOverlays, preloadToolNames)
    + buildPolicyBlock(opts.policy)
    + buildProofPolicyBlock(opts.proofRequirements);
  emitManagedToolBudget({
    projectId: opts.projectId,
    missionId: opts.missionId,
    toolOverlays,
    preloadToolNames,
  });
  const steeringPipeline = new SteeringPipeline('coding' as TaskProfile);
  return {
    effectiveSystemPrompt,
    lrSystemPrompt: steeringPipeline.applyPromptCaching(effectiveSystemPrompt, opts.model),
    steeringPipeline,
  };
}

export async function prepareManagedMission(opts: PrepareManagedMissionOpts): Promise<ManagedMissionPrep> {
  const coreTask = opts.missionTask ?? opts.missionTitle;
  const lean = opts.prelude === 'lean' || opts.prelude === 'bot';
  const brainContext = lean ? '' : await recallManagedBrainContext(coreTask, opts.missionId);
  const startupBlock = lean ? '' : await loadManagedStartupBlock(opts.worktreePath);
  const harnessBlockSuffix = lean ? '' : await loadManagedHarnessSuffix(opts.worktreePath, opts.agentName);
  const skillContext = lean ? '' : await injectManagedSkillContext(coreTask);
  let botTopical = '';
  if (opts.prelude === 'bot' && opts.botId) {
    try {
      const { loadBotTopicalContext } = await import('../bots/botTopicalRecall.js');
      botTopical = await loadBotTopicalContext(opts.botId, coreTask);
    } catch {
      botTopical = '';
    }
  }
  const fullTaskPrompt = composeManagedTaskPrompt({
    harnessBlockSuffix,
    startupBlock,
    coreTask,
    worktreePath: opts.worktreePath,
    brainContext: botTopical || brainContext,
    skillContext,
  });
  const loopPrompt = await resolveManagedLoopPrompt(opts, coreTask);
  return { coreTask, fullTaskPrompt, ...loopPrompt };
}
