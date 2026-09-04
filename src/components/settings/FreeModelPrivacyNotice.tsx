/* FreeModelPrivacyNotice — persistent, unmissable warning shown whenever the
   currently selected managed model is a free OpenRouter model.

   Why this exists: free models let the upstream provider collect and train
   on submitted data (OpenRouter's documented behavior for ":free" routes).
   That must be visible to the user BEFORE they send code to a free model,
   not buried in a settings sub-page they may never revisit. This component
   is rendered directly inside the model picker (see ModelPicker.tsx), right
   at the point of selection, and stays visible for as long as a free model
   stays selected — not a one-time dismissible toast — because the risk
   (sensitive code leaving the machine) recurs on every message, not once.

   Kept free of any import from src/lib/models/** logic: the caller passes
   the already-resolved `isFree` boolean (from OpenRouterModel.isFree), so
   this component only renders — it never re-derives the free/paid decision.
*/

import { useI18n } from '../../i18n';

export interface FreeModelPrivacyNoticeProps {
  /** True when the currently selected model is a free (zero-cost) model. */
  isFree: boolean;
}

function WarningIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path
        d="M8 2 1.5 13.5h13Z"
        stroke="#FB923C"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8 6.4v3.2" stroke="#FB923C" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r="0.9" fill="#FB923C" />
    </svg>
  );
}

export function FreeModelPrivacyNotice({ isFree }: FreeModelPrivacyNoticeProps) {
  const { t } = useI18n();

  if (!isFree) return null;

  return (
    <div
      data-testid="free-model-privacy-notice"
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 6,
        padding: '8px 10px',
        borderRadius: 7,
        background: 'rgba(251,146,60,0.10)',
        border: '1px solid rgba(251,146,60,0.35)',
      }}
    >
      <WarningIcon />
      <span style={{ flex: 1, fontSize: 11, lineHeight: 1.45, color: '#FB923C' }}>
        {t('settings.pro.freeModelNotice')}
      </span>
    </div>
  );
}
