/**
 * onboarding.spec.ts — E2E coverage for the onboarding wizard's web contract.
 *
 * useOnboarding.ts (src/components/onboarding/useOnboarding.ts:89-95) gates
 * `showOnboarding` behind `isTauri() && userId` — the wizard is intentionally
 * desktop + authenticated-only and "never auto-opens on the public web demo"
 * (see the hook's own module doc comment). Playwright always drives the web
 * build (no Tauri runtime, see playwright.config.ts's webServer), so the
 * modal can NEVER appear here regardless of localStorage state — the four
 * tests this file used to have (seeding no 'lazy.onboarded' key and expecting
 * the wizard to appear, walking through its 4 steps, checking the completion
 * flag) tested a state this environment cannot produce, and predate the
 * 2026-07-11 manager-first redesign's default landing space change besides.
 *
 * What's left is the honest web-contract assertion: on a completely fresh
 * context (no localStorage at all — not even 'lazy.onboarded'), the modal
 * does not auto-open and the real app shell renders instead.
 *
 * The isTauri()+userId GATING LOGIC itself (the part this file cannot
 * exercise, desktop being unreachable from a browser) has no direct vitest
 * unit test as of this writing — grep src/__tests__ for `useOnboarding`:
 * the only hit is onboardingStepSet.test.tsx, which covers OnboardingModal's
 * FULL_STEPS vs CONDENSED_STEPS choice by rendering it directly with
 * explicit props, not useOnboarding()'s own isTauri()/userId branching. That
 * gap is real and worth closing separately; it is not filled by this file.
 */

import { test, expect } from 'playwright/test';

test.describe('Onboarding wizard — web build contract', () => {
  test('does not auto-open on a fresh context, and the real app shell renders instead', async ({ page }) => {
    // No addInitScript at all — the freshest possible context, no
    // 'lazy.onboarded' key, no locale pin. If the gate were ever wrong (e.g.
    // regressed to "first run on any platform"), this is exactly the
    // condition that would make the wizard incorrectly appear.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // No dialog of any kind renders on load — the command palette only opens
    // on Ctrl+K, and the onboarding modal (the only other dialog in the app)
    // is desktop-gated, so `dialog` should have zero matches, not just a
    // failed name lookup for the wizard's own labels.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The real shell renders in its place — TopNav's nav is locale-agnostic
    // here on purpose (no locale pin): 'Spaces' is a substring of every
    // shipped locale's translation (e.g. French 'Espaces'), so this assertion
    // holds regardless of the host's default navigator.language.
    await expect(page.getByRole('navigation', { name: /Spaces/i })).toBeVisible({ timeout: 20_000 });
  });

  test('still does not auto-open after a reload, with or without an onboarded flag', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: /Spaces/i })).toBeVisible({ timeout: 20_000 });
  });
});
