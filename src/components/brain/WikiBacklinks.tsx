/* WikiBacklinks — "what links here" strip for the Wiki note view.

   Renders the incoming-edges list WikiTab resolves via platform.brain.
   backlinks() + platform.brain.note() (title lookup, capped — see
   loadBacklinks in WikiTab.tsx) as a compact, clickable list matching the
   wiki-article look (muted section label, small purple links). Clicking an
   entry emits nav:focusBrainNode — the same in-view navigation mechanism
   WikiPage's own internal note links already use (see WikiPage.tsx
   handleArticleClick); WikiTab subscribes to that event and calls
   openNote(), so no extra callback prop needs to be threaded through.

   Renders nothing when there are no backlinks — an empty "what links here"
   section is worse than none. */

import { useI18n } from '../../i18n';
import { emit } from '../../lib/bus';
import { formatNeuronTitle } from '../../lib/brain/neuronTitle';

export interface WikiBacklinkItem {
  id: string;
  title: string;
}

interface WikiBacklinksProps {
  items: WikiBacklinkItem[];
  /** Count of additional backlinks beyond `items` — the uncapped total minus
      the resolved/shown list. 0 when nothing was truncated. */
  more: number;
}

function BacklinkRow({ item }: { item: WikiBacklinkItem }) {
  return (
    <button
      type="button"
      title={item.id}
      onClick={() => emit('nav:focusBrainNode', item.id)}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderRadius: 5,
        padding: '3px 6px',
        margin: '0 -6px',
        fontSize: 12,
        color: '#A78BFF',
        cursor: 'pointer',
        fontFamily: 'inherit',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {formatNeuronTitle(item.title, 80)}
    </button>
  );
}

export function WikiBacklinks({ items, more }: WikiBacklinksProps) {
  const { t } = useI18n();
  if (items.length === 0) return null;

  return (
    <div
      style={{
        maxWidth: 820,
        marginTop: 28,
        paddingTop: 12,
        borderTop: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.4)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 8,
        }}
      >
        {t('brain.wikiBacklinks')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {items.map((item) => (
          <BacklinkRow key={item.id} item={item} />
        ))}
      </div>
      {more > 0 && (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 4, padding: '0 6px' }}>
          {t('brain.wikiBacklinksMore', { count: more })}
        </div>
      )}
    </div>
  );
}
