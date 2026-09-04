/**
 * MissionDetailTranscript.test.tsx
 *
 * The mission DETAIL view's action timeline previously rendered managed-agent
 * ReAct steps verbatim: a raw `[3] read_file: {"path":"src/foo.ts"}` line
 * (tool name + a JSON args dump) immediately followed by a raw
 * `Observation: <tool output>` line. This locks the DISPLAY-only fix: both
 * lines are now re-presented with a readable tool name + a compact args
 * summary / a visually distinct "result of the action above" line — while
 * every other entry shape (plain human sentences, [eval]/[note locale] tags)
 * keeps rendering exactly as before.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
  MissionDetailTranscript,
  parseTimelineEntry,
} from '../components/agents/MissionDetailTranscript';
import type { Mission } from '../lib/agents/types';
import { I18nProvider } from '../i18n';

// jsdom does not implement scrollIntoView (same stub as MessageList.test.tsx)
// — MissionDetailTranscript auto-scrolls to the newest entry on mount.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function makeMission(overrides: Partial<Mission>): Mission {
  return {
    id: 'm1',
    title: 'Test mission',
    status: 'running',
    model: 'sonnet',
    ...overrides,
  };
}

function renderTranscript(mission: Mission) {
  return render(
    <I18nProvider>
      <MissionDetailTranscript mission={mission} />
    </I18nProvider>,
  );
}

describe('parseTimelineEntry (pure)', () => {
  it('parses a "[N] tool_name: {json}" action line into a humanized tool name + args summary', () => {
    const entry = parseTimelineEntry('[3] read_file: {"path":"src/foo.ts"}');
    expect(entry).toEqual({
      kind: 'action',
      step: '3',
      toolLabel: 'Read file',
      argsSummary: 'path: src/foo.ts',
    });
  });

  it('parses an action line with empty args (e.g. git_status) without an args summary', () => {
    const entry = parseTimelineEntry('[1] git_status: {}');
    expect(entry).toEqual({ kind: 'action', step: '1', toolLabel: 'Git status', argsSummary: '' });
  });

  it('strips the "Observation:" prefix', () => {
    const entry = parseTimelineEntry('Observation: 42 lines written');
    expect(entry).toEqual({ kind: 'observation', text: '42 lines written' });
  });

  it('falls back to plain text for anything else (French status sentences, [eval]/[tests] tags, ...)', () => {
    expect(parseTimelineEntry('Mission démarrée — worktree en cours de création…')).toEqual({
      kind: 'plain',
      text: 'Mission démarrée — worktree en cours de création…',
    });
    expect(parseTimelineEntry('[eval] Évaluation terminée — score: 82 — PASSÉ')).toEqual({
      kind: 'plain',
      text: '[eval] Évaluation terminée — score: 82 — PASSÉ',
    });
  });

  it('falls back to plain text when the trailing payload is not valid JSON (never hides data)', () => {
    const raw = '[2] weird_tool: not-json-at-all';
    expect(parseTimelineEntry(raw)).toEqual({ kind: 'plain', text: raw });
  });
});

describe('MissionDetailTranscript — readable tool calls + observations', () => {
  it('renders a raw action line as a humanized tool name with its args summary, not the raw JSON', () => {
    const mission = makeMission({
      status: 'done',
      actionTimeline: [{ time: '10:00', text: '[3] read_file: {"path":"src/foo.ts"}' }],
    });
    renderTranscript(mission);

    expect(screen.getByTestId('transcript-action')).toBeInTheDocument();
    expect(screen.getByText(/Read file/)).toBeInTheDocument();
    expect(screen.getByText(/path: src\/foo\.ts/)).toBeInTheDocument();
    expect(screen.queryByText(/"path":"src\/foo\.ts"/)).toBeNull();
  });

  it('renders an Observation line without the literal "Observation:" prefix', () => {
    const mission = makeMission({
      status: 'done',
      actionTimeline: [{ time: '10:00', text: 'Observation: file written successfully' }],
    });
    renderTranscript(mission);

    expect(screen.getByTestId('transcript-observation')).toHaveTextContent('file written successfully');
    expect(screen.queryByText(/^Observation:/)).toBeNull();
  });

  it('still renders a plain human-readable entry unchanged', () => {
    const mission = makeMission({
      status: 'running',
      actionTimeline: [{ time: '10:00', text: 'Worktree créé : .lazy/worktrees/m1', isLive: true }],
    });
    renderTranscript(mission);

    expect(screen.getByText('Worktree créé : .lazy/worktrees/m1')).toBeInTheDocument();
  });
});

// QA B14: stable id so MissionDetail.tsx's focusSection effect (Cockpit
// urgent card's "Logs" action) can scroll straight to this section via
// document.getElementById('mission-transcript-section').
describe('MissionDetailTranscript — section id (QA B14 focus target)', () => {
  it('exposes id="mission-transcript-section" on its root when it renders', () => {
    const mission = makeMission({
      status: 'done',
      actionTimeline: [{ time: '10:00', text: 'did something' }],
    });
    const { container } = renderTranscript(mission);
    expect(container.querySelector('#mission-transcript-section')).not.toBeNull();
  });

  it('renders nothing (no id to find) when the mission has no actionTimeline', () => {
    const { container } = renderTranscript(makeMission({ status: 'queued' }));
    expect(container.querySelector('#mission-transcript-section')).toBeNull();
  });
});
