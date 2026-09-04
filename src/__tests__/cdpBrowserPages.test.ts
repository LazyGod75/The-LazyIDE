import { describe, it, expect } from 'vitest';

/**
 * C54 / C55 — unit-level contracts for CloudCdpBrowser without a live CDP socket.
 * We exercise the public helpers that parse CDP targets and build full-page
 * screenshot params; the class methods that need a live socket are covered by
 * the pure helpers exported for testability.
 */
import {
  buildFullPageScreenshotParams,
  pickDistinctPageTarget,
} from '../lib/solari/cdpBrowser';

describe('CDP multi-tab + full-page screenshot (C54/C55)', () => {
  it('pickDistinctPageTarget prefers a new target id over the existing page', () => {
    const created = pickDistinctPageTarget(
      [{ targetId: 't1', type: 'page' }, { targetId: 't2', type: 'page' }],
      't1',
      't2',
    );
    expect(created).toEqual({ targetId: 't2', type: 'page' });
  });

  it('pickDistinctPageTarget falls back to createdTargetId when list is empty', () => {
    expect(pickDistinctPageTarget([], undefined, 't_new')).toEqual({ targetId: 't_new', type: 'page' });
  });

  it('buildFullPageScreenshotParams sets captureBeyondViewport when fullPage', () => {
    expect(buildFullPageScreenshotParams({ format: 'png', fullPage: true })).toEqual({
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
    });
    expect(buildFullPageScreenshotParams({ format: 'jpeg', fullPage: false })).toEqual({
      format: 'jpeg',
      fromSurface: true,
    });
  });
});
