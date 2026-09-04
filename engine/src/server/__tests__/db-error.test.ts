/**
 * db-error.test.ts
 *
 * Unit tests for mapDbError in src/server/security.ts:
 *   - SQLITE_BUSY → 503 + Retry-After: 3 + JSON body
 *   - Other errors → returns false (caller keeps control)
 */

import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { mapDbError } from '../../server/security.js';

type MockRes = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead(status: number, h?: Record<string, string>): void;
  end(data?: string): void;
};

function makeMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, h = {}) {
      this.statusCode = status;
      Object.assign(this.headers, h);
    },
    end(data = '') {
      this.body = data;
    },
  };
  return res;
}

function makeSqliteBusyError(): Error {
  const err = new Error('database is locked') as NodeJS.ErrnoException;
  err.code = 'SQLITE_BUSY';
  return err;
}

describe('mapDbError — SQLITE_BUSY', () => {
  it('returns true and writes 503 with Retry-After header', () => {
    const res = makeMockRes();
    const err = makeSqliteBusyError();
    const handled = mapDbError(res as unknown as ServerResponse, err);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.headers['content-type']).toBe('application/json');
  });

  it('body is JSON with error key mentioning retry', () => {
    const res = makeMockRes();
    const err = makeSqliteBusyError();
    mapDbError(res as unknown as ServerResponse, err);

    const parsed = JSON.parse(res.body) as { error: string };
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error).toMatch(/retry/i);
  });
});

describe('mapDbError — other errors', () => {
  it('returns false for a generic Error', () => {
    const res = makeMockRes();
    const handled = mapDbError(res as unknown as ServerResponse, new Error('unexpected'));
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0); // nothing written
  });

  it('returns false for ENOENT', () => {
    const res = makeMockRes();
    const err = new Error('no such file') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const handled = mapDbError(res as unknown as ServerResponse, err);
    expect(handled).toBe(false);
  });

  it('returns false for null/undefined', () => {
    const res = makeMockRes();
    expect(mapDbError(res as unknown as ServerResponse, null)).toBe(false);
    expect(mapDbError(res as unknown as ServerResponse, undefined)).toBe(false);
  });
});
