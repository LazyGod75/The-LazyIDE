import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { runInitVibe } from '../src/commands/init-vibe.js';

function makeHomes(): { vibeHome: string; agentsHome: string; lazyBrainHome: string } {
  const base = mkdtempSync(join(tmpdir(), 'lb-init-'));
  const vibeHome = join(base, '.vibe');
  const agentsHome = join(base, '.agents');
  const lazyBrainHome = join(base, '.lazybrain');
  mkdirSync(vibeHome, { recursive: true });
  return { vibeHome, agentsHome, lazyBrainHome };
}

describe('runInitVibe', () => {
  it('writes the hook entry and preserves existing user hooks', async () => {
    const { vibeHome, agentsHome, lazyBrainHome } = makeHomes();
    writeFileSync(
      join(vibeHome, 'hooks.toml'),
      '[[hooks]]\nname = "user-own-hook"\ntype = "post_agent_turn"\ncommand = "echo hi"\n',
      'utf8',
    );
    const report = await runInitVibe({ vibeHome, agentsHome, lazyBrainHome });
    const parsed = parseToml(readFileSync(join(vibeHome, 'hooks.toml'), 'utf8')) as {
      hooks: Array<Record<string, unknown>>;
    };
    expect(parsed.hooks).toHaveLength(2);
    const names = parsed.hooks.map((h) => h.name);
    expect(names).toContain('user-own-hook');
    expect(names).toContain('lazybrain-capture');
    const lb = parsed.hooks.find((h) => h.name === 'lazybrain-capture')!;
    expect(String(lb.command)).toContain('vibe-hook.mjs');
    expect(lb.type).toBe('post_agent_turn');
    expect(report.hookInstalled).toBe(true);
  });

  it('is idempotent: re-running replaces, not duplicates, the entry', async () => {
    const { vibeHome, agentsHome, lazyBrainHome } = makeHomes();
    await runInitVibe({ vibeHome, agentsHome, lazyBrainHome });
    await runInitVibe({ vibeHome, agentsHome, lazyBrainHome });
    const parsed = parseToml(readFileSync(join(vibeHome, 'hooks.toml'), 'utf8')) as {
      hooks: Array<Record<string, unknown>>;
    };
    expect(parsed.hooks.filter((h) => h.name === 'lazybrain-capture')).toHaveLength(1);
  });

  it('only touches enable_experimental_hooks with explicit consent', async () => {
    const { vibeHome, agentsHome, lazyBrainHome } = makeHomes();
    writeFileSync(join(vibeHome, 'config.toml'), 'theme = "dark"\n', 'utf8');

    const without = await runInitVibe({ vibeHome, agentsHome, lazyBrainHome });
    expect(without.experimentalHooksEnabled).toBe(false);
    let config = parseToml(readFileSync(join(vibeHome, 'config.toml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config.enable_experimental_hooks).toBeUndefined();
    expect(config.theme).toBe('dark');

    const withFlag = await runInitVibe({ vibeHome, agentsHome, lazyBrainHome, enableHooks: true });
    expect(withFlag.experimentalHooksEnabled).toBe(true);
    config = parseToml(readFileSync(join(vibeHome, 'config.toml'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config.enable_experimental_hooks).toBe(true);
    expect(config.theme).toBe('dark');
  });

  it('installs skills into <agentsHome>/skills/<name>/SKILL.md', async () => {
    const { vibeHome, agentsHome, lazyBrainHome } = makeHomes();
    const report = await runInitVibe({ vibeHome, agentsHome, lazyBrainHome });
    expect(report.skillsInstalled).toContain('lazybrain-recall');
    const skillFile = join(agentsHome, 'skills', 'lazybrain-recall', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, 'utf8')).toContain('lazybrain search');
  });

  it('installs the explore override with --explore', async () => {
    const { vibeHome, agentsHome, lazyBrainHome } = makeHomes();
    const report = await runInitVibe({ vibeHome, agentsHome, lazyBrainHome, explore: true });
    expect(report.exploreInstalled).toBe(true);
    expect(existsSync(join(vibeHome, 'agents', 'explore.toml'))).toBe(true);
    expect(readFileSync(join(vibeHome, 'prompts', 'explore.md'), 'utf8')).toContain(
      'lazybrain search',
    );
  });

  it('fails clearly when the vibe home is missing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'lb-init-'));
    await expect(
      runInitVibe({ vibeHome: join(base, 'nope'), agentsHome: join(base, '.agents') }),
    ).rejects.toThrow(/Vibe home not found/);
  });

  // Task 4: stable hook path — shim copied to lazyBrainHome, hooks.toml references that path
  it('copies vibe-hook.mjs to lazyBrainHome/hooks/ and references stable path', async () => {
    const { vibeHome, agentsHome, lazyBrainHome } = makeHomes();
    const report = await runInitVibe({ vibeHome, agentsHome, lazyBrainHome });
    expect(report.hookInstalled).toBe(true);

    // The stable copy must exist
    const stableShim = join(lazyBrainHome, 'hooks', 'vibe-hook.mjs');
    expect(existsSync(stableShim)).toBe(true);

    // hooks.toml must reference the stable path, not the npm package path
    const parsed = parseToml(readFileSync(join(vibeHome, 'hooks.toml'), 'utf8')) as {
      hooks: Array<Record<string, unknown>>;
    };
    const lb = parsed.hooks.find((h) => h.name === 'lazybrain-capture')!;
    expect(String(lb.command)).toContain(lazyBrainHome);
    expect(String(lb.command)).toContain('vibe-hook.mjs');
  });

  it('re-init overwrites the stable shim (upgrade semantics)', async () => {
    const { vibeHome, agentsHome, lazyBrainHome } = makeHomes();
    await runInitVibe({ vibeHome, agentsHome, lazyBrainHome });
    // Corrupt the stable shim to simulate stale state
    const stableShim = join(lazyBrainHome, 'hooks', 'vibe-hook.mjs');
    writeFileSync(stableShim, '// stale\n', 'utf8');
    // Re-init should overwrite
    await runInitVibe({ vibeHome, agentsHome, lazyBrainHome });
    const content = readFileSync(stableShim, 'utf8');
    expect(content).not.toBe('// stale\n');
    expect(content).toContain('lazybrain');
  });
});
