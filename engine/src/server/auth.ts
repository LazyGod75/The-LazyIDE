import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Check Bearer-token authentication.
 * If a token is required and the request does not carry it,
 * writes 401 and returns false. Returns true when auth passes.
 */
export function checkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
): boolean {
  if (!token) return true;
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Unauthorized');
    return false;
  }
  return true;
}
