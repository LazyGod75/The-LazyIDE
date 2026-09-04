/**
 * In-memory EngineFacade stub — deterministic fake data.
 *
 * Used by server tests and as fallback when src/engine is absent.
 * All state is process-local; reset between test runs via fresh instances.
 */

import type { EngineFacade, FederatedHit, TeamBrainStats } from './engine-facade.js';

interface StubNote {
  noteId: string;
  teamSlug: string;
  authorUsername: string;
  agent?: string;
  type: string;
  tags: string[];
  text: string;
  createdAt: string;
}

export class EngineStub implements EngineFacade {
  private readonly _notes: StubNote[] = [];
  private _noteCounter = 0;

  async ensureTeamBrain(teamSlug: string): Promise<{ brainPath: string }> {
    return { brainPath: `/tmp/stub-brains/${teamSlug}` };
  }

  async search(opts: {
    query: string;
    teamSlugs: string[];
    top?: number;
  }): Promise<FederatedHit[]> {
    const limit = opts.top ?? 20;
    const lower = opts.query.toLowerCase();

    const hits: FederatedHit[] = this._notes
      .filter(
        (n) =>
          opts.teamSlugs.includes(n.teamSlug) &&
          (n.text.toLowerCase().includes(lower) || n.type.toLowerCase().includes(lower)),
      )
      .slice(0, limit)
      .map((n) => ({
        teamSlug: n.teamSlug,
        noteId: n.noteId,
        title: `${n.type}: ${n.text.slice(0, 60)}`,
        snippet: n.text.slice(0, 120),
        score: 0.9,
        type: n.type,
        date: n.createdAt,
      }));

    // If no real matches, return deterministic stub hits for permitted teams
    if (hits.length === 0) {
      return opts.teamSlugs.slice(0, 3).map((slug, i) => ({
        teamSlug: slug,
        noteId: `stub-note-${i + 1}`,
        title: `Stub result for "${opts.query}"`,
        snippet: `This is a deterministic stub result for team ${slug}. Query: ${opts.query}`,
        score: 0.8 - i * 0.1,
        type: 'reference',
        date: '2026-06-01T00:00:00Z',
      }));
    }

    return hits;
  }

  async storeNote(opts: {
    teamSlug: string;
    authorUsername: string;
    agent?: string;
    type?: string;
    tags?: string[];
    text: string;
  }): Promise<{ noteId: string }> {
    this._noteCounter += 1;
    const noteId = `note-${String(this._noteCounter).padStart(4, '0')}`;
    const note: StubNote = {
      noteId,
      teamSlug: opts.teamSlug,
      authorUsername: opts.authorUsername,
      agent: opts.agent,
      type: opts.type ?? 'reference',
      tags: opts.tags ?? [],
      text: opts.text,
      createdAt: new Date().toISOString(),
    };
    this._notes.push(note);
    return { noteId };
  }

  async renderWikiIndex(teamSlug: string): Promise<{ title: string; bodyHtml: string }> {
    const teamNotes = this._notes.filter((n) => n.teamSlug === teamSlug);
    const rows = teamNotes
      .map(
        (n) =>
          `<li><a href="/t/${encodeURIComponent(teamSlug)}/wiki/note/${encodeURIComponent(n.noteId)}">${escHtml(n.noteId)}: ${escHtml(n.text.slice(0, 60))}</a></li>`,
      )
      .join('\n');

    const bodyHtml = `
<h2>Wiki Index — ${escHtml(teamSlug)}</h2>
<p><em>Stub engine — ${teamNotes.length} note(s) stored in this session.</em></p>
${teamNotes.length > 0 ? `<ul>${rows}</ul>` : '<p>No notes yet.</p>'}
<p><a href="/t/${encodeURIComponent(teamSlug)}">← Back to team page</a></p>
`.trim();

    return { title: `Wiki — ${teamSlug}`, bodyHtml };
  }

  async renderWikiNote(
    teamSlug: string,
    noteId: string,
  ): Promise<{ title: string; bodyHtml: string } | null> {
    const note = this._notes.find((n) => n.teamSlug === teamSlug && n.noteId === noteId);
    if (!note) {
      // Return a stub note for deterministic fake data
      return {
        title: `Note ${noteId} — ${teamSlug}`,
        bodyHtml: `
<h2>Note: ${escHtml(noteId)}</h2>
<p><strong>Team:</strong> ${escHtml(teamSlug)}</p>
<p><em>Stub note — not found in session store.</em></p>
<p><a href="/t/${encodeURIComponent(teamSlug)}/wiki">← Back to wiki index</a></p>
`.trim(),
      };
    }

    const bodyHtml = `
<h2>${escHtml(note.type)}: ${escHtml(note.noteId)}</h2>
<p><strong>Author:</strong> ${escHtml(note.authorUsername)}</p>
<p><strong>Created:</strong> ${escHtml(note.createdAt)}</p>
${note.tags.length > 0 ? `<p><strong>Tags:</strong> ${note.tags.map(escHtml).join(', ')}</p>` : ''}
<hr>
<pre>${escHtml(note.text)}</pre>
<p><a href="/t/${encodeURIComponent(teamSlug)}/wiki">← Back to wiki index</a></p>
`.trim();

    return { title: `${note.type}: ${noteId}`, bodyHtml };
  }

  async stats(teamSlug: string): Promise<TeamBrainStats> {
    const teamNotes = this._notes.filter((n) => n.teamSlug === teamSlug);
    const decisions = teamNotes.filter((n) => n.type === 'decision');
    const last = teamNotes[teamNotes.length - 1];
    return {
      notes: teamNotes.length,
      activeDecisions: decisions.length,
      lastCaptureAt: last?.createdAt,
    };
  }

  async shutdown(): Promise<void> {
    // Nothing to flush in the stub
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Shared singleton stub used when no real engine is available. */
export const engineStub: EngineFacade = new EngineStub();
