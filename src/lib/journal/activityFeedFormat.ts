/* activityFeedFormat.ts — humanizes ActivityFeedItem rows (journal_activity_feed
   rows) into short, human-readable ticker lines for FluxFooter (design §9).

   Pure, no I/O — payload_preview is a raw (and possibly TRUNCATED, since the
   Rust side caps it at 200 chars — see journal.rs's journal_activity_feed_inner)
   JSON string of the event's payload; every event_type in the journal
   vocabulary (eventTypes.ts) is handled with an honest fallback so a
   corrupt/truncated/unrecognized payload NEVER leaks raw `{`/JSON into the
   ticker — it just falls back to the humanized event type label (and mission
   id, when present).

   F3 fix (post-e2e fix wave): FluxFooter used to render `payload_preview`
   verbatim, e.g. `M9 {"mission":{"id":"M9","title":"QA pricing — tests
   unitaires","status":"running",...` — a raw, often mid-JSON-truncated dump.

   Sweep #7 / audit P07 fix — three real bugs, one honest boundary:

   1. TIMESTAMPS ARE NEVER RE-STAMPED HERE. `humanizeActivityItem` reads
      `item.ts_ms` — the journal's own, original write-time column — and
      nothing else; there is no `Date.now()` anywhere in this module. The
      "every boot shows 21:48 for every row" symptom users saw was NOT a
      render-time bug: it is agentsStore.tsx's debounce-save effect
      (`lastJournaledMissionsRef`, reset to an empty Map on every app boot)
      re-emitting a `mission.updated` for every mission still around from a
      previous session, stamped with the CURRENT `Date.now()` at boot,
      because that ref has no way to tell "already journaled in a previous
      session" from "never journaled at all". That is a real journal WRITE
      captured permanently in the events table — no amount of read-side
      formatting can undo it. Fixing it belongs in agentsStore.tsx (out of
      this module's ownership); flagged here so the next wave that owns that
      file has the exact root cause instead of re-diagnosing it from scratch.
   2. DEDUPE: `buildFeedEntries` collapses consecutive rows that render to
      the exact same line (see dedupeConsecutive below) — real double-emits
      (a flush retried, a boot re-journal of an unchanged mission across two
      close restarts) no longer show as a visual "loop" of repeated text.
   3. TRUNCATION RECOVERY: a Mission snapshot's payload almost always blows
      past the Rust preview's 200-char cap, so `JSON.parse` throws and the
      row used to collapse all the way down to a bare "mission" label (the
      "opaque fragment" complaint). `extractField` below does a best-effort
      regex pull of `status`/`title` straight out of the truncated JSON text
      — still honest (never guesses, returns undefined on no match) — so a
      truncated row can usually still show real status/title instead of the
      generic fallback.

   i18n: every label is looked up through the caller's own `t()` (the same
   function `useI18n()` returns), under `feed.eventType.<event_type>` keys —
   see i18n/locales/*.ts. This ticker is a first-class, always-visible
   product surface (not a technical audit view — contrast
   canvas/history/eventSummary.ts's deliberately-generic-not-i18n'd choice
   for RunHistoryDrawer's timeline, a different surface with a different
   tradeoff), so every event_type in eventTypes.ts's vocabulary is covered in
   all 6 locales, never left to leak a raw dotted type string except as the
   deliberate last-resort fallback for a truly unrecognized future type.
*/

import type { ActivityFeedItem } from './projections.js';
import { basename } from '../paths.js';

/** Matches useI18n()'s own `t` signature exactly — callers pass the real
 *  translate function through, this module never touches i18n/index.tsx
 *  directly (keeps this module pure/dependency-free, and testable with a
 *  trivial stub — see activityFeedFormat.test.ts). */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** On-boot cap: "show the last ~50 real events", not an ever-growing or
 *  synthetic replay burst. Also FluxFooter's query limit — see its
 *  doc comment. */
export const MAX_FEED_ENTRIES = 50;

function timeHHMM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Best-effort JSON.parse — payload_preview can be truncated by the Rust
 *  query's own 200-char preview cap, so a parse failure is expected and NOT
 *  an error: callers fall back to an honest label-only line, never raw
 *  text. */
function tryParsePayload(preview: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(preview);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Regex-based best-effort extraction of one string field from a possibly
 *  TRUNCATED JSON string — used only once `tryParsePayload` has already
 *  failed (or parsed something without the shape we need), so a mid-object
 *  cut like `{"mission":{"id":"M9","title":"QA pricing","status":"runni`
 *  can still surface the real `status`/`title` instead of collapsing to the
 *  bare event-type label. Returns undefined (never throws, never guesses)
 *  when the field never appeared before the cut. */
function extractField(raw: string, field: string): string | undefined {
  const match = raw.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

/** Same best-effort idea as extractField, for loop.tick/loop.iteration's
 *  iteration counter — checked against the parsed payload first (loop
 *  payloads are tiny, so parsing normally succeeds), then a raw-text regex
 *  as a last resort. loop.iteration's LoopIterationPayload only carries a
 *  free-text `summary` like "iteration 3 -> mission M28-child" (see
 *  loopScheduler.ts) — the number is pulled out of that string. */
function extractLoopIteration(payload: Record<string, unknown> | null, raw: string): number | undefined {
  if (payload) {
    if (typeof payload.iteration === 'number') return payload.iteration;
    if (typeof payload.summary === 'string') {
      const match = payload.summary.match(/iteration\s+(\d+)/i);
      if (match) return Number(match[1]);
    }
  }
  const rawMatch = raw.match(/"iteration"\s*:\s*(\d+)/) ?? raw.match(/iteration\s+(\d+)/i);
  return rawMatch ? Number(rawMatch[1]) : undefined;
}

/** Human label for one journal event_type, via the caller's `t()` — see
 *  i18n/locales/*.ts's `feed.eventType.*` keys (full eventTypes.ts
 *  vocabulary, all 6 locales). Falls back to the raw dotted `event_type`
 *  string itself (never JSON, never the composed lookup key) for a type
 *  this module genuinely doesn't know about yet — forward-compatible with a
 *  future event type landing before its i18n entries do. */
function eventTypeLabel(eventType: string, t: Translate): string {
  const key = `feed.eventType.${eventType}`;
  const translated = t(key);
  return translated === key ? eventType : translated;
}

/**
 * Renders one activity-feed row as a short human-readable ticker line —
 * `HH:MM <details>`, never raw JSON. `item.ts_ms` — the journal's own
 * original write-time column — is the ONLY time source used; this function
 * never calls Date.now() and never re-derives a timestamp (see this file's
 * header for the boot-restamp bug this guarantee closes on the read side).
 *
 * Recognized shapes, checked in order:
 *  - `mission.approved` fired by the auto-merge engine (payload `{actor:
 *    "auto"}`): `HH:MM M9 mergée automatiquement (auto)`.
 *  - A row carrying a full mission snapshot (`{"mission": {"id","title",
 *    "status",...}}` — mission.created/mission.updated's real shape):
 *    `HH:MM M9 · running · QA pricing — tests unitaires`.
 *  - A mission.created/mission.updated row whose snapshot got TRUNCATED
 *    (JSON.parse failed or came back without `.mission`): best-effort
 *    status/title recovery straight out of the raw preview text (see
 *    extractField) — still `HH:MM M9 · running · QA pricing…` whenever
 *    those fields survived the cut, never the bare fallback unless neither
 *    did.
 *  - A project.* row (`{"root": "..."}`): `HH:MM projet ouvert ·
 *    LazySite-internet` (basename of root, never the full path).
 *  - loop.tick/loop.iteration with a recoverable iteration number: `HH:MM
 *    Mission M28 — itération 3` instead of the opaque generic "itération
 *    loop" fragment.
 *
 * Every other event type — or anything that matched none of the above —
 * falls back to `HH:MM <mission_id ·> <humanized event type>`, still never
 * raw JSON.
 */
export function humanizeActivityItem(item: ActivityFeedItem, t: Translate): string {
  const time = timeHHMM(item.ts_ms);
  const payload = tryParsePayload(item.payload_preview);

  // W-MODES-ui safety legibility — a `mission.approved` fired by the
  // auto-merge engine (agentsStore.tsx's `triggerAutoMergeIfEligible`,
  // `MissionApprovedPayload.actor: 'auto'`, eventTypes.ts) must read
  // differently in the FLUX ticker than an ordinary human "Merger" click:
  // "mergée automatiquement (auto)" rather than the generic "approuvée"
  // fallback below — the whole point of a per-project approval mode is
  // that no one is surprised an unattended merge happened, and the ticker
  // is where that fact is most likely to be noticed in passing. Checked
  // BEFORE the generic mission-snapshot/fallback branches below since this
  // event's payload never carries a mission snapshot (only `{actor, mode}`
  // — see MissionApprovedPayload's own doc comment), so it would otherwise
  // fall through to the plain "approuvée" label with no auto/human
  // distinction at all.
  if (item.event_type === 'mission.approved' && payload?.actor === 'auto' && item.mission_id) {
    return `${time} ${t('feed.autoMerged', { missionId: item.mission_id })}`;
  }

  // P58 (automatic fleet hygiene) — a `fleet.hygiene` row never carries a
  // mission_id (a sweep is fleet-wide, see FleetHygienePayload's own doc
  // comment) and never a `.mission` snapshot, so it must be recognized here
  // BEFORE the generic branches below (same reasoning as mission.approved's
  // 'auto' case just above) — otherwise it would fall all the way through
  // to the bare event-type-label fallback with no counts shown at all,
  // which is exactly the "silent cleanup" this whole feature exists to
  // avoid. Falls back to the generic label (never raw JSON) only when the
  // payload is missing/malformed — honest degradation, not a crash.
  if (item.event_type === 'fleet.hygiene') {
    const archived = payload && typeof payload.archived === 'number' ? payload.archived : undefined;
    const purged = payload && typeof payload.purged === 'number' ? payload.purged : undefined;
    const deduped = payload && typeof payload.deduped === 'number' ? payload.deduped : undefined;
    // projectsClosed is read leniently (default 0, never required for this
    // branch to fire) — an OLDER journal row written before this field
    // existed must still render its archived/purged/deduped counts rather
    // than fall through to the bare label fallback.
    const projectsClosed = payload && typeof payload.projectsClosed === 'number' ? payload.projectsClosed : 0;
    if (archived !== undefined && purged !== undefined && deduped !== undefined) {
      return `${time} ${t('feed.fleetHygiene', { archived, purged, deduped, projectsClosed })}`;
    }
  }

  // 2026-07-22 memory-pressure incident — a `spawn.deferred` row never
  // carries a `.mission` snapshot (SpawnDeferredPayload is just
  // {reason, retryInMs}), so it must be recognized here BEFORE the generic
  // branches below, same reasoning as `fleet.hygiene` just above. Falls
  // back to the generic label (never raw JSON) only when the payload is
  // missing/malformed.
  if (item.event_type === 'spawn.deferred') {
    const retryInMs = payload && typeof payload.retryInMs === 'number' ? payload.retryInMs : undefined;
    if (retryInMs !== undefined) {
      return `${time} ${t('feed.spawnDeferred', { retrySeconds: Math.round(retryInMs / 1000) })}`;
    }
  }

  // IN-PLACE WEBVIEW RECOVERY — an `app.recovered` row never carries a
  // `.mission` snapshot or a mission_id (AppRecoveredPayload is just
  // {mode}, emitted directly from Rust — see eventTypes.ts's own doc
  // comment), so it must be recognized here BEFORE the generic branches
  // below, same reasoning as `fleet.hygiene`/`spawn.deferred` above. Two
  // distinct, honest lines rather than one generic label — a user who sees
  // "the app restarted" deserves to know that (heavier, sidecars/missions
  // interrupted) actually happened, not the same reassuring "display
  // restored" text the far more common in-place recovery uses. Falls back
  // to the generic label (never raw JSON) only when the payload is
  // missing/malformed.
  if (item.event_type === 'app.recovered') {
    const mode = payload && typeof payload.mode === 'string' ? payload.mode : undefined;
    if (mode === 'in_place') {
      return `${time} ${t('feed.appRecoveredInPlace')}`;
    }
    if (mode === 'restart') {
      return `${time} ${t('feed.appRecoveredRestart')}`;
    }
  }

  // P-SEARCH (visible web-search canvas surface) — an `agent.web_search` row
  // carries no `.mission` snapshot (WebSearchPayload is just {query,
  // resultCount}), so it must be recognized here BEFORE the generic
  // payload.mission branch below — otherwise it falls all the way through
  // to the bare event-type-label fallback with no query/count shown, hiding
  // exactly the "what did the agent search for" signal this ticker line
  // exists to surface. Falls back to the generic label (never raw JSON)
  // only when the payload is missing/malformed or mission_id is absent
  // (agent.web_search always carries one — see toolRuntime.ts's emit site
  // — but this stays honest rather than assuming).
  if (item.event_type === 'agent.web_search') {
    const query = payload && typeof payload.query === 'string' ? payload.query : undefined;
    const resultCount = payload && typeof payload.resultCount === 'number' ? payload.resultCount : undefined;
    if (query !== undefined && resultCount !== undefined && item.mission_id) {
      return `${time} ${t('feed.webSearch', { missionId: item.mission_id, query, resultCount })}`;
    }
  }

  if (payload && isRecord(payload.mission)) {
    const mission = payload.mission;
    const status = typeof mission.status === 'string' ? mission.status : undefined;
    const title = typeof mission.title === 'string' ? mission.title : undefined;
    const parts = [item.mission_id ?? undefined, status, title].filter(isNonEmptyString);
    if (parts.length > 0) return `${time} ${parts.join(' · ')}`;
  }

  // Truncation recovery — only for the two event types whose real payload
  // shape carries a mission snapshot (see MissionCreatedPayload/
  // MissionUpdatedPayload, eventTypes.ts). Reached only when the branch
  // above didn't already return, i.e. JSON.parse failed outright or parsed
  // something without a `.mission` object — both are exactly what a
  // mid-object truncation of a real snapshot looks like.
  if (item.event_type === 'mission.created' || item.event_type === 'mission.updated') {
    const status = extractField(item.payload_preview, 'status');
    const title = extractField(item.payload_preview, 'title');
    const parts = [item.mission_id ?? undefined, status, title].filter(isNonEmptyString);
    if (parts.length > 0) return `${time} ${parts.join(' · ')}`;
  }

  if (item.event_type.startsWith('project.')) {
    const root = payload && typeof payload.root === 'string' ? payload.root : undefined;
    const label = eventTypeLabel(item.event_type, t);
    return root ? `${time} ${label} · ${basename(root)}` : `${time} ${label}`;
  }

  if (item.event_type === 'loop.tick' || item.event_type === 'loop.iteration') {
    const iteration = extractLoopIteration(payload, item.payload_preview);
    if (iteration !== undefined && item.mission_id) {
      return `${time} ${t('feed.loopIteration', { missionId: item.mission_id, n: iteration })}`;
    }
  }

  const label = eventTypeLabel(item.event_type, t);
  return item.mission_id ? `${time} ${item.mission_id} · ${label}` : `${time} ${label}`;
}

/** Collapses consecutive rows that render to the exact same ticker line
 *  (real double-emits, or a boot re-journal of an unchanged mission across
 *  two close restarts) down to one — the "repeats identical entries in a
 *  loop" complaint. Deliberately consecutive-only: two genuinely identical
 *  lines separated by unrelated activity are each real, distinct history
 *  and both stay. */
function dedupeConsecutive(entries: readonly FeedEntry[]): FeedEntry[] {
  const result: FeedEntry[] = [];
  for (const entry of entries) {
    if (result.length > 0 && result[result.length - 1].text === entry.text) continue;
    result.push(entry);
  }
  return result;
}

/** One ticker row, ready to render — `missionId` lets FluxFooter wire a
 *  click straight to `canvas:focus` without re-parsing `text`. */
export interface FeedEntry {
  seq: number;
  text: string;
  missionId: string | null;
}

/**
 * Builds the ordered, deduped list of ticker entries from raw activity-feed
 * rows. Item order and timestamps are never touched — `humanizeActivityItem`
 * reads `item.ts_ms` verbatim (see this file's header) — this function only
 * caps the row count (`maxItems`, default MAX_FEED_ENTRIES — "the last ~50
 * real events", never a synthetic replay burst) and collapses consecutive
 * duplicate lines (dedupeConsecutive).
 */
export function buildFeedEntries(
  items: readonly ActivityFeedItem[],
  t: Translate,
  maxItems: number = MAX_FEED_ENTRIES,
): FeedEntry[] {
  const capped = items.slice(0, maxItems);
  const rendered = capped.map((item) => ({
    seq: item.seq,
    text: humanizeActivityItem(item, t),
    missionId: item.mission_id,
  }));
  return dedupeConsecutive(rendered);
}

/** Joins the deduped ticker entries into the footer's single line, never
 *  raw payload text, truncated to `maxChars` with an ellipsis. */
export function buildActivityTicker(items: readonly ActivityFeedItem[], maxChars: number, t: Translate): string {
  const line = buildFeedEntries(items, t)
    .map((entry) => entry.text)
    .join(' · ');
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}
