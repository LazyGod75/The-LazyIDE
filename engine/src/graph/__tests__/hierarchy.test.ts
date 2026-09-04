import { describe, expect, it } from 'vitest';
import type { NoteFile } from '../../store/reader.js';
import { extractHierarchy } from '../hierarchy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeNote(id: string, cwd: string, html?: string): NoteFile {
  const fullHtml = html ?? `<article id="${id}" data-cerveau-cwd="${cwd}"></article>`;
  return { path: `/brain/notes/${id}.html`, id, html: fullHtml, sizeBytes: 0, mtimeMs: 0 };
}

// ---------------------------------------------------------------------------
// extractHierarchy
// ---------------------------------------------------------------------------
describe('extractHierarchy', () => {
  it('returns a root node with id "_root" and level 0', () => {
    const tree = extractHierarchy([]);
    expect(tree.root.id).toBe('_root');
    expect(tree.root.level).toBe(0);
  });

  it('returns empty tree for no notes', () => {
    const tree = extractHierarchy([]);
    expect(tree.projects).toHaveLength(0);
    expect(tree.totalNodes).toBe(1); // only root
  });

  it('creates a project node for a single note', () => {
    const notes = [makeNote('note-1', 'C:/Users/user/Documents/Acme/marketing')];
    const tree = extractHierarchy(notes);
    expect(tree.projects).toContain('acme');
    const projectNode = tree.byId.get('acme');
    expect(projectNode).toBeDefined();
    expect(projectNode!.level).toBe(1);
  });

  it('creates nested module nodes', () => {
    const notes = [makeNote('note-1', 'C:/Users/user/Documents/Acme/marketing')];
    const tree = extractHierarchy(notes);
    const moduleNode = tree.byId.get('acme/marketing');
    expect(moduleNode).toBeDefined();
    expect(moduleNode!.level).toBe(2);
    expect(moduleNode!.parent).toBe('acme');
  });

  it('attaches note to the most specific node', () => {
    const notes = [makeNote('note-1', 'C:/Users/user/Documents/Acme/marketing')];
    const tree = extractHierarchy(notes);
    const leafNode = tree.byId.get('acme/marketing');
    expect(leafNode!.noteIds).toContain('note-1');
    // Project node should NOT directly own the note
    const projectNode = tree.byId.get('acme');
    expect(projectNode!.noteIds).not.toContain('note-1');
  });

  it('accumulates conversationCount up the hierarchy', () => {
    const notes = [
      makeNote('note-1', 'C:/Users/user/Documents/Acme/marketing'),
      makeNote('note-2', 'C:/Users/user/Documents/Acme/marketing'),
    ];
    const tree = extractHierarchy(notes);
    const projectNode = tree.byId.get('acme');
    expect(projectNode!.conversationCount).toBe(2);
    const leafNode = tree.byId.get('acme/marketing');
    expect(leafNode!.conversationCount).toBe(2);
  });

  it('handles multiple projects', () => {
    const notes = [
      makeNote('note-1', 'C:/Users/user/Documents/Acme/marketing'),
      makeNote('note-2', 'C:/Users/user/Documents/OtherProject/backend'),
    ];
    const tree = extractHierarchy(notes);
    expect(tree.projects).toContain('acme');
    expect(tree.projects).toContain('otherproject');
    expect(tree.projects).toHaveLength(2);
  });

  it('skips notes without data-cerveau-cwd', () => {
    const note: NoteFile = {
      path: '/brain/notes/no-cwd.html',
      id: 'no-cwd',
      html: '<article id="no-cwd"></article>',
      sizeBytes: 0,
      mtimeMs: 0,
    };
    const tree = extractHierarchy([note]);
    expect(tree.projects).toHaveLength(0);
  });

  it('handles hyphenated cwd in first segment', () => {
    const notes = [makeNote('note-1', 'C:/Users/user/Documents/Acme-Tracking-cal')];
    const tree = extractHierarchy(notes);
    expect(tree.byId.has('acme')).toBe(true);
    expect(tree.byId.has('acme/tracking')).toBe(true);
    expect(tree.byId.has('acme/tracking/cal')).toBe(true);
    const leaf = tree.byId.get('acme/tracking/cal');
    expect(leaf!.noteIds).toContain('note-1');
  });

  it('wires parent-child links correctly', () => {
    const notes = [makeNote('note-1', 'C:/Users/user/Documents/Acme/marketing')];
    const tree = extractHierarchy(notes);
    const projectNode = tree.byId.get('acme');
    expect(projectNode!.children).toContain('acme/marketing');
    expect(tree.root.children).toContain('acme');
  });

  it('deduplicates notes added twice with same id', () => {
    const note = makeNote('note-1', 'C:/Users/user/Documents/Acme/marketing');
    const tree = extractHierarchy([note, note]);
    const leaf = tree.byId.get('acme/marketing');
    const count = leaf!.noteIds.filter((id) => id === 'note-1').length;
    expect(count).toBe(1);
  });
});
