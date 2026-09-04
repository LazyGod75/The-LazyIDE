/* statusReasonLabel.test.ts — real bug: mission card M26 rendered the raw
   machine token "consecutive_failures" instead of prose (confirmed live in
   the packaged app's DOM). This file proves translateStatusReason (a) maps
   every known raw reason token to prose in all 6 locales, (b) never lets an
   UNKNOWN raw snake_case token reach the UI verbatim, and (c) stays in sync
   with the actual reason literals managedAgent.ts emits, so a new reason
   added there without a matching KNOWN_REASONS entry fails this test
   instead of silently leaking to a mission card.
*/
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  translateStatusReason,
  __KNOWN_REASONS_FOR_TEST__ as KNOWN_REASONS,
  __looksLikeRawToken_FOR_TEST__ as looksLikeRawToken,
} from '../lib/agents/statusReasonLabel';
import { fr } from '../i18n/locales/fr';
import { en } from '../i18n/locales/en';
import { es } from '../i18n/locales/es';
import { de } from '../i18n/locales/de';
import { ja } from '../i18n/locales/ja';
import { zh } from '../i18n/locales/zh';

const REPO_ROOT = resolve(__dirname, '../..');
const LOCALES: Record<string, Record<string, string>> = { fr, en, es, de, ja, zh };

function makeTranslate(dict: Record<string, string>) {
  return (key: string, params?: Record<string, string | number>) => {
    let str = dict[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  };
}

describe('translateStatusReason — every known raw reason resolves to prose', () => {
  for (const [token, entry] of Object.entries(KNOWN_REASONS)) {
    it(`"${token}" is translated (never rendered raw) in every locale`, () => {
      for (const dict of Object.values(LOCALES)) {
        const t = makeTranslate(dict);
        const out = translateStatusReason(token, t);
        expect(out).toBeDefined();
        expect(out).not.toBe(token);
        expect(looksLikeRawToken(out as string)).toBe(false);
        // The dict itself must actually carry the key (not silently fall
        // back to the key name because it's missing from this locale).
        expect(dict[entry.key]).toBeTruthy();
      }
    });
  }

  it('falls back to the original French when no translator is supplied', () => {
    for (const token of Object.keys(KNOWN_REASONS)) {
      const out = translateStatusReason(token);
      expect(out).not.toBe(token);
      expect(looksLikeRawToken(out as string)).toBe(false);
    }
  });
});

describe('translateStatusReason — unknown raw tokens never reach the UI', () => {
  const unknownTokens = [
    'totally_new_unmapped_reason',
    'some_future_failure_kind',
    'x',
    'a_b_c_d_e_f',
  ];

  for (const token of unknownTokens) {
    it(`"${token}" (never seen by this module) becomes generic prose, not the raw token`, () => {
      const tEn = makeTranslate(en);
      const outDefault = translateStatusReason(token);
      const outEn = translateStatusReason(token, tEn);

      for (const out of [outDefault, outEn]) {
        expect(out).toBeDefined();
        expect(out).not.toBe(token);
        expect(out).not.toContain('_');
        expect(looksLikeRawToken(out as string)).toBe(false);
      }
    });
  }
});

describe('translateStatusReason — non-token values pass through unchanged', () => {
  it('leaves an already-translated French sentence untouched', () => {
    const prose = 'Mission arrêtée — budget dépassé (100% du plafond atteint).';
    expect(translateStatusReason(prose)).toBe(prose);
  });

  it('leaves free-form error text untouched', () => {
    const prose = 'TypeError: x is undefined';
    expect(translateStatusReason(prose)).toBe(prose);
  });

  it('passes undefined/empty through unchanged', () => {
    expect(translateStatusReason(undefined)).toBeUndefined();
    expect(translateStatusReason('')).toBe('');
  });
});

describe('translateStatusReason — worktree_creation_failed prefix', () => {
  it('translates the prefix and preserves the real error detail', () => {
    const raw = 'worktree_creation_failed: fatal: destination path already exists';
    const out = translateStatusReason(raw);
    expect(out).not.toBe(raw);
    expect(out).toContain('fatal: destination path already exists');
    expect(out).not.toMatch(/^worktree_creation_failed:/);
  });

  it('translates in every locale with the {detail} placeholder substituted', () => {
    const raw = 'worktree_creation_failed: some git error';
    for (const dict of Object.values(LOCALES)) {
      const t = makeTranslate(dict);
      const out = translateStatusReason(raw, t);
      expect(out).toContain('some git error');
      expect(out).not.toContain('{detail}');
    }
  });
});

describe('KNOWN_REASONS stays in sync with managedAgent.ts', () => {
  it('covers every static `reason:` literal emitMetrics passes on managed-loop failure', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'src/lib/agents/managedAgent.ts'), 'utf8');
    const matches = [...source.matchAll(/emitMetrics\(\{\s*type:\s*'failed',\s*reason:\s*(`[^`]*`|'[^']*')\s*\}\)/g)];
    expect(matches.length).toBeGreaterThan(0);

    for (const match of matches) {
      const literal = match[1];
      if (literal.startsWith('`')) {
        // Template literal — only the `stuck_${reason}` shape exists today;
        // both concrete StuckReason values it can interpolate (stuckDetector.ts)
        // must be pre-registered since this module can't evaluate the template.
        expect(literal).toBe('`stuck_${reason}`');
        expect(KNOWN_REASONS['stuck_repeated_identical_failure']).toBeDefined();
        expect(KNOWN_REASONS['stuck_repeated_action_observation']).toBeDefined();
        continue;
      }
      const token = literal.slice(1, -1);
      expect(KNOWN_REASONS[token], `KNOWN_REASONS is missing "${token}" — add it or it will render raw`).toBeDefined();
    }
  });

  it('covers globalRuntime.ts\'s crash-recovery reason and agentsStore.tsx\'s launch-stall reason', () => {
    expect(KNOWN_REASONS['interrupted_by_crash']).toBeDefined();
    expect(KNOWN_REASONS['launch_stalled']).toBeDefined();
  });
});
