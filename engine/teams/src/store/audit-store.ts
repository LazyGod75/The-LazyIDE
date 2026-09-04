/**
 * Audit store — append-only log in data/db/audit.csv.
 *
 * Writes use appendRow (open-append, creates header if absent).
 * Reads scan the full file; a readFiltered helper supports future admin UI.
 */

import { AUDIT_CSV } from '../config.js';
import type { AuditEntry } from '../domain/types.js';
import { appendRow, readTable } from './csv.js';
import { AUDIT_SCHEMA } from './schemas.js';

function rowToEntry(row: Record<string, string>): AuditEntry {
  return {
    ts: row.ts!,
    userId: row.userId!,
    action: row.action!,
    resource: row.resource!,
    details: row.details!,
  };
}

/**
 * Append a single audit event. Never throws on I/O error to avoid disrupting
 * the primary operation — callers should handle the returned boolean.
 */
export function logAuditEvent(entry: AuditEntry): boolean {
  try {
    appendRow(AUDIT_CSV, AUDIT_SCHEMA, {
      ts: entry.ts,
      userId: entry.userId,
      action: entry.action,
      resource: entry.resource,
      details: entry.details,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read all audit entries. Returns [] if the file does not exist.
 */
export function readAuditLog(): AuditEntry[] {
  return readTable(AUDIT_CSV, AUDIT_SCHEMA).map(rowToEntry);
}

export interface AuditFilter {
  readonly userId?: string;
  readonly action?: string;
  readonly resource?: string;
  readonly from?: Date;
  readonly to?: Date;
}

/**
 * Read audit entries matching a filter.
 * Designed for the future admin viewer; no index — full scan.
 */
export function readFilteredAuditLog(filter: AuditFilter): AuditEntry[] {
  return readAuditLog().filter((entry) => {
    if (filter.userId !== undefined && entry.userId !== filter.userId) return false;
    if (filter.action !== undefined && entry.action !== filter.action) return false;
    if (filter.resource !== undefined && entry.resource !== filter.resource) return false;
    const ts = new Date(entry.ts);
    if (filter.from !== undefined && ts < filter.from) return false;
    if (filter.to !== undefined && ts > filter.to) return false;
    return true;
  });
}
