/**
 * dream-tool-trace.ts — Facade for tool-trace file extraction.
 *
 * Implementation lives in src/util/tool-trace.ts so that sources/ modules
 * can import from the util layer without creating a sources → commands inversion.
 *
 * This file re-exports everything so the dream pipeline import path is unchanged.
 */

// Re-export all public symbols from the canonical util location.
export type { ToolTraceResult } from '../util/tool-trace.js';
export { extractToolTraceFiles, relativise } from '../util/tool-trace.js';
