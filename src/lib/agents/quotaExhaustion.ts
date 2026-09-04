/* quotaExhaustion.ts — detects the Claude CLI's own subscription/session
   quota-exhaustion condition inside a mission's captured agent text, and
   distinguishes it from an ordinary task/agent failure.

   Real incident (overnight run, 2026-08-19): seven writer missions (M68-M74)
   each failed with the CLI's own line, verbatim, in the journal's
   `mission.step` events —

     "You've hit your session limit · resets 12:30am (Europe/Paris)"

   — but the app classified every one as an ordinary mission failure,
   RETRIED anyway (M72 alone relaunched four times in twelve minutes, each
   hitting the exact same wall), and told the user only "Mission failed
   after retry — see agent logs", discarding both the real cause and the
   reset time it had already captured.

   This module gives that condition its own identity so recovery.ts can stop
   retrying it and runtime.ts can report it honestly, with the reset time
   when the CLI provided one.
*/

/**
 * The CLI's own first-person phrasing for "you are out of usage for this
 * billing/session window" — deliberately narrow. Requires the exact
 * "you've hit your ... limit" construction the CLI emits, not a bare
 * keyword match on "session limit"/"rate limit"/"quota". A task whose OWN
 * text merely discusses session limits (e.g. "implement session limit
 * handling for the API") never reproduces this first-person construction,
 * so it can never false-positive here — see quotaExhaustion.test.ts.
 * Handles both the straight (') and curly (’) apostrophe and the
 * "you have" spelled-out variant some CLI builds emit.
 */
const QUOTA_EXHAUSTION_PATTERN =
  /you(?:'ve|’ve| have) hit your (?:session|usage|weekly|five[- ]hour|5[- ]hour) limit/i;

/**
 * Captures "resets <time>[am|pm] (<timezone>)" immediately after the
 * exhaustion phrase — the CLI's own format, e.g.
 * "resets 12:30am (Europe/Paris)". The timezone group is optional (some
 * CLI builds/locales omit it) and so is the am/pm marker.
 */
const RESET_TIME_PATTERN = /resets?\s+(\d{1,2}:\d{2}\s*(?:am|pm)?)(?:\s*\(([^)]+)\))?/i;

export interface QuotaExhaustionInfo {
  /** Raw "resets ..." fragment, verbatim from the source text, e.g.
   *  "12:30am (Europe/Paris)" or just "12:30am" when no timezone was
   *  reported. Undefined when the message carried no reset time at all. */
  resetLabel?: string;
  /**
   * Best-effort absolute epoch ms for the parsed reset time — the NEXT
   * upcoming occurrence of that wall-clock time in the reported timezone
   * (or the local system timezone when none was reported). Undefined when
   * resetLabel is undefined, OR when the clock/timezone could not be
   * resolved (an unrecognized IANA zone name) — NEVER a guessed fallback
   * value; callers must treat "undefined" as "no known boundary", not "now".
   */
  resetAtMs?: number;
}

/** Standard "zoned wall-clock time -> UTC instant" conversion: guesses a UTC
 *  instant for (hour:minute) on `timeZone`'s CURRENT calendar date, then
 *  corrects for that zone's real offset by re-reading the guess back through
 *  the same zone and comparing. Returns undefined if `timeZone` is not a
 *  recognized IANA name (Intl throws) rather than silently misreporting a
 *  wrong instant. `timeZone` undefined is valid — Intl then uses the host's
 *  own local timezone, a reasonable reading of a reset line the CLI printed
 *  with no explicit zone at all. */
function zonedWallTimeToUtcMs(hour: number, minute: number, timeZone: string | undefined, nowMs: number): number | undefined {
  try {
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(nowMs))
      .reduce<Record<string, string>>((acc, p) => {
        acc[p.type] = p.value;
        return acc;
      }, {});
    const y = Number(dateParts.year);
    const mo = Number(dateParts.month);
    const d = Number(dateParts.day);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return undefined;

    const utcGuess = Date.UTC(y, mo - 1, d, hour, minute);

    const offsetParts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcGuess))
      .reduce<Record<string, string>>((acc, p) => {
        acc[p.type] = p.value;
        return acc;
      }, {});
    // Intl can format midnight as "24" for hour12:false in some engines.
    const readHour = offsetParts.hour === '24' ? 0 : Number(offsetParts.hour);
    const readAsUtc = Date.UTC(
      Number(offsetParts.year),
      Number(offsetParts.month) - 1,
      Number(offsetParts.day),
      readHour,
      Number(offsetParts.minute),
      Number(offsetParts.second),
    );
    const offsetMs = readAsUtc - utcGuess;
    let resetAtMs = utcGuess - offsetMs;

    // The reset time already passed today (in that zone) — the next real
    // occurrence is the same wall-clock time tomorrow (this also correctly
    // handles the common overnight case: e.g. it is 23:07 and the CLI
    // reports "resets 00:30" — 00:30 TODAY's date is in the past relative
    // to 23:07, so this rolls forward to 00:30 the very next day, ~83
    // minutes away, not a whole extra day out).
    if (resetAtMs <= nowMs) resetAtMs += 24 * 60 * 60 * 1000;
    return resetAtMs;
  } catch {
    return undefined;
  }
}

function parseResetTimeLabel(timeLabel: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(timeLabel.trim());
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return undefined;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  return { hour, minute };
}

/**
 * True/populated only when `text` contains the CLI's own subscription/
 * session quota-exhaustion phrasing (see QUOTA_EXHAUSTION_PATTERN) —
 * returns null for everything else, including ordinary failures and text
 * that merely discusses rate/session limits without the CLI's exact
 * first-person construction. `nowMs` is injectable for deterministic tests;
 * defaults to the real clock.
 */
export function detectQuotaExhaustion(text: string, nowMs: number = Date.now()): QuotaExhaustionInfo | null {
  if (!QUOTA_EXHAUSTION_PATTERN.test(text)) return null;

  const resetMatch = RESET_TIME_PATTERN.exec(text);
  if (!resetMatch) return {};

  const rawTime = resetMatch[1].trim();
  const rawTz = resetMatch[2]?.trim();
  const resetLabel = rawTz ? `${rawTime} (${rawTz})` : rawTime;

  const parsedTime = parseResetTimeLabel(rawTime);
  const resetAtMs = parsedTime
    ? zonedWallTimeToUtcMs(parsedTime.hour, parsedTime.minute, rawTz, nowMs)
    : undefined;

  return { resetLabel, resetAtMs };
}

/**
 * Honest, human-readable statusReason/timeline text for a detected quota
 * exhaustion — follows this codebase's "never a fabricated success/cause"
 * convention (see agentsStore.tsx's open_project/create_project catches):
 * the real cause AND the real reset time (when known) are surfaced verbatim
 * instead of a generic "see agent logs" pointer.
 */
export function formatQuotaExhaustionReason(info: QuotaExhaustionInfo): string {
  if (info.resetLabel) {
    return `subscription quota exhausted — retry possible from ${info.resetLabel}`;
  }
  return 'subscription quota exhausted — no reset time reported by the CLI; retry manually once your subscription quota has replenished';
}
