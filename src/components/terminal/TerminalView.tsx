/* TerminalView — xterm.js terminal wired to the platform PTY.
   Props: terminalId (optional, used for multi-terminal cases)
   Mounts xterm in a container, fits on resize, connects I/O to the PTY.
   Under Tauri this is a real portable-pty process spawned via Rust
   (see src/lib/platform/tauri.ts). Only the browser/Playwright preview
   (src/lib/platform/web.ts) falls back to an in-memory mock shell.
*/

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getPlatform } from '../../lib/platform';
import { useTerminalAi } from '../../lib/ai/terminalAi';
import { recordTerminalInput, recordTerminalOutput } from '../../lib/terminal/history';
import { stripVerbatimPrefix } from '../../lib/paths';
import { useI18n } from '../../i18n';
import { useToastSafe } from '../ui';

/** Extracts a human-readable reason from an arbitrary rejection value.
 *  Tauri's `invoke()` rejects with whatever the Rust command's `Err(...)`
 *  carries — a plain STRING (not an `Error`), so `String(error)` is what
 *  actually surfaces here in practice; `Error` is handled too for any
 *  future/web-platform rejection shape. Never returns an empty string (a
 *  rejection with no usable reason still gets a generic fallback) so the
 *  toast this feeds is never blank. */
function describeSpawnError(error: unknown): string {
  if (error instanceof Error) return error.message || 'unknown error';
  if (typeof error === 'string' && error.length > 0) return error;
  return 'unknown error';
}

// ── Xterm theme matching design system tokens ─────────────────────

const XTERM_THEME = {
  background: '#0E0E12',
  foreground: '#E6E8EF',
  cursor: '#7C5CFF',
  cursorAccent: '#0E0E12',
  selectionBackground: 'rgba(124, 92, 255, 0.28)',
  selectionForeground: '#E6E8EF',
  // ANSI palette — tasteful, not garish
  black: '#1C1C24',
  red: '#FF6B6B',
  green: '#66E27A',
  yellow: '#FFC76B',
  blue: '#7C5CFF',
  magenta: '#FF7BB0',
  cyan: '#4FC3F7',
  white: '#D5D8E0',
  brightBlack: '#4A4A5A',
  brightRed: '#FF8585',
  brightGreen: '#80EE94',
  brightYellow: '#FFD685',
  brightBlue: '#A78BFF',
  brightMagenta: '#FFB0CC',
  brightCyan: '#76D6F9',
  brightWhite: '#E6E8EF',
};

// ── Component ─────────────────────────────────────────────────────

interface TerminalViewProps {
  /** Unique identifier — used for logging or future PTY registry */
  terminalId?: string;
  /** Working directory for the PTY */
  cwd?: string;
  /**
   * fix/canvas-legibility — additive, optional activity signal: called with
   * the byte length of every chunk the PTY writes (same `pty.onData`
   * handler that already feeds `recordTerminalOutput`/xterm, just also
   * reported up to the caller). NOT a replacement for
   * `lib/terminal/history.ts`'s `recordTerminalOutput` — that buffer is
   * module-level/global (a single `outputBuffer`, not keyed by
   * terminalId — confirmed in that file), so it cannot answer "did THIS
   * terminal node produce output" for a canvas with multiple terminal
   * surfaces. This prop is the honest per-instance alternative:
   * TerminalNode.tsx uses it to decide whether an idle-looking pane still
   * carries a live shell worth showing at full size.
   */
  onActivity?: (bytes: number) => void;
}

export function TerminalView({ terminalId: _terminalId, cwd, onActivity }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  // fix/canvas-legibility — read via a ref (not a spawn-effect dependency):
  // a caller-supplied inline callback churns identity every render, and
  // this effect spawns the real PTY — including it in the dependency array
  // would respawn/kill the shell on every unrelated re-render, exactly the
  // "PTY must never die" constraint this file's own header already commits
  // to for cwd. Same idiom as the pre-existing `t`/`toast` exclusion below.
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  // True from mount until the PTY spawn settles (either attaches or fails —
  // the failure path already writes its own message into the xterm buffer,
  // see the `.catch()` below). Without this, the strip between "tab opened"
  // and "spawn resolved" rendered as a dead black rectangle — no prompt, no
  // cursor, no indication a shell was even being started (see this file's
  // own #0E0E12 background, otherwise indistinguishable from "broken").
  const [isSpawning, setIsSpawning] = useState(true);
  const [showAiBar, setShowAiBar] = useState(false);
  const [aiQuery, setAiQuery] = useState('');
  const [aiResult, setAiResult] = useState<string | null>(null);
  const { suggestCommand, explainOutput, isThinking } = useTerminalAi();
  const { t } = useI18n();
  const toast = useToastSafe();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Root-cause fix (thread/handle leak, 2026-07-24): `platform.terminal
    // .spawn()` below is ASYNC — if this effect's cleanup runs (unmount, or
    // `cwd` changing) BEFORE that promise resolves, `cleanupRef.current` is
    // still null at that point (it is only assigned inside the `.then()`),
    // so the cleanup below has nothing to call and the in-flight spawn's
    // PTY is silently orphaned once it DOES resolve: nothing ever calls
    // `pty.kill()` on it, permanently leaking that terminal_spawn call's
    // Rust-side child process (powershell.exe/conhost.exe) plus its reader
    // and exit-watchdog OS threads. A component that mounts/unmounts (or
    // changes `cwd`) faster than a real PTY spawn round-trips leaks one
    // full PTY per cycle this way — observed live as ~100 threads/min and
    // ~500 handles/min growth on an otherwise idle app. `cancelled` is
    // checked in the `.then()` below to kill a late-arriving PTY instead of
    // attaching it to an xterm instance that no longer exists.
    let cancelled = false;
    setIsSpawning(true);

    // ── Create xterm instance ───────────────────────────────────
    const xterm = new Terminal({
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: true,
      scrollback: 2000,
    });
    xtermRef.current = xterm;

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(container);

    try {
      fitAddon.fit();
    } catch {
      // may throw if dimensions are 0 during mount
    }

    // ── Spawn PTY (real portable-pty under Tauri, mock shell in web preview) ──
    // Strip Windows' verbatim "\\?\" prefix before it reaches the PTY: Rust's
    // canonicalize() (the usual source of `cwd`, via AppContext's
    // projectRoot) returns that prefix on Windows, and passing it straight
    // through leaked it into the spawned shell's own prompt (visible,
    // e.g., as `PS \\?\C:\...\>` in PowerShell). Display-only — the
    // verbatim path is still what's stored/keyed everywhere else.
    const spawnCwd = cwd ? stripVerbatimPrefix(cwd) : cwd;
    const platform = getPlatform();
    platform.terminal.spawn('sh', [], { cwd: spawnCwd }).then(pty => {
      if (cancelled) {
        // This effect was already torn down before the spawn resolved (see
        // this effect's own doc comment above) — the component has no live
        // xterm/cleanupRef to attach this PTY to, so kill it immediately
        // rather than orphaning the child process + its reader/watchdog
        // threads forever.
        pty.kill();
        return;
      }
      setIsSpawning(false);
      // PTY → xterm
      const unsubData = pty.onData(data => {
        recordTerminalOutput(data);
        onActivityRef.current?.(data.length);
        xterm.write(data);
      });

      // xterm → PTY
      const dataDispose = xterm.onData(data => {
        recordTerminalInput(data);
        pty.write(data);
      });

      // Store combined cleanup
      cleanupRef.current = () => {
        unsubData();
        dataDispose.dispose();
        pty.kill();
      };
    }).catch((error: unknown) => {
      // R10 fix — this used to have no `.catch()` at all: a rejected spawn
      // (e.g. the Rust side's `resolve_spawn_cwd` refusing a `cwd` that does
      // not exist / is not a directory — src-tauri/src/commands/terminal.rs)
      // surfaced as an UNHANDLED promise rejection instead of a user-visible
      // failure, observed live as a pageerror whose value was the cwd/reason
      // string. Handled honestly here: written into the xterm pane itself
      // (a real shell would show its own spawn failure the same way) AND
      // toasted, never silently swallowed.
      const reason = describeSpawnError(error);
      xterm.write(`\r\n\x1b[31m${t('terminal.spawnFailed', { reason })}\x1b[0m\r\n`);
      toast(t('terminal.spawnFailed', { reason }), 'error');
      if (!cancelled) setIsSpawning(false);
    });

    // ── ResizeObserver → fit + notify PTY ──────────────────────
    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore resize errors while detaching
      }
    });
    observer.observe(container);

    // ── Cleanup on unmount ──────────────────────────────────────
    return () => {
      cancelled = true;
      observer.disconnect();

      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }

      xterm.dispose();
    };
    // t/toast are i18n/toast callbacks (stable in practice — useToastSafe's
    // real toast() is memoized by ToastProvider); re-running this whole
    // effect (which tears down and respawns the PTY) on their identity
    // churn would kill a live shell session for no reason. Only `cwd`
    // should ever re-spawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const handleAiSuggest = async () => {
    if (!aiQuery.trim() || !xtermRef.current) return;
    setAiResult(null);
    const buffer = xtermRef.current.buffer.active;
    const lines: string[] = [];
    for (let i = Math.max(0, buffer.length - 50); i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    const result = await suggestCommand(aiQuery, lines.join('\n'));
    if (result.suggestion) setAiResult(result.suggestion);
    else if (result.error) setAiResult(`Error: ${result.error}`);
  };

  const handleExplain = async () => {
    if (!xtermRef.current) return;
    setAiResult(null);
    const buffer = xtermRef.current.buffer.active;
    const lines: string[] = [];
    for (let i = Math.max(0, buffer.length - 50); i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    const result = await explainOutput(lines.join('\n'));
    if (result.suggestion) setAiResult(result.suggestion);
    else if (result.error) setAiResult(`Error: ${result.error}`);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {showAiBar && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'rgba(124,92,255,0.06)', borderBottom: '1px solid rgba(124,92,255,0.15)', flexShrink: 0 }}>
          <input
            value={aiQuery}
            onChange={e => setAiQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAiSuggest(); }}
            placeholder="Ask AI for a command..."
            style={{ flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, padding: '3px 8px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
          />
          <button onClick={handleAiSuggest} disabled={isThinking} style={{ background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 4, padding: '3px 8px', color: '#A78BFF', cursor: isThinking ? 'wait' : 'pointer', fontSize: 10, fontFamily: 'inherit' }}>
            {isThinking ? '...' : 'Suggest'}
          </button>
          <button onClick={handleExplain} disabled={isThinking} style={{ background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 4, padding: '3px 8px', color: '#A78BFF', cursor: isThinking ? 'wait' : 'pointer', fontSize: 10, fontFamily: 'inherit' }}>
            Explain
          </button>
          <button onClick={() => setShowAiBar(false)} style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
        </div>
      )}
      {aiResult && (
        <div style={{ padding: '4px 8px', fontSize: 11, color: 'rgba(255,255,255,0.6)', background: 'rgba(124,92,255,0.04)', borderBottom: '1px solid rgba(124,92,255,0.1)', flexShrink: 0, maxHeight: 80, overflowY: 'auto' }}>
          {aiResult}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 6px', background: '#0E0E12', flexShrink: 0 }}>
        <button onClick={() => setShowAiBar(!showAiBar)} style={{ background: 'transparent', border: 'none', color: showAiBar ? '#A78BFF' : 'rgba(255,255,255,0.2)', cursor: 'pointer', fontSize: 10, fontFamily: 'inherit', padding: '2px 4px' }}>
          ✨ AI
        </button>
      </div>
      <div style={{ flex: 1, width: '100%', position: 'relative', background: '#0E0E12', overflow: 'hidden' }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
        {isSpawning && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(255,255,255,0.25)',
              fontSize: 12,
              pointerEvents: 'none',
            }}
          >
            {t('terminal.starting')}
          </div>
        )}
      </div>
    </div>
  );
}
