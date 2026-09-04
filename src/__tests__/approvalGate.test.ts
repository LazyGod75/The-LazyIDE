/* approvalGate.test.ts — adversarial unit tests for the blocking LazyBot
   approval gate (src/lib/agents/approval/approvalGate.ts). The point of this
   module is fail-closed behaviour: a consequential cloud action must NEVER
   slip through without a human verdict.

   The event bus and the platform file IO are both mocked (no real events, no
   disk); the rules store runs against an in-memory map.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

const memFs = new Map<string, string>();
const readFile = vi.fn(async (path: string) => {
  const content = memFs.get(path);
  if (content === undefined) throw new Error(`not found: ${path}`);
  return content;
});
const writeFile = vi.fn(async (path: string, content: string) => {
  memFs.set(path, content);
});
const createDir = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    fs: { readFile, writeFile, createDir },
  })),
}));

import { emit } from '../lib/bus';
import { CANCELLED_OBSERVATION, DENIED_OBSERVATION } from '../lib/agents/approval/approvalTypes';
import { _resetApprovalRulesForTests, addRule, listRules } from '../lib/agents/approval/approvalRules';
import {
  getPendingApproval,
  interceptAction,
  listPendingApprovals,
  resolveApproval,
} from '../lib/agents/approval/approvalGate';

/** Flush pending microtasks so the gate's async rule-load settles. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  memFs.clear();
  _resetApprovalRulesForTests();
});

// ── Supervised gating ─────────────────────────────────────────────

describe('supervised gating', () => {
  it('a send-class click stays PENDING until a deny verdict settles it as denied', async () => {
    let settled = false;
    const promise = interceptAction({
      missionId: 'm-send',
      tool: 'cloud_browser_click',
      args: { selector: '#tweet-btn' },
      page: { url: 'https://x.com/home', targetText: 'Post' },
      autonomy: 'supervised',
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await flush();
    expect(settled).toBe(false);
    const pending = getPendingApproval('m-send');
    expect(pending).toBeDefined();
    expect(pending?.klass).toBe('send');
    expect(pending?.reason).toBe('class');
    // The request bus event carries the full PendingApproval.
    expect(emit).toHaveBeenCalledWith('solari:approvalRequest', expect.objectContaining({
      missionId: 'm-send',
      tool: 'cloud_browser_click',
      args: { selector: '#tweet-btn' },
      klass: 'send',
      reason: 'class',
      page: expect.objectContaining({ url: 'https://x.com/home', targetText: 'Post' }),
    }));
    expect(resolveApproval('m-send', 'deny')).toBe(true);
    await expect(promise).resolves.toEqual({ kind: 'denied', observation: DENIED_OBSERVATION });
    expect(emit).toHaveBeenCalledWith('solari:approvalResolved', { missionId: 'm-send', verdict: 'deny' });
  });

  it('approve settles as allow', async () => {
    const promise = interceptAction({
      missionId: 'm-approve',
      tool: 'cloud_browser_click',
      args: {},
      page: { targetText: 'Post' },
      autonomy: 'supervised',
    });
    await flush();
    expect(resolveApproval('m-approve', 'approve')).toBe(true);
    await expect(promise).resolves.toEqual({ kind: 'allow' });
  });

  it('edit with new args settles as edited with the edited args', async () => {
    const promise = interceptAction({
      missionId: 'm-edit',
      tool: 'cloud_browser_click',
      args: { selector: '#tweet-btn' },
      page: { targetText: 'Post' },
      autonomy: 'supervised',
    });
    await flush();
    expect(resolveApproval('m-edit', 'edit', { selector: '#edited' })).toBe(true);
    await expect(promise).resolves.toEqual({ kind: 'edited', args: { selector: '#edited' } });
    expect(emit).toHaveBeenCalledWith('solari:approvalResolved', {
      missionId: 'm-edit',
      verdict: 'edit',
      editedArgs: { selector: '#edited' },
    });
  });

  it('edit without editedArgs falls back to approve', async () => {
    const promise = interceptAction({
      missionId: 'm-edit-none',
      tool: 'cloud_browser_click',
      args: {},
      page: { targetText: 'Post' },
      autonomy: 'supervised',
    });
    await flush();
    expect(resolveApproval('m-edit-none', 'edit')).toBe(true);
    await expect(promise).resolves.toEqual({ kind: 'allow' });
  });

  it('alwaysAllow allows AND persists an allow rule for klass+site+tool; the next same intercept allows immediately', async () => {
    const promise = interceptAction({
      missionId: 'm-always',
      tool: 'cloud_browser_click',
      args: {},
      page: { url: 'https://x.com/home', targetText: 'Post' },
      autonomy: 'supervised',
    });
    await flush();
    expect(resolveApproval('m-always', 'alwaysAllow')).toBe(true);
    await expect(promise).resolves.toEqual({ kind: 'allow' });
    expect(emit).toHaveBeenCalledWith('solari:approvalResolved', { missionId: 'm-always', verdict: 'alwaysAllow' });
    // Rule persisted with klass + site + tool.
    const rules = listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ effect: 'allow', klass: 'send', site: 'x.com', tool: 'cloud_browser_click' });
    // Second intercept for the same class/site/tool resolves IMMEDIATELY as allow.
    const second = await interceptAction({
      missionId: 'm-always-2',
      tool: 'cloud_browser_click',
      args: {},
      page: { url: 'https://x.com/home', targetText: 'Post' },
      autonomy: 'supervised',
    });
    expect(second).toEqual({ kind: 'allow' });
    expect(getPendingApproval('m-always-2')).toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(2); // request + resolved, no second request
  });

  it('a pre-existing REQUIRE rule beats a pre-existing allow rule -> blocks with reason rule', async () => {
    await addRule({ effect: 'allow', klass: 'send', site: 'x.com', tool: 'cloud_browser_click' });
    await addRule({ effect: 'require', klass: 'send', site: 'x.com', tool: 'cloud_browser_click' });
    const promise = interceptAction({
      missionId: 'm-rule',
      tool: 'cloud_browser_click',
      args: {},
      page: { url: 'https://x.com/home', targetText: 'Post' },
      autonomy: 'supervised',
    });
    await flush();
    expect(getPendingApproval('m-rule')?.reason).toBe('rule');
    expect(resolveApproval('m-rule', 'approve')).toBe(true);
    await promise;
  });

  it('an unknown class blocks (fail-safe)', async () => {
    const promise = interceptAction({
      missionId: 'm-unknown',
      tool: 'cloud_desktop_type',
      args: {},
      page: {},
      autonomy: 'supervised',
    });
    await flush();
    expect(getPendingApproval('m-unknown')?.klass).toBe('unknown');
    expect(getPendingApproval('m-unknown')?.reason).toBe('class');
    expect(resolveApproval('m-unknown', 'deny')).toBe(true);
    await promise;
  });
});

// ── Autonomy modes ────────────────────────────────────────────────

describe('autonomy modes', () => {
  it('manual blocks every cloud action tool with reason autonomy', async () => {
    const promise = interceptAction({
      missionId: 'm-manual',
      tool: 'cloud_desktop_type',
      args: {},
      page: {},
      autonomy: 'manual',
    });
    await flush();
    expect(getPendingApproval('m-manual')?.klass).toBe('unknown');
    expect(getPendingApproval('m-manual')?.reason).toBe('autonomy');
    expect(resolveApproval('m-manual', 'approve')).toBe(true);
    await promise;
  });

  it('yolo allows a send action immediately', async () => {
    const outcome = await interceptAction({
      missionId: 'm-yolo-send',
      tool: 'cloud_browser_click',
      args: {},
      page: { targetText: 'Post' },
      autonomy: 'yolo',
    });
    expect(outcome).toEqual({ kind: 'allow' });
    expect(getPendingApproval('m-yolo-send')).toBeUndefined();
  });

  it('yolo still blocks credentials', async () => {
    const promise = interceptAction({
      missionId: 'm-yolo-cred',
      tool: 'cloud_browser_type',
      args: {},
      page: { inputType: 'password' },
      autonomy: 'yolo',
    });
    await flush();
    expect(getPendingApproval('m-yolo-cred')?.klass).toBe('credentials');
    expect(getPendingApproval('m-yolo-cred')?.reason).toBe('class');
    expect(resolveApproval('m-yolo-cred', 'deny')).toBe(true);
    await promise;
  });
});

// ── Abort, invariants and read-only pass-through ──────────────────

describe('abort and invariants', () => {
  it('aborting while pending settles cancelled, clears the pending entry and emits a cancelled verdict', async () => {
    const controller = new AbortController();
    const promise = interceptAction({
      missionId: 'm-abort',
      tool: 'cloud_browser_click',
      args: {},
      page: { targetText: 'Post' },
      autonomy: 'supervised',
      signal: controller.signal,
    });
    await flush();
    expect(getPendingApproval('m-abort')).toBeDefined();
    controller.abort();
    await expect(promise).resolves.toEqual({ kind: 'cancelled', observation: CANCELLED_OBSERVATION });
    expect(getPendingApproval('m-abort')).toBeUndefined();
    expect(emit).toHaveBeenCalledWith('solari:approvalResolved', { missionId: 'm-abort', verdict: 'cancelled' });
  });

  it('a second intercept for the same mission while one is pending rejects loudly', async () => {
    const promise = interceptAction({
      missionId: 'm-dual',
      tool: 'cloud_browser_click',
      args: {},
      page: { targetText: 'Post' },
      autonomy: 'supervised',
    });
    await flush();
    await expect(
      interceptAction({
        missionId: 'm-dual',
        tool: 'cloud_browser_click',
        args: {},
        page: { targetText: 'Post' },
        autonomy: 'supervised',
      }),
    ).rejects.toThrow(/pending/i);
    expect(resolveApproval('m-dual', 'approve')).toBe(true);
    await promise;
  });

  it('read-only tools allow immediately with no pending, no pending list entry and no bus event', async () => {
    const outcome = await interceptAction({
      missionId: 'm-read',
      tool: 'cloud_browser_read_page',
      args: {},
      page: {},
      autonomy: 'supervised',
    });
    expect(outcome).toEqual({ kind: 'allow' });
    expect(getPendingApproval('m-read')).toBeUndefined();
    expect(listPendingApprovals()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('resolveApproval returns false when nothing was pending', () => {
    expect(resolveApproval('m-nope', 'approve')).toBe(false);
  });
});


