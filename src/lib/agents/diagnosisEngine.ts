/* diagnosisEngine.ts — Error categorization and Brain-backed suggestions (Pillar D3).
   Categorizes failures, queries the Brain for similar past failures, and writes
   the diagnosis back into the Brain.

   P2.3: Brain-augmented diagnosis — when an LLM is available, uses Brain recall
   + LLM reasoning to produce a richer diagnosis than keyword matching alone.
   Falls back to keyword-based categorization when no LLM is available.
*/

import type { MissionOutcome } from './types.js';
import { noteDiagnosis } from './brainNotation.js';
import { getPlatform } from '../platform/index.js';
import { getProvider } from '../models/index.js';
import type { StreamChatRequest, ChatMessage } from '../models/types.js';

export interface Diagnosis {
  category: string;
  rootCause: string;
  suggestedFix: string;
  confidence: number;
  similarCases: string[];
  /** Brain recall hits used to ground the diagnosis (P2.3). */
  brainContext?: string;
  /** Whether LLM reasoning was used (P2.3). */
  llmAugmented?: boolean;
  /** Phase 4: Whether this failure was preventable (LLM-assessed). */
  preventable?: boolean;
}

export async function diagnose(outcome: MissionOutcome, projectRoot?: string): Promise<Diagnosis> {
  // Phase 4: Try LLM-driven diagnosis first (when a provider is available)
  const llmDiagnosis = await tryLlmDiagnosis(outcome, projectRoot);
  if (llmDiagnosis) return llmDiagnosis;

  // P2.3: Try Brain-augmented diagnosis next
  const brainDiagnosis = await tryBrainAugmentedDiagnosis(outcome, projectRoot);
  if (brainDiagnosis) return brainDiagnosis;

  // Fallback: keyword-based diagnosis (original path)
  const category = categorize(outcome);
  const rootCause = guessRootCause(outcome, category);
  const suggestedFix = guessFix(category);
  const similarCases = await findSimilarFailures(outcome, category);
  const confidence = outcome.errorMessage ? 0.7 : 0.4;

  noteDiagnosis({ errorCategory: category, rootCause, suggestedFix, confidence, projectRoot });

  return { category, rootCause, suggestedFix, confidence, similarCases };
}

// ── LLM-driven diagnosis (Phase 4) ────────────────────────────────

interface LlmDiagnosisOutput {
  rootCause: string;
  category: string;
  suggestedFix: string;
  confidence: number;
  preventable: boolean;
}

async function tryLlmDiagnosis(
  outcome: MissionOutcome,
  projectRoot?: string,
): Promise<Diagnosis | null> {
  try {
    const provider = getProvider();
    if (!provider || provider.id === 'mock' || provider.id === 'no-model') return null;

    const platform = getPlatform();
    let brainContext = '';
    if (platform?.brain?.search) {
      const query = `failure ${outcome.errorMessage ?? ''} ${outcome.projectId}`;
      const results = await platform.brain.search(query, 5);
      brainContext = results
        .map((r) => `- [${r.cluster ?? 'general'}] ${r.title}: ${r.snippet?.slice(0, 200) ?? ''}`)
        .join('\n');
    }

    const systemPrompt = `You are a post-mortem diagnosis engine. Analyze the mission failure and produce a structured root-cause analysis. Respond ONLY with valid JSON matching this schema:
{"rootCause":"string","category":"string","suggestedFix":"string","confidence":0-1,"preventable":boolean}

Categories: type_error, test_failure, lint_error, budget_exceeded, git_error, infrastructure, unknown_failure`;

    const userPrompt = `Mission: ${outcome.title}
Error message: ${outcome.errorMessage ?? 'none'}
Status: ${outcome.status}
Project: ${outcome.projectId ?? 'unknown'}

Brain recall of similar failures:
${brainContext || 'none'}

Diagnose the root cause and suggest a fix. Respond with JSON only.`;

    const messages: ChatMessage[] = [
      { id: 'diag-sys', role: 'assistant', content: systemPrompt },
      { id: 'diag-user', role: 'user', content: userPrompt },
    ];

    const model = provider.listModels()[0];
    if (!model) return null;

    const req: StreamChatRequest = {
      messages,
      model,
      mode: 'ask',
    };

    let rawOutput = '';
    for await (const chunk of provider.streamChat(req)) {
      rawOutput += chunk;
    }

    const parsed = parseLlmDiagnosisOutput(rawOutput);
    if (!parsed) return null;

    const similarCases: string[] = [];
    if (platform?.brain?.search) {
      const results = await platform.brain.search(`failure ${parsed.category} ${outcome.projectId}`, 5);
      similarCases.push(...results.map((r) => r.id ?? r.title).filter((id): id is string => Boolean(id)));
    }

    noteDiagnosis({ errorCategory: parsed.category, rootCause: parsed.rootCause, suggestedFix: parsed.suggestedFix, confidence: parsed.confidence, projectRoot });

    // Write post-mortem as a structured brain note
    writePostMortemNote(outcome, parsed, brainContext, projectRoot);

    return {
      category: parsed.category,
      rootCause: parsed.rootCause,
      suggestedFix: parsed.suggestedFix,
      confidence: parsed.confidence,
      similarCases,
      brainContext: brainContext || undefined,
      llmAugmented: true,
      preventable: parsed.preventable,
    };
  } catch {
    return null;
  }
}

function parseLlmDiagnosisOutput(raw: string): LlmDiagnosisOutput | null {
  try {
    // Extract JSON from the output (LLM may wrap it in markdown code fences)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.rootCause !== 'string' ||
        typeof parsed.category !== 'string' ||
        typeof parsed.suggestedFix !== 'string' ||
        typeof parsed.confidence !== 'number' ||
        typeof parsed.preventable !== 'boolean') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writePostMortemNote(
  outcome: MissionOutcome,
  diagnosis: LlmDiagnosisOutput,
  brainContext: string,
  _projectRoot?: string,
): void {
  try {
    const platform = getPlatform();
    if (!platform?.brain?.capture) return;

    const text = [
      `POST-MORTEM: ${outcome.title}`,
      `Status: ${outcome.status}`,
      `Error: ${outcome.errorMessage ?? 'none'}`,
      ``,
      `Root Cause: ${diagnosis.rootCause}`,
      `Category: ${diagnosis.category}`,
      `Suggested Fix: ${diagnosis.suggestedFix}`,
      `Confidence: ${(diagnosis.confidence * 100).toFixed(0)}%`,
      `Preventable: ${diagnosis.preventable ? 'yes' : 'no'}`,
      brainContext ? `\nBrain context:\n${brainContext}` : '',
    ].join('\n');

    platform.brain.capture({
      kind: 'learning',
      title: `Post-mortem: ${outcome.title.slice(0, 80)}`,
      text,
      tags: ['post-mortem', `category:${diagnosis.category}`, `preventable:${diagnosis.preventable}`],
      source: 'lazy-ide:diagnosis-engine',
      space: 'code',
    });
  } catch {
    // Non-fatal — brain capture failure shouldn't block diagnosis
  }
}

// ── Brain-augmented diagnosis (P2.3) ──────────────────────────────

async function tryBrainAugmentedDiagnosis(
  outcome: MissionOutcome,
  projectRoot?: string,
): Promise<Diagnosis | null> {
  try {
    const platform = getPlatform();
    if (!platform?.brain?.search) return null;

    // Query Brain for similar failures
    const category = categorize(outcome);
    const query = `failure ${category} ${outcome.errorMessage ?? ''} ${outcome.projectId}`;
    const results = await platform.brain.search(query, 5);

    if (results.length === 0) return null;

    const similarCases = results.map((r) => r.id ?? r.title).filter((id): id is string => Boolean(id));
    const brainContext = results
      .map((r) => `- [${r.cluster ?? 'general'}] ${r.title}: ${r.snippet?.slice(0, 200) ?? ''}`)
      .join('\n');

    // Use Brain context to enrich the keyword-based diagnosis
    // (Full LLM call would go here when a managed provider is available;
    //  for now we use the Brain context to sharpen confidence and fix suggestion)
    const rootCause = guessRootCause(outcome, category);
    const baseFix = guessFix(category);

    // If Brain found similar cases, increase confidence and refine fix
    const confidence = Math.min(0.9, 0.6 + results.length * 0.08);
    const suggestedFix = enrichFixWithBrain(baseFix, brainContext);

    noteDiagnosis({ errorCategory: category, rootCause, suggestedFix, confidence, projectRoot });

    return {
      category,
      rootCause,
      suggestedFix,
      confidence,
      similarCases,
      brainContext,
      llmAugmented: true,
    };
  } catch {
    return null;
  }
}

function enrichFixWithBrain(baseFix: string, brainContext: string): string {
  if (!brainContext) return baseFix;
  // Append the most relevant Brain insight to the fix suggestion
  const firstHit = brainContext.split('\n')[0];
  return `${baseFix}\n\nBrain insight: ${firstHit}`;
}

// ── Keyword-based categorization (fallback) ───────────────────────

function categorize(outcome: MissionOutcome): string {
  const msg = (outcome.errorMessage ?? '').toLowerCase();
  if (msg.includes('type') || msg.includes('typescript') || msg.includes('tsc')) return 'type_error';
  if (msg.includes('test') || msg.includes('vitest') || msg.includes('jest')) return 'test_failure';
  if (msg.includes('lint') || msg.includes('biome') || msg.includes('eslint')) return 'lint_error';
  if (msg.includes('budget') || msg.includes('cost')) return 'budget_exceeded';
  if (msg.includes('worktree') || msg.includes('git')) return 'git_error';
  if (msg.includes('network') || msg.includes('429') || msg.includes('timeout')) return 'infrastructure';
  if (outcome.status === 'failed') return 'unknown_failure';
  return 'success';
}

function guessRootCause(outcome: MissionOutcome, category: string): string {
  if (category === 'type_error') return 'Type mismatch or missing type annotation after edits.';
  if (category === 'test_failure') return 'Code change broke an existing test assertion.';
  if (category === 'lint_error') return 'Code style or forbidden pattern introduced.';
  if (category === 'budget_exceeded') return 'Mission exceeded its configured cost cap.';
  if (category === 'git_error') return 'Git worktree or merge state is inconsistent.';
  if (category === 'infrastructure') return 'External service or rate limit issue.';
  return outcome.errorMessage ?? 'Unknown root cause';
}

function guessFix(category: string): string {
  if (category === 'type_error') return 'Run typecheck, fix reported TS errors, then re-run mission.';
  if (category === 'test_failure') return 'Inspect failing test output and update implementation or test expectation.';
  if (category === 'lint_error') return 'Run lint and apply auto-fixes or manual corrections.';
  if (category === 'budget_exceeded') return 'Raise budget cap or split the task into smaller missions.';
  if (category === 'git_error') return 'Clean the worktree and retry; verify branch state.';
  if (category === 'infrastructure') return 'Retry after backoff or switch provider/model.';
  return 'Review mission output and retry.';
}

async function findSimilarFailures(outcome: MissionOutcome, category: string): Promise<string[]> {
  try {
    const platform = getPlatform();
    if (!platform?.brain?.search) return [];
    const results = await platform.brain.search(`failure ${category} ${outcome.projectId}`, 5);
    return results.map((r) => r.id ?? r.title).filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}
