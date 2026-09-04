/* env-mock.ts — stub for src/lib/env.ts used in screenshot harness.
   Prevents the "missing env vars" throw when Vite alias intercepts the import. */

export const supabaseUrl = 'https://mock.supabase.co';
export const supabaseAnonKey = 'mock-anon-key';

export function getAiProxyUrl(): string {
  return 'https://mock.supabase.co/functions/v1/ai-proxy';
}
