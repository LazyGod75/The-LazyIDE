/**
 * TDD tests for dream slug uniqueness per conversation.
 *
 * Spec: no two DIFFERENT conversations may produce the same note id,
 * even when their summary text is identical. The SAME conversation
 * re-processed must always produce the SAME note id (idempotent).
 *
 * The mechanism under test is `makeConversationSessionId`, a pure helper
 * exported from dream.ts that derives a deterministic, collision-resistant
 * session id from the conversation file path.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeConversationSessionId } from '../src/commands/dream.js';
import { slug } from '../src/store/paths.js';

// ---------------------------------------------------------------------------
// Helper that mirrors what annotateSession does with the sessionId
// (heuristic.ts line 112):
//   noteId = slug(`${ts.slice(0, 10)}-${input.sessionId.slice(0, 8)}-${title}`)
// We only need the sessionId part to verify uniqueness.
// ---------------------------------------------------------------------------
function buildNoteIdPrefix(sessionId: string, datePrefix: string): string {
  return slug(`${datePrefix}-${sessionId.slice(0, 20)}-same-title`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dream slug uniqueness per conversation', () => {
  // Test 1 — two DIFFERENT conversations with the same summary text → different note ids
  it('produces distinct session ids for two different conversation file paths', () => {
    const path1 = '/home/user/.claude/projects/proj-a/session-abc.jsonl';
    const path2 = '/home/user/.claude/projects/proj-b/session-xyz.jsonl';

    const sessionId1 = makeConversationSessionId(path1);
    const sessionId2 = makeConversationSessionId(path2);

    expect(sessionId1).not.toBe(sessionId2);
  });

  // Test 2 — same conversation re-processed → same session id (idempotent)
  it('produces the same session id when the same path is passed twice', () => {
    const path = '/home/user/.claude/projects/proj-a/session-abc.jsonl';

    const sessionId1 = makeConversationSessionId(path);
    const sessionId2 = makeConversationSessionId(path);

    expect(sessionId1).toBe(sessionId2);
  });

  // Test 3 — two different paths with identical basename → still distinct
  it('distinguishes paths that share the same filename but differ in parent directory', () => {
    const path1 = '/home/user/.claude/projects/proj-a/01JVKZ.jsonl';
    const path2 = '/home/user/.claude/projects/proj-b/01JVKZ.jsonl';

    const sessionId1 = makeConversationSessionId(path1);
    const sessionId2 = makeConversationSessionId(path2);

    expect(sessionId1).not.toBe(sessionId2);
  });

  // Test 4 — note ids built from different conversations + same title are distinct
  it('builds distinct note id prefixes for different conversations sharing the same title', () => {
    const path1 = '/home/user/.claude/projects/proj-a/session-111.jsonl';
    const path2 = '/home/user/.claude/projects/proj-b/session-222.jsonl';
    const date = '2026-05-28';

    const sid1 = makeConversationSessionId(path1);
    const sid2 = makeConversationSessionId(path2);

    const noteId1 = buildNoteIdPrefix(sid1, date);
    const noteId2 = buildNoteIdPrefix(sid2, date);

    expect(noteId1).not.toBe(noteId2);
  });

  // Test 5 — hash suffix is within slug length limit (slug truncates at 80)
  it('produces a session id that, combined with a date prefix and short title, stays within 80 chars after slug', () => {
    const path = '/home/user/.claude/projects/some-project/some-conversation.jsonl';
    const sessionId = makeConversationSessionId(path);
    const date = '2026-05-28';
    const fullSlug = slug(`${date}-${sessionId}-a short title here`);

    expect(fullSlug.length).toBeLessThanOrEqual(80);
  });

  // Test 6 — session id format: starts with "dream-" and includes 8-char hex hash
  it('session id starts with "dream-" and contains an 8-character hex suffix', () => {
    const path = '/home/user/.claude/projects/proj/session.jsonl';
    const sessionId = makeConversationSessionId(path);

    // Format: dream-<8hex>
    expect(sessionId).toMatch(/^dream-[0-9a-f]{8}$/);
  });

  // Test 7 — the 8-char hex matches the first 8 chars of SHA-256 of the path
  it('hash suffix equals first 8 chars of SHA-256 of the file path', () => {
    const path = '/home/user/.claude/projects/proj/session.jsonl';
    const sessionId = makeConversationSessionId(path);

    const expectedHash = createHash('sha256').update(path).digest('hex').slice(0, 8);
    expect(sessionId).toBe(`dream-${expectedHash}`);
  });

  // Test 8 — same conversation processed twice builds identical note ids end-to-end
  it('two runs on the same conversation produce the same note id (no duplicate proliferation)', () => {
    const path = '/home/user/.claude/projects/my-app/session-abc.jsonl';
    const date = '2026-05-28';
    const title = 'decided to use TypeScript';

    const noteId1 = slug(`${date}-${makeConversationSessionId(path)}-${title}`);
    const noteId2 = slug(`${date}-${makeConversationSessionId(path)}-${title}`);

    expect(noteId1).toBe(noteId2);
    expect(noteId1.length).toBeGreaterThanOrEqual(5); // schema: id must be >= 5 chars
    expect(noteId1.length).toBeLessThanOrEqual(80); // slug max
  });
});
