/* AgentWizard — 5-step create/edit form for a LazyAgent.
   Steps: (1) Identite (2) Intelligence (3) Capacites (4) Declencheurs (5) Revue
   Immutable — always produces new agent objects.
*/

import { useState, useCallback, useEffect } from 'react';
import type { LazyAgent, AgentColor, ModelTier, MemoryScope, AgentScope } from '../../../lib/agents/agentDef';
import { AGENT_COLOR_MAP, validateAgent, createNewAgent } from '../../../lib/agents/agentDef';
import { buildClaudeCodeAgentMd } from '../../../lib/agents/compile';
import { FREQUENCY_PRESETS, formatCron, nextCronRun } from '../../../lib/agents/scheduleUtils';
import {
  generateProjectCommandToolId,
  listProjectCommandTools,
  saveProjectCommandTool,
  validateProjectCommandTool,
  type ProjectCommandTool,
} from '../../../lib/agents/projectCommandTools';
import {
  generateDeclarativeToolId,
  listDeclarativeTools,
  saveDeclarativeTool,
  validateWebReadTool,
  validateFileReadTool,
  type DeclarativeTool,
  type DeclarativeToolKind,
} from '../../../lib/agents/declarativeTools';
import {
  generateTransformToolId,
  listTransformTools,
  saveTransformTool,
  validateTransformTool,
  type TransformTool,
} from '../../../lib/agents/transformTools';
import { useI18n } from '../../../i18n';

// ── Tool groups ───────────────────────────────────────────────────

const TOOL_GROUPS: Array<{ group: string; tools: string[] }> = [
  { group: 'Files', tools: ['Read', 'Write', 'Edit', 'MultiEdit'] },
  { group: 'Shell', tools: ['Bash', 'Computer'] },
  { group: 'Web', tools: ['WebSearch', 'WebFetch'] },
  { group: 'MCP', tools: ['mcp__*'] },
];

// ── Helper components ─────────────────────────────────────────────

function FormField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>
        {label}
      </label>
      {hint && (
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: -2 }}>{hint}</span>
      )}
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: '#0A0A10',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 7,
  padding: '7px 10px',
  color: '#E2E2F0',
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: 100,
  lineHeight: 1.5,
};

// ── Step 1: Identite ──────────────────────────────────────────────

function StepIdentite({ agent, onChange }: { agent: LazyAgent; onChange: (a: LazyAgent) => void }) {
  const { t } = useI18n();
  const descWordCount = agent.description.split(/\s+/).filter(Boolean).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <FormField label={t('agents.wizard.nameLabel')} hint={t('agents.wizard.nameHint')}>
        <input
          style={inputStyle}
          value={agent.name}
          placeholder={t('agents.wizard.namePlaceholder')}
          onChange={(e) => onChange({ ...agent, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
        />
      </FormField>

      <FormField label={t('agents.wizard.displayNameLabel')}>
        <input
          style={inputStyle}
          value={agent.displayName}
          placeholder={t('agents.wizard.displayNamePlaceholder')}
          onChange={(e) => onChange({ ...agent, displayName: e.target.value })}
        />
      </FormField>

      <FormField
        label={t('agents.wizard.descriptionLabel')}
        hint={t('agents.wizard.descriptionHint', { count: descWordCount, s: descWordCount !== 1 ? 's' : '' })}
      >
        <textarea
          style={{ ...textareaStyle, minHeight: 80 }}
          value={agent.description}
          placeholder={t('agents.wizard.descriptionPlaceholder')}
          onChange={(e) => onChange({ ...agent, description: e.target.value })}
        />
        {descWordCount < 20 && descWordCount > 0 && (
          <span style={{ fontSize: 11, color: '#FBB924' }}>
            {t('agents.wizard.descriptionShort')}
          </span>
        )}
      </FormField>

      <FormField label={t('agents.wizard.colorLabel')}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(Object.entries(AGENT_COLOR_MAP) as Array<[AgentColor, string]>).map(([color, hex]) => (
            <button
              key={color}
              onClick={() => onChange({ ...agent, color })}
              title={color}
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: hex,
                border: agent.color === color ? `3px solid white` : '3px solid transparent',
                cursor: 'pointer',
                transition: 'border-color 0.15s',
              }}
            />
          ))}
        </div>
      </FormField>

      <FormField label={t('agents.wizard.tagsLabel')} hint={t('agents.wizard.tagsHint')}>
        <input
          style={inputStyle}
          value={agent.tags.join(', ')}
          placeholder={t('agents.wizard.tagsPlaceholder')}
          onChange={(e) => onChange({
            ...agent,
            tags: e.target.value.split(',').map((tag) => tag.trim()).filter(Boolean),
          })}
        />
      </FormField>

      <FormField label={t('agents.wizard.scopeLabel')}>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['project', 'user'] as AgentScope[]).map((scope) => (
            <button
              key={scope}
              onClick={() => onChange({ ...agent, scope })}
              style={{
                padding: '5px 14px',
                borderRadius: 6,
                border: `1px solid ${agent.scope === scope ? '#7C5CFF' : 'rgba(255,255,255,0.12)'}`,
                background: agent.scope === scope ? 'rgba(124,92,255,0.15)' : 'transparent',
                color: agent.scope === scope ? '#C4B5FD' : 'rgba(255,255,255,0.5)',
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {scope === 'project' ? t('agents.wizard.scopeProject') : t('agents.wizard.scopeUser')}
            </button>
          ))}
        </div>
      </FormField>
    </div>
  );
}

// ── Step 2: Intelligence ──────────────────────────────────────────

function StepIntelligence({ agent, onChange }: { agent: LazyAgent; onChange: (a: LazyAgent) => void }) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <FormField label={t('agents.wizard.systemPromptLabel')} hint={t('agents.wizard.systemPromptHint')}>
        <textarea
          style={{ ...textareaStyle, minHeight: 200, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
          value={agent.systemPrompt}
          placeholder={t('agents.wizard.systemPromptPlaceholder')}
          onChange={(e) => onChange({ ...agent, systemPrompt: e.target.value })}
        />
      </FormField>

      <FormField label={t('agents.wizard.skillsLabel')} hint={t('agents.wizard.skillsHint')}>
        <textarea
          style={{ ...textareaStyle, minHeight: 60, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
          value={(agent.skills ?? []).join('\n')}
          placeholder="security-reviewer&#10;tdd-guide"
          onChange={(e) => onChange({
            ...agent,
            skills: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
          })}
        />
      </FormField>

      <FormField label={t('agents.wizard.brainScopeLabel')} hint={t('agents.wizard.brainScopeHint')}>
        <input
          style={inputStyle}
          value={agent.brainScope ?? ''}
          placeholder="auth"
          onChange={(e) => onChange({ ...agent, brainScope: e.target.value || undefined })}
        />
      </FormField>

      <FormField label={t('agents.wizard.memoryLabel')}>
        <div style={{ display: 'flex', gap: 8 }}>
          {([undefined, 'user', 'project', 'local'] as Array<MemoryScope | undefined>).map((mem) => (
            <button
              key={String(mem)}
              onClick={() => onChange({ ...agent, memory: mem })}
              style={{
                padding: '5px 12px',
                borderRadius: 6,
                border: `1px solid ${agent.memory === mem ? '#7C5CFF' : 'rgba(255,255,255,0.12)'}`,
                background: agent.memory === mem ? 'rgba(124,92,255,0.15)' : 'transparent',
                color: agent.memory === mem ? '#C4B5FD' : 'rgba(255,255,255,0.5)',
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {mem ?? t('agents.wizard.memoryNone')}
            </button>
          ))}
        </div>
      </FormField>
    </div>
  );
}

// ── Project-command tools (W-BYO row 2) ────────────────────────────
//
// A "commande de projet" tool is a named, described binding onto a command
// that must already pass isWorktreeScriptCommand (worktreeScriptCommands.ts
// — the R6b scoped-worktree-script gate). Attaching one here never grants
// new execution capability: an acceptEdits/full agent can already run any
// allowlisted npm/cargo script via the pre-existing bypass in
// managedToolPermissions.checkToolExecution, with or without this catalog.
// This section is purely the authoring/discovery UI — see
// projectCommandTools.ts's module header for the full rationale.

function ProjectCommandsSection({ agent, onChange }: { agent: LazyAgent; onChange: (a: LazyAgent) => void }) {
  const { t } = useI18n();
  const [tools, setTools] = useState<ProjectCommandTool[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listProjectCommandTools().then(setTools).catch(() => setTools([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const qualifies = agent.permissionMode === 'acceptEdits' || agent.permissionMode === 'full';
  const attached = new Set(agent.projectCommandTools ?? []);

  function toggleAttached(id: string): void {
    const next = attached.has(id)
      ? (agent.projectCommandTools ?? []).filter((existing) => existing !== id)
      : [...(agent.projectCommandTools ?? []), id];
    onChange({ ...agent, projectCommandTools: next });
  }

  async function handleAddTool(): Promise<void> {
    const validation = validateProjectCommandTool({ name, command, description });
    if (!validation.valid) {
      setError(validation.errors.join('; '));
      return;
    }
    const tool: ProjectCommandTool = {
      id: generateProjectCommandToolId(),
      name: name.trim(),
      command: command.trim(),
      description: description.trim(),
      createdAt: new Date().toISOString(),
    };
    await saveProjectCommandTool(tool);
    reload();
    setName('');
    setCommand('');
    setDescription('');
    setError(null);
    setShowForm(false);
  }

  return (
    <FormField label={t('agents.wizard.projectCommandsLabel')} hint={t('agents.wizard.projectCommandsHint')}>
      {!qualifies && (
        <div style={{ fontSize: 11, color: '#FBB924', marginBottom: 6 }}>
          {t('agents.wizard.projectCommandsRequiresMode')}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: qualifies ? 1 : 0.45, pointerEvents: qualifies ? 'auto' : 'none' }}>
        {tools.length === 0 && (
          <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.35)' }}>{t('agents.wizard.projectCommandsEmpty')}</span>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tools.map((tool) => {
            const isChecked = attached.has(tool.id);
            return (
              <button
                key={tool.id}
                data-testid={`project-command-toggle-${tool.id}`}
                onClick={() => toggleAttached(tool.id)}
                title={`${tool.command} — ${tool.description}`}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: `1px solid ${isChecked ? '#66E27A' : 'rgba(255,255,255,0.12)'}`,
                  background: isChecked ? 'rgba(102,226,122,0.12)' : 'transparent',
                  color: isChecked ? '#66E27A' : 'rgba(255,255,255,0.5)',
                  fontSize: 11.5,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {tool.name}
              </button>
            );
          })}
        </div>

        {showForm ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <input
              style={inputStyle}
              value={name}
              placeholder={t('agents.wizard.projectCommandNamePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
              value={command}
              placeholder={t('agents.wizard.projectCommandCommandPlaceholder')}
              onChange={(e) => setCommand(e.target.value)}
            />
            <input
              style={inputStyle}
              value={description}
              placeholder={t('agents.wizard.projectCommandDescPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
            {error && <span style={{ fontSize: 11, color: '#F87171' }}>{error}</span>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                data-testid="project-command-save-btn"
                onClick={() => void handleAddTool()}
                style={{
                  padding: '5px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#7C5CFF',
                  color: '#fff',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t('common.save')}
              </button>
              <button
                onClick={() => { setShowForm(false); setError(null); }}
                style={{
                  padding: '5px 14px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'transparent',
                  color: 'rgba(255,255,255,0.6)',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            data-testid="project-command-add-btn"
            onClick={() => setShowForm(true)}
            style={{
              alignSelf: 'flex-start',
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px dashed rgba(255,255,255,0.18)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 11.5,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t('agents.wizard.projectCommandsAdd')}
          </button>
        )}
      </div>
    </FormField>
  );
}

// ── Declarative tools (W-PROVE row 3) ──────────────────────────────
//
// A « lecture web » tool is an HTTP GET bound to a single, exact-match
// allowlisted host (https only). A « lecture fichier projet » tool is a
// read bound to a single project-relative path. Neither ever executes
// user-authored code — see declarativeTools.ts's module header for the
// full safety-by-construction rationale. Unlike ProjectCommandsSection
// above, attaching one of these carries no permissionMode gate: reading an
// allowlisted URL or a project file is safe regardless of the agent's own
// edit permissions.

function DeclarativeToolsSection({ agent, onChange }: { agent: LazyAgent; onChange: (a: LazyAgent) => void }) {
  const { t } = useI18n();
  const [tools, setTools] = useState<DeclarativeTool[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [kind, setKind] = useState<DeclarativeToolKind>('web_read');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [allowedHost, setAllowedHost] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listDeclarativeTools().then(setTools).catch(() => setTools([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const attached = new Set(agent.declarativeTools ?? []);

  function toggleAttached(id: string): void {
    const next = attached.has(id)
      ? (agent.declarativeTools ?? []).filter((existing) => existing !== id)
      : [...(agent.declarativeTools ?? []), id];
    onChange({ ...agent, declarativeTools: next });
  }

  async function handleAddTool(): Promise<void> {
    const validation = kind === 'web_read'
      ? validateWebReadTool({ name, description, allowedHost })
      : validateFileReadTool({ name, description, path });
    if (!validation.valid) {
      setError(validation.errors.join('; '));
      return;
    }
    const base = { id: generateDeclarativeToolId(), name: name.trim(), description: description.trim(), createdAt: new Date().toISOString() };
    const tool: DeclarativeTool = kind === 'web_read'
      ? { ...base, kind: 'web_read', allowedHost: allowedHost.trim() }
      : { ...base, kind: 'file_read', path: path.trim() };
    await saveDeclarativeTool(tool);
    reload();
    setName('');
    setDescription('');
    setAllowedHost('');
    setPath('');
    setError(null);
    setShowForm(false);
  }

  return (
    <FormField label={t('agents.wizard.declarativeToolsLabel')} hint={t('agents.wizard.declarativeToolsHint')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {tools.length === 0 && (
          <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.35)' }}>{t('agents.wizard.declarativeToolsEmpty')}</span>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tools.map((tool) => {
            const isChecked = attached.has(tool.id);
            const summary = tool.kind === 'web_read' ? `https://${tool.allowedHost}` : tool.path;
            return (
              <button
                key={tool.id}
                data-testid={`declarative-tool-toggle-${tool.id}`}
                aria-pressed={isChecked}
                onClick={() => toggleAttached(tool.id)}
                title={`${summary} — ${tool.description}`}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: `1px solid ${isChecked ? '#66E27A' : 'rgba(255,255,255,0.12)'}`,
                  background: isChecked ? 'rgba(102,226,122,0.12)' : 'transparent',
                  color: isChecked ? '#66E27A' : 'rgba(255,255,255,0.5)',
                  fontSize: 11.5,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {tool.kind === 'web_read' ? '\u{1F310} ' : '\u{1F4C4} '}
                {tool.name}
              </button>
            );
          })}
        </div>

        {showForm ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['web_read', 'file_read'] as DeclarativeToolKind[]).map((k) => (
                <button
                  key={k}
                  data-testid={`declarative-tool-kind-${k}`}
                  onClick={() => setKind(k)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: `1px solid ${kind === k ? '#7C5CFF' : 'rgba(255,255,255,0.12)'}`,
                    background: kind === k ? 'rgba(124,92,255,0.15)' : 'transparent',
                    color: kind === k ? '#C4B5FD' : 'rgba(255,255,255,0.5)',
                    fontSize: 11.5,
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  {k === 'web_read' ? t('agents.wizard.declarativeToolKindWebRead') : t('agents.wizard.declarativeToolKindFileRead')}
                </button>
              ))}
            </div>
            <input
              style={inputStyle}
              value={name}
              placeholder={t('agents.wizard.declarativeToolNamePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
            {kind === 'web_read' ? (
              <input
                data-testid="declarative-tool-host-input"
                style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                value={allowedHost}
                placeholder={t('agents.wizard.declarativeToolHostPlaceholder')}
                onChange={(e) => setAllowedHost(e.target.value)}
              />
            ) : (
              <input
                data-testid="declarative-tool-path-input"
                style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                value={path}
                placeholder={t('agents.wizard.declarativeToolPathPlaceholder')}
                onChange={(e) => setPath(e.target.value)}
              />
            )}
            <input
              style={inputStyle}
              value={description}
              placeholder={t('agents.wizard.declarativeToolDescPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
            {error && <span data-testid="declarative-tool-error" style={{ fontSize: 11, color: '#F87171' }}>{error}</span>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                data-testid="declarative-tool-save-btn"
                onClick={() => void handleAddTool()}
                style={{
                  padding: '5px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#7C5CFF',
                  color: '#fff',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t('common.save')}
              </button>
              <button
                onClick={() => { setShowForm(false); setError(null); }}
                style={{
                  padding: '5px 14px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'transparent',
                  color: 'rgba(255,255,255,0.6)',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            data-testid="declarative-tool-add-btn"
            onClick={() => setShowForm(true)}
            style={{
              alignSelf: 'flex-start',
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px dashed rgba(255,255,255,0.18)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 11.5,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t('agents.wizard.declarativeToolsAdd')}
          </button>
        )}
      </div>
    </FormField>
  );
}

// ── Transform tools (W-CODE) ────────────────────────────────────────
//
// A « transformation » tool is a user-authored PURE JS function body —
// `(input) => output` — run in transformSandbox.ts's isolated worker/vm
// (zero fs/network/process access, hard timeout, size-capped output — see
// that module's header for the full threat model). Unlike
// ProjectCommandsSection, this carries no permissionMode gate: a pure
// computation with no side effects is safe regardless of the agent's own
// edit permissions, same posture as DeclarativeToolsSection above.

function TransformToolsSection({ agent, onChange }: { agent: LazyAgent; onChange: (a: LazyAgent) => void }) {
  const { t } = useI18n();
  const [tools, setTools] = useState<TransformTool[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listTransformTools().then(setTools).catch(() => setTools([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const attached = new Set(agent.transformTools ?? []);

  function toggleAttached(id: string): void {
    const next = attached.has(id)
      ? (agent.transformTools ?? []).filter((existing) => existing !== id)
      : [...(agent.transformTools ?? []), id];
    onChange({ ...agent, transformTools: next });
  }

  async function handleAddTool(): Promise<void> {
    const validation = validateTransformTool({ name, description, code });
    if (!validation.valid) {
      setError(validation.errors.join('; '));
      return;
    }
    const tool: TransformTool = {
      id: generateTransformToolId(),
      name: name.trim(),
      description: description.trim(),
      code,
      createdAt: new Date().toISOString(),
    };
    await saveTransformTool(tool);
    reload();
    setName('');
    setDescription('');
    setCode('');
    setError(null);
    setShowForm(false);
  }

  return (
    <FormField label={t('agents.wizard.transformToolsLabel')} hint={t('agents.wizard.transformToolsHint')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {tools.length === 0 && (
          <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.35)' }}>{t('agents.wizard.transformToolsEmpty')}</span>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tools.map((tool) => {
            const isChecked = attached.has(tool.id);
            return (
              <button
                key={tool.id}
                data-testid={`transform-tool-toggle-${tool.id}`}
                aria-pressed={isChecked}
                onClick={() => toggleAttached(tool.id)}
                title={`${tool.description}`}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: `1px solid ${isChecked ? '#66E27A' : 'rgba(255,255,255,0.12)'}`,
                  background: isChecked ? 'rgba(102,226,122,0.12)' : 'transparent',
                  color: isChecked ? '#66E27A' : 'rgba(255,255,255,0.5)',
                  fontSize: 11.5,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {'\u{1F9EE} '}
                {tool.name}
              </button>
            );
          })}
        </div>

        {showForm ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <input
              style={inputStyle}
              value={name}
              placeholder={t('agents.wizard.transformToolNamePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              data-testid="transform-tool-code-input"
              style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", minHeight: 90, resize: 'vertical' }}
              value={code}
              placeholder={t('agents.wizard.transformToolCodePlaceholder')}
              onChange={(e) => setCode(e.target.value)}
            />
            <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.35)' }}>
              {t('agents.wizard.transformToolCodeHint')}
            </span>
            <input
              style={inputStyle}
              value={description}
              placeholder={t('agents.wizard.transformToolDescPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
            {error && <span data-testid="transform-tool-error" style={{ fontSize: 11, color: '#F87171' }}>{error}</span>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                data-testid="transform-tool-save-btn"
                onClick={() => void handleAddTool()}
                style={{
                  padding: '5px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#7C5CFF',
                  color: '#fff',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t('common.save')}
              </button>
              <button
                onClick={() => { setShowForm(false); setError(null); }}
                style={{
                  padding: '5px 14px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'transparent',
                  color: 'rgba(255,255,255,0.6)',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            data-testid="transform-tool-add-btn"
            onClick={() => setShowForm(true)}
            style={{
              alignSelf: 'flex-start',
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px dashed rgba(255,255,255,0.18)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 11.5,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {t('agents.wizard.transformToolsAdd')}
          </button>
        )}
      </div>
    </FormField>
  );
}

// ── Step 3: Capacites ─────────────────────────────────────────────

function StepCapacites({ agent, onChange }: { agent: LazyAgent; onChange: (a: LazyAgent) => void }) {
  const { t } = useI18n();

  const toggleTool = (list: 'allow' | 'deny', tool: string) => {
    const current = agent.tools?.[list] ?? [];
    const next = current.includes(tool)
      ? current.filter((item) => item !== tool)
      : [...current, tool];
    onChange({ ...agent, tools: { ...agent.tools, [list]: next } });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 16 }}>
        <FormField label={t('agents.wizard.modelLabel')}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['haiku', 'sonnet', 'opus', 'inherit'] as ModelTier[]).map((tier) => (
              <button
                key={tier}
                onClick={() => onChange({ ...agent, modelTier: tier })}
                style={{
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: `1px solid ${agent.modelTier === tier ? '#7C5CFF' : 'rgba(255,255,255,0.12)'}`,
                  background: agent.modelTier === tier ? 'rgba(124,92,255,0.15)' : 'transparent',
                  color: agent.modelTier === tier ? '#C4B5FD' : 'rgba(255,255,255,0.5)',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {tier}
              </button>
            ))}
          </div>
        </FormField>

        <FormField label={t('agents.wizard.effortLabel')}>
          <div style={{ display: 'flex', gap: 6 }}>
            {(['low', 'medium', 'high', undefined] as Array<'low' | 'medium' | 'high' | undefined>).map((eff) => (
              <button
                key={String(eff)}
                onClick={() => onChange({ ...agent, effort: eff })}
                style={{
                  padding: '5px 10px',
                  borderRadius: 6,
                  border: `1px solid ${agent.effort === eff ? '#7C5CFF' : 'rgba(255,255,255,0.12)'}`,
                  background: agent.effort === eff ? 'rgba(124,92,255,0.15)' : 'transparent',
                  color: agent.effort === eff ? '#C4B5FD' : 'rgba(255,255,255,0.5)',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {eff ?? t('agents.wizard.effortAuto')}
              </button>
            ))}
          </div>
        </FormField>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <FormField label={t('agents.wizard.permissionModeLabel')}>
          <select
            style={{ ...inputStyle, paddingRight: 24 }}
            value={agent.permissionMode ?? 'default'}
            onChange={(e) => onChange({ ...agent, permissionMode: e.target.value as LazyAgent['permissionMode'] })}
          >
            <option value="default">{t('agents.wizard.permDefault')}</option>
            <option value="acceptEdits">{t('agents.wizard.permAcceptEdits')}</option>
            <option value="plan">{t('agents.wizard.permPlan')}</option>
            <option value="full">{t('agents.wizard.permFull')}</option>
          </select>
        </FormField>

        <FormField label={t('agents.wizard.maxTurnsLabel')}>
          <input
            style={{ ...inputStyle, width: 100 }}
            type="number"
            min={1}
            max={200}
            value={agent.maxTurns ?? ''}
            placeholder={t('agents.wizard.maxTurnsPlaceholder')}
            onChange={(e) => onChange({ ...agent, maxTurns: e.target.value ? Number(e.target.value) : undefined })}
          />
        </FormField>
      </div>

      <FormField label={t('agents.wizard.isolationLabel')}>
        <div style={{ display: 'flex', gap: 8 }}>
          {([null, 'worktree'] as Array<'worktree' | null>).map((iso) => (
            <button
              key={String(iso)}
              onClick={() => onChange({ ...agent, isolation: iso ?? undefined })}
              style={{
                padding: '5px 14px',
                borderRadius: 6,
                border: `1px solid ${agent.isolation === iso ? '#7C5CFF' : 'rgba(255,255,255,0.12)'}`,
                background: agent.isolation === iso ? 'rgba(124,92,255,0.15)' : 'transparent',
                color: agent.isolation === iso ? '#C4B5FD' : 'rgba(255,255,255,0.5)',
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {iso ?? t('agents.wizard.isolationNone')}
            </button>
          ))}
        </div>
      </FormField>

      <FormField label={t('agents.wizard.toolsLabel')}>
        <div style={{ display: 'flex', gap: 16 }}>
          {(['allow', 'deny'] as const).map((listKey) => (
            <div key={listKey} style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: listKey === 'allow' ? '#66E27A' : '#F87171', marginBottom: 8, fontWeight: 600 }}>
                {listKey === 'allow' ? t('agents.wizard.toolsAllowed') : t('agents.wizard.toolsDenied')}
              </div>
              {TOOL_GROUPS.map(({ group, tools }) => (
                <div key={group} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginBottom: 4 }}>{group}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {tools.map((tool) => {
                      const isChecked = (agent.tools?.[listKey] ?? []).includes(tool);
                      return (
                        <button
                          key={tool}
                          onClick={() => toggleTool(listKey, tool)}
                          style={{
                            padding: '2px 8px',
                            borderRadius: 4,
                            border: `1px solid ${isChecked ? (listKey === 'allow' ? '#66E27A' : '#F87171') : 'rgba(255,255,255,0.12)'}`,
                            background: isChecked ? (listKey === 'allow' ? 'rgba(102,226,122,0.12)' : 'rgba(248,113,113,0.12)') : 'transparent',
                            color: isChecked ? (listKey === 'allow' ? '#66E27A' : '#F87171') : 'rgba(255,255,255,0.4)',
                            fontSize: 11,
                            fontFamily: 'inherit',
                            cursor: 'pointer',
                          }}
                        >
                          {tool}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </FormField>

      <ProjectCommandsSection agent={agent} onChange={onChange} />
      <DeclarativeToolsSection agent={agent} onChange={onChange} />
      <TransformToolsSection agent={agent} onChange={onChange} />
    </div>
  );
}

// ── Step 4: Declencheurs ──────────────────────────────────────────

function StepDeclencheurs({ agent, onChange }: { agent: LazyAgent; onChange: (a: LazyAgent) => void }) {
  const { t } = useI18n();
  const schedule = agent.triggers.schedule;
  const scheduleEnabled = schedule?.enabled ?? false;
  const scheduleMode = schedule?.mode ?? 'local';
  const scheduleCron = schedule?.cron ?? '';

  const setSchedule = (patch: Partial<NonNullable<LazyAgent['triggers']['schedule']>>) => {
    const current = schedule ?? { cron: '', mode: 'local' as const, enabled: false };
    onChange({
      ...agent,
      triggers: {
        ...agent.triggers,
        schedule: { ...current, ...patch },
      },
    });
  };

  const clearSchedule = () => {
    onChange({
      ...agent,
      triggers: { ...agent.triggers, schedule: undefined },
    });
  };

  const nextRun = scheduleCron && scheduleEnabled && scheduleMode === 'local'
    ? nextCronRun(scheduleCron)
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Manual — always on */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          background: 'rgba(102,226,122,0.06)',
          border: '1px solid rgba(102,226,122,0.2)',
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 18 }}>&#10003;</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#66E27A' }}>{t('agents.wizard.manualLaunch')}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{t('agents.wizard.manualLaunchDesc')}</div>
        </div>
      </div>

      {/* Drag & Drop — phase 2 live */}
      <FormField label={t('agents.wizard.dragDropLabel')} hint={t('agents.wizard.dragDropHint')}>
        <input
          style={inputStyle}
          placeholder={t('agents.wizard.dragDropPlaceholder')}
          value={(agent.triggers.dragDrop?.acceptsFileTypes ?? []).join(', ')}
          onChange={(e) => {
            const types = e.target.value
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
            onChange({
              ...agent,
              triggers: {
                ...agent.triggers,
                dragDrop: types.length > 0 ? { acceptsFileTypes: types } : undefined,
              },
            });
          }}
        />
      </FormField>

      {/* Schedule — LOCAL (real) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.65)', flex: 1 }}>
            {t('agents.wizard.localScheduleLabel')}
          </div>
          {/* Enable toggle */}
          <button
            onClick={() => {
              if (scheduleEnabled) {
                setSchedule({ enabled: false });
              } else {
                setSchedule({ enabled: true, cron: scheduleCron || '0 9 * * 1-5', mode: 'local' });
              }
            }}
            style={{
              padding: '3px 12px',
              borderRadius: 12,
              border: `1px solid ${scheduleEnabled ? '#66E27A' : 'rgba(255,255,255,0.18)'}`,
              background: scheduleEnabled ? 'rgba(102,226,122,0.12)' : 'transparent',
              color: scheduleEnabled ? '#66E27A' : 'rgba(255,255,255,0.4)',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {scheduleEnabled ? t('agents.wizard.scheduleActive') : t('agents.wizard.scheduleInactive')}
          </button>
        </div>

        {/* Frequency presets */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FREQUENCY_PRESETS.map((p) => {
            const isSelected = p.cron !== '' && scheduleCron === p.cron;
            const isCustomSelected = p.cron === '' && !FREQUENCY_PRESETS.some((q) => q.cron !== '' && q.cron === scheduleCron);
            return (
              <button
                key={p.label}
                onClick={() => {
                  if (p.cron !== '') {
                    setSchedule({ cron: p.cron, mode: 'local' });
                  }
                }}
                style={{
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: `1px solid ${(isSelected || isCustomSelected) ? '#7C5CFF' : 'rgba(255,255,255,0.12)'}`,
                  background: (isSelected || isCustomSelected) ? 'rgba(124,92,255,0.15)' : 'transparent',
                  color: (isSelected || isCustomSelected) ? '#C4B5FD' : 'rgba(255,255,255,0.4)',
                  fontSize: 11,
                  fontFamily: 'inherit',
                  cursor: p.cron !== '' ? 'pointer' : 'default',
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* Custom cron input */}
        <input
          style={inputStyle}
          value={scheduleCron}
          placeholder={t('agents.wizard.cronPlaceholder')}
          onChange={(e) => {
            if (e.target.value) {
              setSchedule({ cron: e.target.value, mode: scheduleMode, enabled: scheduleEnabled });
            } else {
              clearSchedule();
            }
          }}
        />

        {/* Next run preview */}
        {nextRun && (
          <div
            style={{
              fontSize: 11,
              color: '#4FC3F7',
              background: 'rgba(79,195,247,0.06)',
              border: '1px solid rgba(79,195,247,0.15)',
              borderRadius: 6,
              padding: '6px 10px',
            }}
          >
            {t('agents.wizard.nextRun')} : {nextRun} &nbsp;({formatCron(scheduleCron)})
          </div>
        )}

        {/* Mode selector */}
        {scheduleCron && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{t('agents.wizard.modeLabel')} :</span>
            <button
              onClick={() => setSchedule({ mode: 'local' })}
              style={{
                padding: '3px 10px',
                borderRadius: 5,
                border: `1px solid ${scheduleMode === 'local' ? '#7C5CFF' : 'rgba(255,255,255,0.12)'}`,
                background: scheduleMode === 'local' ? 'rgba(124,92,255,0.15)' : 'transparent',
                color: scheduleMode === 'local' ? '#C4B5FD' : 'rgba(255,255,255,0.4)',
                fontSize: 11,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {t('agents.wizard.modeLocal')}
            </button>
            <button
              onClick={() => setSchedule({ mode: 'cloud' })}
              style={{
                padding: '3px 10px',
                borderRadius: 5,
                border: `1px solid ${scheduleMode === 'cloud' ? '#FBB924' : 'rgba(255,255,255,0.12)'}`,
                background: scheduleMode === 'cloud' ? 'rgba(251,185,36,0.10)' : 'transparent',
                color: scheduleMode === 'cloud' ? '#FBB924' : 'rgba(255,255,255,0.4)',
                fontSize: 11,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {t('agents.wizard.modeCloud')}
            </button>
          </div>
        )}

        {scheduleMode === 'cloud' && scheduleCron && (
          <div
            style={{
              padding: '8px 12px',
              background: 'rgba(251,185,36,0.06)',
              border: '1px solid rgba(251,185,36,0.18)',
              borderRadius: 6,
              fontSize: 11,
              color: '#FBB924',
            }}
          >
            {t('agents.wizard.cloudNote')}
          </div>
        )}
      </div>

      {/* Event placeholder */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: 0.5 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>
          {t('agents.wizard.eventsLabel')} <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>({t('agents.wizard.comingSoon')})</span>
        </div>
        <input
          style={{ ...inputStyle, opacity: 0.5 }}
          disabled
          placeholder="on:commit, on:pr-open, on:file-change:src/**"
        />
      </div>
    </div>
  );
}

// ── Step 5: Revue ─────────────────────────────────────────────────

function StepRevue({ agent, onTestNow }: { agent: LazyAgent; onTestNow: () => void }) {
  const { t } = useI18n();
  const validation = validateAgent(agent);
  const preview = buildClaudeCodeAgentMd(agent);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Validation status */}
      {!validation.valid && (
        <div
          style={{
            padding: '10px 14px',
            background: 'rgba(248,113,113,0.08)',
            border: '1px solid rgba(248,113,113,0.25)',
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: '#F87171', marginBottom: 4 }}>
            {t('agents.wizard.validationErrors')}
          </div>
          {validation.errors.map((e, i) => (
            <div key={i} style={{ fontSize: 12, color: '#FCA5A5' }}>• {e}</div>
          ))}
        </div>
      )}

      {validation.warnings.map((w, i) => (
        <div
          key={i}
          style={{
            padding: '8px 12px',
            background: 'rgba(251,185,36,0.08)',
            border: '1px solid rgba(251,185,36,0.2)',
            borderRadius: 6,
            fontSize: 12,
            color: '#FBB924',
          }}
        >
          {w}
        </div>
      ))}

      {/* Generated .md preview */}
      <FormField label={t('agents.wizard.previewLabel')}>
        <div
          style={{
            background: '#0A0A10',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: '12px 14px',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: 'rgba(255,255,255,0.7)',
            whiteSpace: 'pre',
            overflow: 'auto',
            maxHeight: 300,
            lineHeight: 1.5,
          }}
        >
          {preview}
        </div>
      </FormField>

      {/* Test now */}
      <button
        onClick={onTestNow}
        disabled={!validation.valid}
        style={{
          padding: '9px 0',
          borderRadius: 7,
          border: 'none',
          background: validation.valid ? '#7C5CFF' : 'rgba(255,255,255,0.06)',
          color: validation.valid ? '#fff' : 'rgba(255,255,255,0.3)',
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: validation.valid ? 'pointer' : 'default',
        }}
      >
        {t('agents.wizard.testNow')}
      </button>
    </div>
  );
}

// ── Wizard shell ──────────────────────────────────────────────────

interface AgentWizardProps {
  initial?: LazyAgent;
  onSave: (agent: LazyAgent) => Promise<void>;
  onTestNow: (agent: LazyAgent) => void;
  onClose: () => void;
}

export function AgentWizard({ initial, onSave, onTestNow, onClose }: AgentWizardProps) {
  const { t } = useI18n();
  const [step, setStep] = useState(1);
  const [agent, setAgent] = useState<LazyAgent>(() => initial ?? createNewAgent());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const STEPS = [
    { id: 1, label: t('agents.wizard.step1') },
    { id: 2, label: t('agents.wizard.step2') },
    { id: 3, label: t('agents.wizard.step3') },
    { id: 4, label: t('agents.wizard.step4') },
    { id: 5, label: t('agents.wizard.step5') },
  ] as const;

  const handleChange = useCallback((updated: LazyAgent) => {
    setAgent(updated);
  }, []);

  const handleSave = useCallback(async () => {
    const validation = validateAgent(agent);
    if (!validation.valid) {
      setError(validation.errors.join(', '));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(agent);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [agent, onSave, onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: '#16161D',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 14,
          width: '90%',
          maxWidth: 640,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        data-testid="agent-wizard"
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 20px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: '#E2E2F0', flex: 1 }}>
            {initial ? t('agents.wizard.titleEdit') : t('agents.wizard.titleNew')}
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: 'rgba(255,255,255,0.4)',
              fontSize: 18,
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>

        {/* Step tabs */}
        <div
          style={{
            display: 'flex',
            padding: '0 20px',
            gap: 2,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            overflowX: 'auto',
          }}
        >
          {STEPS.map(({ id, label }) => (
            <button
              key={id}
              data-testid={`wizard-step-tab-${id}`}
              onClick={() => setStep(id)}
              style={{
                padding: '10px 14px',
                background: 'none',
                border: 'none',
                borderBottom: step === id ? '2px solid #7C5CFF' : '2px solid transparent',
                color: step === id ? '#C4B5FD' : 'rgba(255,255,255,0.4)',
                fontSize: 12,
                fontWeight: step === id ? 600 : 400,
                fontFamily: 'inherit',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'color 0.15s',
              }}
            >
              {id}. {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          {step === 1 && <StepIdentite agent={agent} onChange={handleChange} />}
          {step === 2 && <StepIntelligence agent={agent} onChange={handleChange} />}
          {step === 3 && <StepCapacites agent={agent} onChange={handleChange} />}
          {step === 4 && <StepDeclencheurs agent={agent} onChange={handleChange} />}
          {step === 5 && <StepRevue agent={agent} onTestNow={() => onTestNow(agent)} />}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 20px',
            borderTop: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          {error && (
            <span style={{ flex: 1, fontSize: 12, color: '#F87171' }}>{error}</span>
          )}
          {!error && <span style={{ flex: 1 }} />}

          {step > 1 && (
            <button
              onClick={() => setStep((s) => s - 1)}
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
              {t('agents.wizard.back')}
            </button>
          )}

          {step < 5 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
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
              {t('agents.wizard.next')}
            </button>
          ) : (
            <button
              data-testid="wizard-save-btn"
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: '6px 20px',
                borderRadius: 7,
                border: 'none',
                background: saving ? 'rgba(124,92,255,0.4)' : '#7C5CFF',
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: saving ? 'default' : 'pointer',
              }}
            >
              {saving ? t('agents.wizard.saving') : t('agents.wizard.save')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
