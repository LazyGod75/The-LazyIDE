/* projectId.ts — shared helpers for turning a raw project/cluster identifier
   into a single canonical, human-readable form.

   The SAME project can appear under two different raw identifiers depending
   on how it entered the brain:
   - a short semantic name ("lazy-backoffice") when derived from a topic tag
   - a full absolute filesystem path ("C:\Users\...\lazy-backoffice") when
     the project was scanned via "Add project to brain"
     (AddProjectToBrainWizard), which records the project root itself as
     the identifier

   Both brainAdapter.ts (graph cluster ids — BrainControls' filter chips and
   legend) and listProjects.ts (Rules tab project filter) need to collapse
   these two representations into ONE before using them as a de-dup key —
   otherwise the same project shows up twice under two different-looking
   labels. Kept as a tiny standalone module (no React/DOM) so both can share
   it without introducing a dependency between them. */

/** True when an id looks like a filesystem path rather than a short semantic name. */
export function looksLikeFsPath(id: string): boolean {
  return id.includes('/') || id.includes('\\');
}

/** Collapses a path-like id down to its last path segment (the project
    folder's own name); short semantic names pass through unchanged. Never
    changes a non-path id, so it is safe to apply unconditionally. */
export function basenameOf(id: string): string {
  if (!looksLikeFsPath(id)) return id;
  const segments = id.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] || id;
}
