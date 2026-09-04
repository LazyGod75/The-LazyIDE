/* pulses.ts — signal pulses that travel along memory links, ported from the
   design handoff prototype's `pulses` builder and per-frame update inside
   `loop()`. Each pulse rides a random edge; when it reaches the target
   node the caller sets that node's `_fire` field to trigger the arrival
   "shockwave" drawn in draw.ts.
*/

export interface PulseState {
  /** Index into the scene's edge list. */
  edgeIndex: number;
  /** 0..1 position along the edge. */
  t: number;
  speed: number;
}

export const PULSE_COUNT = 16;
const PULSE_SEED = 7;
const PULSE_MIN_SPEED = 0.004;
const PULSE_SPEED_RANGE = 0.008;

/** ANSI C LCG constants — matches the prototype's dedicated pulses generator exactly. */
function createAnsiCRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
}

/** Builds the fixed pool of signal pulses, each assigned to a random edge. */
export function buildPulses(
  edgeCount: number,
  count: number = PULSE_COUNT,
  seed: number = PULSE_SEED,
): PulseState[] {
  if (edgeCount <= 0) return [];
  const rng = createAnsiCRng(seed);
  const pulses: PulseState[] = [];
  for (let i = 0; i < count; i++) {
    pulses.push({
      edgeIndex: Math.floor(rng() * edgeCount),
      t: rng(),
      speed: PULSE_MIN_SPEED + rng() * PULSE_SPEED_RANGE,
    });
  }
  return pulses;
}

/**
 * Advances a pulse by one frame, wrapping at 1. Mutates `pulse.t` in place
 * (hot-path helper called once per pulse per frame — no allocation) and
 * returns true on the frame it wraps, so the caller can fire the target
 * node's arrival shockwave.
 */
export function advancePulse(pulse: PulseState): boolean {
  pulse.t += pulse.speed;
  if (pulse.t >= 1) {
    pulse.t -= 1;
    return true;
  }
  return false;
}
