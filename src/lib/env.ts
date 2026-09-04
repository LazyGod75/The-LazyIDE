/**
 * Client-side environment. Cloud (Supabase) is pre-configured with Lazy's
 * public Cloud endpoint (see cloudConfig.ts). Forks can
 * override via VITE_SUPABASE_* env vars, or set them empty for pure OSS.
 */

import { LAZY_CLOUD_CONFIG } from './cloudConfig.js';
import { isCloudConfigured } from './envCloud.js';

/** Supabase URL — defaults to Lazy Cloud, overridable via env for forks. */
export const supabaseUrl = (
  String(import.meta.env.VITE_SUPABASE_URL ?? '') || LAZY_CLOUD_CONFIG.supabaseUrl
).trim();

/** Supabase anon key — defaults to Lazy Cloud, overridable via env for forks. */
export const supabaseAnonKey = (
  String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '') || LAZY_CLOUD_CONFIG.supabaseAnonKey
).trim();

const VITE_AI_PROXY_URL = import.meta.env.VITE_AI_PROXY_URL as string | undefined;

export { isCloudConfigured };

export function getAiProxyUrl(): string {
  if (VITE_AI_PROXY_URL) {
    return VITE_AI_PROXY_URL;
  }
  if (!supabaseUrl) {
    return '';
  }
  return `${supabaseUrl}/functions/v1/ai-proxy`;
}
