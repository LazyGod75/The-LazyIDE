/* githubOAuth.ts — GitHub OAuth device flow wrapper (design §10).

   The heavy lifting (HTTP + token storage) happens in Rust commands:
     github_oauth_device_code(clientId)     → { deviceCode, userCode, ... }
     github_oauth_poll_token(clientId, code) → { accessToken | error }
     github_api_get/post(url, token, body)  → narrow api.github.com proxy
     teams_github_token_write/read/clear    → app-data-dir token store

   This module owns the state machine a React component consumes:
     idle → waiting-device (shows userCode + verificationUri) →
     polling (auto-retries at GitHub's interval) → connected → disconnected.
   Also provides `fetchGitHubIdentity` + `provisionOneBrainRepo` (create the
   single private brain repo under the connected account).

   The Client ID is public (embedding it in the app is fine for the device
   flow — GitHub's device flow token exchange does not require a secret).
*/

import { invoke } from '@tauri-apps/api/core';

export const GITHUB_OAUTH_CLIENT_ID = '<github-oauth-client-id>';

// ── Rust result shapes (mirror github_oauth.rs) ─────────────────────

export interface DeviceCodeResult {
  ok: boolean;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  interval?: number;
  expiresIn?: number;
  error?: string;
}

export interface TokenPollResult {
  ok: boolean;
  accessToken?: string;
  tokenType?: string;
  scope?: string;
  error?: string;
  errorDescription?: string;
}

export interface GitHubApiResult {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
}

export interface GitHubTokenStore {
  token: string;
  login: string;
  name?: string;
  email?: string;
  updatedAt: number;
}

// ── Rust bridge ─────────────────────────────────────────────────────

export function requestDeviceCode(clientId: string = GITHUB_OAUTH_CLIENT_ID): Promise<DeviceCodeResult> {
  return invoke<DeviceCodeResult>('github_oauth_device_code', { clientId });
}

export function pollAccessToken(
  clientId: string,
  deviceCode: string,
): Promise<TokenPollResult> {
  return invoke<TokenPollResult>('github_oauth_poll_token', { clientId, deviceCode });
}

export function githubApiGet(url: string, token: string): Promise<GitHubApiResult> {
  return invoke<GitHubApiResult>('github_api_get', { url, token });
}

export function githubApiPost(url: string, token: string, body: unknown): Promise<GitHubApiResult> {
  return invoke<GitHubApiResult>('github_api_post', {
    url,
    token,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function writeGitHubToken(store: GitHubTokenStore): Promise<void> {
  return invoke<void>('teams_github_token_write', { payload: store });
}

export function readGitHubToken(): Promise<GitHubTokenStore | null> {
  return invoke<GitHubTokenStore | null>('teams_github_token_read');
}

export function clearGitHubToken(): Promise<void> {
  return invoke<void>('teams_github_token_clear');
}

// ── Identity + org listing ───────────────────────────────────────────

export interface GitHubUser {
  login: string;
  name?: string;
  email?: string;
  html_url: string;
}

export interface GitHubOrg {
  login: string;
}

/** Fetch the connected GitHub user (requires the OAuth token). */
export async function fetchGitHubUser(token: string): Promise<GitHubUser | null> {
  const res = await githubApiGet('https://api.github.com/user', token);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.body) as GitHubUser;
  } catch {
    return null;
  }
}

/** List the orgs the connected user belongs to (for repo provisioning). */
export async function fetchGitHubOrgs(token: string): Promise<GitHubOrg[]> {
  const res = await githubApiGet('https://api.github.com/user/orgs?per_page=100', token);
  if (!res.ok) return [];
  try {
    const arr = JSON.parse(res.body) as GitHubOrg[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ── Repo provisioning ───────────────────────────────────────────────

export interface ProvisionedRepo {
  name: string;
  cloneUrl: string;
  htmlUrl: string;
}

export interface ProvisionOneRepoOptions {
  token: string;
  owner: string;
  ownerIsOrg: boolean;
  name: string;
}

/**
 * Create a single private brain repo on GitHub under the connected owner.
 * Skips if it already exists (GitHub 422 → success).
 */
export async function provisionOneRepo(opts: ProvisionOneRepoOptions): Promise<ProvisionedRepo> {
  const { token, owner, ownerIsOrg, name } = opts;
  const baseUrl = ownerIsOrg
    ? `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos`
    : 'https://api.github.com/user/repos';
  const res = await githubApiPost(baseUrl, token, {
    name,
    private: true,
    description: 'LazyBrain team brain (auto-provisioned by Lazy)',
    auto_init: false,
  });
  if (res.ok) {
    try {
      const parsed = JSON.parse(res.body) as { clone_url?: string; html_url?: string; name?: string };
      return {
        name: parsed.name ?? name,
        cloneUrl: parsed.clone_url ?? `https://github.com/${owner}/${name}.git`,
        htmlUrl: parsed.html_url ?? `https://github.com/${owner}/${name}`,
      };
    } catch {
      return {
        name,
        cloneUrl: `https://github.com/${owner}/${name}.git`,
        htmlUrl: `https://github.com/${owner}/${name}`,
      };
    }
  }
  if (res.status === 422) {
    return {
      name,
      cloneUrl: `https://github.com/${owner}/${name}.git`,
      htmlUrl: `https://github.com/${owner}/${name}`,
    };
  }
  throw new Error(res.error ?? `GitHub create ${name} failed (${res.status})`);
}
