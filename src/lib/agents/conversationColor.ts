/* conversationColor — deterministic per-conversation accent colour
   (multi-conversation LazyManager, wave 1). A pure hash of the conversation
   id into a hue, rendered as a fixed-saturation/lightness HSL string so
   every colour in the palette reads at a consistent visual weight — same id
   always produces the same colour, no store/registry needed. Reused by the
   tab strip's pill dot (LazyManagerHeader.tsx) today; intended for canvas
   attribution chips once Mission.originConversationId grows a UI consumer
   (wave 2, see that field's own doc comment in lib/agents/types.ts). */

/** FNV-1a-ish string hash — fast, deterministic, no external dependency. */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Returns a stable `hsl(...)` colour for a conversation id — the SAME id
 *  always maps to the SAME colour, and different ids spread across the hue
 *  wheel (fixed saturation/lightness keeps every generated colour at a
 *  similar visual weight, so no id's dot reads as louder/dimmer than
 *  another's by chance of hash). */
export function conversationAccentColor(conversationId: string): string {
  const hue = hashString(conversationId) % 360;
  return `hsl(${hue}, 70%, 60%)`;
}
