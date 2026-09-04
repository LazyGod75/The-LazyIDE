/* CodeSidebarBrain — "🧠 BRAIN — FICHIER ACTIF" + "RÈGLE DU MANAGER"
   sidebar sections (design-code.md §4.4/§4.5). Both derive from real data
   only:
     - neurons: brain.tree()'s project→module→file hierarchy, matched
       against the active file's relative path/basename. No fabricated
       "lu 3×" counts (that per-neuron usage field doesn't exist anywhere in
       the real Brain types) — only name + real node type/id are shown.
     - manager note: the real scheduler.queued/scope_conflict journal signal
       (see lib/agents/managerNote.ts). Omitted entirely when no such event
       exists for the project — never a static placeholder.
*/

import { useEffect, useState } from 'react';
import type { Platform } from '../../../lib/platform/types';
import type { BrainTreeNode } from '../../../lib/platform/types';
import type { FleetMission } from '../../../lib/agents/fleetMissions';
import { loadManagerNote, type ManagerNoteData } from '../../../lib/agents/managerNote';
import { basenameOf } from '../../../lib/agents/codeFileActivity';
import { relativeToRoot } from './fileTree';
import { useI18n } from '../../../i18n';
import { useToast } from '../../ui';
import { BrainIcon } from '../../icons';

interface BrainNeuronMatch {
  label: string;
  type: string | null;
  id: string;
}

function findNodeForFile(nodes: BrainTreeNode[], relPath: string, filename: string): BrainNeuronMatch | null {
  for (const node of nodes) {
    if (node.noteId && (node.label === filename || node.label === relPath || relPath.endsWith(node.label))) {
      return { label: node.label, type: node.type, id: node.noteId };
    }
    const found = findNodeForFile(node.children, relPath, filename);
    if (found) return found;
  }
  return null;
}

interface CodeSidebarBrainProps {
  platform: Platform;
  activeFilePath: string | null;
  activeFileRoot: string | null;
  onOpenNeuron: (noteId: string) => void;
}

export function CodeSidebarBrain({ platform, activeFilePath, activeFileRoot, onOpenNeuron }: CodeSidebarBrainProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [neuron, setNeuron] = useState<BrainNeuronMatch | null | undefined>(undefined);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!activeFilePath || !activeFileRoot) { setNeuron(undefined); return; }
    let cancelled = false;
    const relPath = relativeToRoot(activeFileRoot, activeFilePath);
    const filename = basenameOf(activeFilePath);
    platform.brain.tree()
      .then((tree) => { if (!cancelled) setNeuron(findNodeForFile(tree.projects, relPath, filename)); })
      .catch(() => { if (!cancelled) setNeuron(null); });
    return () => { cancelled = true; };
  }, [platform, activeFilePath, activeFileRoot]);

  // B24: "no neuron linked" used to be a dead end — this fires a REAL
  // brain.capture() (the same platform API captureEdit() in lib/brain/
  // capture.ts uses for auto-save captures, called here directly and
  // un-debounced since it's an explicit one-off user action, not a
  // background auto-capture). No optimistic re-link attempt afterwards:
  // the sidebar's file->neuron match depends on a background graph
  // rebuild (scheduleRebuild() in capture.ts) whose timing this component
  // has no visibility into, so claiming an immediate visual update here
  // would risk a misleading "looks broken" state if the rebuild hasn't
  // run yet — the success toast is the honest, verifiable signal.
  async function handleCaptureNeuron() {
    if (!activeFilePath || capturing) return;
    setCapturing(true);
    const filename = basenameOf(activeFilePath);
    try {
      let firstLine = '';
      try {
        const content = await platform.fs.readFile(activeFilePath);
        firstLine = content.split('\n')[0]?.slice(0, 120) ?? '';
      } catch {
        // Best-effort context only — capture still proceeds without it.
      }
      await platform.brain.capture({
        kind: 'edit',
        title: `Fichier: ${filename}`,
        text: firstLine
          ? `Capture manuelle depuis l'éditeur : ${activeFilePath}\nPremière ligne : ${firstLine}`
          : `Capture manuelle depuis l'éditeur : ${activeFilePath}`,
        files: [activeFilePath],
        source: 'lazy-ide:code-sidebar',
        space: 'code',
      });
      toast(t('codespace.brain.captureSuccess'), 'success', 2500);
    } catch (err) {
      toast(t('codespace.brain.captureFailed', { error: err instanceof Error ? err.message : String(err) }), 'error');
    } finally {
      setCapturing(false);
    }
  }

  return (
    <div>
      <div style={{ padding: '14px 18px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* QA fix (no emoji in UI chrome): a literal 🧠 emoji used to carry
            this header inline (same class of fix as MissionNode.tsx's
            PromoteIcon replacing "Promote 🧠" — see that file's doc
            comment). BrainIcon is the same drawn glyph already used for
            "brain" chrome elsewhere (SpacesRail's nav icon, Briefing.tsx's
            empty state) — reused here rather than forking a new icon. */}
        <BrainIcon size={13} color="var(--color-accent-pale)" />
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1.8, color: 'var(--color-accent-pale)', textTransform: 'uppercase' }}>
          {t('codespace.brain.title')}
        </span>
      </div>
      {!activeFilePath ? (
        <div style={{ padding: '0 18px 12px', fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
          {t('codespace.brain.noFile')}
        </div>
      ) : neuron === undefined ? (
        <div style={{ padding: '0 18px 12px', fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
          {t('codespace.brain.loading')}
        </div>
      ) : neuron ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onOpenNeuron(neuron.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenNeuron(neuron.id);
            }
          }}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            background: 'rgba(124,92,255,0.07)',
            border: '1px solid rgba(124,92,255,0.3)',
            borderRadius: 8,
            padding: '7px 11px',
            margin: '0 18px 12px',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(124,92,255,0.6)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(124,92,255,0.3)'; }}
        >
          <span style={{ fontSize: 12.5, color: 'var(--color-accent-lighter)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {neuron.label}
          </span>
          {neuron.type && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: '#8A7FB8', flexShrink: 0 }}>
              {neuron.type}
            </span>
          )}
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            background: 'rgba(124,92,255,0.07)',
            border: '1px solid rgba(124,92,255,0.3)',
            borderRadius: 8,
            padding: '7px 11px',
            margin: '0 18px 12px',
          }}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--color-accent-lighter)', flex: 1 }}>
              {t('codespace.brain.noneLinked')}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: '#8A7FB8' }}>—</span>
          </div>
          <button
            onClick={handleCaptureNeuron}
            disabled={capturing}
            style={{
              alignSelf: 'flex-start',
              fontSize: 11,
              color: capturing ? 'var(--color-text-disabled)' : 'var(--color-accent-lighter)',
              background: 'transparent',
              border: '1px solid rgba(124,92,255,0.35)',
              borderRadius: 5,
              padding: '3px 9px',
              cursor: capturing ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {capturing ? t('codespace.brain.capturing') : t('codespace.brain.captureAffordance')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Manager note — pinned to the sidebar's bottom by the PARENT layout
// (CodeSidebar.tsx renders this OUTSIDE the scrollable section stack, not
// via CSS margin-top:auto within this component itself) ────────────────

interface CodeSidebarManagerNoteProps {
  platform: Platform;
  projectId: string | null;
  missions: readonly FleetMission[];
}

export function CodeSidebarManagerNote({ platform, projectId, missions }: CodeSidebarManagerNoteProps) {
  const { t } = useI18n();
  const [managerNote, setManagerNote] = useState<ManagerNoteData | null>(null);

  useEffect(() => {
    if (!projectId || platform.name !== 'tauri') { setManagerNote(null); return; }
    let cancelled = false;
    const titleFor = (id: string) => missions.find((m) => m.id === id)?.title ?? null;
    loadManagerNote(projectId, titleFor).then((note) => { if (!cancelled) setManagerNote(note); }).catch(() => {});
    return () => { cancelled = true; };
    // Re-check whenever the mission set changes (a new conflict may have
    // just been recorded, or the missions needed to resolve titles arrived).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, platform.name, missions.length]);

  if (!managerNote) return null;

  return (
    <div style={{ padding: '14px 18px', borderTop: '1px solid var(--color-border-2)', flexShrink: 0 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1.8, color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
        {t('codespace.manager.title')}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--color-text-muted)' }}>
        {t('codespace.manager.note', { queued: managerNote.queuedTitle, conflict: managerNote.conflictTitle })}
      </div>
    </div>
  );
}
