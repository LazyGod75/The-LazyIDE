/**
 * RFC4180-compliant CSV engine.
 *
 * Design decisions:
 * - Zero dependencies — pure Node built-ins only.
 * - Re-read per call (no in-memory cache): safe at LazyBrain-Teams scale;
 *   keeps state simple and avoids stale-read bugs between agents.
 * - Atomic writes via tmp-file + rename (avoids partial-write corruption).
 * - Append mode for audit log (open-append, create-with-header if absent).
 * - Schema validation is eager: fail-fast with row number on first error.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Field schema
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'isodate' | 'integer' | 'enum' | 'optionalString';

export interface FieldSchema {
  readonly name: string;
  readonly type: FieldType;
  readonly enumValues?: readonly string[];
}

export type TableSchema = readonly FieldSchema[];

// ---------------------------------------------------------------------------
// RFC4180 serialisation
// ---------------------------------------------------------------------------

/**
 * Escape a single field value per RFC4180.
 * Fields containing commas, double-quotes, or newlines must be quoted.
 */
export function escapeField(value: string): string {
  const needsQuoting =
    value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r');
  if (!needsQuoting) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Serialize one row to a CSV line (no trailing newline).
 */
export function serializeRow(fields: readonly string[]): string {
  return fields.map(escapeField).join(',');
}

// ---------------------------------------------------------------------------
// RFC4180 parsing
// ---------------------------------------------------------------------------

/**
 * Parse a complete CSV string into an array of rows (each row is an array of
 * string fields). Handles quoted fields, embedded commas, embedded newlines,
 * and escaped double-quotes ("").
 *
 * Returned rows include the header row at index 0.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let pos = 0;
  const len = content.length;

  while (pos <= len) {
    // End of input — flush last (possibly empty) row
    if (pos === len) {
      break;
    }

    const row: string[] = [];
    rows.push(row);

    // Parse fields in this row
    while (pos <= len) {
      if (content[pos] === '"') {
        // Quoted field
        pos++; // skip opening quote
        let field = '';
        while (pos < len) {
          if (content[pos] === '"') {
            if (pos + 1 < len && content[pos + 1] === '"') {
              field += '"';
              pos += 2;
            } else {
              pos++; // skip closing quote
              break;
            }
          } else {
            field += content[pos];
            pos++;
          }
        }
        row.push(field);
      } else {
        // Unquoted field — read until comma or newline
        let field = '';
        while (
          pos < len &&
          content[pos] !== ',' &&
          content[pos] !== '\n' &&
          content[pos] !== '\r'
        ) {
          field += content[pos];
          pos++;
        }
        row.push(field);
      }

      // After each field: check what follows
      if (pos >= len || content[pos] === '\n') {
        pos++; // skip LF
        break; // end of row
      }
      if (content[pos] === '\r') {
        pos++; // skip CR
        if (pos < len && content[pos] === '\n') {
          pos++; // skip LF in CRLF
        }
        break; // end of row
      }
      if (content[pos] === ',') {
        pos++; // skip comma, continue to next field
        // If this comma is the last char before EOL/EOF, push empty field
        if (pos >= len || content[pos] === '\r' || content[pos] === '\n') {
          row.push('');
        }
      }
    }

    // Skip trailing CRLF that might remain
    if (pos < len && content[pos] === '\r') pos++;
    if (pos < len && content[pos] === '\n') pos++;
  }

  // Remove trailing empty row that results from a trailing newline
  if (rows.length > 0 && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === '') {
    rows.pop();
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function validateField(value: string, schema: FieldSchema, rowNum: number): string {
  switch (schema.type) {
    case 'string':
      return value; // any non-empty? for now allow empty
    case 'optionalString':
      return value;
    case 'isodate':
      if (value === '') return value; // optional ISO date (e.g. revokedAt)
      if (!ISO8601_RE.test(value)) {
        throw new Error(
          `Row ${rowNum}: field "${schema.name}" is not a valid ISO-8601 date: "${value}"`,
        );
      }
      return value;
    case 'integer': {
      const n = Number(value);
      if (!Number.isInteger(n)) {
        throw new Error(`Row ${rowNum}: field "${schema.name}" is not an integer: "${value}"`);
      }
      return value;
    }
    case 'enum': {
      if (!schema.enumValues?.includes(value)) {
        throw new Error(
          `Row ${rowNum}: field "${schema.name}" has invalid enum value "${value}". ` +
            `Expected one of: ${schema.enumValues?.join(', ')}`,
        );
      }
      return value;
    }
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// readTable / writeTable / appendRow
// ---------------------------------------------------------------------------

/**
 * Read a CSV file and return typed string-map rows.
 * Fails fast with row+field info if schema validation fails.
 * Returns [] if the file does not exist.
 */
export function readTable(filePath: string, schema: TableSchema): Record<string, string>[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, 'utf-8');
  const rows = parseCsv(content);

  if (rows.length === 0) {
    return [];
  }

  const header = rows[0]!;

  // Verify header matches schema
  for (let i = 0; i < schema.length; i++) {
    const expected = schema[i]!.name;
    const actual = header[i];
    if (actual !== expected) {
      throw new Error(
        `CSV header mismatch in "${filePath}": column ${i} expected "${expected}", got "${actual}"`,
      );
    }
  }

  const result: Record<string, string>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const record: Record<string, string> = {};

    for (let c = 0; c < schema.length; c++) {
      const fieldSchema = schema[c]!;
      const rawValue = row[c] ?? '';
      record[fieldSchema.name] = validateField(rawValue, fieldSchema, r + 1);
    }

    result.push(record);
  }

  return result;
}

/**
 * Write rows to a CSV file atomically (tmp + rename).
 * Creates parent directories if needed.
 */
export function writeTable(
  filePath: string,
  schema: TableSchema,
  rows: readonly Record<string, string>[],
): void {
  mkdirSync(dirname(filePath), { recursive: true });

  const headerLine = serializeRow(schema.map((f) => f.name));
  const lines = [headerLine];

  for (const row of rows) {
    const fields = schema.map((f) => row[f.name] ?? '');
    lines.push(serializeRow(fields));
  }

  const content = `${lines.join('\n')}\n`;
  const tmpPath = `${filePath}.tmp`;

  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

/**
 * Append a single row to a CSV file.
 * Creates the file with the header row if it does not exist.
 * Uses open-append mode — safe for audit log use.
 */
export function appendRow(
  filePath: string,
  schema: TableSchema,
  row: Record<string, string>,
): void {
  mkdirSync(dirname(filePath), { recursive: true });

  const fields = schema.map((f) => row[f.name] ?? '');
  const line = `${serializeRow(fields)}\n`;

  if (!existsSync(filePath)) {
    const header = `${serializeRow(schema.map((f) => f.name))}\n`;
    writeFileSync(filePath, header + line, 'utf-8');
  } else {
    appendFileSync(filePath, line, 'utf-8');
  }
}
