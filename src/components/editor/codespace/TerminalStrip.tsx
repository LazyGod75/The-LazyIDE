/* TerminalStrip — bottom expandable strip (terminal/problems/output/tests/
   ports), extracted verbatim in behavior from the pre-redesign
   CodeSpace.tsx's inline TerminalStrip.

   DEFECT 1 fix (terminal opening in the workspace parent instead of the
   active project) — this component now resolves a real `cwd` for every
   terminal session via resolveTerminalCwd.ts, preferring the open file's
   OWNING project (findOwningProject over AppContext's `openProjects`,
   exactly what CodeSpace.tsx already uses for the status bar/banner/colors
   — no new state invented) and falling back to AppContext's `projectRoot`
   (the left-rail active project) when no file is open yet.

   DEFECT 2 fix (zero terminal controls — one shell for the whole session,
   no new/close/switch) — this strip now holds a small array of terminal
   `sessions`, each its own real PTY (TerminalView instance), with a tab row
   to switch between them, a "+" to spawn another (in the CURRENT active
   project's cwd), and a "×" to close one. Every session is labelled with
   its cwd's basename so defect 1's fix is actually visible per-tab.

   Sessions are mounted unconditionally (visibility toggled via CSS
   `display`, never a conditional `{cond && <TerminalView/>}`) so switching
   to the Problems/Output/Tests/Ports tab — or collapsing the strip — never
   unmounts a running shell; TerminalView's own cleanup effect is the ONLY
   thing that ever calls `pty.kill()`, so a session is torn down (and its
   pty actually reaped, see that file's leak-fix doc comment) exactly once,
   only when the user explicitly closes it or the whole space unmounts.
*/

import { useCallback, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useEditorStore } from '../editorStore';
import { useAppContext } from '../../../app/AppContext';
import { TerminalView } from '../../terminal/TerminalView';
import { ProblemsPanel as ProblemsPanelComponent } from '../ProblemsPanel';
import { TestsPanel } from '../TestsPanel';
import { PortForwardingPanel } from '../../platform/PortForwardingPanel';
import { emit } from '../../../lib/bus';
import { findOwningProject } from '../../../lib/agents/projectForPath';
import { resolveTerminalCwd } from '../../../lib/terminal/resolveTerminalCwd';
import { basename, stripVerbatimPrefix } from '../../../lib/paths';

type StripTab = 'terminal' | 'problemes' | 'sortie' | 'tests' | 'ports';

const STRIP_TAB_KEYS: Array<{ id: StripTab; labelKey: string }> = [
  { id: 'terminal', labelKey: 'code.strip.terminal' },
  { id: 'problemes', labelKey: 'code.strip.problems' },
  { id: 'sortie', labelKey: 'code.strip.output' },
  { id: 'tests', labelKey: 'code.strip.tests' },
  { id: 'ports', labelKey: 'code.strip.ports' },
];

const STRIP_COLLAPSED_HEIGHT = 38;

// ── Terminal sessions ────────────────────────────────────────────────

interface TerminalSession {
  readonly id: string;
  /** Captured at CREATION time only (see resolvedCwd usage below) — an
   *  already-running session's cwd never changes after the fact just
   *  because the user opens a different file/project; only a freshly
   *  spawned session picks up whatever is active right now. Respawning a
   *  live shell out from under the user because they clicked a different
   *  tab would be its own, worse bug. */
  readonly cwd: string | undefined;
}

let terminalSessionSeq = 0;

function createTerminalSession(cwd: string | undefined): TerminalSession {
  terminalSessionSeq += 1;
  return { id: `code-strip-term-${terminalSessionSeq}`, cwd };
}

/** Short, legible per-tab label — the whole point of labelling sessions at
 *  all (per defect 2) is to make defect 1's fix visible: which project each
 *  open terminal actually lives in. Mirrors TerminalNode.tsx's
 *  shortTerminalTitle (verbatim-prefix stripped, basename only). */
function terminalSessionLabel(cwd: string | undefined, noCwdLabel: string): string {
  if (!cwd) return noCwdLabel;
  return basename(stripVerbatimPrefix(cwd));
}

export function TerminalStrip({ height }: { height: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<StripTab>('terminal');
  const { diagnostics, activeTabPath } = useEditorStore();
  const { platform, projectRoot, openProjects } = useAppContext();

  // Authoritative "active project" for a NEW terminal: the open file's
  // owning project first (most specific — matches what the user is looking
  // at), AppContext's app-wide projectRoot otherwise. Both are state the
  // app already tracks (CodeSpace.tsx derives the exact same
  // activeFileProject via this same findOwningProject call for its status
  // bar/banner) — nothing new invented here.
  const activeFileProject = activeTabPath ? findOwningProject(activeTabPath, openProjects) : null;
  const resolvedCwd = resolveTerminalCwd({
    activeFileProjectRoot: activeFileProject?.root,
    fallbackProjectRoot: projectRoot,
  });

  const [sessions, setSessions] = useState<TerminalSession[]>(() => [createTerminalSession(resolvedCwd)]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => sessions[0].id);

  const handleNewTerminal = useCallback(() => {
    const session = createTerminalSession(resolvedCwd);
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }, [resolvedCwd]);

  // Both state updates happen together, synchronously, in this one event
  // handler (React 18 batches them into a single render) — reading `sessions`
  // straight from render scope rather than via a setState updater function,
  // and never reconciling `activeSessionId` in a separate effect: an effect
  // that calls setState purely to patch up another piece of state after the
  // fact is exactly the "cascading render" antipattern React's own
  // react-hooks/set-state-in-effect rule flags.
  const handleCloseTerminal = useCallback((id: string) => {
    // Always keep at least one terminal — same convention TerminalsSpace.tsx
    // already establishes (closing the last one would leave the tab with no
    // way to spawn a fresh shell short of the "+" button, which still works,
    // but an empty terminal tab reads as broken rather than "closed").
    if (sessions.length <= 1) return;
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (activeSessionId === id) {
      const neighborIdx = Math.min(idx, next.length - 1);
      setActiveSessionId(next[neighborIdx].id);
    }
  }, [sessions, activeSessionId]);

  const stripHeight = expanded ? height : STRIP_COLLAPSED_HEIGHT;

  return (
    <div
      style={{
        height: stripHeight,
        borderTop: '1px solid rgba(255,255,255,0.07)',
        background: 'var(--color-panel-3)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <div style={{ height: STRIP_COLLAPSED_HEIGHT, minHeight: STRIP_COLLAPSED_HEIGHT, display: 'flex', alignItems: 'stretch', borderBottom: expanded ? '1px solid rgba(255,255,255,0.07)' : 'none', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'stretch', borderRight: '1px solid var(--color-border-2)' }}>
          {STRIP_TAB_KEYS.map(tab => {
            const isActive = tab.id === activeTab;
            const badge = tab.id === 'problemes' && diagnostics.length > 0 ? diagnostics.length : null;
            return (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); if (!expanded) setExpanded(true); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '0 14px', fontSize: 11,
                  color: isActive ? '#D5D8E0' : 'rgba(255,255,255,0.3)',
                  background: isActive ? 'var(--color-panel)' : 'transparent',
                  border: 'none', borderTop: `2px solid ${isActive ? '#7C5CFF' : 'transparent'}`,
                  cursor: 'pointer', fontWeight: isActive ? 500 : undefined, fontFamily: 'inherit',
                }}
              >
                {t(tab.labelKey)}
                {badge !== null && (
                  <span style={{ background: '#F07178', color: '#fff', borderRadius: 8, fontSize: 9, padding: '0 4px', lineHeight: '14px', fontWeight: 600 }}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Terminal controls (defect 2): session switcher + new terminal —
            only meaningful while the terminal sub-tab itself is showing. */}
        {expanded && activeTab === 'terminal' && (
          <div style={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto', borderRight: '1px solid var(--color-border-2)' }}>
            {sessions.map((session) => {
              const isActiveSession = session.id === activeSessionId;
              const label = terminalSessionLabel(session.cwd, t('canvas.terminal.noCwd'));
              return (
                <div
                  key={session.id}
                  title={session.cwd ? stripVerbatimPrefix(session.cwd) : t('canvas.terminal.noCwd')}
                  style={{
                    display: 'flex', alignItems: 'center', flexShrink: 0,
                    background: isActiveSession ? 'rgba(124,92,255,0.1)' : 'transparent',
                    borderBottom: `2px solid ${isActiveSession ? '#7C5CFF' : 'transparent'}`,
                  }}
                >
                  <button
                    onClick={() => setActiveSessionId(session.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px 0 12px', fontSize: 11,
                      color: isActiveSession ? '#D5D8E0' : 'rgba(255,255,255,0.4)',
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      fontFamily: 'var(--font-mono)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleCloseTerminal(session.id); }}
                    disabled={sessions.length <= 1}
                    title={t('terminals.close')}
                    aria-label={t('terminals.close')}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, marginRight: 6,
                      fontSize: 10, color: sessions.length <= 1 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.3)',
                      background: 'transparent', border: 'none', borderRadius: 4,
                      cursor: sessions.length <= 1 ? 'default' : 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              onClick={handleNewTerminal}
              title={t('terminals.newTerminal')}
              aria-label={t('terminals.newTerminal')}
              style={{
                display: 'flex', alignItems: 'center', padding: '0 12px', fontSize: 14, lineHeight: 1,
                color: 'rgba(255,255,255,0.35)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              +
            </button>
          </div>
        )}

        <div style={{ flex: 1 }} />

        <button
          onClick={() => setExpanded(prev => !prev)}
          title={expanded ? t('code.collapseTerminal') : t('code.expandTerminal')}
          style={{
            display: 'flex', alignItems: 'center', padding: '0 14px', fontSize: 13, color: 'rgba(255,255,255,0.35)',
            cursor: 'pointer', background: 'transparent', border: 'none',
            transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 150ms ease',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Terminal sessions are ALWAYS mounted (never conditionally rendered
          on `expanded`/`activeTab`) — only their visibility toggles via CSS
          `display`. Switching to Problems/Output/Tests/Ports, or collapsing
          the strip, must never kill a running shell; only an explicit "×"
          (handleCloseTerminal) or this component unmounting does that, via
          TerminalView's own cleanup effect (real pty.kill(), no orphaned
          process — see that file's leak-fix doc comment). */}
      <div style={{ flex: expanded ? 1 : 0, overflow: 'hidden', display: expanded && activeTab === 'terminal' ? 'flex' : 'none' }}>
        {sessions.map((session) => (
          <div key={session.id} style={{ display: session.id === activeSessionId ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
            <TerminalView terminalId={session.id} cwd={session.cwd} />
          </div>
        ))}
      </div>

      {expanded && activeTab === 'problemes' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
          <ProblemsPanelComponent onFileOpen={(path) => emit('editor:openFile', { path })} />
        </div>
      )}
      {expanded && activeTab === 'sortie' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.15)', fontSize: 12 }}>
          {t('code.noOutput')}
        </div>
      )}
      {expanded && activeTab === 'tests' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
          <TestsPanel platform={platform} projectRoot={projectRoot} />
        </div>
      )}
      {expanded && activeTab === 'ports' && (
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
          <PortForwardingPanel />
        </div>
      )}
    </div>
  );
}
