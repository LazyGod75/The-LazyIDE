import { describe, expect, it } from 'vitest';
import { isJsonOnlyNoise, shouldCapture } from '../src/capture/validator.js';
import { validateNote } from '../src/schema/validator.js';

const validHtml = `
  <article id="2026-05-20-note-abc1"
           data-cerveau-version="0.1.0"
           data-cerveau-created="2026-05-20T10:00:00Z"
           data-cerveau-source="session:abc#1">
    <p data-cerveau-fact>fact</p>
  </article>`;

describe('validator', () => {
  it('accepts valid note', () => {
    const r = validateNote(validHtml);
    expect(r.ok).toBe(true);
    expect(r.factsCount).toBe(1);
    expect(r.attrsCount).toBeGreaterThan(3);
  });

  it('rejects missing root', () => {
    const r = validateNote('<p>no root</p>');
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'NO_ROOT')).toBe(true);
  });

  it('rejects missing required attr', () => {
    const r = validateNote(`<article id="note-abc" data-cerveau-version="0.1.0"></article>`);
    expect(r.ok).toBe(false);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_REQUIRED_ATTR');
  });

  it('rejects invalid date', () => {
    const r = validateNote(
      `<article id="note-abc" data-cerveau-version="0.1.0" data-cerveau-created="yesterday" data-cerveau-source="s"></article>`,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'INVALID_DATE')).toBe(true);
  });

  it('rejects out-of-range importance', () => {
    const r = validateNote(
      `<article id="note-abc" data-cerveau-version="0.1.0" data-cerveau-created="2026-05-20"
                data-cerveau-source="s" data-cerveau-importance="1.5"></article>`,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'OUT_OF_RANGE_FLOAT')).toBe(true);
  });

  it('warns on unknown type but accepts (forward-compat)', () => {
    const r = validateNote(
      `<article id="note-abc" data-cerveau-version="0.1.0" data-cerveau-created="2026-05-20"
                data-cerveau-source="s" data-cerveau-type="weird"></article>`,
    );
    expect(r.ok).toBe(true);
    expect(r.issues.some((i) => i.code === 'INVALID_TYPE' && i.level === 'warn')).toBe(true);
  });

  it('detects secrets and refuses', () => {
    const r = validateNote(
      `<article id="note-abc" data-cerveau-version="0.1.0" data-cerveau-created="2026-05-20"
                data-cerveau-source="s"><p>my key sk-abcdefghijklmnopqrstuvwxyz0123 leaked</p></article>`,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'SECRET_DETECTED')).toBe(true);
  });

  it('rejects note with id shorter than 5 chars', () => {
    const r = validateNote(
      `<article id="abc" data-cerveau-version="0.1.0" data-cerveau-created="2026-05-20"
                data-cerveau-source="s"></article>`,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'INVALID_ID_TOO_SHORT')).toBe(true);
  });

  it('rejects note with id starting with $', () => {
    const r = validateNote(
      `<article id="$id14" data-cerveau-version="0.1.0" data-cerveau-created="2026-05-20"
                data-cerveau-source="s"></article>`,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'INVALID_ID_TEMPLATE_VAR')).toBe(true);
  });

  it('rejects note with bare lowercase alpha id (sub-topic name leak)', () => {
    const r = validateNote(
      `<article id="mobile" data-cerveau-version="0.1.0" data-cerveau-created="2026-05-20"
                data-cerveau-source="s"></article>`,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'INVALID_ID_BARE_ALPHA')).toBe(true);
  });

  it('rejects "nutrition" as a bare alpha id', () => {
    const r = validateNote(
      `<article id="nutrition" data-cerveau-version="0.1.0" data-cerveau-created="2026-05-20"
                data-cerveau-source="s"></article>`,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'INVALID_ID_BARE_ALPHA')).toBe(true);
  });
});

describe('isJsonOnlyNoise — Action C: inline JSON in prose', () => {
  // These must NOT be rejected — they are prose with embedded code snippets.
  it('allows prose containing inline { ok: false, error } object', () => {
    const text =
      'Convention: API handlers wrap business calls in try/catch and return { ok: false, error: { code, message } } on failure. See src/api/login.ts as the reference implementation.';
    expect(isJsonOnlyNoise(text)).toBe(false);
  });

  it('allows prose with embedded array literal', () => {
    const text =
      'We store allowed roles as [1, 2, 3] integers in the permissions table, not strings.';
    expect(isJsonOnlyNoise(text)).toBe(false);
  });

  it('allows a short { key: value } snippet with surrounding prose', () => {
    const text =
      'Return shape is always { status: "ok", data: ... } for success responses per the API convention.';
    expect(isJsonOnlyNoise(text)).toBe(false);
  });

  // These MUST be rejected — they are pure JSON dumps with no prose.
  it('rejects a raw Claude Code hook payload (session_id + tool_name markers)', () => {
    const text = '{"session_id":"abc","tool_name":"Bash","tool_response":{"output":"done"}}';
    expect(isJsonOnlyNoise(text)).toBe(true);
  });

  it('rejects a JSON object whose only string values are short machine tokens', () => {
    const text = '{"ok":true,"code":200,"id":"abc123"}';
    expect(isJsonOnlyNoise(text)).toBe(true);
  });
});

describe('shouldCapture — Action B: cf-error-handling fixture roundtrip', () => {
  it('accepts the cf-error-handling fixture text', () => {
    const text =
      'Convention: API handlers wrap business calls in try/catch and return { ok: false, error: { code, message } } on failure. See src/api/login.ts as the reference implementation.';
    const result = shouldCapture(text);
    // May be duplicate if run multiple times; just ensure it is not json_only_noise or too_short.
    expect(result.ok === true || (result.ok === false && result.reason === 'duplicate')).toBe(true);
    if (!result.ok) {
      expect(result.reason).not.toBe('json_only_noise');
      expect(result.reason).not.toBe('too_short');
    }
  });
});

describe('shouldCapture — low_value_tool: filter out pure file operations', () => {
  it('rejects pure Read capture: "Tool Read. read file.ts" with no context', () => {
    const text =
      'Tool Read. read C:\\Users\\username\\Documents\\project\\src\\capture\\validator.ts';
    const result = shouldCapture(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('low_value_tool');
    }
  });

  it('accepts Read capture with meaningful prose about the file', () => {
    const text =
      'Tool Read. read C:\\src\\fts.ts. This file implements the full-text search indexing system using SQLite FTS5. It supports incremental indexing and parallel batch operations.';
    const result = shouldCapture(text);
    expect(result.ok === true || (result.ok === false && result.reason === 'duplicate')).toBe(true);
    if (!result.ok) {
      expect(result.reason).not.toBe('low_value_tool');
    }
  });

  it('rejects pure Edit capture: "Tool Edit. modified file.ts" with no context', () => {
    const text =
      'Tool Edit. modified C:\\Users\\username\\Documents\\project\\src\\capture\\validator.ts';
    const result = shouldCapture(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('low_value_tool');
    }
  });

  it('accepts Edit capture with meaningful context about the change', () => {
    const text =
      'Tool Edit. modified C:\\src\\validator.ts. Added low_value_tool rejection type to filter out pure file operation captures. This prevents read-only tools from creating useless notes.';
    const result = shouldCapture(text);
    expect(result.ok === true || (result.ok === false && result.reason === 'duplicate')).toBe(true);
    if (!result.ok) {
      expect(result.reason).not.toBe('low_value_tool');
    }
  });

  it('rejects pure Grep capture: "Tool Grep. grep pattern file" with no results', () => {
    const text = 'Tool Grep. grep -r "pattern" C:\\src. No matches found in the search results.';
    const result = shouldCapture(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('low_value_tool');
    }
  });

  it('accepts Grep capture with semantic findings', () => {
    const text =
      'Tool Grep. grep -r "ValidationRejection" C:\\src. Found that the type has been updated to include low_value_tool rejection reason. This enables filtering out pure file operation captures with no insight.';
    const result = shouldCapture(text);
    expect(result.ok === true || (result.ok === false && result.reason === 'duplicate')).toBe(true);
    if (!result.ok) {
      expect(result.reason).not.toBe('low_value_tool');
    }
  });

  it('rejects log dump: mostly JSON lines with minimal prose', () => {
    const text =
      'Tool Bash. executed npm script\n{"level":30,"time":1779647116811,"app":"lazybrain","total":39}\n{"level":20,"time":1779647116812,"app":"lazybrain","event":"process_start"}\n{"level":20,"time":1779647116813,"app":"lazybrain","event":"load_conversations"}\n{"level":20,"time":1779647116814,"app":"lazybrain","event":"scan_notes"}';
    const result = shouldCapture(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('low_value_tool');
    }
  });

  it('rejects pure command execution: "Tool Bash. git status" with no output context', () => {
    const text = 'Tool Bash. git status. Files modified: 2, Files staged: 0.';
    const result = shouldCapture(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('low_value_tool');
    }
  });

  it('accepts Bash with meaningful analysis of command results', () => {
    const text =
      'Tool Bash. git log --oneline | head -5. Recent commits show migration pattern: first created users table, then added email uniqueness constraint, then added RLS policies. The order matters because of foreign key dependencies.';
    const result = shouldCapture(text);
    expect(result.ok === true || (result.ok === false && result.reason === 'duplicate')).toBe(true);
    if (!result.ok) {
      expect(result.reason).not.toBe('low_value_tool');
    }
  });
});
