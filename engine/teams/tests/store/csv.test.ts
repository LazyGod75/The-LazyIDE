/**
 * Tests for the RFC4180-compliant CSV engine.
 * Covers: roundtrip, quotes, commas, embedded newlines, unicode, empty fields,
 * atomic-write behavior, schema validation failure messages.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendRow,
  escapeField,
  parseCsv,
  readTable,
  serializeRow,
  writeTable,
} from '../../src/store/csv.js';
import type { TableSchema } from '../../src/store/csv.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `lbt-csv-test-${process.pid}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

const SIMPLE_SCHEMA: TableSchema = [
  { name: 'id', type: 'string' },
  { name: 'name', type: 'string' },
  { name: 'note', type: 'optionalString' },
];

// ---------------------------------------------------------------------------
// escapeField
// ---------------------------------------------------------------------------

describe('escapeField', () => {
  it('leaves plain strings unchanged', () => {
    expect(escapeField('hello')).toBe('hello');
    expect(escapeField('abc123')).toBe('abc123');
  });

  it('wraps strings containing commas in quotes', () => {
    expect(escapeField('a,b')).toBe('"a,b"');
  });

  it('wraps strings containing double-quotes and doubles them', () => {
    expect(escapeField('say "hello"')).toBe('"say ""hello"""');
  });

  it('wraps strings containing newlines', () => {
    expect(escapeField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('handles empty string', () => {
    expect(escapeField('')).toBe('');
  });

  it('handles unicode', () => {
    expect(escapeField('日本語')).toBe('日本語');
    expect(escapeField('emoji 🧠')).toBe('emoji 🧠');
  });
});

// ---------------------------------------------------------------------------
// parseCsv roundtrip
// ---------------------------------------------------------------------------

describe('parseCsv', () => {
  it('parses a simple two-row CSV', () => {
    const input = 'id,name\n1,Alice\n2,Bob\n';
    const rows = parseCsv(input);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(['id', 'name']);
    expect(rows[1]).toEqual(['1', 'Alice']);
    expect(rows[2]).toEqual(['2', 'Bob']);
  });

  it('handles quoted fields with embedded commas', () => {
    const input = 'a,b\n"hello, world",plain\n';
    const rows = parseCsv(input);
    expect(rows[1]).toEqual(['hello, world', 'plain']);
  });

  it('handles escaped double-quotes inside quoted fields', () => {
    const input = 'a\n"say ""hi"""\n';
    const rows = parseCsv(input);
    expect(rows[1]).toEqual(['say "hi"']);
  });

  it('handles embedded newlines in quoted fields', () => {
    const raw = 'line1\nline2';
    const csvLine = `"${raw}"`;
    const input = `a\n${csvLine}\n`;
    const rows = parseCsv(input);
    expect(rows[1]![0]).toBe(raw);
  });

  it('handles empty fields', () => {
    const input = 'a,b,c\n1,,3\n';
    const rows = parseCsv(input);
    expect(rows[1]).toEqual(['1', '', '3']);
  });

  it('handles CRLF line endings', () => {
    const input = 'a,b\r\n1,2\r\n';
    const rows = parseCsv(input);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(['1', '2']);
  });

  it('handles unicode field values', () => {
    const input = 'val\nこんにちは\n日本語テスト\n';
    const rows = parseCsv(input);
    expect(rows[1]![0]).toBe('こんにちは');
    expect(rows[2]![0]).toBe('日本語テスト');
  });

  it('roundtrips special chars through serialize + parse', () => {
    const fields = ['id1', 'Name, "With" Commas', 'note\nwith\nnewlines'];
    const line = serializeRow(fields);
    const parsed = parseCsv(`${line}\n`);
    expect(parsed[0]).toEqual(fields);
  });
});

// ---------------------------------------------------------------------------
// readTable / writeTable
// ---------------------------------------------------------------------------

describe('readTable', () => {
  it('returns empty array for non-existent file', () => {
    const result = readTable(join(testDir, 'nope.csv'), SIMPLE_SCHEMA);
    expect(result).toEqual([]);
  });

  it('reads and validates a valid file', () => {
    const file = join(testDir, 'data.csv');
    writeTable(file, SIMPLE_SCHEMA, [
      { id: '1', name: 'Alice', note: '' },
      { id: '2', name: 'Bob', note: 'hello' },
    ]);
    const rows = readTable(file, SIMPLE_SCHEMA);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe('Alice');
    expect(rows[1]!.note).toBe('hello');
  });

  it('throws on header mismatch', () => {
    const file = join(testDir, 'bad.csv');
    writeTable(file, SIMPLE_SCHEMA, [{ id: '1', name: 'A', note: '' }]);
    const wrongSchema: TableSchema = [
      { name: 'wrong', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'note', type: 'optionalString' },
    ];
    expect(() => readTable(file, wrongSchema)).toThrow(/header mismatch/i);
  });

  it('throws with row number on enum validation failure', () => {
    const enumSchema: TableSchema = [{ name: 'role', type: 'enum', enumValues: ['a', 'b'] }];
    const file = join(testDir, 'enum.csv');
    writeFileSync(file, 'role\na\nINVALID\n');
    expect(() => readTable(file, enumSchema)).toThrow(/Row 3/);
  });

  it('throws with row number on isodate validation failure', () => {
    const dateSchema: TableSchema = [{ name: 'ts', type: 'isodate' }];
    const file = join(testDir, 'date.csv');
    writeFileSync(file, 'ts\n2024-01-01T00:00:00Z\nnot-a-date\n');
    expect(() => readTable(file, dateSchema)).toThrow(/Row 3/);
  });

  it('throws with row number on integer validation failure', () => {
    const intSchema: TableSchema = [{ name: 'count', type: 'integer' }];
    const file = join(testDir, 'int.csv');
    writeFileSync(file, 'count\n42\nnot-int\n');
    expect(() => readTable(file, intSchema)).toThrow(/Row 3/);
  });
});

describe('writeTable atomicity', () => {
  it('produces no tmp file after successful write', () => {
    const file = join(testDir, 'atomic.csv');
    writeTable(file, SIMPLE_SCHEMA, [{ id: '1', name: 'Test', note: '' }]);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('overwrites previous content completely', () => {
    const file = join(testDir, 'overwrite.csv');
    writeTable(file, SIMPLE_SCHEMA, [
      { id: '1', name: 'First', note: '' },
      { id: '2', name: 'Second', note: '' },
    ]);
    writeTable(file, SIMPLE_SCHEMA, [{ id: '99', name: 'Only', note: '' }]);
    const rows = readTable(file, SIMPLE_SCHEMA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('99');
  });
});

// ---------------------------------------------------------------------------
// appendRow
// ---------------------------------------------------------------------------

describe('appendRow', () => {
  it('creates file with header on first append', () => {
    const file = join(testDir, 'append.csv');
    appendRow(file, SIMPLE_SCHEMA, { id: '1', name: 'First', note: '' });
    const content = readFileSync(file, 'utf-8');
    expect(content.startsWith('id,name,note\n')).toBe(true);
  });

  it('appends subsequent rows without re-writing header', () => {
    const file = join(testDir, 'append2.csv');
    appendRow(file, SIMPLE_SCHEMA, { id: '1', name: 'A', note: '' });
    appendRow(file, SIMPLE_SCHEMA, { id: '2', name: 'B', note: '' });
    appendRow(file, SIMPLE_SCHEMA, { id: '3', name: 'C', note: '' });
    const rows = readTable(file, SIMPLE_SCHEMA);
    expect(rows).toHaveLength(3);
    expect(rows[2]!.name).toBe('C');
  });

  it('correctly escapes special chars in appended rows', () => {
    const file = join(testDir, 'append-special.csv');
    appendRow(file, SIMPLE_SCHEMA, { id: '1', name: 'Alice, "Expert"', note: 'line1\nline2' });
    const rows = readTable(file, SIMPLE_SCHEMA);
    expect(rows[0]!.name).toBe('Alice, "Expert"');
    expect(rows[0]!.note).toBe('line1\nline2');
  });
});
