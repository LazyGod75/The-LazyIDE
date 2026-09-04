/* WindowSelector — segmented control for selecting a UsageWindow */

import type { UsageWindow } from '../../lib/models/usageHistory';
import { useI18n } from '../../i18n';

export interface WindowSelectorProps {
  value: UsageWindow;
  onChange: (w: UsageWindow) => void;
}

const WINDOWS: UsageWindow[] = ['today', '7d', 'all'];

export function WindowSelector({ value, onChange }: WindowSelectorProps) {
  const { t } = useI18n();

  return (
    <div
      style={{
        display: 'flex',
        background: '#16161D',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.08)',
        padding: 2,
        gap: 2,
      }}
    >
      {WINDOWS.map((w) => (
        <button
          key={w}
          data-testid={`window-${w}`}
          onClick={() => onChange(w)}
          style={{
            padding: '3px 10px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 500,
            fontFamily: 'inherit',
            lineHeight: 1.4,
            transition: 'background 0.15s, color 0.15s',
            background: value === w ? '#7C5CFF' : 'transparent',
            color: value === w ? '#fff' : 'rgba(255,255,255,0.5)',
            whiteSpace: 'nowrap',
          }}
        >
          {t(`metrics.window.${w}`)}
        </button>
      ))}
    </div>
  );
}
