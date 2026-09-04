/* BrainWiki — right panel: selected node's wiki page.
   Shows title, type pill, date, status, tags, body, links, files,
   temporal validity, cluster box, action buttons.
   Accepts AdaptedNode + WikiPayload (real or mock).

   Wired:
   - "Open in code" -> emit editor:openFile with node source file if known
   - "History"      -> show provenance/meta or honest "no history yet" label
   - Wiki links     -> emit nav:focusBrainNode to navigate to linked node
*/

import { useState } from 'react';
import type { WikiPayload } from '../../lib/mock/brain';
import type { AdaptedNode } from '../../lib/brain/brainAdapter';
import { formatNeuronTitle } from '../../lib/brain/neuronTitle';
import { useI18n } from '../../i18n';
import { emit } from '../../lib/bus';
import { NoteMeta } from './NoteMeta';

// ── Cluster colors (real IDE clusters) ────────────────────────────

const CLUSTER_COLOR_MAP: Record<string, string> = {
  editor:  '#9B7CFF',
  agents:  '#4FC3F7',
  brain:   '#66E27A',
  tauri:   '#FFC76B',
  models:  '#FF7BB0',
  topical: '#F472B6', // rose — topical notes (data-cerveau-space=topical)
  // Legacy mock clusters
  Auth:     '#9B7CFF',
  Paiement: '#4FC3F7',
  Tests:    '#66E27A',
  Infra:    '#FFC76B',
  UI:       '#FF7BB0',
  unknown:  '#888888',
};

// ── Sub-components ────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 9,
        fontWeight: 700,
        color: 'rgba(255,255,255,0.3)',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        marginBottom: 7,
      }}
    >
      {children}
    </div>
  );
}

// ── BrainWiki ─────────────────────────────────────────────────────

interface BrainWikiProps {
  node: AdaptedNode | null;
  wikiPayload?: WikiPayload | null;
  clusterStats?: Record<string, string>;
}

function TopicalPill({ t }: { t: (key: string) => string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 10,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: 'rgba(244,114,182,0.15)',
        color: '#F472B6',
        border: '1px solid rgba(244,114,182,0.3)',
      }}
    >
      {t('brain.wiki.topical')}
    </span>
  );
}

// ── Contradiction warning ─────────────────────────────────────────
//
// Surfaces the engine's contradiction-detection signal (data-cerveau-conflict-
// with, written by engine/src/graph/contradictions.ts and serialized on
// /_api/note-meta as conflictWith). Non-empty → this note contradicts one or
// more past decisions; each is a button that navigates to the conflicting note.

interface ContradictionWarningProps {
  conflictWith: string[];
  t: (key: string, params?: Record<string, string | number>) => string;
}

function ContradictionWarning({ conflictWith, t }: ContradictionWarningProps) {
  if (conflictWith.length === 0) return null;
  return (
    <div
      role="alert"
      style={{
        background: 'rgba(239,68,68,0.1)',
        border: '1px solid rgba(239,68,68,0.35)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span aria-hidden style={{ fontSize: 14, lineHeight: 1, color: '#FCA5A5' }}>
          ⊘
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: '#FCA5A5',
            letterSpacing: '0.02em',
          }}
        >
          {t('brain.contradiction')}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {conflictWith.map((target) => (
          <button
            key={target}
            type="button"
            title={target}
            onClick={() => emit('nav:focusBrainNode', target)}
            style={{
              textAlign: 'left',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: 5,
              padding: '4px 8px',
              fontSize: 11,
              color: '#FCA5A5',
              cursor: 'pointer',
              fontFamily: 'inherit',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {t('brain.contradictionWith', { target: `#${target}` })}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BrainWiki({ node, wikiPayload, clusterStats }: BrainWikiProps) {
  const { t } = useI18n();
  const [showHistory, setShowHistory] = useState(false);

  if (!node) return null;

  const data = wikiPayload;
  const color = CLUSTER_COLOR_MAP[node.cluster] ?? '#888888';
  const stat = clusterStats?.[node.cluster] ?? `cluster ${node.cluster}`;

  // Build display values from payload or fallback to node data. A neuron
  // derived from a mission prompt can carry raw HTML markup and/or an
  // upstream mid-tag hard-truncation (see lib/brain/neuronTitle.ts) — always
  // sanitize before rendering.
  const title = formatNeuronTitle(data?.title ?? node.name, 200);
  const type = data?.type ?? node.type;
  const status = data?.status ?? 'active';
  const meta = data?.meta ?? `${node.cluster} · 2026`;
  const tags = data?.tags ?? [`#${node.cluster.toLowerCase()}`];
  const body = data?.body ?? t('brain.wiki.neuronOfCluster', { cluster: node.cluster });
  const links = data?.links ?? [];
  const files = data?.files ?? [];
  const validity = data?.validity ?? t('brain.wiki.validCluster', { cluster: node.cluster });
  // Contradiction-detection signal — non-empty when this note contradicts one
  // or more past decisions (see ContradictionWarning above).
  const conflictWith = data?.conflictWith ?? [];

  const statusStyle =
    status === 'active'
      ? {
          bg: 'rgba(34,197,94,0.12)',
          color: '#4ADE80',
          border: 'rgba(34,197,94,0.25)',
        }
      : {
          bg: 'rgba(255,255,255,0.07)',
          color: 'rgba(255,255,255,0.45)',
          border: 'rgba(255,255,255,0.1)',
        };

  return (
    <div
      style={{
        width: 340,
        minWidth: 0,
        flexShrink: 0,
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: '#0E0E12',
      }}
    >
      {/* Header */}
      <div style={{ padding: '16px 16px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <NoteMeta
            kind={type}
            author={data?.author}
            when={data?.when ?? (node.created ? node.created.slice(0, 10) : undefined)}
          />
          {(node.isTopical || node.cluster === 'topical') && <TopicalPill t={t} />}
          {node.sourceProject && (
            <span
              title={node.sourceProject}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: 4,
                padding: '2px 7px',
                fontSize: 9,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                background: 'rgba(255,255,255,0.06)',
                color: 'rgba(255,255,255,0.4)',
                border: '1px solid rgba(255,255,255,0.1)',
                maxWidth: 120,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {node.sourceProject.split(/[\\/]/).pop() ?? node.sourceProject}
            </span>
          )}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              borderRadius: 10,
              padding: '2px 9px',
              fontSize: 10,
              fontWeight: 600,
              background: statusStyle.bg,
              color: statusStyle.color,
              border: `1px solid ${statusStyle.border}`,
            }}
          >
            {status === 'active' && (
              <span
                style={{
                  display: 'inline-block',
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: '#4ADE80',
                }}
              />
            )}
            {status}
          </span>
        </div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: '#E8E3FF',
            lineHeight: 1.3,
            marginBottom: 6,
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginBottom: 8 }}>
          {meta}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
          {tags.map((t) => (
            <span
              key={t}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                background: 'rgba(124,92,255,0.1)',
                borderRadius: 4,
                padding: '2px 7px',
                fontSize: 10,
                color: '#A78BFF',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {t}
            </span>
          ))}
        </div>
        <div style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }} />
      </div>

      {/* Scrollable body */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Contradiction warning — shown when the engine flagged this note as
            contradicting a past decision (data-cerveau-conflict-with). */}
        <ContradictionWarning conflictWith={conflictWith} t={t} />

        {/* Body text */}
        <div>
          <div
            style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', lineHeight: 1.65 }}
          >
            {body}
          </div>
        </div>

        {/* Links */}
        <div>
          <SectionTitle>{t('brain.wiki.linksSection')}</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {links.length === 0 ? (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', padding: '4px 8px' }}>
                {t('brain.wiki.noRichLinks')}
              </div>
            ) : (
              links.map((l, i) => (
                <div
                  key={i}
                  role="button"
                  tabIndex={0}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '5px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 11,
                  }}
                  onClick={() => emit('nav:focusBrainNode', l.target)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') emit('nav:focusBrainNode', l.target);
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.05)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                  }}
                >
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      color: 'rgba(255,255,255,0.3)',
                      minWidth: 70,
                      flexShrink: 0,
                    }}
                  >
                    {l.label}
                  </span>
                  <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10 }}>=&gt;</span>
                  <span style={{ color: '#A78BFF', fontWeight: 500 }}>{l.target}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Files */}
        {files.length > 0 && (
          <div>
            <SectionTitle>{t('brain.wiki.linkedFiles')}</SectionTitle>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {files.map((f) => (
                <span
                  key={f}
                  role="button"
                  tabIndex={0}
                  onClick={() => emit('editor:openFile', { path: f })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') emit('editor:openFile', { path: f });
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 5,
                    padding: '3px 8px',
                    fontSize: 10,
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    color: 'rgba(255,255,255,0.55)',
                    cursor: 'pointer',
                  }}
                >
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Temporal validity */}
        <div
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 8,
            padding: '10px 12px',
          }}
        >
          <SectionTitle>{t('brain.temporalValidity')}</SectionTitle>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{validity}</div>
        </div>

        {/* Cluster box */}
        <div
          style={{
            background: `${color}1a`,
            border: `1px solid ${color}33`,
            borderRadius: 8,
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: `${color}2e`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: color,
                boxShadow: `0 0 8px ${color}`,
              }}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#C4B5FD' }}>
              {t('brain.wiki.clusterBoxTitle', { cluster: node.cluster })}
            </div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>{stat}</div>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => {
              // Prefer first file in the list; fall back to the node id as a hint
              const sourcePath = files[0] ?? node.id;
              emit('editor:openFile', { path: sourcePath });
            }}
            style={{
              flex: 1,
              padding: '7px 10px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              border: '1px solid rgba(124,92,255,0.35)',
              background: 'rgba(124,92,255,0.15)',
              color: '#C4B5FD',
              fontFamily: 'inherit',
            }}
          >
            {t('brain.wiki.openInCode')}
          </button>
          <button
            onClick={() => setShowHistory((prev) => !prev)}
            style={{
              flex: 1,
              padding: '7px 10px',
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              border: showHistory
                ? '1px solid rgba(124,92,255,0.35)'
                : '1px solid rgba(255,255,255,0.1)',
              background: showHistory
                ? 'rgba(124,92,255,0.15)'
                : 'rgba(255,255,255,0.05)',
              color: showHistory ? '#C4B5FD' : 'rgba(255,255,255,0.65)',
              fontFamily: 'inherit',
            }}
          >
            {t('brain.wiki.history')}
          </button>
        </div>

        {/* History panel */}
        {showHistory && (
          <div
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 6,
              padding: '10px 12px',
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: 'rgba(255,255,255,0.3)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                marginBottom: 6,
              }}
            >
              {t('brain.wiki.provenance')}
            </div>
            {/* Show meta from wikiPayload if available, otherwise honest label */}
            {wikiPayload ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                  <span style={{ color: 'rgba(255,255,255,0.3)' }}>{t('brain.wiki.dateLabel')}</span>{' '}
                  {wikiPayload.meta}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                  <span style={{ color: 'rgba(255,255,255,0.3)' }}>{t('brain.wiki.clusterLabel')}</span>{' '}
                  {node.cluster}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                  <span style={{ color: 'rgba(255,255,255,0.3)' }}>{t('brain.wiki.validityLabel')}</span>{' '}
                  {wikiPayload.validity}
                </div>
                <div
                  style={{
                    fontSize: 9,
                    color: 'rgba(255,199,107,0.6)',
                    marginTop: 4,
                  }}
                >
                  {t('brain.wiki.fullHistoryNoneYet')}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                {t('brain.wiki.noHistoryYet')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
