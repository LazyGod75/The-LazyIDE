/**
 * LazyBrain one-shot installer.
 *
 * What this does:
 *   - Validates Node version
 *   - Resolves brain path (interactive or via env)
 *   - Creates ~/.claude/settings.local.json hook entries (merged, not overwriting)
 *   - Symlinks (or copies) skills into ~/.claude/skills/
 *   - Prints next steps
 *
 * What it does NOT do:
 *   - Download models (run `npm run download-models` separately)
 *   - Push to git
 *   - Configure Anthropic API key (optional, only used by LLM annotator)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, '..');

function main(): void {
  if (Number.parseInt(process.versions.node.split('.')[0], 10) < 20) {
    fail('Node 20+ required.');
  }

  const brainPath = resolveBrainPath();
  ensureDirs(brainPath);

  buildAndLink();

  const claudeDir = join(homedir(), '.claude');
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

  copySkills(claudeDir);
  mergeSettings(claudeDir, brainPath);

  console.log('');
  console.log('LazyBrain installation complete.');
  console.log(`  Brain: ${brainPath}`);
  console.log(`  CLI:   lazybrain (npm-linked)`);
  console.log('');
  console.log('Optional next steps:');
  console.log('  1. Download ONNX models (~530 MB, one-time):');
  console.log('       npm run download-models');
  console.log('  2. Set ANTHROPIC_API_KEY for LLM-augmented annotation.');
  console.log('  3. Restart Claude Code so hooks pick up.');
}

function buildAndLink(): void {
  const distEntry = join(REPO, 'dist', 'bin', 'lazybrain.js');
  if (!existsSync(distEntry)) {
    console.log('Building lazybrain CLI...');
    execSync('npm run build', { cwd: REPO, stdio: 'inherit' });
  }
  console.log('Linking lazybrain to PATH...');
  try {
    execSync('npm link', { cwd: REPO, stdio: 'inherit' });
  } catch {
    console.warn('npm link failed (may need admin). Run manually: cd LazyBrain && npm link');
  }
}

function resolveBrainPath(): string {
  if (process.env.LAZYBRAIN_BRAIN_PATH) {
    return resolvePath(process.env.LAZYBRAIN_BRAIN_PATH);
  }
  const docs = join(homedir(), 'Documents');
  if (existsSync(docs)) {
    const match = readdirSync(docs).find(
      (d) => d.startsWith('Lazy-Brain') && existsSync(join(docs, d, 'brain', 'notes')),
    );
    if (match) {
      const found = join(docs, match, 'brain');
      console.log(`Auto-detected brain at: ${found}`);
      return found;
    }
  }
  const guess = process.env.LAZYBRAIN_BRAIN_PATH_GUESS ?? join(homedir(), 'Documents', 'Lazy-Brain', 'brain');
  console.log(`No brain found. Will create at: ${guess}`);
  return guess;
}

function ensureDirs(brainPath: string): void {
  const dirs = [brainPath, join(brainPath, 'notes'), join(brainPath, 'batches'), join(brainPath, 'meta')];
  for (const d of dirs) {
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true });
      console.log(`Created: ${d}`);
    }
  }
}

function copySkills(claudeDir: string): void {
  const skillsDir = join(claudeDir, 'skills');
  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
  // Skills live under plugins/lazybrain/skills (canonical layout for the
  // Claude Code plugin marketplace). The flat `skills/` dir is legacy.
  const candidates = [
    join(REPO, 'plugins', 'lazybrain', 'skills'),
    join(REPO, 'skills'),
  ];
  const src = candidates.find((p) => existsSync(p));
  if (!src) return;
  for (const f of readdirSync(src)) {
    if (!f.endsWith('.SKILL.md')) continue;
    const target = join(skillsDir, f);
    copyFileSync(join(src, f), target);
    console.log(`Skill installed: ${target}`);
  }
}

interface ClaudeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
  [key: string]: unknown;
}

/**
 * Detect whether bash is available on the current PATH.
 * Returns the full path to bash when found, or null otherwise.
 */
function findBash(): string | null {
  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['bash'],
      { encoding: 'utf8', timeout: 3000 },
    );
    if (result.status === 0) {
      const line = result.stdout.trim().split(/\r?\n/)[0].trim();
      if (line.length > 0) return line;
    }
  } catch {
    // spawnSync can throw on very restricted systems
  }
  return null;
}

/**
 * Build the hook command string for one event.
 *
 * The node dispatcher (_run.mjs) is always preferred — it is cross-platform,
 * requires no shell, and works identically on Windows, macOS, and Linux.
 * The bash dispatcher (_run.sh) is kept as a legacy reference but is no longer
 * registered by the installer.
 *
 * The Stop event uses the built dist binary directly (node dist/bin/lazybrain.js)
 * so no recompile cost is paid per session end.
 */
function buildHookCommand(
  _bashPath: string | null,
  _shDispatcher: string,
  nodeDispatcher: string,
  event: string,
): string {
  // Always use the cross-platform node dispatcher; no bash dependency.
  return `node "${nodeDispatcher}" ${event}`;
}

function mergeSettings(claudeDir: string, _brainPath: string): void {
  const file = join(claudeDir, 'settings.local.json');
  let cfg: ClaudeSettings = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      console.warn(`Could not parse ${file}, backing up.`);
      copyFileSync(file, `${file}.bak.${Date.now()}`);
    }
  }
  cfg.hooks ??= {};

  // Resolve dispatcher paths (forward slashes for cross-platform JSON safety).
  const hooksDir = join(REPO, 'plugins', 'lazybrain', 'hooks');
  const shDispatcher  = join(hooksDir, '_run.sh').replace(/\\/g, '/');
  const nodeDispatcher = join(hooksDir, '_run.mjs').replace(/\\/g, '/');

  // The node dispatcher is the default on all platforms. bash detection is
  // kept so findBash() can still be called by callers, but hooks.json and
  // settings.local.json always register the node path.
  const bashPath = findBash();

  const eventMap: Record<string, { matcher?: string; event: string; timeout: number }> = {
    SessionStart:     { matcher: 'startup|clear|compact|resume', event: 'session-start', timeout: 10 },
    UserPromptSubmit: { event: 'user-prompt-submit', timeout: 8 },
    PostToolUse:      { matcher: 'Edit|Write|MultiEdit|Bash', event: 'post-tool-use', timeout: 4 },
    PreCompact:       { event: 'pre-compact', timeout: 30 },
    // Stop timeout is short: fast capture runs inline; index-rebuild is detached.
    Stop:             { event: 'stop', timeout: 15 },
  };

  // Wipe prior LazyBrain entries (legacy bash + node .mjs paths) so reinstall is idempotent.
  for (const event of Object.keys(eventMap)) {
    const entries = cfg.hooks[event];
    if (entries) {
      cfg.hooks[event] = entries.filter(
        (e) =>
          !e.hooks.some(
            (h) =>
              typeof h.command === 'string' &&
              (h.command.includes('lazybrain') ||
                h.command.includes('LazyBrain/hooks') ||
                h.command.includes('LazyBrain\\hooks') ||
                h.command.includes('_run.sh') ||
                h.command.includes('_run.mjs')),
          ),
      );
    }
  }

  for (const [event, def] of Object.entries(eventMap)) {
    const entries = cfg.hooks[event] ?? [];
    const cmd = buildHookCommand(bashPath, shDispatcher, nodeDispatcher, def.event);
    const entry: { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> } = {
      hooks: [{ type: 'command', command: cmd, timeout: def.timeout }],
    };
    if (def.matcher) entry.matcher = def.matcher;
    entries.push(entry);
    cfg.hooks[event] = entries;
    console.log(`Hook registered: ${event} → node (cross-platform)`);
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(`Updated: ${file}`);
}

function fail(msg: string): never {
  console.error(`lazybrain install: ${msg}`);
  process.exit(1);
}

main();
