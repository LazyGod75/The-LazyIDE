/* dedupKindAbout.test.ts
   Tests for the fix to dedup.ts's queryByKindAbout / buildKindAboutSelector.

   Ground truth: `article[data-cerveau-kind="${kind}"][data-cerveau-about="${about}"]`
   targeted an attribute (data-cerveau-kind) that no capture path ever writes
   on a note's <article> (same root cause as recompose-all.ts's
   extractAuthoredItem — see that file's deriveAuthoredKind() doc comment),
   so the "same-kind-about" dedup path never fired against real data; every
   probe silently fell through to queryByTitle.

   buildKindAboutSelector() now also matches on data-cerveau-type (for
   "decision") or data-cerveau-tags (for bug/rule/warning/idea/qa/activity) —
   the fields capture.rs's event_to_html genuinely populates — while keeping
   the explicit data-cerveau-kind branch for forward compatibility.

   NOTE (reported, not fixed here): `data-cerveau-about` itself is ALSO never
   written by any current capture path (CaptureEvent.about has no TS caller
   that sets it, verified the same way as itemKind). So even after this fix,
   queryByKindAbout still returns zero hits against TODAY's real notes — the
   selector is now correct, but nothing in the brain carries the `about`
   half of it yet. The tests below prove the SELECTOR is now correct — that
   is this file's fix's scope — using a mocked queryCss so they do not
   depend on `about` being wired up.
*/

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(),
  isTauri: vi.fn(() => true),
}));

import { getPlatform, isTauri } from '../lib/platform';
import { buildKindAboutSelector, findDuplicates } from '../lib/brain/dedup';

const mockGetPlatform = vi.mocked(getPlatform);
const mockIsTauri = vi.mocked(isTauri);

describe('buildKindAboutSelector', () => {
  it('maps kind "decision" onto data-cerveau-type, not just the dead data-cerveau-kind attribute', () => {
    const sel = buildKindAboutSelector('decision', 'file:src/payments/stripe.ts');
    expect(sel).toContain('article[data-cerveau-kind="decision"][data-cerveau-about="file:src/payments/stripe.ts"]');
    expect(sel).toContain('article[data-cerveau-type="decision"][data-cerveau-about="file:src/payments/stripe.ts"]');
  });

  it('maps every non-decision kind onto a whole-word data-cerveau-tags match', () => {
    for (const kind of ['bug', 'rule', 'warning', 'idea', 'qa', 'activity']) {
      const sel = buildKindAboutSelector(kind, 'file:x.ts');
      expect(sel).toContain(`article[data-cerveau-tags~="${kind}"][data-cerveau-about="file:x.ts"]`);
    }
  });

  it('ORs the explicit-kind and fallback selectors as a CSS selector list', () => {
    const sel = buildKindAboutSelector('bug', 'file:x.ts');
    const parts = sel.split(',').map((s) => s.trim());
    expect(parts).toHaveLength(2);
  });
});

describe('findDuplicates — same-kind-about path', () => {
  beforeEach(() => {
    mockIsTauri.mockReturnValue(true);
  });

  it('queries with a selector built from the populated fields, not the dead data-cerveau-kind-only selector', async () => {
    const queryCss = vi.fn().mockResolvedValue('#existing-1\nExisting bug note about stripe.ts');
    mockGetPlatform.mockReturnValue({
      brain: { queryCss, search: vi.fn() },
    } as unknown as ReturnType<typeof getPlatform>);

    await findDuplicates([
      { kind: 'bug', about: 'file:src/payments/stripe.ts', text: 'Webhook secret missing crashes silently', title: 'bug — webhook secret' },
    ]);

    expect(queryCss).toHaveBeenCalledTimes(1);
    const [selectorArg] = queryCss.mock.calls[0];
    // The old code called queryCss with ONLY the dead attribute; assert the
    // fixed selector also carries the populated data-cerveau-tags fallback.
    expect(selectorArg).toContain('data-cerveau-tags~="bug"');
    expect(selectorArg).toContain('data-cerveau-about="file:src/payments/stripe.ts"');
  });

  it('falls back to queryByTitle when the kind/about probe finds nothing (unchanged behavior)', async () => {
    const queryCss = vi.fn().mockResolvedValue('');
    const search = vi.fn().mockResolvedValue([]);
    mockGetPlatform.mockReturnValue({
      brain: { queryCss, search },
    } as unknown as ReturnType<typeof getPlatform>);

    await findDuplicates([
      { kind: 'decision', about: 'file:x.ts', text: 'Some decision', title: 'decision — x' },
    ]);

    expect(queryCss).toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith('decision — x', 10);
  });
});
