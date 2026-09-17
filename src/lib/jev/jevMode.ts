/* jevMode.ts — TypeSafe key storage + the "Jev mode" opt-in flag.

   Storage model mirrors byokProviders.ts: the API key lives in the OS
   credential vault on desktop (via vaultClient.ts's BYOK lane) and in
   localStorage when running in a plain browser (Playwright/QA).

   SECURITY — desktop posture is stronger than the other BYOK providers':
   api.typesafe.ai has no browser CORS support, so the actual API call is
   made by the Rust side (src-tauri/src/commands/jev.rs's jev_ask), which
   reads the key from the vault INTERNALLY. The raw key therefore never
   crosses IPC into the WebView — JS only ever holds a presence flag.

   Two distinct gates:
     isJevConfigured()  — a key exists (access)
     isJevModeOn()      — key exists AND the user opted in (consent)
   Every enhancement call site checks isJevModeOn(), never just the key.
*/

import {
  setSecret,
  deleteSecret,
  getSecretPresence,
  byokVaultKey,
} from '../vault/vaultClient.js';
import { emit } from '../bus.js';

const JEV_VAULT_KEY = byokVaultKey('typesafe'); // 'apikey.typesafe'
const JEV_LOCALSTORAGE_KEY = 'lazy.apikey.typesafe';
const JEV_ENABLED_KEY = 'lazy.jev.enabled';

declare global {
  interface Window {
    /** Sync presence flag (desktop) / raw key (browser fallback only).
     *  Never logged, never rendered. */
    __lazyJevConfigured?: boolean;
    __lazyJevKey?: string;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true' || raw === '1';
  } catch {
    return fallback;
  }
}

export function isJevRuntimeTauri(): boolean {
  try {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  } catch {
    return false;
  }
}

function emitStateChange(): void {
  emit('jev:stateChange', { configured: isJevConfigured(), enabled: isJevModeOn() });
}

/** Warm the sync presence mirror once at app start (called from main.tsx,
 *  same pattern as initByokVault). Desktop reads a masked presence check —
 *  never the raw secret. */
export async function initJevVault(): Promise<void> {
  try {
    if (isJevRuntimeTauri()) {
      const presence = await getSecretPresence(JEV_VAULT_KEY);
      window.__lazyJevConfigured = presence.present === true;
    } else {
      window.__lazyJevKey = localStorage.getItem(JEV_LOCALSTORAGE_KEY) ?? '';
      window.__lazyJevConfigured = window.__lazyJevKey.length > 0;
    }
  } catch (err) {
    console.warn('[jev] initJevVault failed:', err);
    window.__lazyJevConfigured = false;
  }
  emitStateChange();
}

/** A TypeSafe key is stored — necessary but not sufficient for Jev mode. */
export function isJevConfigured(): boolean {
  return window.__lazyJevConfigured === true;
}

/** Browser-runtime accessor for jevClient.ts's direct-fetch fallback —
 *  the ONLY legitimate reader. Desktop never populates this (the key
 *  stays in the OS vault; Rust reads it inside jev_ask). */
export function getJevBrowserKey(): string {
  return window.__lazyJevKey ?? '';
}

/** Jev mode = key configured AND user opted in. Every enhancement path
 *  gates on this single synchronous check; when false the app must
 *  behave exactly as if Jev did not exist. */
export function isJevModeOn(): boolean {
  return isJevConfigured() && readBool(JEV_ENABLED_KEY, true);
}

export function isJevModeEnabled(): boolean {
  return readBool(JEV_ENABLED_KEY, true);
}

export function setJevModeEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(JEV_ENABLED_KEY, String(enabled));
  } catch { /* ignore */ }
  emitStateChange();
}

/** Persist the key. Desktop: OS vault, JS keeps only a presence flag.
 *  Browser: the documented localStorage fallback (same as BYOK chat keys). */
export function saveJevKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  window.__lazyJevConfigured = true;
  if (isJevRuntimeTauri()) {
    void setSecret(JEV_VAULT_KEY, trimmed).then(() => emitStateChange());
  } else {
    window.__lazyJevKey = trimmed;
    try { localStorage.setItem(JEV_LOCALSTORAGE_KEY, trimmed); } catch { /* ignore */ }
  }
  emitStateChange();
}

export function deleteJevKey(): void {
  window.__lazyJevConfigured = false;
  window.__lazyJevKey = '';
  if (isJevRuntimeTauri()) {
    void deleteSecret(JEV_VAULT_KEY).then(() => emitStateChange());
  } else {
    try { localStorage.removeItem(JEV_LOCALSTORAGE_KEY); } catch { /* ignore */ }
  }
  emitStateChange();
}
