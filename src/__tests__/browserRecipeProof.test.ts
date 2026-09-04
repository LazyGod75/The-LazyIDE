/**
 * browserRecipeProof.test.ts — Mission B (proof window).
 *
 * Covers browserRecipeProof.ts's pure transforms end to end:
 *   - outcome derivation distinguishes voluntary stop / circuit breaker /
 *     failure / completion honestly;
 *   - the stopped-before step id and the circuit-breaker step are both
 *     identified correctly;
 *   - the manager-facing contract (summary text + stable capture refs);
 *   - the rendered HTML makes the stop point explicit and visually
 *     distinguishes a circuit-breaker abort from a voluntary stop;
 *   - no secret ever reaches the built run, its summary, or its HTML, even
 *     if a future upstream bug started echoing one back;
 *   - the inline-screenshot weight cap;
 *   - disk persistence (best-effort, Tauri-gated), same platform-mock
 *     pattern as consolidation.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserRecipe, BrowserRecipeResult } from '../lib/agents/browserRecipe';
import {
  BROWSER_PROOF_INLINE_SCREENSHOT_CAP,
  browserProofSurfaceId,
  buildBrowserProofHtml,
  buildBrowserProofRun,
  capBrowserProofScreenshots,
  createBrowserProofRunId,
  deriveBrowserProofOutcome,
  listBrowserProofCaptureRefs,
  persistBrowserProofScreenshots,
  summarizeBrowserProofRun,
  type BrowserProofLabels,
} from '../lib/agents/browserRecipeProof';

// ── platform mock (disk persistence only — see the last describe block) ──
const isTauriMock = vi.fn(() => true);
const createDirMock = vi.fn().mockResolvedValue(undefined);
const writeFileMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  isTauri: () => isTauriMock(),
  getPlatform: () => ({
    fs: {
      createDir: (...a: unknown[]) => createDirMock(...a),
      writeFile: (...a: unknown[]) => writeFileMock(...a),
    },
  }),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => 'C:\\Users\\test\\AppData\\Roaming\\lazy',
}));

const LABELS: BrowserProofLabels = {
  outcomeStoppedTitle: 'Stopped before the irreversible step',
  outcomeCircuitBreakerTitle: 'Circuit breaker — unexpected screen',
  outcomeFailedTitle: 'Run failed',
  outcomeCompletedTitle: 'Completed',
  stoppedBeforeLine: 'Stopped before step "{stepId}" — never executed.',
  circuitBreakerLine: 'Unexpected screen "{label}" after step "{stepId}".',
  failedLine: 'Failed: {reason}',
  irreversibleExecutedBadge: 'Irreversible — executed',
  stepOkBadge: 'OK',
  stepFailedBadge: 'Failed',
  screenshotCappedNote: 'Kept on disk only',
  noScreenshotNote: 'No screenshot',
  stepsHeading: 'Steps',
};

function recipe(overrides: Partial<BrowserRecipe> = {}): BrowserRecipe {
  return {
    profileName: 'acme-brand',
    steps: [
      { id: 'nav', kind: 'navigate', url: 'file:///page.html' },
      { id: 'wait', kind: 'waitFor', selector: '#ready' },
      { id: 'publish', kind: 'click', selector: '#go', irreversible: true },
    ],
    ...overrides,
  };
}

function okOutcome(id: string, screenshotBase64?: string) {
  return { id, kind: 'click' as const, ok: true, detail: 'done', screenshotBase64 };
}

beforeEach(() => {
  isTauriMock.mockReturnValue(true);
  createDirMock.mockClear().mockResolvedValue(undefined);
  writeFileMock.mockClear().mockResolvedValue(undefined);
});

describe('deriveBrowserProofOutcome', () => {
  it('precedence: circuit breaker beats stoppedBeforeFinal/failure', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: true,
      circuitBreakerTripped: { label: 'captcha', afterStepId: 'wait' },
      failure: null,
      steps: [],
    };
    expect(deriveBrowserProofOutcome(result)).toBe('circuitBreaker');
  });

  it('failure beats stoppedBeforeFinal', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: true,
      circuitBreakerTripped: null,
      failure: 'boom',
      steps: [],
    };
    expect(deriveBrowserProofOutcome(result)).toBe('failed');
  });

  it('stoppedBeforeFinal when nothing else fired', () => {
    const result: BrowserRecipeResult = { stoppedBeforeFinal: true, circuitBreakerTripped: null, failure: null, steps: [] };
    expect(deriveBrowserProofOutcome(result)).toBe('stoppedBeforeFinal');
  });

  it('completed otherwise', () => {
    const result: BrowserRecipeResult = { stoppedBeforeFinal: false, circuitBreakerTripped: null, failure: null, steps: [] };
    expect(deriveBrowserProofOutcome(result)).toBe('completed');
  });
});

describe('buildBrowserProofRun', () => {
  it('identifies the exact irreversible step the run stopped BEFORE (voluntary stop)', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: true,
      circuitBreakerTripped: null,
      failure: null,
      steps: [okOutcome('nav', 'shot-nav'), okOutcome('wait', 'shot-wait')],
    };
    const run = buildBrowserProofRun({ id: 'run-1', missionId: 'm1', recipe: recipe(), result });

    expect(run.outcome).toBe('stoppedBeforeFinal');
    expect(run.stoppedBeforeStepId).toBe('publish');
    expect(run.steps.map((s) => s.id)).toEqual(['nav', 'wait']);
    // The stopped-before step never even appears in the timeline (it never ran).
    expect(run.steps.some((s) => s.id === 'publish')).toBe(false);
  });

  it('flags the circuit-breaker step distinctly from a voluntary stop', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: false,
      circuitBreakerTripped: { label: 'verification screen', afterStepId: 'wait' },
      failure: null,
      steps: [
        okOutcome('nav', 'shot-nav'),
        { id: 'wait', kind: 'waitFor', ok: false, guardTripped: 'verification screen', screenshotBase64: 'shot-guard' },
      ],
    };
    const run = buildBrowserProofRun({ id: 'run-2', missionId: 'm1', recipe: recipe(), result });

    expect(run.outcome).toBe('circuitBreaker');
    expect(run.circuitBreaker).toEqual({ label: 'verification screen', afterStepId: 'wait' });
    expect(run.stoppedBeforeStepId).toBeUndefined();
  });

  it('marks the irreversible step as executed when the run actually completes it', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: false,
      circuitBreakerTripped: null,
      failure: null,
      steps: [okOutcome('nav'), okOutcome('wait'), okOutcome('publish', 'shot-publish')],
    };
    const run = buildBrowserProofRun({ id: 'run-3', missionId: 'm1', recipe: recipe(), result });

    expect(run.outcome).toBe('completed');
    const publishStep = run.steps.find((s) => s.id === 'publish');
    expect(publishStep?.irreversible).toBe(true);
  });

  it('gives every screenshot a stable ref scoped to the run', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: true,
      circuitBreakerTripped: null,
      failure: null,
      steps: [okOutcome('nav', 'shot-nav')],
    };
    const run = buildBrowserProofRun({ id: 'run-4', missionId: 'm1', recipe: recipe(), result });
    expect(run.steps[0].screenshotRef).toBe('run-4:nav');
    expect(run.steps[0].screenshotDataUri).toBe('data:image/png;base64,shot-nav');
  });

  it('NEVER leaks a secret/value field even if the upstream outcome erroneously carried one (allowlist copy, not a spread)', () => {
    const result = {
      stoppedBeforeFinal: true,
      circuitBreakerTripped: null,
      failure: null,
      steps: [
        // Simulates a hypothetical future bug where the Rust/controller side
        // started echoing back extra fields — buildBrowserProofRun must
        // still only ever copy its known allowlist.
        { id: 'login', kind: 'fill', ok: true, detail: 'filled', value: 'super-secret-password', secretEnvVar: 'LAZY_TEST_SECRET' },
      ],
    } as unknown as BrowserRecipeResult;
    const run = buildBrowserProofRun({
      id: 'run-5',
      missionId: 'm1',
      recipe: recipe({ steps: [{ id: 'login', kind: 'fill', selector: '#password', secretEnvVar: 'LAZY_TEST_SECRET' }] }),
      result,
    });

    const serialized = JSON.stringify(run);
    expect(serialized).not.toContain('super-secret-password');
    expect(run.steps[0]).not.toHaveProperty('value');
    expect(run.steps[0]).not.toHaveProperty('secretEnvVar');
  });
});

describe('capBrowserProofScreenshots (weight bound, directive #7)', () => {
  it('keeps a run at or under the cap unchanged (same reference)', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: false,
      circuitBreakerTripped: null,
      failure: null,
      steps: [okOutcome('a', 's1'), okOutcome('b', 's2')],
    };
    const run = buildBrowserProofRun({ id: 'run-cap-1', missionId: 'm1', recipe: recipe(), result });
    expect(capBrowserProofScreenshots(run, 5)).toBe(run);
  });

  it('drops the OLDEST inline screenshots first, keeping refs for all of them', () => {
    const steps = Array.from({ length: 10 }, (_, i) => okOutcome(`s${i}`, `shot-${i}`));
    const result: BrowserRecipeResult = { stoppedBeforeFinal: false, circuitBreakerTripped: null, failure: null, steps };
    const run = buildBrowserProofRun({
      id: 'run-cap-2',
      missionId: 'm1',
      recipe: recipe({ steps: steps.map((s) => ({ id: s.id, kind: 'click' })) }),
      result,
    });

    const capped = capBrowserProofScreenshots(run, 3);
    const withInline = capped.steps.filter((s) => s.screenshotDataUri !== undefined);
    expect(withInline).toHaveLength(3);
    expect(withInline.map((s) => s.id)).toEqual(['s7', 's8', 's9']);
    // Every step, capped or not, still carries its stable ref.
    expect(capped.steps.every((s) => s.screenshotRef !== undefined)).toBe(true);
  });

  it('defaults to BROWSER_PROOF_INLINE_SCREENSHOT_CAP when no explicit cap is given', () => {
    const steps = Array.from({ length: BROWSER_PROOF_INLINE_SCREENSHOT_CAP + 4 }, (_, i) => okOutcome(`s${i}`, `shot-${i}`));
    const result: BrowserRecipeResult = { stoppedBeforeFinal: false, circuitBreakerTripped: null, failure: null, steps };
    const run = buildBrowserProofRun({
      id: 'run-cap-3',
      missionId: 'm1',
      recipe: recipe({ steps: steps.map((s) => ({ id: s.id, kind: 'click' })) }),
      result,
    });

    const capped = capBrowserProofScreenshots(run);
    expect(capped.steps.filter((s) => s.screenshotDataUri !== undefined)).toHaveLength(BROWSER_PROOF_INLINE_SCREENSHOT_CAP);
  });
});

describe('manager-facing contract (directive #5)', () => {
  it('summarizeBrowserProofRun names the stopped-before step explicitly for a voluntary stop', () => {
    const result: BrowserRecipeResult = { stoppedBeforeFinal: true, circuitBreakerTripped: null, failure: null, steps: [okOutcome('nav', 's1')] };
    const run = buildBrowserProofRun({ id: 'run-6', missionId: 'm1', recipe: recipe(), result });
    const summary = summarizeBrowserProofRun(run);
    expect(summary).toContain('publish');
    expect(summary.toLowerCase()).toContain('stopped deliberately');
  });

  it('summarizeBrowserProofRun distinguishes a circuit-breaker abort from a voluntary stop', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: false,
      circuitBreakerTripped: { label: 'captcha', afterStepId: 'wait' },
      failure: null,
      steps: [okOutcome('nav'), { id: 'wait', kind: 'waitFor', ok: false, guardTripped: 'captcha' }],
    };
    const run = buildBrowserProofRun({ id: 'run-7', missionId: 'm1', recipe: recipe(), result });
    const summary = summarizeBrowserProofRun(run);
    expect(summary).toContain('captcha');
    expect(summary.toLowerCase()).toContain('circuit breaker');
    expect(summary.toLowerCase()).not.toContain('stopped deliberately');
  });

  it('listBrowserProofCaptureRefs returns one stable ref per capture, in order', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: false,
      circuitBreakerTripped: null,
      failure: null,
      steps: [okOutcome('a', 's1'), { id: 'b', kind: 'click', ok: false, error: 'x' }, okOutcome('c', 's3')],
    };
    const run = buildBrowserProofRun({
      id: 'run-8',
      missionId: 'm1',
      recipe: recipe({ steps: [{ id: 'a', kind: 'click' }, { id: 'b', kind: 'click' }, { id: 'c', kind: 'click' }] }),
      result,
    });
    const refs = listBrowserProofCaptureRefs(run);
    expect(refs).toEqual([
      { ref: 'run-8:a', stepId: 'a', ok: true },
      { ref: 'run-8:c', stepId: 'c', ok: true },
    ]);
  });
});

describe('buildBrowserProofHtml — explicit stop point + coupe-circuit distinction (directives #3 and #4)', () => {
  it('a voluntary stop shows the "stopped before" banner naming the exact step', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: true,
      circuitBreakerTripped: null,
      failure: null,
      steps: [okOutcome('nav', 's1'), okOutcome('wait', 's2')],
    };
    const run = buildBrowserProofRun({ id: 'run-9', missionId: 'm1', recipe: recipe(), result });
    const html = buildBrowserProofHtml(run, LABELS);

    expect(html).toContain('class="banner banner-stop"');
    expect(html).toContain('Stopped before step "publish"');
    expect(html).not.toContain('class="banner banner-breaker"');
  });

  it('a circuit-breaker abort shows the DISTINCT breaker banner + step highlight, never the voluntary-stop banner', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: false,
      circuitBreakerTripped: { label: 'unexpected layout', afterStepId: 'wait' },
      failure: null,
      steps: [
        okOutcome('nav', 's1'),
        { id: 'wait', kind: 'waitFor', ok: false, guardTripped: 'unexpected layout', screenshotBase64: 's2' },
      ],
    };
    const run = buildBrowserProofRun({ id: 'run-10', missionId: 'm1', recipe: recipe(), result });
    const html = buildBrowserProofHtml(run, LABELS);

    expect(html).toContain('class="banner banner-breaker"');
    expect(html).not.toContain('class="banner banner-stop"');
    expect(html).toContain('step-breaker');
    expect(html).toContain('unexpected layout');
  });

  it('escapes step detail/error text (defense in depth — a target page could put anything in innerText)', () => {
    const result: BrowserRecipeResult = {
      stoppedBeforeFinal: false,
      circuitBreakerTripped: null,
      failure: null,
      steps: [{ id: 'assert', kind: 'assert', ok: false, error: '<script>alert(1)</script>' }],
    };
    const run = buildBrowserProofRun({
      id: 'run-11',
      missionId: 'm1',
      recipe: recipe({ steps: [{ id: 'assert', kind: 'assert', expect: 'visible', selector: '#x' }] }),
      result,
    });
    const html = buildBrowserProofHtml(run, LABELS);

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('never leaks a secret literal into the rendered HTML', () => {
    const result = {
      stoppedBeforeFinal: false,
      circuitBreakerTripped: null,
      failure: null,
      steps: [{ id: 'login', kind: 'fill', ok: true, detail: 'filled', value: 'planted-secret-xyz' }],
    } as unknown as BrowserRecipeResult;
    const run = buildBrowserProofRun({
      id: 'run-12',
      missionId: 'm1',
      recipe: recipe({ steps: [{ id: 'login', kind: 'fill', selector: '#p', secretEnvVar: 'X' }] }),
      result,
    });
    const html = buildBrowserProofHtml(run, LABELS);
    expect(html).not.toContain('planted-secret-xyz');
  });

  it('caps inline images even when the caller forgot to cap the run first (defense in depth)', () => {
    const steps = Array.from({ length: BROWSER_PROOF_INLINE_SCREENSHOT_CAP + 5 }, (_, i) => okOutcome(`s${i}`, `imgdata${i}`));
    const result: BrowserRecipeResult = { stoppedBeforeFinal: false, circuitBreakerTripped: null, failure: null, steps };
    const run = buildBrowserProofRun({
      id: 'run-13',
      missionId: 'm1',
      recipe: recipe({ steps: steps.map((s) => ({ id: s.id, kind: 'click' })) }),
      result,
    });
    const html = buildBrowserProofHtml(run, LABELS);
    const imgCount = (html.match(/<img /g) ?? []).length;
    expect(imgCount).toBe(BROWSER_PROOF_INLINE_SCREENSHOT_CAP);
  });
});

describe('ids', () => {
  it('browserProofSurfaceId is deterministic per profile and slugifies unsafe characters', () => {
    expect(browserProofSurfaceId('Acme Brand!!')).toBe(browserProofSurfaceId('Acme Brand!!'));
    expect(browserProofSurfaceId('Acme Brand!!')).not.toMatch(/[^a-zA-Z0-9_-]/);
  });

  it('createBrowserProofRunId is unique per mission+timestamp for the same profile', () => {
    const a = createBrowserProofRunId('acme', 'm1', 1000);
    const b = createBrowserProofRunId('acme', 'm2', 1000);
    expect(a).not.toBe(b);
    expect(a.startsWith(browserProofSurfaceId('acme'))).toBe(true);
  });
});

describe('persistBrowserProofScreenshots (best-effort disk backup, Tauri-gated)', () => {
  it('writes each inline screenshot to disk and records screenshotDiskPath', async () => {
    const result: BrowserRecipeResult = { stoppedBeforeFinal: true, circuitBreakerTripped: null, failure: null, steps: [okOutcome('nav', 's1')] };
    const run = buildBrowserProofRun({ id: 'run-disk-1', missionId: 'm1', recipe: recipe(), result });

    const persisted = await persistBrowserProofScreenshots(run);

    expect(createDirMock).toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(persisted.steps[0].screenshotDiskPath).toBeTruthy();
    // The written content is the same base64 data URI, never a secret.
    const [, content] = writeFileMock.mock.calls[0] as [string, string];
    expect(content).toBe('data:image/png;base64,s1');
  });

  it('is a no-op outside Tauri (web/test platform)', async () => {
    isTauriMock.mockReturnValue(false);
    const result: BrowserRecipeResult = { stoppedBeforeFinal: true, circuitBreakerTripped: null, failure: null, steps: [okOutcome('nav', 's1')] };
    const run = buildBrowserProofRun({ id: 'run-disk-2', missionId: 'm1', recipe: recipe(), result });

    const persisted = await persistBrowserProofScreenshots(run);
    expect(createDirMock).not.toHaveBeenCalled();
    expect(persisted).toBe(run);
  });

  it('never throws when createDir fails — degrades to the unpersisted run', async () => {
    createDirMock.mockRejectedValueOnce(new Error('disk full'));
    const result: BrowserRecipeResult = { stoppedBeforeFinal: true, circuitBreakerTripped: null, failure: null, steps: [okOutcome('nav', 's1')] };
    const run = buildBrowserProofRun({ id: 'run-disk-3', missionId: 'm1', recipe: recipe(), result });

    await expect(persistBrowserProofScreenshots(run)).resolves.toEqual(run);
  });
});
