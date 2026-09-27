/**
 * Real-time voice provider settings (ADR 0141 RT-3) — tenant-wide admin config: pick the
 * speech-to-speech provider (OpenAI Realtime / Gemini Live) + the BYOK key it uses, or `off`
 * for the recorded-voice fallback. Lives on the Keys page (the BYOK key it references is set
 * there). The key value never leaves the host; this stores only the credentialRef.
 */
import { Button } from '../ui/Button.js';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getRealtimeConfig, setRealtimeConfig, type RealtimeProviderId } from '../chat/voice/voiceClient.js';
import { Notice } from '../ui/Notice.js';
import { SelectField } from '../ui/Field.js';

const PROVIDERS: Array<{ id: RealtimeProviderId | 'off'; brand?: string }> = [
  { id: 'off' },
  { id: 'openai-realtime', brand: 'OpenAI Realtime' },
  { id: 'gemini-live', brand: 'Gemini Live' },
];

export function RealtimeVoiceSettings({ storedRefs, refsUnreadable = false }: {
  storedRefs: readonly string[];
  /**
   * The key list could not be READ. Without this the empty array is
   * indistinguishable from "this tenant stores no keys", and the ADR 0499
   * missing-binding alarm below fires on a perfectly healthy configuration —
   * telling the operator their key was deleted and voice is about to fail.
   */
  refsUnreadable?: boolean;
}): JSX.Element {
  const { t } = useTranslation('byok');
  const [provider, setProvider] = useState<RealtimeProviderId | 'off'>('off');
  const [credentialRef, setCredentialRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void getRealtimeConfig().then((c) => { if (!live) return; setProvider(c.provider); setCredentialRef(c.credentialRef ?? ''); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true); setError(null); setSaved(false);
    try {
      const needsKey = provider !== 'off';
      await setRealtimeConfig({ provider, ...(needsKey && credentialRef ? { credentialRef } : {}) });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  const needsKey = provider !== 'off';
  // ADR 0499 — a configured ref whose secret has since been deleted matches no
  // <option>, so the select silently rendered BLANK and the card read "not
  // configured yet" rather than "pointing at a key that is gone". That is how a
  // dead realtime-voice binding stayed invisible here for a month while every
  // session-mint 400'd. Keep the broken value on screen, and name it.
  // …but only when we actually read the list. An unreadable list proves nothing
  // about whether the configured ref still exists.
  const refIsMissing = !refsUnreadable && needsKey && credentialRef !== '' && !storedRefs.includes(credentialRef);
  return (
    <section className="surface-card u-flex u-flex-col u-gap-3" aria-labelledby="rt-voice-h">
      <h2 id="rt-voice-h" className="u-fs-16 u-fw-600 u-m-0">{t('rtTitle')}</h2>
      <p className="muted u-fs-13 u-m-0">{t('rtDesc')}</p>
      {error ? <Notice variant="error">{error}</Notice> : null}
      {saved ? <Notice variant="success" announce={t('rtSaved')}>{t('rtSaved')}</Notice> : null}
      <div className="u-flex u-gap-3 u-flex-wrap u-items-end">
        <SelectField label={t('rtProvider')} value={provider} onChange={(e) => setProvider(e.target.value as RealtimeProviderId | 'off')} className="u-flex-1">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.brand ?? t('rtProviderOff')}</option>)}
        </SelectField>
        {needsKey ? (
          <SelectField label={t('rtKey')} value={credentialRef} onChange={(e) => setCredentialRef(e.target.value)} className="u-flex-1">
            <option value="">{t('rtKeySelect')}</option>
            {refIsMissing ? <option value={credentialRef}>{t('rtKeyMissing', { ref: credentialRef })}</option> : null}
            {storedRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
          </SelectField>
        ) : null}
      </div>
      {refIsMissing ? <Notice variant="error">{t('rtKeyMissingWarning', { ref: credentialRef })}</Notice> : null}
      {/* Deliberately NOT `announce`d, and that is not an oversight: this card's
          save-success notice already owns the single polite slot
          (`noticeAnnounceSuccess.test.tsx` pins exactly one per file), and the
          two CAN co-occur — the list stays unreadable while the user saves a
          provider — so announcing here would clobber the save confirmation. */}
      {refsUnreadable ? <Notice variant="warning">{t('rtKeysUnreadable')}</Notice> : null}
      {needsKey && !refsUnreadable && storedRefs.length === 0 ? <p className="muted u-fs-12 u-m-0">{t('rtNoKeys')}</p> : null}
      {provider === 'gemini-live' ? <Notice variant="warning">{t('rtGeminiAssurance')}</Notice> : null}
      <div className="action-bar">
        <Button variant="primary" size="sm" disabled={busy || (needsKey && !credentialRef)} onClick={() => void save()}>
          {busy ? t('rtSaving') : t('rtSave')}
        </Button>
      </div>
    </section>
  );
}
