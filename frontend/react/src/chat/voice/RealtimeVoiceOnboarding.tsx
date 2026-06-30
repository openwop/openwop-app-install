/**
 * First-run real-time voice onboarding (ADR 0141) — shown the first time a person reaches for
 * voice when no real-time provider is configured yet. Explains the BYOK + provider setup and
 * routes them to the Keys page, or lets them use the recorded-voice fallback for now.
 *
 * Shown once per browser (a localStorage flag); after that the Voice button uses the walkie-
 * talkie fallback directly.
 */
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../../ui/Modal.js';
import { MicIcon } from '../../ui/icons/index.js';
import { getProvider, type ProviderId } from '../../byok/lib/providers.js';

const SEEN_KEY = 'owp.voiceRt.onboardingSeen';

/** A "Get a key" link to the provider's API-key console — reuses the BYOK providers catalog
 *  (the same source the Keys page uses), so the URL can't drift. */
function ProviderKeyLink({ id, label }: { id: ProviderId; label: string }): JSX.Element {
  const url = getProvider(id).apiKeyConsoleUrl;
  if (!url) return <></>;
  return <> · <a className="inline-link" href={url} target="_blank" rel="noopener noreferrer">{label}</a></>;
}

export function realtimeOnboardingSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}
export function markRealtimeOnboardingSeen(): void {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode — just re-show */ }
}

export function RealtimeVoiceOnboarding({ onClose, onUseRecorded }: { onClose: () => void; onUseRecorded: () => void }): JSX.Element {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  return (
    <Modal label={t('voiceRtOnbTitle')} onClose={onClose} showClose>
      <h2 className="u-mt-0 u-flex u-items-center u-gap-2"><MicIcon size={18} aria-hidden /> {t('voiceRtOnbTitle')}</h2>
      <p className="u-fs-14">{t('voiceRtOnbBody')}</p>

      <h3 className="u-fs-14 u-fw-600 u-mb-1">{t('voiceRtOnbProviders')}</h3>
      <ul className="u-fs-13 u-flex u-flex-col u-gap-1 u-mt-0">
        <li>{t('voiceRtOnbOpenai')}<ProviderKeyLink id="openai" label={t('voiceRtOnbGetKey')} /></li>
        <li>{t('voiceRtOnbGemini')}<ProviderKeyLink id="google" label={t('voiceRtOnbGetKey')} /></li>
      </ul>

      <h3 className="u-fs-14 u-fw-600 u-mb-1">{t('voiceRtOnbHow')}</h3>
      <ol className="u-fs-13 u-flex u-flex-col u-gap-1 u-mt-0">
        <li>{t('voiceRtOnbStep1')}</li>
        <li>{t('voiceRtOnbStep2')}</li>
      </ol>

      <div className="action-bar u-justify-end u-mt-3">
        <button type="button" className="secondary btn-sm" onClick={() => { onClose(); onUseRecorded(); }}>
          {t('voiceRtOnbLater')}
        </button>
        <button type="button" className="btn-primary btn-sm" onClick={() => { onClose(); navigate('/keys'); }}>
          {t('voiceRtOnbSetup')}
        </button>
      </div>
    </Modal>
  );
}
