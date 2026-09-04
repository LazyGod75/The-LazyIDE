import { useState } from 'react';
import { ComingSoon } from './ComingSoon';

interface ExtensionPanelProps {
  onClose: () => void;
}

interface Extension {
  id: string;
  name: string;
  publisher: string;
  description: string;
  installed: boolean;
  version: string;
}

const SAMPLE_EXTENSIONS: Extension[] = [
  { id: 'prettier', name: 'Prettier', publisher: 'Prettier', description: 'Code formatter using prettier', installed: false, version: '3.0.0' },
  { id: 'eslint', name: 'ESLint', publisher: 'Microsoft', description: 'Integrates ESLint into Lazy', installed: true, version: '2.4.0' },
  { id: 'gitlens', name: 'GitLens', publisher: 'GitKraken', description: 'Supercharge Git within Lazy', installed: false, version: '14.0.0' },
  { id: 'tailwind', name: 'Tailwind CSS', publisher: 'Tailwind Labs', description: 'Intelligent Tailwind CSS tooling', installed: false, version: '0.12.0' },
  { id: 'docker', name: 'Docker', publisher: 'Microsoft', description: 'Build and manage Docker containers', installed: false, version: '1.29.0' },
  { id: 'python', name: 'Python', publisher: 'Microsoft', description: 'Python language support', installed: true, version: '1.20.0' },
  { id: 'rust-analyzer', name: 'rust-analyzer', publisher: 'The Rust Project', description: 'Rust language support', installed: true, version: '0.4.0' },
];

export function ExtensionPanel({ onClose }: ExtensionPanelProps) {
  const [extensions, setExtensions] = useState(SAMPLE_EXTENSIONS);
  const [search, setSearch] = useState('');

  function toggleInstall(id: string) {
    setExtensions(prev => prev.map(ext => ext.id === id ? { ...ext, installed: !ext.installed } : ext));
  }

  const filtered = extensions.filter(ext =>
    !search || ext.name.toLowerCase().includes(search.toLowerCase()) || ext.description.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', background: '#0E0E12' }}>
      <ComingSoon label="Extensions" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search extensions..."
          style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '5px 10px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
        />
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 14 }}>×</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.map(ext => (
          <div key={ext.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ width: 32, height: 32, borderRadius: 6, background: 'rgba(124,92,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>
              🧩
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: '#D5D8E0', fontWeight: 500 }}>
                {ext.name}
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginLeft: 6 }}>v{ext.version}</span>
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ext.description}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 1 }}>
                {ext.publisher}
              </div>
            </div>
            <button
              onClick={() => toggleInstall(ext.id)}
              style={{
                background: ext.installed ? 'rgba(255,255,255,0.05)' : 'rgba(124,92,255,0.15)',
                border: ext.installed ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(124,92,255,0.2)',
                borderRadius: 4,
                padding: '4px 12px',
                color: ext.installed ? 'rgba(255,255,255,0.4)' : '#A78BFF',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'inherit',
                flexShrink: 0,
              }}
            >
              {ext.installed ? 'Uninstall' : 'Install'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
