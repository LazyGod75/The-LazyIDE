/* Brain-domain tool handlers: query/query_css/neighbours/record/synthesize.
   Extracted verbatim from toolRuntime.ts's executeTool switch. */

import { getPlatform } from '../../platform/index.js';
import { isConflictError } from '../../brain/captureQueue.js';
import { buildPromptBrainContext, normalizeRecall } from '../../brain/context.js';
import { recordRecallSaving } from '../../models/costStore.js';
import { runBrainQueryCss, runBrainNeighbours } from '../../brain/brainTool.js';
import type { ToolExecutionContext } from './types.js';

export async function brainQuery(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const query = String(args.query ?? '');
  if (!query) return 'ERROR: No query provided';
  try {
    const recall = normalizeRecall(await getPlatform().brain.recall(query, _ctx.missionId));
    const ctx = buildPromptBrainContext(recall);
    recordRecallSaving(recall, 'tool');
    return ctx || `No brain results for "${query}"`;
  } catch (err) {
    return `Brain query failed: ${String(err)}`;
  }
}

export async function brainQueryCss(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const selector = String(args.selector ?? '');
  if (!selector) return 'ERROR: No selector provided';
  const limit = args.limit !== undefined ? Number(args.limit) : undefined;
  const out = await runBrainQueryCss(selector, limit);
  return out;
}

export async function brainNeighbours(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const id = String(args.id ?? '');
  if (!id) return 'ERROR: No id provided';
  const out = await runBrainNeighbours(id);
  return out;
}

export async function brainRecord(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const kind = String(args.kind ?? 'discovery');
  const title = String(args.title ?? '');
  const description = String(args.description ?? '');
  const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
  if (!title || !description) return 'ERROR: title and description required for brain_record';
  try {
    const platform = getPlatform();
    // MUST be awaited: an un-awaited call here would let a rejection
    // (e.g. a duplicate note's "Note already exists" conflict) escape
    // this try/catch as an unhandled promise rejection instead of being
    // handled below — same bug class as managedAgent.ts's FINAL-handler
    // mission-summary capture (see its doc comment for the full story).
    await platform.brain.capture({
      kind: 'agent',
      title: `[${kind}] ${title}`,
      text: description,
      tags: ['agent', 'brain-record', kind, ...tags],
      source: 'lazy-ide:tool-runtime',
      space: 'code',
    });
    return `Recorded to brain: [${kind}] ${title}`;
  } catch (err) {
    if (isConflictError(err)) {
      // Already captured by an earlier attempt (or an equivalent
      // same-day note) — see captureQueue.ts's module header. Not a
      // real failure from the agent's point of view.
      return `Recorded to brain: [${kind}] ${title}`;
    }
    console.warn('[toolRuntime] brain_record capture failed:', err);
    return `Brain record failed: ${String(err)}`;
  }
}

export async function brainSynthesize(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<string> {
  const topic = String(args.topic ?? '');
  if (!topic) return 'ERROR: No topic provided';
  try {
    const recall = normalizeRecall(await getPlatform().brain.recall(topic, _ctx.missionId));
    const ctx = buildPromptBrainContext(recall);
    recordRecallSaving(recall, 'tool');
    if (!ctx) return `No brain notes found for topic "${topic}"`;
    return `Synthesis for "${topic}":\n${ctx}`;
  } catch (err) {
    return `Brain synthesis failed: ${String(err)}`;
  }
}
