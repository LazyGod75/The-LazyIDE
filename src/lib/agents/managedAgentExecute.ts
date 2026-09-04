/* managedAgentExecute.ts — ReAct tool-execution step extracted from
   planAndActManaged.

   Measured 2026-08-28: planAndActManaged cyclomatic complexity was 107
   (ESLint ceiling 12). This module owns the post-parse observation path:
   V5 identical-call dedup, attach_proof, executeTool + after-edit
   diagnostics/diff/checkpoint, tool.called journal, canvas visual overlay,
   swarm file-change. Behavior is copied, not redesigned. Does not import
   managedAgent.ts (cycle). */

import type { ToolPolicy } from './managedAgentPolicy.js';
import type { AgentPermissionMode } from './managedToolPermissions.js';
import { emitBuffered } from '../journal/journal.js';
import { emit as busEmit } from '../bus.js';
import { appendAfterEditDiagnostics } from './afterEditDiagnostics.js';
import { appendAfterEditDiff } from './afterEditDiff.js';
import { appendAfterEditCheckpoint } from './afterEditCheckpoint.js';
import { hasUndoSnapshot } from '../tools/handlers/files.js';
import { resolvePath } from '../tools/handlers/shared.js';
import { getDiagnostics } from '../tools/handlers/search.js';
import { gitDiff } from '../tools/handlers/git.js';
import { dedupNudgeObservation } from './managedAgentDedup.js';
import { getVisualToolMeta } from './managedAgentVisualMeta.js';

export function extractToolFiles(args: Record<string, unknown>): string[] | undefined {
  const files: string[] = [];
  for (const key of ['path', 'old_path', 'new_path', 'file'] as const) {
    const value = args[key];
    if (typeof value === 'string' && value) files.push(value);
  }
  if (Array.isArray(args.paths)) {
    for (const value of args.paths) {
      if (typeof value === 'string' && value) files.push(value);
    }
  }
  return files.length > 0 ? files : undefined;
}

function emitVisualAndSwarm(action: string, args: Record<string, unknown>, missionId: string): void {
  const visualToolMeta = getVisualToolMeta(action, args);
  if (visualToolMeta) {
    busEmit('canvas:toolActivity', {
      missionId,
      toolName: action,
      label: visualToolMeta.label,
      icon: visualToolMeta.icon,
      detail: visualToolMeta.detail,
    });
  }
  if (action !== 'write_file' && action !== 'edit_file' && action !== 'multi_edit') return;
  const files = extractToolFiles(args);
  if (!files || files.length === 0) return;
  for (const filePath of files) {
    busEmit('swarm:fileChange', {
      missionId,
      filePath,
      action: action === 'write_file' ? 'write' : 'edit',
      timestamp: Date.now(),
    });
  }
}

export async function observeManagedTool(opts: {
  action: string;
  args: Record<string, unknown>;
  worktreePath: string;
  policy: ToolPolicy;
  agentMode: AgentPermissionMode;
  missionId: string;
  agentName?: string;
  projectId: string;
  execute: (
    action: string,
    args: Record<string, unknown>,
    worktreePath: string,
    policy: ToolPolicy,
    agentMode: AgentPermissionMode,
    missionId: string,
    agentName: string | undefined,
    projectId: string,
  ) => Promise<string>;
}): Promise<string> {
  const toolStartedAt = Date.now();
  let observation: string;
  try {
    observation = await opts.execute(
      opts.action, opts.args, opts.worktreePath, opts.policy, opts.agentMode,
      opts.missionId, opts.agentName, opts.projectId,
    );
  } catch (err) {
    observation = `ERROR: ${String(err)}`;
  }
  const files = extractToolFiles(opts.args);
  const diagnose = (path: string) => getDiagnostics({ path }, {
    rootPath: opts.worktreePath, policy: opts.policy, agentMode: opts.agentMode,
  });
  const diffFile = (path: string) => gitDiff({ path }, {
    rootPath: opts.worktreePath, policy: opts.policy, agentMode: opts.agentMode,
  });
  observation = await appendAfterEditDiagnostics({
    action: opts.action, observation, files, diagnose,
  });
  observation = await appendAfterEditDiff({
    action: opts.action, observation, files, diffFile,
  });
  observation = appendAfterEditCheckpoint({
    action: opts.action,
    observation,
    files,
    hasCheckpoint: (path) => hasUndoSnapshot(resolvePath(opts.worktreePath, path)),
  });
  emitBuffered({
    tsMs: Date.now(),
    projectId: opts.projectId,
    missionId: opts.missionId,
    actor: 'agent',
    type: 'tool.called',
    payload: { name: opts.action, files, durationMs: Date.now() - toolStartedAt },
  });
  emitVisualAndSwarm(opts.action, opts.args, opts.missionId);
  return observation;
}

export interface ManagedObservation {
  observation: string;
  toolCallDelta: number;
  recordDedup: boolean;
}

type ObserveExecute = Parameters<typeof observeManagedTool>[0]['execute'];

export async function resolveManagedObservation(opts: {
  action: string;
  args: Record<string, unknown>;
  wasDeduped: boolean;
  firstRanAtStep: number | undefined;
  worktreePath: string;
  policy: ToolPolicy;
  agentMode: AgentPermissionMode;
  missionId: string;
  agentName?: string;
  projectId: string;
  attachProof: (args: Record<string, unknown>) => Promise<string>;
  execute: ObserveExecute;
}): Promise<ManagedObservation> {
  if (opts.wasDeduped && opts.firstRanAtStep !== undefined) {
    return {
      observation: dedupNudgeObservation(opts.firstRanAtStep),
      toolCallDelta: 0,
      recordDedup: false,
    };
  }
  if (opts.action === 'attach_proof') {
    return { observation: await opts.attachProof(opts.args), toolCallDelta: 1, recordDedup: false };
  }
  const observation = await observeManagedTool(opts);
  return { observation, toolCallDelta: 1, recordDedup: true };
}
