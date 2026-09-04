import { describe, it, expect } from 'vitest';
import { isImagePath } from '../spaces/CodeSpace';

// ── Image extension detection (CodeSpace.tsx's handleSidebarFileOpen) ──
// Determines whether opening a file from the sidebar routes to the
// ImagePreview overlay (binary-safe read) instead of a text editor tab
// (UTF-8 read, would corrupt binary image content).

describe('isImagePath', () => {
  it.each(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])('treats .%s as an image', (ext) => {
    expect(isImagePath(`screenshot.${ext}`)).toBe(true);
  });

  it('is case-insensitive on the extension', () => {
    expect(isImagePath('SCREENSHOT.PNG')).toBe(true);
  });

  it('returns false for source and text files', () => {
    expect(isImagePath('index.ts')).toBe(false);
    expect(isImagePath('README.md')).toBe(false);
    expect(isImagePath('package.json')).toBe(false);
  });

  it('returns false for a filename with no extension', () => {
    expect(isImagePath('Makefile')).toBe(false);
  });
});
