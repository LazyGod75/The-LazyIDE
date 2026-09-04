/* gateAuditLog.ts — Append-only local audit log of every gate decision.
 *
 * Phase 2 of the orchestration overhaul: every action that passes through
 * evaluateActionGate is logged here for traceability. The log is a simple
 * append-only JSONL file at `<project>/.lazy/gate-audit.jsonl` — one entry
 * per gate decision, never modified or deleted.
 *
 * This is a local-first, no-network-send log (per the plan's global
 * constraints). It's the substrate for future audit UI / compliance review.
 */

export interface GateAuditEntry {
  timestamp: string;
  actionType: string;
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
  turnId?: string;
  autonomyMode?: string;
}

/** In-memory audit log — the primary store in all environments.
 *  Persisted to .lazy/gate-audit.jsonl via the platform FS when available
 *  (see persistGateAuditLog), but always readable in-memory for tests. */
const inMemoryLog: GateAuditEntry[] = [];

/** Append a single audit entry to the in-memory log.
 *  Also attempts to persist to .lazy/gate-audit.jsonl via platform FS,
 *  but never throws — logging failures are silently swallowed. */
export async function appendGateAuditEntry(entry: GateAuditEntry): Promise<void> {
  inMemoryLog.push(entry);
  try {
    const { getPlatform } = await import('../platform/index.js');
    const platform = getPlatform();
    if (platform.fs?.writeFile && platform.fs?.readFile) {
      const path = '.lazy/gate-audit.jsonl';
      let existing = '';
      try {
        existing = await platform.fs.readFile(path);
      } catch {
        // File doesn't exist yet — first entry
      }
      const newContent = existing + JSON.stringify(entry) + '\n';
      await platform.fs.writeFile(path, newContent);
    }
  } catch {
    // Best-effort — never block execution
  }
}

/** Read all in-memory audit entries (for tests and audit UI). */
export function readGateAuditLog(): GateAuditEntry[] {
  return [...inMemoryLog];
}

/** Reset the in-memory log — tests only. */
export function resetGateAuditLog(): void {
  inMemoryLog.length = 0;
}
