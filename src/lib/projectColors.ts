/* projectColors.ts — deterministic per-project color assignment (D3).

   No per-project color field exists anywhere in the data model
   (ProjectEntry has none) — this derives a stable color purely from the
   project id, so the same project always renders with the same hue across
   every consumer (Cockpit grid rows, Code sidebar, tabs) without any
   persisted state. Pure and synchronous; safe to call on every render.
*/

/** Ordered palette from the design handoff, extended with a few more
 *  distinct hues so a fleet of more than 5 open projects still gets
 *  visually distinguishable colors instead of repeating too soon. */
const PROJECT_COLOR_PALETTE: readonly string[] = [
  '#7C5CFF', // violet
  '#E64980', // pink
  '#38BDF8', // cyan
  '#0CA678', // green
  '#8A8F9C', // grey
  '#FBB924', // amber
  '#F87171', // red
  '#A78BFA', // light violet
  '#FB7185', // rose
  '#22C55E', // emerald
];

/** Small, deterministic string hash (djb2-ish) — same input always
 *  produces the same output, no external dependency needed for this. */
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Deterministic color for a project, stable across sessions/components.
 * Falls back to the palette's last (neutral grey) entry for an empty id.
 */
export function colorForProject(projectId: string): string {
  if (!projectId) return PROJECT_COLOR_PALETTE[PROJECT_COLOR_PALETTE.length - 1];
  const index = hashString(projectId) % PROJECT_COLOR_PALETTE.length;
  return PROJECT_COLOR_PALETTE[index];
}
