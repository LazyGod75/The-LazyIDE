/* NoteMeta — type / author / date chips matching the Night Signal wiki HUD.
   Author is never on BrainNoteMeta; callers parse it from note HTML
   (data-cerveau-author) or omit the chip. */

import type { CSSProperties } from 'react';
import './brain-hud.css';

const KIND_TONE: Record<string, { bg: string; fg: string }> = {
  decision: { bg: 'var(--color-accent-soft)', fg: 'var(--color-accent-light)' },
  rule: { bg: 'rgba(251,185,36,0.14)', fg: 'var(--color-warning)' },
  file: { bg: 'rgba(56,189,248,0.12)', fg: 'var(--color-assistant-cyan)' },
  bug: { bg: 'rgba(248,113,113,0.14)', fg: 'var(--color-danger)' },
  concept: { bg: 'rgba(74,222,128,0.12)', fg: 'var(--color-success)' },
  synthesis: { bg: 'var(--color-accent-soft)', fg: 'var(--color-accent-light)' },
  skill: { bg: 'rgba(56,189,248,0.12)', fg: 'var(--color-assistant-cyan)' },
  module: { bg: 'rgba(74,222,128,0.12)', fg: 'var(--color-success)' },
};

function hueForAuthor(author: string): string {
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0;
  const hues = ['#7C5CFF', '#4FC3F7', '#FF7BB0', '#66E27A', '#FFC76B'];
  return hues[h % hues.length];
}

export function KindPill({ kind }: { kind: string }) {
  const t = KIND_TONE[kind] ?? { bg: 'var(--color-panel-3)', fg: 'var(--color-text-muted)' };
  const style: CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '3px 8px',
    borderRadius: 99,
    background: t.bg,
    color: t.fg,
  };
  return (
    <span data-testid="note-kind-pill" style={style}>
      {kind}
    </span>
  );
}

export function Avatar({
  initials,
  color,
  size = 28,
}: {
  initials: string;
  color: string;
  size?: number;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        display: 'grid',
        placeItems: 'center',
        fontSize: size * 0.38,
        fontWeight: 700,
        color: '#fff',
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  );
}

export function NoteMeta({
  kind,
  author,
  when,
  cluster,
}: {
  kind: string;
  author?: string;
  when?: string;
  cluster?: string;
}) {
  const initials = author
    ? author
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '';
  return (
    <div className="note-meta" data-testid="note-meta">
      <KindPill kind={kind} />
      {author && (
        <span className="note-chip note-chip-author" data-testid="note-meta-author">
          <Avatar initials={initials} color={hueForAuthor(author)} size={16} />
          {author}
        </span>
      )}
      {when && (
        <span className="note-chip note-chip-when" data-testid="note-meta-when">
          {when}
        </span>
      )}
      {cluster && (
        <span className="note-chip note-chip-cluster" data-testid="note-meta-cluster">
          {cluster}
        </span>
      )}
    </div>
  );
}
