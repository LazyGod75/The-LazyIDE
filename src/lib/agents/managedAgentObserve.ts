/* managedAgentObserve.ts — post-tool trace + stall nudge extracted from
   planAndActManaged. Does not import managedAgent.ts (cycle). */

import { detectStall, type ToolCallRecord } from './loopGuard.js';
import { classifyError, detectConvention, type TraceBuffer } from './toolTraces.js';

export function recordManagedTraceAndStall(opts: {
  wasDeduped: boolean;
  action: string;
  args: Record<string, unknown>;
  observation: string;
  traceBuffer: TraceBuffer;
  compress: (text: string) => string;
  toolCallHistory: ToolCallRecord[];
}): string {
  if (!opts.wasDeduped && opts.action !== 'attach_proof') {
    const isSuccess = !opts.observation.startsWith('ERROR:');
    opts.traceBuffer.record({
      toolName: opts.action,
      args: JSON.stringify(opts.args).slice(0, 200),
      success: isSuccess,
      errorType: isSuccess ? undefined : classifyError(opts.observation),
      convention: isSuccess ? detectConvention(opts.action, opts.args, opts.observation) : undefined,
      timestamp: Date.now(),
    });
  }
  const compressed = opts.compress(opts.observation);
  opts.toolCallHistory.push({ name: opts.action, args: opts.args });
  const stall = detectStall(opts.toolCallHistory, {
    repeatThreshold: Number.MAX_SAFE_INTEGER,
    noEditWindow: 12,
  });
  return stall.stalled ? `${compressed}\n\n${stall.message}` : compressed;
}
