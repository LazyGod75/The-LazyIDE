/**
 * artifactImage.test.ts — resolveScreenshotSrc's binary-safe thumbnail
 * resolution (W9 stitch #1). Covers, in priority order:
 *   - readFileBase64 available + succeeds -> 'ok' with the base64 text used
 *     directly as the data: URI (no re-encoding).
 *   - readFileBase64 available + the ~5MB (base64.length * 0.75) guard trips
 *     -> 'too-large' WITHOUT falling back to the legacy readFile path.
 *   - readFileBase64 available + fails -> honest missing/unreadable via
 *     readDir, WITHOUT falling back to the legacy readFile path (both would
 *     fail identically for a real binary file).
 *   - readFileBase64 absent (web/Playwright mock) -> falls back to the
 *     legacy UTF-8 readFile + re-encode round-trip, unchanged from before
 *     this wave.
 *   - no platform.fs at all -> 'unreadable', never throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const readFile = vi.fn();
const readFileBase64 = vi.fn();
const readDir = vi.fn();

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(),
}));

import { getPlatform } from '../lib/platform';
import { resolveScreenshotSrc } from '../components/agents/report/artifactImage';

const mockGetPlatform = vi.mocked(getPlatform);

function installPlatform(opts: { withBase64: boolean }): void {
  mockGetPlatform.mockReturnValue({
    fs: {
      readFile,
      readDir,
      ...(opts.withBase64 ? { readFileBase64 } : {}),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal fs-only Platform test double
  } as any);
}

beforeEach(() => {
  readFile.mockReset();
  readFileBase64.mockReset();
  readDir.mockReset();
  mockGetPlatform.mockReset();
});

describe('resolveScreenshotSrc — binary-safe path (readFileBase64 present)', () => {
  it('resolves ok with the base64 text used directly as the data URI (no re-encoding)', async () => {
    installPlatform({ withBase64: true });
    readFileBase64.mockResolvedValue('iVBORw0KGgoAAAANSU'); // arbitrary base64-looking text

    const result = await resolveScreenshotSrc('/proj/.lazy/artifacts/m1/shot.png');

    expect(result).toEqual({ status: 'ok', dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSU' });
    expect(readFile).not.toHaveBeenCalled(); // legacy path never consulted when the binary-safe one succeeds
  });

  it('picks the mime type from the file extension', async () => {
    installPlatform({ withBase64: true });
    readFileBase64.mockResolvedValue('YWJj');

    const result = await resolveScreenshotSrc('/proj/shot.jpeg');

    expect(result).toEqual({ status: 'ok', dataUri: 'data:image/jpeg;base64,YWJj' });
  });

  it('applies the ~5MB guard on base64.length * 0.75 (decoded byte count) and never falls back', async () => {
    installPlatform({ withBase64: true });
    // MAX_INLINE_CHARS is 5_000_000 bytes; base64.length * 0.75 must exceed
    // that, so base64.length must exceed 5_000_000 / 0.75 ≈ 6_666_667.
    readFileBase64.mockResolvedValue('a'.repeat(6_700_000));

    const result = await resolveScreenshotSrc('/proj/huge.png');

    expect(result).toEqual({ status: 'too-large' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('a file just under the guard still resolves ok', async () => {
    installPlatform({ withBase64: true });
    readFileBase64.mockResolvedValue('a'.repeat(100));

    const result = await resolveScreenshotSrc('/proj/shot.png');

    expect(result.status).toBe('ok');
  });

  it('falls to the honest "unreadable" state when readFileBase64 fails but the file exists on disk', async () => {
    installPlatform({ withBase64: true });
    readFileBase64.mockRejectedValue(new Error('decode failed'));
    readDir.mockResolvedValue([{ name: 'shot.png', path: '/proj/shot.png', isDir: false }]);

    const result = await resolveScreenshotSrc('/proj/shot.png');

    expect(result).toEqual({ status: 'unreadable' });
    expect(readFile).not.toHaveBeenCalled(); // no redundant legacy attempt — same underlying fs, would fail identically
  });

  it('falls to the honest "missing" state when readFileBase64 fails and the file is absent from the directory listing', async () => {
    installPlatform({ withBase64: true });
    readFileBase64.mockRejectedValue(new Error('ENOENT'));
    readDir.mockResolvedValue([{ name: 'other.png', path: '/proj/other.png', isDir: false }]);

    const result = await resolveScreenshotSrc('/proj/shot.png');

    expect(result).toEqual({ status: 'missing' });
  });

  it('falls to "missing" when readFileBase64 AND readDir both fail', async () => {
    installPlatform({ withBase64: true });
    readFileBase64.mockRejectedValue(new Error('ENOENT'));
    readDir.mockRejectedValue(new Error('ENOENT'));

    const result = await resolveScreenshotSrc('/proj/shot.png');

    expect(result).toEqual({ status: 'missing' });
  });
});

describe('resolveScreenshotSrc — legacy UTF-8 fallback (readFileBase64 absent, e.g. web/Playwright mock)', () => {
  it('reads via readFile and base64-re-encodes when readFileBase64 is not exposed by the platform', async () => {
    installPlatform({ withBase64: false });
    readFile.mockResolvedValue('hello');

    const result = await resolveScreenshotSrc('/proj/shot.svg');

    expect(result.status).toBe('ok');
    expect(readFileBase64).not.toHaveBeenCalled();
    if (result.status === 'ok') {
      expect(result.dataUri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    }
  });

  it('resolves "missing" honestly when readFile fails and the directory listing has no such file', async () => {
    installPlatform({ withBase64: false });
    readFile.mockRejectedValue(new Error('ENOENT'));
    readDir.mockResolvedValue([]);

    const result = await resolveScreenshotSrc('/proj/shot.png');

    expect(result).toEqual({ status: 'missing' });
  });

  it('applies the legacy content.length guard (unchanged from before this wave)', async () => {
    installPlatform({ withBase64: false });
    readFile.mockResolvedValue('a'.repeat(5_000_001));

    const result = await resolveScreenshotSrc('/proj/huge.png');

    expect(result).toEqual({ status: 'too-large' });
  });
});

describe('resolveScreenshotSrc — no platform.fs', () => {
  it('resolves "unreadable" without throwing', async () => {
    mockGetPlatform.mockReturnValue({} as ReturnType<typeof getPlatform>);

    const result = await resolveScreenshotSrc('/proj/shot.png');

    expect(result).toEqual({ status: 'unreadable' });
  });
});
