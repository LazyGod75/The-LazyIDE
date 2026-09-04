/* Shared priority tiers for common shortcut-precedence patterns.
   Priorities are plain numbers (see ShortcutDefinition.priority) — these
   constants only exist to avoid magic numbers at call sites that need a
   scoped shortcut to deterministically win over a global one sharing the
   same combo (e.g. the editor's inline-edit Mod+K winning over the command
   palette's Mod+K while the editor has focus — see EditorPane.tsx and
   AppShell.tsx). Components are free to use raw numbers for anything more
   specific than these two tiers. */

export const SHORTCUT_PRIORITY = {
  /** Default tier for app-wide shortcuts with no competing scoped combo. */
  GLOBAL: 0,
  /** A scoped shortcut (e.g. "only while X is focused") that should win
   *  over a global shortcut sharing the same combo. */
  SCOPED: 10,
} as const;
