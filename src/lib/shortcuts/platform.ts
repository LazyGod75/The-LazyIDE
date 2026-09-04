/* Centralizes the Mac-vs-other platform check used to resolve "Mod" in
   combo strings. Mirrors the navigator.platform sniff already used ad-hoc
   in AppShell.tsx / Omnibar.tsx — kept local to this module so the generic
   shortcut registry doesn't depend on those app-specific call sites. */

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.platform.toUpperCase().includes('MAC');
}
