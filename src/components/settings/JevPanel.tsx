/* JevPanel — Settings panel for the TypeSafe Jev capability.

   Two distinct controls, matching jevMode.ts's two gates:
     - the API key (access)   → OS vault via saveJevKey/deleteJevKey
     - the Jev mode toggle    → lazy.jev.enabled pref (consent)

   Everything here is additive and optional: with no key, the IDE behaves
   exactly as if Jev did not exist. The panel says so plainly — it is a
   settings surface, not a paywall.
*/

import { useCallback, useEffect, useState } from 'react';
import {
  isJevConfigured,
  isJevModeEnabled,
  saveJevKey,
  deleteJevKey,
  setJevModeEnabled,
} from '../../lib/jev/jevMode';
import { on } from '../../lib/bus';
import { useI18n } from '../../i18n';
import { useToastSafe } from '../ui/Toast';

const FEATURE_KEYS = [
  'settings.jev.feature.askJev',
  'settings.jev.feature.wakeup',
  'settings.jev.feature.lazybot',
  'settings.jev.feature.review',
  'settings.jev.feature.recall',
] as const;

export function JevPanel() {
  const { t } = useI18n();
  const [configured, setConfigured] = useState(isJevConfigured());
  const [modeOn, setModeOn] = useState(isJevModeEnabled());
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const toast = useToastSafe();

  // Re-read live state on every jev:stateChange (another surface — the
  // header chip — may toggle the mode while this panel is open).
  useEffect(() => on('jev:stateChange', (p) => {
    setConfigured(p.configured);
    setModeOn(p.enabled);
  }), []);

  const handleSave = useCallback(() => {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      saveJevKey(keyInput);
      setConfigured(true);
      setKeyInput('');
      toast(t('settings.jev.keySaved'), 'success');
    } catch (err) {
      toast(`${t('settings.jev.saveFailed')}: ${String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [keyInput, toast, t]);

  const handleDelete = useCallback(() => {
    setSaving(true);
    try {
      deleteJevKey();
      setConfigured(false);
      toast(t('settings.jev.keyRemoved'), 'success');
    } catch (err) {
      toast(`${t('settings.jev.removeFailed')}: ${String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [toast, t]);

  const handleToggle = useCallback(() => {
    const next = !modeOn;
    setJevModeEnabled(next);
    setModeOn(next);
  }, [modeOn]);

  // Live connectivity check — one minimal noul through the REAL pipeline
  // (vault key → jev_ask Rust command → api.typesafe.ai). Proves the key
  // works before the user relies on it; reports model + round-trip latency.
  const handleTest = useCallback(async () => {
    setTesting(true);
    try {
      const { jevAsk } = await import('../../lib/jev/jevClient');
      const t0 = Date.now();
      const res = await jevAsk(
        { check: 'settings connection test' },
        { ping: { type: 'noul', instructions: 'Is this a connectivity check?' } },
        { timeoutMs: 5_000 },
      );
      toast(t('settings.jev.testOk', { model: res.model, ms: Date.now() - t0 }), 'success');
    } catch (err) {
      toast(`${t('settings.jev.testFailed')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setTesting(false);
    }
  }, [toast, t]);

  return (
    <div style={S.panel}>
      <h2 style={S.title}>{t('settings.jev.title')}</h2>
      <p style={S.description}>{t('settings.jev.description')}</p>

      <div style={S.statusRow}>
        <span style={{
          ...S.statusBadge,
          ...(configured ? S.statusConfigured : S.statusNotConfigured),
        }}>
          {configured ? t('settings.jev.configured') : t('settings.jev.notConfigured')}
        </span>
        {configured && (
          <span style={{
            ...S.statusBadge,
            ...(modeOn ? S.statusConfigured : S.statusPaused),
          }}>
            {modeOn ? t('settings.jev.modeOn') : t('settings.jev.modeOff')}
          </span>
        )}
      </div>

      <div style={S.section}>
        <label style={S.label}>{t('settings.jev.keyLabel')}</label>
        <input
          type="password"
          style={S.input}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={configured ? t('settings.jev.keyPlaceholderReplace') : 'apikey_...'}
          disabled={saving}
          data-testid="jev-key-input"
        />
      </div>

      <div style={S.actions}>
        <button
          onClick={handleSave}
          disabled={!keyInput.trim() || saving}
          style={{ ...S.btn, ...S.btnPrimary }}
          data-testid="jev-save-key"
        >
          {saving ? t('settings.jev.saving') : t('settings.jev.saveKey')}
        </button>
        {configured && (
          <button
            onClick={handleTest}
            disabled={testing || !modeOn}
            style={{ ...S.btn, ...S.btnSecondary }}
            data-testid="jev-test-connection"
            title={!modeOn ? t('settings.jev.modeOff') : undefined}
          >
            {testing ? t('settings.jev.testing') : t('settings.jev.testKey')}
          </button>
        )}
        {configured && (
          <button
            onClick={handleDelete}
            disabled={saving}
            style={{ ...S.btn, ...S.btnDanger }}
            data-testid="jev-remove-key"
          >
            {t('settings.jev.removeKey')}
          </button>
        )}
      </div>

      {configured && (
        <div style={S.modeRow}>
          <button
            type="button"
            role="switch"
            aria-checked={modeOn}
            onClick={handleToggle}
            style={{ ...S.toggle, ...(modeOn ? S.toggleOn : S.toggleOff) }}
            data-testid="jev-mode-toggle"
          >
            <span style={{ ...S.toggleKnob, ...(modeOn ? S.toggleKnobOn : {}) }} />
          </button>
          <div>
            <div style={S.modeLabel}>{t('settings.jev.modeLabel')}</div>
            <div style={S.modeHint}>{t('settings.jev.modeHint')}</div>
          </div>
        </div>
      )}

      <div style={S.features}>
        <div style={S.featuresTitle}>{t('settings.jev.featuresTitle')}</div>
        <ul style={S.featureList}>
          {FEATURE_KEYS.map((k) => (
            <li key={k} style={S.featureItem}>{t(k)}</li>
          ))}
        </ul>
      </div>

      <div style={S.help}>
        <p>{t('settings.jev.pricingNote')}</p>
        <p>
          {t('settings.jev.keySource')}{' '}
          <a href="https://docs.typesafe.ai" target="_blank" rel="noopener noreferrer" style={S.link}>
            docs.typesafe.ai
          </a>
        </p>
        <p>{t('settings.jev.privacyNote')}</p>
      </div>
    </div>
  );
}

const S = {
  panel: { maxWidth: 640, display: 'flex', flexDirection: 'column' as const, gap: 16 },
  title: { fontSize: 18, fontWeight: 700, color: 'var(--color-text)', margin: 0 },
  description: { fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.5, margin: 0 },
  statusRow: { display: 'flex', alignItems: 'center', gap: 12 },
  statusBadge: { fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6 },
  statusConfigured: { background: 'rgba(102,226,122,0.15)', color: '#66E27A' },
  statusNotConfigured: { background: 'rgba(160,160,170,0.15)', color: 'var(--color-text-muted)' },
  statusPaused: { background: 'rgba(251,185,36,0.14)', color: 'var(--color-warning-text)' },
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
  btnSecondary: {
    background: 'var(--color-panel-3)', border: '1px solid var(--color-border-2)',
    color: 'var(--color-text-secondary)',
  },
  btnDanger: {
    background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)',
    color: '#FF6B6B',
  },
  modeRow: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
    borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-panel)',
  },
  toggle: {
    width: 38, height: 22, borderRadius: 11, border: '1px solid var(--color-border-2)',
    cursor: 'pointer', position: 'relative' as const, flexShrink: 0, padding: 0,
  },
  toggleOn: { background: 'rgba(124,92,255,0.45)' },
  toggleOff: { background: 'var(--color-panel-3)' },
  toggleKnob: {
    position: 'absolute' as const, top: 2, left: 2, width: 16, height: 16,
    borderRadius: 8, background: 'var(--color-text)', transition: 'left 0.15s',
  },
  toggleKnobOn: { left: 18 },
  modeLabel: { fontSize: 13, fontWeight: 600, color: 'var(--color-text)' },
  modeHint: { fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 },
  features: {
    padding: '12px 14px', borderRadius: 10,
    border: '1px solid var(--color-border)', background: 'var(--color-panel)',
  },
  featuresTitle: { fontSize: 13, fontWeight: 600, color: 'var(--color-text)', marginBottom: 8 },
  featureList: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column' as const, gap: 6 },
  featureItem: { fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.45 },
  help: { marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.5 },
  link: { color: '#B8A9FF', textDecoration: 'none' },
};
