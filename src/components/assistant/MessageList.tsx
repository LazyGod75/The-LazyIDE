/* MessageList — renders the conversation thread */

import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { ChatMessage, ChatMode, StreamPart } from '../../lib/models';
import { emit } from '../../lib/bus';
import { useI18n } from '../../i18n';
import { MarkdownRenderer } from '../../lib/markdown';
import type { MarkdownCodeBlock } from '../../lib/markdown';

type ThinkingPart = Extract<StreamPart, { type: 'thinking' }>;
type ToolPart = Extract<StreamPart, { type: 'tool' }>;
type TFunction = (key: string, params?: Record<string, string | number>) => string;

// ── Citation chip ─────────────────────────────────────────────────

function CitationChip({ nodeRef }: { nodeRef: string }) {
  const nodeId = nodeRef.startsWith('#') ? nodeRef.slice(1) : nodeRef;

  function handleClick() {
    emit('nav:focusBrainNode', nodeId);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      emit('nav:focusBrainNode', nodeId);
    }
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'rgba(124,92,255,0.15)',
        border: '1px solid rgba(124,92,255,0.28)',
        borderRadius: 4,
        padding: '1px 6px',
        fontSize: 10,
        color: 'var(--color-accent-light)',
        fontWeight: 500,
        cursor: 'pointer',
        userSelect: 'none',
        margin: '0 2px',
      }}
    >
      {nodeRef}
    </span>
  );
}

// ── Code block ────────────────────────────────────────────────────

interface CodeBlockProps {
  language: string;
  code: string;
  /** Explicit target file for THIS block, ONLY ever set from the fence's
   *  own info string (see parseFenceInfo.ts) — never guessed from prose. */
  targetPath?: string;
  /** Chat mode the surrounding message was generated under — see
   *  canOfferApply's doc comment for the gating rule this drives. */
  mode: ChatMode;
}

/**
 * APPLY-GATING RULE (DEFECT 2 fix — an illustrative snippet must never be
 * one-click-applied to a guessed file).
 *
 * Apply/Reject are offered ONLY when BOTH hold:
 *   1. mode !== 'ask' — 'ask' is read-only Q&A (see ChatMode's doc comment
 *      in lib/models/types.ts): the user asked a question, not for an
 *      edit, so offering to write files back is surprising and dangerous
 *      on what is very often a partial/illustrative snippet. This is the
 *      PRIMARY signal (owner-verified refinement) — it hides Apply
 *      regardless of anything else about the block.
 *   2. targetPath is set — and it may ONLY ever come from the fenced
 *      block's own opening-line info string (an explicit, model-declared
 *      filename, e.g. "```tsx src/components/Foo.tsx"), NEVER from
 *      scanning the surrounding prose for something that looks like a
 *      path. The removed extractTargetPath() used to do exactly that —
 *      and CodeSpace.tsx's editor:applyEdit handler falls back to
 *      whatever file happens to be open (`req.path ?? activeTabPath`)
 *      whenever no path is supplied, so a guessed-and-missed target was
 *      not merely "wrong file", it silently retargeted the CURRENTLY
 *      OPEN file instead.
 *
 * Otherwise the block is Copy-only. Real edit/agent flows with a known
 * target (Ctrl+K inline-edit in InlineEditBar.tsx, ProblemsPanel's
 * autoFix) never go through this component at all — they call
 * editor:applyEdit directly with the real target from the active
 * editor/problem, entirely bypassing chat. This gate only concerns
 * code blocks rendered inside the assistant chat transcript.
 */
export function canOfferApply(mode: ChatMode, targetPath: string | undefined): boolean {
  return mode !== 'ask' && !!targetPath;
}

function CodeBlock({ language, code, targetPath, mode }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);
  const [rejected, setRejected] = useState(false);
  const { t } = useI18n();
  const canApply = canOfferApply(mode, targetPath);

  function handleApply() {
    // Defense in depth: the button is only rendered when canApply is true,
    // but re-check here too so this can never fire from a stale render.
    if (!canApply || !targetPath) return;
    emit('editor:applyEdit', {
      proposedContent: code,
      language,
      path: targetPath,
    });
    setApplied(true);
    setTimeout(() => setApplied(false), 2000);
  }

  function handleReject() {
    setRejected(true);
    setTimeout(() => setRejected(false), 1500);
  }

  function handleCopy() {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      style={{
        marginTop: 8,
        background: 'rgba(0,0,0,0.35)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 10px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.03)',
        }}
      >
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', fontFamily: 'var(--font-mono)' }}>
          {language}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={handleCopy}
            title={t('assistant.codeBlock.copy')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              color: copied ? '#66E27A' : 'rgba(255,255,255,0.35)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              padding: '2px 6px',
            }}
          >
            {copied ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <rect x="2" y="3" width="7" height="8" rx="1" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M4 3V2h4v1" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            )}
          </button>
          {canApply && (
            <>
              <button
                onClick={handleReject}
                style={{
                  fontSize: 10,
                  color: rejected ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.35)',
                  background: rejected ? 'rgba(255,255,255,0.06)' : 'transparent',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 4,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                  transition: 'all 0.15s',
                }}
              >
                {rejected ? '✕' : t('assistant.codeBlock.reject')}
              </button>
              <button
                onClick={handleApply}
                style={{
                  fontSize: 10,
                  color: applied ? '#66E27A' : 'var(--color-accent-light)',
                  background: applied ? 'rgba(102,226,122,0.15)' : 'rgba(124,92,255,0.15)',
                  border: `1px solid ${applied ? 'rgba(102,226,122,0.3)' : 'rgba(124,92,255,0.3)'}`,
                  borderRadius: 4,
                  padding: '2px 8px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                  transition: 'all 0.15s',
                }}
              >
                {applied ? t('assistant.codeBlock.applied') : t('assistant.codeBlock.apply')}
              </button>
            </>
          )}
        </div>
      </div>
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          fontSize: 11,
          lineHeight: 1.6,
          color: 'var(--color-text-dim)',
          fontFamily: 'var(--font-mono)',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── Thinking block (collapsible reasoning) ─────────────────────────
//
// Default expanded state follows streaming: open (live) while the turn is
// still streaming, collapsed to a one-line chip once it completes. A user
// click overrides that default for the rest of this message's lifetime.

function ThinkingBlock({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const { t } = useI18n();
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? isStreaming;

  if (!text.trim()) return null;

  return (
    <div data-testid="assistant-thinking" style={{ marginBottom: 8 }}>
      <button
        type="button"
        data-testid="assistant-thinking-toggle"
        onClick={() => setManualExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          background: 'transparent',
          border: 'none',
          padding: '2px 0',
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: isStreaming ? 'var(--color-accent-light)' : 'rgba(255,255,255,0.35)',
          fontSize: 10.5,
          fontWeight: 500,
        }}
      >
        <svg
          width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}
        >
          <path d="M3 1.5L6.5 4.5L3 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={isStreaming ? { animation: 'blink 1.4s ease-in-out infinite' } : undefined}>
          {isStreaming ? t('assistant.thinking.inProgress') : t('assistant.thinking.label')}
        </span>
      </button>
      {expanded && (
        <div
          data-testid="assistant-thinking-text"
          style={{
            marginTop: 3,
            marginLeft: 14,
            paddingLeft: 8,
            borderLeft: '2px solid rgba(255,255,255,0.08)',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'rgba(255,255,255,0.38)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

// ── Tool-call steps ─────────────────────────────────────────────

/** Extracts a named string field from a tool call's untyped input payload. */
function toolInputValue(input: unknown, key: string): string {
  if (!input || typeof input !== 'object' || !(key in input)) return '';
  return String((input as Record<string, unknown>)[key]);
}

/** Concise, i18n'd, argument-aware label for one tool-call step — covers
 *  every tool name reachable today (the 3 brain directives from
 *  brainSearchLoop.ts's describeBrainDirective + the 8 general directives
 *  from assistantToolLoop.ts's TOOL_DIRECTIVE_MAP), each paired with its
 *  real input key so the label shows what was searched/read/fetched, not
 *  just the tool name. Anything else falls back to "Tool: {name}" instead
 *  of a raw directive keyword like "WEB_FETCH:". */
function toolStepLabel(part: ToolPart, t: TFunction): string {
  switch (part.name) {
    case 'brain_search':
      return t('assistant.tool.brainSearch', { query: toolInputValue(part.input, 'query') });
    case 'brain_query_css':
      return t('assistant.tool.brainQueryCss', { value: toolInputValue(part.input, 'selector') });
    case 'brain_neighbours':
      return t('assistant.tool.brainNeighbours', { value: toolInputValue(part.input, 'id') });
    case 'web_search':
      return t('assistant.tool.webSearch', { value: toolInputValue(part.input, 'query') });
    case 'web_fetch':
      return t('assistant.tool.webFetch', { value: toolInputValue(part.input, 'url') });
    case 'read_file':
      return t('assistant.tool.readFile', { value: toolInputValue(part.input, 'path') });
    case 'read_dir':
      return t('assistant.tool.readDir', { value: toolInputValue(part.input, 'path') || '.' });
    case 'search_code':
      return t('assistant.tool.searchCode', { value: toolInputValue(part.input, 'pattern') });
    case 'git_status':
      return t('assistant.tool.gitStatus');
    case 'git_diff':
      return t('assistant.tool.gitDiff', { value: toolInputValue(part.input, 'path') });
    case 'git_log':
      return t('assistant.tool.gitLog', { value: toolInputValue(part.input, 'count') || '10' });
    default:
      return t('assistant.tool.generic', { name: part.name });
  }
}

/** Folds a tool result to a single display line — output can be multi-line
 *  (file contents, command/log output); already capped upstream (see
 *  assistantToolLoop.ts's `.slice(0, 160)`), this just guarantees ONE line. */
function formatResultSummary(summary: string): string {
  return summary.replace(/\s+/g, ' ').trim();
}

function ToolStatusIcon({ status }: { status: ToolPart['status'] }) {
  if (status === 'running') {
    return (
      <svg
        width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"
        style={{ animation: 'spin 0.8s linear infinite', transformOrigin: '50% 50%', flexShrink: 0 }}
      >
        <circle cx="5" cy="5" r="3.5" stroke="rgba(255,255,255,0.15)" strokeWidth="1.3" />
        <path d="M8.5 5A3.5 3.5 0 0 0 5 1.5" stroke="var(--color-accent-light)" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
        <circle cx="5" cy="5" r="3.8" stroke="#F87171" strokeWidth="1.2" />
        <line x1="5" y1="3" x2="5" y2="5.4" stroke="#F87171" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="5" cy="7" r="0.5" fill="#F87171" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M2 5.2l2 2 4-4.4" stroke="#66E27A" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolStepRow({ part }: { part: ToolPart }) {
  const { t } = useI18n();
  const label = toolStepLabel(part, t);
  // Concise one-line result under the label (e.g. "3 web results", a file
  // excerpt, an error message) — absent while running (no result yet).
  const result = part.resultSummary ? formatResultSummary(part.resultSummary) : '';
  return (
    <div
      data-testid="assistant-tool-step"
      data-status={part.status}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '2px 0', fontSize: 11, fontFamily: 'var(--font-mono)' }}
    >
      <span style={{ marginTop: 1 }}><ToolStatusIcon status={part.status} /></span>
      <div style={{ minWidth: 0, flex: 1, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
        <div style={{ color: part.status === 'error' ? '#F87171' : 'rgba(255,255,255,0.4)' }}>{label}</div>
        {result && (
          <div
            data-testid="assistant-tool-result"
            style={{ marginTop: 1, color: part.status === 'error' ? 'rgba(248,113,113,0.7)' : 'rgba(255,255,255,0.28)', fontSize: 10.5 }}
          >
            {result}
          </div>
        )}
      </div>
    </div>
  );
}

/** A single step renders inline (no collapse chrome); 2+ steps group under
 *  a collapsible "{n} steps" header, expanded while streaming and
 *  auto-collapsing once the turn completes (user click overrides). */
function ToolSteps({ parts, isStreaming }: { parts: ToolPart[]; isStreaming: boolean }) {
  const { t } = useI18n();
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? isStreaming;

  if (parts.length === 0) return null;

  if (parts.length === 1) {
    return (
      <div data-testid="assistant-tool-steps" style={{ marginBottom: 8 }}>
        <ToolStepRow part={parts[0]} />
      </div>
    );
  }

  return (
    <div data-testid="assistant-tool-steps" style={{ marginBottom: 8 }}>
      <button
        type="button"
        data-testid="assistant-tool-steps-toggle"
        onClick={() => setManualExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          background: 'transparent',
          border: 'none',
          padding: '2px 0',
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: 'rgba(255,255,255,0.35)',
          fontSize: 10.5,
          fontWeight: 500,
        }}
      >
        <svg
          width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}
        >
          <path d="M3 1.5L6.5 4.5L3 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{t('assistant.tool.stepsCount', { count: parts.length })}</span>
      </button>
      {expanded && (
        <div style={{ marginTop: 2, marginLeft: 14, paddingLeft: 8, borderLeft: '2px solid rgba(255,255,255,0.08)' }}>
          {parts.map(part => <ToolStepRow key={part.id} part={part} />)}
        </div>
      )}
    </div>
  );
}

// ── Message content renderer ──────────────────────────────────────
//
// NOTE: the old renderInlineCitations() and extractTargetPath()-from-prose
// helpers that used to live here are GONE. Citations are now handled by
// MarkdownRenderer's renderCitation hook (see AssistantMessage below) so
// they render correctly inside headings/lists/tables too, not just a flat
// paragraph. extractTargetPath was REMOVED outright (DEFECT 2) — see
// canOfferApply's doc comment above CodeBlock for why, and where a genuine
// target now comes from instead (the fence's own info string, never
// surrounding prose).

const NARRATION_LEAD_IN_RE = /^(je vais|laisse[- ]moi|let me|let's|i'll|i will|i'm going to)\b/i;
const MAX_TRIMMED_LINE_LENGTH = 100;

/**
 * DEFECT 3 (minor) — drops a single throwaway narration lead-in line
 * ("Je vais analyser…", "Let me check…") so the rendered markdown starts
 * on the real content. Conservative by design:
 * - Only ever applied to the FINAL (non-streaming) answer (see
 *   AssistantMessage) — a partial first line mid-stream is never mistaken
 *   for one.
 * - Requires the line to be followed by a blank-line paragraph break, i.e.
 *   a genuine standalone lead-in — never trims into a paragraph that
 *   simply BEGINS with one of these verbs and continues its thought on the
 *   next line.
 * - Requires the line to be short (<= 100 chars) — a real throwaway
 *   lead-in is a short sentence; a long opening paragraph that happens to
 *   start with "Let me" is real content and must be left alone.
 * Falls through to returning `content` unchanged whenever any of this
 * isn't cleanly true — losing real content would be far worse than an
 * occasional un-trimmed narration line.
 */
export function trimLeadingNarration(content: string): string {
  const newlineIndex = content.indexOf('\n');
  if (newlineIndex === -1) return content;

  const firstLine = content.slice(0, newlineIndex).trim();
  if (firstLine.length > MAX_TRIMMED_LINE_LENGTH || !NARRATION_LEAD_IN_RE.test(firstLine)) {
    return content;
  }

  const rest = content.slice(newlineIndex + 1);
  const restAfterBlank = rest.replace(/^\n+/, '');
  // No blank line right after — not a clean standalone lead-in, leave alone.
  if (restAfterBlank === rest) return content;

  return restAfterBlank;
}

// ── User message ──────────────────────────────────────────────────

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: '86%',
          background: 'rgba(124,92,255,0.14)',
          border: '1px solid rgba(124,92,255,0.22)',
          borderRadius: '10px 10px 3px 10px',
          padding: '8px 11px',
        }}
      >
        <p style={{ margin: 0, fontSize: 12, color: 'rgba(220,215,255,0.9)', lineHeight: 1.5, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
          {message.content}
        </p>
      </div>
    </div>
  );
}

// ── Assistant message ─────────────────────────────────────────────

function ErrorLabel() {
  const { t } = useI18n();
  return (
    <div
      data-testid="assistant-error"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        marginBottom: 6,
        fontSize: 10,
        color: '#F87171',
        fontWeight: 600,
        letterSpacing: '0.03em',
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M6 1L11 10H1L6 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
        <line x1="6" y1="5" x2="6" y2="7.5" stroke="currentColor" strokeWidth="1.2"/>
        <circle cx="6" cy="9" r="0.5" fill="currentColor"/>
      </svg>
      {t('common.error')}
    </div>
  );
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const isError = message.error === true;
  const isStreaming = message.isStreaming === true;
  // Mode this message was generated under — see ChatMessage.mode's doc
  // comment. Absent (historical/persisted messages) defaults to 'ask',
  // the safe Copy-only behavior — see canOfferApply above CodeBlock.
  const effectiveMode: ChatMode = message.mode ?? 'ask';

  // Thinking/tool-call steps (assistant chat, structured stream only — see
  // StreamPart's doc comment in types.ts). Both are empty/undefined for a
  // simple non-agentic completion, so nothing below renders and the
  // message looks exactly like it did before these existed.
  const thinkingPart = message.parts?.find((p): p is ThinkingPart => p.type === 'thinking');
  const toolPartsList = message.parts?.filter((p): p is ToolPart => p.type === 'tool') ?? [];
  const hasSteps = !!thinkingPart || toolPartsList.length > 0;

  const bubbleStyle = isError
    ? {
        flex: 1,
        background: 'rgba(248,113,113,0.08)',
        border: '1px solid rgba(248,113,113,0.45)',
        borderRadius: '3px 10px 10px 10px',
        padding: '9px 11px',
      }
    : {
        flex: 1,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid var(--color-border)',
        borderRadius: '3px 10px 10px 10px',
        padding: '9px 11px',
      };

  function renderContent() {
    if (isError) {
      return (
        <p style={{ margin: 0, fontSize: 12, color: 'rgba(215,212,228,0.9)', lineHeight: 1.6, overflowWrap: 'break-word', wordBreak: 'break-word' }}>
          {message.content}
        </p>
      );
    }

    if (message.content) {
      // The narration trim only ever runs on the FINAL answer — mid-stream
      // a still-arriving first line must never be mistaken for a complete
      // one (see trimLeadingNarration's doc comment).
      const displayContent = isStreaming ? message.content : trimLeadingNarration(message.content);
      const caret = isStreaming ? (
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 12,
            background: 'var(--color-accent)',
            marginLeft: 2,
            borderRadius: 1,
            animation: 'blink 0.8s step-end infinite',
            verticalAlign: 'text-bottom',
          }}
        />
      ) : undefined;

      return (
        <div style={{ fontSize: 12, color: 'rgba(215,212,228,0.9)', lineHeight: 1.6 }}>
          <MarkdownRenderer
            content={displayContent}
            trailingInline={caret}
            renderCitation={(ref, key) => <CitationChip key={key} nodeRef={ref} />}
            renderCodeBlock={(block: MarkdownCodeBlock, key: string) => (
              <CodeBlock
                key={key}
                language={block.language}
                code={block.code}
                targetPath={block.targetPath}
                mode={effectiveMode}
              />
            )}
          />
        </div>
      );
    }

    if (message.isStreaming) {
      // The thinking/tool-steps blocks (rendered above renderContent() in
      // the JSX below) already show live progress once they exist — avoid
      // double signaling with the generic dots placeholder in that case.
      // Falls through to the dots only while truly nothing has arrived yet
      // (e.g. waiting for the very first token).
      if (hasSteps) return null;
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {([0, 1, 2] as const).map(i => (
              <span
                key={i}
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: 'var(--color-accent)',
                  display: 'inline-block',
                  animation: `blink 1.2s step-end ${i * 0.4}s infinite`,
                  opacity: 0.7,
                }}
              />
            ))}
          </div>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontStyle: 'italic' }}>
            {t('assistant.workInProgress')}
          </span>
        </div>
      );
    }

    return (
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 12,
          background: 'var(--color-accent)',
          borderRadius: 1,
          animation: 'blink 0.8s step-end infinite',
        }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: 'linear-gradient(135deg,#7C5CFF,#9D7FFF)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: 1,
          boxShadow: '0 2px 8px rgba(124,92,255,0.35)',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ color: '#fff' }}>
          <path d="M5 0l1.2 3.8L10 5l-3.8 1.2L5 10 3.8 6.2 0 5l3.8-1.2z"/>
        </svg>
      </div>
      <div style={{ ...bubbleStyle, minWidth: 0, overflow: 'hidden' }}>
        {isError && <ErrorLabel />}
        {!isError && thinkingPart && <ThinkingBlock text={thinkingPart.text} isStreaming={isStreaming} />}
        {!isError && <ToolSteps parts={toolPartsList} isStreaming={isStreaming} />}
        {renderContent()}
        {!isError && message.interrupted && (
          <div
            data-testid="assistant-interrupted-marker"
            style={{ marginTop: 4, fontSize: 10.5, color: 'rgba(255,255,255,0.35)', fontStyle: 'italic' }}
          >
            {t('assistant.interruptedMarker')}
          </div>
        )}
        {!isError && message.codeBlock && !message.isStreaming && (
          <CodeBlock
            language={message.codeBlock.language}
            code={message.codeBlock.code}
            targetPath={message.codeBlock.targetPath}
            mode={effectiveMode}
          />
        )}
      </div>
    </div>
  );
}

// ── MessageList ───────────────────────────────────────────────────

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const { t } = useI18n();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '20px 16px',
          gap: 8,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 10 10" fill="rgba(255,255,255,0.2)">
          <path d="M5 0l1.2 3.8L10 5l-3.8 1.2L5 10 3.8 6.2 0 5l3.8-1.2z"/>
        </svg>
        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', textAlign: 'center', lineHeight: 1.6 }}>
          {t('assistant.emptyStateHintPrefix')}<strong>@</strong>{t('assistant.emptyStateHintSuffix')}
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px 12px 6px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {messages.map(msg =>
        msg.role === 'user' ? (
          <UserMessage key={msg.id} message={msg} />
        ) : (
          <AssistantMessage key={msg.id} message={msg} />
        )
      )}
      <div ref={bottomRef} />
    </div>
  );
}
