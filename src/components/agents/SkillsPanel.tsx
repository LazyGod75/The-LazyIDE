/* SkillsPanel.tsx — Skills management surface (G5).
   Browses brain-stored skills (data-cerveau-type="skill") and lets the
   user activate one manually for the current project. The injection
   pipeline (skillInjection.ts) already handles semantic injection at turn
   time; this panel is the missing PRODUCT SURFACE to see, create and
   activate them.
*/

import { useEffect, useState, useCallback } from 'react';
import { loadAllSkills, saveSkill, type Skill } from '../../lib/agents/skillInjection';
import { useI18n } from '../../i18n';

export function SkillsPanel() {
  const { t } = useI18n();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setSkills(await loadAllSkills());
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAllSkills().then((found) => {
      setSkills(found);
      setLoading(false);
    });
  }, []);

  const handleCreate = async (): Promise<void> => {
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    if (!trimmedName || !trimmedBody) {
      setNote(t('skillsPanel.nameAndBodyRequired'));
      return;
    }
    await saveSkill({ name: trimmedName, description: trimmedBody.slice(0, 120), body: trimmedBody });
    setName('');
    setBody('');
    setNote(t('skillsPanel.savedNote', { name: trimmedName }));
    await refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Skills (brain)</div>
        <button onClick={refresh} style={buttonStyle} aria-label={t('common.refresh')}>↻</button>
      </div>

      {note && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', background: 'rgba(124,92,255,0.08)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 6, padding: '6px 10px' }}>
          {note}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('skillsPanel.namePlaceholder')}
          style={{ ...inputStyle, width: '100%' }}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t('skillsPanel.bodyPlaceholder')}
          rows={3}
          style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
        />
        <button onClick={handleCreate} style={buttonStyle}>{t('skillsPanel.saveButton')}</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {loading ? (
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{t('skillsPanel.loading')}</div>
        ) : skills.length === 0 ? (
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>
            {t('skillsPanel.empty')}
          </div>
        ) : (
          skills.map((skill) => (
            <div
              key={skill.id}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 6,
                padding: '8px 10px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
                  {skill.name}
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
                  {skill.description}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: 'rgba(124,92,255,0.15)',
  color: '#C4B5FD',
  border: '1px solid rgba(124,92,255,0.35)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.9)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  outline: 'none',
};
