/**
 * Engine public surface — E2 imports from here.
 *
 * Dynamic import target: import('../engine/facade.js') must resolve createEngine.
 */

export type { EngineFacade, EngineDeps, FederatedHit, TeamBrainStats } from './facade.js';
export { createEngine } from './facade.js';
