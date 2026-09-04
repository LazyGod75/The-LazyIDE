/* approvalRules.test.ts — unit tests for the persisted LazyBot approval
   rules store (src/lib/agents/approval/approvalRules.ts).

   The platform file IO is mocked with an in-memory map (same approach as the
   loopEngine tests) so no disk is ever touched.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DEFAULT_CLASS_EFFECT,
  _resetApprovalRulesForTests,
  addRule,
  listRules,
  loadRules,
  removeRule,
  resolveEffect,
  saveRules,
} from '../lib/agents/approval/approvalRules';
import type { ActionClass } from '../lib/agents/approval/approvalTypes';

// ── Mock platform (in-memory map) ─────────────────────────────────

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

beforeEach(() => {
  memFs.clear();
  _resetApprovalRulesForTests();
});

// ── Tests ─────────────────────────────────────────────────────────

describe('DEFAULT_CLASS_EFFECT', () => {
  it('covers every ActionClass with the specified default effect', () => {
    const expectations: Record<ActionClass, 'require' | 'allow'> = {
      browse: 'allow',
      read: 'allow',
      screenshot: 'allow',
      compose: 'allow',
      send: 'require',
      publish: 'require',
      pay: 'require',
      delete: 'require',
      credentials: 'require',
      exec: 'require',
      file_write: 'require',
      unknown: 'require',
    };
    expect(Object.keys(DEFAULT_CLASS_EFFECT).sort()).toEqual(Object.keys(expectations).sort());
    for (const klass of Object.keys(expectations) as ActionClass[]) {
      expect(DEFAULT_CLASS_EFFECT[klass]).toBe(expectations[klass]);
    }
  });
});

describe('addRule', () => {
  it('rejects a rule with no match dimensions', async () => {
    await expect(addRule({ effect: 'require' })).rejects.toThrow(/dimension/i);
  });

  it('generates an id and adds the rule to the in-memory list', async () => {
    const rule = await addRule({
      effect: 'allow',
      klass: 'send',
      site: 'x.com',
      tool: 'cloud_browser_click',
      label: 'Always allow sending on x.com',
    });
    expect(rule.id).toBeTruthy();
    expect(rule.effect).toBe('allow');
    expect(rule.createdAt).toBeGreaterThan(0);
    expect(listRules()).toEqual([
      expect.objectContaining({ id: rule.id, klass: 'send', site: 'x.com', tool: 'cloud_browser_click' }),
    ]);
  });

  it('persists the rule so a fresh load restores it', async () => {
    const rule = await addRule({ effect: 'allow', klass: 'send', site: 'x.com' });
    expect(writeFile).toHaveBeenCalled();
    const savedPath = writeFile.mock.calls[0][0] as string;
    expect(memFs.get(savedPath)).toContain(rule.id);
    // Simulate a fresh module: in-memory state is wiped, disk (the mock map)
    // still holds the write-through from addRule.
    _resetApprovalRulesForTests();
    await loadRules();
    expect(listRules()).toEqual([
      expect.objectContaining({ id: rule.id, effect: 'allow', klass: 'send', site: 'x.com' }),
    ]);
  });
});

describe('resolveEffect', () => {
  const allowSendClickOnX = {
    effect: 'allow' as const,
    klass: 'send' as ActionClass,
    site: 'x.com',
    tool: 'cloud_browser_click',
    id: 'r-allow',
    createdAt: 1,
  };

  it('falls back to the class default when no rule matches', () => {
    expect(resolveEffect('send', undefined, 'cloud_browser_click', [])).toBe('require');
    expect(resolveEffect('compose', undefined, 'cloud_browser_click', [])).toBe('allow');
    expect(resolveEffect('unknown', undefined, 'cloud_browser_click', [])).toBe('require');
  });

  it('a matching require rule wins over a matching allow rule regardless of insertion order', () => {
    const requireRule = { ...allowSendClickOnX, effect: 'require' as const, id: 'r-require' };
    expect(resolveEffect('send', 'x.com', 'cloud_browser_click', [allowSendClickOnX, requireRule])).toBe('require');
    expect(resolveEffect('send', 'x.com', 'cloud_browser_click', [requireRule, allowSendClickOnX])).toBe('require');
  });

  it('matches site by exact host or suffix, never a lookalike host', () => {
    expect(resolveEffect('send', 'x.com', 'cloud_browser_click', [allowSendClickOnX])).toBe('allow');
    expect(resolveEffect('send', 'www.x.com', 'cloud_browser_click', [allowSendClickOnX])).toBe('allow');
    expect(resolveEffect('send', 'notx.com', 'cloud_browser_click', [allowSendClickOnX])).toBe('require');
  });

  it('requires every provided dimension to match', () => {
    expect(resolveEffect('send', 'x.com', 'cloud_browser_click', [allowSendClickOnX])).toBe('allow');
    expect(resolveEffect('send', 'x.com', 'cloud_browser_type', [allowSendClickOnX])).toBe('require');
    expect(resolveEffect('pay', 'x.com', 'cloud_browser_click', [allowSendClickOnX])).toBe('require');
  });

  it('a rule with no dimensions never matches', () => {
    const noDims = { effect: 'allow' as const, id: 'r-nodims', createdAt: 1 };
    expect(resolveEffect('send', 'x.com', 'cloud_browser_click', [noDims])).toBe('require');
  });
});

describe('removeRule', () => {
  it('removes an existing rule by id and persists', async () => {
    const rule = await addRule({ effect: 'allow', klass: 'send' });
    expect(await removeRule(rule.id)).toBe(true);
    expect(listRules()).toEqual([]);
    expect(writeFile).toHaveBeenCalled();
  });

  it('returns false for an unknown id', async () => {
    expect(await removeRule('does-not-exist')).toBe(false);
  });
});

describe('loadRules', () => {
  it('starts empty when the store file is missing', async () => {
    await loadRules();
    expect(listRules()).toEqual([]);
  });

  it('tolerates a corrupt store file', async () => {
    await addRule({ effect: 'allow', klass: 'send' });
    const savedPath = writeFile.mock.calls[0][0] as string;
    memFs.set(savedPath, '{ this is not json');
    _resetApprovalRulesForTests();
    await expect(loadRules()).resolves.toBeUndefined();
    expect(listRules()).toEqual([]);
  });
});

describe('saveRules', () => {
  it('write-through persists the full rule list with no partial state', async () => {
    await loadRules();
    const rules = [
      { id: 'r1', effect: 'require' as const, klass: 'pay' as ActionClass, createdAt: 1 },
      { id: 'r2', effect: 'allow' as const, tool: 'cloud_browser_click', createdAt: 2 },
    ];
    await saveRules(rules);
    expect(listRules()).toHaveLength(2);
    const savedPath = writeFile.mock.calls[0][0] as string;
    expect(JSON.parse(memFs.get(savedPath) ?? '[]')).toHaveLength(2);
  });
});

