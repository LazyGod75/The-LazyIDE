/* MissionDetailRight — right column of MissionDetail (Diff, Scope, Brain, Cost, Proofs) */

import type { Mission, ProofArtifact } from '../../lib/agents/types';
import { derivePerimeterRows } from '../../lib/agents/perimeter';
import { useI18n } from '../../i18n';

interface MissionDetailRightProps {
  mission: Mission;
}

function Card({
  title,
  children,
  testId,
  id,
}: {
  title: string;
  children: React.ReactNode;
  /** Optional locale-independent hook for e2e/component tests — the title
   *  itself is translated (see i18n/locales/*.ts's 'agents.detail.*Title'
   *  keys), so anything driving this UI in a non-English locale must never
   *  assert on the rendered title text (see ProofsCard's call site). */
  testId?: string;
  /** QA B14: stable DOM id so MissionDetail's focusSection effect can
   *  document.getElementById + scrollIntoView it — only DiffCard sets this
   *  today (see its call site below). */
  id?: string;
}) {
  return (
    <div
      id={id}
      data-testid={testId}
      style={{
        background: '#16161D',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '9px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.45)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {title}
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
    </div>
  );
}

function DiffCard({ mission }: { mission: Mission }) {
  const { t } = useI18n();
  if (!mission.diffFiles && !mission.diffSnippet) return null;

  return (
    <Card id="mission-diff-card" testId="diff-card" title={t('agents.detail.diffLive')}>
      {mission.diffFiles && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
          {mission.diffFiles.map((f) => (
            <div
              key={f.filename}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 8px',
                borderRadius: 5,
                background: f.inProgress ? 'rgba(124,92,255,0.06)' : 'transparent',
                border: f.inProgress ? '1px solid rgba(124,92,255,0.15)' : '1px solid transparent',
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.65)',
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.filename}
              </span>
              <span style={{ fontSize: 10, color: '#4ADE80', fontWeight: 600 }}>+{f.added}</span>
              <span style={{ fontSize: 10, color: '#F87171', fontWeight: 600 }}>-{f.removed}</span>
              {f.inProgress && (
                <span
                  style={{
                    fontSize: 9,
                    color: '#C4B5FD',
                    background: 'rgba(124,92,255,0.15)',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontWeight: 600,
                  }}
                >
                  {t('agents.detail.inProgress')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {mission.diffSnippet && (
        <pre
          style={{
            margin: 0,
            padding: '8px 10px',
            background: '#0A0A10',
            borderRadius: 6,
            fontSize: 11,
            lineHeight: 1.6,
            overflowX: 'auto',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          }}
        >
          {mission.diffSnippet.map((line, i) => {
            const isAdd = line.startsWith('+');
            const isRem = line.startsWith('-');
            return (
              <div
                key={i}
                style={{
                  color: isAdd ? '#4ADE80' : isRem ? '#F87171' : 'rgba(255,255,255,0.45)',
                  background: isAdd ? 'rgba(74,222,128,0.06)' : isRem ? 'rgba(248,113,113,0.06)' : 'transparent',
                  marginLeft: -10,
                  paddingLeft: 10,
                  paddingRight: 10,
                }}
              >
                {line}
              </div>
            );
          })}
        </pre>
      )}
    </Card>
  );
}

/** D13 graft (b) — "Périmètre" block: declared scope paths (✓) plus any
 *  genuinely recorded denial signal (✕) — see perimeter.ts's module doc
 *  comment for the honesty rules (scopePaths is declared-only, never
 *  runtime-enforced; ✕ rows are never fabricated). Hidden entirely when the
 *  mission has no contract/scopePaths, same convention as BrainCard/DiffCard. */
function ScopeCard({ mission }: { mission: Mission }) {
  const { t } = useI18n();
  const rows = derivePerimeterRows(mission);
  if (rows.length === 0) return null;

  return (
    <Card title={t('agents.detail.scopeTitle')} testId="scope-card">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {rows.map((row) => (
          <div key={row.path} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: row.state === 'flagged' ? '#F87171' : '#4ADE80', flexShrink: 0 }}>
                {row.state === 'flagged' ? '✕' : '✓'}
              </span>
              <span
                style={{
                  fontSize: 11.5,
                  color: 'rgba(255,255,255,0.7)',
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {row.path}
              </span>
            </div>
            {row.state === 'flagged' && row.detail && (
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginLeft: 18, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {row.detail}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.32)', lineHeight: 1.4 }}>
        {t('agents.detail.scopeDeclaredHint')}
      </div>
    </Card>
  );
}

function BrainCard({ mission }: { mission: Mission }) {
  const { t } = useI18n();
  // brainCitations is only ever populated by the dev mock seed today — no
  // real LazyBrain citation pipeline writes to this field yet. Hide the
  // card rather than show stale/fake context so we never imply the agent
  // actually grounded itself when we don't have evidence it did.
  if (!mission.brainCitations || mission.brainCitations.length === 0) return null;

  return (
    <Card title={t('agents.detail.brainContext')}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {mission.brainCitations.map((c) => (
          <span
            key={c.id}
            style={{
              fontSize: 11,
              color: '#C4B5FD',
              background: 'rgba(124,92,255,0.12)',
              border: '1px solid rgba(124,92,255,0.25)',
              padding: '3px 8px',
              borderRadius: 5,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            }}
          >
            {c.label}
          </span>
        ))}
      </div>
      {mission.tokensSaved && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 8px',
            background: 'rgba(34,197,94,0.06)',
            border: '1px solid rgba(34,197,94,0.15)',
            borderRadius: 5,
          }}
        >
          <span style={{ fontSize: 11, color: '#4ADE80' }}>{mission.tokensSaved}</span>
        </div>
      )}
    </Card>
  );
}

/** Minimal proof-of-work list (spec §8, T1.4) — one row per Mission.proofs
    entry (kind badge + the most salient field(s) for that kind + path/
    outputPath where applicable). No preview/viewer yet — W2's kanban Review
    column builds the full proof gallery; this is just enough to see, at a
    glance, what evidence a mission has actually attached. Hidden entirely
    when there are no proofs yet, same convention as BrainCard/DiffCard
    above (never show an empty-state placeholder here). */
function ProofsCard({ mission }: { mission: Mission }) {
  const { t } = useI18n();
  if (!mission.proofs || mission.proofs.length === 0) return null;

  function proofSummary(proof: ProofArtifact): string {
    switch (proof.kind) {
      case 'screenshot':
        return proof.label;
      case 'test_run':
        return proof.command;
      case 'e2e_recording':
        return proof.path;
      case 'command_output':
        return proof.command;
      case 'behavior_diff':
        return `${proof.before} → ${proof.after}`;
    }
  }

  function proofPath(proof: ProofArtifact): string | undefined {
    switch (proof.kind) {
      case 'screenshot':
      case 'e2e_recording':
        return proof.path;
      case 'test_run':
      case 'command_output':
        return proof.outputPath;
      case 'behavior_diff':
        return undefined;
    }
  }

  return (
    <Card title={t('agents.detail.proofsTitle')} testId="proofs-card">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {mission.proofs.map((proof, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '6px 8px',
              borderRadius: 5,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#C4B5FD',
                  background: 'rgba(124,92,255,0.12)',
                  border: '1px solid rgba(124,92,255,0.25)',
                  padding: '1px 6px',
                  borderRadius: 4,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {t(`agents.modal.proof.${proof.kind}`)}
              </span>
              {proof.kind === 'test_run' && (
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
                  {t('agents.detail.proofExitCode', { code: proof.exitCode })}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.65)',
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {proofSummary(proof)}
            </div>
            {proofPath(proof) && (
              <div
                style={{
                  fontSize: 10,
                  color: 'rgba(255,255,255,0.32)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {proofPath(proof)}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Real per-run cost/token numbers from the Rust agent runner.
    Mirrors the formatting used by MissionDetail's Observability row
    (credits = round(costUsd * 100), fr-FR thousands separator) so the
    two views of the same metrics never disagree. */
function CostCard({ mission }: { mission: Mission }) {
  const { t } = useI18n();
  const metrics = mission.agentMetrics;

  return (
    <Card title={t('agents.detail.costTokens')}>
      {!metrics ? (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.32)' }}>
          {t('agents.detail.awaitingMetrics')}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#E2E2F0', fontFamily: "'JetBrains Mono', monospace" }}>
                {metrics.costUsd > 0 ? Math.round(metrics.costUsd * 100).toLocaleString() : '—'}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>{t('agents.detail.totalCost')}</div>
            </div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#C4B5FD', fontFamily: "'JetBrains Mono', monospace" }}>
                {metrics.inputTokens + metrics.outputTokens > 0
                  ? (metrics.inputTokens + metrics.outputTokens).toLocaleString()
                  : '—'}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>{t('agents.detail.tokens')}</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 14 }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              {t('agents.detail.metricDuration')}: {(metrics.durationMs / 1000).toFixed(1)}s
            </span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
              {t('agents.detail.metricToolCalls')}: {metrics.toolCount}
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

export function MissionDetailRight({ mission }: MissionDetailRightProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <DiffCard mission={mission} />
      <ScopeCard mission={mission} />
      <BrainCard mission={mission} />
      <CostCard mission={mission} />
      <ProofsCard mission={mission} />
    </div>
  );
}
