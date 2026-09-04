/* SolariPanel — Settings panel for configuring the Solari API key.
   Stores the key in the OS vault via vaultClient.setSecret.
   Shows configured status, key input, save/delete buttons.
*/

import { useCallback, useEffect, useState } from 'react';
import { setSecret, deleteSecret, getSecretPresence } from '../../lib/vault/vaultClient';
import { resetSolariClients, emitSolariConfiguredChange } from '../../lib/solari/solariClient';
import { useToastSafe } from '../ui/Toast';

export function SolariPanel() {
  const [configured, setConfigured] = useState(false);
  const [hint, setHint] = useState<string | undefined>();
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToastSafe();

  const checkConfigured = useCallback(async () => {
    try {
      const presence = await getSecretPresence('solari');
      setConfigured(presence.present && (presence.hint ?? '').length > 0);
      setHint(presence.hint);
    } catch {
      setConfigured(false);
    }
  }, []);

  useEffect(() => {
    void checkConfigured();
  }, [checkConfigured]);

  const handleSave = useCallback(async () => {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      await setSecret('solari', keyInput.trim());
      resetSolariClients();
      await emitSolariConfiguredChange();
      await checkConfigured();
      setKeyInput('');
      toast('Solari API key saved', 'success');
    } catch (err) {
      toast(`Failed to save key: ${String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [keyInput, checkConfigured, toast]);

  const handleDelete = useCallback(async () => {
    setSaving(true);
    try {
      await deleteSecret('solari');
      resetSolariClients();
      await emitSolariConfiguredChange();
      await checkConfigured();
      toast('Solari API key removed', 'success');
    } catch (err) {
      toast(`Failed to remove key: ${String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [checkConfigured, toast]);

  return (
    <div style={S.panel}>
      <h2 style={S.title}>Solari Cloud</h2>
      <p style={S.description}>
        Solari provides cloud browsers, desktop VMs, and code sandboxes for your LazyBots.
        Configure your API key to enable cloud capabilities.
      </p>

      <div style={S.statusRow}>
        <span style={{
          ...S.statusBadge,
          ...(configured ? S.statusConfigured : S.statusNotConfigured),
        }}>
          {configured ? 'Configured' : 'Not configured'}
        </span>
        {configured && hint && (
          <span style={S.hint}>Key: {hint}</span>
        )}
      </div>

      <div style={S.section}>
        <label style={S.label}>API Key</label>
        <input
          type="password"
          style={S.input}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={configured ? 'Enter a new key to replace the existing one' : 'slr_live_...'}
          disabled={saving}
        />
      </div>

      <div style={S.actions}>
        <button
          onClick={handleSave}
          disabled={!keyInput.trim() || saving}
          style={{ ...S.btn, ...S.btnPrimary }}
        >
          {saving ? 'Saving...' : 'Save Key'}
        </button>
        {configured && (
          <button
            onClick={handleDelete}
            disabled={saving}
            style={{ ...S.btn, ...S.btnDanger }}
          >
            Remove Key
          </button>
        )}
      </div>

      <div style={S.help}>
        <p>Get your API key from the <a href="https://console.getsolari.com" target="_blank" rel="noopener noreferrer" style={S.link}>Solari Console</a>.</p>
        <p>The key is stored securely in your OS credential store and never leaves your machine.</p>
      </div>
    </div>
  );
}

const S = {
  panel: { maxWidth: 600, display: 'flex', flexDirection: 'column' as const, gap: 16 },
  title: { fontSize: 18, fontWeight: 700, color: 'var(--color-text)', margin: 0 },
  description: { fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.5, margin: 0 },
  statusRow: { display: 'flex', alignItems: 'center', gap: 12 },
  statusBadge: { fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6 },
  statusConfigured: { background: 'rgba(102,226,122,0.15)', color: '#66E27A' },
  statusNotConfigured: { background: 'rgba(255,107,107,0.15)', color: '#FF6B6B' },
  hint: { fontSize: 12, color: 'var(--color-text-secondary)', fontFamily: 'monospace' },
  section: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  label: { fontSize: 13, fontWeight: 500, color: 'var(--color-text-secondary)' },
  input: {
    background: 'var(--color-input-bg)', border: '1px solid var(--color-border)',
    borderRadius: 8, padding: '10px 12px', color: 'var(--color-text)', fontSize: 14,
    outline: 'none', width: '100%', boxSizing: 'border-box' as const,
  },
  actions: { display: 'flex', gap: 10 },
  btn: {
    padding: '10px 16px', borderRadius: 8, cursor: 'pointer',
    fontSize: 14, fontWeight: 500, border: '1px solid transparent',
  },
  btnPrimary: {
    background: 'rgba(124,92,255,0.2)', border: '1px solid rgba(124,92,255,0.5)',
    color: '#B8A9FF',
  },
  btnDanger: {
    background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)',
    color: '#FF6B6B',
  },
  help: { marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 },
  link: { color: '#B8A9FF', textDecoration: 'none' },
};
