/**
 * orgApi.test.ts
 *
 * Unit tests for the Teams management orgApi wrappers added in the
 * department + member-role/dept management work. The Supabase client is
 * mocked at the module boundary so we assert the exact Edge Function name
 * and request body, plus the ApiEnvelope mapping for success / failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Supabase client mock ──────────────────────────────────────────

const invokeMock = vi.fn();

vi.mock('../lib/supabase/client', () => ({
  supabase: {
    functions: {
      invoke: (...args: unknown[]) => invokeMock(...args),
    },
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────

import {
  createDepartment,
  setMemberRole,
  setMemberDept,
  listOrg,
} from '../lib/teams/orgApi';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── createDepartment ──────────────────────────────────────────────

describe('createDepartment', () => {
  it('invokes org-create-dept with { orgId, slug, name } and returns the deptId', async () => {
    invokeMock.mockResolvedValue({ data: { success: true, data: { deptId: 'dept-1' } }, error: null });

    const result = await createDepartment('org-1', 'engineering', 'Engineering');

    expect(invokeMock).toHaveBeenCalledWith('org-create-dept', {
      body: { orgId: 'org-1', slug: 'engineering', name: 'Engineering' },
    });
    expect(result).toEqual({ success: true, data: { deptId: 'dept-1' } });
  });

  it('maps a server-side error envelope to a failure result', async () => {
    invokeMock.mockResolvedValue({ data: { success: false, error: 'Slug already exists' }, error: null });

    const result = await createDepartment('org-1', 'engineering', 'Engineering');

    expect(result).toEqual({ success: false, error: 'Slug already exists' });
  });

  it('maps a transport error to a failure result', async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: 'Network down' } });

    const result = await createDepartment('org-1', 'engineering', 'Engineering');

    expect(result).toEqual({ success: false, error: 'Network down' });
  });
});

// ── setMemberRole ─────────────────────────────────────────────────

describe('setMemberRole', () => {
  it('invokes org-set-role with { orgId, userId, role }', async () => {
    invokeMock.mockResolvedValue({ data: { success: true, data: null }, error: null });

    const result = await setMemberRole('org-2', 'user-9', 'viewer');

    expect(invokeMock).toHaveBeenCalledWith('org-set-role', {
      body: { orgId: 'org-2', userId: 'user-9', role: 'viewer' },
    });
    expect(result).toEqual({ success: true, data: null });
  });

  it('surfaces the owner-immutable rejection from the backend', async () => {
    invokeMock.mockResolvedValue({ data: { success: false, error: 'The owner role is immutable.' }, error: null });

    const result = await setMemberRole('org-2', 'owner-id', 'member');

    expect(result).toEqual({ success: false, error: 'The owner role is immutable.' });
  });
});

// ── setMemberDept ─────────────────────────────────────────────────

describe('setMemberDept', () => {
  it('invokes org-set-dept with a department id', async () => {
    invokeMock.mockResolvedValue({ data: { success: true, data: null }, error: null });

    const result = await setMemberDept('org-3', 'user-7', 'dept-5');

    expect(invokeMock).toHaveBeenCalledWith('org-set-dept', {
      body: { orgId: 'org-3', userId: 'user-7', deptId: 'dept-5' },
    });
    expect(result).toEqual({ success: true, data: null });
  });

  it('passes deptId: null to unassign a member', async () => {
    invokeMock.mockResolvedValue({ data: { success: true, data: null }, error: null });

    await setMemberDept('org-3', 'user-7', null);

    expect(invokeMock).toHaveBeenCalledWith('org-set-dept', {
      body: { orgId: 'org-3', userId: 'user-7', deptId: null },
    });
  });
});

// ── listOrg — departments passthrough ─────────────────────────────

describe('listOrg departments', () => {
  it('passes departments through from the org-list response', async () => {
    invokeMock.mockResolvedValue({
      data: {
        success: true,
        data: {
          org: { id: 'org-4', name: 'Acme', seats: 5 },
          members: [],
          invitations: [],
          allocations: [],
          departments: [{ id: 'd1', slug: 'eng', name: 'Engineering' }],
        },
      },
      error: null,
    });

    const result = await listOrg('org-4');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.departments).toEqual([{ id: 'd1', slug: 'eng', name: 'Engineering' }]);
    }
  });

  it('defaults departments to [] when the response omits them', async () => {
    invokeMock.mockResolvedValue({
      data: {
        success: true,
        data: {
          org: { id: 'org-5', name: 'Acme', seats: 5 },
          members: [],
          invitations: [],
          allocations: [],
        },
      },
      error: null,
    });

    const result = await listOrg('org-5');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.departments).toEqual([]);
    }
  });
});
