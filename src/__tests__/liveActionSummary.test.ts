/**
 * Tests for liveActionSummary.ts's humanizeLiveAction — F2 fix (post-e2e
 * fix wave): mission cards used to render the raw tool-call JSON dump
 * verbatim (e.g. `Bash: Bash {"command":"node --test pricing.test.js"}`).
 */

import { describe, it, expect } from 'vitest';
import { humanizeLiveAction } from '../lib/agents/liveActionSummary';

describe('humanizeLiveAction', () => {
  it('returns an empty string for an undefined liveAction', () => {
    expect(humanizeLiveAction(undefined)).toBe('');
  });

  it('never renders raw JSON braces for a Bash tool call', () => {
    const result = humanizeLiveAction('Bash: Bash {"command":"node --test src/lib/pricing.test.js"}');
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    expect(result).toContain('bash');
    expect(result.startsWith('▊')).toBe(true);
  });

  it('humanizes a Read tool call to the file basename, never the full path', () => {
    const result = humanizeLiveAction('Read: Read {"file_path":"C:\\\\Users\\\\David\\\\.claude\\\\settings.json"}');
    expect(result).not.toContain('{');
    expect(result).not.toContain('C:\\Users');
    expect(result).toContain('lit');
    expect(result).toContain('settings.json');
  });

  it('humanizes a Write tool call', () => {
    const result = humanizeLiveAction('Write: Write {"content":"const x = 1;","file_path":"src/lib/pricing.ts"}');
    expect(result).not.toContain('{');
    expect(result).toContain('écrit');
    expect(result).toContain('pricing.ts');
  });

  it('humanizes a PowerShell tool call to a short command detail', () => {
    const result = humanizeLiveAction('PowerShell: PowerShell {"command":"node --version","description":"Check Node.js version"}');
    expect(result).not.toContain('{');
    expect(result).toContain('commande');
    expect(result).toContain('node --version');
  });

  it('falls back to the tool verb alone when the args are unparsable JSON', () => {
    const result = humanizeLiveAction('Bash: Bash {not valid json}');
    expect(result).not.toContain('{');
    expect(result).toContain('bash');
  });

  it('passes through an already human-readable French sentence unchanged (no JSON to strip)', () => {
    expect(humanizeLiveAction('Worktree prêt — démarrage du loop…')).toBe('Worktree prêt — démarrage du loop…');
    expect(humanizeLiveAction('Stoppé')).toBe('Stoppé');
    expect(humanizeLiveAction('Évaluation en cours…')).toBe('Évaluation en cours…');
    expect(humanizeLiveAction('Retry: previous attempt failed')).toBe('Retry: previous attempt failed');
  });

  it('truncates an overly long command detail', () => {
    const longCommand = 'a'.repeat(200);
    const result = humanizeLiveAction(`Bash: Bash {"command":"${longCommand}"}`);
    expect(result.length).toBeLessThan(longCommand.length);
    expect(result).toContain('…');
  });

  it('falls back to the lowercased tool name for an unrecognized tool', () => {
    const result = humanizeLiveAction('CustomTool: CustomTool {"foo":"bar"}');
    expect(result).not.toContain('{');
    expect(result.toLowerCase()).toContain('customtool');
  });
});

describe('humanizeLiveAction — translated verb via t (2026-08 i18n pass)', () => {
  // Regression guard: the live-action line used to render the French verb
  // unconditionally, even in an English/other-locale UI (audit finding —
  // "toujours français quelle que soit la langue"). A caller with a real
  // `t` (UrgentMissionCard.tsx/CompactMissionCard.tsx) must now get the
  // locale's own verb; a caller with no `t` (the canvas mission node,
  // out of this wave's scope) keeps the ORIGINAL French — never a crash,
  // never a silent behavior change for that path.
  const enT = (key: string) => {
    const dict: Record<string, string> = {
      'cockpit.liveAction.verb.bash': 'bash',
      'cockpit.liveAction.verb.command': 'command',
      'cockpit.liveAction.verb.read': 'reads',
      'cockpit.liveAction.verb.write': 'writes',
    };
    return dict[key] ?? key;
  };

  it('uses the translated verb when t is supplied', () => {
    const result = humanizeLiveAction('Read: Read {"file_path":"src/lib/pricing.ts"}', enT);
    expect(result).toContain('reads');
    expect(result).not.toContain('lit');
  });

  it('uses the translated command verb for PowerShell when t is supplied', () => {
    const result = humanizeLiveAction('PowerShell: PowerShell {"command":"node --version"}', enT);
    expect(result).toContain('command');
    expect(result).not.toContain('commande');
  });

  it('still falls back to the original French verb when t is omitted', () => {
    const result = humanizeLiveAction('Read: Read {"file_path":"src/lib/pricing.ts"}');
    expect(result).toContain('lit');
  });
});
