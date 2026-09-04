import { useState } from 'react';
import { getActiveModel } from '../../lib/models';
import { useI18n } from '../../i18n';

interface SettingsPanelProps {
  onClose: () => void;
}

interface SettingItem {
  key: string;
  labelKey: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  value: string | number | boolean;
  options?: string[];
  descriptionKey?: string;
}

// NOTE: this panel's fields are cosmetic only. updateSetting() below writes
// to the `lazy.settings.*` localStorage namespace, which nothing else in the
// app reads back — the live AI/model configuration lives in AccessSettings
// (see src/lib/models/accessSettings.ts) and is edited from SettingsSpace /
// ModelPicker (src/spaces/SettingsSpace.tsx, src/components/settings/ModelPicker.tsx).
// Resolved through getActiveModel() (instead of a hardcoded literal) purely
// so this dead default can never drift back to a stale/inaccessible model id.
const RESOLVED_CHAT_MODEL_ID = getActiveModel().id;

// B22: every label/description below used to be a hardcoded English string
// (an English leak regardless of the active locale) — now real i18n keys
// (code.settingsPanel.*, all 6 locales). `key` (the settings.* storage key)
// stays a plain identifier — it is never rendered as UI copy.
const SETTINGS_SECTIONS: Array<{ titleKey: string; items: SettingItem[] }> = [
  {
    titleKey: 'code.settingsPanel.section.editor',
    items: [
      { key: 'editor.fontSize', labelKey: 'code.settingsPanel.editor.fontSize.label', type: 'number', value: 13, descriptionKey: 'code.settingsPanel.editor.fontSize.description' },
      { key: 'editor.tabSize', labelKey: 'code.settingsPanel.editor.tabSize.label', type: 'number', value: 2, descriptionKey: 'code.settingsPanel.editor.tabSize.description' },
      { key: 'editor.wordWrap', labelKey: 'code.settingsPanel.editor.wordWrap.label', type: 'boolean', value: false, descriptionKey: 'code.settingsPanel.editor.wordWrap.description' },
      { key: 'editor.minimap', labelKey: 'code.settingsPanel.editor.minimap.label', type: 'boolean', value: true, descriptionKey: 'code.settingsPanel.editor.minimap.description' },
      { key: 'editor.formatOnSave', labelKey: 'code.settingsPanel.editor.formatOnSave.label', type: 'boolean', value: false, descriptionKey: 'code.settingsPanel.editor.formatOnSave.description' },
      { key: 'editor.bracketPairColorization', labelKey: 'code.settingsPanel.editor.bracketPairColorization.label', type: 'boolean', value: true },
    ],
  },
  {
    titleKey: 'code.settingsPanel.section.keybindings',
    items: [
      { key: 'kb.goToLine', labelKey: 'code.settingsPanel.kb.goToLine.label', type: 'text', value: 'Ctrl+G' },
      { key: 'kb.find', labelKey: 'code.settingsPanel.kb.find.label', type: 'text', value: 'Ctrl+F' },
      { key: 'kb.inlineEdit', labelKey: 'code.settingsPanel.kb.inlineEdit.label', type: 'text', value: 'Ctrl+K' },
      { key: 'kb.sendToChat', labelKey: 'code.settingsPanel.kb.sendToChat.label', type: 'text', value: 'Ctrl+L' },
      { key: 'kb.symbolPicker', labelKey: 'code.settingsPanel.kb.symbolPicker.label', type: 'text', value: 'Ctrl+Shift+O' },
      { key: 'kb.commandPalette', labelKey: 'code.settingsPanel.kb.commandPalette.label', type: 'text', value: 'Ctrl+Shift+P' },
    ],
  },
  {
    titleKey: 'code.settingsPanel.section.ai',
    items: [
      { key: 'ai.completionModel', labelKey: 'code.settingsPanel.ai.completionModel.label', type: 'text', value: 'claude-haiku-4-5', descriptionKey: 'code.settingsPanel.ai.completionModel.description' },
      { key: 'ai.chatModel', labelKey: 'code.settingsPanel.ai.chatModel.label', type: 'text', value: RESOLVED_CHAT_MODEL_ID, descriptionKey: 'code.settingsPanel.ai.chatModel.description' },
      { key: 'ai.autoFix', labelKey: 'code.settingsPanel.ai.autoFix.label', type: 'boolean', value: true, descriptionKey: 'code.settingsPanel.ai.autoFix.description' },
      { key: 'ai.completionDebounce', labelKey: 'code.settingsPanel.ai.completionDebounce.label', type: 'number', value: 800 },
    ],
  },
  {
    titleKey: 'code.settingsPanel.section.terminal',
    items: [
      { key: 'terminal.fontSize', labelKey: 'code.settingsPanel.terminal.fontSize.label', type: 'number', value: 13 },
      { key: 'terminal.scrollback', labelKey: 'code.settingsPanel.terminal.scrollback.label', type: 'number', value: 2000 },
      { key: 'terminal.aiAssist', labelKey: 'code.settingsPanel.terminal.aiAssist.label', type: 'boolean', value: true },
    ],
  },
];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Record<string, string | number | boolean>>(() => {
    const initial: Record<string, string | number | boolean> = {};
    for (const section of SETTINGS_SECTIONS) {
      for (const item of section.items) {
        initial[item.key] = item.value;
      }
    }
    return initial;
  });

  function updateSetting(key: string, value: string | number | boolean) {
    setSettings(prev => ({ ...prev, [key]: value }));
    try {
      localStorage.setItem(`lazy.settings.${key}`, String(value));
    } catch { /* ignore */ }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: '80%', maxWidth: 700, maxHeight: '80%', background: '#1C1C2A', borderRadius: 12, border: '1px solid rgba(124,92,255,0.2)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: '#E6E8EF' }}>{t('code.settingsPanel.title')}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          {SETTINGS_SECTIONS.map(section => (
            <div key={section.titleKey} style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                {t(section.titleKey)}
              </div>
              {section.items.map(item => (
                <div key={item.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#D5D8E0' }}>{t(item.labelKey)}</div>
                    {item.descriptionKey && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 2 }}>{t(item.descriptionKey)}</div>}
                  </div>
                  {item.type === 'boolean' ? (
                    <button
                      onClick={() => updateSetting(item.key, !settings[item.key])}
                      style={{
                        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
                        background: settings[item.key] ? '#7C5CFF' : 'rgba(255,255,255,0.1)',
                        position: 'relative', transition: 'background 0.2s',
                      }}
                    >
                      <span style={{ position: 'absolute', top: 2, left: settings[item.key] ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                    </button>
                  ) : item.type === 'select' ? (
                    <select
                      value={String(settings[item.key])}
                      onChange={e => updateSetting(item.key, e.target.value)}
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 8px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
                    >
                      {item.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  ) : (
                    <input
                      type={item.type === 'number' ? 'number' : 'text'}
                      value={String(settings[item.key])}
                      onChange={e => updateSetting(item.key, item.type === 'number' ? parseInt(e.target.value) || 0 : e.target.value)}
                      style={{ width: 120, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 8px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
