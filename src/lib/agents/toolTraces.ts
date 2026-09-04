/* toolTraces — capture and process tool execution traces.

   Every executeTool call produces a trace record (tool name, args,
   success/failure, error type, correction). These traces are:
     1. Accumulated in-memory during a mission
     2. Processed at mission end to extract learning patterns
     3. Persisted to the brain as tool-profile overlays

   This is the runtime implementation of the Trace-Free+ insight:
   instead of offline trace collection + fine-tuning, we collect traces
   in-memory per mission and distill them into brain notes that improve
   future tool descriptions.

   One-directional dependency: imports from learnedToolProfiles (types + save).
   Imported by managedAgent.ts (capture + processAtMissionEnd).
*/

import type { ToolTraceRecord } from './learnedToolProfiles.js';
import { buildAddendumFromTraces, saveToolProfile } from './learnedToolProfiles.js';

/** In-memory trace buffer for one mission. */
export class TraceBuffer {
  private traces: ToolTraceRecord[] = [];
  private corrections: Map<string, string> = new Map(); // errorType → correction

  /** Record a tool execution trace. */
  record(trace: ToolTraceRecord): void {
    this.traces.push(trace);

    // Track corrections: if a failed call is followed by a successful
    // call of the same tool, the successful call's args are the "correction"
    if (trace.success && trace.errorType) {
      this.corrections.set(trace.errorType, trace.convention ?? trace.args.slice(0, 100));
    }
  }

  /** Get all traces for a specific tool. */
  getTracesForTool(toolName: string): ToolTraceRecord[] {
    return this.traces.filter(t => t.toolName === toolName);
  }

  /** Get all traces. */
  getAll(): ToolTraceRecord[] {
    return [...this.traces];
  }

  /** Number of traces recorded. */
  get size(): number {
    return this.traces.length;
  }

  /**
   * Process traces at mission end: for each tool with enough traces,
   * extract a learning addendum and persist it to the brain.
   */
  async processAtMissionEnd(): Promise<void> {
    const toolNames = new Set(this.traces.map(t => t.toolName));
    for (const toolName of toolNames) {
      const toolTraces = this.getTracesForTool(toolName);
      if (toolTraces.length < 2) continue;

      const addendum = buildAddendumFromTraces(toolName, toolTraces);
      if (addendum) {
        await saveToolProfile(toolName, addendum, toolTraces.length);
      }
    }
  }

  /** Clear the buffer (called after processing). */
  clear(): void {
    this.traces = [];
    this.corrections.clear();
  }
}

/**
 * Classify an error observation into a short error type string.
 * Used to group similar failures across traces.
 */
export function classifyError(observation: string): string | undefined {
  if (!observation.startsWith('ERROR:')) return undefined;
  const lower = observation.toLowerCase();

  if (lower.includes('old_string not found') || lower.includes('string not found')) return 'match_failed';
  if (lower.includes('not found') || lower.includes('no such file')) return 'not_found';
  if (lower.includes('permission') || lower.includes('denied')) return 'permission';
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('syntax') || lower.includes('parse')) return 'syntax';
  if (lower.includes('old_string not found') || lower.includes('match')) return 'match_failed';
  if (lower.includes('invalid') || lower.includes('invalid pattern')) return 'invalid_input';
  if (lower.includes('exit code') || lower.includes('exit 1')) return 'command_failed';
  return 'other';
}

/**
 * Detect a convention from a successful tool call.
 * For run_command, extracts the command that worked.
 * For run_tests, notes the test framework.
 */
export function detectConvention(
  toolName: string,
  args: Record<string, unknown>,
  observation: string,
): string | undefined {
  if (toolName === 'run_command') {
    const cmd = String(args.command ?? '');
    if (cmd && !observation.startsWith('ERROR:')) {
      // Only record non-trivial commands
      if (cmd.includes('test') || cmd.includes('lint') || cmd.includes('build') || cmd.includes('cargo')) {
        return `command: ${cmd}`;
      }
    }
  }
  if (toolName === 'run_tests') {
    if (!observation.startsWith('ERROR:') && observation.includes('passed')) {
      return 'tests pass with current config';
    }
  }
  return undefined;
}
