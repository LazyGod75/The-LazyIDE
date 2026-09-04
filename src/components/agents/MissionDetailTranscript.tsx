/* MissionDetailTranscript — action timeline + step-by-step replay for MissionDetail.
   Extracted from MissionDetail.tsx (file-size split, behavior identical) —
   self-contained like MissionDetailRight/MissionDetailJudge: owns its own
   "should I render" check and section title, the parent just places it. */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Mission, ActionEvent } from '../../lib/agents/types';
import { useI18n } from '../../i18n';

const REPLAY_STEP_DELAY_MS = 350;

interface MissionDetailTranscriptProps {
  mission: Mission;
}

// ── Timeline entry parsing (DISPLAY ONLY — never changes event.text itself,
//    only how it's rendered) ─────────────────────────────────────────
//
// The managed-agent loop (managedAgent.ts) writes two raw entries per ReAct
// step: `[3] read_file: {"path":"src/foo.ts"}` (the action) immediately
// followed by `Observation: <tool output, already capped upstream>` (the
// result). Rendered verbatim, this is exactly the kind of raw
// directive+JSON dump a reader has to parse by eye instead of reading. Both
// lines are recognized here and re-presented with a readable tool name +
// a compact args summary / a visually subordinate "result of the action
// above" line — everything else (French status sentences, [eval]/[tests]/
// [note locale] tags, etc.) is already human-readable and renders exactly
// as before via the 'plain' fallback.

const ACTION_LINE_RE = /^\[(\d+)\]\s+([A-Za-z][\w.]*)\s*:\s*(\{[\s\S]*\})\s*$/;
const OBSERVATION_PREFIX_RE = /^Observation:\s*/;
const MAX_ARGS_SUMMARY_LENGTH = 90;

type ParsedTimelineEntry =
  | { kind: 'action'; step: string; toolLabel: string; argsSummary: string }
  | { kind: 'observation'; text: string }
  | { kind: 'plain'; text: string };

/** "read_file" -> "Read file", "run_command" -> "Run command". A plain
 *  snake_case -> sentence-case transform reads correctly for every tool in
 *  the registry (present and future) without needing an exhaustive map. */
function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, ' ').trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "key: value, key2: value2" summary of a tool call's JSON args, truncated
 *  so a large payload (e.g. a multi_edit list) never breaks the row's
 *  layout. Returns '' when args is `{}` or isn't valid/object JSON — the
 *  caller falls back to the raw line in the latter case so no data is ever
 *  silently hidden. */
function summarizeArgs(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return '';
    const summary = entries
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(', ');
    return summary.length > MAX_ARGS_SUMMARY_LENGTH
      ? `${summary.slice(0, MAX_ARGS_SUMMARY_LENGTH)}…`
      : summary;
  } catch {
    return '';
  }
}

export function parseTimelineEntry(text: string): ParsedTimelineEntry {
  const actionMatch = ACTION_LINE_RE.exec(text);
  if (actionMatch) {
    const [, step, toolNameRaw, argsJson] = actionMatch;
    const isEmptyArgs = argsJson.trim() === '{}';
    const argsSummary = isEmptyArgs ? '' : summarizeArgs(argsJson);
    // Only render as a structured action when the args are genuinely empty
    // OR parsed to a non-empty summary — an unparsable/unexpected payload
    // falls through to 'plain' so the raw line (never hidden) is shown.
    if (isEmptyArgs || argsSummary) {
      return { kind: 'action', step, toolLabel: humanizeToolName(toolNameRaw), argsSummary };
    }
  }
  if (OBSERVATION_PREFIX_RE.test(text)) {
    return { kind: 'observation', text: text.replace(OBSERVATION_PREFIX_RE, '').trim() };
  }
  return { kind: 'plain', text };
}

function TimelineEntryContent({ text }: { text: string }) {
  const entry = parseTimelineEntry(text);

  if (entry.kind === 'action') {
    return (
      <span data-testid="transcript-action">
        <span style={{ fontWeight: 600 }}>#{entry.step} · {entry.toolLabel}</span>
        {entry.argsSummary && (
          <span style={{ opacity: 0.65, marginLeft: 6 }}>{entry.argsSummary}</span>
        )}
      </span>
    );
  }

  if (entry.kind === 'observation') {
    return (
      <span data-testid="transcript-observation" style={{ opacity: 0.75 }}>
        {'→ '}{entry.text}
      </span>
    );
  }

  return <>{entry.text}</>;
}

export function MissionDetailTranscript({ mission }: MissionDetailTranscriptProps) {
  const { t } = useI18n();
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const [isReplaying, setIsReplaying] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Visible slice of the timeline during replay (or all events otherwise). */
  const visibleTimeline: ActionEvent[] = isReplaying
    ? (mission.actionTimeline ?? []).slice(0, replayIndex)
    : (mission.actionTimeline ?? []);

  /** Start a step-by-step replay from the beginning. */
  const startReplay = useCallback(() => {
    const timeline = mission.actionTimeline ?? [];
    if (timeline.length === 0) return;
    setReplayIndex(0);
    setIsReplaying(true);
  }, [mission.actionTimeline]);

  /** Stop an in-progress replay immediately. */
  const stopReplay = useCallback(() => {
    if (replayTimerRef.current !== null) {
      clearTimeout(replayTimerRef.current);
      replayTimerRef.current = null;
    }
    setIsReplaying(false);
    setReplayIndex(0);
  }, []);

  // Advance replay one step at a time
  useEffect(() => {
    if (!isReplaying) return;
    const timeline = mission.actionTimeline ?? [];
    if (replayIndex >= timeline.length) {
      // Replay complete — defer to avoid synchronous setState-in-effect
      const id = setTimeout(() => setIsReplaying(false), 0);
      return () => clearTimeout(id);
    }
    replayTimerRef.current = setTimeout(() => {
      setReplayIndex((prev) => prev + 1);
      transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, REPLAY_STEP_DELAY_MS);
    return () => {
      if (replayTimerRef.current !== null) {
        clearTimeout(replayTimerRef.current);
      }
    };
  }, [isReplaying, replayIndex, mission.actionTimeline]);

  // Auto-scroll to the newest entry as the live timeline grows (generalizes
  // the previous "scroll after adding an intervention note" behavior — any
  // new entry, live-agent or user-driven, now scrolls into view the same way).
  useEffect(() => {
    if (isReplaying) return;
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [mission.actionTimeline?.length, isReplaying]);

  if (!mission.actionTimeline || mission.actionTimeline.length === 0) return null;

  return (
    // QA B14: stable id so MissionDetail's focusSection effect can scroll
    // the Cockpit urgent card's "Logs" action directly here (mirrors
    // DiffCard's "mission-diff-card" id in MissionDetailRight.tsx).
    <div id="mission-transcript-section">
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.35)',
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          marginBottom: 10,
        }}
      >
        {t('agents.detail.sectionTranscript')}
      </div>

      {/* Replay controls — only for completed missions */}
      {(mission.status === 'done' || mission.status === 'review' ||
        mission.status === 'failed' || mission.status === 'cancelled') && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          {!isReplaying ? (
            <button
              data-testid="replay-btn"
              onClick={startReplay}
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                border: '1px solid rgba(124,92,255,0.35)',
                background: 'rgba(124,92,255,0.10)',
                color: '#C4B5FD',
                fontSize: 11,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {t('agents.detail.replay')}
            </button>
          ) : (
            <>
              <button
                data-testid="replay-stop-btn"
                onClick={stopReplay}
                style={{
                  padding: '4px 12px',
                  borderRadius: 6,
                  border: '1px solid rgba(248,113,113,0.35)',
                  background: 'rgba(248,113,113,0.10)',
                  color: '#F87171',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t('agents.detail.stopReplay')}
              </button>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                {replayIndex} / {mission.actionTimeline.length}
              </span>
            </>
          )}
        </div>
      )}
      <div
        style={{
          background: '#0A0A10',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 8,
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          maxHeight: 340,
          overflowY: 'auto',
        }}
      >
        {visibleTimeline.map((event, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 10,
              padding: '5px 6px',
              borderRadius: 5,
              background: event.isLive
                ? 'rgba(124,92,255,0.08)'
                : event.text.startsWith('[note locale]')
                ? 'rgba(251,185,36,0.06)'
                : 'transparent',
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: 'rgba(255,255,255,0.3)',
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                flexShrink: 0,
                paddingTop: 1,
                width: 36,
              }}
            >
              {event.time}
            </span>
            <span
              style={{
                fontSize: 12,
                color: event.isLive
                  ? '#E2E2F0'
                  : event.text.startsWith('[note locale]')
                  ? '#FBB924'
                  : 'rgba(255,255,255,0.55)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <TimelineEntryContent text={event.text} />
              {(event.isLive || (isReplaying && i === visibleTimeline.length - 1)) && (
                <span className="agent-timeline-cursor" />
              )}
            </span>
          </div>
        ))}
        <div ref={transcriptEndRef} />
      </div>
    </div>
  );
}
