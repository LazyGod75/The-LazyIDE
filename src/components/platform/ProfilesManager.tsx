import { useState } from 'react';

interface ProfilesManagerProps {
  onClose: () => void;
}

interface Profile {
  id: string;
  name: string;
  icon: string;
  settings: Record<string, string>;
}

export function ProfilesManager({ onClose }: ProfilesManagerProps) {
  const [profiles, setProfiles] = useState<Profile[]>([
    { id: 'default', name: 'Default', icon: '🟣', settings: {} },
    { id: 'work', name: 'Work', icon: '🔵', settings: {} },
    { id: 'personal', name: 'Personal', icon: '🟢', settings: {} },
  ]);
  const [active, setActive] = useState('default');

  function addProfile() {
    const name = window.prompt('Profile name:');
    if (!name) return;
    const id = `profile-${Date.now()}`;
    setProfiles(prev => [...prev, { id, name, icon: '⚪', settings: {} }]);
  }

  function deleteProfile(id: string) {
    if (id === 'default') return;
    setProfiles(prev => prev.filter(p => p.id !== id));
    if (active === id) setActive('default');
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: 400, background: '#1C1C2A', borderRadius: 12, border: '1px solid rgba(124,92,255,0.2)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#E6E8EF' }}>Profiles</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
        <div style={{ padding: 12 }}>
          {profiles.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, background: active === p.id ? 'rgba(124,92,255,0.08)' : 'transparent', marginBottom: 4, cursor: 'pointer' }} onClick={() => setActive(p.id)}>
              <span style={{ fontSize: 16 }}>{p.icon}</span>
              <span style={{ flex: 1, fontSize: 12, color: active === p.id ? '#A78BFF' : 'rgba(255,255,255,0.5)' }}>{p.name}</span>
              {active === p.id && <span style={{ fontSize: 10, color: '#66E27A' }}>● Active</span>}
              {p.id !== 'default' && <button onClick={e => { e.stopPropagation(); deleteProfile(p.id); }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.2)', cursor: 'pointer', fontSize: 14 }}>×</button>}
            </div>
          ))}
          <button onClick={addProfile} style={{ marginTop: 8, width: '100%', background: 'rgba(124,92,255,0.1)', border: '1px solid rgba(124,92,255,0.15)', borderRadius: 6, padding: '6px', color: '#A78BFF', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>
            + New Profile
          </button>
        </div>
      </div>
    </div>
  );
}
