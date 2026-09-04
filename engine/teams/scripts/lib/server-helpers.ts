/**
 * Shared HTTP helpers for seed and test scripts.
 * Cookie-jar pattern mirrors tests/e2e-flow.test.ts.
 */

export interface CookieJar {
  readonly cookie: string;
  readonly csrfToken: string;
}

export interface FetchResult {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string>;
}

export async function httpGet(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<FetchResult> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'GET', headers, redirect: 'manual' });
  const body = await res.text();
  const hdrs: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    hdrs[k] = v;
  });
  return { status: res.status, body, headers: hdrs };
}

export async function httpPost(
  baseUrl: string,
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<FetchResult> {
  const params = new URLSearchParams(fields).toString();
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: params,
    redirect: 'manual',
  });
  const body = await res.text();
  const hdrs: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    hdrs[k] = v;
  });
  return { status: res.status, body, headers: hdrs };
}

export function extractCookie(headers: Record<string, string>, name: string): string | undefined {
  const raw = headers['set-cookie'] ?? '';
  const match = raw.match(new RegExp(`${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

export function extractCsrf(html: string): string {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? '';
}

export async function loginAs(
  baseUrl: string,
  username: string,
  password: string,
): Promise<CookieJar> {
  const loginRes = await httpPost(baseUrl, '/login', { username, password });
  const rawCookie = extractCookie(loginRes.headers, 'lbt_session');
  if (!rawCookie) {
    throw new Error(`Login failed for ${username} — no session cookie. Status: ${loginRes.status}`);
  }

  const cookieStr = `lbt_session=${rawCookie}`;
  const me = await httpGet(baseUrl, '/me', { Cookie: cookieStr });
  const csrfToken = extractCsrf(me.body);
  if (!csrfToken) {
    const adminNew = await httpGet(baseUrl, '/admin/teams/new', { Cookie: cookieStr });
    const fallbackCsrf = extractCsrf(adminNew.body);
    if (!fallbackCsrf) {
      const teamPage = await httpGet(baseUrl, '/t/platform', { Cookie: cookieStr });
      const teamCsrf = extractCsrf(teamPage.body);
      if (!teamCsrf) {
        throw new Error(`Could not extract CSRF token for ${username}`);
      }
      return { cookie: cookieStr, csrfToken: teamCsrf };
    }
    return { cookie: cookieStr, csrfToken: fallbackCsrf };
  }
  return { cookie: cookieStr, csrfToken };
}

export function jarHeaders(jar: CookieJar): Record<string, string> {
  return { Cookie: jar.cookie };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
