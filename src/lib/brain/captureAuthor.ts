/* captureAuthor.ts — "qui a écrit quoi et quand" for every brain capture.

   The author (signed-in Supabase user's display name / email local part) is
   stamped onto CaptureEvents so the resulting neurons carry
   data-cerveau-author on the article + each fact paragraph. Populated
   automatically when the event doesn't already carry one.

   Single choke point used by:
     - src/lib/brain/capture.ts's dispatch() (IDE captures),
     - src/lib/platform/tauri.ts + web.ts's brain.capture() (agent/manager
       and every other capture path) — so no capture can bypass attribution.
*/

import type { CaptureEvent } from '../platform/types.js';

let _cachedAuthor: string | null | undefined;
let _cachedAuthorId: string | null | undefined;
let _cachedDept: string | null | undefined;

/** Resolve the current user's display name (cached after first fetch). */
export async function resolveCaptureAuthor(): Promise<string | undefined> {
  if (_cachedAuthor !== undefined) return _cachedAuthor ?? undefined;
  await populateCaptureCache();
  return _cachedAuthor ?? undefined;
}

/** Resolve the current user's Supabase UUID (cached after first fetch). */
export async function resolveCaptureAuthorId(): Promise<string | undefined> {
  if (_cachedAuthorId !== undefined) return _cachedAuthorId ?? undefined;
  await populateCaptureCache();
  return _cachedAuthorId ?? undefined;
}

/** Resolve both author display name, author id, and department slug. */
export async function resolveCaptureIdentity(): Promise<{
  author?: string;
  authorId?: string;
  dept?: string;
}> {
  if (_cachedAuthor === undefined || _cachedAuthorId === undefined || _cachedDept === undefined) {
    await populateCaptureCache();
  }
  return {
    author: _cachedAuthor ?? undefined,
    authorId: _cachedAuthorId ?? undefined,
    dept: _cachedDept ?? undefined,
  };
}

/** Reset caches to "not yet fetched" (undefined). Called on sign-out. */
export function invalidateCaptureAuthor(): void {
  _cachedAuthor = undefined;
  _cachedAuthorId = undefined;
  _cachedDept = undefined;
}

async function populateCaptureCache(): Promise<void> {
  _cachedAuthor = null;
  _cachedAuthorId = null;
  _cachedDept = null;
  try {
    const { supabase } = await import('../supabase/client.js');
    const { data } = await supabase.auth.getUser();
    const email = data?.user?.email;
    const name = data?.user?.user_metadata?.['display_name'] as string | undefined;
    const userId = data?.user?.id;
    _cachedAuthor = name || (email && email.includes('@') ? email.split('@')[0] : '') || null;
    _cachedAuthorId = userId || null;
    if (userId) {
      _cachedDept = await resolveDeptSlug(
        supabase as unknown as { from: (table: string) => DeptQuery },
        userId,
      );
    }
  } catch {
    _cachedAuthor = null;
    _cachedAuthorId = null;
    _cachedDept = null;
  }
}

async function resolveDeptSlug(
  supabase: { from: (table: string) => DeptQuery },
  userId: string,
): Promise<string | null> {
  try {
    const { data: memberRows, error } = await supabase
      .from('org_members')
      .select('dept_id')
      .eq('user_id', userId)
      .limit(1);
    if (error || !memberRows?.[0]?.dept_id) return null;
    const deptId = memberRows[0].dept_id as string;
    const { data: deptRows } = await supabase
      .from('departments')
      .select('slug')
      .eq('id', deptId)
      .limit(1);
    const slug = deptRows?.[0]?.slug as string | undefined;
    return slug || deptId;
  } catch {
    return null;
  }
}

interface DeptQuery {
  select: (cols: string) => DeptQuery;
  eq: (col: string, value: string) => DeptQuery;
  limit: (n: number) => Promise<{
    data: Array<Record<string, string | null>> | null;
    error: unknown;
  }>;
}

/** Stamp `author` (and optionally `authorId`) onto the event unless it
 *  already has one (or no author is provided). */
export function withCaptureAuthor(
  event: CaptureEvent,
  author: string | undefined,
  authorId?: string,
): CaptureEvent {
  if (!author) return event;
  if (authorId && !event.authorId) {
    return { ...event, author: event.author ?? author, authorId };
  }
  if (!event.author) {
    return { ...event, author };
  }
  return event;
}

/** Enrich a capture event with the current user's identity (fire-and-forget
 *  safe: resolves the cached identity, returns the event unchanged on error). */
export async function enrichCaptureAuthor(event: CaptureEvent): Promise<CaptureEvent> {
  const { author, authorId, dept } = await resolveCaptureIdentity();
  let stamped = withCaptureAuthor(event, author, authorId);
  if (dept && !stamped.dept) {
    stamped = { ...stamped, dept };
  }
  return stamped;
}
