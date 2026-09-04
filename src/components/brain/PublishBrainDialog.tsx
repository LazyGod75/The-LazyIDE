/* PublishBrainDialog — confirm + publish the active brain to GitHub. */

import { useId, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { getPlatform } from '../../lib/platform';
import type { Brain } from '../../lib/platform/types';
import type { BrainInfo, BrainPublishOptions, BrainPublishResult } from '../../lib/platform/tauri';
import {
  BrainDialogShell,
  DialogActions,
  GhostButton,
  PrimaryButton,
} from './BrainDialogShell';
import { BRAIN_TEXT_INPUT, BRAIN_FIELD_LABEL } from './brainDialogFields';

export function PublishBrainDialog({
  brainInfo,
  onClose,
}: {
  brainInfo: BrainInfo | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const platform = getPlatform();
  const [remoteUrl, setRemoteUrl] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<BrainPublishResult | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const isPersonalBrain = brainInfo?.source === 'env_override';
  const blocked = publishing || !confirmed;

  return (
    <BrainDialogShell titleId={titleId} panelRef={panelRef} onClose={onClose}>
      <div id={titleId} style={{ fontSize: 14, fontWeight: 700, color: '#E8E3FF' }}>
        {t('settings.memory.publish.title')}
      </div>
      <BrainPathLine path={brainInfo?.path} />
      {isPersonalBrain && <PersonalBrainWarning />}
      <PublishConfirm checked={confirmed} personal={isPersonalBrain} onChange={setConfirmed} />
      <GithubUrlField value={remoteUrl} onChange={setRemoteUrl} />
      {result && <PublishResultBanner result={result} />}
      <DialogActions>
        <GhostButton onClick={onClose}>{t('common.cancel')}</GhostButton>
        <PrimaryButton
          disabled={blocked}
          onClick={() => void runPublish(platform.brain, remoteUrl, setPublishing, setResult)}
        >
          {publishing
            ? t('settings.memory.publish.publishingButton')
            : t('settings.memory.publish.publishButton')}
        </PrimaryButton>
      </DialogActions>
    </BrainDialogShell>
  );
}

async function runPublish(
  brain: Brain,
  remoteUrl: string,
  setPublishing: (v: boolean) => void,
  setResult: (v: BrainPublishResult | null) => void,
): Promise<void> {
  setPublishing(true);
  setResult(null);
  try {
    const widened = brain as Brain & {
      publishGithub(opts?: BrainPublishOptions): Promise<BrainPublishResult>;
    };
    setResult(await widened.publishGithub({ remoteUrl: remoteUrl.trim() || undefined }));
  } catch (err: unknown) {
    setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
  } finally {
    setPublishing(false);
  }
}

function BrainPathLine({ path }: { path: string | undefined }) {
  const { t } = useI18n();
  return (
    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
      {t('settings.memory.publish.brainToPublishLabel')}{' '}
      <span style={{ fontFamily: 'var(--font-mono, monospace)', color: '#E8E3FF', wordBreak: 'break-all' }}>
        {path ?? '…'}
      </span>
    </div>
  );
}

function PersonalBrainWarning() {
  const { t } = useI18n();
  return (
    <div
      style={{
        padding: '8px 10px',
        background: 'rgba(255,199,107,0.08)',
        border: '1px solid rgba(255,199,107,0.3)',
        borderRadius: 6,
        fontSize: 11,
        color: '#FFC76B',
        lineHeight: 1.5,
      }}
    >
      {t('settings.memory.publish.personalBrainWarning')}
    </div>
  );
}

function PublishConfirm({
  checked,
  personal,
  onChange,
}: {
  checked: boolean;
  personal: boolean;
  onChange: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const suffix = personal ? t('settings.memory.publish.confirmPersonalSuffix') : '';
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 2 }} />
      <span>
        {t('settings.memory.publish.confirmLabel')}
        {suffix}
      </span>
    </label>
  );
}

function GithubUrlField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={BRAIN_FIELD_LABEL}>{t('settings.memory.githubUrlLabel')}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('settings.memory.publish.urlPlaceholder')}
        style={BRAIN_TEXT_INPUT}
      />
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}>
        {t('settings.memory.publish.cliHint')}
      </span>
    </div>
  );
}

function PublishResultBanner({ result }: { result: BrainPublishResult }) {
  const { t } = useI18n();
  const ok = result.ok;
  return (
    <div
      style={{
        fontSize: 11,
        lineHeight: 1.5,
        padding: '8px 10px',
        borderRadius: 6,
        background: ok ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
        border: `1px solid ${ok ? '#4ADE80' : '#F87171'}44`,
        color: ok ? '#4ADE80' : '#F87171',
      }}
    >
      {ok && result.url ? (
        <>
          {t('settings.memory.publish.successPrefix')}{' '}
          <a href={result.url} target="_blank" rel="noreferrer" style={{ color: '#4ADE80' }}>
            {result.url}
          </a>
        </>
      ) : (
        result.message
      )}
    </div>
  );
}
