/* MissionCard — kanban card for a mission, varies by status */

import { useEffect, useState } from 'react';
import type { Mission, ProofArtifact } from '../../lib/agents/types';
import { useI18n } from '../../i18n';
import { translateStatusReason } from '../../lib/agents/statusReasonLabel';

/** Queue dwell time after which the queued card shows a soft slow-start
    hint (v0.1.5 W2.5). */
const SLOW_START_MS = 30_000;
/** Light re-render cadence so the hint appears without any store write. */
const SLOW_START_TICK_MS = 15_000;

interface MissionCardProps {
  mission: Mission;
  onClick: () => void;
  onDelete?: () => void;
}

// ── Sub-renderers ──────────────────────────────────────────────────

function Chip({
  children,
  color = 'rgba(255,255,255,0.10)',
  textColor = 'rgba(255,255,255,0.55)',
  title,
}: {
  children: React.ReactNode;
  color?: string;
  textColor?: string;
  /** Native tooltip — used by the worktree chip below to surface
   *  Mission.baseBranch (which start point this worktree was created FROM)
   *  without adding a whole new visible element to the card. */
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 7px',
        borderRadius: 4,
        background: color,
        color: textColor,
        fontSize: 10,
        fontWeight: 500,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function QueuedCard({ mission, onClick, onDelete }: MissionCardProps) {
  const { t } = useI18n();

  // "now" lives in state (refreshed on mount, then every 15s) so the >30s
  // slow-start hint below is a pure derivation during render — no Date.now()
  // call in the render path itself (react-hooks/purity). The lazy initial
  // value is derived only from props so it stays pure too; the effect
  // corrects it to the real clock immediately after mount.
  const [now, setNow] = useState(() => mission.createdAt ?? 0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), SLOW_START_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const slowStart =
    !mission.statusReason &&
    typeof mission.createdAt === 'number' &&
    now - mission.createdAt > SLOW_START_MS;

  return (
    <button onClick={onClick} style={cardBase(false, false)}>
      <div style={{ opacity: 0.62 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
          <div style={titleStyle}>{mission.title}</div>
          {onDelete && <DeleteButton onClick={onDelete} />}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <Chip>{mission.model}</Chip>
          <LoopBadge mission={mission} />
          {mission.dependsOn && mission.dependsOn.length > 0 && (
            <Chip color="rgba(251,185,36,0.12)" textColor="#FBB924">
              {t('agents.card.waitingFor', { ids: mission.dependsOn.join(', ') })}
            </Chip>
          )}
        </div>
        {mission.statusReason && (
          <div
            data-testid="mission-status-reason"
            style={{ marginTop: 8, fontSize: 11, lineHeight: 1.4, color: '#FBB924' }}
          >
            {translateStatusReason(mission.statusReason, t)}
          </div>
        )}
        {slowStart && (
          <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.4, color: 'rgba(255,255,255,0.45)' }}>
            {t('agents.card.slowStartHint')}
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(255,255,255,0.28)' }}>
          {mission.id}
        </div>
      </div>
    </button>
  );
}

function RunningCard({ mission, onClick, onDelete }: MissionCardProps) {
  const { t } = useI18n();
  const isOrch = mission.isOrchestrator === true;

  return (
    <button
      onClick={onClick}
      className="agent-running-card"
      style={{
        ...cardBase(true, isOrch),
        cursor: 'pointer',
      }}
    >
      {/* Title row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
        <div style={{ ...titleStyle, flex: 1, minWidth: 0 }}>{mission.title}</div>
        {onDelete && <DeleteButton onClick={onDelete} />}
        {isOrch && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.06em',
              color: '#FBB924',
              background: 'rgba(251,185,36,0.12)',
              border: '1px solid rgba(251,185,36,0.25)',
              borderRadius: 3,
              padding: '1px 5px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            {t('agents.card.orchestrator')}
          </span>
        )}
      </div>

      {/* Live action or sub-agents */}
      {isOrch && mission.subAgents ? (
        <div
          style={{
            marginTop: 8,
            background: 'rgba(0,0,0,0.25)',
            borderRadius: 6,
            padding: '6px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {mission.subAgents.map((sa) => (
            <div
              key={sa.name}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: sa.status === 'running' ? '#22C55E' : 'rgba(255,255,255,0.2)',
                  flexShrink: 0,
                  display: 'inline-block',
                }}
              />
              <span style={{ fontSize: 11, color: sa.status === 'running' ? '#E2E2F0' : 'rgba(255,255,255,0.38)' }}>
                {sa.name}
              </span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', marginLeft: 'auto' }}>
                {sa.status === 'running' ? t('agents.card.active') : t('agents.card.waiting')}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7 }}>
          <span className="agent-live-dot" />
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', fontStyle: 'italic' }}>
            {mission.liveAction}
          </span>
        </div>
      )}

      {/* Progress bar (non-orchestrator) */}
      {!isOrch && mission.progress !== undefined && (
        <div style={{ marginTop: 8 }}>
          <div className="agent-progress-track">
            <div className="agent-progress-bar" style={{ width: `${mission.progress}%` }} />
          </div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 3, textAlign: 'right' }}>
            {mission.progress}%
          </div>
        </div>
      )}

      {/* Footer chips */}
      <div style={{ display: 'flex', gap: 5, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {mission.model && <Chip color="rgba(124,92,255,0.15)" textColor="#C4B5FD">{mission.model}</Chip>}
        <LoopBadge mission={mission} />
        {mission.worktree && (
          <Chip
            color="rgba(255,255,255,0.06)"
            textColor="rgba(255,255,255,0.45)"
            title={mission.baseBranch ? t('agents.card.startedFrom', { branch: mission.baseBranch }) : undefined}
          >
            {mission.worktree}
          </Chip>
        )}
        {mission.brainCitations && mission.brainCitations.length > 0 && (
          <Chip color="rgba(124,92,255,0.10)" textColor="#A78BFF">🧠 brain</Chip>
        )}
        {/* Cross-project READ access transparency — see
            Mission.extraReadableRoots' doc comment (lib/agents/types.ts).
            Renders only when this mission actually declared extra
            readable roots (the overwhelming common case has none). */}
        {mission.extraReadableRoots && mission.extraReadableRoots.length > 0 && (
          <Chip
            color="rgba(96,165,250,0.12)"
            textColor="#60A5FA"
            title={`Lecture cross-projet autorisée (écriture bloquée hors worktree) :\n${mission.extraReadableRoots.join('\n')}`}
          >
            📖 {mission.extraReadableRoots.length === 1 ? '1 projet' : `${mission.extraReadableRoots.length} projets`}
          </Chip>
        )}
        {mission.dependsOn && mission.dependsOn.length > 0 && (
          <Chip color="rgba(251,185,36,0.12)" textColor="#FBB924">
            {t('agents.card.waitingFor', { ids: mission.dependsOn.join(', ') })}
          </Chip>
        )}
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
        {mission.filesCount !== undefined && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
            {t('agents.detail.filesCount', { count: String(mission.filesCount) })}
          </span>
        )}
        {mission.duration && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>{mission.duration}</span>
        )}
        {mission.cost && (
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginLeft: 'auto' }}>{mission.cost}</span>
        )}
      </div>
    </button>
  );
}

function ReviewCard({ mission, onClick, onDelete }: MissionCardProps) {
  const { t } = useI18n();
  return (
    <button onClick={onClick} style={cardBase(false, false)}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
        <div style={titleStyle}>{mission.title}</div>
        {onDelete && <DeleteButton onClick={onDelete} />}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <LoopBadge mission={mission} />
      </div>

      {/* Diff stats */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {mission.diffAdded !== undefined && (
          <span style={{ fontSize: 12, color: '#4ADE80', fontWeight: 600 }}>
            +{mission.diffAdded}
          </span>
        )}
        {mission.diffRemoved !== undefined && (
          <span style={{ fontSize: 12, color: '#F87171', fontWeight: 600 }}>
            -{mission.diffRemoved}
          </span>
        )}
        {/* Trust-critical defect #2 (M2 forensics) — an empty deliverable
            must never show the same green "N/M approve" chip a real review
            gets: that reads as partial success on a mission that produced
            nothing. Takes priority over judgesApproved (mutually exclusive
            in practice — evaluateMission's emptyDeliverable short-circuit
            never lets a real judge verdict form). */}
        {mission.emptyDeliverable ? (
          <span style={{ fontSize: 11, color: '#FBB924', marginLeft: 4, fontWeight: 600 }}>
            {t('agents.card.emptyDeliverable')}
          </span>
        ) : (
          mission.judgesApproved && (
            <span style={{ fontSize: 11, color: '#4ADE80', marginLeft: 4 }}>{mission.judgesApproved}</span>
          )
        )}
      </div>

      {/* Chips */}
      <div style={{ display: 'flex', gap: 5, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {mission.model && <Chip color="rgba(124,92,255,0.15)" textColor="#C4B5FD">{mission.model}</Chip>}
        {mission.worktree && (
          <Chip
            color="rgba(255,255,255,0.06)"
            textColor="rgba(255,255,255,0.45)"
            title={mission.baseBranch ? t('agents.card.startedFrom', { branch: mission.baseBranch }) : undefined}
          >
            {mission.worktree}
          </Chip>
        )}
        {mission.extraReadableRoots && mission.extraReadableRoots.length > 0 && (
          <Chip
            color="rgba(96,165,250,0.12)"
            textColor="#60A5FA"
            title={`Lecture cross-projet autorisée (écriture bloquée hors worktree) :\n${mission.extraReadableRoots.join('\n')}`}
          >
            📖 {mission.extraReadableRoots.length === 1 ? '1 projet' : `${mission.extraReadableRoots.length} projets`}
          </Chip>
        )}
      </div>

      {/* Review button */}
      <div style={{ marginTop: 10 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            borderRadius: 5,
            background: 'rgba(34,197,94,0.12)',
            border: '1px solid rgba(34,197,94,0.25)',
            color: '#4ADE80',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {t('agents.card.review')} →
        </span>
      </div>
    </button>
  );
}

function ProofGallery({ proofs }: { proofs: ProofArtifact[] }) {
  if (!proofs || proofs.length === 0) return null;
  return (
    <div
      data-testid="proof-gallery"
      style={{
        marginTop: 8,
        display: 'flex',
        gap: 4,
        flexWrap: 'wrap',
      }}
    >
      {proofs.map((proof, i) => {
        const icon = proof.kind === 'screenshot' ? '🖼' : proof.kind === 'test_run' ? '✓' : proof.kind === 'e2e_recording' ? '▶' : '📄';
        const label = proof.kind === 'screenshot' ? proof.label : proof.kind === 'test_run' ? `exit ${proof.exitCode}` : proof.kind;
        return (
          <div
            key={i}
            title={typeof label === 'string' ? label : proof.kind}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'rgba(34,197,94,0.10)',
              border: '1px solid rgba(34,197,94,0.20)',
              fontSize: 10,
              color: '#4ADE80',
              whiteSpace: 'nowrap',
            }}
          >
            <span>{icon}</span>
            <span style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {typeof label === 'string' ? label : proof.kind}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DoneCard({ mission, onClick, onDelete }: MissionCardProps) {
  const { t } = useI18n();
  return (
    <button onClick={onClick} style={{ ...cardBase(false, false), opacity: 0.75 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ ...titleStyle, flex: 1, minWidth: 0 }}>{mission.title}</div>
        <span style={{ color: '#4ADE80', fontSize: 14, marginLeft: 2 }}>✓</span>
        <LoopBadge mission={mission} />
        {onDelete && <DeleteButton onClick={onDelete} />}
      </div>
      {mission.merged && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#4ADE80', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span>⎇</span> {t('agents.card.merged')}
        </div>
      )}
      {mission.proofs && mission.proofs.length > 0 && (
        <ProofGallery proofs={mission.proofs} />
      )}
      <div style={{ marginTop: 6, display: 'flex', gap: 8, fontSize: 10, color: 'rgba(255,255,255,0.32)' }}>
        {mission.cost && <span>{mission.cost}</span>}
        <span>{mission.id}</span>
      </div>
    </button>
  );
}

function FailedCard({ mission, onClick, onDelete }: MissionCardProps) {
  const { t } = useI18n();
  return (
    <button onClick={onClick} style={{ ...cardBase(false, false), borderColor: 'rgba(239,68,68,0.25)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ ...titleStyle, flex: 1, minWidth: 0 }}>{mission.title}</div>
        <span style={{ color: '#F87171', fontSize: 14, marginLeft: 2 }}>✕</span>
        <LoopBadge mission={mission} />
        {onDelete && <DeleteButton onClick={onDelete} />}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: '#F87171' }}>
        {t('agents.card.failed')}
      </div>
      {mission.statusReason && (
        <div
          data-testid="mission-status-reason"
          style={{
            marginTop: 6,
            fontSize: 11,
            lineHeight: 1.45,
            color: '#FCA5A5',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 6,
            padding: '6px 8px',
          }}
        >
          {translateStatusReason(mission.statusReason, t)}
        </div>
      )}
      <div style={{ marginTop: 6, display: 'flex', gap: 8, fontSize: 10, color: 'rgba(255,255,255,0.32)' }}>
        <span>{mission.id}</span>
      </div>
    </button>
  );
}

function CancelledCard({ mission, onClick, onDelete }: MissionCardProps) {
  const { t } = useI18n();
  return (
    <button onClick={onClick} style={{ ...cardBase(false, false), opacity: 0.5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ ...titleStyle, flex: 1, minWidth: 0, textDecoration: 'line-through' }}>{mission.title}</div>
        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14, marginLeft: 2 }}>⊘</span>
        <LoopBadge mission={mission} />
        {onDelete && <DeleteButton onClick={onDelete} />}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
        {t('agents.card.cancelled')}
      </div>
      <div style={{ marginTop: 6, display: 'flex', gap: 8, fontSize: 10, color: 'rgba(255,255,255,0.22)' }}>
        <span>{mission.id}</span>
      </div>
    </button>
  );
}

// ── Loop badge ─────────────────────────────────────────────────────

function LoopBadge({ mission }: { mission: Mission }) {
  if (mission.loopConfig) {
    const cfg = mission.loopConfig;
    return (
      <Chip color="rgba(124,92,255,0.15)" textColor="#a78bfa">
        loop {cfg.cadence} #{cfg.iterationCount}
      </Chip>
    );
  }
  if (mission.loopParentId && mission.loopIteration) {
    return (
      <Chip color="rgba(124,92,255,0.15)" textColor="#a78bfa">
        iter #{mission.loopIteration}
      </Chip>
    );
  }
  return null;
}

// ── Styles ─────────────────────────────────────────────────────────

function cardBase(running: boolean, orchestrator: boolean): React.CSSProperties {
  if (running) {
    return {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      background: orchestrator ? 'rgba(251,185,36,0.04)' : '#191924',
      border: orchestrator
        ? '1px solid rgba(251,185,36,0.25)'
        : '1px solid rgba(124,92,255,0.2)',
      borderRadius: 10,
      padding: '11px 12px',
      cursor: 'pointer',
      fontFamily: 'inherit',
    };
  }
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: '11px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#E2E2F0',
  lineHeight: 1.35,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical' as const,
};

// ── Main export ────────────────────────────────────────────────────

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <span
      role="button"
      aria-label="Delete mission"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        borderRadius: 5,
        background: 'transparent',
        color: 'rgba(255,255,255,0.3)',
        fontSize: 13,
        cursor: 'pointer',
        transition: 'background 0.12s, color 0.12s',
        lineHeight: 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(239,68,68,0.15)';
        e.currentTarget.style.color = '#F87171';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'rgba(255,255,255,0.3)';
      }}
    >
      🗑
    </span>
  );
}

export function MissionCard({ mission, onClick, onDelete }: MissionCardProps) {
  switch (mission.status) {
    case 'queued':
      return <QueuedCard mission={mission} onClick={onClick} onDelete={onDelete} />;
    case 'running':
      return <RunningCard mission={mission} onClick={onClick} onDelete={onDelete} />;
    case 'review':
      return <ReviewCard mission={mission} onClick={onClick} onDelete={onDelete} />;
    case 'done':
      return <DoneCard mission={mission} onClick={onClick} onDelete={onDelete} />;
    case 'failed':
      return <FailedCard mission={mission} onClick={onClick} onDelete={onDelete} />;
    case 'cancelled':
      return <CancelledCard mission={mission} onClick={onClick} onDelete={onDelete} />;
    default:
      return null;
  }
}
