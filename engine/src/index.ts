/**
 * Engine public API barrel — selective re-exports for TS consumers (Tauri/E2).
 *
 * The primary integration surface is the CLI (bin/lazybrain.ts); this barrel
 * exists so callers that import the engine as a library can access the
 * recompose functions and types without reaching into internal module paths.
 */

export { recomposeFileNeuronEnrichment, type AuthoredItem } from './annotator/blocks/composers/recompose.js';
export { type EnrichmentItem, type FileNeuronEnrichment } from './annotator/blocks/composers/file-neuron.js';
