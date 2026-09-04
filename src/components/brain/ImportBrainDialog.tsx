/* ImportBrainDialog — clone a published brain repo and make it active. */

import { useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { getPlatform } from '../../lib/platform';
import type { Brain } from '../../lib/platform/types';
import { type BrainWithSetup } from '../../lib/brain/brainWithSetup';
import {
  BrainDialogShell,
  DialogActions,
  GhostButton,
  PrimaryButton,
} from './BrainDialogShell';
import { BRAIN_TEXT_INPUT } from './brainDialogFields';
import { BrainField } from './BrainField';

export function ImportBrainDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const { t } = useI18n();
  const platform = getPlatform();
  const [url, setUrl] = useState('');
  const [dest, setDest] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const ready = confirmed && url.trim().length > 0 && dest.trim().length > 0;
  const blocked = importing || !ready;

  return (
    <BrainDialogShell titleId={titleId} panelRef={panelRef} onClose={onClose}>
      <div id={titleId} style={{ fontSize: 14, fontWeight: 700, color: '#E8E3FF' }}>
        {t('settings.memory.import.title')}
      </div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 }}>
        {t('settings.memory.import.description')}
      </div>
      <BrainField label={t('settings.memory.githubUrlLabel')}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('settings.memory.import.urlPlaceholder')}
          style={BRAIN_TEXT_INPUT}
        />
      </BrainField>
      <DestField dest={dest} onDest={setDest} onBrowse={() => void browseDest(platform.name, setDest)} />
      <ConfirmRow checked={confirmed} onChange={setConfirmed} />
      {result && <ImportResultBanner result={result} />}
      <DialogActions>
        <GhostButton onClick={onClose}>{t('common.cancel')}</GhostButton>
        <PrimaryButton
          disabled={blocked}
          onClick={() => void runImport(platform.brain, url, dest, t, onImported, setImporting, setResult)}
        >
          {importing
            ? t('settings.memory.import.importingButton')
            : t('settings.memory.import.importButton')}
        </PrimaryButton>
      </DialogActions>
    </BrainDialogShell>
  );
}

async function browseDest(platformName: string, setDest: (v: string) => void): Promise<void> {
  if (platformName !== 'tauri') return;
  const { openFolder } = await import('../../lib/platform/tauri');
  const picked = await openFolder();
  if (picked) setDest(picked);
}

async function runImport(
  brain: Brain,
  url: string,
  dest: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  onImported: () => void,
  setImporting: (v: boolean) => void,
  setResult: (v: { ok: boolean; message: string } | null) => void,
): Promise<void> {
  setImporting(true);
  setResult(null);
  try {
    const updated = await (brain as BrainWithSetup).importFromGithub({
      url: url.trim(),
      dest: dest.trim(),
    });
    setResult({ ok: true, message: t('settings.memory.import.successMessage', { path: updated.path }) });
    onImported();
  } catch (err: unknown) {
    setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
  } finally {
    setImporting(false);
  }
}

function DestField({
  dest,
  onDest,
  onBrowse,
}: {
  dest: string;
  onDest: (v: string) => void;
  onBrowse: () => void;
}) {
  const { t } = useI18n();
  return (
    <BrainField label={t('settings.memory.import.destLabel')}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={dest}
          onChange={(e) => onDest(e.target.value)}
          placeholder={t('settings.memory.import.destPlaceholder')}
          style={{ ...BRAIN_TEXT_INPUT, flex: 1 }}
        />
        <button
          onClick={onBrowse}
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            fontSize: 11,
            fontWeight: 500,
            cursor: 'pointer',
            border: '1px solid rgba(255,255,255,0.1)',
            background: 'rgba(255,255,255,0.05)',
            color: 'rgba(255,255,255,0.6)',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {t('settings.memory.chooseFolderButton')}
        </button>
      </div>
    </BrainField>
  );
}

function ConfirmRow({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const { t } = useI18n();
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>{t('settings.memory.import.confirmLabel')}</span>
    </label>
  );
}

function ImportResultBanner({ result }: { result: { ok: boolean; message: string } }) {
  return (
    <div
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        padding: '8px 10px',
        borderRadius: 6,
        background: result.ok ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
        border: `1px solid ${result.ok ? '#4ADE80' : '#F87171'}44`,
        color: result.ok ? '#4ADE80' : '#F87171',
      }}
    >
      {result.message}
    </div>
  );
}
