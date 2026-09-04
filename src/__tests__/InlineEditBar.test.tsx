import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InlineEditBar, spliceProposedContent } from '../components/editor/InlineEditBar';
import { I18nProvider } from '../i18n';
import { saveAccessSettings } from '../lib/models/accessSettings';
import { DEFAULT_MODEL, findModelById } from '../lib/models/registry';
import type { StreamChatRequest } from '../lib/models';

// Mock only provider SELECTION — getActiveModel() (the model-resolution path
// under test here, DEFECT #1) is left REAL via importOriginal, so these
// tests prove genuine dynamic resolution rather than a mocked pass-through.
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProvider: vi.fn(),
    describeProviderReadiness: vi.fn(() => ({ ready: true })),
  };
});

import { getProvider } from '../lib/models/index';

function renderBar() {
  const onDone = vi.fn();
  const onProposeDiff = vi.fn();
  render(
    <I18nProvider>
      <InlineEditBar
        selectedCode="function foo() {}"
        filename="foo.ts"
        language="typescript"
        filePath="/proj/foo.ts"
        selFrom={0}
        selTo={0}
        fullContent="function foo() {}"
        onDone={onDone}
        onProposeDiff={onProposeDiff}
      />
    </I18nProvider>,
  );
  return { onDone, onProposeDiff };
}

/** Wires a mock provider that records the request it received and yields a
 *  single canned response chunk. */
function mockStreamChat(capture: { request: StreamChatRequest | null }) {
  vi.mocked(getProvider).mockReturnValue({
    id: 'mock',
    label: 'Mock',
    listModels: () => [],
    streamChat: (req: StreamChatRequest) => {
      capture.request = req;
      return (async function* () {
        yield 'fixed code';
      })();
    },
  });
}

/** Wires a mock provider that streams an arbitrary list of raw chunks
 *  (joined together, the way InlineEditBar accumulates them) so tests can
 *  simulate a fenced or narrated response instead of the single-token
 *  canned "fixed code" chunk above. */
function mockStreamChatWithResponse(response: string, label = 'Claude Code (abonnement)') {
  vi.mocked(getProvider).mockReturnValue({
    id: 'claude-code',
    label,
    listModels: () => [],
    streamChat: () => (async function* () {
      yield response;
    })(),
  });
}

beforeEach(() => {
  localStorage.clear();
});

// ── DEFECT #2: focus handoff ────────────────────────────────────────
// Ctrl+K without a selection used to leave DOM focus ambiguous between the
// CodeMirror view and the prompt input, letting the first keystrokes of the
// user's instruction leak into the document instead of the prompt.

describe('InlineEditBar — focus handoff (DEFECT #2)', () => {
  it('claims focus on the prompt input as soon as it mounts', () => {
    renderBar();
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('keeps focus on the prompt input for the no-selection case (selFrom === selTo)', () => {
    // selFrom/selTo equal — the exact "no selection" shape EditorPane passes
    // when Ctrl+K fires with the caret sitting mid-line, no highlighted text.
    renderBar();
    const input = screen.getByRole('textbox');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'a' } });
    expect(input).toHaveValue('a');
  });
});

// ── DEFECT #1: model resolution ─────────────────────────────────────
// Ctrl+K used to hardcode 'claude-sonnet-4-20250514', which the Claude Code
// CLI subscription path rejects outright, so no diff was ever produced.

describe('InlineEditBar — model resolution (DEFECT #1)', () => {
  it('sends the resolved active model (DEFAULT_MODEL) to streamChat, not a hardcoded literal', async () => {
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    renderBar();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add error handling' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(capture.request).not.toBeNull());
    expect(capture.request?.model).toEqual(DEFAULT_MODEL);
    expect(capture.request?.model.id).not.toBe('claude-sonnet-4-20250514');
  });

  it('honors a persisted model override instead of a hardcoded literal', async () => {
    saveAccessSettings({ model: 'claude-opus-5' });
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    renderBar();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add error handling' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(capture.request).not.toBeNull());
    expect(capture.request?.model).toEqual(findModelById('claude-opus-5'));
  });
});

// ── HIGH DEFECT: agentic narration corrupts inline-edit ──────────────
// Real QA capture: user selected `export function add(a,b){return a+b}`
// and asked "add a short comment above this" under the "Claude Code
// (abonnement)" backend. The model narrated tool calls instead of
// returning code, and accepting the diff replaced the function with prose:
//   -export function add(a: number, b: number): number {
//   -  return a + b;
//   -}
//   +→ Read `qa-ctrlk-select-fixture.ts`
//   +The file already has the function on line 3. I'll add a short comment above it:
//   +→ Edit `qa-ctrlk-select-fixture.ts`
//   +Done. Added a short comment "Returns the sum of two numbers" above the `add()` function.
// Root cause: InlineEditBar sent mode: 'edit', which carries an agentic
// "apply changes directly using your tools" system prompt AND (on the
// Claude Code CLI backend) real acceptEdits/--add-dir file access — see
// ChatMode's doc comment in lib/models/types.ts. Fix: mode: 'transform'
// (strict code-only system prompt, no agentic file access) plus
// sanitizeModelCodeOutput as a fail-safe gate before anything reaches the
// diff/apply path.

describe('InlineEditBar — code-only output, not agentic narration (HIGH defect)', () => {
  it('sends mode "transform" (single-shot code transform), never the agentic "edit" mode', async () => {
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    renderBar();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add a comment' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(capture.request).not.toBeNull());
    expect(capture.request?.mode).toBe('transform');
  });

  it('applies a pure-code response as the diff unchanged', async () => {
    const code = 'export function add(a: number, b: number): number {\n  return a + b;\n}';
    mockStreamChatWithResponse(code);
    const { onProposeDiff, onDone } = renderBar();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add types' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(onProposeDiff).toHaveBeenCalledTimes(1));
    expect(onProposeDiff).toHaveBeenCalledWith(code);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('unwraps a fenced code response before applying it', async () => {
    const code = 'export function add(a: number, b: number): number {\n  return a + b;\n}';
    mockStreamChatWithResponse('```typescript\n' + code + '\n```');
    const { onProposeDiff } = renderBar();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add types' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(onProposeDiff).toHaveBeenCalledTimes(1));
    expect(onProposeDiff).toHaveBeenCalledWith(code);
  });

  it('REGRESSION: does not apply agentic narration as code — fails safe instead of corrupting the file', async () => {
    const narration = [
      '→ Read `qa-ctrlk-select-fixture.ts`',
      "The file already has the function on line 3. I'll add a short comment above it:",
      '→ Edit `qa-ctrlk-select-fixture.ts`',
      'Done. Added a short comment "Returns the sum of two numbers" above the `add()` function.',
    ].join('\n');
    mockStreamChatWithResponse(narration);
    const { onProposeDiff, onDone } = renderBar();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add a short comment above this' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/narration|explanation/i)).toBeInTheDocument());

    // Never applied — no corrupted diff, and the bar stays open (onDone not
    // called) so the user sees the error instead of a silently-closed bar.
    expect(onProposeDiff).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    // Names the backend so QA/users know which engine misbehaved.
    expect(screen.getByText((content) => content.includes('Claude Code (abonnement)'))).toBeInTheDocument();
  });
});

// ── DEFECT D: glued lines when splicing a multi-line replacement (2026-07 in-app QA) ──
// Real QA capture: user's selection started right after an existing
// `import {...} from "./src/i18n/routing";` statement (caret at the end of
// that line, shift-selected forward to grab the following statement) and
// asked the model to add a comment above the selected code. The model
// correctly returned "// comment\n<code>", but splicing it in glued the
// (unselected) import statement directly onto the new comment — no newline
// between them — because the selection boundary was mid-line, not aligned
// to a line start.

describe('spliceProposedContent — boundary newline safety (DEFECT D)', () => {
  it('inserts a leading newline for a multi-line replacement when the text before the splice does not already end with one', () => {
    const result = spliceProposedContent('import x;', 9, 9, '// comment\ncode();');
    expect(result).toBe('import x;\n// comment\ncode();');
  });

  it('does not insert a double newline when the text before the splice already ends with one', () => {
    const result = spliceProposedContent('import x;\n', 10, 10, '// comment\ncode();');
    expect(result).toBe('import x;\n// comment\ncode();');
  });

  it('inserts a trailing newline for a multi-line replacement when the text after the splice does not already start with one', () => {
    const result = spliceProposedContent('foorest', 0, 3, 'bar\nbaz');
    expect(result).toBe('bar\nbaz\nrest');
  });

  it('never forces a newline for a single-line (inline) replacement — ordinary same-line edits are unaffected', () => {
    // Renaming `foo` to `bar` mid-expression must stay glued to its
    // neighbors on the same line — this is NOT the multi-line "comment
    // above a line" case the fix targets.
    expect(spliceProposedContent('headfoo', 4, 7, 'bar')).toBe('headbar');
    expect(spliceProposedContent('foorest', 0, 3, 'bar')).toBe('barrest');
  });

  it('never inserts a leading newline when the replacement lands at the very start of the file', () => {
    const result = spliceProposedContent('original', 0, 0, 'prefix\nline2\n');
    expect(result).toBe('prefix\nline2\noriginal');
  });

  it('never inserts a trailing newline when the replacement lands at the very end of the file', () => {
    const result = spliceProposedContent('original', 8, 8, '\nsuffix1\nsuffix2');
    expect(result).toBe('original\nsuffix1\nsuffix2');
  });

  it('does not double up when the replacement already supplies its own boundary newlines', () => {
    const result = spliceProposedContent('a;\nb;', 3, 3, '\n// already separated\n');
    expect(result).toBe('a;\n\n// already separated\nb;');
  });

  it('reproduces the exact QA scenario: comment glued to an unselected import statement', () => {
    const importLine = 'import { getRequestConfig } from "./src/i18n/routing";';
    const originalNextLine = 'export default getRequestConfig(async () => ({}));';
    const fullContent = `${importLine}\n${originalNextLine}\n`;

    // Selection starts at the import's own newline (caret at end of the
    // import line, then Shift+Down+End) and runs through the next line —
    // the import itself is untouched/unselected.
    const selFrom = importLine.length;
    const selTo = importLine.length + 1 + originalNextLine.length;
    const replacement = `// Loads the locale-aware request config\n${originalNextLine}`;

    const result = spliceProposedContent(fullContent, selFrom, selTo, replacement);

    expect(result).not.toContain(`${importLine}// Loads`);
    expect(result).toBe(`${importLine}\n// Loads the locale-aware request config\n${originalNextLine}\n`);
  });
});

describe('InlineEditBar — splice preserves line breaks at the selection boundary (DEFECT D)', () => {
  it('does not glue the inserted comment onto the unselected statement immediately before the selection', async () => {
    const importLine = 'import { getRequestConfig } from "./src/i18n/routing";';
    const originalNextLine = 'export default getRequestConfig(async () => ({}));';
    const fullContent = `${importLine}\n${originalNextLine}\n`;

    const selFrom = importLine.length;
    const selTo = importLine.length + 1 + originalNextLine.length;
    const selectedCode = fullContent.slice(selFrom, selTo);

    // The model includes a leading blank line before its comment (common
    // formatting) — sanitizeModelCodeOutput's trim() strips it, which is
    // exactly what used to leave the splice with nothing to separate the
    // comment from the untouched import line before it.
    const modelResponse = `\n// Loads the locale-aware request config\n${originalNextLine}`;
    mockStreamChatWithResponse(modelResponse);

    const onProposeDiff = vi.fn();
    render(
      <I18nProvider>
        <InlineEditBar
          selectedCode={selectedCode}
          filename="routing.ts"
          language="typescript"
          filePath="/proj/routing.ts"
          selFrom={selFrom}
          selTo={selTo}
          fullContent={fullContent}
          onDone={vi.fn()}
          onProposeDiff={onProposeDiff}
        />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add a comment above this' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    await waitFor(() => expect(onProposeDiff).toHaveBeenCalledTimes(1));
    const proposed = onProposeDiff.mock.calls[0][0] as string;

    // The exact glue this defect produced: import statement and comment on one line.
    expect(proposed).not.toContain(`${importLine}// Loads`);
    expect(proposed).toBe(`${importLine}\n// Loads the locale-aware request config\n${originalNextLine}\n`);
  });
});
