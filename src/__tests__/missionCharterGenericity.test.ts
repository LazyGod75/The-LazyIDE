/* missionCharterGenericity.test.ts — Delivery criterion (SPEC-CHARTE-DE-
 * MISSION.md §8): "Aucun code spécifique à Instagram, aux carrousels ou au
 * format en 4 slides dans le produit." The demo use case (Instagram
 * carousels, 4 English slides) must never leak into the PRODUCT source of
 * the mission-charter / recurring-regime / browser-publishing feature — the
 * whole point is that any user can run the same playbook on a different
 * network, format, and subject with zero code changes.
 *
 * Scoped to the real feature surface only (not test fixtures, which
 * legitimately use "carousel"/"Instagram" as ARBITRARY example input data to
 * prove the generic path handles them like any other string — that is a
 * different thing from the product hard-coding logic around them). The
 * pre-existing ECC agent persona catalog (src/lib/agents/ecc/*) is also
 * deliberately excluded: `carousel-designer` there is one of ~73 generic
 * reusable specialist personas (alongside `kotlin-reviewer`, `seo-specialist`,
 * etc.), added in a separate, unrelated commit before this feature existed,
 * itself already multi-platform (Instagram/LinkedIn/X) with a dynamic slide
 * count — not a hard-coded shape for this spec's demo case.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');

// The real feature surface (spec Missions A-D): charter proposal, regime
// lifecycle, learning/artifact stores, browser-recipe publishing, and their
// validator/classifier/UI wiring. `managerEngine.ts` is handled separately
// below (see extractPromptSections) — it is the multi-thousand-line SYSTEM
// PROMPT for the whole manager, covering dozens of unrelated capabilities
// with their own illustrative worked examples (one pre-existing, unrelated
// example teaches "ask before presuming render pipeline" using an image-
// carousel-vs-video pair — a different feature, predating this spec); a
// whole-file scan there would flag that unrelated content, not this
// feature's own code.
const FEATURE_FILES = [
  'src/lib/agents/types.ts',
  'src/lib/agents/managerActionValidator.ts',
  'src/lib/agents/actionClassifier.ts',
  'src/lib/agents/loopGate.ts',
  'src/lib/agents/loopEngine.ts',
  'src/lib/agents/loopScheduler.ts',
  'src/lib/agents/loopArtifact.ts',
  'src/lib/agents/loopMetrics.ts',
  'src/lib/agents/browserRecipe.ts',
  'src/components/lazyManager/missionCharter.ts',
  'src/components/lazyManager/MissionCharterCard.tsx',
  'src/components/lazyManager/DecisionCard.tsx',
  'src/components/lazyManager/RegimeStatusCard.tsx',
];

/** Extracts JUST this feature's own prompt sections out of managerEngine.ts's
 *  much larger system prompt, by anchor text — the create_loop entry (incl.
 *  its charter-seed fields) and the whole Mission Charter block (propose_
 *  mission_charter + run_browser_recipe + their two Rules bullets). Throws
 *  if an anchor goes missing (a silent empty-string scan would be worse than
 *  no check at all — NEVER DEGRADE IN SILENCE). */
function extractPromptSections(source: string): string {
  function between(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`extractPromptSections: anchor not found ("${startMarker}" .. "${endMarker}")`);
    }
    return source.slice(start, end);
  }
  return [
    between('3. create_loop', '\n4.'),
    between('### Mission Charter (recurring/gated work)', '**Worked example (router)**'),
    between('use propose_mission_charter BEFORE', '\n- Never conflate the three triggers'),
  ].join('\n');
}

// Forbidden literal substrings — the demo's own network/format/copy, never a
// legitimate generic term. Checked case-insensitively.
const FORBIDDEN_TERMS = [
  'instagram',
  'carousel',
  'carrousel',
  '4 slide',
  '4-slide',
  'why are you bad at ai',
  'be lazy',
];

/** Strips comments before scanning — the criterion is "no CODE specific to
 *  the demo case" (hard-coded selectors/branches/defaults), not "the word
 *  never appears anywhere", which would also flag legitimate doc comments
 *  illustrating genericity itself (e.g. browserRecipe.ts's own header: "the
 *  same runner drives Instagram, another network, ... without any code
 *  change" — naming Instagram there is PROOF of genericity, not a
 *  violation). A string literal or identifier actually used in code is
 *  untouched by this stripping and still fails the check below. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

describe('Mission Charter feature — no demo-case-specific hardcoding (spec §8, delivery criterion)', () => {
  for (const file of FEATURE_FILES) {
    it(`${file} contains no Instagram/carousel/4-slide-format specifics in actual code`, () => {
      const raw = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
      const code = stripComments(raw).toLowerCase();
      for (const term of FORBIDDEN_TERMS) {
        expect(code, `found forbidden term "${term}" in ${file} (outside comments)`).not.toContain(term);
      }
    });
  }

  it('managerEngine.ts\'s own Mission Charter / create_loop / run_browser_recipe prompt sections contain no Instagram/carousel/4-slide-format specifics', () => {
    // buildManagerCorePrompt (the static system-prompt template this test
    // scans) was mechanically extracted out of managerEngine.ts into its own
    // module (managerCorePrompt.ts) — same content, same behavior, new file.
    const raw = readFileSync(resolve(REPO_ROOT, 'src/lib/agents/managerCorePrompt.ts'), 'utf-8');
    const sections = extractPromptSections(raw).toLowerCase();
    for (const term of FORBIDDEN_TERMS) {
      expect(sections, `found forbidden term "${term}" in managerEngine.ts's charter/loop/browser-recipe sections`).not.toContain(term);
    }
  });

  it('the same run_browser_recipe action shape works for a DIFFERENT network/format with no code change (genericity test, spec §8)', async () => {
    const { validateManagerAction } = await import('../lib/agents/managerActionValidator');
    // A completely different domain: a recipe-sharing site, a single long
    // post, no slides at all — same action, same validator, no special-case.
    const genericRecipe = {
      type: 'run_browser_recipe',
      recipe: {
        profileName: 'my-recipe-blog',
        steps: [
          { id: 'open', kind: 'navigate', url: 'https://example-recipes.test/new' },
          { id: 'title', kind: 'fill', selector: '#title', text: 'Weeknight Pasta' },
          { id: 'publish', kind: 'click', selector: '#publish-button', irreversible: true },
        ],
      },
    };
    expect(validateManagerAction(genericRecipe)).toEqual({ ok: true });
  });
});
