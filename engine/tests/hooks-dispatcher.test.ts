/**
 * hooks-dispatcher.test.ts
 *
 * Validates that:
 *   - hooks.json uses `node _run.mjs` for all hook events (no bash)
 *   - The Stop hook timeout is 15 s (fast path: index-update is detached)
 *   - _run.mjs has the spawnIndexRebuildDetached function (calls index-update)
 *   - install.ts buildHookCommand always returns a node command (no bash)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const HOOKS_DIR = join(REPO, 'plugins', 'lazybrain', 'hooks');
const HOOKS_JSON = join(HOOKS_DIR, 'hooks.json');
const RUN_MJS = join(HOOKS_DIR, '_run.mjs');
const INSTALL_TS = join(REPO, 'scripts', 'install.ts');

// ---------------------------------------------------------------------------
// hooks.json
// ---------------------------------------------------------------------------

describe('hooks.json', () => {
  it('exists', () => {
    expect(existsSync(HOOKS_JSON)).toBe(true);
  });

  it('is valid JSON', () => {
    const raw = readFileSync(HOOKS_JSON, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('uses node _run.mjs for all hook commands (no bash)', () => {
    const cfg = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
    for (const [event, entries] of Object.entries(cfg.hooks as Record<string, unknown[]>)) {
      for (const entry of entries) {
        for (const hook of (entry as { hooks: Array<{ command: string }> }).hooks) {
          expect(hook.command).toMatch(/^node\s+"/);
          expect(hook.command).not.toMatch(/^bash/);
          expect(hook.command).toContain('_run.mjs');
          expect(hook.command).not.toContain('_run.sh');
        }
      }
      // Ensure all events are covered
      expect(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop']).toContain(
        event,
      );
    }
  });

  it('Stop hook has timeout of 15 s (fast path; index-update is detached)', () => {
    const cfg = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
    const stopEntries = (cfg.hooks as Record<string, Array<{ hooks: Array<{ timeout?: number }> }>>)
      .Stop;
    expect(stopEntries).toBeDefined();
    for (const entry of stopEntries) {
      for (const hook of entry.hooks) {
        expect(hook.timeout).toBe(15);
      }
    }
  });

  it('all five expected events are registered', () => {
    const cfg = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
    const events = Object.keys(cfg.hooks);
    expect(events).toContain('SessionStart');
    expect(events).toContain('UserPromptSubmit');
    expect(events).toContain('PostToolUse');
    expect(events).toContain('PreCompact');
    expect(events).toContain('Stop');
  });

  it('passes the correct event name to each hook command', () => {
    const cfg = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
    const hooks = cfg.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const expectedEvents: Record<string, string> = {
      SessionStart: 'session-start',
      UserPromptSubmit: 'user-prompt-submit',
      PostToolUse: 'post-tool-use',
      PreCompact: 'pre-compact',
      Stop: 'stop',
    };
    for (const [event, eventStr] of Object.entries(expectedEvents)) {
      const entries = hooks[event];
      expect(entries, `${event} entries`).toBeDefined();
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          expect(hook.command).toContain(eventStr);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// _run.mjs
// ---------------------------------------------------------------------------

describe('_run.mjs', () => {
  it('exists', () => {
    expect(existsSync(RUN_MJS)).toBe(true);
  });

  it('uses built-in node:http module (no external deps)', () => {
    const src = readFileSync(RUN_MJS, 'utf8');
    expect(src).toContain("import http from 'node:http'");
    expect(src).not.toContain('createRequire');
  });

  it('implements spawnIndexRebuildDetached as a detached spawn', () => {
    const src = readFileSync(RUN_MJS, 'utf8');
    expect(src).toContain('spawnIndexRebuildDetached');
    expect(src).toContain('detached: true');
    expect(src).toContain('child.unref()');
  });

  it('uses index-update (incremental) not index-rebuild in spawnIndexRebuildDetached', () => {
    const src = readFileSync(RUN_MJS, 'utf8');
    // Must use the incremental command
    expect(src).toContain("'index-update'");
    // Must not spawn index-rebuild (full scan)
    expect(src).not.toContain("'index-rebuild'");
    // No TODO markers in shipped hook dispatcher
    expect(src).not.toMatch(/\bTODO\b/);
  });

  it('stop event calls spawnIndexRebuildDetached (index runs detached)', () => {
    const src = readFileSync(RUN_MJS, 'utf8');
    // Verify the stop case calls spawnIndexRebuildDetached
    const stopCase = src.slice(src.indexOf("case 'stop':"));
    expect(stopCase).toContain('spawnIndexRebuildDetached');
  });

  it('handles all 5 expected events', () => {
    const src = readFileSync(RUN_MJS, 'utf8');
    expect(src).toContain("case 'session-start':");
    expect(src).toContain("case 'user-prompt-submit':");
    expect(src).toContain("case 'post-tool-use':");
    expect(src).toContain("case 'pre-compact':");
    expect(src).toContain("case 'stop':");
  });

  it('stop event flushes capture synchronously before detached work', () => {
    const src = readFileSync(RUN_MJS, 'utf8');
    const stopCase = src.slice(src.indexOf("case 'stop':"));
    // flush_sync capture must appear before spawnIndexRebuildDetached
    const captureIdx = stopCase.indexOf('flush_sync');
    const rebuildIdx = stopCase.indexOf('spawnIndexRebuildDetached');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(rebuildIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(rebuildIdx);
  });
});

// ---------------------------------------------------------------------------
// install.ts (static source analysis)
// ---------------------------------------------------------------------------

describe('install.ts', () => {
  it('exists', () => {
    expect(existsSync(INSTALL_TS)).toBe(true);
  });

  it('buildHookCommand returns a node command, not bash', () => {
    const src = readFileSync(INSTALL_TS, 'utf8');
    // The function body must not contain a bash branch
    const fnStart = src.indexOf('function buildHookCommand(');
    const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain('node "${nodeDispatcher}"');
    expect(fnBody).not.toContain('"${bashPath}"');
    expect(fnBody).not.toContain('if (bashPath)');
  });

  it('Stop event timeout is 15 in eventMap', () => {
    const src = readFileSync(INSTALL_TS, 'utf8');
    // Look for "Stop:" entry in eventMap
    const stopLine = src.match(/Stop\s*:\s*\{[^}]*timeout:\s*(\d+)/);
    expect(stopLine).not.toBeNull();
    expect(Number(stopLine?.[1])).toBe(15);
  });

  it('registers all 5 hook events', () => {
    const src = readFileSync(INSTALL_TS, 'utf8');
    expect(src).toContain('SessionStart');
    expect(src).toContain('UserPromptSubmit');
    expect(src).toContain('PostToolUse');
    expect(src).toContain('PreCompact');
    expect(src).toContain('Stop');
  });

  it('idempotent wipe filter includes _run.sh and _run.mjs', () => {
    const src = readFileSync(INSTALL_TS, 'utf8');
    expect(src).toContain('_run.sh');
    expect(src).toContain('_run.mjs');
  });
});
