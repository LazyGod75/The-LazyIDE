/* ambientField.ts — the "cortex density" ambient particle field and the
   drifting halo motes, ported from the design handoff prototype's
   `buildAmbient()` and `motes` builder.

   The field is a fixed-size, deterministic point cloud (typed arrays, no
   per-point objects) standing in for the brain's full mass — which can be
   5k-20k real neurons — so the renderer never rasterizes every real node
   individually. It is built once (after first paint, see BrainGraph3D's
   requestIdleCallback usage — "NE PAS CASSER" perf note in the handoff)
   and reused every frame; only the LOD stride (see projection.ts's
   `ambientStride`) changes how much of it gets drawn.
*/

import { createRng } from './layout';

export const AMBIENT_POINT_COUNT = 2400;
const AMBIENT_SEED = 1337;

export interface AmbientField {
  /** x,y,z interleaved per point (length = count * 3). */
  positions: Float32Array;
  /** phase, twinkleAmplitude interleaved per point (length = count * 2). */
  meta: Float32Array;
  count: number;
}

/**
 * Builds the ambient cortex field. Points are rejection-sampled inside the
 * unit ball then stretched into a two-lobe "brain" shape (mirrors the
 * prototype's `lobe = x>=0?1:-1` split), each carrying a random twinkle
 * phase/amplitude for the additive scintillation in the draw layer.
 */
export function buildAmbientField(
  count: number = AMBIENT_POINT_COUNT,
  seed: number = AMBIENT_SEED,
): AmbientField {
  const positions = new Float32Array(count * 3);
  const meta = new Float32Array(count * 2);
  const rng = createRng(seed);

  for (let i = 0; i < count; i++) {
    let x: number;
    let y: number;
    let z: number;
    do {
      x = rng() * 2 - 1;
      y = rng() * 2 - 1;
      z = rng() * 2 - 1;
    } while (x * x + y * y + z * z > 1);

    const lobe = x >= 0 ? 1 : -1;
    positions[i * 3] = (x * 0.74 + lobe * 0.3) * 1.34;
    positions[i * 3 + 1] = (y * 0.6 - 0.03) * 1.34;
    positions[i * 3 + 2] = z * 0.72 * 1.34;

    meta[i * 2] = rng() * 6.28;
    meta[i * 2 + 1] = 0.08 + rng() * 0.22;
  }

  return { positions, meta, count };
}

export interface Mote {
  angle: number;
  radiusFactor: number;
  speed: number;
  size: number;
  phase: number;
}

export const MOTE_COUNT = 40;
const MOTE_SEED = 99;

/** Park-Miller multiplicative LCG — matches the prototype's dedicated motes generator exactly. */
function createParkMillerRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

/** Ambient drifting motes rendered around the halo ring (see draw.ts's drawBackdrop). */
export function buildMotes(count: number = MOTE_COUNT, seed: number = MOTE_SEED): Mote[] {
  const rng = createParkMillerRng(seed);
  return Array.from({ length: count }, () => ({
    angle: rng() * Math.PI * 2,
    radiusFactor: 0.3 + rng() * 0.85,
    speed: (rng() - 0.5) * 0.0012,
    size: 0.5 + rng() * 1.2,
    phase: rng() * Math.PI * 2,
  }));
}
