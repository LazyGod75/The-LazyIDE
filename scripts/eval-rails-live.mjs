#!/usr/bin/env node
/**
 * C86 — live rails eval runner.
 *
 * Exact command:
 *   LIVE=1 node scripts/eval-rails-live.mjs
 *
 * Windows PowerShell:
 *   $env:LIVE=1; node scripts/eval-rails-live.mjs
 *
 * Optional keys (never required for the structure check):
 *   ANTHROPIC_API_KEY  → BYOK Anthropic probe
 *   DEEPSEEK_API_KEY   → BYOK DeepSeek OpenAI-compatible probe (historical C86)
 *   VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY → Pro / free proxy presence
 *   OPENROUTER_API_KEY / LAZY_OPENROUTER_KEY → free catalog presence
 *   LIVE_CLI=1 or CLAUDE_CLI_PATH → CLI rail presence
 *
 * On Windows, if DEEPSEEK_API_KEY is absent, attempts a silent inject from the
 * OS vault entry `apikey.deepseek` (com.lazy.app) without printing the value.
 *
 * Loads .env / .env.local key NAMES only via dotenv-style parse if present;
 * does not print secret values.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(resolve(root, '.env'));
loadEnvFile(resolve(root, '.env.local'));

process.env.LIVE = process.env.LIVE || '1';

/**
 * Windows: inject DEEPSEEK_API_KEY from Credential Manager if missing.
 * Never logs the secret — only whether inject succeeded.
 * Secret travels only via spawn stdout → process.env (no temp file).
 */
function tryInjectDeepseekFromVault() {
  const already = (process.env.DEEPSEEK_API_KEY || '').trim();
  if (already) return { injected: false, reason: 'env-already-set' };
  if (process.platform !== 'win32') return { injected: false, reason: 'not-windows' };

  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CredReadDs {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr ptr; if (!CredRead(target, 1, 0, out ptr)) return null;
    try {
      var cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      if (cred.CredentialBlob == IntPtr.Zero || cred.CredentialBlobSize == 0) return "";
      return Marshal.PtrToStringUni(cred.CredentialBlob, (int)cred.CredentialBlobSize / 2);
    } finally { CredFree(ptr); }
  }
}
"@
$val = [CredReadDs]::Read('apikey.deepseek.com.lazy.app')
if ([string]::IsNullOrWhiteSpace($val)) { exit 2 }
[Console]::Out.Write($val)
`;
  try {
    const probe = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', windowsHide: true },
    );
    if (probe.status === 2) return { injected: false, reason: 'vault-absent' };
    if (probe.status !== 0) return { injected: false, reason: 'vault-read-failed' };
    const raw = String(probe.stdout || '').trim();
    if (!raw) return { injected: false, reason: 'vault-empty' };
    process.env.DEEPSEEK_API_KEY = raw;
    return { injected: true, reason: 'vault-apikey.deepseek' };
  } catch {
    return { injected: false, reason: 'vault-exception' };
  }
}

const vaultInject = tryInjectDeepseekFromVault();

const keysPresent = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_KEY',
  'DEEPSEEK_API_KEY',
  'LAZY_DEEPSEEK_KEY',
  'OPENROUTER_API_KEY',
  'LAZY_OPENROUTER_KEY',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'CLAUDE_CLI_PATH',
  'LIVE_CLI',
].filter((k) => {
  const v = process.env[k];
  return typeof v === 'string' && v.trim().length > 0;
});

console.log(JSON.stringify({
  cmd: 'LIVE=1 npx vitest run src/__tests__/railsEval.live.eval.test.ts',
  keysPresent,
  vaultInject: { injected: vaultInject.injected, reason: vaultInject.reason },
  note: 'values redacted — only names listed',
}));

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'src/__tests__/railsEval.live.eval.test.ts'],
  { cwd: root, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' },
);

process.exit(result.status ?? 1);
