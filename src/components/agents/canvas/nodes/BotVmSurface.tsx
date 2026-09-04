/* BotVmSurface — the "connected window" of a LazyBot: a live view of what is
   happening inside its Solari VM/session (browser screenshot+URL, or the
   desktop noVNC stream), with an Enlarge (fullscreen) toggle and a Takeover
   button so the human can interact directly (login/2FA/captcha).
*/

import { useEffect, useRef, useState } from 'react';
import { subscribeBotVmState, openDesktopStream, openBrowserTakeover, getLastBotVmState, type BotVmState } from '../../../../lib/solari/botVmState';
import { mountLiveDesktop, type LiveDesktopViewer } from '../../../../lib/solari/desktopViewer';
import type { CdpPage } from '../../../../lib/solari/cdpBrowser';
import {
  startTeachSession,
  recordTeachStep,
  endTeachSession,
  isTeachModeActive,
} from '../../../../lib/bots/teachMode';
import { compileSkillOverlay } from '../../../../lib/bots/skillCompiler';
import { applyTeachSkillToPersona } from '../../../../lib/bots/applyTeachSkill';
import { emit } from '../../../../lib/bus';

interface BotVmSurfaceProps {
  botId: string;
}

export function BotVmSurface({ botId }: BotVmSurfaceProps) {
  // Initialize from the last known state so the screenshot appears immediately
  // on mount (the canvas node may mount AFTER the bot already navigated —
  // the floating window never had this problem because it stayed mounted).
  const [state, setState] = useState<BotVmState | null>(() => getLastBotVmState(botId) ?? null);
  const [stream, setStream] = useState<{ streamUrl: string; token?: string } | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [teaching, setTeaching] = useState(false);
  const [skillDraft, setSkillDraft] = useState<string | null>(null);
  const [browserFrame, setBrowserFrame] = useState<string | null>(null);
  const takeoverPageRef = useRef<CdpPage | null>(null);
  const streamHostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<LiveDesktopViewer | null>(null);

  // Mount the live noVNC client into the host div whenever a desktop stream
  // becomes available (Takeover). NoVNC is loaded lazily via mountLiveDesktop.
  useEffect(() => {
    if (!stream?.streamUrl) return;
    const host = streamHostRef.current;
    if (!host) return;
    let disposed = false;
    host.innerHTML = '';
    setStreamError(null);
    mountLiveDesktop(host, stream.streamUrl, { viewOnly: false })
      .then((viewer) => {
        if (disposed) {
          viewer.disconnect();
          return;
        }
        viewerRef.current = viewer;
      })
      .catch((err) => {
        if (!disposed) setStreamError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
      viewerRef.current?.disconnect();
      viewerRef.current = null;
      if (host) host.innerHTML = '';
    };
  }, [stream]);

  useEffect(() => {
    const off = subscribeBotVmState(botId, (s) => {
      setState(s);
      // While teaching, journal every action as a demonstration step.
      if (isTeachModeActive(botId) && s.lastAction) {
        const url = s.url;
        if (url) recordTeachStep(botId, { kind: 'navigate', target: url, selector: url });
        if (s.screenshotDataUrl) recordTeachStep(botId, { kind: 'screenshot', target: 'page' });
        if (s.lastAction) recordTeachStep(botId, { kind: 'note', target: s.lastAction, note: s.lastAction });
      }
    });
    return off;
  }, [botId]);

  const handleTeach = () => {
    if (teaching) {
      const journal = endTeachSession(botId);
      setTeaching(false);
      if (journal && journal.steps.length > 0) {
        const overlay = compileSkillOverlay(journal);
        setSkillDraft(overlay);
        void applyTeachSkillToPersona(botId, overlay).then((saved) => {
          if (saved) emit('lazybots:changed', { botId });
        });
      } else {
        setSkillDraft('No steps were recorded — perform the task while teaching is active, then stop.');
      }
    } else {
      startTeachSession(botId, `Skill ${new Date().toLocaleTimeString()}`);
      setTeaching(true);
      setSkillDraft(null);
    }
  };

  const handleTakeover = async () => {
    setStreamError(null);
    const browser = await openBrowserTakeover(botId);
    if (!('error' in browser)) {
      takeoverPageRef.current = browser.page;
      const stop = await browser.page.startScreencast((dataUrl) => setBrowserFrame(dataUrl));
      takeoverPageRef.current = browser.page;
      void stop;
      return;
    }
    const res = await openDesktopStream(botId);
    if ('error' in res) setStreamError(res.error);
    else setStream(res);
  };

  const handleBrowserClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    const page = takeoverPageRef.current;
    if (!page) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) * (img.naturalWidth || rect.width)) / rect.width;
    const y = ((e.clientY - rect.top) * (img.naturalHeight || rect.height)) / rect.height;
    await page.clickAt(x, y);
  };

  const url = state?.url;
  const shot = state?.screenshotDataUrl;

  const body = (
    <div style={S.surface} data-testid="bot-vm-surface">
      <div style={S.topbar}>
        <span style={S.mode}>{browserFrame ? 'Browser (CDP)' : state?.mode === 'desktop' || stream ? 'Desktop (noVNC)' : 'Browser'}</span>
        {state?.url && <span style={S.url} title={state.url}>{state.url}</span>}
        <span style={S.spacer} />
        <button data-testid="bot-vm-takeover" onClick={handleTakeover} style={S.takeover}>
          Takeover
        </button>
        <button data-testid="bot-vm-teach" onClick={handleTeach} style={teaching ? S.teachActive : S.teach}>
          {teaching ? '● Stop & Compile' : 'Teach (record → skill)'}
        </button>
        <button data-testid="bot-vm-enlarge" onClick={() => setFullscreen((f) => !f)} style={S.enlarge}>
          {fullscreen ? 'Exit' : 'Enlarge'}
        </button>
      </div>

      {skillDraft && (
        <div style={S.skillDraft}>
          <div style={S.skillDraftTitle}>Skill saved into this bot's system prompt (editable below)</div>
          <textarea
            style={S.skillDraftTextarea}
            rows={8}
            defaultValue={skillDraft}
            aria-label="Skill draft"
          />
        </div>
      )}

      {streamError && <div style={S.error}>Stream failed: {streamError}</div>}

      {stream ? (
        <div
          ref={streamHostRef}
          data-testid="bot-vm-desktop"
          style={S.desktopHost}
        />
      ) : browserFrame ? (
        <div style={S.shotWrap} data-testid="bot-vm-cdp-takeover">
          <img src={browserFrame} alt="Bot browser takeover" style={S.shot} onClick={(e) => void handleBrowserClick(e)} />
          {url && <div style={S.urlBar}>{url}</div>}
        </div>
      ) : shot ? (
        <div style={S.shotWrap}>
          <img src={shot} alt="Bot VM screenshot" style={S.shot} />
          {url && <div style={S.urlBar}>{url}</div>}
        </div>
      ) : (
        <div style={S.empty}>
          No live view yet — the bot has not started a session.
          <br />
          <button onClick={handleTakeover} style={S.takeover}>Start noVNC (desktop)</button>
        </div>
      )}
    </div>
  );

  if (fullscreen) {
    return (
      <div style={S.fullscreen} data-testid="bot-vm-fullscreen">
        {body}
      </div>
    );
  }
  return body;
}

const S = {
  surface: {
    display: 'flex', flexDirection: 'column' as const,
    background: '#0E0E14', border: '1px solid rgba(124,92,255,0.25)',
    borderRadius: 10, overflow: 'hidden', height: '100%', minHeight: 200,
  },
  fullscreen: {
    position: 'fixed' as const, inset: 0, zIndex: 9999,
    background: '#05050A', padding: 12, display: 'flex',
    flexDirection: 'column' as const,
  },
  topbar: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    background: '#16161D', flexShrink: 0, flexWrap: 'wrap' as const,
  },
  mode: { fontSize: 12, fontWeight: 600, color: '#B8A9FF' },
  url: { fontSize: 11, color: '#9994B8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: 260 },
  spacer: { flex: 1 },
  takeover: {
    padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
    background: 'rgba(255,183,107,0.12)', border: '1px solid rgba(255,183,107,0.4)', color: '#FFB86B',
  },
  enlarge: {
    padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
    background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.4)', color: '#B8A9FF',
  },
  teach: {
    padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
    background: 'rgba(102,226,122,0.12)', border: '1px solid rgba(102,226,122,0.4)', color: '#66E27A',
  },
  teachActive: {
    padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700,
    background: 'rgba(255,107,107,0.18)', border: '1px solid rgba(255,107,107,0.5)', color: '#FF6B6B',
  },
  skillDraft: { padding: 8, borderTop: '1px solid rgba(124,92,255,0.2)' },
  skillDraftTitle: { fontSize: 11, color: '#B8A9FF', marginBottom: 6 },
  skillDraftTextarea: {
    width: '100%', boxSizing: 'border-box' as const, minHeight: 140,
    background: '#0E0E14', border: '1px solid rgba(124,92,255,0.25)', borderRadius: 8,
    color: '#E2E2F0', fontSize: 12, fontFamily: 'monospace', padding: 8, resize: 'vertical' as const,
  },
  iframe: { flex: 1, width: '100%', border: 'none', background: '#000' },
  desktopHost: { flex: 1, width: '100%', minHeight: 0, background: '#000', overflow: 'hidden' },
  shotWrap: { flex: 1, position: 'relative' as const, minHeight: 0, background: '#000' },
  shot: { width: '100%', height: '100%', objectFit: 'contain' as const, display: 'block' },
  urlBar: {
    position: 'absolute' as const, bottom: 6, left: 6, right: 6,
    background: 'rgba(0,0,0,0.7)', color: '#E2E2F0', fontSize: 11,
    padding: '4px 8px', borderRadius: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  empty: { flex: 1, color: '#9994B8', fontSize: 12, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16, textAlign: 'center' as const },
  error: { color: '#FF6B6B', fontSize: 12, padding: '6px 10px' },
};
