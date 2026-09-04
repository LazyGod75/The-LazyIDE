/**
 * F(1) — stats.ts: structural_recall_rate_pct must be renamed to l1_routing_rate_pct.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStats } from '../src/commands/stats.js';
import { closeDb } from '../src/indexer/fts.js';
import { resetConfigForTests } from '../src/util/config.js';

describe('F(1) — stats field rename', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    const brainDir = mkdtempSync(join(tmpdir(), 'lb-stats-'));
    mkdirSync(join(brainDir, 'notes'), { recursive: true });
    mkdirSync(join(brainDir, '_cache'), { recursive: true });
    process.env.LAZYBRAIN_BRAIN_PATH = brainDir;
    process.env.LAZYBRAIN_CACHE_PATH = join(brainDir, '_cache');
    resetConfigForTests();
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('JSON output contains l1_routing_rate_pct (not structural_recall_rate_pct)', () => {
    const out = runStats({});
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed).toHaveProperty('l1_routing_rate_pct');
    expect(parsed).not.toHaveProperty('structural_recall_rate_pct');
  });

  it('pretty output contains the routing rate metric', () => {
    const out = runStats({ pretty: true });
    // Should mention the L1 routing rate (not the old "structural recall" label)
    expect(out).toContain('L1 routing');
  });
});
