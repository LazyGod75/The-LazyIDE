import type { IncomingMessage, ServerResponse } from 'node:http';

/** Shared type for an HTTP route handler. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => void | Promise<void>;
