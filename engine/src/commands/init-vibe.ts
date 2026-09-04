/**
 * lazybrain init --agent vibe
 *
 * Installs the Vibe integration:
 *  1. [[hooks]] entry "lazybrain-capture" in <VIBE_HOME>/hooks.toml
 *     (merge-safe: parses existing TOML, replaces our entry, never clobbers
 *     user hooks; aborts the hooks step on unparseable TOML).
 *  2. enable_experimental_hooks = true in <VIBE_HOME>/config.toml — ONLY with
 *     the explicit --enable-hooks consent flag (it is an experimental Vibe
 *     feature; we never flip it silently).
 *  3. Recall skills into ~/.agents/skills/<name>/SKILL.md — the cross-agent
 *     directory Vibe scans natively. NOT ~/.vibe/skills (it would shadow).
 *  4. Optional: the LazybrainRead spatial-recall tool (--tools) and the
 *     brain-aware explore profile (--explore) — files shipped in
 *     plugins/lazybrain/vibe/.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { getLogger } from '../util/logger.js';

export interface InitVibeOptions {
  /** Override VIBE_HOME (tests). */
  vibeHome?: string;
  /** Override ~/.agents (tests). */
  agentsHome?: string;
  /** Override ~/.lazybrain (stable hook target dir; tests). */
  lazyBrainHome?: string;
  /** Explicit consent to set enable_experimental_hooks=true. */
  enableHooks?: boolean;
  /** Install the LazybrainRead spatial-recall Python tool. */
  tools?: boolean;
  /** Install the brain-aware explore subagent override. */
  explore?: boolean;
  pretty?: boolean;
}

export interface InitVibeReport {
  vibeHome: string;
  hookInstalled: boolean;
  experimentalHooksEnabled: boolean;
  skillsInstalled: string[];
  toolsInstalled: boolean;
  exploreInstalled: boolean;
  warnings: string[];
}

const HOOK_NAME = 'lazybrain-capture';
const SKILLS_TO_PORT = [
  'lazybrain-recall',
  'lazybrain-search',
  'lazybrain-query',
  'lazybrain-summary',
  'lazybrain-time-travel',
];

/** plugins/ ships next to dist/ in the npm package and in the repo. */
function pluginRoot(): string {
  return fileURLToPath(new URL('../../plugins/lazybrain/', import.meta.url));
}

export async function runInitVibe(opts: InitVibeOptions = {}): Promise<InitVibeReport> {
  const log = getLogger();
  const warnings: string[] = [];
  const vibeHome = resolve(opts.vibeHome ?? process.env.VIBE_HOME ?? join(homedir(), '.vibe'));
  const agentsHome = resolve(opts.agentsHome ?? join(homedir(), '.agents'));
  const lazyBrainHome = resolve(opts.lazyBrainHome ?? join(homedir(), '.lazybrain'));

  if (!existsSync(vibeHome)) {
    throw new Error(
      `Vibe home not found at ${vibeHome}. Install mistral-vibe and run it once first (or set VIBE_HOME).`,
    );
  }

  const hookInstalled = installHook(vibeHome, lazyBrainHome, warnings);
  const experimentalHooksEnabled = opts.enableHooks
    ? enableExperimentalHooks(vibeHome, warnings)
    : false;
  if (!opts.enableHooks && hookInstalled) {
    warnings.push(
      'Hooks stay dormant until enable_experimental_hooks=true in config.toml. Re-run with --enable-hooks to set it, or set it manually.',
    );
  }
  const skillsInstalled = installSkills(agentsHome, warnings);
  const toolsInstalled = opts.tools ? installTool(vibeHome, warnings) : false;
  const exploreInstalled = opts.explore ? installExplore(vibeHome, warnings) : false;

  log.info({ vibeHome, hookInstalled, skillsInstalled }, 'init --agent vibe complete');
  return {
    vibeHome,
    hookInstalled,
    experimentalHooksEnabled,
    skillsInstalled,
    toolsInstalled,
    exploreInstalled,
    warnings,
  };
}

/**
 * Copy the hook shim to a stable location under ~/.lazybrain/hooks/ and write
 * the [[hooks]] entry into $VIBE_HOME/hooks.toml pointing at that stable path.
 *
 * Why: if the npm package is reinstalled or its path changes, the shim ref
 * inside hooks.toml would silently break. The stable copy at ~/.lazybrain/hooks/
 * survives npm updates and re-init overwrites it to pick up shim upgrades.
 *
 * Known limitation: smol-toml rewrites hooks.toml without preserving TOML
 * comments. This is a smol-toml constraint, not a LazyBrain bug.
 */
function installHook(vibeHome: string, lazyBrainHome: string, warnings: string[]): boolean {
  const hooksPath = join(vibeHome, 'hooks.toml');
  const packageShimPath = join(pluginRoot(), 'vibe', 'vibe-hook.mjs');
  const stableHooksDir = join(lazyBrainHome, 'hooks');
  const stableShimPath = join(stableHooksDir, 'vibe-hook.mjs');

  // Copy shim to stable location; fall back to package path with a warning on failure.
  let shimPath = packageShimPath;
  try {
    mkdirSync(stableHooksDir, { recursive: true });
    copyFileSync(packageShimPath, stableShimPath);
    shimPath = stableShimPath;
  } catch (err) {
    warnings.push(
      `Could not copy hook shim to ${stableShimPath} (${(err as Error).message}). Falling back to package path — re-run after npm reinstall to refresh.`,
    );
  }

  let doc: Record<string, unknown> = {};
  if (existsSync(hooksPath)) {
    try {
      doc = parseToml(readFileSync(hooksPath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      warnings.push(
        `hooks.toml is not valid TOML (${(err as Error).message}) — hook NOT installed. Add it manually.`,
      );
      return false;
    }
  }

  const hooks = Array.isArray(doc.hooks) ? (doc.hooks as Array<Record<string, unknown>>) : [];
  const kept = hooks.filter((h) => h.name !== HOOK_NAME);
  kept.push({
    name: HOOK_NAME,
    type: 'post_agent_turn',
    command: `node "${shimPath}"`,
    timeout: 15.0,
    description: 'LazyBrain incremental memory capture (always exits 0)',
  });
  const next = { ...doc, hooks: kept };
  writeFileSync(hooksPath, `${stringifyToml(next)}\n`, 'utf8');
  return true;
}

function enableExperimentalHooks(vibeHome: string, warnings: string[]): boolean {
  const configPath = join(vibeHome, 'config.toml');
  let doc: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      doc = parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      warnings.push(
        `config.toml is not valid TOML (${(err as Error).message}) — flag NOT set. Set enable_experimental_hooks = true manually.`,
      );
      return false;
    }
  }
  const next = { ...doc, enable_experimental_hooks: true };
  writeFileSync(configPath, `${stringifyToml(next)}\n`, 'utf8');
  return true;
}

function installSkills(agentsHome: string, warnings: string[]): string[] {
  const sourceDir = join(pluginRoot(), 'skills');
  const installed: string[] = [];
  for (const name of SKILLS_TO_PORT) {
    const sourceFile = join(sourceDir, `${name}.SKILL.md`);
    if (!existsSync(sourceFile)) {
      warnings.push(`skill source missing: ${sourceFile}`);
      continue;
    }
    const targetDir = join(agentsHome, 'skills', name);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(sourceFile, join(targetDir, 'SKILL.md'));
    installed.push(name);
  }
  return installed;
}

function installTool(vibeHome: string, warnings: string[]): boolean {
  const source = join(pluginRoot(), 'vibe', 'tools', 'lazybrain_read.py');
  if (!existsSync(source)) {
    warnings.push(`tool source missing: ${source} (ships in a later task)`);
    return false;
  }
  const targetDir = join(vibeHome, 'tools');
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(source, join(targetDir, 'lazybrain_read.py'));
  return true;
}

function installExplore(vibeHome: string, warnings: string[]): boolean {
  const agentSource = join(pluginRoot(), 'vibe', 'agents', 'explore.toml');
  const promptSource = join(pluginRoot(), 'vibe', 'prompts', 'explore.md');
  if (!existsSync(agentSource) || !existsSync(promptSource)) {
    warnings.push('explore override sources missing (ships in a later task)');
    return false;
  }
  mkdirSync(join(vibeHome, 'agents'), { recursive: true });
  mkdirSync(join(vibeHome, 'prompts'), { recursive: true });
  copyFileSync(agentSource, join(vibeHome, 'agents', 'explore.toml'));
  copyFileSync(promptSource, join(vibeHome, 'prompts', 'explore.md'));
  return true;
}
