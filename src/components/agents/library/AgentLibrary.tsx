/* AgentLibrary — main Bibliotheque view with three tabs:
   1. General — all 67 built-in ECC agents
   2. Personal — user-created + project agents
   3. Favorites — agents the user starred (persisted in localStorage)
   Grid of AgentCard / EccAgentCard + create/edit wizard.
*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LazyAgent, AgentScope } from '../../../lib/agents/agentDef';
import { createNewAgent, createAgentTemplate } from '../../../lib/agents/agentDef';
import { listAgents, saveAgent, deleteAgent } from '../../../lib/agents/agentsStorage';
import type { StoredAgent } from '../../../lib/agents/agentsStorage';
import { ECC_AGENTS, eccToLazyAgent } from '../../../lib/agents/eccAgents';
import type { EccAgent } from '../../../lib/agents/eccAgents';
import { listProjectCommandTools, saveProjectCommandTool } from '../../../lib/agents/projectCommandTools';
import {
  agentExportFileName,
  buildAgentExportEnvelope,
  parseAgentExportEnvelope,
  remapImportedAgent,
} from '../../../lib/agents/agentImportExport';
import { AgentCard } from './AgentCard';
import { EccAgentCard } from './EccAgentCard';
import { AgentWizard } from './AgentWizard';
import { EmptyState, SkeletonCard, useToast } from '../../ui';
import { useI18n } from '../../../i18n';

// ── Favorites (localStorage) ──────────────────────────────────────

const FAV_KEY = 'lazy.agent.favorites';

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveFavorites(favs: Set<string>): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favs]));
  } catch {
    // ignore
  }
}

// ── Run prompt modal ──────────────────────────────────────────────

interface RunPromptModalProps {
  agent: LazyAgent;
  onRun: (task: string) => void;
  onClose: () => void;
}

function RunPromptModal({ agent, onRun, onClose }: RunPromptModalProps) {
  const { t } = useI18n();
  const [task, setTask] = useState(`Run the ${agent.displayName || agent.name} agent.`);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: '#16161D',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          width: 480,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: '#E2E2F0' }}>
          {t('agents.library.runTitle')} : {agent.displayName || agent.name}
        </div>
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          autoFocus
          style={{
            background: '#0A0A10',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 7,
            padding: '10px 12px',
            color: '#E2E2F0',
            fontSize: 13,
            fontFamily: 'inherit',
            outline: 'none',
            resize: 'vertical',
            minHeight: 80,
            lineHeight: 1.5,
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px',
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.6)',
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => onRun(task)}
            style={{
              padding: '6px 20px',
              borderRadius: 7,
              border: 'none',
              background: '#7C5CFF',
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t('agents.library.runBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Agent group ───────────────────────────────────────────────────

interface AgentGroupProps {
  title: string;
  agents: StoredAgent[];
  onEdit: (agent: LazyAgent) => void;
  onRun: (agent: LazyAgent) => void;
  onDuplicate: (agent: LazyAgent, scope: AgentScope) => void;
  onDelete: (agent: LazyAgent, scope: AgentScope) => void;
  onExport: (agent: LazyAgent) => void;
}

function AgentGroup({ title, agents, onEdit, onRun, onDuplicate, onDelete, onExport }: AgentGroupProps) {
  if (agents.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.35)',
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
        }}
      >
        {title} ({agents.length})
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 12,
        }}
      >
        {agents.map(({ agent, scope }) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onRun={() => onRun(agent)}
            onEdit={() => onEdit(agent)}
            onDuplicate={() => onDuplicate(agent, scope)}
            onDelete={() => onDelete(agent, scope)}
            onExport={() => onExport(agent)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Template picker ───────────────────────────────────────────────

type TemplateKey = 'security-reviewer' | 'test-writer' | 'refactor' | 'blank';

function TemplatePicker({ onPick }: { onPick: (key: TemplateKey) => void }) {
  const { t } = useI18n();
  const TEMPLATES: Array<{ key: TemplateKey; label: string; color: string }> = [
    { key: 'blank', label: t('agents.library.templateBlank'), color: '#8A8F9C' },
    { key: 'security-reviewer', label: 'Security Reviewer', color: '#F87171' },
    { key: 'test-writer', label: 'Test Writer', color: '#66E27A' },
    { key: 'refactor', label: 'Refactor Cleaner', color: '#7C5CFF' },
  ];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1050,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onPick('blank'); }}
    >
      <div
        style={{
          background: '#16161D',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          padding: 24,
          width: 400,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: '#E2E2F0' }}>{t('agents.library.chooseTemplate')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {TEMPLATES.map(({ key, label, color }) => (
            <button
              key={key}
              onClick={() => onPick(key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.03)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: '#E2E2F0', fontFamily: 'inherit' }}>{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── EccAgentGroup ────────────────────────────────────────────────

interface EccAgentGroupProps {
  title: string;
  agents: EccAgent[];
  favorites: Set<string>;
  onRun: (agent: EccAgent) => void;
  onToggleFavorite: (name: string) => void;
  onDuplicate: (agent: EccAgent) => void;
}

function EccAgentGroup({ title, agents, favorites, onRun, onToggleFavorite, onDuplicate }: EccAgentGroupProps) {
  if (agents.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.35)',
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
        }}
      >
        {title} ({agents.length})
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 12,
        }}
      >
        {agents.map((agent) => (
          <EccAgentCard
            key={agent.name}
            agent={agent}
            isFavorite={favorites.has(agent.name)}
            onRun={() => onRun(agent)}
            onToggleFavorite={() => onToggleFavorite(agent.name)}
            onDuplicate={() => onDuplicate(agent)}
          />
        ))}
      </div>
    </div>
  );
}

// ── FavoriteEccGroup ──────────────────────────────────────────────

interface FavoriteEccGroupProps {
  agents: EccAgent[];
  onRun: (agent: EccAgent) => void;
  onToggleFavorite: (name: string) => void;
  onDuplicate: (agent: EccAgent) => void;
}

function FavoriteEccGroup({ agents, onRun, onToggleFavorite, onDuplicate }: FavoriteEccGroupProps) {
  const { t } = useI18n();
  if (agents.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: '#FFC76B',
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
        }}
      >
        ★ {t('agents.library.favoritesEcc')} ({agents.length})
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 12,
        }}
      >
        {agents.map((agent) => (
          <EccAgentCard
            key={agent.name}
            agent={agent}
            isFavorite={true}
            onRun={() => onRun(agent)}
            onToggleFavorite={() => onToggleFavorite(agent.name)}
            onDuplicate={() => onDuplicate(agent)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Main AgentLibrary ─────────────────────────────────────────────

interface AgentLibraryProps {
  onRunAgent: (agent: LazyAgent, task: string) => void;
}

export function AgentLibrary({ onRunAgent }: AgentLibraryProps) {
  const { toast } = useToast();
  const { t } = useI18n();
  const [storedAgents, setStoredAgents] = useState<StoredAgent[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<LazyAgent | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [runPrompt, setRunPrompt] = useState<LazyAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites());
  const [searchQuery, setSearchQuery] = useState('');
  const [libraryTab, setLibraryTab] = useState<'general' | 'personal' | 'favorites'>('general');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const agents = await listAgents();
      setStoredAgents(agents);
    } catch {
      setStoredAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload(); // eslint-disable-line react-hooks/set-state-in-effect
  }, [reload]);

  const handleSave = useCallback(async (agent: LazyAgent) => {
    try {
      await saveAgent(agent.scope, agent);
      await reload();
      toast(t('agents.library.saved', { name: agent.displayName || agent.name }), 'success');
    } catch {
      toast(t('agents.library.saveFailed'), 'error');
    }
  }, [reload, toast, t]);

  const handleDelete = useCallback(async (agent: LazyAgent, scope: AgentScope) => {
    if (!window.confirm(t('agents.library.deleteConfirm', { name: agent.displayName || agent.name }))) return;
    try {
      await deleteAgent(scope, agent.id);
      await reload();
      toast(t('agents.library.deleted', { name: agent.displayName || agent.name }), 'info');
    } catch {
      toast(t('agents.library.deleteFailed'), 'error');
    }
  }, [reload, toast, t]);

  const handleDuplicate = useCallback(async (agent: LazyAgent, scope: AgentScope) => {
    const duplicate: LazyAgent = {
      ...agent,
      id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${agent.name}-copy`,
      displayName: `${agent.displayName} (copy)`,
      createdAt: new Date().toISOString(),
    };
    await saveAgent(scope, duplicate);
    await reload();
  }, [reload]);

  const toggleFavorite = useCallback((name: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      saveFavorites(next);
      return next;
    });
  }, []);

  const handleEccRun = useCallback((ecc: EccAgent) => {
    const agent = eccToLazyAgent(ecc);
    setRunPrompt(agent);
  }, []);

  const handleEccDuplicate = useCallback(async (ecc: EccAgent) => {
    const agent = eccToLazyAgent(ecc);
    const duplicate: LazyAgent = {
      ...agent,
      id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `${agent.name}-copy`,
      displayName: `${agent.displayName} (copy)`,
      createdAt: new Date().toISOString(),
    };
    try {
      await saveAgent('project', duplicate);
      await reload();
      toast(t('agents.library.duplicated', { name: ecc.displayName }), 'success');
    } catch {
      toast(t('agents.library.duplicateFailed'), 'error');
    }
  }, [reload, toast, t]);

  const handleOpenNew = useCallback(() => {
    setTemplatePickerOpen(true);
  }, []);

  // W-BYO row 1 — « Exporter » a single agent as a shareable `.lazyagent.json`
  // file (agentImportExport.ts's own header explains why Blob-download,
  // not the sandboxed project-scoped fs commands — same reasoning
  // canvasExportImport.ts already established for the whole canvas).
  const handleExportAgent = useCallback(async (agent: LazyAgent) => {
    try {
      const availableTools = await listProjectCommandTools();
      const envelope = buildAgentExportEnvelope(agent, availableTools);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = agentExportFileName(agent.name || agent.displayName, envelope.exportedAtMs);
      anchor.click();
      URL.revokeObjectURL(url);
      toast(t('agents.library.exportAgentDone', { name: agent.displayName || agent.name }), 'success');
    } catch {
      toast(t('agents.library.saveFailed'), 'error');
    }
  }, [toast, t]);

  // « Importer un agent » — reads the picked File's text, validates it as a
  // real agent-export envelope (never trusts a file from disk/a teammate),
  // mints a fresh id + project scope, and registers it via the SAME
  // agentsStorage.saveAgent every other agent write already goes through.
  const importInputRef = useRef<HTMLInputElement>(null);
  const handleImportAgentFile = useCallback((file: File) => {
    void file.text().then(async (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        toast(t('agents.library.importAgentInvalid'), 'error');
        return;
      }
      const envelope = parseAgentExportEnvelope(parsed);
      if (!envelope) {
        toast(t('agents.library.importAgentInvalid'), 'error');
        return;
      }
      const imported = remapImportedAgent(envelope);
      try {
        await saveAgent(imported.scope, imported);
        for (const tool of envelope.projectCommandTools) {
          // Best-effort — a tool save failure never blocks the agent import
          // itself; the agent still lands, just without that one attached
          // command available until re-added.
          try {
            await saveProjectCommandTool(tool);
          } catch {
            // ignore — see comment above
          }
        }
        await reload();
        toast(t('agents.library.importAgentDone', { name: imported.displayName || imported.name }), 'success');
      } catch {
        toast(t('agents.library.saveFailed'), 'error');
      }
    });
  }, [reload, toast, t]);

  const handlePickTemplate = useCallback((key: TemplateKey) => {
    setTemplatePickerOpen(false);
    if (key === 'blank') {
      setEditingAgent(null);
      setWizardOpen(true);
      return;
    }
    const tpl = createAgentTemplate(key);
    const agent = createNewAgent({ ...tpl, scope: 'project' });
    setEditingAgent(agent);
    setWizardOpen(true);
  }, []);

  const userAgents = storedAgents.filter((s) => s.scope === 'user');
  const projectAgents = storedAgents.filter((s) => s.scope === 'project');

  // Filter ECC agents by search query
  const filteredEcc = useMemo(() => {
    if (!searchQuery.trim()) return ECC_AGENTS;
    const q = searchQuery.toLowerCase();
    return ECC_AGENTS.filter((a) =>
      a.name.includes(q) ||
      a.displayName.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.tags.some((tag) => tag.includes(q))
    );
  }, [searchQuery]);

  const favoriteEccAgents = useMemo(
    () => ECC_AGENTS.filter((a) => favorites.has(a.name)),
    [favorites],
  );

  return (
    <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#E2E2F0' }}>
            {t('agents.library.title')}
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
            {t('agents.library.subtitle', { custom: storedAgents.length, ecc: ECC_AGENTS.length })}
          </p>
        </div>
        <input
          type="text"
          placeholder={t('agents.library.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            background: '#0A0A10',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 7,
            padding: '6px 12px',
            color: '#E2E2F0',
            fontSize: 12,
            fontFamily: 'inherit',
            outline: 'none',
            width: 200,
          }}
        />
        <button
          data-testid="import-agent-btn"
          onClick={() => importInputRef.current?.click()}
          style={{
            padding: '6px 14px',
            borderRadius: 7,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'transparent',
            color: 'rgba(255,255,255,0.6)',
            fontSize: 12,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          {t('agents.library.importAgent')}
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json,.lazyagent.json"
          data-testid="import-agent-input"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) handleImportAgentFile(file);
          }}
        />
        <button
          data-testid="new-agent-btn"
          data-primary="true"
          onClick={handleOpenNew}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 16px',
            borderRadius: 7,
            border: 'none',
            background: 'var(--color-accent)',
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
            boxShadow: '0 2px 12px rgba(124,92,255,0.35)',
            transition: 'box-shadow 0.15s, transform 0.1s',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.boxShadow = '0 0 0 3px rgba(124,92,255,0.25), 0 4px 16px rgba(124,92,255,0.4)';
            el.style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.boxShadow = '0 2px 12px rgba(124,92,255,0.35)';
            el.style.transform = 'translateY(0)';
          }}
        >
          + {t('agents.library.newAgent')}
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 12,
          }}
        >
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : (
        <>
          {/* Tab selector */}
          <div
            style={{
              display: 'flex',
              gap: 4,
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              paddingBottom: 0,
            }}
          >
            {([
              { id: 'general', label: t('agents.library.tabGeneral'), count: ECC_AGENTS.length },
              { id: 'personal', label: t('agents.library.tabPersonal'), count: storedAgents.length },
              { id: 'favorites', label: t('agents.library.tabFavorites'), count: favoriteEccAgents.length },
            ] as const).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setLibraryTab(tab.id)}
                style={{
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: libraryTab === tab.id ? 600 : 400,
                  color: libraryTab === tab.id ? '#E2E2F0' : 'rgba(255,255,255,0.40)',
                  background: 'none',
                  border: 'none',
                  borderBottom: libraryTab === tab.id ? '2px solid #7C5CFF' : '2px solid transparent',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  marginBottom: -1,
                }}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </div>

          {/* Tab content */}
          {libraryTab === 'general' && (
            <EccAgentGroup
              title={t('agents.library.eccLibrary')}
              agents={filteredEcc}
              favorites={favorites}
              onRun={handleEccRun}
              onToggleFavorite={toggleFavorite}
              onDuplicate={handleEccDuplicate}
            />
          )}

          {libraryTab === 'personal' && (
            <>
              <AgentGroup
                title={t('agents.library.myAgents')}
                agents={userAgents}
                onEdit={(a) => { setEditingAgent(a); setWizardOpen(true); }}
                onRun={(a) => setRunPrompt(a)}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onExport={(a) => void handleExportAgent(a)}
              />
              <AgentGroup
                title={t('agents.library.projectAgents')}
                agents={projectAgents}
                onEdit={(a) => { setEditingAgent(a); setWizardOpen(true); }}
                onRun={(a) => setRunPrompt(a)}
                onDuplicate={handleDuplicate}
                onDelete={handleDelete}
                onExport={(a) => void handleExportAgent(a)}
              />
            </>
          )}

          {libraryTab === 'favorites' && (
            <FavoriteEccGroup
              agents={favoriteEccAgents}
              onRun={handleEccRun}
              onToggleFavorite={toggleFavorite}
              onDuplicate={handleEccDuplicate}
            />
          )}
        </>
      )}

      {/* Empty state when no agents at all and no search results */}
      {!loading && storedAgents.length === 0 && filteredEcc.length === 0 && (
        <EmptyState
          icon="⬡"
          title={t('agents.library.emptyTitle')}
          subtitle={t('agents.library.emptySubtitle')}
          action={{ label: t('agents.library.emptyAction'), onClick: handleOpenNew }}
        />
      )}

      {/* Template picker */}
      {templatePickerOpen && (
        <TemplatePicker onPick={handlePickTemplate} />
      )}

      {/* Create/Edit wizard */}
      {wizardOpen && (
        <AgentWizard
          initial={editingAgent ?? undefined}
          onSave={handleSave}
          onTestNow={(agent) => {
            setWizardOpen(false);
            setRunPrompt(agent);
          }}
          onClose={() => { setWizardOpen(false); setEditingAgent(null); }}
        />
      )}

      {/* Run prompt */}
      {runPrompt && (
        <RunPromptModal
          agent={runPrompt}
          onRun={(task) => {
            onRunAgent(runPrompt, task);
            setRunPrompt(null);
          }}
          onClose={() => setRunPrompt(null)}
        />
      )}
    </div>
  );
}
