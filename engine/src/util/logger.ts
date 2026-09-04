import { createRequire } from 'node:module';
import pino from 'pino';
import { getConfig } from './config.js';

let cached: pino.Logger | null = null;

/**
 * Resolve whether pino-pretty is available in the current environment.
 *
 * Uses createRequire (sync, no dynamic import needed) so the check is
 * synchronous and the logger can be constructed eagerly.  Returns false on
 * any resolution failure — callers fall back to plain stderr JSON logging.
 */
function isPinoPrettyAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

export function getLogger(): pino.Logger {
  if (cached) return cached;
  const cfg = getConfig();
  const usePretty = process.stderr.isTTY && cfg.logLevel === 'debug' && isPinoPrettyAvailable();
  cached = pino({
    level: cfg.logLevel,
    base: { app: 'lazybrain' },
    transport: usePretty ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  });
  return cached;
}

export function resetLoggerForTests(): void {
  cached = null;
}
