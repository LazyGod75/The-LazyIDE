/* Provider fallback — combo routing with automatic retry.
   When a provider fails (rate limit, quota, network), the fallback chain
   slides to the next model/provider transparently. */

import type { ModelProvider, StreamChatRequest, StreamEvent } from '../models/types.js';
import { textEventsFromStrings } from '../models/streamEvents.js';

export interface FallbackConfig {
  /** Ordered list of providers to try. The first that succeeds wins. */
  providers: ModelProvider[];
  /** HTTP status codes that should trigger a fallback (default: 429, 502, 503). */
  fallbackStatusCodes?: number[];
  /** Max retries across all providers before giving up (default: 3). */
  maxRetries?: number;
  /** Whether to yield a notice to the user when falling back (default: true). */
  yieldFallbackNotice?: boolean;
}

const DEFAULT_FALLBACK_STATUS_CODES = [429, 502, 503];
const DEFAULT_MAX_RETRIES = 3;

/**
 * Wrap a list of providers into a single provider that tries each in order
 * until one succeeds. If a provider throws or yields an empty stream, the
 * next provider is tried. Combo routing concept, simplified for Lazy's
 * provider model.
 */
export function withFallback(config: FallbackConfig): ModelProvider {
  const {
    providers,
    fallbackStatusCodes = DEFAULT_FALLBACK_STATUS_CODES,
    maxRetries = DEFAULT_MAX_RETRIES,
    yieldFallbackNotice = true,
  } = config;

  if (providers.length === 0) {
    throw new Error('withFallback requires at least one provider');
  }

  const primary = providers[0];

  async function* tryStreamChat(
    req: StreamChatRequest,
  ): AsyncIterable<string> {
    let lastError: unknown = null;
    let attempts = 0;

    for (const provider of providers) {
      if (attempts >= maxRetries) break;
      attempts++;

      try {
        let yielded = false;
        for await (const chunk of provider.streamChat(req)) {
          yielded = true;
          yield chunk;
        }
        if (yielded) return; // Success — stop the fallback chain
        // Empty stream — try next provider
      } catch (err) {
        lastError = err;
        // Check if the error is recoverable (should trigger fallback)
        const recoverable = isRecoverableError(err, fallbackStatusCodes);
        if (!recoverable) throw err;
        // Continue to next provider
      }
    }

    // All providers exhausted — rethrow the last error or yield nothing
    if (lastError) throw lastError;
  }

  async function* tryStreamChatEvents(
    req: StreamChatRequest,
  ): AsyncIterable<StreamEvent> {
    let lastError: unknown = null;
    let attempts = 0;

    for (const provider of providers) {
      if (attempts >= maxRetries) break;
      attempts++;

      try {
        if (provider.streamChatEvents) {
          let yielded = false;
          for await (const event of provider.streamChatEvents(req)) {
            yielded = true;
            yield event;
          }
          if (yielded) return;
        } else {
          // Provider doesn't support structured events — bridge from strings
          let yielded = false;
          for await (const event of textEventsFromStrings(provider.streamChat(req))) {
            yielded = true;
            yield event;
          }
          if (yielded) return;
        }
      } catch (err) {
        lastError = err;
        const recoverable = isRecoverableError(err, fallbackStatusCodes);
        if (!recoverable) throw err;
        if (yieldFallbackNotice) {
          yield {
            type: 'text',
            id: 'fallback-notice',
            text: `\n\n_(bascule vers ${providers[providers.indexOf(provider) + 1]?.label ?? 'secours'}…)_\n\n`,
          };
        }
      }
    }

    if (lastError) throw lastError;
  }

  return {
    id: 'fallback',
    label: primary.label,
    listModels: () => primary.listModels(),
    streamChat: tryStreamChat,
    streamChatEvents: tryStreamChatEvents,
  };
}

/**
 * Check whether an error should trigger a fallback to the next provider.
 * Recoverable: rate limits (429), bad gateway (502), service unavailable (503),
 * network errors, or ManagedUnavailableError with specific codes.
 */
function isRecoverableError(err: unknown, fallbackStatusCodes: number[]): boolean {
  // Check for status property on error objects
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const status = e.status ?? e.statusCode ?? e.code;
    if (typeof status === 'number' && fallbackStatusCodes.includes(status)) {
      return true;
    }
    // ManagedUnavailableError with managed_unavailable or no_credits code
    if (typeof e.code === 'string') {
      if (e.code === 'managed_unavailable' || e.code === 'no_credits') {
        return true;
      }
    }
    // Network errors (TypeError: Failed to fetch)
    if (err instanceof TypeError && err.message.includes('fetch')) {
      return true;
    }
  }
  return false;
}
