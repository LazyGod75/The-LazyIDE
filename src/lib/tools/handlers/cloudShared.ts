/* cloudShared.ts — helpers shared by the cloud_* tool handlers
   (cloudBrowser.ts, cloudDesktop.ts, cloudSandbox.ts).

   Every cloud tool is keyed by ctx.missionId and reports its activity on the
   event bus so the canvas can show a live view. Error mapping goes through
   solariClient.mapSolariError so the observation string is always actionable.
*/

import type { ToolExecutionContext } from './types.js';
import { mapSolariError } from '../../solari/solariClient.js';
import { emit } from '../../bus.js';

/** Observation returned by every cloud_* tool when ctx.missionId is absent. */
export const MISSION_REQUIRED = 'ERROR: cloud_* tools require a mission context';

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function numberArg(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

export function truncate(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) : text;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function errorMessage(toolName: string, err: unknown): string {
  return `ERROR: ${toolName} failed: ${mapSolariError(err).userMessage}`;
}

/** Emit the canvas visual-activity event for a cloud tool call. No-op when the
 *  call has no mission context (assistant chat / LazyManager). */
export function emitActivity(
  ctx: ToolExecutionContext,
  toolName: string,
  label: string,
  detail?: string,
): void {
  if (!ctx.missionId) return;
  emit('canvas:toolActivity', {
    missionId: ctx.missionId,
    toolName,
    label,
    icon: 'browser',
    detail,
  });
}

/** Convert binary image bytes to a `data:` URL, chunked to avoid a stack
 *  overflow on large screenshots. Works in both browser and Node. */
export function bytesToDataUrl(bytes: Uint8Array, mime = 'image/png'): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
