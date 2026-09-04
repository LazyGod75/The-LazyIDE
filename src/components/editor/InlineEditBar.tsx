/* InlineEditBar — prompt bar that appears at top of editor for Ctrl+K inline edit.
   User types an instruction, the selected code + instruction is sent to the model,
   and the result is applied via editor:applyEdit bus event.
*/

import { useState, useRef, useCallback, useLayoutEffect } from 'react';
import { emit } from '../../lib/bus';
import { getProvider, describeProviderReadiness, getActiveModel } from '../../lib/models';
import type { ChatMessage } from '../../lib/models';
import { sanitizeModelCodeOutput } from '../../lib/ai/codeOutputSanitizer';
import { useI18n } from '../../i18n';

/**
 * Splices `replacement` into `fullContent` at [from, to), inserting a
 * newline at either boundary when it's missing — so a multi-line
 * replacement (e.g. a newly-added comment line) never gets glued onto
 * whatever precedes or follows the spliced range.
 *
 * DEFECT D (2026-07 in-app QA): selFrom/selTo do not always land on a clean
 * line boundary. A real CodeMirror selection (sel.from !== sel.to — see
 * EditorPane's computeInlineEditRange) can start mid-line, right after an
 * existing statement, e.g. when the user places the caret at the end of one
 * line and shift-selects forward to the following statement(s) they want
 * changed, leaving that first line itself unselected. sanitizeModelCodeOutput
 * unconditionally .trim()s the model's response, stripping any leading/
 * trailing newline it included. Combined, a model reply like
 * "// comment\nexport default …" spliced in right after an unselected
 * `import {...} from "./src/i18n/routing";` landed as one glued line:
 *   import {...} from "./src/i18n/routing";// comment
 * instead of the comment starting its own new line.
 *
 * Only applies when `replacement` itself spans multiple lines: a single-line
 * replacement (the common case — renaming a variable, rewriting an
 * expression mid-line, etc.) is left byte-for-byte alone, exactly as before,
 * since forcing a newline there would break an ordinary inline edit that is
 * SUPPOSED to stay glued to its neighbors on the same line. For a multi-line
 * replacement this only INSERTS a newline when neither side already
 * supplies one — it never removes anything and never touches the interior
 * of `replacement` — so it is a no-op for every splice that was already
 * correctly separated.
 */
export function spliceProposedContent(
  fullContent: string,
  from: number,
  to: number,
  replacement: string,
): string {
  const before = fullContent.slice(0, from);
  const after = fullContent.slice(to);
  const isMultiLine = replacement.includes('\n');

  const needsLeadingNewline =
    isMultiLine && before.length > 0 && !before.endsWith('\n') && !replacement.startsWith('\n');
  const needsTrailingNewline =
    isMultiLine && after.length > 0 && !after.startsWith('\n') && !replacement.endsWith('\n');

  return (
    before +
    (needsLeadingNewline ? '\n' : '') +
    replacement +
    (needsTrailingNewline ? '\n' : '') +
    after
  );
}

interface InlineEditBarProps {
  selectedCode: string;
  filename: string;
  language: string;
  filePath: string;
  /** Start offset of the target range in the full document (0-based). With
   *  no active selection, EditorPane passes the current line's start
   *  instead of the whole document — see computeInlineEditRange in
   *  EditorPane.tsx. */
  selFrom: number;
  /** End offset of the target range in the full document (0-based). With
   *  no active selection, EditorPane passes the current line's end instead
   *  of the whole document. */
  selTo: number;
  /** Full file content at the moment Ctrl+K was pressed. Used to reconstruct the file after a partial edit. */
  fullContent: string;
  onDone: () => void;
  /** If provided, the proposed content is passed to this callback instead of directly applying. */
  onProposeDiff?: (proposedContent: string) => void;
}

export function InlineEditBar({ selectedCode, filename, language, filePath, selFrom, selTo, fullContent, onDone, onProposeDiff }: InlineEditBarProps) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Explicitly claim focus for the prompt input as soon as the bar mounts.
  // CodeMirror's view still holds DOM focus at the instant Ctrl+K fires (the
  // shortcut only triggers while `view.hasFocus` is true — see EditorPane's
  // useShortcut registration), so relying on the input's passive `autoFocus`
  // attribute alone left a window where the first keystrokes typed by the
  // user could land in the document instead of this prompt (DEFECT #2:
  // typed instructions leaking into the code buffer). useLayoutEffect runs
  // before any other component's passive `useEffect` in the same commit —
  // e.g. EditorPane's no-deps LSP-bind effect — so this wins the handoff
  // deterministically instead of racing it.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!instruction.trim() || loading) return;
    setLoading(true);
    setError(null);

    const readiness = describeProviderReadiness(undefined, t);
    if (!readiness.ready) {
      setError(readiness.reason ?? t('editor.inlineEdit.noEngine'));
      setLoading(false);
      return;
    }

    const provider = getProvider(t);

    const userMsg: ChatMessage = {
      id: `inline-${Date.now()}`,
      role: 'user',
      content: `Selected code from ${filename}:\n\`\`\`${language}\n${selectedCode}\n\`\`\`\n\nInstruction: ${instruction.trim()}\n\nReturn ONLY the replacement code for the selected snippet above. No explanation, no narration, no markdown code fences.`,
    };

    const assistantMsg: ChatMessage = {
      id: `inline-assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
    };

    try {
      let accumulated = '';
      const stream = provider.streamChat({
        messages: [userMsg, assistantMsg],
        // Resolved active model (not a hardcoded literal) — see getActiveModel().
        model: getActiveModel(),
        // 'transform', NOT 'edit': a single-shot, non-agentic code
        // transform — see ChatMode's doc comment in lib/models/types.ts.
        // Reusing 'edit' here was the root cause of a HIGH defect: 'edit'
        // carries an agentic system prompt AND (on the Claude Code CLI
        // backend, see chat.rs) real acceptEdits/--add-dir file access, so
        // the model narrated tool calls ("→ Read foo.ts\nDone. Added a
        // comment...") instead of returning code, and that narration got
        // spliced into the file as if it were the replacement.
        mode: 'transform',
      });

      for await (const token of stream) {
        accumulated += token;
      }

      // Fail-safe: reject narration/prose instead of applying it as code —
      // a no-op-with-error beats corrupting the buffer. See
      // codeOutputSanitizer.ts (also strips markdown fences the model adds
      // despite the "no fences" instruction).
      const sanitized = sanitizeModelCodeOutput(accumulated);
      if (!sanitized.ok) {
        setError(`${sanitized.reason} (backend: ${provider.label})`);
        return;
      }

      // If the user had an actual selection, splice only that range; otherwise replace the whole file.
      // spliceProposedContent guards the splice boundaries against gluing
      // onto adjacent, unselected lines — see its doc comment (DEFECT D).
      const proposedContent = selFrom !== selTo
        ? spliceProposedContent(fullContent, selFrom, selTo, sanitized.code)
        : sanitized.code;

      if (onProposeDiff) {
        onProposeDiff(proposedContent);
      } else {
        emit('editor:applyEdit', {
          proposedContent,
          path: filePath,
          language,
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('editor.inlineEdit.genError'));
    } finally {
      setLoading(false);
    }
  }, [instruction, loading, selectedCode, filename, language, filePath, selFrom, selTo, fullContent, onDone, onProposeDiff, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onDone();
    }
  }, [handleSubmit, onDone]);

  return (
    <>
      <style>{`@keyframes lazypulse { 0%,80%,100%{opacity:0.2} 40%{opacity:1} }`}</style>
      <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: 'rgba(124,92,255,0.08)',
        borderBottom: '1px solid rgba(124,92,255,0.2)',
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 10, color: 'var(--color-accent-light)', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {t('editor.inlineEdit.label')}
      </span>
      <input
        ref={inputRef}
        value={instruction}
        onChange={e => setInstruction(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('editor.inlineEdit.placeholder', { filename })}
        disabled={loading}
        style={{
          flex: 1,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          fontSize: 12,
          color: 'var(--color-text)',
          fontFamily: 'inherit',
        }}
      />
      {error && (
        <span style={{ fontSize: 10, color: '#F07178', whiteSpace: 'nowrap' }}>
          {error}
        </span>
      )}
      {loading && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {[0, 1, 2].map(i => (
            <span
              key={i}
              style={{
                width: 4,
                height: 4,
                borderRadius: '50%',
                background: 'var(--color-accent)',
                display: 'inline-block',
                animation: `lazypulse 1.2s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </span>
      )}
      {!loading && (
        <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, padding: '1px 5px', flexShrink: 0, whiteSpace: 'nowrap' }}>
          ↵
        </span>
      )}
      <button
        onClick={onDone}
        onMouseEnter={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.3)'; }}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'rgba(255,255,255,0.3)',
          cursor: 'pointer',
          padding: 0,
          fontFamily: 'inherit',
          display: 'flex',
          alignItems: 'center',
        }}
        title={t('editor.inlineEdit.cancel')}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
    </>
  );
}
