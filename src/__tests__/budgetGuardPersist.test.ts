/* budgetGuardPersist.test.ts — per-bot spend survives app restarts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setBudgetRoot,
  resetBudgetForTests,
  hydrateBudgetStore,
  flushBudgetStore,
  recordBotCost,
  getBotSpend,
} from '../lib/bots/budgetGuard';

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
  getPlatform: vi.fn(() => ({ fs: { readFile, writeFile, createDir } })),
}));

beforeEach(() => {
  memFs.clear();
  readFile.mockClear();
  writeFile.mockClear();
  createDir.mockClear();
  resetBudgetForTests();
  setBudgetRoot('/repo');
});

describe('budget persistence', () => {
  it('persists cumulative spend to disk', async () => {
    const total = recordBotCost('bot_1', 5.0);
    expect(total).toBeCloseTo(5.0, 4);

    await flushBudgetStore();
    const path = '/repo/.lazy/bot-budget.json';
    expect(writeFile).toHaveBeenCalledWith(path, expect.any(String));
    const file = JSON.parse(memFs.get(path)!);
    expect(file.version).toBe('1.0.0');
    expect(file.spend.bot_1.totalUsd).toBeCloseTo(5.0, 4);
    expect(typeof file.spend.bot_1.updatedAt).toBe('string');
  });

  it('rehydrates spend after a simulated restart and continues accumulating', async () => {
    recordBotCost('bot_1', 5.0);
    await flushBudgetStore();

    // Simulate a process restart: reset in-memory state, then rehydrate from disk.
    resetBudgetForTests();
    await hydrateBudgetStore();
    expect(getBotSpend('bot_1')).toBeCloseTo(5.0, 4);

    recordBotCost('bot_1', 2.0);
    await flushBudgetStore();
    const file = JSON.parse(memFs.get('/repo/.lazy/bot-budget.json')!);
    expect(file.spend.bot_1.totalUsd).toBeCloseTo(7.0, 4);
    expect(getBotSpend('bot_1')).toBeCloseTo(7.0, 4);
  });

  it('keeps different bots in separate spend buckets', async () => {
    recordBotCost('bot_1', 3.0);
    recordBotCost('bot_2', 7.0);
    await flushBudgetStore();

    const file = JSON.parse(memFs.get('/repo/.lazy/bot-budget.json')!);
    expect(file.spend.bot_1.totalUsd).toBeCloseTo(3.0, 4);
    expect(file.spend.bot_2.totalUsd).toBeCloseTo(7.0, 4);
  });
});
