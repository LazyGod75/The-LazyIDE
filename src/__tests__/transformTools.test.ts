/**
 * transformTools.test.ts — W-CODE coverage for lib/agents/transformTools.ts:
 * author-time validation (name/description/code required, size cap, syntax
 * pre-check), the runtime shape guard, and CRUD persistence. The SECURITY
 * proof (sandbox escape attempts blocked) lives in transformSandbox.test.ts —
 * this file is about the AUTHORING/STORAGE half only, exactly mirroring how
 * declarativeTools.test.ts / projectCommandTools.test.ts split "author a
 * valid/invalid tool" from "execute a tool safely".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkTransformSyntax,
  validateTransformTool,
  isTransformToolLike,
  saveTransformTool,
  listTransformTools,
  deleteTransformTool,
  generateTransformToolId,
  _resetTransformToolsForTests,
  TRANSFORM_CODE_MAX_CHARS,
  type TransformTool,
} from '../lib/agents/transformTools';

beforeEach(() => {
  _resetTransformToolsForTests();
});

function makeTool(overrides: Partial<TransformTool> = {}): TransformTool {
  return {
    id: 'ttool-1',
    name: 'Double items',
    description: 'Doubles every number in input.items',
    code: 'return input.items.map((x) => x * 2);',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── checkTransformSyntax ────────────────────────────────────────────────

describe('checkTransformSyntax', () => {
  it('accepts valid function bodies without ever executing them', () => {
    expect(checkTransformSyntax('return input.items.map((x) => x * 2);')).toBeNull();
    expect(checkTransformSyntax('const y = input + 1; return y;')).toBeNull();
  });

  it('never executes the body — a body that would throw if called returns no syntax error at all', () => {
    // If checkTransformSyntax ever CALLED the function instead of merely
    // constructing it, this body would throw and the check would report an
    // error. It reports null (valid syntax), proving construction-only
    // parsing, never invocation.
    expect(checkTransformSyntax('throw new Error("would only throw if called");')).toBeNull();
  });

  it('reports a syntax error for malformed code', () => {
    const err = checkTransformSyntax('this is not valid js {{{');
    expect(err).not.toBeNull();
  });
});

// ── validateTransformTool ────────────────────────────────────────────────

describe('validateTransformTool', () => {
  it('accepts a well-formed tool', () => {
    const result = validateTransformTool({
      name: 'Double items',
      description: 'Doubles every number',
      code: 'return input.map((x) => x * 2);',
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects a missing name, description, or code', () => {
    expect(validateTransformTool({ name: '', description: 'd', code: 'return input;' }).valid).toBe(false);
    expect(validateTransformTool({ name: 'n', description: '', code: 'return input;' }).valid).toBe(false);
    expect(validateTransformTool({ name: 'n', description: 'd', code: '' }).valid).toBe(false);
  });

  it('rejects code over the character cap', () => {
    const huge = 'x'.repeat(TRANSFORM_CODE_MAX_CHARS + 1);
    const result = validateTransformTool({ name: 'n', description: 'd', code: huge });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/exceeds/);
  });

  it('rejects code with a syntax error', () => {
    const result = validateTransformTool({ name: 'n', description: 'd', code: 'return input.[[[' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/syntax error/);
  });
});

// ── Runtime shape guard ──────────────────────────────────────────────────

describe('isTransformToolLike', () => {
  it('accepts a well-shaped tool', () => {
    expect(isTransformToolLike(makeTool())).toBe(true);
  });

  it('rejects a malformed shape or a non-object', () => {
    expect(isTransformToolLike({ id: '1', name: 'x' })).toBe(false);
    expect(isTransformToolLike(null)).toBe(false);
    expect(isTransformToolLike('not an object')).toBe(false);
    expect(isTransformToolLike(42)).toBe(false);
    expect(isTransformToolLike({ ...makeTool(), code: 42 })).toBe(false);
  });
});

// ── Persistence (CRUD) ────────────────────────────────────────────────

describe('transform tools CRUD (web-mock fallback)', () => {
  it('save -> list -> delete round-trips', async () => {
    const tool = makeTool({ id: generateTransformToolId() });
    await saveTransformTool(tool);

    const listed = await listTransformTools();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: tool.id, name: tool.name, code: tool.code });

    await deleteTransformTool(tool.id);
    expect(await listTransformTools()).toHaveLength(0);
  });

  it('update overwrites the existing entry by id rather than duplicating it', async () => {
    const tool = makeTool({ id: generateTransformToolId() });
    await saveTransformTool(tool);
    await saveTransformTool({ ...tool, name: 'Renamed' });

    const listed = await listTransformTools();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('Renamed');
  });

  it('throws on save when the tool fails its own validation, and never persists it', async () => {
    await expect(saveTransformTool(makeTool({ code: '' }))).rejects.toThrow(/Invalid transformation tool/);
    expect(await listTransformTools()).toHaveLength(0);
  });

  it('delete is a no-op (never throws) for an id that does not exist', async () => {
    await expect(deleteTransformTool('does-not-exist')).resolves.toBeUndefined();
  });

  it('generateTransformToolId mints unique, prefixed ids', () => {
    const a = generateTransformToolId();
    const b = generateTransformToolId();
    expect(a).toMatch(/^ttool-/);
    expect(a).not.toBe(b);
  });
});
