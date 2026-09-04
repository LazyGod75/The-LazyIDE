import { useState } from 'react';
import { useI18n } from '../../i18n';

interface WebPreviewProps {
  url: string;
  onClose: () => void;
}

export function WebPreview({ url, onClose }: WebPreviewProps) {
  const { t } = useI18n();
  const [currentUrl, setCurrentUrl] = useState(url);
  const [inputUrl, setInputUrl] = useState(url);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#1C1C2A', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <button onClick={() => setCurrentUrl(url)} style={{ background: 'rgba(255,255,255,0.05)', border: 'none', borderRadius: 4, color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 14, padding: '4px 8px' }} aria-label={t('common.refresh')}>↻</button>
        <input
          value={inputUrl}
          onChange={e => setInputUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') setCurrentUrl(inputUrl); }}
          style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '5px 10px', color: '#D5D8E0', fontSize: 12, fontFamily: 'inherit', outline: 'none' }}
        />
        <button onClick={() => setCurrentUrl(inputUrl)} style={{ background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 4, padding: '4px 10px', color: '#A78BFF', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>{t('webPreview.goButton')}</button>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 18 }}>×</button>
      </div>
      <iframe
        src={currentUrl}
        style={{ flex: 1, border: 'none', background: '#fff' }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        title={t('webPreview.title')}
      />
    </div>
  );
}
